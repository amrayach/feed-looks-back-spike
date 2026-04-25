#!/usr/bin/env node
// node/src/bake_watch.mjs
// Open a stage server and watch a baked bundle play out in the browser,
// with cycle patches firing at audio-aligned timestamps.
//
// Usage:
//   node node/src/bake_watch.mjs --use-baked bake_song1 \
//        --stage-audio "audio/song 1.wav"
//
// Pipeline per cycle (mirrors run_spike.mjs live path, minus Opus call):
//   beginCycle(state, …)
//   broadcast cycle.begin
//   for each tool_call: applyToolCallDetailed(state, …) → broadcast each patch
// Server stays alive for duration + tail so the user can watch.

import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createStageServer } from "./stage_server.mjs";
import {
  loadBakeDirectory, getBakedCycle, enumerateBakedCycles, getAnticipationOffsetMs,
} from "./bake_player.mjs";
import { createInitialState, beginCycle } from "./scene_state.mjs";
import { applyToolCallDetailed } from "./tool_handlers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_ROOT = join(__dirname, "..");

async function main() {
  const { values } = parseArgs({
    options: {
      "use-baked":     { type: "string" },
      "stage-audio":   { type: "string" },
      "lead-seconds":  { type: "string", default: "8" },
    },
  });

  if (!values["use-baked"]) {
    process.stderr.write("Usage: node bake_watch.mjs --use-baked <dir> [--stage-audio <wav>] [--lead-seconds N]\n");
    process.exit(1);
  }

  const bakeDir = resolve(values["use-baked"]);
  const stageAudioPath = values["stage-audio"] ? resolve(values["stage-audio"]) : null;
  const leadSeconds = parseInt(values["lead-seconds"], 10);

  const { plan } = loadBakeDirectory(bakeDir);
  const indices = enumerateBakedCycles(bakeDir);

  const stageServer = await createStageServer({ port: 9999 });
  const runId = `watch_${Date.now().toString(36)}`;
  const runDir = join(NODE_ROOT, "output", `run_${runId}`);
  mkdirSync(runDir, { recursive: true });

  if (stageAudioPath && existsSync(stageAudioPath)) {
    copyFileSync(stageAudioPath, join(runDir, "audio.wav"));
  }

  // mode "precompute" auto-plays the served audio.wav in the browser
  // and tells stage.html to render bootstrap with audio transport.
  await stageServer.setCurrentRunContext({ runId, mode: "precompute", runDir });
  const showUrl = stageServer.getShowUrl({ runId, mode: "precompute" });
  const operatorUrl = stageServer.getOperatorUrl({ runId, mode: "precompute" });

  process.stdout.write(`\n=================== bake_watch ===================\n`);
  process.stdout.write(`track:    ${plan.track_id}\n`);
  process.stdout.write(`duration: ${plan.duration_s.toFixed(1)}s, ${indices.length} cycles\n`);
  process.stdout.write(`show:     ${showUrl}\n`);
  process.stdout.write(`stage:    ${operatorUrl}\n`);
  process.stdout.write(`\nFirst cycle fires in ~${leadSeconds}s. Open the show URL,\n`);
  process.stdout.write(`audio will autoplay (click once if browser blocks autoplay).\n`);
  process.stdout.write(`==================================================\n\n`);

  const state = createInitialState();
  const audioStartMs = Date.now() + leadSeconds * 1000;

  async function fireCycle(idx) {
    const cycle = getBakedCycle(bakeDir, idx);
    const intent = plan.per_cycle_intent[idx];
    const elapsedTotalS = intent?.snapshot_time_s ?? idx * 5;

    beginCycle(state, { cycleIndex: idx, elapsedTotalS });

    await stageServer.broadcastPatch({
      type: "cycle.begin",
      cycle_n: idx,
      hijaz_state: {},
    });

    process.stdout.write(`  cycle ${String(idx).padStart(3, "0")} (t=${elapsedTotalS.toFixed(1)}s): ${cycle.tool_calls.length} tool call(s)\n`);

    for (const toolCall of cycle.tool_calls) {
      const block = { type: "tool_use", id: toolCall.id, name: toolCall.name, input: toolCall.input };
      try {
        const detailed = await applyToolCallDetailed(state, block);
        for (const patch of detailed.patches ?? []) {
          await stageServer.broadcastPatch(patch);
        }
      } catch (err) {
        process.stderr.write(`    tool_call ${toolCall.name} failed: ${err.message}\n`);
      }
    }
  }

  // Schedule each cycle on its own setTimeout.
  for (const idx of indices) {
    const intent = plan.per_cycle_intent[idx];
    const snapshotMs = (intent?.snapshot_time_s ?? idx * 5) * 1000;
    const offsetMs = getAnticipationOffsetMs(plan, idx);
    const fireAt = audioStartMs + snapshotMs + offsetMs;
    const delayMs = Math.max(0, fireAt - Date.now());
    setTimeout(() => { fireCycle(idx).catch((e) => process.stderr.write(`cycle ${idx} error: ${e.message}\n`)); }, delayMs);
  }

  // Stay alive until track finishes + a tail for the closing tableau.
  const tailMs = 15_000;
  const totalMs = leadSeconds * 1000 + plan.duration_s * 1000 + tailMs;
  await new Promise((r) => setTimeout(r, totalMs));

  process.stdout.write(`\nplayback complete; closing server.\n`);
  await stageServer.close();
}

await main();
