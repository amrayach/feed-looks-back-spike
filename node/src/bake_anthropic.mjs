// node/src/bake_anthropic.mjs
// Bake-only Anthropic SDK wrapper. Does NOT replace opus_client.mjs;
// kept separate so the live path stays byte-identical.
//
// Conventions:
// - System prefix is built from prompt files + reference photos + track-meta
//   images, with cache_control on the last block.
// - User message is plain text (sectioned).
// - Returned content drops "thinking" blocks (Codex constraint:
//   we do NOT surface hidden chain-of-thought as artifacts;
//   only model-visible "text" + "tool_use" content is persisted).
//
// COST OVERRIDE on Opus 4.7:
// The plan originally specified thinking:{type:"enabled", budget_tokens:N},
// but Opus 4.7 removed budget_tokens (returns HTTP 400). On 4.7, the actual
// cost lever is output_config.effort. Defaults applied here:
//   Pass 1 (Composition):  effort="xhigh"  — deepest reasoning for plan
//   Pass 2 (Execution):    effort="medium" — per-cycle, plan does heavy lift
//   Pass 3 (Critique):     effort="medium" — pattern matching against plan
//   Pass 3 (Refine):       effort="medium" — applying critique
// thinkingBudget is retained as a docs-only parameter for cost-tracking
// metadata in artifacts; it is NOT forwarded to the API.

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import "dotenv/config";

const MODEL_DEFAULT = "claude-opus-4-7";

function mimeTypeFor(path) {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  throw new Error(`unsupported image extension for ${path}`);
}

function imageBlockFromFile(path) {
  const data = readFileSync(path).toString("base64");
  return {
    type: "image",
    source: { type: "base64", media_type: mimeTypeFor(path), data },
  };
}

function textBlockFromFile(path, label) {
  const text = readFileSync(path, "utf8");
  return { type: "text", text: `### ${label}\n\n${text}` };
}

export function buildSystemPrefix({ promptFiles = [],
                                    summaryJsonPath = null,
                                    compositionPlanPath = null,
                                    extraText = [],
                                    cache = true } = {}) {
  // Text-only blocks suitable for the API's `system` parameter.
  // Anthropic's `system` field rejects non-text blocks (HTTP 400);
  // images must go in user message content via buildImageContentBlocks.
  const blocks = [];
  for (const pf of promptFiles) {
    blocks.push(textBlockFromFile(pf.path, pf.label));
  }
  if (summaryJsonPath) {
    const text = readFileSync(summaryJsonPath, "utf8");
    blocks.push({ type: "text", text: `### TRACK SUMMARY\n\n\`\`\`json\n${text}\n\`\`\`` });
  }
  if (compositionPlanPath) {
    const text = readFileSync(compositionPlanPath, "utf8");
    blocks.push({ type: "text", text: `### COMPOSITION PLAN\n\n\`\`\`json\n${text}\n\`\`\`` });
  }
  for (const t of extraText) {
    blocks.push({ type: "text", text: t });
  }
  if (cache && blocks.length > 0) {
    blocks[blocks.length - 1] = {
      ...blocks[blocks.length - 1],
      cache_control: { type: "ephemeral" },
    };
  }
  return blocks;
}

export function buildImageContentBlocks({ imageFiles = [], cache = true } = {}) {
  // User-message content blocks: alternating text-label + image block.
  // When cache=true, applies cache_control to the last image so the
  // system prefix + image prefix are cached together as a stable
  // prefix across per-cycle calls.
  const blocks = [];
  for (const ifx of imageFiles) {
    if (ifx.label) blocks.push({ type: "text", text: `### ${ifx.label}` });
    blocks.push(imageBlockFromFile(ifx.path));
  }
  if (cache && blocks.length > 0) {
    blocks[blocks.length - 1] = {
      ...blocks[blocks.length - 1],
      cache_control: { type: "ephemeral" },
    };
  }
  return blocks;
}

export function buildUserMessage(sections) {
  const text = sections.map(({ label, body }) =>
    `### ${label}\n\n${body}`).join("\n\n");
  return { role: "user", content: [{ type: "text", text }] };
}

export function extractRationaleAndToolCalls(content) {
  const visible = (content || []).filter((b) => b.type !== "thinking");
  const textBlocks = visible.filter((b) => b.type === "text");
  const toolCalls = visible.filter((b) => b.type === "tool_use").map((b) => ({
    id: b.id, name: b.name, input: b.input,
  }));
  const rationale = textBlocks.map((b) => b.text).join("\n").trim();
  return { rationale, toolCalls };
}

export async function callBake({ system, userMessage, tools = [],
                                 model = MODEL_DEFAULT,
                                 thinkingBudget, // retained for documentation/cost-tracking only
                                 effort = "high", // Opus 4.7 cost lever; "xhigh"/"high"/"medium"/"low"/"max"
                                 maxTokens,
                                 client = null, signal = null }) {
  const c = client || new Anthropic();
  // Opus 4.7: budget_tokens is removed (HTTP 400 if passed). Cost is
  // controlled via output_config.effort. thinkingBudget is docs-only.
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [userMessage],
    thinking: { type: "adaptive" },
    output_config: { effort },
  };
  if (tools.length > 0) params.tools = tools;
  const response = await c.messages.create(params, signal ? { signal } : undefined);
  return {
    content: response.content,
    stop_reason: response.stop_reason,
    usage: response.usage,
    model: response.model,
  };
}

