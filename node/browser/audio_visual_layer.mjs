// Always-on audio-reactive visual bed for the live stage.
//
// This layer is deliberately independent from Opus tool calls: it reads the
// feature bus (and, when available, a browser AudioContext analyser for the
// stage audio element) so the stage keeps breathing while API cycles are in
// flight. It stays behind authored elements and sketches.

const FEATURE_NAMES = [
  "amplitude",
  "onset_strength",
  "spectral_centroid",
  "hijaz_state",
  "hijaz_intensity",
  "hijaz_tahwil",
];

const VALID_STATES = new Set(["quiet", "approach", "arrived", "tahwil", "aug2"]);
const NON_COMMAND_PATCH_TYPES = new Set(["cycle.begin", "cycle.end", "replay.begin", "replay.end"]);

const PALETTES = Object.freeze({
  quiet: Object.freeze({
    base: [16, 20, 30],
    warm: [204, 152, 82],
    cool: [64, 121, 139],
    accent: [232, 205, 150],
  }),
  approach: Object.freeze({
    base: [18, 17, 24],
    warm: [217, 130, 76],
    cool: [56, 151, 154],
    accent: [232, 190, 119],
  }),
  arrived: Object.freeze({
    base: [20, 17, 15],
    warm: [230, 184, 95],
    cool: [86, 150, 135],
    accent: [246, 220, 160],
  }),
  tahwil: Object.freeze({
    base: [12, 18, 26],
    warm: [219, 165, 88],
    cool: [77, 166, 190],
    accent: [226, 223, 184],
  }),
  aug2: Object.freeze({
    base: [22, 15, 25],
    warm: [208, 109, 100],
    cool: [83, 139, 190],
    accent: [232, 185, 147],
  }),
});

