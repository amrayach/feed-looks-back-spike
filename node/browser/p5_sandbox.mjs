// node/browser/p5_sandbox.mjs
// Host-side manager for sandboxed p5.js sketches. One instance per page;
// mounts iframes for background + up to 3 localized sketches, forwards
// feature_bus values into each iframe over a MessageChannel port, watches
// heartbeats, retires on timeout. Iframe src points at the server's
// /p5/sandbox route, which returns an HTML shell with a server-enforced
// CSP header (see node/src/stage_server.mjs and node/browser/p5_bridge.js).
//
// Safety boundary (spec §7.3, post Tier 6 R1 MessageChannel refactor):
//   - sandbox="allow-scripts"  — no allow-same-origin, no network
//   - HTTP Content-Security-Policy header served by /p5/sandbox with
//     default-src 'none'; connect-src 'none'; frame-src 'none'; and
//     script-src 'self' 'unsafe-eval' (attribute CSP is not a strong
//     boundary so we no longer rely on it)
//   - heartbeat every 500 ms, kill on 2 s silence
//   - parent↔iframe transport is a MessageChannel: after a single
//     wildcard-target handshake post on iframe load that transfers
//     port2 into the sandbox, every subsequent message flows over the
//     port. Ports do not use origin — the port itself is the capability.
//   - figurative-only enforcement lives in the prompt, not at runtime

const sharedUrl = import.meta.url.startsWith("file:")
  ? "../src/patch_protocol.mjs"
  : "/shared/patch_protocol.mjs";

// zod is available on the browser via the /vendor/zod importmap (see stage.html).
// In the Node self-test we load zod through patch_protocol (which re-exports
// nothing — we import zod directly). Both sides resolve 'zod' to the same
// ESM build, so message schemas validate identically.
const zodModule = import.meta.url.startsWith("file:")
  ? await import("zod")
  : await import("/vendor/zod/index.js");
const z = zodModule.z ?? zodModule.default?.z ?? zodModule.default ?? zodModule;

// Silence the "unused sharedUrl" — imported for future parity with the rest
// of /browser/ which loads patch_protocol. Sandbox messages are its own
// schema (not WsMessageSchema), so we don't pull it in here.
void sharedUrl;

// MessageChannel resolution. In the browser it's a global; in Node (15+)
// it lives under node:worker_threads. We resolve once at module load
// so each createP5Sandbox() call uses the same constructor.
const MessageChannelCtor =
  typeof MessageChannel !== "undefined"
    ? MessageChannel
    : (await import("node:worker_threads")).MessageChannel;

const HeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  frame_count: z.number(),
  last_frame_time_ms: z.number(),
});
const ReadySchema = z.object({
  type: z.literal("ready"),
  sketch_id: z.string().nullable().optional(),
});
const ErrorSchema = z.object({ type: z.literal("error"), message: z.string() });
const LogSchema = z.object({
  type: z.literal("log"),
  level: z.enum(["log", "warn", "error"]),
  message: z.string(),
});
const SandboxMessageSchema = z.discriminatedUnion("type", [
  HeartbeatSchema,
  ReadySchema,
  ErrorSchema,
  LogSchema,
]);

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 2000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 500;
const INITIAL_WARMUP_GRACE_MS = 3000;

function buildSandboxSrc(sketchId, slot) {
  const params = new URLSearchParams({ sketch_id: sketchId, slot });
  return `/p5/sandbox?${params.toString()}`;
}

// Default figurative fallback mounted when a sketch is retired because
// it crashed (heartbeat timeout or {type:"error"} port message). A still
// DOM motif — spec §1 is "figurative, not abstract": candle flame as a
// recognizable still image rather than a flow field or particle grid.
// Authors can override with their own fallbackFactory option.
function defaultFallbackFactory(documentLike, { slot, reason }) {
  const el = documentLike.createElement("div");
  el.dataset.flbSketchFallback = "1";
  el.dataset.flbFallbackReason = reason;
  el.dataset.flbFallbackSlot = slot;
  const isBackground = slot === "background";
  const sizeCss = isBackground
    ? "width: 100%; height: 100%;"
    : "width: 100%; height: 100%;";
  el.style = el.style ?? {};
  el.style.cssText = [
    "display: flex",
    "align-items: center",
    "justify-content: center",
    "pointer-events: none",
    sizeCss,
  ].join("; ");
  // Single <svg> candle flame — teardrop with a subtle inner highlight.
  // Inline markup keeps the fallback self-contained (no extra fetch)
  // and renders under the same origin as the stage, unlike the iframe.
  el.innerHTML = `<svg viewBox="-24 -40 48 80" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="candle flame"><path d="M 0 -36 C 14 -18, 14 2, 4 14 C -2 20, 2 26, 0 28 C -2 26, 2 20, -4 14 C -14 2, -14 -18, 0 -36 Z" fill="#ffb347" opacity="0.92"/><path d="M 0 -24 C 6 -12, 6 2, 1 8 C -1 12, 1 16, 0 18 C -1 16, 1 12, -1 8 C -6 2, -6 -12, 0 -24 Z" fill="#fff3c0" opacity="0.85"/></svg>`;
  return el;
}

const SKETCH_SIZES = {
  small: { w: 300, h: 300 },
  medium: { w: 500, h: 500 },
  large: { w: 800, h: 800 },
};

