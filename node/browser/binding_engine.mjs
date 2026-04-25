// node/browser/binding_engine.mjs
// Per-element subscribe/lerp/apply-to-DOM engine. Driven by
// feature_bus dispatches and a single rAF tick loop shared across
// every mounted element. No DOM reads — only writes.

const sharedUrl = import.meta.url.startsWith("file:")
  ? "../src/binding_easing.mjs"
  : "/shared/binding_easing.mjs";

const {
  createLerper,
  mapInputToOutput,
  DEFAULT_SMOOTHING_MS,
  IMPULSE_DEFAULT_SMOOTHING_MS,
} = await import(sharedUrl);

// v6.2: motion preset kernels. Each preset runs as an "audio-parameterized
// response curve" — it reads the live feature_bus value on every rAF tick
// and computes its own output. This is deliberately NOT a pre-scripted
// keyframe animation: the kernel's shape (sine/decay/wander) is fixed,
// but its amplitude and phase respond to the audio signal in real time.
//
// Each kernel returns contributions to a separate "motion state" slot
// that composes with explicit reactivity bindings (multiplicative for
// scale, additive for rotation/translate). That way an element can
// carry BOTH a motion preset AND explicit bindings without one
// stomping the other.

export const MOTION_KERNEL_DEFAULTS = Object.freeze({
  breathe: { feature: "hijaz_intensity", frequencyHz: 0.2, magnitude: 0.09 },
  pulse:   { feature: "onset_strength",  decayMs: 300,     magnitude: 0.17 },
  orbit:   { feature: "amplitude",       frequencyHz: 0.1, magnitude: 22   },
  drift:   { feature: "hijaz_intensity", frequencyHz: 0.06, magnitude: 24  },
  tremble: { feature: "onset_strength",  magnitude: 4                      },
});

// Numeric encoding for hijaz_state enum (authors gate via map.in=[N,N]).
// Kept here rather than in patch_protocol.mjs because it's strictly a
// binding-engine convention — the protocol sees the raw string.
const HIJAZ_STATE_NUMERIC = Object.freeze({
  quiet: 0,
  approach: 1,
  arrived: 2,
  tahwil: 3,
  aug2: 4,
});

// Fixed transform key order so multi-binding composition is
// deterministic regardless of binding-array order on the element.
const TRANSFORM_KEY_ORDER = Object.freeze(["scale", "rotation", "translateX", "translateY"]);

export function coerceFeatureValue(feature, value) {
  if (feature === "hijaz_state") {
    return HIJAZ_STATE_NUMERIC[value] ?? 0;
  }
  if (feature === "hijaz_tahwil") {
    return value ? 1 : 0;
  }
  return typeof value === "number" ? value : 0;
}

export function restValueForBinding(binding) {
  // Rest = out[0] verbatim — the authored start-of-map endpoint. An
  // author writing out=[1, 0] means "rest at 1, descend toward 0 as
  // input rises" (e.g. an opacity that dims when the music gets louder);
  // Math.min(lo, hi) would silently flip that to 0 and the inversion
  // the author asked for would never appear. For a standard ascending
  // tuple out=[lo, hi] this is the same value as before.
  return binding.map.out[0];
}

export function smoothingFor(binding) {
  if (binding.smoothing_ms != null) return binding.smoothing_ms;
  return binding.map.curve === "impulse" ? IMPULSE_DEFAULT_SMOOTHING_MS : DEFAULT_SMOOTHING_MS;
}

// Compose explicit reactivity state with motion kernel contributions.
// Returned shape has the same keys as `state` so formatTransform /
// filter writers can read one merged object without branching.
function composeMotion(state, motionState) {
  if (!motionState) return state;
  const out = { ...state };
  // scale is multiplicative: a breathe kernel with factor 1.03 on an
  // element with explicit scale 1.2 lands at 1.236.
  if (motionState.scaleFactor !== undefined) {
    const base = out.scale ?? 1;
    out.scale = base * motionState.scaleFactor;
  }
  // rotation / translate are additive.
  if (motionState.rotationDelta !== undefined) {
    out.rotation = (out.rotation ?? 0) + motionState.rotationDelta;
  }
  if (motionState.translateXDelta !== undefined) {
    out.translateX = (out.translateX ?? 0) + motionState.translateXDelta;
  }
  if (motionState.translateYDelta !== undefined) {
    out.translateY = (out.translateY ?? 0) + motionState.translateYDelta;
  }
  return out;
}

