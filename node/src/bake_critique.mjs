// node/src/bake_critique.mjs
// Pass 3 driver — holistic critique + per-weak-cycle refinement.
//
// CLI:
//   node node/src/bake_critique.mjs --bake-dir bake_song1
//   node node/src/bake_critique.mjs --bake-dir bake_song1 --max-refines 2
//   node node/src/bake_critique.mjs --self-test
//
// Algorithm:
//   1. Load composition_plan.json + all cycle_NNN.json files.
//   2. Build critique prompt from critique_pass.md template.
//   3. Call runCritique(...) → extractRationaleAndToolCalls() → parse JSON
//      from the text block → validate against critiqueSchema.
//   4. Save critique.json.
//   5. For each weak cycle (up to --max-refines), call runRefine(...).
//      Parse + validate against cycleV2Schema. Save cycle_NNN_v2.json.
//   6. Append to validation log.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bakeDirLayout, cyclePaths, readJson, writeJson,
  validateOrThrow, critiqueSchema, cycleV2Schema,
  appendValidationLog,
} from "./bake_io.mjs";
import {
  runCritique, runRefine, extractRationaleAndToolCalls,
} from "./bake_anthropic.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_ROOT = join(__dirname, "..");

const CRITIQUE_PROMPT_PATH = join(NODE_ROOT, "prompts", "bake", "critique_pass.md");
const REFINE_PROMPT_PATH   = join(NODE_ROOT, "prompts", "bake", "refine_pass.md");

// ─── Helpers ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { maxRefines: Infinity };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--bake-dir")    a.bakeDir = argv[++i];
    else if (v === "--max-refines") a.maxRefines = parseInt(argv[++i], 10);
    else if (v === "--self-test")   a.selfTest = true;
  }
  return a;
}

function loadAllCycles(layout) {
  if (!existsSync(layout.cyclesDir)) return [];
  return readdirSync(layout.cyclesDir)
    .filter((f) => /^cycle_\d{3}\.json$/.test(f))
    .sort()
    .map((f) => readJson(join(layout.cyclesDir, f)));
}

function buildCritiquePrompt(critiqueTemplate, plan, cycles) {
  const cycleDecisions = cycles.map((c) => {
    return `### Cycle ${c.cycle_index}\nrationale: ${c.rationale || "(none)"}\ntool_calls: ${JSON.stringify(c.tool_calls, null, 2)}`;
  }).join("\n\n");

  const schemaDoc = JSON.stringify({
    weak_cycles: [
      { cycle: "(int) cycle index", issue: "(string)", suggestion: "(string)" },
    ],
    global_notes: "(string summary of the composition overall)",
    model: "(string model name)",
    thinking_budget: "(int)",
    critiqued_at: "(ISO timestamp)",
  }, null, 2);

  return critiqueTemplate
    .replace("{{CYCLE_COUNT}}", String(cycles.length))
    .replace("{{COMPOSITION_PLAN_JSON}}", JSON.stringify(plan, null, 2))
    .replace("{{CYCLE_DECISIONS_BLOCK}}", cycleDecisions)
    .replace("{{CRITIQUE_SCHEMA_DOC}}", schemaDoc);
}

function buildRefinePrompt(refineTemplate, plan, weakEntry, cycleJson) {
  const idx = weakEntry.cycle;
  const intent = plan.per_cycle_intent[idx] || {};
  const act = plan.overall_arc.find((a) => a.act_index === intent.active_act) || plan.overall_arc[0] || {};

  return refineTemplate
    .replace(/{{CYCLE_INDEX}}/g, String(idx))
    .replace("{{CURRENT_CYCLE_BLOCK}}", JSON.stringify(cycleJson, null, 2))
    .replace("{{RECENT_DECISIONS_BLOCK}}", "(prior cycles omitted in refine pass)")
    .replace("{{FUTURE_PREVIEW_BLOCK}}", "(future cycles omitted in refine pass)")
    .replace("{{ACTIVE_ACT_NAME}}", act.name || "unknown")
    .replace("{{ACTIVE_ACT_INTENT}}", act.intent || "unknown")
    .replace("{{CYCLE_INTENT}}", intent.intent || "unknown")
    .replace("{{ENERGY_HINT}}", intent.energy_hint || "unknown")
    .replace("{{CRITIQUE_ISSUE}}", weakEntry.issue)
    .replace("{{CRITIQUE_SUGGESTION}}", weakEntry.suggestion);
}