const POSITION_ANCHORS = {
  "top-left":      { top: "0%",   left: "0%" },
  "top-center":    { top: "0%",   left: "50%", translateX: "-50%" },
  "top-right":     { top: "0%",   right: "0%" },
  "mid-left":      { top: "50%",  left: "0%", translateY: "-50%" },
  "center":        { top: "50%",  left: "50%", translateX: "-50%", translateY: "-50%" },
  "mid-right":     { top: "50%",  right: "0%", translateY: "-50%" },
  "bottom-left":   { bottom: "0%", left: "0%" },
  "bottom-center": { bottom: "0%", left: "50%", translateX: "-50%" },
  "bottom-right":  { bottom: "0%", right: "0%" },
};

function positionToStyle(positionKey, sizeKey) {
  const size = SKETCH_SIZES[sizeKey] ?? SKETCH_SIZES.medium;
  const anchor = POSITION_ANCHORS[positionKey] ?? POSITION_ANCHORS.center;
  const transforms = [];
  if (anchor.translateX) transforms.push(`translateX(${anchor.translateX})`);
  if (anchor.translateY) transforms.push(`translateY(${anchor.translateY})`);
  const css = [
    "position: absolute",
    `width: ${size.w}px`,
    `height: ${size.h}px`,
    "border: 0",
    anchor.top != null ? `top: ${anchor.top}` : null,
    anchor.bottom != null ? `bottom: ${anchor.bottom}` : null,
    anchor.left != null ? `left: ${anchor.left}` : null,
    anchor.right != null ? `right: ${anchor.right}` : null,
    transforms.length > 0 ? `transform: ${transforms.join(" ")}` : null,
  ].filter(Boolean).join("; ");
  return css;
}

