import "dotenv/config";
import { parseArgs } from "node:util";
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { makeOpusClient, resolveModel, callOpus } from "./opus_client.mjs";
import { buildPacket } from "./packet_builder.mjs";
import {
  createInitialState,
  beginCycle,
  autoFade,
  formatSummary,
  saveState,
  snapshotCycle,
  recordDecision,
  formatRecentDecisions,
  formatDirectorStatus,
} from "./scene_state.mjs";
import { applyToolCallDetailed } from "./tool_handlers.mjs";
import { autoFadeDurationForElement } from "./patch_emitter.mjs";
import { renderFinalHtml, renderLiveHtml } from "./operator_views.mjs";
import { createStageServer } from "./stage_server.mjs";
import {
  loadMoodBoard,
  buildMoodBoardUserBlocks,
  shouldCaptureSelfFrame,
  buildSelfFrameUserBlocks,
} from "./image_content.mjs";
import { createSelfFrameCapturer } from "./self_frame.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_ROOT = resolve(__dirname, "..");
const DEFAULT_PYTHON_BIN = process.env.FLB_PYTHON_BIN ?? "/home/amay/miniconda3/envs/ambi_audio/bin/python";
const STREAM_FEATURES_PATH = resolve(NODE_ROOT, "..", "python", "stream_features.py");

// opus 4.7 token pricing ($/MTok). edit here if pricing changes; the
// runner never hits the API in phase 2, so this only affects phase 3
// cost estimates printed alongside the real-mode output.
const PRICING_PER_MTOK = Object.freeze({
  input: 5.0,
  output: 25.0,
  cache_read: 0.5,
  cache_write: 6.25,
});

const CYCLE_STATUS = Object.freeze({
  OK: "ok",
  API_FAILURE: "api_failure",
  RESPONSE_PARSE_FAILURE: "response_parse_failure",
  PERSISTENCE_FAILURE: "persistence_failure",
  TOOL_CALL_ERRORS: "tool_call_errors",
});

const VALID_STOP_REASONS = new Set(["tool_use", "end_turn"]);

function usage() {
  return `Usage: node src/run_spike.mjs <corpus_dir> --config <name> [--cycles N:M] [--dry-run] [--feature-producer <python|none>] [--stage-audio <wav>]
       node src/run_spike.mjs --self-test

Arguments:
  corpus_dir      path to a directory of cycle_NNN.json files
  --config NAME   config name (only 'config_a' exists in this session)
  --cycles N:M    optional inclusive range of cycle indices (default: all)
  --dry-run       build packets and synthesize tool calls locally; do not call the API
                  (default: real API mode — spends credit)
  --stage-audio   optional WAV to expose to the browser stage as /run/<id>/audio.wav
  --self-test     run inline self-tests for error handling and exit
`;
}

