import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_THINKING = Object.freeze({ type: "adaptive" });
export const DEFAULT_OUTPUT_CONFIG = Object.freeze({ effort: "high" });

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

function parseEnvInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableOpusError(err) {
  const status = err?.status ?? err?.response?.status;
  if ([408, 409, 429, 500, 502, 503, 504, 529].includes(status)) return true;
  const message = String(err?.message ?? "").toLowerCase();
  return (
    message.includes("overloaded") ||
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("temporarily unavailable") ||
    message.includes("timeout")
  );
}

export async function callOpus(client, packet, options = {}) {
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

  const maxAttempts = Math.max(
    1,
    options.maxAttempts ?? parseEnvInt("FLB_OPUS_MAX_ATTEMPTS", 6),
  );
  const baseDelayMs = options.baseDelayMs ?? parseEnvInt("FLB_OPUS_RETRY_BASE_MS", 1500);
  const logger = options.logger ?? process.stderr;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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

      const retryable = isRetryableOpusError(err);
      if (!retryable || attempt >= maxAttempts) throw err;

      const jitterMs = Math.floor(Math.random() * 250);
      const delayMs = Math.min(15000, baseDelayMs * 2 ** (attempt - 1)) + jitterMs;
      logger?.write?.(
        `WARN: Opus API transient failure (${err.status ?? "unknown"}): ${err.message}. ` +
          `Retrying ${attempt + 1}/${maxAttempts} in ${delayMs}ms.\n`,
      );
      await sleep(delayMs);
    }
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

  await t("callOpus passes thinking and high output_config to messages.create by default", async () => {
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
    assert.deepEqual(calls[0].output_config, { effort: "high" });
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

  await t("callOpus retries transient overload errors before succeeding", async () => {
    let attempts = 0;
    const fakeClient = {
      messages: {
        create: async () => {
          attempts += 1;
          if (attempts < 3) {
            const err = new Error("529 overloaded_error: Overloaded");
            err.status = 529;
            throw err;
          }
          return { id: "msg", content: [] };
        },
      },
    };
    const logger = { write() {} };
    const response = await callOpus(
      fakeClient,
      {
        model: "claude-opus-4-7",
        max_tokens: 1024,
        system: [{ type: "text", text: "sys" }],
        tools: [],
        messages: [{ role: "user", content: "hi" }],
      },
      { maxAttempts: 3, baseDelayMs: 0, logger },
    );
    assert.equal(response.id, "msg");
    assert.equal(attempts, 3);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
