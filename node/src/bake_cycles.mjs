// node/src/bake_cycles.mjs
// Pass 2 driver — per-cycle execution. Parallel batches with
// deterministic merge ordering. Persists every cycle's exact input
// alongside its output for inspection and --resume.
//
// COST OVERRIDE: default thinkingBudget is 16384 (down from plan's 32768)
// to stay within API budget. See bake_anthropic.mjs for full override notes.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bakeDirLayout, cyclePaths, ensureDir, readJson, writeJson,
  validateOrThrow, cycleOutputSchema, appendValidationLog,
} from "./bake_io.mjs";
import {
  buildSystemPrefix, buildUserMessage, callBake,
  extractRationaleAndToolCalls,
} from "./bake_anthropic.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_ROOT = join(__dirname, "..");

const PROMPT_TEMPLATE_PATH = join(NODE_ROOT, "prompts", "bake", "execution_pass.md");
const BAYATI_BASE = join(NODE_ROOT, "prompts", "bayati_base.md");
const MEDIUM_RULES = join(NODE_ROOT, "prompts", "configs", "config_a", "medium_rules.md");
const TOOLS_JSON_PATH = join(NODE_ROOT, "prompts", "configs", "config_a", "tools.json");
const MOOD_BOARD_JSON = join(NODE_ROOT, "canon", "mood_board.json");
const MOOD_BOARD_DIR = join(NODE_ROOT, "canon", "placeholders");
const REFERENCE_PHOTOS_DIR = join(NODE_ROOT, "canon", "reference_photos");

function parseArgs(argv) {
  // thinkingBudget default: 16384 (user override from plan's 32768 — cost budget)
  const a = { concurrency: 5, thinkingBudget: 16384, maxOutputTokens: 8192,
              cyclesRange: null, resume: false, mockFixtureDir: null };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--bake-dir") a.bakeDir = argv[++i];
    else if (v === "--corpus") a.corpus = argv[++i];
    else if (v === "--concurrency") a.concurrency = parseInt(argv[++i], 10);
    else if (v === "--thinking-budget") a.thinkingBudget = parseInt(argv[++i], 10);
    else if (v === "--max-output-tokens") a.maxOutputTokens = parseInt(argv[++i], 10);
    else if (v === "--cycles") {
      const [lo, hi] = argv[++i].split(":").map((n) => parseInt(n, 10));
      a.cyclesRange = [lo, hi];
    } else if (v === "--resume") a.resume = true;
    else if (v === "--mock-fixture-dir") a.mockFixtureDir = argv[++i];
    else if (v === "--self-test") a.selfTest = true;
  }
  return a;
}

function fillTemplate(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v));
  }
  return out;
}

function formatCurrentCycle(cycle) {
  return JSON.stringify({
    cycle_id: cycle.cycle_id, cycle_index: cycle.cycle_index,
    snapshot_time_s: cycle.snapshot_time_s,
    block_1_scalars: cycle.block_1_scalars,
    block_2_summary: cycle.block_2_summary,
    block_3_sparklines: cycle.block_3_sparklines,
  }, null, 2);
}

function formatRecentDecisions(decisionHistory, cycleIndex, lastN = 3) {
  const prior = decisionHistory.filter((d) => d.cycle_index < cycleIndex)
    .sort((a, b) => b.cycle_index - a.cycle_index).slice(0, lastN)
    .reverse();
  if (prior.length === 0) return "(no prior decisions — this is an early-batch cycle)";
  return prior.map((d) => {
    const calls = d.tool_calls.map((tc) =>
      `  - ${tc.name}(${JSON.stringify(tc.input).slice(0, 200)})`).join("\n");
    return `Cycle ${d.cycle_index}: ${d.rationale || "(no rationale)"}\n${calls}`;
  }).join("\n\n");
}

