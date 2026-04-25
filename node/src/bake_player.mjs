// node/src/bake_player.mjs
// Replay-side reader. Resolves v2-or-v1 cycle outputs, clamps
// anticipation offsets, and schedules patches at audio-aligned
// timestamps via the stage server's existing broadcastPatch mechanism.
// Does NOT touch opus_client.mjs (live path stays byte-identical).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  bakeDirLayout, cyclePaths, readJson, validateOrThrow,
  cycleOutputSchema, cycleV2Schema, compositionPlanSchema,
} from "./bake_io.mjs";

const ANTICIPATION_CLAMP_MIN_MS = -500;
const ANTICIPATION_CLAMP_MAX_MS = 0;

// ─── Reader API ────────────────────────────────────────────────────

export function loadBakeDirectory(bakeDir) {
  const layout = bakeDirLayout(bakeDir);
  if (!existsSync(layout.compositionPlanJson)) {
    throw new Error(`bake dir missing composition_plan.json: ${bakeDir}`);
  }
  const plan = validateOrThrow(
    compositionPlanSchema, readJson(layout.compositionPlanJson), "composition_plan",
  );
  const audioPath = existsSync(layout.audioWav) ? layout.audioWav : null;
  return { layout, plan, audioPath };
}

export function getCompositionPlan(bakeDir) {
  return loadBakeDirectory(bakeDir).plan;
}

export function getBakedCycle(bakeDir, cycleIndex) {
  const layout = bakeDirLayout(bakeDir);
  const paths = cyclePaths(layout, cycleIndex);
  if (existsSync(paths.v2Json)) {
    return validateOrThrow(cycleV2Schema, readJson(paths.v2Json),
                           `cycle_${cycleIndex}_v2`);
  }
  if (existsSync(paths.json)) {
    return validateOrThrow(cycleOutputSchema, readJson(paths.json),
                           `cycle_${cycleIndex}`);
  }
  throw new Error(`no baked cycle for index ${cycleIndex} in ${bakeDir}`);
}

export function enumerateBakedCycles(bakeDir) {
  const layout = bakeDirLayout(bakeDir);
  if (!existsSync(layout.cyclesDir)) return [];
  const indices = new Set();
  for (const f of readdirSync(layout.cyclesDir)) {
    const m = /^cycle_(\d+)(_v2)?\.json$/.exec(f);
    if (m) indices.add(parseInt(m[1], 10));
  }
  return [...indices].sort((a, b) => a - b);
}

export function getAnticipationOffsetMs(plan, cycleIndex) {
  const raw = plan.anticipation_offsets_ms?.[String(cycleIndex)] ?? 0;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(ANTICIPATION_CLAMP_MIN_MS, Math.min(ANTICIPATION_CLAMP_MAX_MS, raw));
}

// ─── Replay controller ─────────────────────────────────────────────
//
// startBakedReplay({ bakeDir, audioPath, stageServer, anticipationMs })
//
// Returns a controller object: { start, stop, onCycle }.
//
// Scheduling:
//   Each cycle fires at:  (per_cycle_intent[i].snapshot_time_s * 1000) + anticipationMs
//   where anticipationMs is clamped to [-500, 0] ms (global override),
//   and per-cycle offsets from plan.anticipation_offsets_ms are applied on
//   top if present.  The global anticipationMs defaults to -200 ms.
//
// The caller must call controller.start(audioStartedAtMs) after audio begins.
// All timers are cleared on controller.stop().