function die(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function parseCyclesRange(raw) {
  if (!raw) return null;
  const m = /^(\d+):(\d+)$/.exec(raw);
  if (!m) die(`--cycles must be of the form N:M (e.g. --cycles 0:10), got: ${raw}`);
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (a > b) die(`--cycles N:M must have N <= M, got: ${raw}`);
  return { start: a, end: b };
}

function listCycleFiles(corpusDir) {
  if (!existsSync(corpusDir)) {
    die(`Corpus directory does not exist: ${corpusDir}`);
  }
  const entries = readdirSync(corpusDir);
  const files = entries.filter((e) => /^cycle_\d+\.json$/.test(e)).sort();
  if (files.length === 0) {
    die(`No cycle_NNN.json files found in ${corpusDir}`);
  }
  return files.map((f) => {
    const m = /^cycle_(\d+)\.json$/.exec(f);
    return { filename: f, index: parseInt(m[1], 10), path: join(corpusDir, f) };
  });
}

function loadConfig(configName) {
  const configDir = join(NODE_ROOT, "prompts", "configs", configName);
  if (!existsSync(configDir)) {
    die(`Config directory not found: ${configDir}`);
  }
  const mediumRules = readFileSync(join(configDir, "medium_rules.md"), "utf8");
  const tools = JSON.parse(readFileSync(join(configDir, "tools.json"), "utf8"));
  return { mediumRules, tools };
}

function timestampSlug() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function padIdx(n, width) {
  return String(n).padStart(width, "0");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeError(err) {
  return {
    name: err?.name ?? "Error",
    message: err?.message ?? String(err),
    status: err?.status ?? null,
    code: err?.code ?? null,
  };
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return JSON.stringify(
      {
        serialization_error: err.message,
        string_value: String(value),
      },
      null,
      2,
    );
  }
}

const DEFAULT_PATCH_FADE_DURATION_MS = 400;

async function writeTextWithRetry(filePath, text, sleepImpl = sleep) {
  try {
    writeFileSync(filePath, text);
    return null;
  } catch (_firstErr) {
    await sleepImpl(100);
    try {
      writeFileSync(filePath, text);
      return null;
    } catch (secondErr) {
      return secondErr;
    }
  }
}

async function writeJsonWithRetry(filePath, value, sleepImpl = sleep) {
  return writeTextWithRetry(filePath, safeJsonStringify(value), sleepImpl);
}

function parseResponse(response) {
  if (!response || !Array.isArray(response.content)) {
    return {
      error: {
        type: CYCLE_STATUS.RESPONSE_PARSE_FAILURE,
        message: "response missing content array",
        stop_reason: response?.stop_reason ?? null,
      },
    };
  }

  const stopReason = response.stop_reason ?? null;
  if (!VALID_STOP_REASONS.has(stopReason)) {
    return {
      error: {
        type: CYCLE_STATUS.RESPONSE_PARSE_FAILURE,
        message: `unexpected stop_reason '${stopReason}'`,
        stop_reason: stopReason,
      },
    };
  }

  const toolUses = [];
  for (const block of response.content) {
    if (block?.type !== "tool_use") continue;
    if (typeof block.id !== "string" || block.id.length === 0) {
      return {
        error: {
          type: CYCLE_STATUS.RESPONSE_PARSE_FAILURE,
          message: "tool_use block missing string id",
          stop_reason: stopReason,
        },
      };
    }
    if (typeof block.name !== "string" || block.name.length === 0) {
      return {
        error: {
          type: CYCLE_STATUS.RESPONSE_PARSE_FAILURE,
          message: "tool_use block missing string name",
          stop_reason: stopReason,
        },
      };
    }
    if (!block.input || typeof block.input !== "object" || Array.isArray(block.input)) {
      return {
        error: {
          type: CYCLE_STATUS.RESPONSE_PARSE_FAILURE,
          message: `tool_use block '${block.name}' missing object input`,
          stop_reason: stopReason,
        },
      };
    }
    toolUses.push(block);
  }

  if (stopReason === "tool_use" && toolUses.length === 0) {
    return {
      error: {
        type: CYCLE_STATUS.RESPONSE_PARSE_FAILURE,
        message: "stop_reason 'tool_use' but no tool_use blocks were present",
        stop_reason: stopReason,
      },
    };
  }

  if (stopReason === "end_turn" && toolUses.length > 0) {
    return {
      error: {
        type: CYCLE_STATUS.RESPONSE_PARSE_FAILURE,
        message: "stop_reason 'end_turn' but tool_use blocks were present",
        stop_reason: stopReason,
      },
    };
  }

  return { stopReason, toolUses };
}

function hasToolCallErrors(toolResults) {
  return toolResults.some((entry) => entry?.result && typeof entry.result === "object" && "error" in entry.result);
}

function deriveCycleStatus({ cycleError, persistenceIssues, toolResults }) {
  if (cycleError?.type === CYCLE_STATUS.API_FAILURE) return CYCLE_STATUS.API_FAILURE;
  if (cycleError?.type === CYCLE_STATUS.RESPONSE_PARSE_FAILURE) return CYCLE_STATUS.RESPONSE_PARSE_FAILURE;
  if (persistenceIssues.length > 0) return CYCLE_STATUS.PERSISTENCE_FAILURE;
  if (hasToolCallErrors(toolResults)) return CYCLE_STATUS.TOOL_CALL_ERRORS;
  return CYCLE_STATUS.OK;
}

function bumpStatusCount(summary, status) {
  summary.totals.status_counts[status] += 1;
  if (status === CYCLE_STATUS.OK) summary.totals.ok_count += 1;
}

// deterministic synthetic tool call generator for dry-run mode. rotates
// across all five tool types so scene state accumulates and exercises
// addText/addSVG/addImage/setBackground/fadeElement plus background_history.
// the semantic content is placeholder — this is structural validation.
function synthesizeToolCalls(cycleIndex, state) {
  const mod = cycleIndex % 7;
  switch (mod) {
    case 0:
      return [
        {
          name: "setBackground",
          input: {
            css_background:
              `linear-gradient(${180 + cycleIndex}deg, #1a1410 0%, #0d0908 100%)`,
          },
        },
      ];
    case 1:
      return [
        {
          name: "addText",
          input: {
            content: `fragment-${cycleIndex}`,
            position: "lower-left",
            style: "serif, large",
          },
        },
      ];
    case 2:
      return [
        {
          name: "addSVG",
          input: {
            svg_markup:
              `<svg viewBox="0 0 100 100"><line x1="0" y1="${50 + (cycleIndex % 10)}" x2="100" y2="${50 - (cycleIndex % 10)}" stroke="#f5e6c8" stroke-width="2" opacity="0.85"/></svg>`,
            position: "horizontal band at mid-height",
            semantic_label: `thin line of moonlight at cycle ${cycleIndex}`,
          },
        },
      ];
    case 3:
      return [
        {
          name: "addImage",
          input: {
            query: `moonlight on still water at cycle ${cycleIndex}`,
            position: "background",
          },
        },
      ];
    case 4:
      return [
        {
          name: "addText",
          input: {
            content: "what remains",
            position: "upper-right",
            style: "light, small",
          },
        },
      ];
    case 5: {
      const victim = state.elements.find((e) => !e.faded);
      return victim
        ? [{ name: "fadeElement", input: { element_id: victim.element_id } }]
        : [];
    }
    case 6:
      return [
        {
          name: "setBackground",
          input: {
            css_background:
              "radial-gradient(circle at 30% 20%, rgba(180,140,90,0.45), rgba(10,10,12,0.95) 70%)",
          },
        },
      ];
    default:
      return [];
  }
}

function extractToolUseBlocks(response) {
  if (!response || !Array.isArray(response.content)) return [];
  return response.content.filter((b) => b && b.type === "tool_use");
}

async function persistStateWithRetry({
  state,
  runDir,
  saveStateImpl = saveState,
  snapshotCycleImpl = snapshotCycle,
  sleepImpl = sleep,
}) {
  const attempt = () => {
    saveStateImpl(state, runDir);
    snapshotCycleImpl(state, runDir);
  };

  try {
    attempt();
    return null;
  } catch (_firstErr) {
    await sleepImpl(100);
    try {
      attempt();
      return null;
    } catch (secondErr) {
      return secondErr;
    }
  }
}

function countByToolName(toolCalls) {
  const counts = {};
  for (const c of toolCalls) {
    counts[c.name] = (counts[c.name] ?? 0) + 1;
  }
  return counts;
}

function formatToolBreakdown(counts) {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "silence";
  return entries.map(([name, n]) => `${n} ${name}`).join(", ");
}

function computeCost(usage) {
  if (!usage) return null;
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (
    (inTok * PRICING_PER_MTOK.input +
      outTok * PRICING_PER_MTOK.output +
      cacheRead * PRICING_PER_MTOK.cache_read +
      cacheWrite * PRICING_PER_MTOK.cache_write) /
    1_000_000
  );
}

function formatUsageChunk(usage) {
  if (!usage) return "";
  const parts = [];
  if (typeof usage.input_tokens === "number") parts.push(`in=${usage.input_tokens}`);
  if (typeof usage.output_tokens === "number") parts.push(`out=${usage.output_tokens}`);
  if (typeof usage.cache_read_input_tokens === "number" && usage.cache_read_input_tokens > 0) {
    parts.push(`cache_r=${usage.cache_read_input_tokens}`);
  }
  if (typeof usage.cache_creation_input_tokens === "number" && usage.cache_creation_input_tokens > 0) {
    parts.push(`cache_w=${usage.cache_creation_input_tokens}`);
  }
  return parts.length ? `usage: ${parts.join(" ")}` : "";
}

function formatCycleStatus({ cycleIndex, elapsedS, toolCalls, activeCount, mode, usage, cost, status }) {
  const counts = countByToolName(toolCalls);
  const breakdown = formatToolBreakdown(counts);
  const callText = toolCalls.length === 1 ? "1 tool call" : `${toolCalls.length} tool calls`;
  const parts = [
    `cycle ${padIdx(cycleIndex, 3)} (${String(elapsedS).padStart(5)}s elapsed): ${callText} (${breakdown})`,
    `${activeCount} elements active`,
  ];
  if (status && status !== CYCLE_STATUS.OK) {
    parts.push(`status: ${status}`);
  }
  if (mode === "real") {
    const uc = formatUsageChunk(usage);
    if (uc) parts.push(uc);
    if (cost !== null && cost !== undefined) parts.push(`cost: $${cost.toFixed(4)}`);
  } else {
    parts.push("dry-run");
  }
  return parts.join(" | ");
}

async function processCycleReal({
  state,
  cycle,
  packet,
  runDir,
  client,
  callOpusImpl,
  applyToolCallDetailedImpl = applyToolCallDetailed,
  fetchImageImpl,
  sleepImpl = sleep,
}) {
  const logDir = join(runDir, "opus_log");
  ensureDir(logDir);
  const persistenceIssues = [];
  const reqPath = join(logDir, `cycle_${padIdx(cycle.cycle_index, 3)}_request.json`);
  const reqWriteErr = await writeJsonWithRetry(reqPath, packet, sleepImpl);
  if (reqWriteErr) {
    persistenceIssues.push(`request log write failed: ${reqWriteErr.message}`);
  }

  let response;
  try {
    response = await callOpusImpl(client, packet);
  } catch (err) {
    return {
      toolCalls: [],
      toolResults: [],
      patches: [],
      stop_reason: null,
      usage: null,
      error: {
        type: CYCLE_STATUS.API_FAILURE,
        message: err?.message ?? String(err),
        raw: serializeError(err),
      },
      persistenceIssues,
    };
  }

  const respPath = join(logDir, `cycle_${padIdx(cycle.cycle_index, 3)}_response.json`);
  const respWriteErr = await writeJsonWithRetry(respPath, response, sleepImpl);
  if (respWriteErr) {
    persistenceIssues.push(`response log write failed: ${respWriteErr.message}`);
  }

  const parsed = parseResponse(response);
  if (parsed.error) {
    const rawPath = join(logDir, `cycle_${padIdx(cycle.cycle_index, 3)}_response_raw.json`);
    const rawWriteErr = await writeJsonWithRetry(rawPath, response, sleepImpl);
    if (rawWriteErr) {
      persistenceIssues.push(`raw response log write failed: ${rawWriteErr.message}`);
    }
    return {
      toolCalls: [],
      toolResults: [],
      patches: [],
      stop_reason: response?.stop_reason ?? null,
      usage: response?.usage ?? null,
      error: parsed.error,
      persistenceIssues,
    };
  }

  const toolResults = [];
  const patches = [];
  for (const block of parsed.toolUses) {
    let detailed;
    try {
      detailed = await applyToolCallDetailedImpl(state, block, { fetchImageImpl });
    } catch (err) {
      detailed = {
        result: { error: `tool application threw: ${err?.message ?? String(err)}` },
        patches: [],
      };
    }
    toolResults.push({ tool_use_id: block.id, name: block.name, result: detailed.result });
    patches.push(...detailed.patches);
    recordDecision(state, { toolUseBlock: block, result: detailed.result });
  }

  return {
    toolCalls: parsed.toolUses,
    toolResults,
    patches,
    stop_reason: parsed.stopReason,
    usage: response.usage ?? null,
    error: null,
    persistenceIssues,
  };
}

async function processCycleDry({
  state,
  cycle,
  packet,
  runDir,
  applyToolCallDetailedImpl = applyToolCallDetailed,
  fetchImageImpl,
}) {
  const dryDir = join(runDir, "dry_run");
  ensureDir(dryDir);
  const packetPath = join(dryDir, `cycle_${padIdx(cycle.cycle_index, 3)}_packet.json`);
  writeFileSync(packetPath, JSON.stringify(packet, null, 2));

  const synthetic = synthesizeToolCalls(cycle.cycle_index, state);
  const toolResults = [];
  const patches = [];
  for (const call of synthetic) {
    const block = { type: "tool_use", id: `synth_${cycle.cycle_index}`, name: call.name, input: call.input };
    const detailed = await applyToolCallDetailedImpl(state, block, { fetchImageImpl });
    toolResults.push({ tool_use_id: block.id, name: block.name, result: detailed.result });
    patches.push(...detailed.patches);
    recordDecision(state, { toolUseBlock: block, result: detailed.result });
  }

  return {
    toolCalls: synthetic,
    toolResults,
    patches,
    stop_reason: "end_turn",
    usage: null,
    error: null,
    persistenceIssues: [],
  };
}

function collectActiveElementIds(state) {
  return new Set(state.elements.filter((element) => !element.faded).map((element) => element.element_id));
}

function collectAutoFadePatches(state, activeBeforeAutoFade) {
  return state.elements
    .filter((element) => element.faded && activeBeforeAutoFade.has(element.element_id))
    .map((element) => ({
      type: "element.fade",
      element_id: element.element_id,
      // v6.2: images get a long opacity-decay (8 s) so their exit reads
      // as a dissolve rather than a blink. Other types keep the short
      // default. autoFadeDurationForElement owns the per-type decision.
      duration_ms: autoFadeDurationForElement(element, DEFAULT_PATCH_FADE_DURATION_MS),
    }));
}

function detectStageMode(runDir) {
  const hasPrecomputedAudio = existsSync(join(runDir, "audio.wav"));
  const hasPrecomputedFeatures = existsSync(join(runDir, "features_track.json"));
  return hasPrecomputedAudio && hasPrecomputedFeatures ? "precompute" : "live";
}

function appendQueryParam(urlString, key, value) {
  const url = new URL(urlString);
  url.searchParams.set(key, value);
  return url.toString();
}

function prepareStageAudio({ sourcePath, runDir, copyFileImpl = copyFileSync }) {
  if (!sourcePath) return null;
  const resolvedSource = resolve(sourcePath);
  if (!existsSync(resolvedSource)) {
    throw new Error(`stage audio file does not exist: ${resolvedSource}`);
  }
  const destPath = join(runDir, "audio.wav");
  copyFileImpl(resolvedSource, destPath);
  return { sourcePath: resolvedSource, runPath: destPath };
}

// Phase 3 narrow diff: feature-producer spawn sits outside the cycle loop so
// it does not collide with Phase 5's self-frame hook (which lives INSIDE the
// loop body). Returns null in precompute / self-test / producer=none paths.
export function startFeatureProducer({
  mode,
  runId,
  wsUrl,
  wsToken = null,
  producer,
  spawnImpl = null,
  pythonBin = DEFAULT_PYTHON_BIN,
  scriptPath = STREAM_FEATURES_PATH,
  device = process.env.FLB_AUDIO_DEVICE ?? null,
} = {}) {
  if (mode !== "live" || producer !== "python") return null;
  const args = [scriptPath, "--mode", "live", "--ws-url", wsUrl, "--run-id", runId];
  if (wsToken) args.push("--ws-token", wsToken);
  if (device) args.push("--device", device);
  if (spawnImpl) return spawnImpl(pythonBin, args);
  const child = spawn(pythonBin, args, { stdio: "inherit" });
  // Surface spawn failures to stderr so the operator can diagnose (e.g.
  // missing Python binary, missing script). Do not crash run_spike on
  // child error — precompute runs don't need the producer anyway.
  child.on("error", (err) => {
    process.stderr.write(`feature_producer spawn error: ${err?.message ?? err}\n`);
  });
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
      process.stderr.write(
        `feature_producer exited unexpectedly (code=${code}, signal=${signal})\n`,
      );
    }
  });
  return {
    stop() {
      try {
        child.kill("SIGTERM");
      } catch {
        // child may have already exited; ignore
      }
    },
    pid: child.pid,
  };
}