function formatFuturePreview(cycles, cycleIndex, nextN = 3) {
  const future = cycles.filter((c) => c.cycle_index > cycleIndex)
    .slice(0, nextN);
  if (future.length === 0) return "(this is the final cycle)";
  return future.map((c) =>
    `Cycle ${c.cycle_index} (t=${c.snapshot_time_s}s): ${c.block_2_summary}`,
  ).join("\n");
}

function findReferencePhotos() {
  if (!existsSync(REFERENCE_PHOTOS_DIR)) return [];
  return readdirSync(REFERENCE_PHOTOS_DIR).filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
    .sort().map((f) => ({ path: join(REFERENCE_PHOTOS_DIR, f), label: `reference: ${f}` }));
}

function findMoodBoardSvgs() {
  if (!existsSync(MOOD_BOARD_DIR)) return [];
  return readdirSync(MOOD_BOARD_DIR).filter((f) => f.endsWith(".svg"))
    .sort().map((f) => ({ path: join(MOOD_BOARD_DIR, f), label: `mood: ${f}` }));
}

function computeSignature({ cycle_index, current_cycle, recent_decisions,
                            future_preview, composition_intent }) {
  const h = createHash("sha256");
  h.update(JSON.stringify({ cycle_index, current_cycle, recent_decisions,
                            future_preview, composition_intent }));
  return h.digest("hex");
}

function loadCorpus(corpusDir) {
  return readdirSync(corpusDir).filter((f) => /^cycle_\d+\.json$/.test(f))
    .sort().map((f) => readJson(join(corpusDir, f)));
}

function inRange(idx, range) {
  if (!range) return true;
  return idx >= range[0] && idx <= range[1];
}

async function bakeOneCycle({ cycle, layout, plan, cycles,
                              decisionHistory, system, tools, template,
                              thinkingBudget, effort, maxOutputTokens, mockFixtureDir, client }) {
  const intent = plan.per_cycle_intent[cycle.cycle_index];
  const act = plan.overall_arc.find(
    (a) => intent.active_act === a.act_index,
  ) || plan.overall_arc[0];
  const currentCycleStr = formatCurrentCycle(cycle);
  const recentStr = formatRecentDecisions(decisionHistory, cycle.cycle_index);
  const futureStr = formatFuturePreview(cycles, cycle.cycle_index);

  const userText = fillTemplate(template, {
    CYCLE_INDEX: cycle.cycle_index,
    CYCLE_COUNT: plan.cycle_count,
    SNAPSHOT_TIME_S: cycle.snapshot_time_s,
    CURRENT_CYCLE_BLOCK: currentCycleStr,
    RECENT_DECISIONS_BLOCK: recentStr,
    FUTURE_PREVIEW_BLOCK: futureStr,
    ACTIVE_ACT_NAME: act.name,
    ACTIVE_ACT_INTENT: act.intent,
    CYCLE_INTENT: intent.intent,
    ENERGY_HINT: intent.energy_hint,
  });
  const userMessage = buildUserMessage([{ label: "EXECUTION PASS", body: userText }]);

  const sig = computeSignature({
    cycle_index: cycle.cycle_index,
    current_cycle: currentCycleStr,
    recent_decisions: recentStr,
    future_preview: futureStr,
    composition_intent: intent,
  });

  const paths = cyclePaths(layout, cycle.cycle_index);
  ensureDir(layout.cyclesDir);
  writeJson(paths.input, {
    user_text: userText, signature: sig,
    cycle_index: cycle.cycle_index,
    thinking_budget: thinkingBudget, max_output_tokens: maxOutputTokens,
  });

  let response;
  if (mockFixtureDir) {
    const fixturePath = join(mockFixtureDir, `cycle_${String(cycle.cycle_index).padStart(3, "0")}_response.json`);
    response = readJson(fixturePath);
  } else {
    response = await callBake({
      system, userMessage, tools,
      model: "claude-opus-4-7",
      thinkingBudget, effort, maxTokens: maxOutputTokens,
      client,
    });
  }
  const { rationale, toolCalls } = extractRationaleAndToolCalls(response.content);
  const cycleOutput = {
    cycle_index: cycle.cycle_index,
    cycle_id: cycle.cycle_id,
    model: response.model || "claude-opus-4-7",
    thinking_budget: thinkingBudget,
    rationale,
    tool_calls: toolCalls,
    input_signature: sig,
    stop_reason: response.stop_reason,
    usage: response.usage || { input_tokens: 0, output_tokens: 0 },
    baked_at: new Date().toISOString(),
  };
  validateOrThrow(cycleOutputSchema, cycleOutput, `cycle_${cycle.cycle_index}`);
  writeJson(paths.json, cycleOutput);
  return cycleOutput;
}

