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
  // Rest = lower output bound. Authors who want an inverted rest (rest
  // at the upper end when at-rest input is high) can flip map.out.
  const [lo, hi] = binding.map.out;
  return Math.min(lo, hi);
}

export function smoothingFor(binding) {
  if (binding.smoothing_ms != null) return binding.smoothing_ms;
  return binding.map.curve === "impulse" ? IMPULSE_DEFAULT_SMOOTHING_MS : DEFAULT_SMOOTHING_MS;
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
  if (state.color_hue !== undefined) domNode.style.filter = `hue-rotate(${state.color_hue}deg)`;
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
      writePerElementState(entry.domNode, entry.state);
    }
    scheduleTick();
  }

  function mount(elementId, domNode, reactivity) {
    if (!reactivity || reactivity.length === 0) return;
    // Defensive: if this element is already mounted (replay replays an
    // element.add, for example), tear the old entry down first.
    if (entries.has(elementId)) unmount(elementId);

    const state = {};
    const bindings = [];
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
    entries.set(elementId, { domNode, bindings, state });
    writePerElementState(domNode, state);

    // Seed each binding with bus.last() if already present so late mounts
    // don't sit at rest until the next feature dispatch.
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
