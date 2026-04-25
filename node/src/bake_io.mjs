// node/src/bake_io.mjs
// Shared dir-layout helpers + Zod schemas + JSON read/write/validate
// for the bake mode pipeline. All bake passes import from here.
//
// Each Zod schema corresponds to one on-disk artifact. Validation is
// strict (extra keys are rejected) so a typo in any pass surfaces
// loudly at the boundary instead of silently propagating.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

// ─── Layout ────────────────────────────────────────────────────────

export function bakeDirLayout(bakeDir) {
  const root = resolve(bakeDir);
  return {
    root,
    trackMeta: join(root, "track_meta"),
    spectrogramPng: join(root, "track_meta", "spectrogram.png"),
    dspPanelPng: join(root, "track_meta", "dsp_panel.png"),
    summaryJson: join(root, "track_meta", "summary.json"),
    compositionPlanJson: join(root, "composition_plan.json"),
    compositionPlanInputJson: join(root, "composition_plan_input.json"),
    compositionPlanLog: join(root, "composition_plan_validation.log"),
    cyclesDir: join(root, "cycles"),
    critiqueJson: join(root, "critique.json"),
    critiqueInputJson: join(root, "critique_input.json"),
    audioWav: join(root, "audio.wav"),
    submissionDir: join(root, "submission"),
  };
}

export function cyclePaths(layout, cycleIndex) {
  const idx = String(cycleIndex).padStart(3, "0");
  return {
    json: join(layout.cyclesDir, `cycle_${idx}.json`),
    input: join(layout.cyclesDir, `cycle_${idx}_input.json`),
    v2Json: join(layout.cyclesDir, `cycle_${idx}_v2.json`),
    v2Input: join(layout.cyclesDir, `cycle_${idx}_v2_input.json`),
  };
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, obj) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

// ─── Zod schemas ───────────────────────────────────────────────────

const arcEntrySchema = z.object({
  act_index: z.number().int().nonnegative(),
  name: z.string().min(1),
  cycle_range: z.tuple([z.number().int(), z.number().int()]),
  intent: z.string().min(1),
}).strict();

const cycleIntentSchema = z.object({
  cycle: z.number().int().nonnegative(),
  active_act: z.number().int().nonnegative(),
  intent: z.string().min(1),
  energy_hint: z.enum(["low", "rising", "high", "falling"]),
  snapshot_time_s: z.number().nonnegative().optional(),
}).strict();

const elementVocabularySchema = z.object({
  anchors: z.array(z.string().min(1)).min(1),
  palette_progression: z.array(z.object({
    cycle_range: z.tuple([z.number().int(), z.number().int()]),
    palette: z.string().min(1),
  }).strict()),
  introduce_at: z.record(z.string(), z.number().int().nonnegative()),
  retire_at: z.record(z.string(), z.number().int().nonnegative()),
}).strict();

const foreshadowSchema = z.object({
  plant_at: z.number().int().nonnegative(),
  pay_off_at: z.number().int().nonnegative(),
  note: z.string().min(1),
}).strict();

export const compositionPlanSchema = z.object({
  track_id: z.string().min(1),
  duration_s: z.number().positive(),
  cycle_count: z.number().int().positive(),
  overall_arc: z.array(arcEntrySchema).min(1),
  per_cycle_intent: z.array(cycleIntentSchema),
  element_vocabulary: elementVocabularySchema,
  foreshadow_pairs: z.array(foreshadowSchema),
  anticipation_offsets_ms: z.record(z.string(), z.number().int()),
  model: z.string().min(1),
  thinking_budget: z.number().int().positive(),
  baked_at: z.string().min(1),
}).strict().refine(
  (p) => p.per_cycle_intent.length === p.cycle_count,
  { message: "per_cycle_intent.length must equal cycle_count" },
).refine(
  (p) => p.per_cycle_intent.every((e, i) => e.cycle === i),
  { message: "per_cycle_intent[i].cycle must equal i (0-indexed, in order)" },
);

const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.any()),
}).strict();

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
}).passthrough();

export const cycleOutputSchema = z.object({
  cycle_index: z.number().int().nonnegative(),
  cycle_id: z.string().min(1),
  model: z.string().min(1),
  thinking_budget: z.number().int().positive(),
  rationale: z.string(),
  tool_calls: z.array(toolCallSchema),
  input_signature: z.string().min(8),
  stop_reason: z.string().min(1),
  usage: usageSchema,
  baked_at: z.string().min(1),
}).strict();

export const cycleV2Schema = cycleOutputSchema.extend({
  refined_from: z.string().min(1),
  critique_note: z.string().min(1),
  critique_suggestion: z.string().min(1),
}).strict();

export const critiqueSchema = z.object({
  weak_cycles: z.array(z.object({
    cycle: z.number().int().nonnegative(),
    issue: z.string().min(1),
    suggestion: z.string().min(1),
  }).strict()),
  global_notes: z.string(),
  model: z.string().min(1),
  thinking_budget: z.number().int().positive(),
  critiqued_at: z.string().min(1),
}).strict();

export function validateOrThrow(schema, obj, label) {
  const result = schema.safeParse(obj);
  if (!result.success) {
    const summary = result.error.errors.map(
      (e) => `${e.path.join(".") || "<root>"}: ${e.message}`,
    ).join("; ");
    const err = new Error(`${label} schema validation failed: ${summary}`);
    err.zodErrors = result.error.errors;
    throw err;
  }
  return result.data;
}

export function appendValidationLog(logPath, attempt, error) {
  ensureDir(dirname(logPath));
  const stamp = new Date().toISOString();
  const line = `[${stamp}] attempt ${attempt}: ${error.message}\n`;
  writeFileSync(logPath, line, { flag: "a" });
}