function parseCritiqueFromContent(content, modelName, thinkingBudget) {
  const { rationale, toolCalls } = extractRationaleAndToolCalls(content);
  // The critique is returned as JSON in the text block (no tool calls per prompt)
  const jsonText = rationale.trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`runCritique returned non-JSON text: ${jsonText.slice(0, 200)}`);
  }
  // Inject required metadata fields if model provided them, else fill from args
  if (!parsed.model)          parsed.model = modelName || "claude-opus-4-7";
  if (!parsed.thinking_budget) parsed.thinking_budget = thinkingBudget;
  if (!parsed.critiqued_at)   parsed.critiqued_at = new Date().toISOString();
  return parsed;
}

function parseRefineFromContent(content, cycleJson, weakEntry, modelName, thinkingBudget, stopReason) {
  const { rationale, toolCalls } = extractRationaleAndToolCalls(content);
  const sig = createHash("sha256")
    .update(JSON.stringify({ cycle_index: cycleJson.cycle_index, rationale, toolCalls }))
    .digest("hex");
  return {
    cycle_index:  cycleJson.cycle_index,
    cycle_id:     cycleJson.cycle_id,
    model:        modelName || "claude-opus-4-7",
    thinking_budget: thinkingBudget,
    rationale,
    tool_calls:   toolCalls,
    input_signature: sig,
    stop_reason:  stopReason ?? "end_turn",
    usage:        { input_tokens: 0, output_tokens: 0 },
    baked_at:     new Date().toISOString(),
    refined_from: `cycle_${String(cycleJson.cycle_index).padStart(3, "0")}.json`,
    critique_note:       weakEntry.issue,
    critique_suggestion: weakEntry.suggestion,
  };
}

// ─── Main pipeline ─────────────────────────────────────────────────

export async function runCritiquePass({
  bakeDir,
  maxRefines = Infinity,
  thinkingBudget = 16384,
  effort = "medium",
  maxOutputTokens = 8192,
  client = null,
  // Injectable overrides for testing
  _runCritique = null,
  _runRefine = null,
} = {}) {
  const layout = bakeDirLayout(bakeDir);
  const critiqueTemplate = readFileSync(CRITIQUE_PROMPT_PATH, "utf8");
  const refineTemplate   = readFileSync(REFINE_PROMPT_PATH,   "utf8");

  const plan   = readJson(layout.compositionPlanJson);
  const cycles = loadAllCycles(layout);

  if (cycles.length === 0) {
    throw new Error(`No cycle_NNN.json files found in ${layout.cyclesDir}`);
  }

  // ── Step 1: Holistic critique ──────────────────────────────────

  const critiquePrompt = buildCritiquePrompt(critiqueTemplate, plan, cycles);

  const critiqueRunner = _runCritique || runCritique;
  const critiqueResult = await critiqueRunner({
    systemPrompt: null,
    allCycles:    critiquePrompt,
    thinkingBudget,
    effort,
    maxOutputTokens,
    client,
  });

  const critiqueData = parseCritiqueFromContent(
    critiqueResult.content,
    critiqueResult.model,
    thinkingBudget,
  );

  const validated = validateOrThrow(critiqueSchema, critiqueData, "critique");

  // ── Step 2: Save critique.json ─────────────────────────────────

  writeJson(layout.critiqueJson, validated);

  // ── Step 3: Refine weak cycles (up to maxRefines) ──────────────

  const weakToRefine = validated.weak_cycles.slice(0, maxRefines === Infinity ? undefined : maxRefines);
  const refineRunner = _runRefine || runRefine;

  for (const weakEntry of weakToRefine) {
    const cycleIdx = weakEntry.cycle;
    const paths = cyclePaths(layout, cycleIdx);
    if (!existsSync(paths.json)) {
      process.stderr.write(`WARN: cycle_${String(cycleIdx).padStart(3, "0")}.json not found; skipping refine\n`);
      continue;
    }
    const cycleJson = readJson(paths.json);
    const refinePrompt = buildRefinePrompt(refineTemplate, plan, weakEntry, cycleJson);

    const refineResult = await refineRunner({
      systemPrompt: refinePrompt,
      weakCycle:    JSON.stringify(cycleJson, null, 2),
      critique:     `Issue: ${weakEntry.issue}\nSuggestion: ${weakEntry.suggestion}`,
      thinkingBudget,
      effort,
      maxOutputTokens,
      client,
    });

    const v2Data = parseRefineFromContent(
      refineResult.content,
      cycleJson,
      weakEntry,
      refineResult.model,
      thinkingBudget,
      refineResult.stop_reason,
    );

    // Override usage if SDK returned real usage
    if (refineResult.usage) {
      v2Data.usage = refineResult.usage;
    }

    const validatedV2 = validateOrThrow(cycleV2Schema, v2Data, `cycle_${cycleIdx}_v2`);
    writeJson(paths.v2Json, validatedV2);
  }

  // ── Step 4: Append validation log ─────────────────────────────

  // Log a success entry (no error — re-use appendValidationLog with a synthetic "ok" error)
  const logEntry = {
    message: `critique pass complete: ${weakToRefine.length} refined, ${validated.weak_cycles.length} flagged`,
  };
  appendValidationLog(layout.critiqueJson.replace(".json", "_validation.log"), "pass3", logEntry);

  return { critique: validated, refineCount: weakToRefine.length };
}