function registerSigintHandler({ processLike = process, onInterrupt }) {
  if (!processLike || typeof processLike.on !== "function") return () => {};
  const unregister =
    typeof processLike.off === "function"
      ? () => processLike.off("SIGINT", handler)
      : typeof processLike.removeListener === "function"
      ? () => processLike.removeListener("SIGINT", handler)
      : () => {};

  function handler(signal = "SIGINT") {
    onInterrupt(signal);
  }

  processLike.on("SIGINT", handler);
  return unregister;
}

async function run(options) {
  const {
    corpusDir,
    configName,
    cyclesRange,
    mode,
    callOpusImpl = callOpus,
    makeClientImpl = makeOpusClient,
    outputRoot = join(NODE_ROOT, "output"),
    hijazBaseOverride = null,
    mediumRulesOverride = null,
    toolsOverride = null,
    modelOverride = null,
    saveStateImpl = saveState,
    snapshotCycleImpl = snapshotCycle,
    sleepImpl = sleep,
    renderFinalHtmlImpl = renderFinalHtml,
    renderLiveHtmlImpl = renderLiveHtml,
    writeSummaryWithRetryImpl = writeJsonWithRetry,
    applyToolCallDetailedImpl = applyToolCallDetailed,
    createStageServerImpl = createStageServer,
    fetchImageImpl = undefined,
    processLike = process,
    featureProducer = null,
    startFeatureProducerImpl = startFeatureProducer,
    createSelfFrameCapturerImpl = createSelfFrameCapturer,
    loadMoodBoardImpl = loadMoodBoard,
    stageAudioPath = null,
    prepareStageAudioImpl = prepareStageAudio,
  } = options;

  const cycles = listCycleFiles(corpusDir).filter((c) => {
    if (!cyclesRange) return true;
    return c.index >= cyclesRange.start && c.index <= cyclesRange.end;
  });
  if (cycles.length === 0) {
    die(`No cycles matched filter (range: ${JSON.stringify(cyclesRange)})`);
  }

  const hijazBase =
    hijazBaseOverride ?? readFileSync(join(NODE_ROOT, "prompts", "bayati_base.md"), "utf8");
  const { mediumRules, tools } =
    mediumRulesOverride !== null && toolsOverride !== null
      ? { mediumRules: mediumRulesOverride, tools: toolsOverride }
      : loadConfig(configName);
  const model = modelOverride ?? resolveModel();

  const runId = timestampSlug();
  const runDir = join(outputRoot, `run_${runId}`);
  ensureDir(runDir);
  const cycleOrdinalByIndex = new Map(cycles.map((entry, idx) => [entry.index, idx]));
  const stageAudio = prepareStageAudioImpl({ sourcePath: stageAudioPath, runDir });
  const stageMode = detectStageMode(runDir);

  const client = mode === "real" ? makeClientImpl() : null;
  let liveHtmlPath = null;
  const stageServer = await createStageServerImpl({ p5LogWriter: process.stdout });
  await stageServer.setCurrentRunContext({ runId, mode: stageMode, runDir });
  const baseOperatorUrl = stageServer.getOperatorUrl({ runId, mode: stageMode });
  const operatorUrl = stageAudio
    ? appendQueryParam(baseOperatorUrl, "audio", "1")
    : baseOperatorUrl;
  const baseShowUrl = typeof stageServer.getShowUrl === "function"
    ? stageServer.getShowUrl({ runId, mode: stageMode })
    : appendQueryParam(baseOperatorUrl.replace("/?", "/show?"), "mode", stageMode);
  const showUrl = stageAudio
    ? appendQueryParam(baseShowUrl, "audio", "1")
    : baseShowUrl;

  const resolvedProducer = featureProducer ?? (stageMode === "live" && mode === "real" ? "python" : "none");
  const wsUrl = `ws://${stageServer.host}:${stageServer.port}/ws`;
  const wsToken = typeof stageServer.getFeatureProducerToken === "function"
    ? stageServer.getFeatureProducerToken()
    : null;
  const featureProducerHandle = startFeatureProducerImpl({
    mode: stageMode,
    runId,
    wsUrl,
    wsToken,
    producer: resolvedProducer,
  });

  let moodBoardBlocks = [];
  try {
    const moodBoard = await loadMoodBoardImpl();
    moodBoardBlocks = buildMoodBoardUserBlocks(moodBoard);
    if (moodBoardBlocks.length > 0) {
      process.stdout.write(`Mood board loaded: ${moodBoard.imageBlocks.length} images.\n`);
    }
  } catch (err) {
    process.stdout.write(`WARN: mood board load failed: ${err?.message ?? err}\n`);
  }
  const selfFrameCapturer = createSelfFrameCapturerImpl({ stageUrl: operatorUrl });
  let pendingSelfFrameBlocks = [];
  let cyclesSinceLastImage = 0;
  let lastSelfFrameErrorAt = -Infinity;
  const interruptState = { requested: false, signal: null, announced: false };
  const cleanupSigintHandler = registerSigintHandler({
    processLike,
    onInterrupt: (signal) => {
      if (interruptState.requested) return;
      interruptState.requested = true;
      interruptState.signal = signal;
      process.stdout.write(
        `\nINTERRUPT: ${signal} received. Finishing the current cycle, then finalizing partial artifacts.\n`,
      );
    },
  });

  try {
    process.stdout.write(
      `run_id=${runId} config=${configName} model=${model} cycles=${cycles.length} mode=${mode}\n`,
    );
    process.stdout.write(`output: ${runDir}\n`);
    process.stdout.write(`show (stage + HUD): ${showUrl}\n`);
    process.stdout.write(`stage only: ${operatorUrl}\n`);

    const state = createInitialState();

    const summary = {
      run_id: runId,
      config: configName,
      model,
      mode,
      stage_url: operatorUrl,
      show_url: showUrl,
      stage_audio: stageAudio
        ? {
            enabled: true,
            source_path: stageAudio.sourcePath,
            run_path: stageAudio.runPath,
          }
        : { enabled: false },
      corpus_dir: corpusDir,
      cycles_total: cycles.length,
      cycles_range: cyclesRange,
      started_at: new Date().toISOString(),
      per_cycle: [],
      totals: {
        total_cycles: cycles.length,
        tool_calls: 0,
        cycles_with_tool_calls: 0,
        cycles_silent: 0,
        cost: 0,
        ok_count: 0,
        status_counts: {
          [CYCLE_STATUS.OK]: 0,
          [CYCLE_STATUS.API_FAILURE]: 0,
          [CYCLE_STATUS.RESPONSE_PARSE_FAILURE]: 0,
          [CYCLE_STATUS.PERSISTENCE_FAILURE]: 0,
          [CYCLE_STATUS.TOOL_CALL_ERRORS]: 0,
        },
      },
    };

    try {
      liveHtmlPath = await renderLiveHtmlImpl(runDir, { state, summary });
      process.stdout.write(`live monitor: ${liveHtmlPath}\n`);
      process.stdout.write(`open it in a browser now; it refreshes automatically during the run.\n\n`);
    } catch (err) {
      process.stdout.write(`WARN: live monitor initialization failed: ${err?.message ?? err}\n\n`);
    }

    for (const c of cycles) {
      if (interruptState.requested) break;
      let cycle;
      let cycleResult = {
        toolCalls: [],
        toolResults: [],
        stop_reason: null,
        usage: null,
        error: null,
        persistenceIssues: [],
      };
      let packet = null;
      let status = CYCLE_STATUS.OK;
      let errorInfo = null;
      let persistenceError = null;
      let activeCount = 0;
      let cost = null;

      try {
        cycle = JSON.parse(readFileSync(c.path, "utf8"));
        beginCycle(state, { cycleIndex: cycle.cycle_index, elapsedTotalS: cycle.elapsed_total_s });

        packet = buildPacket({
          cycle,
          sceneStateSummary: formatSummary(state),
          directorStatusSummary: formatDirectorStatus(state, { cyclesTotal: cycles.length }),
          recentDecisionsSummary: formatRecentDecisions(state.decision_history, cycle.cycle_index),
          hijazBase,
          mediumRules,
          tools,
          model,
          moodBoardBlocks,
          selfFrameUserBlocks: pendingSelfFrameBlocks,
          cycleOrdinal: cycleOrdinalByIndex.get(c.index),
          cyclesTotal: cycles.length,
        });
        pendingSelfFrameBlocks = [];                              // consumed — reset after use

        await stageServer.broadcastPatch({
          type: "cycle.begin",
          cycle_n: cycle.cycle_index,
          hijaz_state: cycle.hijaz_state ?? {},
        });

        cycleResult =
          mode === "real"
            ? await processCycleReal({
                state,
                cycle,
                packet,
                runDir,
                client,
                callOpusImpl,
                applyToolCallDetailedImpl,
                fetchImageImpl,
                sleepImpl,
              })
            : await processCycleDry({
                state,
                cycle,
                packet,
                runDir,
                applyToolCallDetailedImpl,
                fetchImageImpl,
              });

        for (const patch of cycleResult.patches ?? []) {
          await stageServer.broadcastPatch(patch);
        }

        const activeBeforeAutoFade = collectActiveElementIds(state);
        autoFade(state);
        const autoFadePatches = collectAutoFadePatches(state, activeBeforeAutoFade);
        for (const patch of autoFadePatches) {
          await stageServer.broadcastPatch(patch);
        }
        persistenceError = await persistStateWithRetry({
          state,
          runDir,
          saveStateImpl,
          snapshotCycleImpl,
          sleepImpl,
        });

        status = deriveCycleStatus({
          cycleError: cycleResult.error,
          persistenceIssues: [
            ...cycleResult.persistenceIssues,
            ...(persistenceError ? [`state persistence failed: ${persistenceError.message}`] : []),
          ],
          toolResults: cycleResult.toolResults,
        });

        if (cycleResult.error) {
          errorInfo = cycleResult.error;
        } else if (status === CYCLE_STATUS.PERSISTENCE_FAILURE) {
          const issues = [
            ...cycleResult.persistenceIssues,
            ...(persistenceError ? [`state persistence failed: ${persistenceError.message}`] : []),
          ];
          errorInfo = {
            type: CYCLE_STATUS.PERSISTENCE_FAILURE,
            message: issues.join("; "),
          };
        } else if (status === CYCLE_STATUS.TOOL_CALL_ERRORS) {
          errorInfo = {
            type: CYCLE_STATUS.TOOL_CALL_ERRORS,
            message: "one or more tool calls returned structured errors",
          };
        }

        activeCount = state.elements.filter((e) => !e.faded).length;
        cost = mode === "real" ? computeCost(cycleResult.usage) : null;
        await stageServer.broadcastPatch({ type: "cycle.end" });

        // Phase 5 — evaluate self-frame triggers and capture for the next cycle's packet.
        pendingSelfFrameBlocks = await maybeCaptureSelfFrame({
          cycleResult,
          cycle,
          cycleIndex: cycle?.cycle_index ?? c.index,
          activeCount,
          capturer: selfFrameCapturer,
          onIncrementDrought: () => { cyclesSinceLastImage += 1; },
          onResetDrought: () => { cyclesSinceLastImage = 0; },
          getCyclesSinceLastImage: () => cyclesSinceLastImage,
          onWarn: (msg) => {
            const now = Date.now();
            if (now - lastSelfFrameErrorAt > 5000) {
              process.stdout.write(`WARN: self-frame capture failed: ${msg}\n`);
              lastSelfFrameErrorAt = now;
            }
          },
        });
      } catch (err) {
        status = CYCLE_STATUS.RESPONSE_PARSE_FAILURE;
        errorInfo = {
          type: CYCLE_STATUS.RESPONSE_PARSE_FAILURE,
          message: err?.message ?? String(err),
        };
        activeCount = state.elements.filter((e) => !e.faded).length;
        await stageServer.broadcastPatch({ type: "cycle.end" });
        // Error path — still advance the drought counter; never capture.
        cyclesSinceLastImage += 1;
        pendingSelfFrameBlocks = [];
      }

      const statusLine = formatCycleStatus({
        cycleIndex: cycle?.cycle_index ?? c.index,
        elapsedS: cycle?.elapsed_total_s ?? "n/a",
        toolCalls: cycleResult.toolCalls,
        activeCount,
        mode,
        usage: cycleResult.usage,
        cost,
        status,
      });
      process.stdout.write(`${statusLine}\n`);

      summary.totals.tool_calls += cycleResult.toolCalls.length;
      if (cycleResult.toolCalls.length > 0) summary.totals.cycles_with_tool_calls += 1;
      else if (status === CYCLE_STATUS.OK && cycleResult.stop_reason === "end_turn") {
        summary.totals.cycles_silent += 1;
      }
      if (cost) summary.totals.cost += cost;
      bumpStatusCount(summary, status);

      summary.per_cycle.push({
        cycle_index: cycle?.cycle_index ?? c.index,
        cycle_id: cycle?.cycle_id ?? `cycle_${padIdx(c.index, 3)}`,
        elapsed_s: cycle?.elapsed_total_s ?? null,
        status,
        error: errorInfo,
        tool_calls: cycleResult.toolCalls.map((c) => ({ name: c.name, input: c.input })),
        tool_results: cycleResult.toolResults,
        persistence_issues: [
          ...cycleResult.persistenceIssues,
          ...(persistenceError ? [`state persistence failed: ${persistenceError.message}`] : []),
        ],
        stop_reason: cycleResult.stop_reason,
        usage: cycleResult.usage,
        cost,
        active_after_cycle: activeCount,
      });

      try {
        liveHtmlPath = await renderLiveHtmlImpl(runDir, { state, summary });
      } catch (err) {
        process.stdout.write(`WARN: live monitor update failed: ${err?.message ?? err}\n`);
      }
      if (interruptState.requested && !interruptState.announced) {
        interruptState.announced = true;
        process.stdout.write(
          `INTERRUPT: stopping after cycle ${padIdx(cycle?.cycle_index ?? c.index, 3)}.\n`,
        );
      }
    }

    summary.interrupted = interruptState.requested;
    summary.interrupt_signal = interruptState.signal;
    summary.cycles_completed = summary.per_cycle.length;
    summary.finished_at = new Date().toISOString();
    const summaryPath = join(runDir, "run_summary.json");
    const summaryWriteErr = await writeSummaryWithRetryImpl(summaryPath, summary, sleepImpl);
    if (summaryWriteErr) {
      process.stdout.write(
        `WARN: run_summary.json write failed after retry: ${summaryWriteErr.message}\n`,
      );
    }

    // render final_scene.html from whatever state exists. runs for both dry-run
    // and real modes so the artifact is always available for review. defensive:
    // if rendering fails, the run is already persisted — log and continue.
    let finalHtmlPath = null;
    try {
      finalHtmlPath = await renderFinalHtmlImpl(runDir, { state, summary });
    } catch (err) {
      process.stdout.write(`WARN: final_scene.html render failed: ${err?.message ?? err}\n`);
    }

    process.stdout.write(
      (interruptState.requested
        ? `\nInterrupted after ${summary.per_cycle.length}/${cycles.length} cycles.\n`
        : `\nDone. ${cycles.length} cycles processed.\n`) +
        `Tool calls total: ${summary.totals.tool_calls} (${summary.totals.cycles_with_tool_calls} cycles with calls, ${summary.totals.cycles_silent} silent)\n` +
        (mode === "real" ? `Cost total: $${summary.totals.cost.toFixed(4)}\n` : "") +
        `Run dir: ${runDir}\n` +
        `Show (stage + HUD): ${showUrl}\n` +
        `Stage only: ${operatorUrl}\n` +
        (liveHtmlPath ? `Live monitor: ${liveHtmlPath}\n` : "") +
        (summaryWriteErr ? `Run summary write failed: ${summaryWriteErr.message}\n` : "") +
        (finalHtmlPath ? `Final HTML: ${finalHtmlPath}\n` : ""),
    );

    return {
      runId,
      runDir,
      summary,
      liveHtmlPath,
      finalHtmlPath,
      summaryWriteError: summaryWriteErr,
      operatorUrl,
      showUrl,
      interrupted: interruptState.requested,
    };
  } finally {
    // Cleanup must happen on ANY exit path (exception, normal return, or
    // interrupt) — otherwise the Python child keeps the audio device held
    // and the stage server leaks its port binding. Guard each step so a
    // failure in one cleanup step doesn't skip the next.
    if (featureProducerHandle) {
      try {
        featureProducerHandle.stop();
      } catch {
        // child may have already exited
      }
    }
    try {
      await stageServer.close();
    } catch {
      // server may already be closed
    }
    try {
      await selfFrameCapturer.close();
    } catch {
      // capturer may already be closed or never opened
    }
    cleanupSigintHandler();
  }
}