export async function runCycles({ bakeDir, corpus, concurrency = 5,
                                  thinkingBudget = 16384, effort = "medium",
                                  maxOutputTokens = 8192,
                                  cyclesRange = null, resume = false,
                                  mockFixtureDir = null, client = null } = {}) {
  if (!bakeDir || !corpus) throw new Error("--bake-dir and --corpus required");
  const layout = bakeDirLayout(bakeDir);
  const plan = readJson(layout.compositionPlanJson);
  const cycles = loadCorpus(corpus);
  const tools = readJson(TOOLS_JSON_PATH);

  const promptFiles = [
    { path: BAYATI_BASE, label: "BAYATI BASE" },
    { path: MEDIUM_RULES, label: "MEDIUM RULES" },
    { path: TOOLS_JSON_PATH, label: "TOOLS SCHEMA" },
    { path: MOOD_BOARD_JSON, label: "MOOD BOARD METADATA" },
  ];
  const imageFiles = [
    ...findMoodBoardSvgs(),
    ...findReferencePhotos(),
    { path: layout.spectrogramPng, label: "track spectrogram" },
    { path: layout.dspPanelPng, label: "track DSP panel" },
  ];
  const system = buildSystemPrefix({
    promptFiles, imageFiles, summaryJsonPath: layout.summaryJson,
    compositionPlanPath: layout.compositionPlanJson,
  });
  const template = readFileSync(PROMPT_TEMPLATE_PATH, "utf8");

  const decisionHistory = [];
  // Bootstrap decisionHistory from any existing valid cycle outputs (for --resume).
  for (const c of cycles) {
    const paths = cyclePaths(layout, c.cycle_index);
    if (resume && existsSync(paths.json)) {
      const existing = readJson(paths.json);
      try {
        validateOrThrow(cycleOutputSchema, existing, "existing");
        decisionHistory.push(existing);
      } catch { /* will re-bake below */ }
    }
  }

  const targetCycles = cycles.filter((c) => inRange(c.cycle_index, cyclesRange));
  let completed = 0;
  for (let batchStart = 0; batchStart < targetCycles.length; batchStart += concurrency) {
    const batch = targetCycles.slice(batchStart, batchStart + concurrency);
    const snapshotHistory = [...decisionHistory];

    const results = await Promise.all(batch.map(async (cycle) => {
      const paths = cyclePaths(layout, cycle.cycle_index);
      if (resume && existsSync(paths.json)) {
        const existing = readJson(paths.json);
        if (existing.input_signature) {
          // Recompute signature based on what THIS run would build.
          const intent = plan.per_cycle_intent[cycle.cycle_index];
          const recentStr = formatRecentDecisions(snapshotHistory, cycle.cycle_index);
          const futureStr = formatFuturePreview(cycles, cycle.cycle_index);
          const sig = computeSignature({
            cycle_index: cycle.cycle_index,
            current_cycle: formatCurrentCycle(cycle),
            recent_decisions: recentStr,
            future_preview: futureStr,
            composition_intent: intent,
          });
          if (sig === existing.input_signature) return existing;
        }
      }
      return await bakeOneCycle({
        cycle, layout, plan, cycles,
        decisionHistory: snapshotHistory,
        system, tools, template, thinkingBudget, effort, maxOutputTokens,
        mockFixtureDir, client,
      });
    }));

    // Deterministic merge: append in cycle-index order.
    results.sort((a, b) => a.cycle_index - b.cycle_index);
    for (const r of results) {
      const idx = decisionHistory.findIndex((d) => d.cycle_index === r.cycle_index);
      if (idx === -1) decisionHistory.push(r);
      else decisionHistory[idx] = r;
    }
    completed += results.length;
  }
  return { decisionHistory, completed };
}