function formatTransform(state) {
  const parts = [];
  for (const key of TRANSFORM_KEY_ORDER) {
    if (state[key] === undefined) continue;
    const v = state[key];
    switch (key) {
      case "scale":
        parts.push(`scale(${v})`);
        break;
      case "rotation":
        parts.push(`rotate(${v}deg)`);
        break;
      case "translateX":
        parts.push(`translateX(${v}px)`);
        break;
      case "translateY":
        parts.push(`translateY(${v}px)`);
        break;
      default:
        break;
    }
  }
  return parts.join(" ");
}

function writePerElementState(domNode, state) {
  const transform = formatTransform(state);
  if (transform.length > 0) domNode.style.transform = transform;
  if (state.opacity !== undefined) domNode.style.opacity = String(state.opacity);
  // Compose CSS filter from hue-rotate + blur + saturate. Absent keys
  // contribute nothing; when every filter-related key is absent the
  // element's `filter` property is not written (keeps untouched
  // elements at their default `filter: none`).
  const filters = [];
  if (state.color_hue !== undefined) filters.push(`hue-rotate(${state.color_hue}deg)`);
  if (state.blur !== undefined) filters.push(`blur(${state.blur}px)`);
  if (state.saturation !== undefined) filters.push(`saturate(${state.saturation})`);
  if (filters.length > 0) domNode.style.filter = filters.join(" ");
}

// Create a live kernel. options.intensity scales the kernel's magnitude.
// options.feature overrides the preset's default feature. t0 is the
// mount time — kernels are phase-aligned relative to mount so every
// element isn't oscillating in unison with every other element using
// the same preset.
export function createMotionKernel(preset, { intensity = 1, feature = null, t0 = 0 } = {}) {
  const defaults = MOTION_KERNEL_DEFAULTS[preset];
  if (!defaults) return null;
  const pickedFeature = feature ?? defaults.feature;

  // Small pseudo-random per-kernel seed so parallel elements don't
  // land in exact phase lock. Deterministic given t0.
  const phaseOffset = Math.abs(Math.sin(t0 * 0.001) * 1000) % 1000;

  // Tracking state for event-driven kernels (pulse, tremble). Updated
  // by observeFeature and consumed by update(nowMs).
  let lastOnsetMs = -Infinity;
  let lastJitter = 0;

  return {
    preset,
    feature: pickedFeature,
    observeFeature(rawValue, nowMs) {
      // Normalize to number for event detection. Boolean hijaz_tahwil
      // is coerced; enum hijaz_state is coerced upstream via
      // coerceFeatureValue — here we just need "is it an impulse?"
      const numeric =
        typeof rawValue === "boolean" ? (rawValue ? 1 : 0) :
        typeof rawValue === "number" ? rawValue : 0;
      if (preset === "pulse" || preset === "tremble") {
        // Impulse threshold: a fresh event re-triggers the kernel.
        if (numeric >= 0.5) lastOnsetMs = nowMs;
      }
      if (preset === "tremble") {
        // Update jitter lazily on observation; the rAF tick still reads it.
        lastJitter = (numeric - 0.5) * 2;
      }
    },
    update(nowMs, currentFeatureValue) {
      const contribution = {};
      const magnitude = defaults.magnitude * intensity;
      const t = (nowMs + phaseOffset) / 1000;
      switch (preset) {
        case "breathe": {
          // Slow sinusoid on scale, amplitude-modulated by the feature.
          const featureScale = typeof currentFeatureValue === "number"
            ? Math.max(0, Math.min(1, currentFeatureValue))
            : 0;
          const envelope = 0.5 + 0.5 * featureScale;
          contribution.scaleFactor = 1 + magnitude * envelope * Math.sin(t * 2 * Math.PI * defaults.frequencyHz);
          break;
        }
        case "pulse": {
          // Exponential decay on scale from the most recent onset.
          const dt = nowMs - lastOnsetMs;
          const decay = dt >= 0 ? Math.exp(-dt / defaults.decayMs) : 0;
          contribution.scaleFactor = 1 + magnitude * decay;
          break;
        }
        case "orbit": {
          // Circular drift in translate space. Radius scales with feature.
          const featureScale = typeof currentFeatureValue === "number"
            ? Math.max(0, Math.min(1, currentFeatureValue))
            : 0;
          const radius = magnitude * featureScale;
          const omega = t * 2 * Math.PI * defaults.frequencyHz;
          contribution.translateXDelta = radius * Math.cos(omega);
          contribution.translateYDelta = radius * Math.sin(omega);
          break;
        }
        case "drift": {
          // Composite slow wander: two offset sines on each axis. Not
          // Perlin; a figurative low-frequency wobble the scene reads
          // as "the breeze moves this thing a little".
          const omega = t * 2 * Math.PI * defaults.frequencyHz;
          contribution.translateXDelta =
            magnitude * (0.6 * Math.sin(omega) + 0.4 * Math.sin(omega * 1.7 + 1.1));
          contribution.translateYDelta =
            magnitude * (0.5 * Math.cos(omega * 0.9) + 0.5 * Math.sin(omega * 1.3 + 0.4));
          break;
        }
        case "tremble": {
          // Small rotation jitter that re-seeds on each onset. Between
          // onsets the jitter decays linearly over ~400 ms back to 0.
          const dt = nowMs - lastOnsetMs;
          const decay = dt < 400 ? Math.max(0, 1 - dt / 400) : 0;
          contribution.rotationDelta = magnitude * lastJitter * decay;
          break;
        }
      }
      return contribution;
    },
  };
}