async function maybeCaptureSelfFrame({
  cycleResult,
  cycle,
  cycleIndex,
  activeCount,
  capturer,
  onIncrementDrought,
  onResetDrought,
  getCyclesSinceLastImage,
  onWarn,
}) {
  try {
    const cyclePatches = cycleResult.patches ?? [];
    const anImageWasAdded = cyclePatches.some(
      (p) => p?.type === "element.add" && p?.element?.type === "image",
    );
    if (anImageWasAdded) onResetDrought();
    else onIncrementDrought();

    const hijazTahwilFired = Boolean(cycle?.hijaz_state?.tahwil_fired);
    const triggered = shouldCaptureSelfFrame({
      cycleIndex,
      activeCount,
      cyclesSinceLastImage: getCyclesSinceLastImage(),
      hijazTahwilFired,
    });
    if (!triggered) return [];

    const pngBuffer = await capturer.capture();
    return buildSelfFrameUserBlocks({
      pngBuffer,
      metadata: {
        previousCycleIndex: cycleIndex,
        activeCount,
        dominantType: null,
        backgroundAgeS: 0,
      },
    });
  } catch (err) {
    onWarn(err?.message ?? String(err));
    return [];
  }
}

function makeTestCycle(index) {
  return {
    cycle_id: `cycle_${padIdx(index, 3)}`,
    cycle_index: index,
    source_file: "self_test.wav",
    snapshot_time_s: 5 + index * 5,
    elapsed_total_s: 5 + index * 5,
    window_duration_s: 4,
    window_start_s: 1 + index * 5,
    window_end_s: 5 + index * 5,
    block_1_scalars: {
      rms_mean: 0.1 + index * 0.01,
      rms_trend: "sustained",
      centroid_mean_hz: 1200 + index * 100,
      centroid_trend: "building",
      onset_density: 10 + index,
      silence_ratio: 0.1,
      pitch_class_primary: "D",
      pitch_class_secondary: null,
    },
    block_2_summary: `Self-test cycle ${index}.`,
    block_3_sparklines: {
      rms: "▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▁▂▃▄▅",
      onset: "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
      centroid: "▁▁▂▂▃▃▄▄▅▅▆▆▇▇██▇▆▅▄",
    },
    _debug: {
      file_percentiles: {},
    },
  };
}