// ─── CLI ───────────────────────────────────────────────────────────

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const a = parseArgs(process.argv);
  if (a.selfTest) {
    await runSelfTests();
  } else {
    const { completed } = await runCycles(a);
    process.stdout.write(`pass 2 complete: ${completed} cycles baked\n`);
  }
}

async function runSelfTests() {
  const assert = (await import("node:assert/strict")).default;
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: pathJoin } = await import("node:path");

  let pass = 0, fail = 0;
  async function t(desc, fn) {
    try { await fn(); pass += 1; process.stdout.write(`  ok  ${desc}\n`); }
    catch (e) { fail += 1; process.stdout.write(`  FAIL ${desc}\n    ${e.message}\n`); }
  }

  function mkBakeFixture(tmp, cycleCount) {
    const corpus = pathJoin(tmp, "corpus"); mkdirSync(corpus, { recursive: true });
    for (let i = 0; i < cycleCount; i++) {
      writeFileSync(pathJoin(corpus, `cycle_${String(i).padStart(3, "0")}.json`),
        JSON.stringify({
          cycle_id: `cycle_${String(i).padStart(3, "0")}`, cycle_index: i,
          source_file: "x.wav", snapshot_time_s: 5 * (i + 1), elapsed_total_s: 5 * (i + 1),
          window_duration_s: 4, window_start_s: 5 * i + 1, window_end_s: 5 * (i + 1),
          block_1_scalars: { rms_mean: 0.1, rms_peak: 0.2, rms_trend: "rising",
            centroid_mean_hz: 1500, centroid_trend: "rising",
            onset_density: 4, onset_peak_strength: 0.5,
            pitch_class_dominant: "D", pitch_class_secondary: null,
            silence_ratio: 0.1, window_duration_s: 4, elapsed_total_s: 5 * (i + 1) },
          block_2_summary: `cycle ${i} prose`,
          block_3_sparklines: { rms: "▁▂▃", onset: "▁▂▃", centroid: "▁▂▃" },
        }));
    }
    const bakeDir = pathJoin(tmp, "bake_x");
    const meta = pathJoin(bakeDir, "track_meta"); mkdirSync(meta, { recursive: true });
    writeFileSync(pathJoin(meta, "summary.json"), JSON.stringify({
      track_id: "x", duration_s: 10, sample_rate: 44100, channels: 2,
      cycle_count: cycleCount, cycle_to_seconds: Array.from({ length: cycleCount }, (_, i) => 5 * (i + 1)),
      peak_rms_window: { start_s: 1, end_s: 5, value: 0.2 },
      silence_regions: [], event_counts: {}, event_timeline: [],
    }));
    writeFileSync(pathJoin(meta, "spectrogram.png"), Buffer.from([137, 80, 78, 71]));
    writeFileSync(pathJoin(meta, "dsp_panel.png"), Buffer.from([137, 80, 78, 71]));
    const plan = {
      track_id: "x", duration_s: 10, cycle_count: cycleCount,
      overall_arc: [{ act_index: 0, name: "Birth", cycle_range: [0, cycleCount - 1], intent: "stillness" }],
      per_cycle_intent: Array.from({ length: cycleCount }, (_, i) => ({
        cycle: i, active_act: 0, intent: `intent_${i}`,
        energy_hint: ["low", "rising", "high", "falling"][i % 4],
      })),
      element_vocabulary: { anchors: ["moonlight"], palette_progression: [], introduce_at: {}, retire_at: {} },
      foreshadow_pairs: [],
      anticipation_offsets_ms: Object.fromEntries(Array.from({ length: cycleCount }, (_, i) => [String(i), 0])),
      model: "claude-opus-4-7", thinking_budget: 49152, baked_at: "2026-04-25T00:00:00Z",
    };
    writeFileSync(pathJoin(bakeDir, "composition_plan.json"), JSON.stringify(plan, null, 2));
    return { corpus, bakeDir };
  }

  function mkMockFixtures(dir, cycleCount) {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < cycleCount; i++) {
      writeFileSync(pathJoin(dir, `cycle_${String(i).padStart(3, "0")}_response.json`), JSON.stringify({
        model: "claude-opus-4-7",
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [
          { type: "text", text: `Rationale for cycle ${i}: chose stillness.` },
          { type: "tool_use", id: `tu_${i}`, name: "addText",
            input: { text: `cycle ${i}` } },
        ],
      }));
    }
  }

  await t("runCycles bakes all cycles with mock fixtures", async () => {
    const tmp = mkdtempSync(pathJoin((await import("node:os")).tmpdir(), "bake-cyc-"));
    const { corpus, bakeDir } = mkBakeFixture(tmp, 3);
    const fix = pathJoin(tmp, "fixtures"); mkMockFixtures(fix, 3);
    const { completed } = await runCycles({
      bakeDir, corpus, concurrency: 2,
      thinkingBudget: 100, maxOutputTokens: 1000,
      mockFixtureDir: fix,
    });
    assert.equal(completed, 3);
    for (let i = 0; i < 3; i++) {
      const out = readJson(pathJoin(bakeDir, "cycles", `cycle_${String(i).padStart(3, "0")}.json`));
      assert.equal(out.cycle_index, i);
      assert.match(out.rationale, /Rationale for cycle/);
      assert.equal(out.tool_calls.length, 1);
    }
  });

  await t("runCycles with --resume skips matching signatures", async () => {
    const tmp = mkdtempSync(pathJoin((await import("node:os")).tmpdir(), "bake-cyc-resume-"));
    const { corpus, bakeDir } = mkBakeFixture(tmp, 2);
    const fix = pathJoin(tmp, "fixtures"); mkMockFixtures(fix, 2);
    await runCycles({ bakeDir, corpus, concurrency: 2,
      thinkingBudget: 1, maxOutputTokens: 1, mockFixtureDir: fix });
    // Modify the fixture; with --resume, the change is ignored because
    // the saved signature already matches the input the run would build.
    writeFileSync(pathJoin(fix, "cycle_000_response.json"), JSON.stringify({
      model: "claude-opus-4-7", stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text: "DIFFERENT" },
                { type: "tool_use", id: "tu_x", name: "addText", input: { text: "diff" } }],
    }));
    await runCycles({ bakeDir, corpus, concurrency: 2,
      thinkingBudget: 1, maxOutputTokens: 1, mockFixtureDir: fix, resume: true });
    const out0 = readJson(pathJoin(bakeDir, "cycles", "cycle_000.json"));
    assert.match(out0.rationale, /Rationale for cycle 0/, "resume should have skipped re-bake");
  });

  await t("decisionHistory in batch 0 is empty (cycles 0..C-1 see no priors)", async () => {
    const tmp = mkdtempSync(pathJoin((await import("node:os")).tmpdir(), "bake-cyc-batch0-"));
    const { corpus, bakeDir } = mkBakeFixture(tmp, 2);
    const fix = pathJoin(tmp, "fixtures"); mkMockFixtures(fix, 2);
    await runCycles({ bakeDir, corpus, concurrency: 2,
      thinkingBudget: 1, maxOutputTokens: 1, mockFixtureDir: fix });
    const inp0 = readJson(pathJoin(bakeDir, "cycles", "cycle_000_input.json"));
    const inp1 = readJson(pathJoin(bakeDir, "cycles", "cycle_001_input.json"));
    // Both are in batch 0 with concurrency 2 → both see no prior decisions.
    assert.match(inp0.user_text, /no prior decisions/);
    assert.match(inp1.user_text, /no prior decisions/);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
}