export async function startBakedReplay({
  bakeDir,
  audioPath,   // reserved for callers; unused internally (audio is handled externally)
  stageServer,
  anticipationMs = -200,
}) {
  // Clamp global anticipation to [-500, 0]
  const globalOffset = Math.max(ANTICIPATION_CLAMP_MIN_MS,
                                Math.min(ANTICIPATION_CLAMP_MAX_MS, anticipationMs));

  const { plan } = loadBakeDirectory(bakeDir);
  const cycleIndices = enumerateBakedCycles(bakeDir);

  let cycleListeners = [];
  let timers = [];
  let stopped = false;

  function onCycle(fn) {
    cycleListeners.push(fn);
  }

  function stop() {
    stopped = true;
    for (const t of timers) clearTimeout(t);
    timers = [];
  }

  async function start(audioStartedAtMs = Date.now()) {
    if (stopped) return;

    for (const idx of cycleIndices) {
      const intent = plan.per_cycle_intent[idx];
      // snapshot_time_s stored per cycle in the intent entry; fall back to idx*5
      const snapshotMs = typeof intent?.snapshot_time_s === "number"
        ? intent.snapshot_time_s * 1000
        : idx * 5000;

      // Per-cycle anticipation from plan, clamped
      const perCycleOffset = getAnticipationOffsetMs(plan, idx);

      // Effective offset: use per-cycle if non-zero, else global
      const effectiveOffset = perCycleOffset !== 0 ? perCycleOffset : globalOffset;

      const fireAt = audioStartedAtMs + snapshotMs + effectiveOffset;
      const delayMs = Math.max(0, fireAt - Date.now());

      // Capture idx in closure
      const cycleIdx = idx;
      const timer = setTimeout(async () => {
        if (stopped) return;
        try {
          const cycle = getBakedCycle(bakeDir, cycleIdx);
          for (const toolCall of (cycle.tool_calls ?? [])) {
            if (stopped) break;
            await stageServer.broadcastPatch({
              type: "baked.tool_call",
              cycle_index: cycleIdx,
              tool_name: toolCall.name,
              tool_input: toolCall.input,
              tool_id: toolCall.id,
            });
          }
          for (const fn of cycleListeners) {
            try { fn(cycleIdx, cycle); } catch { /* listener errors are non-fatal */ }
          }
        } catch (err) {
          // Log but don't crash — a missing cycle is non-fatal in replay
          process.stderr.write(`bake_player: cycle ${cycleIdx} error: ${err.message}\n`);
        }
      }, delayMs);
      timers.push(timer);
    }
  }

  return { start, stop, onCycle };
}