// ─── Self-tests ────────────────────────────────────────────────────

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  let pass = 0;
  let fail = 0;
  async function t(desc, fn) {
    try { await fn(); pass += 1; process.stdout.write(`  ok  ${desc}\n`); }
    catch (err) { fail += 1; process.stdout.write(`  FAIL ${desc}\n    ${err.message}\n`); }
  }

  await t("bakeDirLayout returns absolute paths under root", () => {
    const layout = bakeDirLayout("/tmp/bake_xyz");
    assert.equal(layout.root, "/tmp/bake_xyz");
    assert.equal(layout.compositionPlanJson, "/tmp/bake_xyz/composition_plan.json");
    assert.equal(layout.cyclesDir, "/tmp/bake_xyz/cycles");
  });

  await t("cyclePaths zero-pads index to 3 digits", () => {
    const paths = cyclePaths(bakeDirLayout("/tmp/x"), 7);
    assert.match(paths.json, /cycle_007\.json$/);
    assert.match(paths.v2Json, /cycle_007_v2\.json$/);
  });

  await t("compositionPlanSchema accepts a valid plan", () => {
    const plan = {
      track_id: "song1", duration_s: 140.1, cycle_count: 2,
      overall_arc: [{ act_index: 0, name: "Birth", cycle_range: [0, 1], intent: "x" }],
      per_cycle_intent: [
        { cycle: 0, active_act: 0, intent: "a", energy_hint: "low" },
        { cycle: 1, active_act: 0, intent: "b", energy_hint: "rising" },
      ],
      element_vocabulary: { anchors: ["x"], palette_progression: [], introduce_at: {}, retire_at: {} },
      foreshadow_pairs: [],
      anticipation_offsets_ms: { "0": 0 },
      model: "claude-opus-4-7", thinking_budget: 49152, baked_at: "2026-04-25T00:00:00Z",
    };
    const parsed = validateOrThrow(compositionPlanSchema, plan, "test");
    assert.equal(parsed.cycle_count, 2);
  });

  await t("compositionPlanSchema rejects per_cycle_intent length mismatch", () => {
    const plan = {
      track_id: "x", duration_s: 1, cycle_count: 3,
      overall_arc: [{ act_index: 0, name: "n", cycle_range: [0, 0], intent: "i" }],
      per_cycle_intent: [
        { cycle: 0, active_act: 0, intent: "a", energy_hint: "low" },
        { cycle: 1, active_act: 0, intent: "b", energy_hint: "low" },
      ],
      element_vocabulary: { anchors: ["x"], palette_progression: [], introduce_at: {}, retire_at: {} },
      foreshadow_pairs: [],
      anticipation_offsets_ms: { "0": 0 },
      model: "m", thinking_budget: 1, baked_at: "z",
    };
    assert.throws(() => validateOrThrow(compositionPlanSchema, plan, "t"),
                  /per_cycle_intent\.length must equal cycle_count/);
  });

  await t("compositionPlanSchema rejects out-of-order per_cycle_intent", () => {
    const plan = {
      track_id: "x", duration_s: 1, cycle_count: 2,
      overall_arc: [{ act_index: 0, name: "n", cycle_range: [0, 1], intent: "i" }],
      per_cycle_intent: [
        { cycle: 1, active_act: 0, intent: "a", energy_hint: "low" },
        { cycle: 0, active_act: 0, intent: "b", energy_hint: "low" },
      ],
      element_vocabulary: { anchors: ["x"], palette_progression: [], introduce_at: {}, retire_at: {} },
      foreshadow_pairs: [],
      anticipation_offsets_ms: { "0": 0 },
      model: "m", thinking_budget: 1, baked_at: "z",
    };
    assert.throws(() => validateOrThrow(compositionPlanSchema, plan, "t"),
                  /per_cycle_intent\[i\]\.cycle must equal i/);
  });

  await t("cycleOutputSchema accepts a valid cycle", () => {
    const cycle = {
      cycle_index: 5, cycle_id: "cycle_005", model: "m", thinking_budget: 100,
      rationale: "I chose stillness because the audio is quiet.",
      tool_calls: [{ id: "t1", name: "addText", input: { text: "x" } }],
      input_signature: "abcd1234efgh5678", stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
      baked_at: "2026-04-25T00:00:00Z",
    };
    validateOrThrow(cycleOutputSchema, cycle, "cycle");
  });

  await t("cycleV2Schema requires refined_from and critique fields", () => {
    const v2 = {
      cycle_index: 5, cycle_id: "cycle_005", model: "m", thinking_budget: 100,
      rationale: "Refined for coherence.",
      tool_calls: [], input_signature: "x_v2_signature_here", stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
      baked_at: "2026-04-25T00:01:00Z",
      refined_from: "cycle_005.json",
      critique_note: "introduces orphan motif",
      critique_suggestion: "carry forward or retire",
    };
    validateOrThrow(cycleV2Schema, v2, "v2");
  });

  await t("critiqueSchema accepts empty weak_cycles", () => {
    const c = {
      weak_cycles: [], global_notes: "all good",
      model: "m", thinking_budget: 100, critiqued_at: "z",
    };
    validateOrThrow(critiqueSchema, c, "critique");
  });

  await t("validateOrThrow surfaces zod path in error message", () => {
    try {
      validateOrThrow(compositionPlanSchema, { track_id: 1 }, "x");
      assert.fail("should have thrown");
    } catch (err) {
      assert.match(err.message, /track_id/);
    }
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
}