// ─── Higher-level wrappers (required exports for Agent D's bake_critique.mjs)

export async function runComposition({ systemPrompt, userMessages = [], images = [],
                                       thinkingBudget = 49152,
                                       effort = "xhigh",
                                       maxOutputTokens = 16384,
                                       tools = [], client = null } = {}) {
  const system = buildSystemPrefix({
    extraText: systemPrompt ? [systemPrompt] : [],
  });
  const imagePrefix = buildImageContentBlocks({ imageFiles: images });
  let userMessage;
  if (userMessages.length > 0) {
    userMessage = { role: "user", content: [...imagePrefix, ...userMessages] };
  } else {
    const base = buildUserMessage([{ label: "COMPOSITION PASS", body: "" }]);
    userMessage = { role: "user", content: [...imagePrefix, ...base.content] };
  }
  return callBake({ system, userMessage, tools, thinkingBudget, effort, maxTokens: maxOutputTokens, client });
}

export async function runExecution({ systemPrompt, cycleContext = "",
                                     thinkingBudget = 16384,
                                     effort = "medium",
                                     maxOutputTokens = 8192,
                                     tools = [], client = null } = {}) {
  const system = buildSystemPrefix({
    extraText: systemPrompt ? [systemPrompt] : [],
  });
  const userMessage = buildUserMessage([{ label: "EXECUTION PASS", body: cycleContext }]);
  return callBake({ system, userMessage, tools, thinkingBudget, effort, maxTokens: maxOutputTokens, client });
}

export async function runCritique({ systemPrompt, allCycles = "",
                                    thinkingBudget = 16384,
                                    effort = "medium",
                                    maxOutputTokens = 8192,
                                    client = null } = {}) {
  const system = buildSystemPrefix({
    extraText: systemPrompt ? [systemPrompt] : [],
  });
  const userMessage = buildUserMessage([{ label: "CRITIQUE PASS", body: allCycles }]);
  return callBake({ system, userMessage, tools: [], thinkingBudget, effort, maxTokens: maxOutputTokens, client });
}

export async function runRefine({ systemPrompt, weakCycle = "", critique = "",
                                  thinkingBudget = 16384,
                                  effort = "medium",
                                  maxOutputTokens = 8192,
                                  tools = [], client = null } = {}) {
  const system = buildSystemPrefix({
    extraText: systemPrompt ? [systemPrompt] : [],
  });
  const userMessage = buildUserMessage([
    { label: "CYCLE TO REFINE", body: weakCycle },
    { label: "CRITIQUE", body: critique },
  ]);
  return callBake({ system, userMessage, tools, thinkingBudget, effort, maxTokens: maxOutputTokens, client });
}

// ─── Self-tests ────────────────────────────────────────────────────

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  let pass = 0, fail = 0;
  async function t(desc, fn) {
    try { await fn(); pass += 1; process.stdout.write(`  ok  ${desc}\n`); }
    catch (e) { fail += 1; process.stdout.write(`  FAIL ${desc}\n    ${e.message}\n`); }
  }

  await t("extractRationaleAndToolCalls drops thinking blocks", () => {
    const content = [
      { type: "thinking", thinking: "private CoT", signature: "abc" },
      { type: "text", text: "Visible rationale: I chose stillness." },
      { type: "tool_use", id: "tu_1", name: "addText", input: { text: "hello" } },
    ];
    const { rationale, toolCalls } = extractRationaleAndToolCalls(content);
    assert.equal(rationale, "Visible rationale: I chose stillness.");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].name, "addText");
    assert.deepEqual(toolCalls[0].input, { text: "hello" });
  });

  await t("extractRationaleAndToolCalls returns empty rationale when no text block", () => {
    const content = [{ type: "tool_use", id: "x", name: "n", input: {} }];
    const { rationale, toolCalls } = extractRationaleAndToolCalls(content);
    assert.equal(rationale, "");
    assert.equal(toolCalls.length, 1);
  });

  await t("buildUserMessage concatenates sections under ### headers", () => {
    const msg = buildUserMessage([
      { label: "CURRENT CYCLE", body: "scalars..." },
      { label: "RECENT DECISIONS", body: "...patches..." },
    ]);
    assert.equal(msg.role, "user");
    assert.match(msg.content[0].text, /### CURRENT CYCLE\n\nscalars\.\.\./);
    assert.match(msg.content[0].text, /### RECENT DECISIONS\n\n\.\.\.patches\.\.\./);
  });

  await t("buildSystemPrefix attaches cache_control to last block", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bake-anthropic-"));
    writeFileSync(join(tmp, "a.md"), "alpha");
    writeFileSync(join(tmp, "b.md"), "beta");
    const blocks = buildSystemPrefix({
      promptFiles: [{ path: join(tmp, "a.md"), label: "A" },
                    { path: join(tmp, "b.md"), label: "B" }],
    });
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].cache_control, undefined);
    assert.deepEqual(blocks[1].cache_control, { type: "ephemeral" });
  });

  await t("buildImageContentBlocks base64-encodes images with correct media_type", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bake-anthropic-img-"));
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    writeFileSync(join(tmp, "img.png"), png);
    const blocks = buildImageContentBlocks({
      imageFiles: [{ path: join(tmp, "img.png"), label: "spectrogram" }],
    });
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].text, "### spectrogram");
    assert.equal(blocks[1].type, "image");
    assert.equal(blocks[1].source.media_type, "image/png");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
}