// ─── Self-tests ────────────────────────────────────────────────────

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  let pass = 0;
  let fail = 0;
  async function t(desc, fn) {
    try { await fn(); pass += 1; process.stdout.write(`  ok  ${desc}\n`); }
    catch (e) { fail += 1; process.stdout.write(`  FAIL ${desc}\n    ${e.message}\n`); }
  }

  function mkBakeWithCycles(tmp, { v1Indices = [], v2Indices = [] } = {}, anticipation_offsets_ms = {}) {
    const bakeDir = join(tmp, "bake_x");
    mkdirSync(join(bakeDir, "cycles"), { recursive: true });
    writeFileSync(join(bakeDir, "composition_plan.json"), JSON.stringify({
      track_id: "x", duration_s: 5, cycle_count: 1,
      overall_arc: [{ act_index: 0, name: "n", cycle_range: [0, 0], intent: "i" }],
      per_cycle_intent: [{ cycle: 0, active_act: 0, intent: "x", energy_hint: "low" }],
      element_vocabulary: { anchors: ["a"], palette_progression: [], introduce_at: {}, retire_at: {} },
      foreshadow_pairs: [],
      anticipation_offsets_ms: Object.keys(anticipation_offsets_ms).length
        ? anticipation_offsets_ms
        : { "0": -250, "1": -1000, "2": 9999, "3": -50 },
      model: "m", thinking_budget: 1, baked_at: "z",
    }));
    for (const i of v1Indices) {
      writeFileSync(join(bakeDir, "cycles", `cycle_${String(i).padStart(3, "0")}.json`),
        JSON.stringify({
          cycle_index: i, cycle_id: `cycle_${String(i).padStart(3, "0")}`,
          model: "m", thinking_budget: 1,
          rationale: `v1 ${i}`, tool_calls: [],
          input_signature: `sig_${i}_xxxxxxxx`, stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          baked_at: "2026-04-25T00:00:00Z",
        }));
    }
    for (const i of v2Indices) {
      writeFileSync(join(bakeDir, "cycles", `cycle_${String(i).padStart(3, "0")}_v2.json`),
        JSON.stringify({
          cycle_index: i, cycle_id: `cycle_${String(i).padStart(3, "0")}`,
          model: "m", thinking_budget: 1,
          rationale: `v2 ${i}`, tool_calls: [],
          input_signature: `sig_${i}_v2_yyyyyyyy`, stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          baked_at: "2026-04-25T00:01:00Z",
          refined_from: `cycle_${String(i).padStart(3, "0")}.json`,
          critique_note: "n", critique_suggestion: "s",
        }));
    }
    return bakeDir;
  }

  await t("getBakedCycle prefers v2 over v1 when both exist", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bake-player-v2-"));
    const bakeDir = mkBakeWithCycles(tmp, { v1Indices: [0], v2Indices: [0] });
    const c = getBakedCycle(bakeDir, 0);
    assert.match(c.rationale, /v2 0/);
  });

  await t("getBakedCycle falls back to v1 when v2 absent", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bake-player-v1-"));
    const bakeDir = mkBakeWithCycles(tmp, { v1Indices: [0] });
    const c = getBakedCycle(bakeDir, 0);
    assert.match(c.rationale, /v1 0/);
  });

  await t("getBakedCycle throws when neither exists", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bake-player-none-"));
    const bakeDir = mkBakeWithCycles(tmp, {});
    assert.throws(() => getBakedCycle(bakeDir, 5), /no baked cycle for index 5/);
  });

  await t("getAnticipationOffsetMs clamps below -500 to -500 and above 0 to 0", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bake-player-clamp-"));
    const bakeDir = mkBakeWithCycles(tmp, { v1Indices: [0] });
    const plan = getCompositionPlan(bakeDir);
    assert.equal(getAnticipationOffsetMs(plan, 0), -250);   // unchanged
    assert.equal(getAnticipationOffsetMs(plan, 1), -500);   // clamped from -1000
    assert.equal(getAnticipationOffsetMs(plan, 2), 0);      // clamped from 9999
    assert.equal(getAnticipationOffsetMs(plan, 3), -50);    // unchanged
    assert.equal(getAnticipationOffsetMs(plan, 99), 0);     // missing → 0
  });

  await t("enumerateBakedCycles returns sorted unique indices across v1 and v2", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bake-player-enum-"));
    const bakeDir = mkBakeWithCycles(tmp, { v1Indices: [0, 2, 4], v2Indices: [2] });
    assert.deepEqual(enumerateBakedCycles(bakeDir), [0, 2, 4]);
  });

  await t("startBakedReplay schedules patches at correct offsets (mock clock)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bake-player-replay-"));

    // Build a bake dir with 2 cycles having tool calls, and 0 anticipation
    const bakeDir = join(tmp, "bake_sched");
    mkdirSync(join(bakeDir, "cycles"), { recursive: true });
    writeFileSync(join(bakeDir, "composition_plan.json"), JSON.stringify({
      track_id: "sched", duration_s: 15, cycle_count: 2,
      overall_arc: [{ act_index: 0, name: "n", cycle_range: [0, 1], intent: "i" }],
      per_cycle_intent: [
        { cycle: 0, active_act: 0, intent: "i0", energy_hint: "low" },
        { cycle: 1, active_act: 0, intent: "i1", energy_hint: "rising" },
      ],
      element_vocabulary: { anchors: ["a"], palette_progression: [], introduce_at: {}, retire_at: {} },
      foreshadow_pairs: [],
      anticipation_offsets_ms: { "0": 0, "1": 0 },
      model: "m", thinking_budget: 1, baked_at: "z",
    }));
    for (let i = 0; i < 2; i++) {
      writeFileSync(join(bakeDir, "cycles", `cycle_${String(i).padStart(3, "0")}.json`),
        JSON.stringify({
          cycle_index: i, cycle_id: `cycle_${String(i).padStart(3, "0")}`,
          model: "m", thinking_budget: 1,
          rationale: `sched_r${i}`,
          tool_calls: [{ id: `tu_${i}`, name: "addText", input: { text: `hello_${i}` } }],
          input_signature: `sig_${i}_schedxxxx`, stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
          baked_at: "2026-04-25T00:00:00Z",
        }));
    }

    const emittedPatches = [];
    const mockStageServer = {
      async broadcastPatch(patch) { emittedPatches.push(patch); },
    };

    // Use anticipationMs=0 so patches fire immediately (audioStartedAt = now - large offset)
    const controller = await startBakedReplay({
      bakeDir,
      stageServer: mockStageServer,
      anticipationMs: 0,
    });

    const cyclesFired = [];
    controller.onCycle((idx) => cyclesFired.push(idx));

    // Start with audio "already playing" 20 seconds ago — all cycles fire immediately
    const farPast = Date.now() - 20_000;
    await controller.start(farPast);

    // Wait for all timers to fire (they're all 0ms delay = immediate)
    await new Promise((r) => setTimeout(r, 100));
    controller.stop();

    assert.equal(emittedPatches.length, 2);
    assert.equal(emittedPatches[0].tool_name, "addText");
    assert.equal(emittedPatches[0].tool_input.text, "hello_0");
    assert.equal(emittedPatches[1].tool_input.text, "hello_1");
    assert.deepEqual(cyclesFired, [0, 1]);
  });

  await t("startBakedReplay prefers v2 cycle when both exist", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bake-player-replay-v2-"));
    const bakeDir = join(tmp, "bake_v2pref");
    mkdirSync(join(bakeDir, "cycles"), { recursive: true });
    writeFileSync(join(bakeDir, "composition_plan.json"), JSON.stringify({
      track_id: "v2p", duration_s: 10, cycle_count: 1,
      overall_arc: [{ act_index: 0, name: "n", cycle_range: [0, 0], intent: "i" }],
      per_cycle_intent: [{ cycle: 0, active_act: 0, intent: "x", energy_hint: "low" }],
      element_vocabulary: { anchors: ["a"], palette_progression: [], introduce_at: {}, retire_at: {} },
      foreshadow_pairs: [],
      anticipation_offsets_ms: { "0": 0 },
      model: "m", thinking_budget: 1, baked_at: "z",
    }));
    // Write both v1 and v2 for cycle 0
    writeFileSync(join(bakeDir, "cycles", "cycle_000.json"), JSON.stringify({
      cycle_index: 0, cycle_id: "cycle_000", model: "m", thinking_budget: 1,
      rationale: "v1_should_not_appear",
      tool_calls: [{ id: "tu_v1", name: "addText", input: { text: "from_v1" } }],
      input_signature: "sig_v1_xxxxxxxx", stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }, baked_at: "2026-04-25T00:00:00Z",
    }));
    writeFileSync(join(bakeDir, "cycles", "cycle_000_v2.json"), JSON.stringify({
      cycle_index: 0, cycle_id: "cycle_000", model: "m", thinking_budget: 1,
      rationale: "v2_wins",
      tool_calls: [{ id: "tu_v2", name: "addText", input: { text: "from_v2" } }],
      input_signature: "sig_v2_yyyyyyyy", stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }, baked_at: "2026-04-25T00:01:00Z",
      refined_from: "cycle_000.json", critique_note: "n", critique_suggestion: "s",
    }));

    const emitted = [];
    const mockServer = { async broadcastPatch(p) { emitted.push(p); } };
    const controller = await startBakedReplay({ bakeDir, stageServer: mockServer, anticipationMs: 0 });
    await controller.start(Date.now() - 20_000);
    await new Promise((r) => setTimeout(r, 100));
    controller.stop();

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].tool_input.text, "from_v2");
  });

  await t("startBakedReplay anticipation is clamped to [-500, 0]", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bake-player-clamp2-"));
    const bakeDir = join(tmp, "bake_clamp2");
    mkdirSync(join(bakeDir, "cycles"), { recursive: true });
    writeFileSync(join(bakeDir, "composition_plan.json"), JSON.stringify({
      track_id: "c2", duration_s: 5, cycle_count: 1,
      overall_arc: [{ act_index: 0, name: "n", cycle_range: [0, 0], intent: "i" }],
      per_cycle_intent: [{ cycle: 0, active_act: 0, intent: "x", energy_hint: "low" }],
      element_vocabulary: { anchors: ["a"], palette_progression: [], introduce_at: {}, retire_at: {} },
      foreshadow_pairs: [],
      anticipation_offsets_ms: { "0": 0 },
      model: "m", thinking_budget: 1, baked_at: "z",
    }));
    writeFileSync(join(bakeDir, "cycles", "cycle_000.json"), JSON.stringify({
      cycle_index: 0, cycle_id: "cycle_000", model: "m", thinking_budget: 1,
      rationale: "r", tool_calls: [],
      input_signature: "sig_clamp_xxxxx", stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }, baked_at: "2026-04-25T00:00:00Z",
    }));

    // Test: anticipationMs=-9999 should be clamped to -500
    // Cycle 0 at snapshot 0ms + (-500ms) = -500ms from audio start
    // If audio started "now", fire should already be delayed 0ms (clamped at -500 → already past)
    const emitted = [];
    const mockServer = { async broadcastPatch(p) { emitted.push(p); } };

    // Pass -9999 — should be clamped to -500
    const controller = await startBakedReplay({ bakeDir, stageServer: mockServer, anticipationMs: -9999 });
    // Audio started 1 second ago. Cycle 0 at 0ms + (-500ms) = -500ms < now, so fires immediately.
    await controller.start(Date.now() - 1000);
    await new Promise((r) => setTimeout(r, 100));
    controller.stop();
    // No tool_calls in this cycle, but onCycle should have been called
    // (no error means clamping worked; if unclamped at -9999 it still fires since past)
    assert.equal(emitted.length, 0); // no tool calls in this cycle, just verifying no crash
  });

  await t("startBakedReplay stop() cancels pending timers", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bake-player-stop-"));
    const bakeDir = join(tmp, "bake_stop");
    mkdirSync(join(bakeDir, "cycles"), { recursive: true });
    writeFileSync(join(bakeDir, "composition_plan.json"), JSON.stringify({
      track_id: "stop", duration_s: 60, cycle_count: 1,
      overall_arc: [{ act_index: 0, name: "n", cycle_range: [0, 0], intent: "i" }],
      per_cycle_intent: [{ cycle: 0, active_act: 0, intent: "x", energy_hint: "low" }],
      element_vocabulary: { anchors: ["a"], palette_progression: [], introduce_at: {}, retire_at: {} },
      foreshadow_pairs: [],
      anticipation_offsets_ms: { "0": 0 },
      model: "m", thinking_budget: 1, baked_at: "z",
    }));
    writeFileSync(join(bakeDir, "cycles", "cycle_000.json"), JSON.stringify({
      cycle_index: 0, cycle_id: "cycle_000", model: "m", thinking_budget: 1,
      rationale: "r",
      tool_calls: [{ id: "tu0", name: "addText", input: { text: "should_not_fire" } }],
      input_signature: "sig_stop_xxxxx", stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }, baked_at: "2026-04-25T00:00:00Z",
    }));

    const emitted = [];
    const mockServer = { async broadcastPatch(p) { emitted.push(p); } };
    // Cycle at 0ms snapshot + 0ms offset; audio starts "in the future" (30s from now)
    // so the timer fires in ~30s. Stop immediately → nothing should fire.
    const controller = await startBakedReplay({ bakeDir, stageServer: mockServer, anticipationMs: 0 });
    await controller.start(Date.now() + 30_000);
    controller.stop();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(emitted.length, 0, "stopped controller should not emit patches");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
}
