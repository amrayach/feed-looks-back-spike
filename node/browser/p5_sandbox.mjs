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

// Must match node/src/stage_server.mjs BG_SKETCH_KEY. Used as the
// sketch_id query param for background iframes until Fix 6 lands a
// real sketch_id on the sketch.background.set patch schema.
const BG_SANDBOX_SLOT_KEY = "__background__";

function buildSandboxSrc(sketchId, slot) {
  const params = new URLSearchParams({ sketch_id: sketchId, slot });
  return `/p5/sandbox?${params.toString()}`;
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
} = {}) {
  if (!mount) throw new Error("mount is required");

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
        retireInternal(sketchId, "heartbeat-timeout");
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
      const parsed = SandboxMessageSchema.safeParse(e?.data);
      if (!parsed.success) return; // drop silently
      // Find the sketch whose iframe contentWindow matches e.source.
      for (const entry of entries.values()) {
        if (entry.iframe.contentWindow === e.source) {
          if (parsed.data.type === "heartbeat") {
            entry.lastHeartbeat = now();
          } else if (parsed.data.type === "ready") {
            entry.ready = true;
            entry.lastHeartbeat = now();
          } else if (parsed.data.type === "error") {
            entry.lastHeartbeat = now(); // errors count as alive
            onSketchError({ sketch_id: entry.sketch_id, message: parsed.data.message });
          }
          return;
        }
      }
    };
    (documentLike.defaultView ?? globalThis).addEventListener("message", messageListener);
  }

  function uninstallMessageListener() {
    if (!messageListener) return;
    (documentLike.defaultView ?? globalThis).removeEventListener("message", messageListener);
    messageListener = null;
  }

  function mountInternal({ sketchId, urlSketchId, slot, styleCss }) {
    installMessageListener();
    subscribeToFeatures();

    // urlSketchId is the key the server uses to look up code in its
    // per-run sketchCodes map. For localized sketches it equals
    // sketchId (patch.sketch_id). For background it is BG_SANDBOX_SLOT_KEY
    // until Fix 6 adds sketch_id to the sketch.background.set patch
    // schema.
    const iframe = documentLike.createElement("iframe");
    iframe.dataset.sketchId = sketchId;
    iframe.dataset.sketchSlot = slot;
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.style = iframe.style ?? {};
    iframe.style.cssText = styleCss;
    // Server serves /p5/sandbox with an HTTP Content-Security-Policy
    // header. The old iframe csp= attribute is not a strong boundary
    // (browser support is partial), so we drop it here.
    iframe.src = buildSandboxSrc(urlSketchId, slot);

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
    if (!entry) return;
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
      urlSketchId: BG_SANDBOX_SLOT_KEY,
      slot: "background",
      styleCss,
    });
  }

  function mountLocalized({ sketch_id, position, size }) {
    if (entries.has(sketch_id)) retireInternal(sketch_id, "remount");
    const styleCss = `${positionToStyle(position, size)}; z-index: 10`;
    mountInternal({
      sketchId: sketch_id,
      urlSketchId: sketch_id,
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
    constructor() {
      this._listeners = new Map();
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
    dispatchMessage(source, data) {
      for (const fn of this._listeners.get("message") ?? []) fn({ source, data });
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
    // Background sketches use a fixed slot key in the URL until Fix 6.
    assert.match(iframe.src, /^\/p5\/sandbox\?sketch_id=__background__&slot=background$/);
    assert.equal(sandbox._entries.size, 1);
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

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
