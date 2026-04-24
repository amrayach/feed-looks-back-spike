// node/browser/p5_sandbox.mjs
// Host-side manager for sandboxed p5.js sketches. One instance per page;
// mounts iframes for background + up to 3 localized sketches, forwards
// feature_bus values into each iframe, watches heartbeats, retires on
// timeout. Iframe src points at the server's /p5/sandbox route, which
// returns an HTML shell with a server-enforced CSP header (see
// node/src/stage_server.mjs and node/browser/p5_bridge.js).
//
// Safety boundary (spec §7.3, post retroactive patches):
//   - sandbox="allow-scripts"  — no allow-same-origin, no network
//   - HTTP Content-Security-Policy header served by /p5/sandbox with
//     default-src 'none'; connect-src 'none'; frame-src 'none'; and
//     script-src 'self' 'unsafe-eval' (attribute CSP is not a strong
//     boundary so we no longer rely on it)
//   - heartbeat every 500 ms, kill on 2 s silence
//   - postMessage validation via Zod AND origin+source gate
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

const HeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  frame_count: z.number(),
  last_frame_time_ms: z.number(),
});
const ReadySchema = z.object({ type: z.literal("ready") });
const ErrorSchema = z.object({ type: z.literal("error"), message: z.string() });
const SandboxMessageSchema = z.discriminatedUnion("type", [HeartbeatSchema, ReadySchema, ErrorSchema]);

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 2000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 500;
const INITIAL_WARMUP_GRACE_MS = 3000;

function buildSandboxSrc(sketchId, slot) {
  const params = new URLSearchParams({ sketch_id: sketchId, slot });
  return `/p5/sandbox?${params.toString()}`;
}