function clamp01(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function smooth(current, target, factor) {
  return current + (target - current) * clamp01(factor);
}

function rgba(rgb, alpha) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`;
}

function hashString(input) {
  const str = String(input ?? "");
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizedFromHash(seed, offset) {
  const byte = (seed >>> offset) & 0xff;
  return byte / 255;
}

export function isCommandPatch(patch) {
  return Boolean(patch?.type && !NON_COMMAND_PATCH_TYPES.has(patch.type));
}

export function createCommandPulse(patch, startedAtS = 0, { reducedMotion = false } = {}) {
  if (!isCommandPatch(patch)) return null;
  const key = patch.element_id ?? patch.element?.element_id ?? patch.group_id ?? patch.sketch_id ?? patch.type;
  const seed = hashString(`${patch.type}:${key}`);
  const strengthByType = {
    "background.set": 0.95,
    "sketch.background.set": 1,
    "scene.pulse": 1.15,
    "scene.palette_shift": 0.95,
    "element.add": 0.85,
    "composition_group.add": 0.9,
    "element.morph": 0.9,
    "element.transform": 0.72,
    "text.animate": 0.72,
    "element.fade": 0.62,
    "composition_group.fade": 0.64,
    "element.remove": 0.5,
    "sketch.retire": 0.5,
  };
  const sceneWide = patch.type?.startsWith("scene.") || patch.type === "background.set" || patch.type === "sketch.background.set";
  return {
    patchType: patch.type,
    startedAtS,
    durationS: reducedMotion ? 0.48 : 1.22,
    strength: reducedMotion ? 0.38 : strengthByType[patch.type] ?? 0.68,
    nx: sceneWide ? 0.5 : 0.18 + normalizedFromHash(seed, 0) * 0.64,
    ny: sceneWide ? 0.52 : 0.22 + normalizedFromHash(seed, 8) * 0.58,
    sceneWide,
  };
}

export function deriveAudioFeaturesFromFrequencyBins(bytes) {
  if (!bytes || bytes.length === 0) {
    return { amplitude: 0, onset_strength: 0, spectral_centroid: 0 };
  }
  let sum = 0;
  let weighted = 0;
  let high = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const v = bytes[i] / 255;
    sum += v;
    weighted += v * i;
    if (i > bytes.length * 0.62) high += v;
  }
  const amplitude = clamp01((sum / bytes.length) * 2.15);
  const centroidRatio = sum > 0 ? weighted / sum / Math.max(1, bytes.length - 1) : 0;
  const spectral_centroid = Math.round(180 + centroidRatio * 3600);
  const onset_strength = clamp01((high / Math.max(1, bytes.length * 0.38)) * 1.45);
  return { amplitude, onset_strength, spectral_centroid };
}

export function computeVisualFrame(rawFeatures = {}, previous = {}, options = {}) {
  const state = VALID_STATES.has(rawFeatures.hijaz_state) ? rawFeatures.hijaz_state : "quiet";
  const palette = PALETTES[state] ?? PALETTES.quiet;
  const reducedMotion = Boolean(options.reducedMotion);
  const targetAmplitude = clamp01(rawFeatures.amplitude);
  const targetOnset = clamp01(rawFeatures.onset_strength);
  const targetIntensity = clamp01(rawFeatures.hijaz_intensity);
  const targetCentroid = clamp01((Number(rawFeatures.spectral_centroid) || 0) / 4200);
  const impulse = rawFeatures.hijaz_tahwil === true ? 1 : 0;
  const smoothing = reducedMotion ? 0.04 : 0.16;

  const amplitude = smooth(previous.amplitude ?? 0, targetAmplitude, smoothing);
  const onset = smooth(previous.onset ?? 0, Math.max(targetOnset, impulse), reducedMotion ? 0.08 : 0.34);
  const intensity = smooth(previous.intensity ?? 0, targetIntensity, smoothing);
  const centroid = smooth(previous.centroid ?? 0.25, targetCentroid, smoothing);

  return {
    state,
    palette,
    amplitude,
    onset,
    intensity,
    centroid,
    energy: clamp01(amplitude * 0.68 + intensity * 0.42 + onset * 0.28),
    drift: reducedMotion ? 0.08 : 0.45 + centroid * 0.9,
  };
}

function resizeCanvas(canvas, ctx, windowLike) {
  const rect = canvas.getBoundingClientRect?.() ?? { width: 0, height: 0 };
  const dpr = Math.max(1, Math.min(2, windowLike?.devicePixelRatio || 1));
  const width = Math.max(1, Math.floor((rect.width || canvas.clientWidth || 1) * dpr));
  const height = Math.max(1, Math.floor((rect.height || canvas.clientHeight || 1) * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: width / dpr, height: height / dpr, dpr };
}

function drawCommandPulses(ctx, width, height, frame, timeS, commandPulses) {
  if (!commandPulses?.length) return;
  const { palette } = frame;
  ctx.globalCompositeOperation = "screen";
  for (const pulse of commandPulses) {
    const age = Math.max(0, timeS - pulse.startedAtS);
    const t = clamp01(age / Math.max(0.001, pulse.durationS));
    if (t >= 1) continue;
    const easeOut = 1 - (1 - t) * (1 - t);
    const alpha = (1 - t) * (1 - t) * pulse.strength;
    const x = width * pulse.nx;
    const y = height * pulse.ny;
    const maxRadius = pulse.sceneWide ? Math.max(width, height) * 0.78 : Math.min(width, height) * 0.54;
    const radius = 24 + easeOut * maxRadius;

    if (ctx.createRadialGradient) {
      const glow = ctx.createRadialGradient(x, y, radius * 0.04, x, y, radius);
      glow.addColorStop(0, rgba(palette.accent, Math.min(0.24, alpha * 0.2)));
      glow.addColorStop(0.34, rgba(palette.warm, Math.min(0.18, alpha * 0.16)));
      glow.addColorStop(1, rgba(palette.cool, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = rgba(palette.accent, Math.min(0.5, alpha * 0.46));
    ctx.lineWidth = 1 + pulse.strength * 5 * (1 - t);
    ctx.beginPath();
    if (ctx.arc) {
      ctx.arc(x, y, radius * 0.58, 0, Math.PI * 2);
    } else {
      ctx.moveTo(x - radius, y);
      ctx.lineTo(x, y - radius);
      ctx.lineTo(x + radius, y);
      ctx.lineTo(x, y + radius);
      ctx.closePath();
    }
    ctx.stroke();

    const sweepY = y + (t - 0.5) * height * 0.42;
    ctx.strokeStyle = rgba(palette.warm, Math.min(0.26, alpha * 0.22));
    ctx.lineWidth = 1 + pulse.strength * 3;
    ctx.beginPath();
    ctx.moveTo(width * 0.08, sweepY);
    ctx.lineTo(width * 0.92, sweepY + Math.sin(timeS + pulse.nx * 6) * 22);
    ctx.stroke();
  }
}

function drawLayer(ctx, canvas, frame, timeS, windowLike, commandPulses = []) {
  const { width, height } = resizeCanvas(canvas, ctx, windowLike);
  const { palette, amplitude, onset, energy, centroid, drift } = frame;
  ctx.clearRect(0, 0, width, height);
  ctx.save?.();
  ctx.globalCompositeOperation = "source-over";

  const baseGradient = ctx.createLinearGradient?.(0, 0, width, height);
  if (baseGradient?.addColorStop) {
    baseGradient.addColorStop(0, rgba(palette.base, 0.16 + energy * 0.08));
    baseGradient.addColorStop(0.5, rgba(palette.cool, 0.04 + amplitude * 0.08));
    baseGradient.addColorStop(1, rgba(palette.warm, 0.06 + energy * 0.1));
    ctx.fillStyle = baseGradient;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.globalCompositeOperation = "screen";

  const horizon = height * (0.58 - centroid * 0.12);
  for (let band = 0; band < 4; band += 1) {
    const bandEnergy = energy * (1 - band * 0.13);
    const ampPx = (18 + band * 10) * (0.35 + bandEnergy);
    const phase = timeS * drift * (0.45 + band * 0.18) + band * 1.7;
    const yBase = horizon + band * 42 - onset * 20;
    const color = band % 2 === 0 ? palette.warm : palette.cool;

    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width; x += Math.max(10, width / 90)) {
      const n =
        Math.sin(x * 0.006 + phase) * 0.62 +
        Math.sin(x * 0.014 - phase * 0.7) * 0.38;
      ctx.lineTo(x, yBase + n * ampPx);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = rgba(color, 0.055 + bandEnergy * 0.13);
    ctx.fill();

    ctx.beginPath();
    for (let x = 0; x <= width; x += Math.max(10, width / 100)) {
      const n =
        Math.sin(x * 0.007 + phase * 1.2) * 0.7 +
        Math.sin(x * 0.019 - phase) * 0.3;
      const y = yBase + n * ampPx;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = rgba(color, 0.12 + bandEnergy * 0.24);
    ctx.lineWidth = 1 + bandEnergy * 2.6;
    ctx.stroke();
  }

  const pillarCount = 9;
  const pillarAlpha = 0.035 + onset * 0.18;
  for (let i = 0; i < pillarCount; i += 1) {
    const x = (width / (pillarCount + 1)) * (i + 1);
    const sway = Math.sin(timeS * 0.7 + i) * (8 + energy * 22);
    const top = height * (0.12 + ((i * 17) % 23) / 100);
    const bottom = height * (0.82 + Math.sin(i) * 0.04);
    const grad = ctx.createLinearGradient?.(x, top, x + sway, bottom);
    if (grad?.addColorStop) {
      grad.addColorStop(0, rgba(palette.accent, 0));
      grad.addColorStop(0.5, rgba(palette.accent, pillarAlpha));
      grad.addColorStop(1, rgba(palette.cool, 0));
      ctx.strokeStyle = grad;
    } else {
      ctx.strokeStyle = rgba(palette.accent, pillarAlpha);
    }
    ctx.lineWidth = 1 + energy * 1.8;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x + sway, bottom);
    ctx.stroke();
  }

  if (onset > 0.15) {
    ctx.globalCompositeOperation = "screen";
    ctx.strokeStyle = rgba(palette.accent, Math.min(0.24, onset * 0.22));
    ctx.lineWidth = 1 + onset * 8;
    ctx.beginPath();
    ctx.moveTo(width * 0.08, horizon - onset * 70);
    ctx.lineTo(width * 0.92, horizon - onset * 70);
    ctx.stroke();
  }

  drawCommandPulses(ctx, width, height, frame, timeS, commandPulses);

  ctx.restore?.();
}

function createAudioAnalyser({ audioEl, windowLike, onError }) {
  const AudioContextImpl = windowLike?.AudioContext ?? windowLike?.webkitAudioContext;
  if (!audioEl || !AudioContextImpl) return null;
  let audioContext = null;
  let analyser = null;
  let bins = null;
  let source = null;

  function ensure() {
    if (analyser) return true;
    try {
      audioContext = new AudioContextImpl();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.82;
      bins = new Uint8Array(analyser.frequencyBinCount);
      source = audioContext.createMediaElementSource(audioEl);
      source.connect(analyser);
      analyser.connect(audioContext.destination);
      return true;
    } catch (err) {
      analyser = null;
      onError?.(err);
      return false;
    }
  }

  async function resume() {
    if (!ensure()) return;
    try {
      if (audioContext?.state === "suspended") await audioContext.resume();
    } catch (err) {
      onError?.(err);
    }
  }

  function read() {
    if (!analyser || !bins) return null;
    analyser.getByteFrequencyData(bins);
    return deriveAudioFeaturesFromFrequencyBins(bins);
  }

  function close() {
    try {
      source?.disconnect?.();
      analyser?.disconnect?.();
      audioContext?.close?.();
    } catch {
      // ignore teardown failures
    }
  }

  return { resume, read, close };
}

export function createAudioVisualLayer({
  mount,
  bus,
  audioEl = null,
  documentLike = globalThis.document,
  windowLike = globalThis,
  rafImpl = globalThis.requestAnimationFrame,
  cancelRafImpl = globalThis.cancelAnimationFrame,
  onError = () => {},
} = {}) {
  if (!mount) throw new Error("mount is required");
  if (!bus?.subscribe) throw new Error("bus is required");
  const canvas = documentLike.createElement("canvas");
  canvas.dataset.audioVisualLayer = "1";
  canvas.setAttribute?.("aria-hidden", "true");
  canvas.style = canvas.style ?? {};
  canvas.style.cssText = [
    "position: absolute",
    "inset: 0",
    "width: 100%",
    "height: 100%",
    "z-index: 1",
    "pointer-events: none",
    "mix-blend-mode: screen",
    "opacity: 0.74",
  ].join("; ");
  if (mount.firstChild && mount.insertBefore) mount.insertBefore(canvas, mount.firstChild);
  else mount.appendChild(canvas);

  const ctx = canvas.getContext?.("2d");
  const reducedMotion = Boolean(windowLike?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  const features = {
    amplitude: 0,
    onset_strength: 0,
    spectral_centroid: 900,
    hijaz_state: "quiet",
    hijaz_intensity: 0,
    hijaz_tahwil: false,
  };
  let frame = computeVisualFrame(features, {}, { reducedMotion });
  let rafHandle = null;
  let stopped = false;
  let lastTimeS = 0;
  let commandPulses = [];
  const unsubscribers = [];
  const analyser = createAudioAnalyser({ audioEl, windowLike, onError });

  for (const name of FEATURE_NAMES) {
    unsubscribers.push(
      bus.subscribe(name, (value) => {
        features[name] = value;
      }),
    );
  }

  const resumeAudioAnalysis = () => {
    void analyser?.resume();
  };
  audioEl?.addEventListener?.("play", resumeAudioAnalysis);
  documentLike?.addEventListener?.("pointerdown", resumeAudioAnalysis, { once: true });
  documentLike?.addEventListener?.("keydown", resumeAudioAnalysis, { once: true });

  function tick(ts = 0) {
    if (stopped) return;
    lastTimeS = ts / 1000;
    const derived = analyser?.read?.();
    if (derived) {
      features.amplitude = Math.max(clamp01(features.amplitude), derived.amplitude);
      features.onset_strength = Math.max(clamp01(features.onset_strength), derived.onset_strength);
      features.spectral_centroid = derived.spectral_centroid || features.spectral_centroid;
      features.hijaz_intensity = Math.max(clamp01(features.hijaz_intensity), derived.amplitude);
    }
    frame = computeVisualFrame(features, frame, { reducedMotion });
    commandPulses = commandPulses.filter((pulse) => lastTimeS - pulse.startedAtS < pulse.durationS);
    if (ctx) drawLayer(ctx, canvas, frame, lastTimeS, windowLike, commandPulses);
    if (rafImpl) rafHandle = rafImpl(tick);
  }

  if (rafImpl) rafHandle = rafImpl(tick);
  else tick(0);

  function stop() {
    stopped = true;
    if (rafHandle != null && cancelRafImpl) cancelRafImpl(rafHandle);
    for (const off of unsubscribers) off();
    audioEl?.removeEventListener?.("play", resumeAudioAnalysis);
    analyser?.close?.();
    canvas.remove?.();
  }

  function triggerCommandPulse(patch) {
    const pulse = createCommandPulse(patch, lastTimeS, { reducedMotion });
    if (!pulse) return false;
    commandPulses.push(pulse);
    if (commandPulses.length > 8) commandPulses = commandPulses.slice(-8);
    return true;
  }

  return {
    canvas,
    stop,
    triggerCommandPulse,
    getFrame: () => frame,
    getFeatures: () => ({ ...features }),
    getCommandPulses: () => [...commandPulses],
  };
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const { createFeatureBus } = await import("./feature_bus.mjs");

  let pass = 0;
  let fail = 0;
  function t(desc, fn) {
    try {
      fn();
      pass += 1;
      process.stdout.write(`  ok  ${desc}\n`);
    } catch (err) {
      fail += 1;
      process.stdout.write(`  FAIL ${desc}\n    ${err.message}\n`);
    }
  }

  class FakeNode {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.dataset = {};
      this.style = { cssText: "" };
      this.attributes = new Map();
      this.firstChild = null;
    }
    appendChild(child) {
      this.children.push(child);
      this.firstChild = this.children[0] ?? null;
      child.parentNode = this;
    }
    insertBefore(child, before) {
      const idx = this.children.indexOf(before);
      if (idx >= 0) this.children.splice(idx, 0, child);
      else this.children.push(child);
      this.firstChild = this.children[0] ?? null;
      child.parentNode = this;
    }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
      this.parentNode.firstChild = this.parentNode.children[0] ?? null;
    }
    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
  }

  class FakeCanvas extends FakeNode {
    constructor() {
      super("canvas");
      this.width = 0;
      this.height = 0;
      this.clientWidth = 800;
      this.clientHeight = 450;
      this.calls = [];
    }
    getBoundingClientRect() {
      return { width: 800, height: 450 };
    }
    getContext() {
      const calls = this.calls;
      return {
        setTransform: (...args) => calls.push(["setTransform", ...args]),
        clearRect: (...args) => calls.push(["clearRect", ...args]),
        fillRect: (...args) => calls.push(["fillRect", ...args]),
        save: () => calls.push(["save"]),
        restore: () => calls.push(["restore"]),
        beginPath: () => calls.push(["beginPath"]),
        moveTo: (...args) => calls.push(["moveTo", ...args]),
        lineTo: (...args) => calls.push(["lineTo", ...args]),
        closePath: () => calls.push(["closePath"]),
        arc: (...args) => calls.push(["arc", ...args]),
        fill: () => calls.push(["fill"]),
        stroke: () => calls.push(["stroke"]),
        createLinearGradient: () => ({ addColorStop: (...args) => calls.push(["addColorStop", ...args]) }),
        createRadialGradient: () => ({ addColorStop: (...args) => calls.push(["radialColorStop", ...args]) }),
        set globalCompositeOperation(value) { calls.push(["gco", value]); },
        set fillStyle(value) { calls.push(["fillStyle", value]); },
        set strokeStyle(value) { calls.push(["strokeStyle", value]); },
        set lineWidth(value) { calls.push(["lineWidth", value]); },
      };
    }
  }

  const fakeDocument = {
    listeners: new Map(),
    createElement(tag) {
      return tag === "canvas" ? new FakeCanvas() : new FakeNode(tag);
    },
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    },
  };

  t("deriveAudioFeaturesFromFrequencyBins maps silent bins to zero energy", () => {
    const got = deriveAudioFeaturesFromFrequencyBins(new Uint8Array(16));
    assert.equal(got.amplitude, 0);
    assert.equal(got.onset_strength, 0);
  });

  t("deriveAudioFeaturesFromFrequencyBins reports higher centroid for bright bins", () => {
    const low = new Uint8Array(16);
    low[1] = 255;
    const high = new Uint8Array(16);
    high[14] = 255;
    assert.ok(
      deriveAudioFeaturesFromFrequencyBins(high).spectral_centroid >
        deriveAudioFeaturesFromFrequencyBins(low).spectral_centroid,
    );
  });

  t("computeVisualFrame clamps features and resolves Hijaz palette", () => {
    const frameOut = computeVisualFrame({
      amplitude: 5,
      onset_strength: 2,
      hijaz_intensity: 1.5,
      spectral_centroid: 8000,
      hijaz_state: "tahwil",
    });
    assert.equal(frameOut.state, "tahwil");
    assert.ok(frameOut.energy <= 1);
    assert.deepEqual(frameOut.palette, PALETTES.tahwil);
  });

  t("isCommandPatch ignores lifecycle/replay patches and accepts visual patches", () => {
    assert.equal(isCommandPatch({ type: "cycle.begin" }), false);
    assert.equal(isCommandPatch({ type: "replay.end" }), false);
    assert.equal(isCommandPatch({ type: "element.add", element: {} }), true);
  });

  t("createCommandPulse maps a patch to a bounded visual impulse", () => {
    const pulse = createCommandPulse({ type: "element.transform", element_id: "elem_001" }, 2);
    assert.equal(pulse.patchType, "element.transform");
    assert.equal(pulse.startedAtS, 2);
    assert.ok(pulse.nx >= 0 && pulse.nx <= 1);
    assert.ok(pulse.ny >= 0 && pulse.ny <= 1);
    assert.ok(pulse.strength > 0);
  });

  t("createAudioVisualLayer mounts a non-interactive canvas and consumes feature bus values", () => {
    const mount = new FakeNode("div");
    const bus = createFeatureBus();
    let rafCallback = null;
    const layer = createAudioVisualLayer({
      mount,
      bus,
      documentLike: fakeDocument,
      windowLike: { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) },
      rafImpl: (fn) => {
        rafCallback = fn;
        return 1;
      },
      cancelRafImpl: () => {},
    });
    assert.equal(mount.children[0], layer.canvas);
    assert.equal(layer.canvas.dataset.audioVisualLayer, "1");
    assert.match(layer.canvas.style.cssText, /pointer-events: none/);
    bus.dispatch("hijaz_state", "aug2");
    bus.dispatch("amplitude", 0.9);
    rafCallback(1000);
    assert.equal(layer.getFeatures().hijaz_state, "aug2");
    assert.ok(layer.getFrame().energy > 0);
    assert.ok(layer.canvas.calls.some((call) => call[0] === "stroke"));
    layer.stop();
  });

  t("triggerCommandPulse queues a ripple and draws it on the next frame", () => {
    const mount = new FakeNode("div");
    const bus = createFeatureBus();
    let rafCallback = null;
    const layer = createAudioVisualLayer({
      mount,
      bus,
      documentLike: fakeDocument,
      windowLike: { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) },
      rafImpl: (fn) => {
        rafCallback = fn;
        return 1;
      },
      cancelRafImpl: () => {},
    });
    assert.equal(layer.triggerCommandPulse({ type: "cycle.begin" }), false);
    assert.equal(layer.triggerCommandPulse({ type: "element.add", element: { element_id: "elem_001" } }), true);
    assert.equal(layer.getCommandPulses().length, 1);
    rafCallback(1000);
    assert.ok(layer.canvas.calls.some((call) => call[0] === "arc"));
    assert.ok(layer.canvas.calls.some((call) => call[0] === "radialColorStop"));
    layer.stop();
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
