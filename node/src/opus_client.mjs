import Anthropic from "@anthropic-ai/sdk";

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

export async function callOpus(client, { model, max_tokens, system, tools, messages }) {
  try {
    return await client.messages.create({
      model,
      max_tokens,
      system,
      tools,
      messages,
    });
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