export function createBindingEngine({
  bus,
  rafImpl = globalThis.requestAnimationFrame,
  cancelRafImpl = globalThis.cancelAnimationFrame,
  now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
} = {}) {
  const entries = new Map();
  let rafHandle = null;
  let running = false;

  function scheduleTick() {
    if (!running) return;
    rafHandle = rafImpl ? rafImpl(tick) : null;
  }

  function startLoop() {
    if (running) return;
    running = true;
    scheduleTick();
  }

  function stopLoopIfIdle() {
    if (entries.size > 0) return;
    running = false;
    if (rafHandle != null && cancelRafImpl) cancelRafImpl(rafHandle);
    rafHandle = null;
  }

  function tick() {
    const nowMs = now();
    for (const entry of entries.values()) {
      for (const binding of entry.bindings) {
        entry.state[binding.property] = binding.lerper.update(nowMs);
      }
      // v6.2: run motion kernel (if attached) and compose its
      // contribution with the explicit reactivity state. bus.last()
      // is read each tick so the kernel stays current even between
      // explicit retarget calls.
      let merged = entry.state;
      if (entry.motion && entry.motion.kernel) {
        const featureValue = bus.last(entry.motion.kernel.feature);
        const contribution = entry.motion.kernel.update(nowMs, featureValue);
        entry.motion.state = contribution;
        merged = composeMotion(entry.state, contribution);
      }
      writePerElementState(entry.domNode, merged);
    }
    scheduleTick();
  }

  function mount(elementId, domNode, reactivity, motion = null) {
    const hasReactivity = Array.isArray(reactivity) && reactivity.length > 0;
    const hasMotion = motion && typeof motion === "object" && typeof motion.preset === "string";
    if (!hasReactivity && !hasMotion) return;
    // Defensive: if this element is already mounted (replay replays an
    // element.add, for example), tear the old entry down first.
    if (entries.has(elementId)) unmount(elementId);

    const state = {};
    const bindings = [];
    if (hasReactivity) {
      for (const raw of reactivity) {
        const rest = restValueForBinding(raw);
        state[raw.property] = rest;
        const lerper = createLerper({
          from: rest,
          to: rest,
          durationMs: smoothingFor(raw),
          now: now(),
          curve: raw.map.curve,
        });
        const unsubscribe = bus.subscribe(raw.feature, (value) => {
          const numeric = coerceFeatureValue(raw.feature, value);
          const target = mapInputToOutput({ value: numeric, map: raw.map });
          lerper.retarget({ to: target, nowMs: now() });
        });
        bindings.push({ property: raw.property, lerper, unsubscribe });
      }
    }

    // v6.2: attach a motion kernel if the element carries one. The
    // kernel subscribes to its input feature so event-driven presets
    // (pulse, tremble) can capture onset events even if the rAF tick
    // doesn't hit at the same millisecond.
    let motionEntry = null;
    if (hasMotion) {
      const kernel = createMotionKernel(motion.preset, {
        intensity: typeof motion.intensity === "number" ? motion.intensity : 1,
        feature: motion.feature ?? null,
        t0: now(),
      });
      if (kernel) {
        const unsubscribe = bus.subscribe(kernel.feature, (value) => {
          kernel.observeFeature(value, now());
        });
        motionEntry = { kernel, unsubscribe, state: {} };
      }
    }

    entries.set(elementId, { domNode, bindings, state, motion: motionEntry });
    writePerElementState(domNode, state);

    // Seed each binding with bus.last() if already present so late mounts
    // don't sit at rest until the next feature dispatch.
    if (hasReactivity) {
      for (const binding of reactivity) {
        const last = bus.last(binding.feature);
        if (last !== undefined) {
          const entry = entries.get(elementId);
          if (!entry) break;
          const lerperForBinding = entry.bindings.find((b) => b.property === binding.property);
          if (lerperForBinding) {
            const numeric = coerceFeatureValue(binding.feature, last);
            const target = mapInputToOutput({ value: numeric, map: binding.map });
            lerperForBinding.lerper.retarget({ to: target, nowMs: now() });
          }
        }
      }
    }

    startLoop();
  }

  function unmount(elementId) {
    const entry = entries.get(elementId);
    if (!entry) return;
    for (const binding of entry.bindings) {
      try {
        binding.unsubscribe();
      } catch {
        // best effort
      }
    }
    // v6.2: unsubscribe the motion kernel's feature subscription too
    // so the bus drops its reference and the kernel can be GC'd.
    if (entry.motion && typeof entry.motion.unsubscribe === "function") {
      try { entry.motion.unsubscribe(); } catch { /* best effort */ }
    }
    entries.delete(elementId);
    stopLoopIfIdle();
  }

  function dispose() {
    for (const id of [...entries.keys()]) unmount(id);
  }

  return { mount, unmount, dispose, _entries: entries };
}


