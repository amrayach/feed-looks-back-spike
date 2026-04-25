// node/src/bake_composition.mjs
// Pass 1 driver — composition planning. Single Opus call with full
// multi-modal track context. Persists exact input + output + log.
//
// CLI:
//   node src/bake_composition.mjs \
//     --corpus ../corpus_song1 --audio "../audio/song 1.wav" \
//     --bake-dir ../bake_song1 --thinking-budget 49152 \
//     [--max-output-tokens 16384] [--mock-response path.json]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bakeDirLayout, ensureDir, readJson, writeJson,
  validateOrThrow, compositionPlanSchema, appendValidationLog,
} from "./bake_io.mjs";
import {
  buildSystemPrefix, buildImageContentBlocks, buildUserMessage, callBake,
  extractRationaleAndToolCalls,
} from "./bake_anthropic.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_ROOT = join(__dirname, "..");
const REPO_ROOT = join(NODE_ROOT, "..");

const PROMPT_TEMPLATE_PATH = join(NODE_ROOT, "prompts", "bake", "composition_pass.md");
const BAYATI_BASE = join(NODE_ROOT, "prompts", "bayati_base.md");
const MEDIUM_RULES = join(NODE_ROOT, "prompts", "configs", "config_a", "medium_rules.md");
const TOOLS_JSON = join(NODE_ROOT, "prompts", "configs", "config_a", "tools.json");
const MOOD_BOARD_JSON = join(NODE_ROOT, "canon", "mood_board.json");
const MOOD_BOARD_DIR = join(NODE_ROOT, "canon", "placeholders");
const REFERENCE_PHOTOS_DIR = join(NODE_ROOT, "canon", "reference_photos");

function parseArgs(argv) {
  const args = { thinkingBudget: 49152, maxOutputTokens: 16384, mockResponse: null };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--corpus") args.corpus = argv[++i];
    else if (v === "--audio") args.audio = argv[++i];
    else if (v === "--bake-dir") args.bakeDir = argv[++i];
    else if (v === "--thinking-budget") args.thinkingBudget = parseInt(argv[++i], 10);
    else if (v === "--max-output-tokens") args.maxOutputTokens = parseInt(argv[++i], 10);
    else if (v === "--mock-response") args.mockResponse = argv[++i];
    else if (v === "--self-test") args.selfTest = true;
  }
  return args;
}

function ensureTrackMeta({ audio, corpus, bakeDir }) {
  const layout = bakeDirLayout(bakeDir);
  if (existsSync(layout.summaryJson)) return layout;
  ensureDir(layout.trackMeta);
  const py = process.env.BAKE_PYTHON || "/home/amay/miniconda3/envs/ambi_audio/bin/python";
  execFileSync(py, [
    join(REPO_ROOT, "python", "enrich_track.py"),
    "--audio", audio,
    "--corpus", corpus,
    "--out", layout.trackMeta,
  ], { stdio: "inherit" });
  return layout;
}

function loadCorpus(corpusDir) {
  const files = readdirSync(corpusDir).filter((f) => /^cycle_\d+\.json$/.test(f)).sort();
  return files.map((f) => readJson(join(corpusDir, f)));
}

function buildCorpusProseTable(cycles) {
  return cycles.map((c) =>
    `[cycle ${c.cycle_index} · t=${c.snapshot_time_s}s] ${c.block_2_summary}`,
  ).join("\n");
}

function buildScalarsTable(cycles) {
  const header = "cycle | t   | rms_mean | centroid_hz | onset | pitch | silence";
  const sep = "------|-----|----------|-------------|-------|-------|--------";
  const rows = cycles.map((c) => {
    const s = c.block_1_scalars;
    return `${c.cycle_index.toString().padStart(5)} | ${c.snapshot_time_s.toFixed(0).padStart(3)} | ${s.rms_mean.toFixed(3).padStart(8)} | ${s.centroid_mean_hz.toString().padStart(11)} | ${s.onset_density.toFixed(1).padStart(5)} | ${(s.pitch_class_dominant || "-").padStart(5)} | ${s.silence_ratio.toFixed(2).padStart(7)}`;
  });
  return [header, sep, ...rows].join("\n");
}