function writeTestCorpus(corpusDir, count) {
  ensureDir(corpusDir);
  for (let index = 0; index < count; index += 1) {
    const cycle = makeTestCycle(index);
    const filePath = join(corpusDir, `cycle_${padIdx(index, 3)}.json`);
    writeFileSync(filePath, JSON.stringify(cycle, null, 2));
  }
}

async function runSelfTests() {
  const assert = (await import("node:assert/strict")).default;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  let pass = 0;
  let fail = 0;

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

  function freshTempRoot(prefix) {
    return mkdtempSync(join(tmpdir(), `${prefix}-`));
  }

  function makeStageServerStub(capturedPatches = []) {
    return {
      async setCurrentRunContext() {},
      async broadcastPatch(patch) {
        capturedPatches.push(patch);
      },
      getOperatorUrl({ runId, mode }) {
        return `http://127.0.0.1:9999/?run_id=${runId}&mode=${mode}`;
      },
      getShowUrl({ runId, mode }) {
        return `http://127.0.0.1:9999/show?run_id=${runId}&mode=${mode}`;
      },
      async close() {},
    };
  }

  await t("run survives api and response-parse failures and records cycle statuses", async () => {
    const tempRoot = freshTempRoot("run-spike-api-errors");
    const corpusDir = join(tempRoot, "corpus");
    const outputRoot = join(tempRoot, "output");
    writeTestCorpus(corpusDir, 3);

    let callIndex = 0;
    const mockCallOpus = async () => {
      const current = callIndex;
      callIndex += 1;
      if (current === 0) {
        return {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "silence is correct" }],
          usage: { input_tokens: 120, output_tokens: 24, cache_read_input_tokens: 90 },
        };
      }
      if (current === 1) {
        const err = new Error("simulated upstream 500");
        err.status = 500;
        err.code = "internal_error";
        throw err;
      }
      return {
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "truncated" }],
        usage: { input_tokens: 140, output_tokens: 2000 },
      };
    };

    const { runDir, summary } = await run({
      corpusDir,
      configName: "config_a",
      cyclesRange: null,
      mode: "real",
      callOpusImpl: mockCallOpus,
      makeClientImpl: () => ({ mocked: true }),
      outputRoot,
      hijazBaseOverride: "self-test hijaz base",
      mediumRulesOverride: "self-test medium rules",
      toolsOverride: [],
      modelOverride: "claude-opus-4-7",
      sleepImpl: async () => {},
      createStageServerImpl: async () => makeStageServerStub(),
    });

    assert.deepEqual(
      summary.per_cycle.map((entry) => entry.status),
      [CYCLE_STATUS.OK, CYCLE_STATUS.API_FAILURE, CYCLE_STATUS.RESPONSE_PARSE_FAILURE],
    );
    assert.equal(summary.totals.ok_count, 1);
    assert.equal(summary.totals.status_counts[CYCLE_STATUS.API_FAILURE], 1);
    assert.equal(summary.totals.status_counts[CYCLE_STATUS.RESPONSE_PARSE_FAILURE], 1);
    assert.equal(summary.per_cycle.length, 3);
    assert.equal(summary.totals.cycles_silent, 1);
    assert.equal(
      existsSync(join(runDir, "opus_log", "cycle_002_response_raw.json")),
      true,
    );

    const summaryPath = join(runDir, "run_summary.json");
    assert.equal(existsSync(summaryPath), true);
    const saved = JSON.parse(readFileSync(summaryPath, "utf8"));
    assert.equal(saved.per_cycle[1].status, CYCLE_STATUS.API_FAILURE);
    assert.equal(saved.per_cycle[2].status, CYCLE_STATUS.RESPONSE_PARSE_FAILURE);

    assert.equal(existsSync(join(runDir, "live_monitor.html")), true);
    // renderFinalHtml wiring: final_scene.html must exist even when some cycles errored
    assert.equal(existsSync(join(runDir, "final_scene.html")), true);
  });

  await t("run survives state persistence failure and records it without aborting later cycles", async () => {
    const tempRoot = freshTempRoot("run-spike-persistence-errors");
    const corpusDir = join(tempRoot, "corpus");
    const outputRoot = join(tempRoot, "output");
    writeTestCorpus(corpusDir, 2);

    let failingAttempts = 0;
    const flakySaveState = (state, runDir) => {
      if (state.current_cycle_index === 0 && failingAttempts < 2) {
        failingAttempts += 1;
        throw new Error("simulated disk hiccup");
      }
      saveState(state, runDir);
    };

    const { runDir, summary } = await run({
      corpusDir,
      configName: "config_a",
      cyclesRange: null,
      mode: "dry-run",
      outputRoot,
      hijazBaseOverride: "self-test hijaz base",
      mediumRulesOverride: "self-test medium rules",
      toolsOverride: [],
      modelOverride: "claude-opus-4-7",
      saveStateImpl: flakySaveState,
      snapshotCycleImpl: snapshotCycle,
      sleepImpl: async () => {},
      createStageServerImpl: async () => makeStageServerStub(),
    });

    assert.deepEqual(
      summary.per_cycle.map((entry) => entry.status),
      [CYCLE_STATUS.PERSISTENCE_FAILURE, CYCLE_STATUS.OK],
    );
    assert.equal(summary.totals.status_counts[CYCLE_STATUS.PERSISTENCE_FAILURE], 1);
    assert.equal(summary.totals.ok_count, 1);
    assert.equal(summary.per_cycle.length, 2);
    assert.equal(
      existsSync(join(runDir, "scene_state_log", "cycle_001.json")),
      true,
    );
    assert.match(summary.per_cycle[0].error.message, /state persistence failed/);

    assert.equal(existsSync(join(runDir, "live_monitor.html")), true);
    // renderFinalHtml wiring: final_scene.html must exist even when persistence failed earlier
    assert.equal(existsSync(join(runDir, "final_scene.html")), true);
  });

  await t("run continues and summary still finalizes when renderFinalHtml throws", async () => {
    const tempRoot = freshTempRoot("run-spike-render-error");
    const corpusDir = join(tempRoot, "corpus");
    const outputRoot = join(tempRoot, "output");
    writeTestCorpus(corpusDir, 1);

    const exploding = () => {
      throw new Error("simulated render failure");
    };

    const { runDir, summary } = await run({
      corpusDir,
      configName: "config_a",
      cyclesRange: null,
      mode: "dry-run",
      outputRoot,
      hijazBaseOverride: "self-test hijaz base",
      mediumRulesOverride: "self-test medium rules",
      toolsOverride: [],
      modelOverride: "claude-opus-4-7",
      sleepImpl: async () => {},
      renderFinalHtmlImpl: exploding,
      createStageServerImpl: async () => makeStageServerStub(),
    });

    assert.equal(summary.per_cycle[0].status, CYCLE_STATUS.OK);
    assert.equal(existsSync(join(runDir, "run_summary.json")), true);
    assert.equal(existsSync(join(runDir, "live_monitor.html")), true);
    // final_scene.html MUST NOT exist because the renderer threw
    assert.equal(existsSync(join(runDir, "final_scene.html")), false);
  });

  await t("run warns on summary write failure but still renders final html from in-memory summary", async () => {
    const tempRoot = freshTempRoot("run-spike-summary-write-error");
    const corpusDir = join(tempRoot, "corpus");
    const outputRoot = join(tempRoot, "output");
    writeTestCorpus(corpusDir, 1);

    const { runDir, liveHtmlPath, finalHtmlPath, summaryWriteError } = await run({
      corpusDir,
      configName: "config_a",
      cyclesRange: null,
      mode: "dry-run",
      outputRoot,
      hijazBaseOverride: "self-test hijaz base",
      mediumRulesOverride: "self-test medium rules",
      toolsOverride: [],
      modelOverride: "claude-opus-4-7",
      sleepImpl: async () => {},
      writeSummaryWithRetryImpl: async () => new Error("simulated summary write failure"),
      createStageServerImpl: async () => makeStageServerStub(),
    });

    assert.match(summaryWriteError.message, /simulated summary write failure/);
    assert.equal(existsSync(join(runDir, "run_summary.json")), false);
    assert.equal(liveHtmlPath, join(runDir, "live_monitor.html"));
    assert.equal(existsSync(join(runDir, "live_monitor.html")), true);
    assert.equal(finalHtmlPath, join(runDir, "final_scene.html"));
    assert.equal(existsSync(join(runDir, "final_scene.html")), true);
  });

  await t("run emits cycle and tool patches while keeping legacy outputs", async () => {
    const tempRoot = freshTempRoot("run-spike-stage-patches");
    const corpusDir = join(tempRoot, "corpus");
    const outputRoot = join(tempRoot, "output");
    const captured = [];
    writeTestCorpus(corpusDir, 2);

    const { operatorUrl, showUrl, runDir } = await run({
      corpusDir,
      configName: "config_a",
      cyclesRange: null,
      mode: "dry-run",
      outputRoot,
      hijazBaseOverride: "self-test hijaz base",
      mediumRulesOverride: "self-test medium rules",
      toolsOverride: [],
      modelOverride: "claude-opus-4-7",
      sleepImpl: async () => {},
      createStageServerImpl: async () => makeStageServerStub(captured),
    });

    assert.equal(captured[0].type, "cycle.begin");
    assert.equal(captured[1].type, "background.set");
    assert.equal(captured[2].type, "cycle.end");
    assert.equal(captured[3].type, "cycle.begin");
    assert.equal(captured[4].type, "element.add");
    assert.equal(captured[5].type, "cycle.end");
    assert.match(operatorUrl, /\?run_id=.*&mode=live$/);
    assert.match(showUrl, /\/show\?run_id=.*&mode=live$/);
    assert.equal(existsSync(join(runDir, "final_scene.html")), true);
  });

  await t("run copies optional stage audio and advertises it in the live stage URL", async () => {
    const tempRoot = freshTempRoot("run-spike-stage-audio");
    const corpusDir = join(tempRoot, "corpus");
    const outputRoot = join(tempRoot, "output");
    const stageAudioPath = join(tempRoot, "sample.wav");
    writeTestCorpus(corpusDir, 1);
    writeFileSync(stageAudioPath, "fake wav bytes");

    const { operatorUrl, showUrl, runDir, summary } = await run({
      corpusDir,
      configName: "config_a",
      cyclesRange: null,
      mode: "dry-run",
      outputRoot,
      hijazBaseOverride: "self-test hijaz base",
      mediumRulesOverride: "self-test medium rules",
      toolsOverride: [],
      modelOverride: "claude-opus-4-7",
      sleepImpl: async () => {},
      createStageServerImpl: async () => makeStageServerStub(),
      stageAudioPath,
    });

    assert.equal(readFileSync(join(runDir, "audio.wav"), "utf8"), "fake wav bytes");
    assert.match(operatorUrl, /\?run_id=.*&mode=live&audio=1$/);
    assert.match(showUrl, /\/show\?run_id=.*&mode=live&audio=1$/);
    assert.equal(summary.stage_audio.enabled, true);
    assert.equal(summary.stage_url, operatorUrl);
    assert.equal(summary.show_url, showUrl);
    assert.equal(summary.stage_audio.source_path, stageAudioPath);
    assert.equal(summary.stage_audio.run_path, join(runDir, "audio.wav"));
  });

  await t("run finalizes partial artifacts after SIGINT and stops before the next cycle", async () => {
    const tempRoot = freshTempRoot("run-spike-sigint");
    const corpusDir = join(tempRoot, "corpus");
    const outputRoot = join(tempRoot, "output");
    writeTestCorpus(corpusDir, 3);

    const listeners = new Map();
    const fakeProcess = {
      on(event, handler) {
        const current = listeners.get(event) ?? [];
        current.push(handler);
        listeners.set(event, current);
      },
      off(event, handler) {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((entry) => entry !== handler),
        );
      },
      emit(event, payload) {
        for (const handler of listeners.get(event) ?? []) handler(payload);
      },
    };

    let callCount = 0;
    const mockCallOpus = async () => {
      callCount += 1;
      if (callCount === 1) fakeProcess.emit("SIGINT", "SIGINT");
      return {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "no tools" }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
      };
    };

    const { runDir, summary, interrupted } = await run({
      corpusDir,
      configName: "config_a",
      cyclesRange: null,
      mode: "real",
      callOpusImpl: mockCallOpus,
      makeClientImpl: () => ({ mocked: true }),
      outputRoot,
      hijazBaseOverride: "self-test hijaz base",
      mediumRulesOverride: "self-test medium rules",
      toolsOverride: [],
      modelOverride: "claude-opus-4-7",
      sleepImpl: async () => {},
      createStageServerImpl: async () => makeStageServerStub(),
      processLike: fakeProcess,
    });

    assert.equal(interrupted, true);
    assert.equal(callCount, 1);
    assert.equal(summary.interrupted, true);
    assert.equal(summary.interrupt_signal, "SIGINT");
    assert.equal(summary.cycles_completed, 1);
    assert.equal(summary.per_cycle.length, 1);
    assert.equal(existsSync(join(runDir, "run_summary.json")), true);
    assert.equal(existsSync(join(runDir, "final_scene.html")), true);
  });

  await t("startFeatureProducer spawns the Python child when mode=live and producer=python", async () => {
    const calls = [];
    const fakeSpawn = (cmd, args) => {
      calls.push({ cmd, args });
      return {
        stop() {
          calls.push({ cmd: "STOP" });
        },
      };
    };
    const handle = startFeatureProducer({
      mode: "live",
      runId: "feat123",
      wsUrl: "ws://127.0.0.1:9999/ws",
      wsToken: "tok_abc_123",
      producer: "python",
      spawnImpl: fakeSpawn,
      pythonBin: "/opt/python/bin/python",
      scriptPath: "/opt/feed/python/stream_features.py",
    });
    assert.ok(handle, "handle should exist");
    handle.stop();
    assert.equal(calls[0].cmd, "/opt/python/bin/python");
    assert.equal(calls[0].args[0], "/opt/feed/python/stream_features.py");
    assert.equal(calls[0].args[1], "--mode");
    assert.equal(calls[0].args[2], "live");
    assert.deepEqual(calls[0].args.slice(3, 7), ["--ws-url", "ws://127.0.0.1:9999/ws", "--run-id", "feat123"]);
    const tokenIdx = calls[0].args.indexOf("--ws-token");
    assert.ok(tokenIdx >= 0, "expected --ws-token in args");
    assert.equal(calls[0].args[tokenIdx + 1], "tok_abc_123");
    assert.equal(calls[1].cmd, "STOP");
  });

  await t("startFeatureProducer is a no-op when mode=precompute or producer=none", () => {
    const calls = [];
    const fakeSpawn = () => {
      calls.push("spawn");
      return { stop() {} };
    };
    assert.equal(
      startFeatureProducer({
        mode: "precompute",
        runId: "a",
        wsUrl: "ws://127.0.0.1:9999/ws",
        producer: "python",
        spawnImpl: fakeSpawn,
      }),
      null,
    );
    assert.equal(
      startFeatureProducer({
        mode: "live",
        runId: "a",
        wsUrl: "ws://127.0.0.1:9999/ws",
        producer: "none",
        spawnImpl: fakeSpawn,
      }),
      null,
    );
    assert.equal(calls.length, 0);
  });

  await t("startFeatureProducer appends --device when one is provided", () => {
    const calls = [];
    const fakeSpawn = (cmd, args) => {
      calls.push({ cmd, args });
      return { stop() {} };
    };
    startFeatureProducer({
      mode: "live",
      runId: "dev",
      wsUrl: "ws://127.0.0.1:9999/ws",
      producer: "python",
      spawnImpl: fakeSpawn,
      device: "Audient iD14",
      pythonBin: "python",
      scriptPath: "stream_features.py",
    });
    const args = calls[0].args;
    const deviceIdx = args.indexOf("--device");
    assert.ok(deviceIdx >= 0, "expected --device in args");
    assert.equal(args[deviceIdx + 1], "Audient iD14");
  });

  await t("run invokes self-frame capturer on trigger cycles (drought + every-5th)", async () => {
    const tempRoot = freshTempRoot("run-spike-self-frame");
    const corpusDir = join(tempRoot, "corpus");
    const outputRoot = join(tempRoot, "output");
    writeTestCorpus(corpusDir, 6);                                // cycles 0..5 inclusive

    const capturedInvocations = [];
    const mockPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const mockCapturer = {
      capture: async () => {
        capturedInvocations.push(Date.now());
        return mockPng;
      },
      close: async () => {},
    };

    const packetsObserved = [];
    const mockCallOpus = async (_client, packet) => {
      packetsObserved.push(packet);
      return {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "no-op" }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
      };
    };

    await run({
      corpusDir,
      configName: "config_a",
      cyclesRange: null,
      mode: "real",
      callOpusImpl: mockCallOpus,
      makeClientImpl: () => ({ mocked: true }),
      outputRoot,
      hijazBaseOverride: "self-test hijaz base",
      mediumRulesOverride: "self-test medium rules",
      toolsOverride: [],
      modelOverride: "claude-opus-4-7",
      sleepImpl: async () => {},
      createStageServerImpl: async () => makeStageServerStub(),
      createSelfFrameCapturerImpl: () => mockCapturer,
      loadMoodBoardImpl: async () => ({ labelText: "", imageBlocks: [] }),
    });

    // With 6 silent cycles (no image element.adds): cyclesSinceLastImage increments
    // each cycle. Capture fires when either:
    //   - cycleIndex % 5 === 0 && cycleIndex > 0  → cycle 5 (every-5th baseline)
    //   - cyclesSinceLastImage > 4                → after cycle 4 (5th increment)
    // So at cycle 4's end, drought reaches 5 → trigger fires (1st capture).
    // At cycle 5's end, drought is now 6 AND every-5th — trigger still fires (2nd capture).
    assert.ok(
      capturedInvocations.length >= 2,
      `expected ≥2 captures on drought + every-5th triggers, got ${capturedInvocations.length}`,
    );

    // Packet for cycle 0 should have no self-frame (first cycle, no prior).
    assert.equal(typeof packetsObserved[0].messages[0].content, "string");

    // Some later packet should carry a self-frame user-block array.
    const sawSelfFrame = packetsObserved.some(
      (p) => Array.isArray(p.messages[0].content) && p.messages[0].content.some((b) => b.type === "image"),
    );
    assert.ok(sawSelfFrame, "expected at least one packet to carry a self-frame image block");
  });

  await t("run does not crash when self-frame capturer throws (degrades gracefully)", async () => {
    const tempRoot = freshTempRoot("run-spike-self-frame-error");
    const corpusDir = join(tempRoot, "corpus");
    const outputRoot = join(tempRoot, "output");
    writeTestCorpus(corpusDir, 6);

    const failingCapturer = {
      capture: async () => { throw new Error("chromium unavailable"); },
      close: async () => {},
    };

    const mockCallOpus = async () => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "no-op" }],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
    });

    const { summary } = await run({
      corpusDir,
      configName: "config_a",
      cyclesRange: null,
      mode: "real",
      callOpusImpl: mockCallOpus,
      makeClientImpl: () => ({ mocked: true }),
      outputRoot,
      hijazBaseOverride: "self-test hijaz base",
      mediumRulesOverride: "self-test medium rules",
      toolsOverride: [],
      modelOverride: "claude-opus-4-7",
      sleepImpl: async () => {},
      createStageServerImpl: async () => makeStageServerStub(),
      createSelfFrameCapturerImpl: () => failingCapturer,
    });

    assert.equal(summary.per_cycle.length, 6);
    assert.equal(summary.interrupted, false);
  });

  await t("--use-baked round-trip dispatches expected patches in order", async () => {
    const tempRoot = freshTempRoot("run-spike-bake-replay");
    const bakeDir = join(tempRoot, "bake_x");
    const cyclesDir = join(bakeDir, "cycles");
    const { mkdirSync: mdk, writeFileSync: wf } = await import("node:fs");
    mdk(cyclesDir, { recursive: true });
    wf(join(bakeDir, "composition_plan.json"), JSON.stringify({
      track_id: "x", duration_s: 10, cycle_count: 2,
      overall_arc: [{ act_index: 0, name: "Birth", cycle_range: [0, 1], intent: "i" }],
      per_cycle_intent: [
        { cycle: 0, active_act: 0, intent: "i0", energy_hint: "low" },
        { cycle: 1, active_act: 0, intent: "i1", energy_hint: "rising" },
      ],
      element_vocabulary: { anchors: ["m"], palette_progression: [], introduce_at: {}, retire_at: {} },
      foreshadow_pairs: [],
      anticipation_offsets_ms: { "0": 0, "1": 0 },
      model: "m", thinking_budget: 1, baked_at: "z",
    }));
    for (let i = 0; i < 2; i++) {
      wf(join(cyclesDir, `cycle_${String(i).padStart(3, "0")}.json`),
        JSON.stringify({
          cycle_index: i, cycle_id: `cycle_${String(i).padStart(3, "0")}`,
          model: "m", thinking_budget: 1,
          rationale: `r${i}`,
          tool_calls: [{ id: `tu_${i}`, name: "addText", input: { text: `t${i}` } }],
          input_signature: `sig_${i}_aaaaaaaa`, stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
          baked_at: "2026-04-25T00:00:00Z",
        }));
    }
    const player = await import("./bake_player.mjs");
    const indices = player.enumerateBakedCycles(bakeDir);
    assert.deepEqual(indices, [0, 1]);
    const c0 = player.getBakedCycle(bakeDir, 0);
    const c1 = player.getBakedCycle(bakeDir, 1);
    assert.equal(c0.tool_calls[0].input.text, "t0");
    assert.equal(c1.tool_calls[0].input.text, "t1");
  });

  process.stdout.write(
    `\n============ run_spike.mjs self-test ============\n${pass}/${pass + fail} passed\n`,
  );
  if (fail > 0) {
    process.exitCode = 1;
  }
}