// ─── CLI entry point ───────────────────────────────────────────────

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const args = parseArgs(process.argv);

  if (args.selfTest) {
    // ── SELF-TESTS ─────────────────────────────────────────────────
    const assert = (await import("node:assert/strict")).default;
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");

    let pass = 0, fail = 0;
    async function t(desc, fn) {
      try {
        await fn();
        pass += 1;
        process.stdout.write(`  ok  ${desc}\n`);
      } catch (err) {
        fail += 1;
        process.stdout.write(`  FAIL ${desc}\n    ${err.message}\n`);
      }
    }

    // ── Fixtures ────────────────────────────────────────────────────

    function makePlan(cycleCount = 3) {
      return {
        track_id: "test_song",
        duration_s: 60,
        cycle_count: cycleCount,
        overall_arc: [{
          act_index: 0, name: "Intro", cycle_range: [0, cycleCount - 1], intent: "establish",
        }],
        per_cycle_intent: Array.from({ length: cycleCount }, (_, i) => ({
          cycle: i, active_act: 0, intent: `intent for cycle ${i}`, energy_hint: "low",
        })),
        element_vocabulary: { anchors: ["x"], palette_progression: [], introduce_at: {}, retire_at: {} },
        foreshadow_pairs: [],
        anticipation_offsets_ms: {},
        model: "claude-opus-4-7", thinking_budget: 16384, baked_at: "2026-04-25T00:00:00Z",
      };
    }

    function makeCycle(idx) {
      return {
        cycle_index: idx, cycle_id: `cycle_${String(idx).padStart(3, "0")}`,
        model: "claude-opus-4-7", thinking_budget: 16384,
        rationale: `rationale for cycle ${idx}`, tool_calls: [],
        input_signature: `sig_${idx}_padded_to_8chars`, stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
        baked_at: "2026-04-25T00:00:00Z",
      };
    }

    function makeBakeDir(tmpRoot, cycleCount = 3, weakIndices = []) {
      const bakeDir = join(tmpRoot, `bake_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
      mkdirSync(join(bakeDir, "cycles"), { recursive: true });
      writeFileSync(join(bakeDir, "composition_plan.json"), JSON.stringify(makePlan(cycleCount)));
      for (let i = 0; i < cycleCount; i++) {
        writeFileSync(
          join(bakeDir, "cycles", `cycle_${String(i).padStart(3, "0")}.json`),
          JSON.stringify(makeCycle(i)),
        );
      }
      return bakeDir;
    }

    function mockCritiqueContent(weakIndices = []) {
      const json = JSON.stringify({
        weak_cycles: weakIndices.map((i) => ({
          cycle: i,
          issue: `cycle ${i} breaks coherence`,
          suggestion: `carry motif forward`,
        })),
        global_notes: "overall decent",
        model: "claude-opus-4-7",
        thinking_budget: 16384,
        critiqued_at: "2026-04-25T12:00:00Z",
      });
      return [{ type: "text", text: json }];
    }

    function mockRefineContent(cycleIdx) {
      return [
        { type: "thinking", thinking: "private CoT", signature: "abc" },
        { type: "text", text: `Refined rationale for cycle ${cycleIdx}.` },
      ];
    }

    const TMP = mkdtempSync(join(tmpdir(), "bake-critique-tests-"));

    // ── Test 1: critique parses correctly and identifies weak cycles ──

    await t("critique parses correctly and identifies weak cycles", async () => {
      const bakeDir = makeBakeDir(TMP, 3, [1]);
      let critiqueCalled = false;

      const result = await runCritiquePass({
        bakeDir,
        _runCritique: async (opts) => {
          critiqueCalled = true;
          return { content: mockCritiqueContent([1]), model: "claude-opus-4-7" };
        },
        _runRefine: async (opts) => {
          return { content: mockRefineContent(1), model: "claude-opus-4-7" };
        },
      });

      assert.ok(critiqueCalled, "runCritique was called");
      assert.equal(result.critique.weak_cycles.length, 1);
      assert.equal(result.critique.weak_cycles[0].cycle, 1);
    });

    // ── Test 2: refine called once per weak cycle, not for non-flagged ──

    await t("refine called once per weak cycle and not for non-flagged cycles", async () => {
      const bakeDir = makeBakeDir(TMP, 3, [0, 2]);
      const refinedIndices = [];

      await runCritiquePass({
        bakeDir,
        _runCritique: async () => ({
          content: mockCritiqueContent([0, 2]), model: "claude-opus-4-7",
        }),
        _runRefine: async (opts) => {
          // Detect which cycle is being refined by inspecting weakCycle body
          const parsed = JSON.parse(opts.weakCycle);
          refinedIndices.push(parsed.cycle_index);
          return { content: mockRefineContent(parsed.cycle_index), model: "claude-opus-4-7" };
        },
      });

      assert.deepEqual(refinedIndices.sort(), [0, 2]);
    });

    // ── Test 3: _v2 files written with correct schema ─────────────────

    await t("_v2 files are written with correct schema", async () => {
      const bakeDir = makeBakeDir(TMP, 2, [0]);
      const layout  = bakeDirLayout(bakeDir);

      await runCritiquePass({
        bakeDir,
        _runCritique: async () => ({
          content: mockCritiqueContent([0]), model: "claude-opus-4-7",
        }),
        _runRefine: async () => ({
          content: mockRefineContent(0), model: "claude-opus-4-7",
        }),
      });

      const v2Path = cyclePaths(layout, 0).v2Json;
      assert.ok(existsSync(v2Path), "cycle_000_v2.json exists");
      const v2 = readJson(v2Path);
      assert.equal(v2.cycle_index, 0);
      assert.equal(v2.refined_from, "cycle_000.json");
      assert.ok(v2.critique_note, "has critique_note");
      assert.ok(v2.critique_suggestion, "has critique_suggestion");
    });

    // ── Test 4: critique.json is written ──────────────────────────────

    await t("critique.json is written to bake-dir", async () => {
      const bakeDir = makeBakeDir(TMP, 2);
      const layout  = bakeDirLayout(bakeDir);

      await runCritiquePass({
        bakeDir,
        _runCritique: async () => ({
          content: mockCritiqueContent([]), model: "claude-opus-4-7",
        }),
        _runRefine: async () => ({ content: [], model: "claude-opus-4-7" }),
      });

      assert.ok(existsSync(layout.critiqueJson), "critique.json exists");
      const c = readJson(layout.critiqueJson);
      assert.equal(c.weak_cycles.length, 0);
      assert.ok(c.critiqued_at, "has critiqued_at");
    });

    // ── Test 5: schema validation rejects malformed critique response ──

    await t("schema validation rejects malformed critique response", async () => {
      const bakeDir = makeBakeDir(TMP, 2);
      let threw = false;
      try {
        await runCritiquePass({
          bakeDir,
          _runCritique: async () => ({
            // weak_cycles item is missing required 'issue' and 'suggestion' fields
            content: [{ type: "text", text: JSON.stringify({
              weak_cycles: [{ cycle: 0 }],  // missing issue + suggestion
              global_notes: "ok",
              model: "claude-opus-4-7",
              thinking_budget: 16384,
              critiqued_at: "2026-04-25T00:00:00Z",
            }) }],
            model: "claude-opus-4-7",
          }),
          _runRefine: async () => ({ content: [], model: null }),
        });
      } catch (err) {
        threw = true;
        assert.match(err.message, /schema validation failed/);
      }
      assert.ok(threw, "should have thrown on malformed critique");
    });

    // ── Test 6: --max-refines cap is honored ──────────────────────────

    await t("--max-refines cap is honored (only N refine calls made)", async () => {
      const bakeDir = makeBakeDir(TMP, 4, [0, 1, 2]);
      const refinedIndices = [];

      await runCritiquePass({
        bakeDir,
        maxRefines: 2,
        _runCritique: async () => ({
          content: mockCritiqueContent([0, 1, 2]), model: "claude-opus-4-7",
        }),
        _runRefine: async (opts) => {
          const parsed = JSON.parse(opts.weakCycle);
          refinedIndices.push(parsed.cycle_index);
          return { content: mockRefineContent(parsed.cycle_index), model: "claude-opus-4-7" };
        },
      });

      assert.equal(refinedIndices.length, 2, "only 2 refine calls despite 3 weak cycles");
    });

    // ── Test 7: extractRationaleAndToolCalls strips thinking blocks ───

    await t("extractRationaleAndToolCalls strips thinking blocks before saving", async () => {
      const bakeDir = makeBakeDir(TMP, 2, [0]);
      const layout  = bakeDirLayout(bakeDir);

      await runCritiquePass({
        bakeDir,
        _runCritique: async () => ({
          content: mockCritiqueContent([0]), model: "claude-opus-4-7",
        }),
        _runRefine: async () => ({
          content: [
            { type: "thinking", thinking: "hidden chain of thought", signature: "xyz" },
            { type: "text", text: "Refined with less abstraction." },
          ],
          model: "claude-opus-4-7",
        }),
      });

      const v2 = readJson(cyclePaths(layout, 0).v2Json);
      // rationale must be the visible text only, no "thinking" content
      assert.equal(v2.rationale, "Refined with less abstraction.");
      // tool_calls must be empty (no tool_use blocks in mockRefineContent)
      assert.deepEqual(v2.tool_calls, []);
    });

    process.stdout.write(`\n7/${pass + fail} passed\n`);
    if (fail > 0) process.stdout.write(`${fail} test(s) FAILED\n`);
    process.stdout.write(`\n============ bake_critique.mjs self-test ============\n${pass}/${pass + fail} passed\n`);
    if (fail > 0) process.exit(1);
  } else {
    // ── CLI production run ─────────────────────────────────────────
    if (!args.bakeDir) {
      process.stderr.write("Usage: node node/src/bake_critique.mjs --bake-dir <dir> [--max-refines N]\n");
      process.exit(1);
    }
    const { critique, refineCount } = await runCritiquePass({
      bakeDir:    args.bakeDir,
      maxRefines: args.maxRefines,
    });
    process.stdout.write(`critique.json saved. ${critique.weak_cycles.length} weak cycles flagged, ${refineCount} refined.\n`);
    if (critique.global_notes) {
      process.stdout.write(`global_notes: ${critique.global_notes}\n`);
    }
  }
}