function buildEventTimelineBullets(summary) {
  if (!summary.event_timeline || summary.event_timeline.length === 0) {
    return "- (no Hijaz/Bayati events fired in this track)";
  }
  return summary.event_timeline.map((e) =>
    `- cycle ${e.cycle} (t=${e.time_s.toFixed(1)}s) — ${e.event}`,
  ).join("\n");
}

function fillTemplate(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v));
  }
  return out;
}

function findReferencePhotos() {
  if (!existsSync(REFERENCE_PHOTOS_DIR)) return [];
  return readdirSync(REFERENCE_PHOTOS_DIR)
    .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
    .sort()
    .map((f) => ({ path: join(REFERENCE_PHOTOS_DIR, f), label: `reference: ${f}` }));
}

function findMoodBoardSvgs() {
  if (!existsSync(MOOD_BOARD_DIR)) return [];
  return readdirSync(MOOD_BOARD_DIR)
    .filter((f) => f.endsWith(".svg")).sort()
    .map((f) => ({ path: join(MOOD_BOARD_DIR, f), label: `mood: ${f}` }));
}

const COMPOSITION_PLAN_SCHEMA_DOC = `
{
  "track_id": "<string>",
  "duration_s": <number>,
  "cycle_count": <number>,
  "overall_arc": [{ "act_index": <int>, "name": "<string>", "cycle_range": [<int>,<int>], "intent": "<string>" }, ...],
  "per_cycle_intent": [{ "cycle": <int>, "active_act": <int>, "intent": "<string>", "energy_hint": "low|rising|high|falling" }, ...],
  "element_vocabulary": {
    "anchors": ["<string>", ...],
    "palette_progression": [{ "cycle_range": [<int>,<int>], "palette": "<string>" }, ...],
    "introduce_at": { "<motif>": <int>, ... },
    "retire_at": { "<motif>": <int>, ... }
  },
  "foreshadow_pairs": [{ "plant_at": <int>, "pay_off_at": <int>, "note": "<string>" }, ...],
  "anticipation_offsets_ms": { "<cycle_idx>": <int in [-500,0]>, ... },
  "model": "claude-opus-4-7",
  "thinking_budget": <int>,
  "baked_at": "<ISO-8601>"
}
`.trim();

