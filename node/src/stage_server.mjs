import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import { createPatchCache } from "./patch_cache.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_NODE_ROOT = resolve(__dirname, "..");

function contentTypeFor(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".mjs":
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".wav":
      return "audio/wav";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

function safeResolve(rootDir, relativePath) {
  const resolvedRoot = resolve(rootDir);
  const filePath = resolve(resolvedRoot, relativePath);
  if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}/`)) return null;
  return filePath;
}

function sendJson(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function makeOperatorUrl({ host, port, runId, mode }) {
  return `http://${host}:${port}/?run_id=${encodeURIComponent(runId)}&mode=${encodeURIComponent(mode)}`;
}

export async function createStageServer({
  host = "127.0.0.1",
  port = 0,
  nodeRoot = DEFAULT_NODE_ROOT,
} = {}) {
  const browserRoot = join(nodeRoot, "browser");
  const srcRoot = join(nodeRoot, "src");
  const outputRoot = join(nodeRoot, "output");
  const imageCacheRoot = join(nodeRoot, "image_cache");
  const zodRoot = join(nodeRoot, "node_modules", "zod");

  let currentContext = null;
  let patchCache = null;
  let lastLifecyclePatch = null;
  const clientMeta = new Map();

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      let filePath = null;

      if (url.pathname === "/") {
        filePath = join(browserRoot, "stage.html");
      } else if (url.pathname.startsWith("/browser/")) {
        filePath = safeResolve(browserRoot, url.pathname.slice("/browser/".length));
      } else if (url.pathname === "/shared/patch_protocol.mjs") {
        filePath = join(srcRoot, "patch_protocol.mjs");
      } else if (url.pathname === "/shared/scene_layout.mjs") {
        filePath = join(srcRoot, "scene_layout.mjs");
      } else if (url.pathname.startsWith("/vendor/zod/")) {
        filePath = safeResolve(zodRoot, url.pathname.slice("/vendor/zod/".length));
      } else {
        const runMatch = /^\/run\/([^/]+)\/(audio\.wav|features_track\.json)$/.exec(url.pathname);
        if (runMatch) {
          filePath = join(outputRoot, `run_${runMatch[1]}`, runMatch[2]);
        } else if (url.pathname.startsWith("/image_cache/")) {
          filePath = safeResolve(imageCacheRoot, url.pathname.slice("/image_cache/".length));
        }
      }

      if (!filePath || !existsSync(filePath)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }

      const body = readFileSync(filePath);
      res.writeHead(200, {
        "content-type": contentTypeFor(filePath),
        "cache-control": "no-store",
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`server error: ${err?.message ?? err}`);
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  async function sendReplay(ws) {
    if (!patchCache || !currentContext) return;
    sendJson(ws, { channel: "patch", patch: { type: "replay.begin", run_id: currentContext.runId } });
    for (const patch of patchCache.getReplayPatches()) {
      sendJson(ws, { channel: "patch", patch });
    }
    sendJson(ws, { channel: "patch", patch: { type: "replay.end", run_id: currentContext.runId } });
    if (lastLifecyclePatch) {
      sendJson(ws, { channel: "patch", patch: lastLifecyclePatch });
    }
  }

  wss.on("connection", (ws) => {
    clientMeta.set(ws, { accepted: false, runId: null, mode: null });

    ws.on("message", async (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        sendJson(ws, { type: "error", message: "invalid json" });
        ws.close();
        return;
      }

      const meta = clientMeta.get(ws);
      if (!meta?.accepted) {
        if (parsed?.type !== "hello") {
          sendJson(ws, { type: "error", message: "first message must be hello" });
          ws.close();
          return;
        }
        if (!currentContext) {
          sendJson(ws, { type: "error", message: "run context unavailable" });
          ws.close();
          return;
        }
        if (parsed.run_id !== currentContext.runId || parsed.mode !== currentContext.mode) {
          sendJson(ws, { type: "error", message: "run mismatch" });
          ws.close();
          return;
        }
        meta.accepted = true;
        meta.runId = parsed.run_id;
        meta.mode = parsed.mode;
        await sendReplay(ws);
      }
    });

    ws.on("close", () => {
      clientMeta.delete(ws);
    });
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    host,
    port: boundPort,

    getOperatorUrl({ runId, mode }) {
      return makeOperatorUrl({ host, port: boundPort, runId, mode });
    },

    async setCurrentRunContext({ runId, mode, runDir }) {
      currentContext = { runId, mode, runDir };
      patchCache = createPatchCache({ persistPath: join(runDir, "patch_cache.json") });
      lastLifecyclePatch = null;
      await patchCache.load();
      for (const ws of clientMeta.keys()) {
        try {
          ws.close();
        } catch {
          // ignore stale client close failures
        }
      }
    },

    async broadcastPatch(patch) {
      if (!patchCache || !currentContext) {
        throw new Error("stage server run context not set");
      }
      if (patch?.type === "cycle.begin" || patch?.type === "cycle.end") {
        lastLifecyclePatch = structuredClone(patch);
      }
      await patchCache.apply(patch);
      for (const [ws, meta] of clientMeta.entries()) {
        if (!meta.accepted || meta.runId !== currentContext.runId) continue;
        sendJson(ws, { channel: "patch", patch });
      }
    },

    async close() {
      for (const ws of clientMeta.keys()) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      await new Promise((resolvePromise) => wss.close(() => resolvePromise()));
      await new Promise((resolvePromise, rejectPromise) =>
        server.close((err) => (err ? rejectPromise(err) : resolvePromise())),
      );
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import("node:assert/strict")).default;
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const http = await import("node:http");
  const { WebSocket } = await import("ws");

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

  function write(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function requestText(url) {
    return new Promise((resolvePromise, rejectPromise) => {
      http.get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolvePromise({ status: res.statusCode, body }));
      }).on("error", rejectPromise);
    });
  }

  function freshNodeRoot(prefix) {
    const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
    write(join(root, "browser", "stage.html"), "<!doctype html><html><body>stage</body></html>");
    write(join(root, "browser", "bootstrap.mjs"), "export const ok = true;\n");
    write(join(root, "src", "patch_protocol.mjs"), "export const ok = true;\n");
    write(join(root, "src", "scene_layout.mjs"), "export const ok = true;\n");
    write(join(root, "node_modules", "zod", "index.js"), "export const z = {};\n");
    write(join(root, "image_cache", "test.jpg"), "jpg");
    return root;
  }

  await t("serves stage.html and static assets", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-static");
    const server = await createStageServer({ nodeRoot });
    try {
      const stage = await requestText(`http://${server.host}:${server.port}/`);
      const shared = await requestText(`http://${server.host}:${server.port}/shared/patch_protocol.mjs`);
      const layout = await requestText(`http://${server.host}:${server.port}/shared/scene_layout.mjs`);
      const image = await requestText(`http://${server.host}:${server.port}/image_cache/test.jpg`);
      const forbidden = await requestText(`http://${server.host}:${server.port}/shared/not_allowed.mjs`);
      assert.equal(stage.status, 200);
      assert.match(stage.body, /stage/);
      assert.equal(shared.status, 200);
      assert.equal(layout.status, 200);
      assert.equal(image.status, 200);
      assert.equal(forbidden.status, 404);
    } finally {
      await server.close();
    }
  });

  await t("replays current state after hello handshake", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-replay");
    const runDir = join(nodeRoot, "output", "run_123");
    mkdirSync(runDir, { recursive: true });
    const server = await createStageServer({ nodeRoot });
    try {
      await server.setCurrentRunContext({ runId: "123", mode: "precompute", runDir });
      await server.broadcastPatch({
        type: "background.set",
        css_background: "linear-gradient(180deg, #111, #000)",
      });
      await server.broadcastPatch({
        type: "element.add",
        element: {
          element_id: "elem_0001",
          type: "text",
          content: { content: "after", position: "lower-left", style: "serif, large" },
          lifetime_s: null,
          composition_group_id: null,
        },
      });

      const messages = [];
      await new Promise((resolvePromise, rejectPromise) => {
        const ws = new WebSocket(`ws://${server.host}:${server.port}/ws`);
        ws.once("open", () => {
          ws.send(JSON.stringify({ type: "hello", run_id: "123", mode: "precompute" }));
        });
        ws.on("message", (data) => {
          messages.push(JSON.parse(String(data)));
          if (messages.length === 4) {
            ws.close();
            resolvePromise();
          }
        });
        ws.once("error", rejectPromise);
      });

      assert.equal(messages[0].patch.type, "replay.begin");
      assert.equal(messages[1].patch.type, "background.set");
      assert.equal(messages[2].patch.type, "element.add");
      assert.equal(messages[3].patch.type, "replay.end");
    } finally {
      await server.close();
    }
  });

  await t("replays the last lifecycle patch so reconnects recover ready state", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-replay-lifecycle");
    const runDir = join(nodeRoot, "output", "run_123");
    mkdirSync(runDir, { recursive: true });
    const server = await createStageServer({ nodeRoot });
    try {
      await server.setCurrentRunContext({ runId: "123", mode: "precompute", runDir });
      await server.broadcastPatch({
        type: "cycle.begin",
        cycle_n: 7,
        hijaz_state: { phase: "arrived" },
      });
      await server.broadcastPatch({ type: "cycle.end" });

      const messages = [];
      await new Promise((resolvePromise, rejectPromise) => {
        const ws = new WebSocket(`ws://${server.host}:${server.port}/ws`);
        ws.once("open", () => {
          ws.send(JSON.stringify({ type: "hello", run_id: "123", mode: "precompute" }));
        });
        ws.on("message", (data) => {
          messages.push(JSON.parse(String(data)));
          if (messages.length === 3) {
            ws.close();
            resolvePromise();
          }
        });
        ws.once("error", rejectPromise);
      });

      assert.equal(messages[0].patch.type, "replay.begin");
      assert.equal(messages[1].patch.type, "replay.end");
      assert.equal(messages[2].patch.type, "cycle.end");
    } finally {
      await server.close();
    }
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
