// node/browser/p5_sandbox.mjs
// Host-side manager for sandboxed p5.js sketches. One instance per page;
// mounts iframes for background + up to 3 localized sketches, forwards
// feature_bus values into each iframe, watches heartbeats, retires on
// timeout. Iframe srcdoc is built here from an inlined template + p5
// source (fetched once from /vendor/p5/p5.min.js) + user sketch code.
//
// Safety boundary (spec §7.3):
//   - sandbox="allow-scripts"  — no allow-same-origin, no network
//   - csp="default-src 'none'; script-src 'unsafe-inline'; img-src blob: data:"
//   - heartbeat every 500 ms, kill on 2 s silence
//   - postMessage validation via Zod
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

// Template — inlined rather than fetched so we ship one file for the whole
// sandbox host. __P5_SOURCE__ and __USER_SKETCH__ are split into literal
// sentinels (not comments) so a sketch author's accidental regex can't
// collide with the template placeholders.
const IFRAME_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;}canvas{display:block;}</style>
</head>
<body>
<script>/*__FLB_P5_SOURCE__*/</script>
<script>
window.features = {
  amplitude: 0, onset_strength: 0, spectral_centroid: 0,
  hijaz_state: "unknown", hijaz_intensity: 0, hijaz_tahwil: false
};
window.__flb_frame_count = 0;
window.__flb_last_frame_time_ms = 0;
window.addEventListener("message", function(e){
  if (!e.data || typeof e.data !== "object") return;
  if (e.data.type === "features" && e.data.values && typeof e.data.values === "object") {
    Object.assign(window.features, e.data.values);
  }
});
function __flb_post_ready(){try{window.parent.postMessage({type:"ready"},"*");}catch(err){}}
function __flb_post_heartbeat(){try{window.parent.postMessage({type:"heartbeat",frame_count:window.__flb_frame_count,last_frame_time_ms:window.__flb_last_frame_time_ms},"*");}catch(err){}}
function __flb_post_error(msg){try{window.parent.postMessage({type:"error",message:String(msg).slice(0,500)},"*");}catch(err){}}
setInterval(__flb_post_heartbeat, 500);
window.addEventListener("error", function(e){__flb_post_error(e && e.message ? e.message : "sketch error");});
__flb_post_ready();
</script>
<script>
try {
/*__FLB_USER_SKETCH__*/
} catch (err) { __flb_post_error(err && err.message ? err.message : "sketch runtime error"); }
</script>
</body>
</html>`;

export function buildSketchSrcdoc(p5Source, userSketch) {
  return IFRAME_TEMPLATE
    .replace("/*__FLB_P5_SOURCE__*/", String(p5Source ?? ""))
    .replace("/*__FLB_USER_SKETCH__*/", String(userSketch ?? ""));
}

export function createP5Sandbox({
  documentLike = globalThis.document,
  mount,
  bus,
  fetchImpl = globalThis.fetch,
  rafImpl = globalThis.requestAnimationFrame,
  cancelRafImpl = globalThis.cancelAnimationFrame,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
  now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  p5SourceOverride = null, // for tests
  heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
  warmupGraceMs = INITIAL_WARMUP_GRACE_MS,
  onRetire = () => {},
  onSketchError = () => {},
} = {}) {
  if (!mount) throw new Error("mount is required");

  const entries = new Map(); // sketch_id → {iframe, slot, createdAt, lastHeartbeat, ready}
  let p5SourceCache = p5SourceOverride;
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

  async function ensureP5Source() {
    if (p5SourceCache != null) return p5SourceCache;
    const res = await fetchImpl("/vendor/p5/p5.min.js");
    if (!res || !res.ok) throw new Error(`p5.min.js fetch failed: ${res?.status ?? "unknown"}`);
    p5SourceCache = await res.text();
    return p5SourceCache;
  }

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

  async function mountInternal({ sketchId, code, slot, styleCss }) {
    installMessageListener();
    subscribeToFeatures();

    const p5Source = await ensureP5Source();
    const srcdoc = buildSketchSrcdoc(p5Source, code);

    const iframe = documentLike.createElement("iframe");
    iframe.dataset.sketchId = sketchId;
    iframe.dataset.sketchSlot = slot;
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("csp", "default-src 'none'; script-src 'unsafe-inline'; img-src blob: data:");
    iframe.style = iframe.style ?? {};
    iframe.style.cssText = styleCss;
    iframe.srcdoc = srcdoc;

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

  async function mountBackground({ sketch_id, code }) {
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
    await mountInternal({ sketchId: sketch_id, code, slot: "background", styleCss });
  }

  async function mountLocalized({ sketch_id, position, size, code }) {
    if (entries.has(sketch_id)) retireInternal(sketch_id, "remount");
    const styleCss = `${positionToStyle(position, size)}; z-index: 10`;
    await mountInternal({ sketchId: sketch_id, code, slot: "localized", styleCss });
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
    _setP5SourceCache: (s) => { p5SourceCache = s; },
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
      this.srcdoc = null;
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

  await t("buildSketchSrcdoc inlines p5 source and user code into the template", () => {
    const html = buildSketchSrcdoc("P5_SRC_MARKER", "function draw(){background(0);}");
    assert.match(html, /P5_SRC_MARKER/);
    assert.match(html, /function draw\(\)\{background\(0\);\}/);
    // Bridge is in place:
    assert.match(html, /window\.features\s*=/);
    assert.match(html, /postMessage.*heartbeat/);
    // Placeholders are fully substituted:
    assert.doesNotMatch(html, /__FLB_P5_SOURCE__/);
    assert.doesNotMatch(html, /__FLB_USER_SKETCH__/);
  });

  await t("mountBackground creates a sandboxed iframe with the expected attributes", async () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const bus = createFeatureBus();
    const raf = rafRunner();
    const interval = intervalRunner();
    const sandbox = createP5Sandbox({
      documentLike,
      mount,
      bus,
      fetchImpl: async () => ({ ok: true, text: async () => "P5_MOCK" }),
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      setIntervalImpl: interval.set,
      clearIntervalImpl: interval.clear,
      now: () => 1000,
    });
    await sandbox.mountBackground({ sketch_id: "sketch_0001", code: "noop();" });
    assert.equal(mount.children.length, 1);
    const iframe = mount.children[0];
    assert.equal(iframe.getAttribute("sandbox"), "allow-scripts");
    assert.match(iframe.getAttribute("csp"), /default-src 'none'/);
    assert.match(iframe.srcdoc, /P5_MOCK/);
    assert.match(iframe.srcdoc, /noop\(\);/);
    assert.equal(sandbox._entries.size, 1);
  });

  await t("mountLocalized positions the iframe according to position + size", async () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const bus = createFeatureBus();
    const raf = rafRunner();
    const interval = intervalRunner();
    const sandbox = createP5Sandbox({
      documentLike,
      mount,
      bus,
      fetchImpl: async () => ({ ok: true, text: async () => "P5_MOCK" }),
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      setIntervalImpl: interval.set,
      clearIntervalImpl: interval.clear,
    });
    await sandbox.mountLocalized({ sketch_id: "sketch_a", position: "top-right", size: "small", code: "" });
    const iframe = mount.children[0];
    assert.match(iframe.style.cssText, /width: 300px/);
    assert.match(iframe.style.cssText, /height: 300px/);
    assert.match(iframe.style.cssText, /top: 0%/);
    assert.match(iframe.style.cssText, /right: 0%/);
  });

  await t("feature dispatch populates featuresLatest and forwards on rAF tick", async () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const bus = createFeatureBus();
    const raf = rafRunner();
    const interval = intervalRunner();
    const postedMessages = [];
    const sandbox = createP5Sandbox({
      documentLike,
      mount,
      bus,
      fetchImpl: async () => ({ ok: true, text: async () => "P5_MOCK" }),
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      setIntervalImpl: interval.set,
      clearIntervalImpl: interval.clear,
    });
    await sandbox.mountLocalized({ sketch_id: "sketch_b", position: "center", size: "medium", code: "" });
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

  await t("heartbeat message updates lastHeartbeat", async () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const bus = createFeatureBus();
    const raf = rafRunner();
    const interval = intervalRunner();
    let clock = 0;
    const sandbox = createP5Sandbox({
      documentLike,
      mount,
      bus,
      fetchImpl: async () => ({ ok: true, text: async () => "P5_MOCK" }),
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      setIntervalImpl: interval.set,
      clearIntervalImpl: interval.clear,
      now: () => clock,
    });
    clock = 100;
    await sandbox.mountLocalized({ sketch_id: "sketch_c", position: "center", size: "small", code: "" });
    const iframe = mount.children[0];
    clock = 500;
    documentLike.defaultView.dispatchMessage(iframe.contentWindow, { type: "heartbeat", frame_count: 30, last_frame_time_ms: 16.7 });
    const entry = sandbox._entries.get("sketch_c");
    assert.equal(entry.lastHeartbeat, 500);
  });

  await t("no heartbeat past warmup + timeout retires the sketch (watchdog fires)", async () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const bus = createFeatureBus();
    const raf = rafRunner();
    const interval = intervalRunner();
    const retired = [];
    let clock = 0;
    const sandbox = createP5Sandbox({
      documentLike,
      mount,
      bus,
      fetchImpl: async () => ({ ok: true, text: async () => "P5_MOCK" }),
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      setIntervalImpl: interval.set,
      clearIntervalImpl: interval.clear,
      now: () => clock,
      heartbeatTimeoutMs: 2000,
      warmupGraceMs: 3000,
      onRetire: (info) => retired.push(info),
    });
    clock = 100;
    await sandbox.mountLocalized({ sketch_id: "sketch_d", position: "center", size: "small", code: "" });
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

  await t("retireSketch removes iframe and fires onRetire with 'retire'", async () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const bus = createFeatureBus();
    const raf = rafRunner();
    const interval = intervalRunner();
    const retired = [];
    const sandbox = createP5Sandbox({
      documentLike,
      mount,
      bus,
      fetchImpl: async () => ({ ok: true, text: async () => "P5_MOCK" }),
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      setIntervalImpl: interval.set,
      clearIntervalImpl: interval.clear,
      onRetire: (info) => retired.push(info),
    });
    await sandbox.mountLocalized({ sketch_id: "sketch_e", position: "center", size: "medium", code: "" });
    sandbox.retireSketch("sketch_e");
    assert.equal(mount.children.length, 0);
    assert.equal(retired[0].reason, "retire");
  });

  await t("invalid postMessage shape is dropped silently (no crash, no heartbeat update)", async () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const bus = createFeatureBus();
    const raf = rafRunner();
    const interval = intervalRunner();
    let clock = 0;
    const sandbox = createP5Sandbox({
      documentLike, mount, bus,
      fetchImpl: async () => ({ ok: true, text: async () => "P5_MOCK" }),
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      setIntervalImpl: interval.set,
      clearIntervalImpl: interval.clear,
      now: () => clock,
    });
    clock = 0;
    await sandbox.mountLocalized({ sketch_id: "sketch_f", position: "center", size: "small", code: "" });
    const iframe = mount.children[0];
    const entry = sandbox._entries.get("sketch_f");
    const before = entry.lastHeartbeat;
    documentLike.defaultView.dispatchMessage(iframe.contentWindow, { type: "garbage", something: 1 });
    assert.equal(entry.lastHeartbeat, before);
  });

  await t("dispose tears down iframes, watchdog, rAF, and message listener", async () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const bus = createFeatureBus();
    const raf = rafRunner();
    const interval = intervalRunner();
    const sandbox = createP5Sandbox({
      documentLike, mount, bus,
      fetchImpl: async () => ({ ok: true, text: async () => "P5_MOCK" }),
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      setIntervalImpl: interval.set,
      clearIntervalImpl: interval.clear,
    });
    await sandbox.mountLocalized({ sketch_id: "s1", position: "center", size: "small", code: "" });
    await sandbox.mountLocalized({ sketch_id: "s2", position: "top-left", size: "small", code: "" });
    sandbox.dispose();
    assert.equal(sandbox._entries.size, 0);
    assert.equal(mount.children.length, 0);
    assert.equal(raf.pending(), 0);
    assert.equal(interval.pending(), 0);
  });

  await t("ready message marks entry ready; unready entries don't receive feature messages", async () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const bus = createFeatureBus();
    const raf = rafRunner();
    const interval = intervalRunner();
    const sandbox = createP5Sandbox({
      documentLike, mount, bus,
      fetchImpl: async () => ({ ok: true, text: async () => "P5_MOCK" }),
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      setIntervalImpl: interval.set,
      clearIntervalImpl: interval.clear,
    });
    const postedToA = [];
    const postedToB = [];
    await sandbox.mountLocalized({ sketch_id: "a", position: "center", size: "small", code: "" });
    await sandbox.mountLocalized({ sketch_id: "b", position: "top-left", size: "small", code: "" });
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

  await t("remount with same sketch_id tears down prior entry", async () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const bus = createFeatureBus();
    const raf = rafRunner();
    const interval = intervalRunner();
    const sandbox = createP5Sandbox({
      documentLike, mount, bus,
      fetchImpl: async () => ({ ok: true, text: async () => "P5_MOCK" }),
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      setIntervalImpl: interval.set,
      clearIntervalImpl: interval.clear,
    });
    await sandbox.mountLocalized({ sketch_id: "r1", position: "center", size: "small", code: "A" });
    await sandbox.mountLocalized({ sketch_id: "r1", position: "top-left", size: "small", code: "B" });
    assert.equal(sandbox._entries.size, 1);
    assert.equal(mount.children.length, 1);
    assert.match(mount.children[0].srcdoc, /B/);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