export async function runComposition({ corpus, audio, bakeDir,
                                       thinkingBudget = 49152,
                                       effort = "xhigh",
                                       maxOutputTokens = 16384,
                                       mockResponse = null,
                                       client = null } = {}) {
  if (!corpus || !audio || !bakeDir) {
    throw new Error("runComposition requires --corpus, --audio, --bake-dir");
  }
  const layout = ensureTrackMeta({ audio, corpus, bakeDir });
  const cycles = loadCorpus(corpus);
  const summary = readJson(layout.summaryJson);

  const template = readFileSync(PROMPT_TEMPLATE_PATH, "utf8");
  const userText = fillTemplate(template, {
    DURATION_S: summary.duration_s.toFixed(1),
    CYCLE_COUNT: summary.cycle_count,
    CYCLE_COUNT_MINUS_ONE: summary.cycle_count - 1,
    CORPUS_PROSE_TABLE: buildCorpusProseTable(cycles),
    SCALARS_TABLE: buildScalarsTable(cycles),
    EVENT_TIMELINE_BULLETS: buildEventTimelineBullets(summary),
    COMPOSITION_PLAN_SCHEMA_DOC: COMPOSITION_PLAN_SCHEMA_DOC,
  });

  const promptFiles = [
    { path: BAYATI_BASE, label: "BAYATI BASE" },
    { path: MEDIUM_RULES, label: "MEDIUM RULES" },
    { path: TOOLS_JSON, label: "TOOLS SCHEMA" },
    { path: MOOD_BOARD_JSON, label: "MOOD BOARD METADATA" },
  ];
  const imageFiles = [
    ...findMoodBoardSvgs(),
    ...findReferencePhotos(),
    { path: layout.spectrogramPng, label: "track spectrogram" },
    { path: layout.dspPanelPng, label: "track DSP panel" },
  ];

  const system = buildSystemPrefix({
    promptFiles, summaryJsonPath: layout.summaryJson,
  });
  const imagePrefix = buildImageContentBlocks({ imageFiles });
  const userMessage = {
    role: "user",
    content: [
      ...imagePrefix,
      { type: "text", text: `### COMPOSITION PASS\n\n${userText}` },
    ],
  };

  // Persist exact input assembly for inspection / replay.
  ensureDir(layout.root);
  writeJson(layout.compositionPlanInputJson, {
    system_block_count: system.length,
    user_text: userText,
    cycle_count: summary.cycle_count,
    duration_s: summary.duration_s,
    thinking_budget: thinkingBudget,
    max_output_tokens: maxOutputTokens,
  });

  let lastError = null;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    if (mockResponse) {
      response = readJson(mockResponse);
    } else {
      response = await callBake({
        system, userMessage,
        model: "claude-opus-4-7",
        thinkingBudget, effort, maxTokens: maxOutputTokens,
        client,
      });
    }
    const { rationale } = extractRationaleAndToolCalls(response.content);
    const jsonText = stripFences(rationale);
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      lastError = new Error(`JSON.parse failed: ${e.message}`);
      appendValidationLog(layout.compositionPlanLog, attempt, lastError);
      if (mockResponse) throw lastError;
      continue;
    }
    parsed.model = response.model || parsed.model || "claude-opus-4-7";
    parsed.thinking_budget = parsed.thinking_budget || thinkingBudget;
    parsed.baked_at = parsed.baked_at || new Date().toISOString();
    if (Array.isArray(parsed.per_cycle_intent) && Array.isArray(summary.cycle_to_seconds)) {
      for (const entry of parsed.per_cycle_intent) {
        const t = summary.cycle_to_seconds[entry.cycle];
        if (typeof t === "number") entry.snapshot_time_s = t;
      }
    }
    try {
      validateOrThrow(compositionPlanSchema, parsed, "composition_plan");
    } catch (e) {
      lastError = e;
      appendValidationLog(layout.compositionPlanLog, attempt, e);
      if (mockResponse) throw e;
      continue;
    }
    writeJson(layout.compositionPlanJson, parsed);
    return { plan: parsed, attempts: attempt };
  }
  throw new Error(`composition pass failed after ${maxAttempts} attempts: ${lastError?.message}`);
}

function stripFences(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  if (start === -1) return text.trim();
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start).trim();
}

// ─── CLI ───────────────────────────────────────────────────────────

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const args = parseArgs(process.argv);
  if (args.selfTest) {
    await runSelfTests();
  } else {
    await runComposition(args);
    process.stdout.write("composition pass complete\n");
  }
}

