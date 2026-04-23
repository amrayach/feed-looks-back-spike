import "dotenv/config";
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { makeOpusClient, resolveModel, callOpus } from "./opus_client.mjs";
import { buildPacket } from "./packet_builder.mjs";
import {
  createInitialState,
  beginCycle,
  autoFade,
  formatSummary,
  saveState,
  snapshotCycle,
} from "./scene_state.mjs";
import { applyToolCallDetailed } from "./tool_handlers.mjs";
import { renderFinalHtml, renderLiveHtml } from "./render_html.mjs";
import { createStageServer } from "./stage_server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_ROOT = resolve(__dirname, "..");

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
  return `Usage: node src/run_spike.mjs <corpus_dir> --config <name> [--cycles N:M] [--dry-run]
       node src/run_spike.mjs --self-test

Arguments:
  corpus_dir      path to a directory of cycle_NNN.json files
  --config NAME   config name (only 'config_a' exists in this session)
  --cycles N:M    optional inclusive range of cycle indices (default: all)
  --dry-run       build packets and synthesize tool calls locally; do not call the API
                  (default: real API mode — spends credit)
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
              `<svg viewBox="0 0 100 100"><line x1="0" y1="${50 + (cycleIndex % 10)}" x2="100" y2="${50 - (cycleIndex % 10)}" stroke="white" stroke-width="2"/></svg>`,
            position: "horizontal band at mid-height",
            semantic_label: `angular break at cycle ${cycleIndex}`,
          },
        },
      ];
    case 3:
      return [
        {
          name: "addImage",
          input: {
            query: `threshold light at cycle ${cycleIndex}`,
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
      duration_ms: DEFAULT_PATCH_FADE_DURATION_MS,
    }));
}

function detectStageMode(runDir) {
  const hasPrecomputedAudio = existsSync(join(runDir, "audio.wav"));
  const hasPrecomputedFeatures = existsSync(join(runDir, "features_track.json"));
  return hasPrecomputedAudio && hasPrecomputedFeatures ? "precompute" : "live";
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
  } = options;

  const cycles = listCycleFiles(corpusDir).filter((c) => {
    if (!cyclesRange) return true;
    return c.index >= cyclesRange.start && c.index <= cyclesRange.end;
  });
  if (cycles.length === 0) {
    die(`No cycles matched filter (range: ${JSON.stringify(cyclesRange)})`);
  }

  const hijazBase =
    hijazBaseOverride ?? readFileSync(join(NODE_ROOT, "prompts", "hijaz_base.md"), "utf8");
  const { mediumRules, tools } =
    mediumRulesOverride !== null && toolsOverride !== null
      ? { mediumRules: mediumRulesOverride, tools: toolsOverride }
      : loadConfig(configName);
  const model = modelOverride ?? resolveModel();

  const runId = timestampSlug();
  const runDir = join(outputRoot, `run_${runId}`);
  ensureDir(runDir);
  const stageMode = detectStageMode(runDir);

  const client = mode === "real" ? makeClientImpl() : null;
  let liveHtmlPath = null;
  const stageServer = await createStageServerImpl();
  await stageServer.setCurrentRunContext({ runId, mode: stageMode, runDir });
  const operatorUrl = stageServer.getOperatorUrl({ runId, mode: stageMode });

  process.stdout.write(
    `run_id=${runId} config=${configName} model=${model} cycles=${cycles.length} mode=${mode}\n`,
  );
  process.stdout.write(`output: ${runDir}\n`);
  process.stdout.write(`stage: ${operatorUrl}\n`);

  const state = createInitialState();

  const summary = {
    run_id: runId,
    config: configName,
    model,
    mode,
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
        hijazBase,
        mediumRules,
        tools,
        model,
      });

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
    } catch (err) {
      status = CYCLE_STATUS.RESPONSE_PARSE_FAILURE;
      errorInfo = {
        type: CYCLE_STATUS.RESPONSE_PARSE_FAILURE,
        message: err?.message ?? String(err),
      };
      activeCount = state.elements.filter((e) => !e.faded).length;
      await stageServer.broadcastPatch({ type: "cycle.end" });
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
  }

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
    `\nDone. ${cycles.length} cycles processed.\n` +
      `Tool calls total: ${summary.totals.tool_calls} (${summary.totals.cycles_with_tool_calls} cycles with calls, ${summary.totals.cycles_silent} silent)\n` +
      (mode === "real" ? `Cost total: $${summary.totals.cost.toFixed(4)}\n` : "") +
      `Run dir: ${runDir}\n` +
      `Stage: ${operatorUrl}\n` +
      (liveHtmlPath ? `Live monitor: ${liveHtmlPath}\n` : "") +
      (summaryWriteErr ? `Run summary write failed: ${summaryWriteErr.message}\n` : "") +
      (finalHtmlPath ? `Final HTML: ${finalHtmlPath}\n` : ""),
  );

  await stageServer.close();

  return {
    runId,
    runDir,
    summary,
    liveHtmlPath,
    finalHtmlPath,
    summaryWriteError: summaryWriteErr,
    operatorUrl,
  };
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

    const { operatorUrl, runDir } = await run({
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
    assert.equal(existsSync(join(runDir, "final_scene.html")), true);
  });

  process.stdout.write(
    `\n============ run_spike.mjs self-test ============\n${pass}/${pass + fail} passed\n`,
  );
  if (fail > 0) {
    process.exitCode = 1;
  }
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
      },
    });
  } catch (err) {
    die(`${err.message}\n\n${usage()}`);
  }
  const { values, positionals } = parsed;

  if (positionals.length !== 1) die(usage());
  if (!values.config) die(`--config is required\n\n${usage()}`);

  const mode = values["dry-run"] ? "dry-run" : "real";
  const corpusDir = resolve(positionals[0]);
  const configName = values.config;
  const cyclesRange = parseCyclesRange(values.cycles);

  await run({ corpusDir, configName, cyclesRange, mode });
}

if (process.argv.includes("--self-test")) {
  await runSelfTests();
} else {
  await main();
}