export function createP5Sandbox({
  documentLike = globalThis.document,
  mount,
  bus,
  rafImpl = globalThis.requestAnimationFrame,
  cancelRafImpl = globalThis.cancelAnimationFrame,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
  now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
  warmupGraceMs = INITIAL_WARMUP_GRACE_MS,
  onRetire = () => {},
  onSketchError = () => {},
  onSketchLog = () => {},
  fallbackFactory,
  messageChannelCtor = MessageChannelCtor,
} = {}) {
  if (!mount) throw new Error("mount is required");
  const factoryForFallback =
    fallbackFactory ?? ((ctx) => defaultFallbackFactory(documentLike, ctx));

  const entries = new Map(); // sketch_id → {iframe, slot, hostPort, createdAt, lastHeartbeat, ready}
  let featuresLatest = {
    amplitude: 0,
    onset_strength: 0,
    spectral_centroid: 0,
    hijaz_state: "unknown",
    hijaz_intensity: 0,
    hijaz_tahwil: false,
  };
  let rafHandle = null;
  let watchdogHandle = null;
  let subscriptions = [];

  function subscribeToFeatures() {
    if (subscriptions.length > 0 || !bus) return;
    for (const name of ["amplitude", "onset_strength", "spectral_centroid", "hijaz_state", "hijaz_intensity", "hijaz_tahwil"]) {
      subscriptions.push(
        bus.subscribe(name, (value) => {
          featuresLatest[name] = value;
        }),
      );
    }
  }

  function unsubscribeFromFeatures() {
    for (const unsub of subscriptions) {
      try { unsub(); } catch { /* best effort */ }
    }
    subscriptions = [];
  }

  function forwardFeaturesTick() {
    for (const entry of entries.values()) {
      if (!entry.ready || !entry.hostPort) continue;
      try {
        // Port-based send — no targetOrigin because ports do not use
        // origin for addressing. The port IS the capability.
        entry.hostPort.postMessage({ type: "features", values: { ...featuresLatest } });
      } catch {
        // port may have been closed mid-tick
      }
    }
    if (rafImpl && entries.size > 0) {
      rafHandle = rafImpl(forwardFeaturesTick);
    } else {
      rafHandle = null;
    }
  }

  function startRafIfNeeded() {
    if (rafHandle != null || !rafImpl) return;
    rafHandle = rafImpl(forwardFeaturesTick);
  }

  function runWatchdog() {
    const nowMs = now();
    for (const [sketchId, entry] of [...entries.entries()]) {
      const grace = nowMs - entry.createdAt < warmupGraceMs;
      const since = nowMs - entry.lastHeartbeat;
      if (!grace && since >= heartbeatTimeoutMs) {
        retireAndReplace(sketchId, "heartbeat-timeout");
      }
    }
  }

  function startWatchdogIfNeeded() {
    if (watchdogHandle != null || !setIntervalImpl) return;
    watchdogHandle = setIntervalImpl(runWatchdog, watchdogIntervalMs);
  }

  function stopWatchdogIfIdle() {
    if (entries.size === 0 && watchdogHandle != null && clearIntervalImpl) {
      clearIntervalImpl(watchdogHandle);
      watchdogHandle = null;
    }
  }

  function handlePortMessage(sketchId, data) {
    const parsed = SandboxMessageSchema.safeParse(data);
    if (!parsed.success) return; // drop silently
    const entry = entries.get(sketchId);
    if (!entry) return;
    if (parsed.data.type === "heartbeat") {
      entry.lastHeartbeat = now();
    } else if (parsed.data.type === "ready") {
      entry.ready = true;
      entry.lastHeartbeat = now();
    } else if (parsed.data.type === "error") {
      onSketchError({ sketch_id: sketchId, message: parsed.data.message });
      retireAndReplace(sketchId, "sketch-error");
    } else if (parsed.data.type === "log") {
      onSketchLog({
        sketch_id: sketchId,
        level: parsed.data.level,
        message: parsed.data.message,
      });
    }
  }

  function mountInternal({ sketchId, slot, styleCss }) {
    subscribeToFeatures();

    // sketchId is both the host-side tracking key AND the URL param the
    // iframe uses to fetch its code from the server's per-run sketchCodes
    // map. Background and localized sketches share the same id namespace
    // (minted by scene_state) so retires target the same id everywhere.
    const iframe = documentLike.createElement("iframe");
    iframe.dataset.sketchId = sketchId;
    iframe.dataset.sketchSlot = slot;
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.style = iframe.style ?? {};
    iframe.style.cssText = styleCss;
    // Server serves /p5/sandbox with an HTTP Content-Security-Policy
    // header. The old iframe csp= attribute is not a strong boundary
    // (browser support is partial), so we drop it here.
    iframe.src = buildSandboxSrc(sketchId, slot);

    // Build the capability: one channel per iframe. port1 stays with
    // the host, port2 is transferred to the iframe on handshake. After
    // transfer, only the iframe holds port2 and only the host holds
    // port1 — no third party can intercept traffic.
    const channel = new messageChannelCtor();
    const hostPort = channel.port1;
    const iframePort = channel.port2;

    // Port receive: heartbeat/ready/error validated via Zod, then
    // dispatched to the same handler paths the old window listener
    // used. Unlike the window listener, this port is scoped to a
    // single iframe, so there is no need to match source → entry.
    hostPort.onmessage = (event) => {
      // Browsers and Node's worker_threads both wrap the port payload in
      // a MessageEvent exposing .data. We always read from .data.
      handlePortMessage(sketchId, event?.data);
    };

    mount.appendChild(iframe);

    entries.set(sketchId, {
      sketch_id: sketchId,
      iframe,
      slot,
      hostPort,
      createdAt: now(),
      lastHeartbeat: now(),
      ready: false,
    });

    // Handshake on iframe load. This is the ONE intentional wildcard
    // targetOrigin in the entire sandbox flow.
    //
    // Required because sandbox=allow-scripts (no allow-same-origin)
    // forces the iframe's document origin to be opaque; targetOrigin
    // cannot name opaque origins, so we cannot use a named origin
    // here. Protected by:
    //   (a) bridge-side event.source === window.parent check
    //   (b) bridge-side message-shape validation (type="port-handoff",
    //       exactly 1 transferred port)
    //   (c) bridge closes its window listener after the first valid
    //       handshake (single-shot)
    // See docs/superpowers/plans/2026-04-24-tier-6-rework-plan.md §4
    // and the Codex Tier 6 blocker that drove this refactor.
    iframe.addEventListener("load", () => {
      try {
        iframe.contentWindow?.postMessage(
          { type: "port-handoff", sketch_id: sketchId },
          "*",
          [iframePort],
        );
      } catch {
        // If the iframe was retired between mount and load (e.g., the
        // patch was retracted), the post will throw — best effort.
      }
    }, { once: true });

    startRafIfNeeded();
    startWatchdogIfNeeded();
  }

  function retireInternal(sketchId, reason = "retire") {
    const entry = entries.get(sketchId);
    if (!entry) return null;
    try { entry.iframe.remove(); } catch { /* best effort */ }
    // Close the host-side port. In Node's worker_threads implementation
    // this releases the handle so the event loop can exit; in browsers
    // it severs the connection so any stale bridge send is a no-op.
    try { entry.hostPort?.close?.(); } catch { /* best effort */ }
    entries.delete(sketchId);
    onRetire({ sketch_id: sketchId, reason, slot: entry.slot });
    stopWatchdogIfIdle();
    if (entries.size === 0) {
      if (rafHandle != null && cancelRafImpl) cancelRafImpl(rafHandle);
      rafHandle = null;
    }
    return entry;
  }

  // Called on crash paths — heartbeat-timeout (watchdog) and
  // {type:"error"} port message from the bridge. Retires the iframe
  // AND mounts a figurative DOM fallback in its place so the slot is
  // never left empty (per spec §1: always figurative, never abstract).
  // retireSketch() — the patch-driven retire — does NOT go through here
  // because the author is retiring by intent, not reacting to a crash.
  function retireAndReplace(sketchId, reason) {
    const entry = retireInternal(sketchId, reason);
    if (!entry) return;
    let fallback = null;
    try {
      fallback = factoryForFallback({ slot: entry.slot, sketch_id: sketchId, reason });
    } catch {
      fallback = null;
    }
    if (!fallback) return;
    try {
      mount.appendChild(fallback);
    } catch {
      /* best effort */
    }
  }

  function mountBackground({ sketch_id }) {
    // Caller is responsible for retiring the prior background (scene_reducer
    // receives sketch.retire first, then sketch.background.set). Defensive
    // same-id remount tear-down mirrors binding_engine's idempotency.
    if (entries.has(sketch_id)) retireInternal(sketch_id, "remount");
    const styleCss = [
      "position: absolute",
      "top: 0",
      "left: 0",
      "width: 100%",
      "height: 100%",
      "border: 0",
      "z-index: 0",
    ].join("; ");
    mountInternal({
      sketchId: sketch_id,
      slot: "background",
      styleCss,
    });
  }

  function mountLocalized({ sketch_id, position, size }) {
    if (entries.has(sketch_id)) retireInternal(sketch_id, "remount");
    const styleCss = `${positionToStyle(position, size)}; z-index: 10`;
    mountInternal({
      sketchId: sketch_id,
      slot: "localized",
      styleCss,
    });
  }

  function retireSketch(sketch_id) {
    retireInternal(sketch_id, "retire");
  }

  function dispose() {
    for (const id of [...entries.keys()]) retireInternal(id, "dispose");
    unsubscribeFromFeatures();
    if (rafHandle != null && cancelRafImpl) cancelRafImpl(rafHandle);
    rafHandle = null;
    if (watchdogHandle != null && clearIntervalImpl) clearIntervalImpl(watchdogHandle);
    watchdogHandle = null;
  }

  return {
    mountBackground,
    mountLocalized,
    retireSketch,
    dispose,
    _entries: entries,
  };
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const { createFeatureBus } = await import("./feature_bus.mjs");
  const { MessageChannel: NodeMessageChannel } = await import("node:worker_threads");

  // Let microtask/port delivery drain. Node's worker_threads MessagePort
  // posts messages via the event loop; setImmediate + one tick is enough
  // for the onmessage handler to fire.
  const flush = () => new Promise((r) => setImmediate(r));

  class FakeElement {
    constructor(tag) {
      this.tagName = tag?.toUpperCase() ?? "DIV";
      this.children = [];
      this.dataset = {};
      this.style = {};
      this._attributes = {};
      this._listeners = new Map();
      this.src = null;
      this.parent = null;
      this._postedToContentWindow = [];
      // contentWindow.postMessage captures {data, target, transfer}
      // so tests can inspect the handshake's third argument (the
      // transfer list containing port2).
      const owner = this;
      this.contentWindow = {
        postMessage(data, target, transfer) {
          owner._postedToContentWindow.push({ data, target, transfer });
        },
      };
    }
    appendChild(child) {
      this.children.push(child);
      child.parent = this;
      return child;
    }
    remove() {
      if (!this.parent) return;
      const idx = this.parent.children.indexOf(this);
      if (idx !== -1) this.parent.children.splice(idx, 1);
      this.parent = null;
    }
    setAttribute(name, value) {
      this._attributes[name] = value;
    }
    getAttribute(name) {
      return this._attributes[name];
    }
    addEventListener(type, fn, opts) {
      const list = this._listeners.get(type) ?? [];
      list.push({ fn, opts });
      this._listeners.set(type, list);
    }
    removeEventListener(type, fn) {
      const list = this._listeners.get(type) ?? [];
      this._listeners.set(type, list.filter((x) => x.fn !== fn));
    }
    fireEvent(type, event = {}) {
      const list = this._listeners.get(type) ?? [];
      for (const { fn } of list) fn(event);
      // Drop any {once: true} listeners so they don't re-fire.
      this._listeners.set(type, list.filter((x) => !x.opts?.once));
    }
  }

  class FakeDocument {
    constructor() {
      this.defaultView = new FakeWindow();
    }
    createElement(tag) {
      return new FakeElement(tag);
    }
  }

  class FakeWindow {
    constructor() {
      this.location = { origin: "http://host.test:9000", href: "http://host.test:9000/stage.html" };
    }
    addEventListener() {}
    removeEventListener() {}
  }

  function intervalRunner() {
    const tasks = [];
    let id = 0;
    return {
      set: (fn /*, ms */) => {
        id += 1;
        tasks.push({ id, fn });
        return id;
      },
      clear: (handle) => {
        const idx = tasks.findIndex((t) => t.id === handle);
        if (idx !== -1) tasks.splice(idx, 1);
      },
      tick() {
        for (const task of [...tasks]) task.fn();
      },
      pending: () => tasks.length,
    };
  }

  function rafRunner() {
    const tasks = [];
    let id = 0;
    return {
      schedule: (fn) => {
        id += 1;
        tasks.push({ id, fn });
        return id;
      },
      cancel: (handle) => {
        const idx = tasks.findIndex((t) => t.id === handle);
        if (idx !== -1) tasks.splice(idx, 1);
      },
      tick() {
        const queued = tasks.splice(0);
        for (const task of queued) task.fn();
      },
      pending: () => tasks.length,
    };
  }

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

  // Registry so we can tear down any sandboxes that a test forgot to
  // dispose. Open MessagePorts keep Node's event loop alive, so leaking
  // one sandbox makes the whole test process hang instead of exiting.
  const allSandboxes = [];
  const allExtraPorts = [];

  function makeSandbox(opts = {}) {
    const documentLike = opts.documentLike ?? new FakeDocument();
    const mount = opts.mount ?? documentLike.createElement("div");
    const bus = opts.bus ?? createFeatureBus();
    const raf = opts.raf ?? rafRunner();
    const interval = opts.interval ?? intervalRunner();
    const sandbox = createP5Sandbox({
      documentLike,
      mount,
      bus,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      setIntervalImpl: interval.set,
      clearIntervalImpl: interval.clear,
      now: opts.now ?? (() => 1000),
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs,
      warmupGraceMs: opts.warmupGraceMs,
      onRetire: opts.onRetire,
      onSketchError: opts.onSketchError,
      onSketchLog: opts.onSketchLog,
      messageChannelCtor: NodeMessageChannel,
    });
    allSandboxes.push(sandbox);
    return { sandbox, documentLike, mount, bus, raf, interval };
  }

  // Helper: fire iframe load, extract the port-handoff args and the
  // transferred port2 so the test can act as the bridge. The returned
  // port2 is registered for cleanup so the test-suite exit is clean
  // even if the test forgets to close it explicitly.
  function handshake(iframe) {
    iframe.fireEvent("load");
    const posted = iframe._postedToContentWindow;
    assert.ok(posted.length >= 1, "expected a port-handoff post on iframe load");
    const first = posted[0];
    const port2 = first.transfer?.[0];
    if (port2) allExtraPorts.push(port2);
    return { call: first, port2 };
  }

  await t("mountBackground creates an iframe with sandbox='allow-scripts' and src pointing at /p5/sandbox", () => {
    const { sandbox, mount } = makeSandbox();
    sandbox.mountBackground({ sketch_id: "sketch_0001" });
    assert.equal(mount.children.length, 1);
    const iframe = mount.children[0];
    assert.equal(iframe.getAttribute("sandbox"), "allow-scripts");
    assert.equal(iframe.getAttribute("csp"), undefined);
    assert.equal(iframe.srcdoc, undefined);
    assert.match(iframe.src, /^\/p5\/sandbox\?sketch_id=sketch_0001&slot=background$/);
    assert.equal(sandbox._entries.size, 1);
  });

  await t("iframe load fires one port-handoff post with targetOrigin '*' and exactly one transferred port", () => {
    const { sandbox, mount } = makeSandbox();
    sandbox.mountLocalized({ sketch_id: "h1", position: "center", size: "small" });
    const iframe = mount.children[0];
    assert.equal(iframe._postedToContentWindow.length, 0, "no post before load");
    iframe.fireEvent("load");
    assert.equal(iframe._postedToContentWindow.length, 1);
    const call = iframe._postedToContentWindow[0];
    assert.equal(call.data.type, "port-handoff");
    assert.equal(call.data.sketch_id, "h1");
    assert.equal(call.target, "*");
    assert.ok(Array.isArray(call.transfer), "transfer arg must be an array");
    assert.equal(call.transfer.length, 1, "exactly one transferred port");
    // port2 must be a real MessagePort (worker_threads in tests, browser MessagePort in runtime).
    assert.ok(call.transfer[0] != null, "transferred port is non-null");
    assert.equal(typeof call.transfer[0].postMessage, "function");
  });

  await t("two consecutive mountBackground + explicit retire → exactly one iframe (Fix 6)", () => {
    const { sandbox, mount } = makeSandbox();
    sandbox.mountBackground({ sketch_id: "sketch_bg_old" });
    assert.equal(mount.children.length, 1);
    assert.match(mount.children[0].src, /sketch_id=sketch_bg_old&slot=background/);
    sandbox.retireSketch("sketch_bg_old");
    assert.equal(mount.children.length, 0);
    sandbox.mountBackground({ sketch_id: "sketch_bg_new" });
    assert.equal(mount.children.length, 1);
    assert.match(mount.children[0].src, /sketch_id=sketch_bg_new&slot=background/);
  });

  await t("mountLocalized positions the iframe according to position + size and uses src with patch sketch_id", () => {
    const { sandbox, mount } = makeSandbox();
    sandbox.mountLocalized({ sketch_id: "sketch_a", position: "top-right", size: "small" });
    const iframe = mount.children[0];
    assert.match(iframe.style.cssText, /width: 300px/);
    assert.match(iframe.style.cssText, /height: 300px/);
    assert.match(iframe.style.cssText, /top: 0%/);
    assert.match(iframe.style.cssText, /right: 0%/);
    assert.match(iframe.src, /^\/p5\/sandbox\?sketch_id=sketch_a&slot=localized$/);
    assert.doesNotMatch(iframe.getAttribute("sandbox") ?? "", /allow-same-origin/);
  });

  await t("features flow over hostPort (not iframe.contentWindow) after bridge signals ready", async () => {
    const { sandbox, mount, bus, raf } = makeSandbox();
    sandbox.mountLocalized({ sketch_id: "sketch_b", position: "center", size: "medium" });
    const iframe = mount.children[0];
    const { port2 } = handshake(iframe);
    assert.ok(port2, "expected port2 from handshake transfer list");
    const fromHost = [];
    port2.onmessage = (e) => fromHost.push(e.data);
    // Bridge signals ready via port2
    port2.postMessage({ type: "ready", sketch_id: "sketch_b" });
    await flush();
    // Dispatch features
    bus.dispatch("amplitude", 0.5);
    bus.dispatch("hijaz_state", "arrived");
    raf.tick();
    await flush();
    // The only iframe.contentWindow.postMessage call was the handshake;
    // features must flow over the port.
    assert.equal(iframe._postedToContentWindow.length, 1, "features must not go via iframe.contentWindow.postMessage");
    const lastFeatureMsg = fromHost[fromHost.length - 1];
    assert.equal(lastFeatureMsg.type, "features");
    assert.equal(lastFeatureMsg.values.amplitude, 0.5);
    assert.equal(lastFeatureMsg.values.hijaz_state, "arrived");
    sandbox.dispose();
    port2.close();
  });

  await t("heartbeat over port updates lastHeartbeat", async () => {
    let clock = 100;
    const { sandbox, mount } = makeSandbox({ now: () => clock });
    sandbox.mountLocalized({ sketch_id: "sketch_c", position: "center", size: "small" });
    const iframe = mount.children[0];
    const { port2 } = handshake(iframe);
    clock = 500;
    port2.postMessage({ type: "heartbeat", frame_count: 30, last_frame_time_ms: 16.7 });
    await flush();
    const entry = sandbox._entries.get("sketch_c");
    assert.equal(entry.lastHeartbeat, 500);
    sandbox.dispose();
    port2.close();
  });

  await t("console log messages over port surface through onSketchLog", async () => {
    const logs = [];
    const { sandbox, mount } = makeSandbox({ onSketchLog: (info) => logs.push(info) });
    sandbox.mountLocalized({ sketch_id: "sketch_log", position: "center", size: "small" });
    const iframe = mount.children[0];
    const { port2 } = handshake(iframe);
    port2.postMessage({ type: "log", level: "warn", message: "lamp flicker" });
    await flush();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].sketch_id, "sketch_log");
    assert.equal(logs[0].level, "warn");
    assert.equal(logs[0].message, "lamp flicker");
    sandbox.dispose();
    port2.close();
  });

  await t("invalid port message shape is dropped silently (no crash, no heartbeat update)", async () => {
    let clock = 0;
    const { sandbox, mount } = makeSandbox({ now: () => clock });
    sandbox.mountLocalized({ sketch_id: "sketch_f", position: "center", size: "small" });
    const iframe = mount.children[0];
    const { port2 } = handshake(iframe);
    const entry = sandbox._entries.get("sketch_f");
    const before = entry.lastHeartbeat;
    port2.postMessage({ type: "garbage", something: 1 });
    await flush();
    assert.equal(entry.lastHeartbeat, before);
    sandbox.dispose();
    port2.close();
  });

  await t("no heartbeat past warmup + timeout retires the sketch (watchdog fires)", () => {
    const retired = [];
    let clock = 100;
    const { sandbox, mount, interval } = makeSandbox({
      now: () => clock,
      heartbeatTimeoutMs: 2000,
      warmupGraceMs: 3000,
      onRetire: (info) => retired.push(info),
    });
    sandbox.mountLocalized({ sketch_id: "sketch_d", position: "center", size: "small" });
    // No handshake fired — the iframe is "dead on arrival" from the host's
    // perspective, which is exactly the bug case the watchdog must catch.
    clock = 3000;
    interval.tick();
    assert.equal(sandbox._entries.size, 1);
    clock = 100 + 3001 + 2001;
    interval.tick();
    assert.equal(sandbox._entries.size, 0);
    assert.equal(retired.length, 1);
    assert.equal(retired[0].sketch_id, "sketch_d");
    assert.equal(retired[0].reason, "heartbeat-timeout");
    void mount;
  });

  await t("retireSketch removes iframe and fires onRetire with 'retire'", () => {
    const retired = [];
    const { sandbox, mount } = makeSandbox({ onRetire: (info) => retired.push(info) });
    sandbox.mountLocalized({ sketch_id: "sketch_e", position: "center", size: "medium" });
    sandbox.retireSketch("sketch_e");
    assert.equal(mount.children.length, 0);
    assert.equal(retired[0].reason, "retire");
  });

  await t("dispose tears down iframes, watchdog, rAF, and per-iframe ports", () => {
    const { sandbox, mount, raf, interval } = makeSandbox();
    sandbox.mountLocalized({ sketch_id: "s1", position: "center", size: "small" });
    sandbox.mountLocalized({ sketch_id: "s2", position: "top-left", size: "small" });
    sandbox.dispose();
    assert.equal(sandbox._entries.size, 0);
    assert.equal(mount.children.length, 0);
    assert.equal(raf.pending(), 0);
    assert.equal(interval.pending(), 0);
  });

  await t("unready entries do not receive feature messages over port", async () => {
    const { sandbox, mount, bus, raf } = makeSandbox();
    sandbox.mountLocalized({ sketch_id: "a", position: "center", size: "small" });
    sandbox.mountLocalized({ sketch_id: "b", position: "top-left", size: "small" });
    const iframeA = mount.children[0];
    const iframeB = mount.children[1];
    const { port2: portA } = handshake(iframeA);
    const { port2: portB } = handshake(iframeB);
    const receivedA = [];
    const receivedB = [];
    portA.onmessage = (e) => receivedA.push(e.data);
    portB.onmessage = (e) => receivedB.push(e.data);
    // Only A signals ready.
    portA.postMessage({ type: "ready" });
    await flush();
    bus.dispatch("amplitude", 0.7);
    raf.tick();
    await flush();
    assert.ok(receivedA.some((m) => m.type === "features" && m.values.amplitude === 0.7));
    assert.equal(receivedB.length, 0, "unready port must not receive features");
    sandbox.dispose();
    portA.close();
    portB.close();
  });

  await t("remount with same sketch_id tears down prior entry and re-issues src", () => {
    const { sandbox, mount } = makeSandbox();
    sandbox.mountLocalized({ sketch_id: "r1", position: "center", size: "small" });
    sandbox.mountLocalized({ sketch_id: "r1", position: "top-left", size: "small" });
    assert.equal(sandbox._entries.size, 1);
    assert.equal(mount.children.length, 1);
    assert.match(mount.children[0].src, /^\/p5\/sandbox\?sketch_id=r1&slot=localized$/);
  });

  await t("{type:'error'} port message retires the iframe AND mounts a figurative DOM fallback", async () => {
    const retired = [];
    const errors = [];
    const { sandbox, mount } = makeSandbox({
      onRetire: (info) => retired.push(info),
      onSketchError: (info) => errors.push(info),
    });
    sandbox.mountLocalized({ sketch_id: "boom_1", position: "center", size: "small" });
    const iframe = mount.children[0];
    const { port2 } = handshake(iframe);
    port2.postMessage({ type: "error", message: "TypeError: p is not defined" });
    await flush();
    assert.equal(sandbox._entries.size, 0);
    assert.equal(mount.children.length, 1);
    const fallback = mount.children[0];
    assert.equal(fallback.dataset.flbSketchFallback, "1");
    assert.equal(fallback.dataset.flbFallbackReason, "sketch-error");
    assert.ok(/candle flame/.test(fallback.innerHTML || ""), "fallback should be figurative (candle flame)");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "TypeError: p is not defined");
    assert.equal(retired.length, 1);
    assert.equal(retired[0].reason, "sketch-error");
    port2.close();
  });

  await t("heartbeat timeout also routes through retireAndReplace (same fallback path)", () => {
    let clock = 100;
    const retired = [];
    const { sandbox, mount, interval } = makeSandbox({
      now: () => clock,
      heartbeatTimeoutMs: 2000,
      warmupGraceMs: 3000,
      onRetire: (info) => retired.push(info),
    });
    sandbox.mountLocalized({ sketch_id: "silent_1", position: "center", size: "small" });
    clock = 100 + 3001 + 2001;
    interval.tick();
    assert.equal(sandbox._entries.size, 0);
    assert.equal(mount.children.length, 1);
    assert.equal(mount.children[0].dataset.flbSketchFallback, "1");
    assert.equal(mount.children[0].dataset.flbFallbackReason, "heartbeat-timeout");
    assert.equal(retired[0].reason, "heartbeat-timeout");
  });

  await t("patch-driven retireSketch does NOT mount a fallback (crash-only path)", () => {
    const { sandbox, mount } = makeSandbox();
    sandbox.mountLocalized({ sketch_id: "bye_1", position: "center", size: "small" });
    assert.equal(mount.children.length, 1);
    sandbox.retireSketch("bye_1");
    assert.equal(mount.children.length, 0);
  });

  await t("grep guard: module source has NO wildcard postMessage on iframe.contentWindow", async () => {
    // R1 regression: a future edit that accidentally reintroduces
    //   iframe.contentWindow.postMessage(..., "*")
    // must fail this test. The single intentional wildcard (the
    // handshake) has a justification block-comment immediately above
    // it citing this plan; we allow exactly one occurrence, and only
    // inside the block that has the comment cue.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "p5_sandbox.mjs"), "utf8");
    const occurrences = [...src.matchAll(/iframe\.contentWindow\?\.postMessage\(/g)];
    assert.equal(occurrences.length, 1, `expected exactly one iframe.contentWindow.postMessage call (the handshake); found ${occurrences.length}`);
    // The single occurrence must be preceded by the "port-handoff"
    // justification comment so the intent is discoverable by grep.
    const idx = occurrences[0].index;
    const precedingWindow = src.slice(Math.max(0, idx - 1200), idx);
    assert.ok(/port-handoff/.test(precedingWindow), "wildcard postMessage must be preceded by a 'port-handoff' justification comment");
    // And the argument triple must target "*" (the only place we accept it).
    const followingWindow = src.slice(idx, idx + 400);
    assert.ok(/"\*"/.test(followingWindow), "the one allowed wildcard must use \"*\" literally");
  });

  await t("bridge accepts handshake from window.parent with exactly 1 port (vm harness)", async () => {
    const { vmBridgeHarness } = await loadBridgeHarness();
    const h = vmBridgeHarness();
    // Simulate the host's handshake post: source=parent, 1 port,
    // shape {type:"port-handoff", sketch_id:"b1"}.
    const channel = new NodeMessageChannel();
    const hostPort = channel.port1;
    const iframePort = channel.port2;
    h.dispatchMessage({
      source: h.ctx.window.parent,
      data: { type: "port-handoff", sketch_id: "b1" },
      ports: [iframePort],
    });
    // Bridge accepts: sends "ready" via port.
    const fromBridge = [];
    hostPort.onmessage = (e) => fromBridge.push(e.data);
    await flush();
    assert.ok(fromBridge.some((m) => m.type === "ready" && m.sketch_id === "b1"), "bridge did not post ready via port");
    h.teardown();
    hostPort.close();
  });

  await t("bridge rejects handshake from non-parent source (vm harness)", async () => {
    const { vmBridgeHarness } = await loadBridgeHarness();
    const h = vmBridgeHarness();
    const channel = new NodeMessageChannel();
    const hostPort = channel.port1;
    const iframePort = channel.port2;
    const fromBridge = [];
    hostPort.onmessage = (e) => fromBridge.push(e.data);
    h.dispatchMessage({
      source: { /* some stranger window */ },
      data: { type: "port-handoff", sketch_id: "b2" },
      ports: [iframePort],
    });
    await flush();
    assert.equal(fromBridge.length, 0, "bridge accepted a non-parent handshake");
    // And the bridge listener is still installed (single-shot only detaches on SUCCESS).
    assert.equal(h.ctx.__flb_listeners.length, 1);
    h.teardown();
    hostPort.close();
    iframePort.close();
  });

  await t("bridge rejects handshake with 0 ports or 2 ports (vm harness)", async () => {
    const { vmBridgeHarness } = await loadBridgeHarness();
    const h = vmBridgeHarness();
    const channel1 = new NodeMessageChannel();
    const channel2 = new NodeMessageChannel();
    const fromBridge = [];
    channel1.port1.onmessage = (e) => fromBridge.push(e.data);
    // Zero ports: malformed handshake.
    h.dispatchMessage({
      source: h.ctx.window.parent,
      data: { type: "port-handoff", sketch_id: "zero" },
      ports: [],
    });
    await flush();
    assert.equal(fromBridge.length, 0, "bridge accepted a handshake with 0 ports");
    // Two ports: malformed handshake.
    h.dispatchMessage({
      source: h.ctx.window.parent,
      data: { type: "port-handoff", sketch_id: "two" },
      ports: [channel1.port2, channel2.port2],
    });
    await flush();
    assert.equal(fromBridge.length, 0, "bridge accepted a handshake with 2 ports");
    h.teardown();
    channel1.port1.close();
    channel1.port2.close();
    channel2.port1.close();
    channel2.port2.close();
  });

  await t("after handshake, parent-sent features flow over port into window.features", async () => {
    const { vmBridgeHarness } = await loadBridgeHarness();
    const h = vmBridgeHarness();
    const channel = new NodeMessageChannel();
    const hostPort = channel.port1;
    const iframePort = channel.port2;
    h.dispatchMessage({
      source: h.ctx.window.parent,
      data: { type: "port-handoff", sketch_id: "c1" },
      ports: [iframePort],
    });
    await flush();
    hostPort.postMessage({ type: "features", values: { amplitude: 0.42, hijaz_state: "arrived" } });
    await flush();
    assert.equal(h.ctx.window.features.amplitude, 0.42);
    assert.equal(h.ctx.window.features.hijaz_state, "arrived");
    h.teardown();
    hostPort.close();
  });

  await t("bridge heartbeat arrives on the port, NOT on window.parent.postMessage", async () => {
    const { vmBridgeHarness } = await loadBridgeHarness();
    const h = vmBridgeHarness();
    const channel = new NodeMessageChannel();
    const hostPort = channel.port1;
    const iframePort = channel.port2;
    const fromBridge = [];
    hostPort.onmessage = (e) => fromBridge.push(e.data);
    h.dispatchMessage({
      source: h.ctx.window.parent,
      data: { type: "port-handoff", sketch_id: "hb1" },
      ports: [iframePort],
    });
    await flush();
    // Tick the bridge's heartbeat interval.
    h.fireInterval(500);
    await flush();
    assert.ok(fromBridge.some((m) => m.type === "heartbeat"), "bridge did not emit heartbeat via port");
    // Critically: window.parent.postMessage should never have been called
    // (it isn't even used by the new bridge code path).
    assert.equal(h.postedToWindowParent.length, 0, "bridge still uses window.parent.postMessage — port transport not complete");
    h.teardown();
    hostPort.close();
  });

  // Loads the bridge source and installs it in a vm context that mirrors
  // a sandboxed iframe (no parent DOM access). Returns a harness with
  // helpers to dispatch messages and fire the heartbeat interval.
  async function loadBridgeHarness() {
    const vm = await import("node:vm");
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bridgeSrc = readFileSync(path.join(here, "p5_bridge.js"), "utf8");

    function vmBridgeHarness() {
      const listeners = [];
      const errorListeners = [];
      const postedToWindowParent = [];
      const intervals = [];
      let nextIntervalId = 1;
      const parentWindow = {
        postMessage: (...args) => postedToWindowParent.push(args),
      };
      const sandboxCtx = {
        window: {
          addEventListener(type, fn) {
            if (type === "message") listeners.push(fn);
            if (type === "error") errorListeners.push(fn);
          },
          removeEventListener(type, fn) {
            if (type === "message") {
              const i = listeners.indexOf(fn);
              if (i !== -1) listeners.splice(i, 1);
            }
            if (type === "error") {
              const i = errorListeners.indexOf(fn);
              if (i !== -1) errorListeners.splice(i, 1);
            }
          },
          parent: parentWindow,
          location: { href: "http://host.test:9000/p5/sandbox?sketch_id=b1&slot=localized" },
          features: undefined,
          __flb_frame_count: 0,
          __flb_last_frame_time_ms: 0,
        },
        document: {
          getElementById: () => ({ textContent: JSON.stringify("/* no-op sketch */") }),
        },
        setInterval: (fn /*, ms */) => {
          const id = nextIntervalId++;
          intervals.push({ id, fn });
          return id;
        },
        clearInterval: (id) => {
          const i = intervals.findIndex((x) => x.id === id);
          if (i !== -1) intervals.splice(i, 1);
        },
        URL,
        JSON,
      };
      // Proxy __flb_listeners onto the ctx so tests can inspect it.
      Object.defineProperty(sandboxCtx, "__flb_listeners", {
        get: () => listeners,
      });

      vm.createContext(sandboxCtx);
      vm.runInContext(bridgeSrc, sandboxCtx);

      return {
        ctx: sandboxCtx,
        postedToWindowParent,
        dispatchMessage(event) {
          for (const fn of [...listeners]) fn(event);
        },
        fireInterval(/* ms */) {
          for (const { fn } of [...intervals]) fn();
        },
        teardown() {
          if (typeof sandboxCtx.window.__flb_bridge_teardown === "function") {
            try { sandboxCtx.window.__flb_bridge_teardown(); } catch { /* ignore */ }
          }
        },
      };
    }

    return { vmBridgeHarness };
  }

  // Close every sandbox + stray test-owned port so open MessagePort
  // handles don't keep the event loop alive after the suite is done.
  for (const sb of allSandboxes) {
    try { sb.dispose(); } catch { /* best effort */ }
  }
  for (const port of allExtraPorts) {
    try { port.close?.(); } catch { /* best effort */ }
  }

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