async function runSelfTests() {
  const assert = (await import("node:assert/strict")).default;
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync: fsExistsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: pathJoin } = await import("node:path");

  let pass = 0, fail = 0;
  async function t(desc, fn) {
    try { await fn(); pass += 1; process.stdout.write(`  ok  ${desc}\n`); }
    catch (e) { fail += 1; process.stdout.write(`  FAIL ${desc}\n    ${e.message}\n`); }
  }

  function mkCorpus(dir, n) {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) {
      writeFileSync(pathJoin(dir, `cycle_${String(i).padStart(3, "0")}.json`),
        JSON.stringify({
          cycle_id: `cycle_${String(i).padStart(3, "0")}`,
          cycle_index: i, source_file: "x.wav",
          snapshot_time_s: 5 * (i + 1), elapsed_total_s: 5 * (i + 1),
          window_duration_s: 4, window_start_s: 5 * i + 1, window_end_s: 5 * (i + 1),
          block_1_scalars: { rms_mean: 0.1, rms_peak: 0.2, rms_trend: "rising",
            centroid_mean_hz: 1500, centroid_trend: "rising",
            onset_density: 4, onset_peak_strength: 0.5,
            pitch_class_dominant: "D", pitch_class_secondary: null,
            silence_ratio: 0.1, window_duration_s: 4, elapsed_total_s: 5 * (i + 1) },
          block_2_summary: `cycle ${i} prose`,
          block_3_sparklines: { rms: "▁▂▃", onset: "▁▂▃", centroid: "▁▂▃" },
        }, null, 2));
    }
  }

  await t("runComposition with valid mock response writes composition_plan.json", async () => {
    const tmp = mkdtempSync(pathJoin((await import("node:os")).tmpdir(), "bake-comp-"));
    const corpus = pathJoin(tmp, "corpus"); mkCorpus(corpus, 2);
    const bakeDir = pathJoin(tmp, "bake_x");
    const meta = pathJoin(bakeDir, "track_meta"); mkdirSync(meta, { recursive: true });
    writeFileSync(pathJoin(meta, "summary.json"), JSON.stringify({
      track_id: "x", duration_s: 10.0, sample_rate: 44100, channels: 2,
      cycle_count: 2, cycle_to_seconds: [5, 10],
      peak_rms_window: { start_s: 1, end_s: 5, value: 0.2 },
      silence_regions: [], event_counts: {}, event_timeline: [],
    }));
    writeFileSync(pathJoin(meta, "spectrogram.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    writeFileSync(pathJoin(meta, "dsp_panel.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const validPlan = {
      track_id: "x", duration_s: 10.0, cycle_count: 2,
      overall_arc: [{ act_index: 0, name: "Birth", cycle_range: [0, 1], intent: "stillness" }],
      per_cycle_intent: [
        { cycle: 0, active_act: 0, intent: "i0", energy_hint: "low" },
        { cycle: 1, active_act: 0, intent: "i1", energy_hint: "rising" },
      ],
      element_vocabulary: { anchors: ["moonlight"], palette_progression: [], introduce_at: {}, retire_at: {} },
      foreshadow_pairs: [],
      anticipation_offsets_ms: { "0": 0, "1": -100 },
    };
    const mockPath = pathJoin(tmp, "mock.json");
    writeFileSync(mockPath, JSON.stringify({
      model: "claude-opus-4-7",
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: "text", text: "```json\n" + JSON.stringify(validPlan) + "\n```" }],
    }));
    const { plan, attempts } = await runComposition({
      corpus, audio: "/dev/null", bakeDir,
      thinkingBudget: 100, maxOutputTokens: 1000,
      mockResponse: mockPath,
    });
    assert.equal(attempts, 1);
    assert.equal(plan.cycle_count, 2);
    assert.equal(plan.per_cycle_intent.length, 2);
    assert.ok(existsSync(pathJoin(bakeDir, "composition_plan.json")));
    assert.ok(existsSync(pathJoin(bakeDir, "composition_plan_input.json")));
  });

  await t("runComposition rejects invalid mock response and fails loudly", async () => {
    const tmp = mkdtempSync(pathJoin((await import("node:os")).tmpdir(), "bake-comp-bad-"));
    const corpus = pathJoin(tmp, "corpus"); mkCorpus(corpus, 2);
    const bakeDir = pathJoin(tmp, "bake_x");
    const meta = pathJoin(bakeDir, "track_meta"); mkdirSync(meta, { recursive: true });
    writeFileSync(pathJoin(meta, "summary.json"), JSON.stringify({
      track_id: "x", duration_s: 10, sample_rate: 44100, channels: 2,
      cycle_count: 2, cycle_to_seconds: [5, 10],
      peak_rms_window: { start_s: 1, end_s: 5, value: 0.2 },
      silence_regions: [], event_counts: {}, event_timeline: [],
    }));
    writeFileSync(pathJoin(meta, "spectrogram.png"), Buffer.from([137, 80, 78, 71]));
    writeFileSync(pathJoin(meta, "dsp_panel.png"), Buffer.from([137, 80, 78, 71]));
    const mockPath = pathJoin(tmp, "bad.json");
    writeFileSync(mockPath, JSON.stringify({
      model: "claude-opus-4-7", stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text: "{ \"track_id\": 1 }" }],
    }));
    await assert.rejects(
      () => runComposition({ corpus, audio: "/dev/null", bakeDir,
        thinkingBudget: 1, maxOutputTokens: 100, mockResponse: mockPath }),
      /schema validation failed|track_id/,
    );
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
}
