import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { WebSocketServer } from "ws";

import { createPatchCache } from "./patch_cache.mjs";
import { WsMessageSchema } from "./patch_protocol.mjs";

// Server-enforced CSP for the p5 sandbox HTML. Attribute-only CSP on
// the iframe tag is not a strong boundary (browser support is partial),
// so we serve the iframe from a real route and set the header here. The
// iframe sandbox has allow-scripts WITHOUT allow-same-origin, so the
// opaque origin + CSP + watchdog form triple-redundant isolation around
// the Opus-authored p5 code.
const SANDBOX_CSP_HEADER = [
  "default-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "img-src 'self' data: blob:",
  "style-src 'unsafe-inline'",
  "script-src 'self' 'unsafe-eval'",
].join("; ");

const VALID_SANDBOX_SLOTS = new Set(["background", "localized"]);

// Escape a string so it is safe to embed inside <script type="application/json">.
// JSON inside a script element is inert under our CSP (not executed),
// but the tokenizer still treats </script> greedily — replace angle
// brackets, ampersands, and line separators to be safe.
function jsonScriptEscape(str) {
  return JSON.stringify(str)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function sandboxHtml({ codeJson }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;}canvas{display:block;}</style>
</head>
<body>
<script type="application/json" id="flb-sketch-code">${codeJson}</script>
<script src="/vendor/p5/p5.min.js"></script>
<script src="/p5/bridge.js"></script>
</body>
</html>
`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_NODE_ROOT = resolve(__dirname, "..");

function contentTypeFor(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".mjs":
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
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
  // Per-run map of {sketch_id -> {code, slot}}. Populated when sketch.add
  // / sketch.background.set patches pass through broadcastPatch; consumed
  // by the /p5/sandbox route when an iframe requests its HTML. Cleared on
  // setCurrentRunContext so runs cannot leak p5 source into each other.
  const sketchCodes = new Map();

  function serveSandboxHtml(res, url) {
    const sketchId = url.searchParams.get("sketch_id");
    const slot = url.searchParams.get("slot");
    if (!sketchId || !slot) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("missing required query params: sketch_id, slot");
      return;
    }
    if (!VALID_SANDBOX_SLOTS.has(slot)) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("invalid slot");
      return;
    }
    const registered = sketchCodes.get(sketchId);
    const code = registered ? registered.code : "";
    const html = sandboxHtml({ codeJson: jsonScriptEscape(code) });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": SANDBOX_CSP_HEADER,
    });
    res.end(html);
  }

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname === "/p5/sandbox") {
        serveSandboxHtml(res, url);
        return;
      }

      let filePath = null;

      if (url.pathname === "/") {
        filePath = join(browserRoot, "stage.html");
      } else if (url.pathname === "/hud") {
        // Code-stream HUD. Loads the feed UI; the page itself reads
        // ?run_id=...&mode=posthoc|live and pulls data either from
        // /run/<id>/run_summary.json (posthoc) or the stage WebSocket
        // (live). Served from the same origin as stage.html so the HUD
        // has no new cross-origin or permissions surface.
        filePath = join(browserRoot, "hud.html");
      } else if (url.pathname === "/p5/bridge.js") {
        filePath = join(browserRoot, "p5_bridge.js");
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
        // Served from a checked-in vendored copy (node/vendor/p5/p5.min.js),
        // not node_modules. The sandbox iframe's CSP is `script-src 'self'`;
        // serving from our own origin keeps that directive narrow (adding
        // a CDN origin would weaken the boundary). The vendored bytes are
        // the contract — see node/vendor/p5/README.md for refresh steps.
        filePath = join(nodeRoot, "vendor", "p5", "p5.min.js");
      } else {
        const runMatch = /^\/run\/([^/]+)\/(audio\.wav|features_track\.json|run_summary\.json)$/.exec(url.pathname);
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
      sketchCodes.clear();
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
      // Register sketch code in the per-run map BEFORE broadcasting so
      // by the time the browser mounts the iframe and requests
      // /p5/sandbox?sketch_id=..., the code is already there. Both
      // sketch.add and sketch.background.set carry their own sketch_id
      // (the id scene_state minted). sketch.retire drops the entry so
      // stale code doesn't accumulate across a run.
      if (patch?.type === "sketch.add" && typeof patch.sketch_id === "string") {
        sketchCodes.set(patch.sketch_id, { code: String(patch.code ?? ""), slot: "localized" });
      } else if (patch?.type === "sketch.background.set" && typeof patch.sketch_id === "string") {
        sketchCodes.set(patch.sketch_id, { code: String(patch.code ?? ""), slot: "background" });
      } else if (patch?.type === "sketch.retire" && typeof patch.sketch_id === "string") {
        sketchCodes.delete(patch.sketch_id);
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
        res.on("end", () =>
          resolvePromise({ status: res.statusCode, body, headers: res.headers }),
        );
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
    write(join(root, "browser", "hud.html"), "<!doctype html><html><body>hud FLB_HUD_MARKER</body></html>");
    write(join(root, "browser", "hud.css"), "/* FLB_HUD_CSS_MARKER */\n");
    write(join(root, "browser", "hud.mjs"), "// FLB_HUD_JS_MARKER\n");
    write(join(root, "browser", "hud_parser.mjs"), "export const hud = true;\n");
    write(join(root, "browser", "bootstrap.mjs"), "export const ok = true;\n");
    write(join(root, "browser", "p5_bridge.js"), "// fake p5_bridge.js content — FLB_BRIDGE_MARKER\n");
    write(join(root, "src", "patch_protocol.mjs"), "export const ok = true;\n");
    write(join(root, "src", "scene_layout.mjs"), "export const ok = true;\n");
    write(join(root, "src", "binding_easing.mjs"), "export const ok = true;\n");
    // Vendored p5 (see node/vendor/p5/README.md). Tests put a byte-sized
    // fake here; production serves the checked-in real p5.min.js.
    write(join(root, "vendor", "p5", "p5.min.js"), "// VENDORED P5 MARKER — minified p5 fake ".repeat(500));
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
      // Fix 7: served bytes must come from the vendored copy, not
      // node_modules. The freshNodeRoot fixture writes a distinctive
      // marker into vendor/p5/p5.min.js; assert it appears in the
      // response. (If we ever accidentally point the route back at
      // node_modules, this test flips red.)
      assert.match(p5src.body, /VENDORED P5 MARKER/, "p5.min.js is not served from node/vendor/p5/");
      assert.equal(forbidden.status, 404);
    } finally {
      await server.close();
    }
  });

  await t("no CDN references for p5 anywhere in node/src or node/browser", async () => {
    // Fix 7 guard: the sandbox CSP deliberately omits CDN origins. A
    // `<script src="https://cdn…/p5">` anywhere in our code would leak
    // past the CSP check at review time, so grep the sources directly.
    const { readdirSync, readFileSync } = await import("node:fs");
    const { dirname: dir } = await import("node:path");
    const here = dir(fileURLToPath(import.meta.url));
    const nodeDir = join(here, "..");
    const cdnPatterns = [
      /cdnjs\.cloudflare\.com[^\s"')]*p5/i,
      /cdn\.jsdelivr\.net[^\s"')]*p5/i,
      /unpkg\.com[^\s"')]*p5/i,
      /cdn\.skypack\.dev[^\s"')]*p5/i,
    ];
    const roots = ["src", "browser"].map((d) => join(nodeDir, d));
    for (const root of roots) {
      for (const name of readdirSync(root)) {
        if (!/\.(mjs|js|html)$/i.test(name)) continue;
        const body = readFileSync(join(root, name), "utf8");
        for (const pat of cdnPatterns) {
          assert.ok(!pat.test(body), `CDN reference to p5 in ${root}/${name}: ${pat}`);
        }
      }
    }
  });

  await t("/p5/sandbox without sketch_id or slot query params returns 400", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-p5-missing-params");
    const server = await createStageServer({ nodeRoot });
    try {
      const noParams = await requestText(`http://${server.host}:${server.port}/p5/sandbox`);
      const missingSlot = await requestText(
        `http://${server.host}:${server.port}/p5/sandbox?sketch_id=x`,
      );
      const missingId = await requestText(
        `http://${server.host}:${server.port}/p5/sandbox?slot=background`,
      );
      const badSlot = await requestText(
        `http://${server.host}:${server.port}/p5/sandbox?sketch_id=x&slot=evil`,
      );
      assert.equal(noParams.status, 400);
      assert.equal(missingSlot.status, 400);
      assert.equal(missingId.status, 400);
      assert.equal(badSlot.status, 400);
    } finally {
      await server.close();
    }
  });

  await t("/p5/sandbox emits an HTTP Content-Security-Policy header with the expected directives", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-p5-csp");
    const runDir = join(nodeRoot, "output", "run_p5csp");
    mkdirSync(runDir, { recursive: true });
    const server = await createStageServer({ nodeRoot });
    try {
      await server.setCurrentRunContext({ runId: "p5csp", mode: "precompute", runDir });
      await server.broadcastPatch({
        type: "sketch.add",
        sketch_id: "sketch_csp_1",
        position: "center",
        size: "small",
        code: "function setup(){createCanvas(100,100);}",
        audio_reactive: false,
        lifetime_s: null,
      });
      const res = await requestText(
        `http://${server.host}:${server.port}/p5/sandbox?sketch_id=sketch_csp_1&slot=localized`,
      );
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"] ?? "", /text\/html/);
      const csp = res.headers["content-security-policy"] ?? "";
      for (const directive of [
        "default-src 'none'",
        "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "img-src 'self' data: blob:",
        "style-src 'unsafe-inline'",
        "script-src 'self' 'unsafe-eval'",
      ]) {
        assert.ok(
          csp.includes(directive),
          `CSP header missing directive: ${directive} (got ${csp})`,
        );
      }
      // Sketch code is embedded as JSON inside a <script type="application/json"> block;
      // the response body MUST contain the code so the bridge can pick it up.
      assert.match(res.body, /createCanvas/);
      // Script refs point at same-origin vendored p5 and the bridge.
      assert.match(res.body, /src="\/vendor\/p5\/p5\.min\.js"/);
      assert.match(res.body, /src="\/p5\/bridge\.js"/);
    } finally {
      await server.close();
    }
  });

  await t("/p5/sandbox for sketch.background.set registers under the patch's sketch_id", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-p5-bg");
    const runDir = join(nodeRoot, "output", "run_p5bg");
    mkdirSync(runDir, { recursive: true });
    const server = await createStageServer({ nodeRoot });
    try {
      await server.setCurrentRunContext({ runId: "p5bg", mode: "precompute", runDir });
      await server.broadcastPatch({
        type: "sketch.background.set",
        sketch_id: "sketch_bg_0001",
        code: "function setup(){noLoop();} function draw(){background(10);}",
        audio_reactive: true,
      });
      const res = await requestText(
        `http://${server.host}:${server.port}/p5/sandbox?sketch_id=sketch_bg_0001&slot=background`,
      );
      assert.equal(res.status, 200);
      assert.match(res.body, /function draw\(\)\{background\(10\);\}/);
    } finally {
      await server.close();
    }
  });

  await t("sketch.retire for a background sketch drops the registered code", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-p5-bg-retire");
    const runDir = join(nodeRoot, "output", "run_p5bgr");
    mkdirSync(runDir, { recursive: true });
    const server = await createStageServer({ nodeRoot });
    try {
      await server.setCurrentRunContext({ runId: "p5bgr", mode: "precompute", runDir });
      await server.broadcastPatch({
        type: "sketch.background.set",
        sketch_id: "sketch_bg_old",
        code: "function draw(){background(20);}",
        audio_reactive: false,
      });
      await server.broadcastPatch({ type: "sketch.retire", sketch_id: "sketch_bg_old" });
      const res = await requestText(
        `http://${server.host}:${server.port}/p5/sandbox?sketch_id=sketch_bg_old&slot=background`,
      );
      // Graceful-empty after retire — old code must not leak past retire.
      assert.equal(res.status, 200);
      assert.doesNotMatch(res.body, /background\(20\)/);
    } finally {
      await server.close();
    }
  });

  await t("/p5/sandbox returns an empty-code response for unknown sketch ids (graceful degradation)", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-p5-unknown");
    const runDir = join(nodeRoot, "output", "run_p5unknown");
    mkdirSync(runDir, { recursive: true });
    const server = await createStageServer({ nodeRoot });
    try {
      await server.setCurrentRunContext({ runId: "p5unknown", mode: "precompute", runDir });
      const res = await requestText(
        `http://${server.host}:${server.port}/p5/sandbox?sketch_id=never_registered&slot=localized`,
      );
      assert.equal(res.status, 200);
      // Empty string embeds as "" in the JSON block — the bridge defaults
      // to empty code so the iframe loads cleanly without a sketch.
      assert.match(res.body, /id="flb-sketch-code"/);
    } finally {
      await server.close();
    }
  });

  await t("sketch.retire drops the registered code so a stale fetch returns empty", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-p5-retire");
    const runDir = join(nodeRoot, "output", "run_p5retire");
    mkdirSync(runDir, { recursive: true });
    const server = await createStageServer({ nodeRoot });
    try {
      await server.setCurrentRunContext({ runId: "p5retire", mode: "precompute", runDir });
      await server.broadcastPatch({
        type: "sketch.add",
        sketch_id: "sketch_retire_1",
        position: "center",
        size: "small",
        code: "function draw(){background(42);}",
        audio_reactive: false,
        lifetime_s: null,
      });
      const before = await requestText(
        `http://${server.host}:${server.port}/p5/sandbox?sketch_id=sketch_retire_1&slot=localized`,
      );
      assert.match(before.body, /background\(42\)/);
      await server.broadcastPatch({ type: "sketch.retire", sketch_id: "sketch_retire_1" });
      const after = await requestText(
        `http://${server.host}:${server.port}/p5/sandbox?sketch_id=sketch_retire_1&slot=localized`,
      );
      assert.doesNotMatch(after.body, /background\(42\)/);
    } finally {
      await server.close();
    }
  });

  await t("/p5/bridge.js is served from node/browser/p5_bridge.js with a JS content-type", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-p5-bridge");
    const server = await createStageServer({ nodeRoot });
    try {
      const res = await requestText(`http://${server.host}:${server.port}/p5/bridge.js`);
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"] ?? "", /javascript/);
      assert.match(res.body, /FLB_BRIDGE_MARKER/);
    } finally {
      await server.close();
    }
  });

  await t("setCurrentRunContext clears the per-run sketchCodes registry", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-p5-clear");
    const runDir = join(nodeRoot, "output", "run_clear1");
    const runDir2 = join(nodeRoot, "output", "run_clear2");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(runDir2, { recursive: true });
    const server = await createStageServer({ nodeRoot });
    try {
      await server.setCurrentRunContext({ runId: "clear1", mode: "precompute", runDir });
      await server.broadcastPatch({
        type: "sketch.add",
        sketch_id: "keep_me",
        position: "center",
        size: "small",
        code: "function draw(){fill('red');}",
        audio_reactive: false,
        lifetime_s: null,
      });
      const still = await requestText(
        `http://${server.host}:${server.port}/p5/sandbox?sketch_id=keep_me&slot=localized`,
      );
      assert.match(still.body, /fill\('red'\)/);
      // New run context must purge the old registry — stale p5 source
      // from a prior run must not leak into the next.
      await server.setCurrentRunContext({ runId: "clear2", mode: "precompute", runDir: runDir2 });
      const gone = await requestText(
        `http://${server.host}:${server.port}/p5/sandbox?sketch_id=keep_me&slot=localized`,
      );
      assert.doesNotMatch(gone.body, /fill\('red'\)/);
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
    importModuleWithoutProcess(join(DEFAULT_NODE_ROOT, "browser", "audio_visual_layer.mjs"));
    importModuleWithoutProcess(join(DEFAULT_NODE_ROOT, "browser", "p5_sandbox.mjs"));
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

  await t("/hud serves the HUD shell and /run/<id>/run_summary.json is exposed", async () => {
    const nodeRoot = freshNodeRoot("flb-stage-server-hud");
    const runDir = join(nodeRoot, "output", "run_hudtest");
    mkdirSync(runDir, { recursive: true });
    // The HUD route is the only route that exposes run_summary.json to
    // the browser. If this test breaks, the post-hoc replay path is broken.
    const fakeSummary = {
      run_id: "hudtest",
      config: "config_a",
      model: "claude-opus-4-7",
      mode: "precompute",
      cycles_total: 1,
      per_cycle: [
        {
          cycle_index: 0,
          cycle_id: "cycle_000",
          elapsed_s: 0.5,
          status: "ok",
          tool_calls: [{ name: "setBackground", input: { css_background: "#000" } }],
        },
      ],
    };
    write(join(runDir, "run_summary.json"), JSON.stringify(fakeSummary));
    const server = await createStageServer({ nodeRoot });
    try {
      await server.setCurrentRunContext({ runId: "hudtest", mode: "precompute", runDir });
      const hud = await requestText(`http://${server.host}:${server.port}/hud`);
      const hudJs = await requestText(`http://${server.host}:${server.port}/browser/hud.mjs`);
      const hudCss = await requestText(`http://${server.host}:${server.port}/browser/hud.css`);
      const summary = await requestText(
        `http://${server.host}:${server.port}/run/hudtest/run_summary.json`,
      );
      assert.equal(hud.status, 200);
      assert.match(hud.body, /FLB_HUD_MARKER/);
      assert.equal(hudJs.status, 200);
      assert.match(hudJs.body, /FLB_HUD_JS_MARKER/);
      assert.match(hudJs.headers["content-type"] ?? "", /javascript/);
      assert.equal(hudCss.status, 200);
      assert.match(hudCss.body, /FLB_HUD_CSS_MARKER/);
      // Guard against regressing to octet-stream — browsers refuse a
      // stylesheet without a text/css content-type, which silently
      // flattens the HUD to Times New Roman on a white background.
      assert.match(hudCss.headers["content-type"] ?? "", /text\/css/);
      assert.equal(summary.status, 200);
      assert.match(summary.headers["content-type"] ?? "", /json/);
      const parsed = JSON.parse(summary.body);
      assert.equal(parsed.run_id, "hudtest");
      assert.equal(parsed.per_cycle[0].tool_calls[0].name, "setBackground");
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