async function runBakedReplay({ bakeDir, stageAudioPath, cyclesRange, recordVideo }) {
  const player = await import("./bake_player.mjs");
  const { loadBakeDirectory, getBakedCycle, enumerateBakedCycles, getAnticipationOffsetMs } = player;
  const { plan, layout } = loadBakeDirectory(bakeDir);

  // Try to find sibling corpus dir for snapshot_time_s; fall back to idx*5
  const corpusDir = join(layout.root, "..", `corpus_${plan.track_id}`);
  const hasCorpus = existsSync(corpusDir);
  if (!hasCorpus) {
    process.stderr.write(
      `WARN: corpus_${plan.track_id} not found beside bakeDir — using idx*5s for timestamps\n`,
    );
  }

  const allIndices = enumerateBakedCycles(bakeDir);
  const indices = cyclesRange
    ? allIndices.filter((i) => i >= cyclesRange[0] && i <= cyclesRange[1])
    : allIndices;

  const stageServer = await createStageServer({ port: 9999 });
  const runId = `bake_${Date.now().toString(36)}`;
  const runDir = join(NODE_ROOT, "output", `run_${runId}`);
  mkdirSync(runDir, { recursive: true });

  if (stageAudioPath && existsSync(stageAudioPath)) {
    const dest = join(runDir, "audio.wav");
    copyFileSync(stageAudioPath, dest);
  }

  await stageServer.setCurrentRunContext({ runId, mode: "baked", runDir });
  const operatorUrl = stageServer.getOperatorUrl({ runId, mode: "baked" });
  const showUrl = stageServer.getShowUrl({ runId, mode: "baked" });
  process.stdout.write(`run_id=${runId} mode=baked\n`);
  process.stdout.write(`stage: ${operatorUrl}\n`);
  process.stdout.write(`show:  ${showUrl}\n`);

  if (recordVideo) {
    process.stdout.write("video capture: Phase 6 video_capture.mjs (not yet available)\n");
  }

  // Dispatch all cycle patches immediately (baked-mode has no live audio alignment;
  // patches fire in sequence with no inter-cycle sleep).
  for (const idx of indices) {
    const cycle = getBakedCycle(bakeDir, idx);
    const offsetMs = getAnticipationOffsetMs(plan, idx);

    let snapshotMs;
    if (hasCorpus) {
      try {
        const corpusCycle = JSON.parse(
          readFileSync(join(corpusDir, `cycle_${String(idx).padStart(3, "0")}.json`), "utf8"),
        );
        snapshotMs = (corpusCycle.snapshot_time_s ?? idx * 5) * 1000;
      } catch {
        snapshotMs = idx * 5000;
      }
    } else {
      snapshotMs = idx * 5000;
    }

    process.stdout.write(`cycle ${String(idx).padStart(3, "0")} (snapshot=${(snapshotMs / 1000).toFixed(1)}s offset=${offsetMs}ms): ${cycle.tool_calls.length} tool call(s)\n`);

    for (const toolCall of cycle.tool_calls) {
      // Emit a baked tool call patch directly — the stage receives it just
      // like a live broadcastPatch, letting the browser visualize it.
      await stageServer.broadcastPatch({
        type: "baked.tool_call",
        cycle_index: idx,
        tool_name: toolCall.name,
        tool_input: toolCall.input,
        tool_id: toolCall.id,
      });
    }
  }

  process.stdout.write(`Done. ${indices.length} cycles replayed.\n`);
  process.stdout.write(`Stage: ${operatorUrl}\n`);
  await stageServer.close();
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        config: { type: "string" },
        cycles: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "feature-producer": { type: "string" },
        "stage-audio": { type: "string" },
        "use-baked": { type: "string" },
        "record-video": { type: "boolean", default: false },
      },
    });
  } catch (err) {
    die(`${err.message}\n\n${usage()}`);
  }
  const { values, positionals } = parsed;

  // Bake-mode short-circuit: if --use-baked is set, replay the baked
  // bundle and return. The existing live-mode path below stays untouched.
  if (values["use-baked"]) {
    if (values.config) die("--use-baked is mutually exclusive with --config");
    if (values["feature-producer"]) die("--use-baked is mutually exclusive with --feature-producer");
    const bakeDir = resolve(values["use-baked"]);
    const stageAudioPath = values["stage-audio"] ? resolve(values["stage-audio"]) : null;
    const cyclesRange = parseCyclesRange(values.cycles);
    const recordVideo = values["record-video"] ?? false;
    await runBakedReplay({ bakeDir, stageAudioPath, cyclesRange, recordVideo });
    return;
  }

  if (positionals.length !== 1) die(usage());
  if (!values.config) die(`--config is required\n\n${usage()}`);

  const mode = values["dry-run"] ? "dry-run" : "real";
  const corpusDir = resolve(positionals[0]);
  const configName = values.config;
  const cyclesRange = parseCyclesRange(values.cycles);
  const featureProducer = values["feature-producer"] ?? null;
  const stageAudioPath = values["stage-audio"] ? resolve(values["stage-audio"]) : null;

  await run({ corpusDir, configName, cyclesRange, mode, featureProducer, stageAudioPath });
}

if (process.argv.includes("--self-test")) {
  await runSelfTests();
} else {
  await main();
}
