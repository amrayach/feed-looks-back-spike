import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_THINKING = Object.freeze({ type: "adaptive" });
export const DEFAULT_OUTPUT_CONFIG = Object.freeze({ effort: "medium" });

export function makeOpusClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "sk-ant-your-key-here") {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Create node/.env from .env.example and fill in your key.",
    );
  }
  return new Anthropic({
    apiKey,
    maxRetries: 5,
  });
}

export function resolveModel() {
  return process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
}

export async function callOpus(client, packet) {
  const {
    model,
    max_tokens,
    system,
    tools,
    messages,
    thinking = DEFAULT_THINKING,
    output_config = DEFAULT_OUTPUT_CONFIG,
  } = packet;
  const params = { model, max_tokens, system, tools, messages };
  if (thinking) params.thinking = thinking;
  if (output_config) params.output_config = output_config;
  try {
    return await client.messages.create(params);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error(`Auth error: ${err.message}. Check ANTHROPIC_API_KEY.`);
    }
    if (err instanceof Anthropic.BadRequestError) {
      throw new Error(`Bad request (400): ${err.message}. Packet shape is wrong; not retrying.`);
    }
    if (err instanceof Anthropic.NotFoundError) {
      throw new Error(`Not found (404): ${err.message}. Likely an invalid model id: ${model}.`);
    }
    throw err;
  }
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
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

  await t("resolveModel defaults to claude-opus-4-7 when env var is unset", () => {
    const saved = process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    try {
      assert.equal(resolveModel(), "claude-opus-4-7");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_MODEL = saved;
    }
  });

  await t("makeOpusClient rejects a missing key", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      assert.throws(() => makeOpusClient(), /ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  await t("callOpus passes thinking and output_config to messages.create by default", async () => {
    const calls = [];
    const fakeClient = {
      messages: {
        create: async (params) => {
          calls.push(params);
          return { id: "msg", content: [] };
        },
      },
    };
    await callOpus(fakeClient, {
      model: "claude-opus-4-7",
      max_tokens: 1024,
      system: [{ type: "text", text: "sys" }],
      tools: [],
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].thinking, { type: "adaptive" });
    assert.deepEqual(calls[0].output_config, { effort: "medium" });
  });

  await t("callOpus honours explicit overrides", async () => {
    const calls = [];
    const fakeClient = {
      messages: {
        create: async (params) => {
          calls.push(params);
          return { id: "msg", content: [] };
        },
      },
    };
    await callOpus(fakeClient, {
      model: "claude-opus-4-7",
      max_tokens: 1024,
      system: [{ type: "text", text: "sys" }],
      tools: [],
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
      output_config: { effort: "high" },
    });
    assert.deepEqual(calls[0].thinking, { type: "disabled" });
    assert.deepEqual(calls[0].output_config, { effort: "high" });
  });

  await t("callOpus passes content-block system arrays through unchanged", async () => {
    const calls = [];
    const fakeClient = {
      messages: {
        create: async (params) => {
          calls.push(params);
          return { id: "msg", content: [] };
        },
      },
    };
    const systemBlocks = [
      { type: "text", text: "base" },
      { type: "text", text: "rules" },
      { type: "text", text: "mood label" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } },
      { type: "text", text: "", cache_control: { type: "ephemeral" } },
    ];
    await callOpus(fakeClient, {
      model: "claude-opus-4-7",
      max_tokens: 1024,
      system: systemBlocks,
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    });
    assert.deepStrictEqual(calls[0].system, systemBlocks);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