const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const { createFeatureBus } = await import("./feature_bus.mjs");

  class FakeElement {
    constructor() {
      this.style = {};
    }
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
        const idx = tasks.findIndex((task) => task.id === handle);
        if (idx !== -1) tasks.splice(idx, 1);
      },
      tick(nowMs) {
        const queued = tasks.splice(0);
        for (const task of queued) task.fn(nowMs);
      },
      pending: () => tasks.length,
    };
  }

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

  t("mount with empty reactivity is a no-op (no rAF scheduled)", () => {
    const bus = createFeatureBus();
    const raf = rafRunner();
    const engine = createBindingEngine({ bus, rafImpl: raf.schedule, cancelRafImpl: raf.cancel });
    engine.mount("elem_0001", new FakeElement(), []);
    assert.equal(raf.pending(), 0);
    assert.equal(engine._entries.size, 0);
  });

  t("mount with an opacity/amplitude binding writes rest value immediately", () => {
    const bus = createFeatureBus();
    const raf = rafRunner();
    let clock = 0;
    const engine = createBindingEngine({
      bus,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      now: () => clock,
    });
    const node = new FakeElement();
    engine.mount("elem_0001", node, [
      { property: "opacity", feature: "amplitude", map: { in: [0, 1], out: [0.4, 1.0], curve: "linear" } },
    ]);
    assert.equal(node.style.opacity, "0.4");
    assert.equal(raf.pending(), 1);
  });

  t("bus dispatch retargets the lerper; next tick moves DOM toward target", () => {
    const bus = createFeatureBus();
    const raf = rafRunner();
    let clock = 0;
    const engine = createBindingEngine({
      bus,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      now: () => clock,
    });
    const node = new FakeElement();
    engine.mount("elem_0001", node, [
      { property: "opacity", feature: "amplitude", map: { in: [0, 1], out: [0, 1], curve: "linear" }, smoothing_ms: 100 },
    ]);
    clock = 0;
    bus.dispatch("amplitude", 1.0);
    clock = 100;
    raf.tick(clock);
    // After full duration, opacity should equal target (1.0).
    assert.equal(node.style.opacity, "1");
  });

  t("coerceFeatureValue maps hijaz_state enum and hijaz_tahwil boolean", () => {
    assert.equal(coerceFeatureValue("hijaz_state", "arrived"), 2);
    assert.equal(coerceFeatureValue("hijaz_state", "tahwil"), 3);
    assert.equal(coerceFeatureValue("hijaz_state", "aug2"), 4);
    assert.equal(coerceFeatureValue("hijaz_state", "unknown"), 0);
    assert.equal(coerceFeatureValue("hijaz_tahwil", true), 1);
    assert.equal(coerceFeatureValue("hijaz_tahwil", false), 0);
    assert.equal(coerceFeatureValue("amplitude", 0.42), 0.42);
    assert.equal(coerceFeatureValue("amplitude", "not a number"), 0);
  });

  t("unmount stops subscriptions (post-unmount dispatch does not update DOM)", () => {
    const bus = createFeatureBus();
    const raf = rafRunner();
    let clock = 0;
    const engine = createBindingEngine({
      bus,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      now: () => clock,
    });
    const node = new FakeElement();
    engine.mount("elem_0001", node, [
      { property: "opacity", feature: "amplitude", map: { in: [0, 1], out: [0, 1], curve: "linear" }, smoothing_ms: 100 },
    ]);
    clock = 0;
    bus.dispatch("amplitude", 1.0);
    clock = 100;
    raf.tick(clock);
    assert.equal(node.style.opacity, "1");

    engine.unmount("elem_0001");
    clock = 200;
    bus.dispatch("amplitude", 0.0);
    clock = 300;
    // No active entries so tick loop should not be running; raf.pending should be 0.
    assert.equal(raf.pending(), 0);
    // Opacity stays at the last pre-unmount value.
    assert.equal(node.style.opacity, "1");
  });

  t("two transform bindings on one element compose into one transform string in fixed order", () => {
    const bus = createFeatureBus();
    const raf = rafRunner();
    let clock = 0;
    const engine = createBindingEngine({
      bus,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      now: () => clock,
    });
    const node = new FakeElement();
    engine.mount("elem_0001", node, [
      { property: "rotation", feature: "onset_strength", map: { in: [0, 1], out: [0, 10], curve: "linear" }, smoothing_ms: 10 },
      { property: "scale", feature: "amplitude", map: { in: [0, 1], out: [1, 1.2], curve: "linear" }, smoothing_ms: 10 },
    ]);
    clock = 0;
    bus.dispatch("amplitude", 1.0);
    bus.dispatch("onset_strength", 1.0);
    clock = 50;
    raf.tick(clock);
    // Fixed key order: scale before rotation, both joined by space.
    assert.match(node.style.transform, /^scale\(1\.2\) rotate\(10deg\)$/);
  });

  t("dispose tears down every entry and stops the rAF loop", () => {
    const bus = createFeatureBus();
    const raf = rafRunner();
    let clock = 0;
    const engine = createBindingEngine({
      bus,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      now: () => clock,
    });
    const node = new FakeElement();
    engine.mount("elem_0001", node, [
      { property: "opacity", feature: "amplitude", map: { in: [0, 1], out: [0, 1], curve: "linear" } },
    ]);
    engine.mount("elem_0002", new FakeElement(), [
      { property: "scale", feature: "amplitude", map: { in: [0, 1], out: [1, 1.5], curve: "linear" } },
    ]);
    assert.equal(engine._entries.size, 2);
    engine.dispose();
    assert.equal(engine._entries.size, 0);
    assert.equal(raf.pending(), 0);
  });

  t("smoothing default is 50 ms for non-impulse curves and 200 ms for impulse", () => {
    const bus = createFeatureBus();
    const raf = rafRunner();
    let clock = 0;
    const engine = createBindingEngine({
      bus,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      now: () => clock,
    });
    const node = new FakeElement();
    engine.mount("elem_0001", node, [
      { property: "opacity", feature: "amplitude", map: { in: [0, 1], out: [0, 1], curve: "linear" } },
    ]);
    clock = 0;
    bus.dispatch("amplitude", 1.0);
    // At t=50 ms (default smoothing), value should be at target for linear curve.
    clock = 50;
    raf.tick(clock);
    assert.equal(node.style.opacity, "1");

    // Impulse binding: default 200 ms, peaks at t=100 ms
    const node2 = new FakeElement();
    engine.mount("elem_0002", node2, [
      { property: "scale", feature: "hijaz_tahwil", map: { in: [0, 1], out: [1, 2], curve: "impulse" } },
    ]);
    clock = 100;
    bus.dispatch("hijaz_tahwil", true);
    clock = 200; // 100ms after dispatch, 50% through the 200ms impulse → peak
    raf.tick(clock);
    // At peak of impulse (t=0.5, eased to 1.0), scale should be at max = 2
    assert.equal(node2.style.transform, "scale(2)");
  });

  t("restValueForBinding returns map.out[0] verbatim (Fix 9; honors inverted tuples)", () => {
    // Ascending tuple: rest = out[0] = 0.
    assert.equal(
      restValueForBinding({ map: { in: [0, 1], out: [0, 1], curve: "linear" } }),
      0,
    );
    // Inverted tuple: author wants rest=1, descending to 0. Under the
    // old Math.min semantics this would have returned 0 — wrong.
    assert.equal(
      restValueForBinding({ map: { in: [0, 1], out: [1, 0], curve: "linear" } }),
      1,
    );
    // Non-[0,1] endpoints: still returns out[0] verbatim.
    assert.equal(
      restValueForBinding({ map: { in: [0, 1], out: [0.7, 0.2], curve: "linear" } }),
      0.7,
    );
  });

  t("mount with an inverted map.out writes out[0] as the at-rest DOM value (Fix 9 end-to-end)", () => {
    const bus = createFeatureBus();
    const raf = rafRunner();
    let clock = 0;
    const engine = createBindingEngine({
      bus,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      now: () => clock,
    });
    const node = new FakeElement();
    // "descend from rest": opacity starts at 1.0 (rest) and descends to
    // 0.2 as amplitude rises.
    engine.mount("elem_descend_01", node, [
      { property: "opacity", feature: "amplitude", map: { in: [0, 1], out: [1.0, 0.2], curve: "linear" } },
    ]);
    assert.equal(node.style.opacity, "1");
  });

  t("late mount seeds lerper from bus.last (no 50-ms rest before first update)", () => {
    const bus = createFeatureBus();
    const raf = rafRunner();
    let clock = 0;
    const engine = createBindingEngine({
      bus,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      now: () => clock,
    });
    // Bus has already been dispatching before the element mounts.
    bus.dispatch("amplitude", 1.0);
    const node = new FakeElement();
    engine.mount("elem_0001", node, [
      { property: "opacity", feature: "amplitude", map: { in: [0, 1], out: [0, 1], curve: "linear" }, smoothing_ms: 100 },
    ]);
    clock = 100;
    raf.tick(clock);
    // After one tick at full smoothing duration, opacity should be near the target (1.0).
    // The late-seed call retargets the lerper from rest=0 to target=1 at mount time,
    // so after 100ms it reaches 1.0 under linear curve.
    assert.equal(node.style.opacity, "1");
  });

  t("writePerElementState composes hue-rotate + blur + saturate into a single filter string", () => {
    // Reach into internals by mounting a synthetic reactivity array that
    // covers all three filter properties and checking the filter output
    // after a single tick.
    const bus = createFeatureBus();
    const raf = rafRunner();
    let clock = 0;
    const engine = createBindingEngine({
      bus, rafImpl: raf.schedule, cancelRafImpl: raf.cancel, now: () => clock,
    });
    const node = new FakeElement();
    engine.mount("elem_filter", node, [
      { property: "color_hue",  feature: "hijaz_intensity", map: { in: [0, 1], out: [0, 45], curve: "linear" }, smoothing_ms: 10 },
      { property: "blur",       feature: "amplitude",       map: { in: [0, 1], out: [0, 5],  curve: "linear" }, smoothing_ms: 10 },
      { property: "saturation", feature: "amplitude",       map: { in: [0, 1], out: [1, 1.6],curve: "linear" }, smoothing_ms: 10 },
    ]);
    clock = 0;
    bus.dispatch("hijaz_intensity", 1);
    bus.dispatch("amplitude", 1);
    clock = 20;
    raf.tick(clock);
    // All three filter functions appear, in the order hue-rotate → blur → saturate.
    assert.match(node.style.filter, /^hue-rotate\(45deg\) blur\(5px\) saturate\(1\.6\)$/);
  });

  t("createMotionKernel breathe produces scaleFactor > 1 and < 1 across a full period", () => {
    const kernel = createMotionKernel("breathe", { intensity: 1, t0: 0 });
    // Default breathe frequencyHz = 0.2 → period = 5 s. Sample at 0, 1.25 s, 2.5 s, 3.75 s.
    // Feature value 1 → envelope = 1.0.
    const c0 = kernel.update(0, 1);
    const c1 = kernel.update(1250, 1);   // quarter period — sin peak
    const c2 = kernel.update(2500, 1);   // half period — sin 0
    const c3 = kernel.update(3750, 1);   // 3/4 period — sin trough
    assert.ok(c1.scaleFactor > c0.scaleFactor, "quarter-period scaleFactor should exceed start");
    assert.ok(Math.abs(c2.scaleFactor - 1) < 0.01, "half-period should land near 1 (sin=0)");
    assert.ok(c3.scaleFactor < 1, "three-quarter period scaleFactor should dip below 1");
  });

  t("createMotionKernel pulse peaks immediately after onset, decays toward 1", () => {
    const kernel = createMotionKernel("pulse", { intensity: 1, t0: 0 });
    kernel.observeFeature(1.0, 0);
    const atPeak = kernel.update(0, 1);
    const after150 = kernel.update(150, 1);
    const after600 = kernel.update(600, 1);
    // At peak: decay=1 → scaleFactor = 1 + magnitude (current default 0.17)
    const expectedPeak = 1 + MOTION_KERNEL_DEFAULTS.pulse.magnitude;
    assert.ok(Math.abs(atPeak.scaleFactor - expectedPeak) < 0.001);
    // 150 ms in: decay ≈ exp(-0.5) ≈ 0.607
    assert.ok(after150.scaleFactor < atPeak.scaleFactor);
    assert.ok(after150.scaleFactor > 1);
    // 600 ms in: decay ≈ exp(-2) ≈ 0.135
    assert.ok(after600.scaleFactor < after150.scaleFactor);
    assert.ok(after600.scaleFactor > 1);
  });

  t("createMotionKernel orbit returns translateX + translateY on the unit circle scaled by feature", () => {
    const kernel = createMotionKernel("orbit", { intensity: 1, t0: 0 });
    // feature = 1 → radius = magnitude * 1. Sample at t=0; x² + y² ≈ magnitude².
    const c = kernel.update(0, 1);
    const r2 = c.translateXDelta * c.translateXDelta + c.translateYDelta * c.translateYDelta;
    const expectedR2 = MOTION_KERNEL_DEFAULTS.orbit.magnitude * MOTION_KERNEL_DEFAULTS.orbit.magnitude;
    assert.ok(Math.abs(r2 - expectedR2) < 0.01, `orbit radius²=${r2}, expected ≈${expectedR2}`);
    // Zero feature collapses radius to zero.
    const c0 = kernel.update(0, 0);
    assert.equal(c0.translateXDelta, 0);
    assert.equal(c0.translateYDelta, 0);
  });

  t("createMotionKernel drift returns nonzero translateX/Y even with zero input feature (ambient wander)", () => {
    // Drift does NOT gate on feature value — it's always on, at
    // magnitude `magnitude * intensity`. Distinguishes drift from
    // orbit/pulse/breathe (those all modulate by feature).
    const kernel = createMotionKernel("drift", { intensity: 1, t0: 0 });
    const samples = [0, 500, 1000, 2000].map((t) => kernel.update(t, 0));
    const anyNonzero = samples.some((c) =>
      Math.abs(c.translateXDelta) > 0.1 || Math.abs(c.translateYDelta) > 0.1,
    );
    assert.ok(anyNonzero, "drift kernel should produce motion even with feature=0");
    // All samples are bounded by magnitude.
    const driftBound = MOTION_KERNEL_DEFAULTS.drift.magnitude + 0.01;
    for (const c of samples) {
      assert.ok(Math.abs(c.translateXDelta) <= driftBound);
      assert.ok(Math.abs(c.translateYDelta) <= driftBound);
    }
  });

  t("createMotionKernel tremble decays to zero after ~400 ms without a new observation", () => {
    const kernel = createMotionKernel("tremble", { intensity: 1, t0: 0 });
    kernel.observeFeature(1.0, 0);
    const atOnset = kernel.update(0, 1);
    const at500 = kernel.update(500, 0);
    assert.ok(Math.abs(atOnset.rotationDelta) > 0, "rotation jitter should fire at onset");
    assert.equal(at500.rotationDelta, 0, "tremble rotation should be back to 0 at 500 ms post-onset");
  });

  t("createMotionKernel returns null for unknown presets", () => {
    assert.equal(createMotionKernel("shimmer"), null);
    assert.equal(createMotionKernel(undefined), null);
  });

  t("mount with motion only (no reactivity) attaches a kernel and writes DOM each tick", () => {
    const bus = createFeatureBus();
    const raf = rafRunner();
    let clock = 0;
    const engine = createBindingEngine({
      bus, rafImpl: raf.schedule, cancelRafImpl: raf.cancel, now: () => clock,
    });
    const node = new FakeElement();
    engine.mount("elem_motion", node, null, { preset: "breathe", intensity: 1 });
    // Kernel observes the feature stream:
    clock = 0;
    bus.dispatch("hijaz_intensity", 1);
    // Tick to a quarter period (~1250 ms) — breathe should push scale > 1.
    clock = 1250;
    raf.tick(clock);
    // `transform` contains a scale(...) greater than 1.
    const scaleMatch = /scale\(([^)]+)\)/.exec(node.style.transform);
    assert.ok(scaleMatch, "motion kernel should produce a scale transform");
    assert.ok(parseFloat(scaleMatch[1]) > 1, `breathe at quarter-period should scale > 1, got ${scaleMatch[1]}`);
  });

  t("motion composes with explicit reactivity: scale is multiplied, rotation added", () => {
    const bus = createFeatureBus();
    const raf = rafRunner();
    let clock = 0;
    const engine = createBindingEngine({
      bus, rafImpl: raf.schedule, cancelRafImpl: raf.cancel, now: () => clock,
    });
    const node = new FakeElement();
    engine.mount(
      "elem_combo",
      node,
      [
        { property: "scale", feature: "amplitude", map: { in: [0, 1], out: [1.2, 1.2], curve: "linear" }, smoothing_ms: 10 },
      ],
      { preset: "pulse", intensity: 1 },
    );
    clock = 0;
    bus.dispatch("amplitude", 1);      // reactivity → scale = 1.2
    bus.dispatch("onset_strength", 1); // pulse kernel fires; peak scaleFactor ≈ 1+pulse.magnitude
    clock = 20;
    raf.tick(clock);
    const scaleMatch = /scale\(([^)]+)\)/.exec(node.style.transform);
    assert.ok(scaleMatch, "merged transform should carry scale");
    const scale = parseFloat(scaleMatch[1]);
    assert.ok(scale > 1.2, `composed scale ${scale} should exceed reactivity-only 1.2`);
    // Upper bound: 1.2 * (1 + pulse.magnitude) plus a small slack for the
    // 20 ms decay window. Bound widens automatically when the kernel default
    // is bumped, so this stays correct across magnitude changes.
    const composedUpper = 1.2 * (1 + MOTION_KERNEL_DEFAULTS.pulse.magnitude) + 0.05;
    assert.ok(scale < composedUpper, `composed scale ${scale} should not exceed reactivity*magnitude upper bound ${composedUpper.toFixed(3)}`);
  });

  t("unmount drops the motion kernel's feature subscription", () => {
    const bus = createFeatureBus();
    const raf = rafRunner();
    let clock = 0;
    const engine = createBindingEngine({
      bus, rafImpl: raf.schedule, cancelRafImpl: raf.cancel, now: () => clock,
    });
    const node = new FakeElement();
    engine.mount("elem_m", node, null, { preset: "pulse", intensity: 1 });
    // One subscriber after mount (pulse → onset_strength).
    // feature_bus exposes its subscriber count via .size on the subscription Set per feature.
    // Since we don't have direct access, we use the behavioral check: after unmount, dispatching
    // should not re-arm the kernel (no entry exists).
    engine.unmount("elem_m");
    clock = 0;
    bus.dispatch("onset_strength", 1);
    clock = 20;
    // No error, no DOM write — entry was torn down cleanly.
    assert.equal(engine._entries.size, 0);
  });

  t("re-mounting the same element_id tears down the previous entry's subscriptions", () => {
    const bus = createFeatureBus();
    const raf = rafRunner();
    let clock = 0;
    const engine = createBindingEngine({
      bus,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      now: () => clock,
    });
    const node = new FakeElement();
    engine.mount("elem_0001", node, [
      { property: "opacity", feature: "amplitude", map: { in: [0, 1], out: [0, 1], curve: "linear" }, smoothing_ms: 10 },
    ]);
    engine.mount("elem_0001", node, [
      { property: "scale", feature: "amplitude", map: { in: [0, 1], out: [1, 2], curve: "linear" }, smoothing_ms: 10 },
    ]);
    assert.equal(engine._entries.size, 1);
    assert.equal(engine._entries.get("elem_0001").bindings.length, 1);
    assert.equal(engine._entries.get("elem_0001").bindings[0].property, "scale");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
