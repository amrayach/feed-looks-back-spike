import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { WebSocketServer } from "ws";

import { createPatchCache } from "./patch_cache.mjs";
import { WsMessageSchema } from "./patch_protocol.mjs";

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
  let featureProducerToken = null;
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
      } else if (url.pathname === "/shared/binding_easing.mjs") {
        filePath = join(srcRoot, "binding_easing.mjs");
      } else if (url.pathname.startsWith("/vendor/zod/")) {
        filePath = safeResolve(zodRoot, url.pathname.slice("/vendor/zod/".length));
      } else if (url.pathname === "/vendor/p5/p5.min.js") {
        filePath = join(nodeRoot, "node_modules", "p5", "lib", "p5.min.js");
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

  async function broadcastFeatureFromProducer(feature, value) {
    if (!currentContext) throw new Error("stage server run context not set");
    const msg = WsMessageSchema.parse({ channel: "feature", feature, value });
    for (const [ws, meta] of clientMeta.entries()) {
      if (!meta.accepted || meta.role !== "operator" || meta.runId !== currentContext.runId) continue;
      sendJson(ws, msg);
    }
  }

  wss.on("connection", (ws) => {
    clientMeta.set(ws, { accepted: false, runId: null, mode: null, role: null });

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
        const requestedRole = parsed.role === "feature_producer" ? "feature_producer" : "operator";
        if (requestedRole === "feature_producer") {
          // Per-run token gate: operator browsers are read-only, but any
          // localhost process could otherwise claim feature_producer just
          // by knowing run_id + mode. run_spike generates the token and
          // forwards it only to the Python child it spawns.
          if (!featureProducerToken || parsed.token !== featureProducerToken) {
            sendJson(ws, { type: "error", message: "feature_producer token invalid or missing" });
            ws.close();
            return;
          }
        }
        meta.accepted = true;
        meta.runId = parsed.run_id;
        meta.mode = parsed.mode;
        meta.role = requestedRole;
        if (requestedRole === "operator") {
          await sendReplay(ws);
        }
        return;
      }

      // Post-handshake routing by role.
      if (meta.role === "feature_producer") {
        if (parsed?.channel !== "feature") {
          sendJson(ws, { type: "error", message: "feature_producer may only send feature messages" });
          return;
        }
        try {
          await broadcastFeatureFromProducer(parsed.feature, parsed.value);
        } catch (err) {
          sendJson(ws, { type: "error", message: `feature rejected: ${err?.message ?? err}` });
        }
        return;
      }

      // Operator role: inbound messages are forbidden (operators are read-only).
      sendJson(ws, { type: "error", message: "operator role is read-only; clients may not post" });
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
      featureProducerToken = randomBytes(16).toString("hex");
      await patchCache.load();
      for (const ws of clientMeta.keys()) {
        try {
          ws.close();
        } catch {
          // ignore stale client close failures
        }
      }
    },

    getFeatureProducerToken() {
      return featureProducerToken;
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
        if (!meta.accepted || meta.role !== "operator" || meta.runId !== currentContext.runId) continue;
        sendJson(ws, { channel: "patch", patch });
      }
    },

    async broadcastFeature(feature, value) {
      await broadcastFeatureFromProducer(feature, value);
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

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const http = await import("node:http");
  const { pathToFileURL } = await import("node:url");
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

  function importModuleWithoutProcess(modulePath) {
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `globalThis.process = undefined; await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
      ],
      { stdio: "pipe" },
    );
  }

  function freshNodeRoot(prefix) {
    const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
    write(join(root, "browser", "stage.html"), "<!doctype html><html><body>stage</body></html>");
    write(join(root, "browser", "bootstrap.mjs"), "export const ok = true;\n");
    write(join(root, "src", "patch_protocol.mjs"), "export const ok = true;\n");
    write(join(root, "src", "scene_layout.mjs"), "export const ok = true;\n");
    write(join(root, "src", "binding_easing.mjs"), "export const ok = true;\n");
    write(join(root, "node_modules", "p5", "lib", "p5.min.js"), "// minified p5 fake content ".repeat(500));
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
      const easing = await requestText(`http://${server.host}:${server.port}/shared/binding_easing.mjs`);
      const image = await requestText(`http://${server.host}:${server.port}/image_cache/test.jpg`);
      const p5src = await requestText(`http://${server.host}:${server.port}/vendor/p5/p5.min.js`);
      const forbidden = await requestText(`http://${server.host}:${server.port}/shared/not_allowed.mjs`);
      assert.equal(stage.status, 200);
      assert.match(stage.body, /stage/);
      assert.equal(shared.status, 200);
      assert.equal(layout.status, 200);
      assert.equal(easing.status, 200);
      assert.equal(image.status, 200);
      assert.equal(p5src.status, 200);
      assert.ok(p5src.body.length > 10000, `p5.min.js body too small (${p5src.body.length} bytes) — check vendored path`);
      assert.equal(forbidden.status, 404);
    } finally {
      await server.close();
    }
  });

  await t("browser-imported shared modules load without a global process", async () => {
    importModuleWithoutProcess(join(DEFAULT_NODE_ROOT, "src", "patch_protocol.mjs"));
    importModuleWithoutProcess(join(DEFAULT_NODE_ROOT, "src", "scene_layout.mjs"));
    importModuleWithoutProcess(join(DEFAULT_NODE_ROOT, "src", "binding_easing.mjs"));
    importModuleWithoutProcess(join(DEFAULT_NODE_ROOT, "browser", "bootstrap.mjs"));
    importModuleWithoutProcess(join(DEFAULT_NODE_ROOT, "browser", "ws_client.mjs"));
    importModuleWithoutProcess(join(DEFAULT_NODE_ROOT, "browser", "scene_reducer.mjs"));
    importModuleWithoutProcess(join(DEFAULT_NODE_ROOT, "browser", "feature_bus.mjs"));
    importModuleWithoutProcess(join(DEFAULT_NODE_ROOT, "browser", "feature_replayer.mjs"));
    importModuleWithoutProcess(join(DEFAULT_NODE_ROOT, "browser", "binding_engine.mjs"));
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

  await t("feature_producer role sends feature messages that reach operator clients when token matches", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-feature");
    const runDir = join(nodeRoot, "output", "run_feat");
    mkdirSync(runDir, { recursive: true });
    const server = await createStageServer({ nodeRoot });
    try {
      await server.setCurrentRunContext({ runId: "feat", mode: "live", runDir });
      const token = server.getFeatureProducerToken();
      assert.ok(token && token.length >= 16, "token should be set after setCurrentRunContext");

      const operatorMessages = [];
      const operatorWs = await new Promise((resolvePromise, rejectPromise) => {
        const ws = new WebSocket(`ws://${server.host}:${server.port}/ws`);
        ws.once("open", () => {
          ws.send(JSON.stringify({ type: "hello", run_id: "feat", mode: "live" }));
        });
        ws.on("message", (raw) => {
          const msg = JSON.parse(String(raw));
          operatorMessages.push(msg);
          if (msg?.patch?.type === "replay.end") resolvePromise(ws);
        });
        ws.once("error", rejectPromise);
      });

      await new Promise((resolvePromise, rejectPromise) => {
        const producer = new WebSocket(`ws://${server.host}:${server.port}/ws`);
        producer.once("open", () => {
          producer.send(JSON.stringify({
            type: "hello",
            role: "feature_producer",
            run_id: "feat",
            mode: "live",
            token,
          }));
          producer.send(JSON.stringify({ channel: "feature", feature: "amplitude", value: 0.42 }));
        });
        setTimeout(() => {
          try {
            producer.close();
          } catch {
            // ignore
          }
          resolvePromise();
        }, 150);
        producer.once("error", rejectPromise);
      });

      await new Promise((r) => setTimeout(r, 100));
      operatorWs.close();

      const featureMessages = operatorMessages.filter((m) => m.channel === "feature");
      assert.equal(featureMessages.length, 1);
      assert.equal(featureMessages[0].feature, "amplitude");
      assert.equal(featureMessages[0].value, 0.42);
    } finally {
      await server.close();
    }
  });

  await t("feature_producer without a valid token is rejected", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-feature-notoken");
    const runDir = join(nodeRoot, "output", "run_notoken");
    mkdirSync(runDir, { recursive: true });
    const server = await createStageServer({ nodeRoot });
    try {
      await server.setCurrentRunContext({ runId: "notoken", mode: "live", runDir });
      const errors = [];
      await new Promise((resolvePromise, rejectPromise) => {
        const producer = new WebSocket(`ws://${server.host}:${server.port}/ws`);
        producer.once("open", () => {
          producer.send(JSON.stringify({
            type: "hello",
            role: "feature_producer",
            run_id: "notoken",
            mode: "live",
            token: "wrong-token",
          }));
        });
        producer.on("message", (raw) => {
          const msg = JSON.parse(String(raw));
          if (msg?.type === "error") errors.push(msg.message);
        });
        producer.on("close", () => resolvePromise());
        setTimeout(() => {
          try {
            producer.close();
          } catch {
            // ignore
          }
        }, 300);
        producer.once("error", rejectPromise);
      });
      assert.ok(
        errors.some((m) => /token/i.test(m)),
        `expected token-rejection error, got ${JSON.stringify(errors)}`,
      );
    } finally {
      await server.close();
    }
  });

  await t("operator clients cannot post feature messages (rejected with error)", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-feature-reject");
    const runDir = join(nodeRoot, "output", "run_reject");
    mkdirSync(runDir, { recursive: true });
    const server = await createStageServer({ nodeRoot });
    try {
      await server.setCurrentRunContext({ runId: "reject", mode: "live", runDir });
      const errors = [];
      await new Promise((resolvePromise, rejectPromise) => {
        const ws = new WebSocket(`ws://${server.host}:${server.port}/ws`);
        let sent = false;
        ws.once("open", () => {
          ws.send(JSON.stringify({ type: "hello", run_id: "reject", mode: "live" }));
        });
        ws.on("message", (raw) => {
          const msg = JSON.parse(String(raw));
          if (!sent && msg?.patch?.type === "replay.end") {
            sent = true;
            ws.send(JSON.stringify({ channel: "feature", feature: "amplitude", value: 0.1 }));
          }
          if (msg?.type === "error") {
            errors.push(msg.message);
            ws.close();
          }
        });
        ws.on("close", () => resolvePromise());
        setTimeout(() => {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }, 500);
        ws.once("error", rejectPromise);
      });
      assert.ok(
        errors.some((m) => /operator|read-only|forbidden/i.test(m)),
        `expected operator-rejection error, got ${JSON.stringify(errors)}`,
      );
    } finally {
      await server.close();
    }
  });

  await t("/run/<run_id>/features_track.json is served with validated schema payload", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-features-track");
    const runDir = join(nodeRoot, "output", "run_ftrack");
    mkdirSync(runDir, { recursive: true });
    const track = {
      schema_version: "1",
      duration_s: 2.0,
      frame_rate_hz: 60,
      frames: [
        {
          t: 0,
          amplitude: 0.1,
          onset_strength: 0,
          spectral_centroid: 1200,
          hijaz_state: "quiet",
          hijaz_intensity: 0.1,
          hijaz_tahwil: false,
        },
        {
          t: 1.0,
          amplitude: 0.5,
          onset_strength: 0.8,
          spectral_centroid: 2000,
          hijaz_state: "approach",
          hijaz_intensity: 0.6,
          hijaz_tahwil: true,
        },
      ],
    };
    write(join(runDir, "features_track.json"), JSON.stringify(track));
    const server = await createStageServer({ nodeRoot });
    try {
      await server.setCurrentRunContext({ runId: "ftrack", mode: "precompute", runDir });
      const res = await requestText(
        `http://${server.host}:${server.port}/run/ftrack/features_track.json`,
      );
      assert.equal(res.status, 200);
      const { FeaturesTrackSchema } = await import("./patch_protocol.mjs");
      const parsed = FeaturesTrackSchema.parse(JSON.parse(res.body));
      assert.equal(parsed.frames.length, 2);
      assert.equal(parsed.frames[1].hijaz_state, "approach");
      assert.equal(parsed.frames[1].hijaz_tahwil, true);
    } finally {
      await server.close();
    }
  });

  await t("broadcastFeature public API validates and relays to operators", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-broadcast-feature");
    const runDir = join(nodeRoot, "output", "run_bcast");
    mkdirSync(runDir, { recursive: true });
    const server = await createStageServer({ nodeRoot });
    try {
      await server.setCurrentRunContext({ runId: "bcast", mode: "precompute", runDir });
      const operatorMessages = [];
      const operatorWs = await new Promise((resolvePromise, rejectPromise) => {
        const ws = new WebSocket(`ws://${server.host}:${server.port}/ws`);
        ws.once("open", () => {
          ws.send(JSON.stringify({ type: "hello", run_id: "bcast", mode: "precompute" }));
        });
        ws.on("message", (raw) => {
          const msg = JSON.parse(String(raw));
          operatorMessages.push(msg);
          if (msg?.patch?.type === "replay.end") resolvePromise(ws);
        });
        ws.once("error", rejectPromise);
      });

      await server.broadcastFeature("amplitude", 0.25);
      await server.broadcastFeature("hijaz_state", "arrived");
      await new Promise((r) => setTimeout(r, 80));
      operatorWs.close();

      await assert.rejects(
        () => server.broadcastFeature("amplitude", 1.5),
        /invalid value|amplitude/i,
      );

      const featureMessages = operatorMessages.filter((m) => m.channel === "feature");
      assert.equal(featureMessages.length, 2);
      assert.equal(featureMessages[0].value, 0.25);
      assert.equal(featureMessages[1].value, "arrived");
    } finally {
      await server.close();
    }
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