// Default figurative fallback mounted when a sketch is retired because
// it crashed (heartbeat timeout or {type:"error"} postMessage). A still
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
  expectedOrigin = documentLike?.defaultView?.location?.origin ?? null,
  fallbackFactory,
} = {}) {
  if (!mount) throw new Error("mount is required");
  const factoryForFallback =
    fallbackFactory ?? ((ctx) => defaultFallbackFactory(documentLike, ctx));

  const entries = new Map(); // sketch_id → {iframe, slot, createdAt, lastHeartbeat, ready}
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
  let messageListener = null;

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
      if (!entry.ready) continue;
      try {
        entry.iframe.contentWindow?.postMessage({ type: "features", values: { ...featuresLatest } }, "*");
      } catch {
        // iframe may have been removed mid-tick
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

  function installMessageListener() {
    if (messageListener) return;
    messageListener = (e) => {
      // Origin gate: sandbox="allow-scripts" WITHOUT allow-same-origin
      // gives the iframe an opaque document origin, so event.origin is
      // the string "null" on the parent side. If a same-origin frame
      // somehow posts (e.g., future allow-same-origin flag flip), accept
      // only the expected parent origin. Everything else is a foreign
      // origin — drop before Zod parsing to keep costs proportional.
      if (e?.origin !== "null" && e?.origin !== expectedOrigin) return;
      // Source gate: only accept messages whose source is a currently
      // tracked iframe's contentWindow. Foreign windows cannot forge
      // event.source because the browser sets it to the real sender.
      let sourceEntry = null;
      for (const entry of entries.values()) {
        if (entry.iframe.contentWindow === e.source) {
          sourceEntry = entry;
          break;
        }
      }
      if (!sourceEntry) return;
      const parsed = SandboxMessageSchema.safeParse(e?.data);
      if (!parsed.success) return; // drop silently
      if (parsed.data.type === "heartbeat") {
        sourceEntry.lastHeartbeat = now();
      } else if (parsed.data.type === "ready") {
        sourceEntry.ready = true;
        sourceEntry.lastHeartbeat = now();
      } else if (parsed.data.type === "error") {
        // A sketch that throws is dead weight — don't wait for the
        // heartbeat watchdog. Fire onSketchError first (caller may
        // log it), then retire and replace with a figurative DOM
        // fallback so the slot isn't left blank.
        onSketchError({ sketch_id: sourceEntry.sketch_id, message: parsed.data.message });
        retireAndReplace(sourceEntry.sketch_id, "sketch-error");
      }
    };
    (documentLike.defaultView ?? globalThis).addEventListener("message", messageListener);
  }

  function uninstallMessageListener() {
    if (!messageListener) return;
    (documentLike.defaultView ?? globalThis).removeEventListener("message", messageListener);
    messageListener = null;
  }

  function mountInternal({ sketchId, slot, styleCss }) {
    installMessageListener();
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

    mount.appendChild(iframe);

    entries.set(sketchId, {
      sketch_id: sketchId,
      iframe,
      slot,
      createdAt: now(),
      lastHeartbeat: now(),
      ready: false,
    });

    startRafIfNeeded();
    startWatchdogIfNeeded();
  }

  function retireInternal(sketchId, reason = "retire") {
    const entry = entries.get(sketchId);
    if (!entry) return null;
    try {
      entry.iframe.remove();
    } catch { /* best effort */ }
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
  // {type:"error"} postMessage from the bridge. Retires the iframe
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
    uninstallMessageListener();
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
      this.contentWindow = { postMessage: () => {} };
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
    constructor({ origin = "http://host.test:9000" } = {}) {
      this._listeners = new Map();
      this.location = { origin, href: `${origin}/stage.html` };
    }
    addEventListener(type, fn) {
      const list = this._listeners.get(type) ?? [];
      list.push(fn);
      this._listeners.set(type, list);
    }
    removeEventListener(type, fn) {
      const list = this._listeners.get(type) ?? [];
      this._listeners.set(type, list.filter((x) => x !== fn));
    }
    // Default origin "null" simulates the real behavior of a sandboxed
    // iframe WITHOUT allow-same-origin: its document origin is opaque
    // and event.origin shows up as the literal string "null" on the
    // parent side. Tests that want to simulate a foreign origin pass
    // one explicitly.
    dispatchMessage(source, data, origin = "null") {
      for (const fn of this._listeners.get("message") ?? []) fn({ source, data, origin });
    }
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
    });
    return { sandbox, documentLike, mount, bus, raf, interval };
  }

  await t("mountBackground creates an iframe with sandbox='allow-scripts' and src pointing at /p5/sandbox", () => {
    const { sandbox, mount } = makeSandbox();
    sandbox.mountBackground({ sketch_id: "sketch_0001" });
    assert.equal(mount.children.length, 1);
    const iframe = mount.children[0];
    assert.equal(iframe.getAttribute("sandbox"), "allow-scripts");
    // csp= attribute is intentionally NOT set — HTTP CSP header served by
    // /p5/sandbox replaces it (attribute CSP is a weak boundary).
    assert.equal(iframe.getAttribute("csp"), undefined);
    // srcdoc is no longer used — iframe loads over HTTP so origin checks work.
    assert.equal(iframe.srcdoc, undefined);
    // Background and localized sketches share one id namespace — the URL
    // sketch_id matches the patch's sketch_id in both cases.
    assert.match(iframe.src, /^\/p5\/sandbox\?sketch_id=sketch_0001&slot=background$/);
    assert.equal(sandbox._entries.size, 1);
  });

  await t("two consecutive mountBackground + explicit retire → exactly one iframe (Fix 6)", () => {
    const { sandbox, mount } = makeSandbox();
    // First set: mounts sketch_bg_old.
    sandbox.mountBackground({ sketch_id: "sketch_bg_old" });
    assert.equal(mount.children.length, 1);
    assert.match(mount.children[0].src, /sketch_id=sketch_bg_old&slot=background/);
    // Producer-side behavior: retire the old, then set the new. The
    // retire targets the server-known id (not a host-synthesized one),
    // which Fix 6 guarantees end-to-end.
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
    // Localized sketches key by the patch's sketch_id directly.
    assert.match(iframe.src, /^\/p5\/sandbox\?sketch_id=sketch_a&slot=localized$/);
    // No allow-same-origin regression.
    assert.doesNotMatch(iframe.getAttribute("sandbox") ?? "", /allow-same-origin/);
  });

  await t("feature dispatch populates featuresLatest and forwards on rAF tick", () => {
    const { sandbox, documentLike, mount, bus, raf } = makeSandbox();
    const postedMessages = [];
    sandbox.mountLocalized({ sketch_id: "sketch_b", position: "center", size: "medium" });
    const iframe = mount.children[0];
    iframe.contentWindow.postMessage = (data) => postedMessages.push(data);
    // Mark ready so forwardFeaturesTick will post.
    documentLike.defaultView.dispatchMessage(iframe.contentWindow, { type: "ready" });
    bus.dispatch("amplitude", 0.5);
    bus.dispatch("hijaz_state", "arrived");
    raf.tick();
    const last = postedMessages[postedMessages.length - 1];
    assert.equal(last.type, "features");
    assert.equal(last.values.amplitude, 0.5);
    assert.equal(last.values.hijaz_state, "arrived");
  });

  await t("heartbeat message updates lastHeartbeat", () => {
    let clock = 100;
    const { sandbox, documentLike, mount } = makeSandbox({ now: () => clock });
    sandbox.mountLocalized({ sketch_id: "sketch_c", position: "center", size: "small" });
    const iframe = mount.children[0];
    clock = 500;
    documentLike.defaultView.dispatchMessage(iframe.contentWindow, { type: "heartbeat", frame_count: 30, last_frame_time_ms: 16.7 });
    const entry = sandbox._entries.get("sketch_c");
    assert.equal(entry.lastHeartbeat, 500);
  });

  await t("no heartbeat past warmup + timeout retires the sketch (watchdog fires)", () => {
    const retired = [];
    let clock = 100;
    const { sandbox, interval } = makeSandbox({
      now: () => clock,
      heartbeatTimeoutMs: 2000,
      warmupGraceMs: 3000,
      onRetire: (info) => retired.push(info),
    });
    sandbox.mountLocalized({ sketch_id: "sketch_d", position: "center", size: "small" });
    // Still inside warmup grace — tick the watchdog, no retirement yet.
    clock = 3000;
    interval.tick();
    assert.equal(sandbox._entries.size, 1);
    // Past warmup AND heartbeat timeout: retire.
    clock = 100 + 3001 + 2001;
    interval.tick();
    assert.equal(sandbox._entries.size, 0);
    assert.equal(retired.length, 1);
    assert.equal(retired[0].sketch_id, "sketch_d");
    assert.equal(retired[0].reason, "heartbeat-timeout");
  });

  await t("retireSketch removes iframe and fires onRetire with 'retire'", () => {
    const retired = [];
    const { sandbox, mount } = makeSandbox({ onRetire: (info) => retired.push(info) });
    sandbox.mountLocalized({ sketch_id: "sketch_e", position: "center", size: "medium" });
    sandbox.retireSketch("sketch_e");
    assert.equal(mount.children.length, 0);
    assert.equal(retired[0].reason, "retire");
  });

  await t("invalid postMessage shape is dropped silently (no crash, no heartbeat update)", () => {
    let clock = 0;
    const { sandbox, documentLike, mount } = makeSandbox({ now: () => clock });
    sandbox.mountLocalized({ sketch_id: "sketch_f", position: "center", size: "small" });
    const iframe = mount.children[0];
    const entry = sandbox._entries.get("sketch_f");
    const before = entry.lastHeartbeat;
    documentLike.defaultView.dispatchMessage(iframe.contentWindow, { type: "garbage", something: 1 });
    assert.equal(entry.lastHeartbeat, before);
  });

  await t("dispose tears down iframes, watchdog, rAF, and message listener", () => {
    const { sandbox, mount, raf, interval } = makeSandbox();
    sandbox.mountLocalized({ sketch_id: "s1", position: "center", size: "small" });
    sandbox.mountLocalized({ sketch_id: "s2", position: "top-left", size: "small" });
    sandbox.dispose();
    assert.equal(sandbox._entries.size, 0);
    assert.equal(mount.children.length, 0);
    assert.equal(raf.pending(), 0);
    assert.equal(interval.pending(), 0);
  });

  await t("ready message marks entry ready; unready entries don't receive feature messages", () => {
    const { sandbox, documentLike, mount, bus, raf } = makeSandbox();
    const postedToA = [];
    const postedToB = [];
    sandbox.mountLocalized({ sketch_id: "a", position: "center", size: "small" });
    sandbox.mountLocalized({ sketch_id: "b", position: "top-left", size: "small" });
    const iframeA = mount.children[0];
    const iframeB = mount.children[1];
    iframeA.contentWindow.postMessage = (data) => postedToA.push(data);
    iframeB.contentWindow.postMessage = (data) => postedToB.push(data);
    documentLike.defaultView.dispatchMessage(iframeA.contentWindow, { type: "ready" });
    bus.dispatch("amplitude", 0.7);
    raf.tick();
    assert.ok(postedToA.some((m) => m.type === "features" && m.values.amplitude === 0.7));
    assert.equal(postedToB.length, 0); // b is not ready yet — no feature post
  });

  await t("remount with same sketch_id tears down prior entry and re-issues src", () => {
    const { sandbox, mount } = makeSandbox();
    sandbox.mountLocalized({ sketch_id: "r1", position: "center", size: "small" });
    sandbox.mountLocalized({ sketch_id: "r1", position: "top-left", size: "small" });
    assert.equal(sandbox._entries.size, 1);
    assert.equal(mount.children.length, 1);
    assert.match(mount.children[0].src, /^\/p5\/sandbox\?sketch_id=r1&slot=localized$/);
  });

  await t("{type:'error'} postMessage retires the iframe AND mounts a figurative DOM fallback", () => {
    const retired = [];
    const errors = [];
    const { sandbox, documentLike, mount } = makeSandbox({
      onRetire: (info) => retired.push(info),
      onSketchError: (info) => errors.push(info),
    });
    sandbox.mountLocalized({ sketch_id: "boom_1", position: "center", size: "small" });
    assert.equal(mount.children.length, 1);
    const iframe = mount.children[0];
    documentLike.defaultView.dispatchMessage(
      iframe.contentWindow,
      { type: "error", message: "TypeError: p is not defined" },
    );
    // Iframe removed; a fallback SVG motif appears in the same slot.
    assert.equal(sandbox._entries.size, 0);
    assert.equal(mount.children.length, 1);
    const fallback = mount.children[0];
    assert.equal(fallback.dataset.flbSketchFallback, "1");
    assert.equal(fallback.dataset.flbFallbackReason, "sketch-error");
    assert.ok(/candle flame/.test(fallback.innerHTML || ""), "fallback should be figurative (candle flame)");
    // onSketchError fires; onRetire fires with the crash reason.
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "TypeError: p is not defined");
    assert.equal(retired.length, 1);
    assert.equal(retired[0].reason, "sketch-error");
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
    // Fallback mounted with the heartbeat-timeout reason.
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
    // No fallback: the author retired by intent, not because of a crash.
    assert.equal(mount.children.length, 0);
  });

  await t("foreign origin is dropped without updating heartbeat (Fix 1 gate)", () => {
    let clock = 100;
    const { sandbox, documentLike, mount } = makeSandbox({ now: () => clock });
    sandbox.mountLocalized({ sketch_id: "o1", position: "center", size: "small" });
    const iframe = mount.children[0];
    const entry = sandbox._entries.get("o1");
    const before = entry.lastHeartbeat;
    clock = 9999;
    // Well-formed heartbeat, but delivered with a foreign origin:
    // should be dropped before the Zod parse even runs.
    documentLike.defaultView.dispatchMessage(
      iframe.contentWindow,
      { type: "heartbeat", frame_count: 1, last_frame_time_ms: 16.7 },
      "https://evil.example.com",
    );
    assert.equal(entry.lastHeartbeat, before);
    assert.equal(entry.ready, false);
  });

  await t("non-iframe source (origin='null') is dropped without matching any entry", () => {
    let clock = 100;
    const { sandbox, documentLike } = makeSandbox({ now: () => clock });
    sandbox.mountLocalized({ sketch_id: "s1", position: "center", size: "small" });
    const entry = sandbox._entries.get("s1");
    const before = entry.lastHeartbeat;
    clock = 9999;
    // A well-formed heartbeat with the correct opaque origin but a
    // source that isn't any tracked iframe's contentWindow — forged
    // event.source is not actually forgeable in a real browser, but
    // we still defend against a stale/leaked window reference.
    const strangerWindow = { postMessage: () => {} };
    documentLike.defaultView.dispatchMessage(
      strangerWindow,
      { type: "heartbeat", frame_count: 1, last_frame_time_ms: 16.7 },
      "null",
    );
    assert.equal(entry.lastHeartbeat, before);
    assert.equal(entry.ready, false);
  });

  await t("expected parent origin (non-null) is accepted when iframe somehow has a named origin", () => {
    let clock = 100;
    const { sandbox, documentLike, mount } = makeSandbox({ now: () => clock });
    sandbox.mountLocalized({ sketch_id: "p1", position: "center", size: "small" });
    const iframe = mount.children[0];
    const entry = sandbox._entries.get("p1");
    clock = 500;
    // Fallback path: if a future flag flip grants the iframe a named
    // origin (e.g., allow-same-origin added), origin will equal the
    // parent's origin. The gate accepts that case too.
    documentLike.defaultView.dispatchMessage(
      iframe.contentWindow,
      { type: "heartbeat", frame_count: 1, last_frame_time_ms: 16.7 },
      "http://host.test:9000",
    );
    assert.equal(entry.lastHeartbeat, 500);
  });

  await t("bridge rejects foreign-origin inbound messages (p5_bridge.js harness)", async () => {
    // Execute the bridge in a VM context with stubbed globals, post a
    // foreign-origin message, assert window.features stays unchanged.
    const vm = await import("node:vm");
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bridgeSrc = readFileSync(path.join(here, "p5_bridge.js"), "utf8");

    const postedToParent = [];
    const listeners = [];
    const sandboxCtx = {
      __flb_listeners: listeners,
      __flb_postedToParent: postedToParent,
    };
    sandboxCtx.window = {
      addEventListener(type, fn) { if (type === "message") listeners.push(fn); },
      removeEventListener() {},
      parent: { postMessage: (msg /* , targetOrigin */) => postedToParent.push(msg) },
      location: { href: "http://host.test:9000/p5/sandbox?sketch_id=b1&slot=localized" },
      features: undefined,
      __flb_frame_count: 0,
      __flb_last_frame_time_ms: 0,
    };
    sandboxCtx.document = {
      getElementById: () => ({ textContent: JSON.stringify("/* no-op sketch */") }),
    };
    sandboxCtx.setInterval = () => 0;
    sandboxCtx.URL = URL;
    sandboxCtx.JSON = JSON;

    vm.createContext(sandboxCtx);
    vm.runInContext(bridgeSrc, sandboxCtx);

    // Bridge should have installed a message listener AND posted 'ready'.
    assert.equal(listeners.length, 1);
    assert.ok(postedToParent.some((m) => m.type === "ready"), "bridge did not post ready");

    // Parent posts a features frame from the expected origin — should mirror.
    listeners[0]({
      source: sandboxCtx.window.parent,
      origin: "http://host.test:9000",
      data: { type: "features", values: { amplitude: 0.42 } },
    });
    assert.equal(sandboxCtx.window.features.amplitude, 0.42);

    // A foreign origin posts a features frame — bridge must drop it.
    listeners[0]({
      source: sandboxCtx.window.parent,
      origin: "https://evil.example.com",
      data: { type: "features", values: { amplitude: 9.99 } },
    });
    assert.equal(sandboxCtx.window.features.amplitude, 0.42, "bridge accepted foreign-origin message");

    // A non-parent source with the right origin — bridge must drop it too.
    listeners[0]({
      source: { /* some other window */ },
      origin: "http://host.test:9000",
      data: { type: "features", values: { amplitude: 7.77 } },
    });
    assert.equal(sandboxCtx.window.features.amplitude, 0.42, "bridge accepted non-parent source");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
