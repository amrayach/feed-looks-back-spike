// node/browser/feature_bus.mjs
// Audio-feature pub/sub. Phase 4's binding engine consumes this contract.

export function createFeatureBus() {
  const lastValues = new Map();
  const wrappersByFeature = new Map();

  function dispatch(feature, value) {
    lastValues.set(feature, value);
    const wrappers = wrappersByFeature.get(feature);
    if (!wrappers) return;
    // Snapshot subscribers before calling so unsubscribe-during-dispatch
    // cannot mutate the iteration.
    for (const wrapper of [...wrappers]) {
      try {
        wrapper(value);
      } catch (err) {
        // Subscriber isolation: one buggy subscriber must not break others.
        // Reported to console for development visibility; silent when
        // console is unavailable (e.g. stripped-down test environments).
        if (typeof console !== "undefined" && typeof console.error === "function") {
          console.error(`feature_bus subscriber for '${feature}' threw:`, err);
        }
      }
    }
  }

  function subscribe(feature, callback) {
    let wrappers = wrappersByFeature.get(feature);
    if (!wrappers) {
      wrappers = new Set();
      wrappersByFeature.set(feature, wrappers);
    }
    const wrapper = (value) => callback(value);
    wrappers.add(wrapper);
    return () => {
      wrappers.delete(wrapper);
      if (wrappers.size === 0) wrappersByFeature.delete(feature);
    };
  }

  function last(feature) {
    return lastValues.get(feature);
  }

  function dispose() {
    wrappersByFeature.clear();
    lastValues.clear();
  }

  return { subscribe, dispatch, last, dispose };
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;

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

  t("subscribe then dispatch delivers the value", () => {
    const bus = createFeatureBus();
    let got;
    bus.subscribe("amplitude", (v) => { got = v; });
    bus.dispatch("amplitude", 0.5);
    assert.equal(got, 0.5);
  });

  t("subscribe returns an unsubscribe function", () => {
    const bus = createFeatureBus();
    let count = 0;
    const off = bus.subscribe("amplitude", () => { count += 1; });
    bus.dispatch("amplitude", 0.1);
    off();
    bus.dispatch("amplitude", 0.2);
    assert.equal(count, 1);
  });

  t("last(feature) returns the most recent value after dispatch", () => {
    const bus = createFeatureBus();
    assert.equal(bus.last("amplitude"), undefined);
    bus.dispatch("amplitude", 0.3);
    bus.dispatch("amplitude", 0.7);
    assert.equal(bus.last("amplitude"), 0.7);
  });

  t("multiple subscribers per feature each receive the value", () => {
    const bus = createFeatureBus();
    const seen = [];
    bus.subscribe("onset_strength", (v) => seen.push(["a", v]));
    bus.subscribe("onset_strength", (v) => seen.push(["b", v]));
    bus.dispatch("onset_strength", 0.9);
    assert.deepEqual(seen, [["a", 0.9], ["b", 0.9]]);
  });

  t("a throwing subscriber does not block other subscribers", () => {
    const bus = createFeatureBus();
    const seen = [];
    const prevError = console.error;
    console.error = () => {};
    try {
      bus.subscribe("amplitude", () => { throw new Error("boom"); });
      bus.subscribe("amplitude", (v) => seen.push(v));
      bus.dispatch("amplitude", 0.2);
    } finally {
      console.error = prevError;
    }
    assert.deepEqual(seen, [0.2]);
  });

  t("dispose removes all listeners", () => {
    const bus = createFeatureBus();
    let count = 0;
    bus.subscribe("amplitude", () => { count += 1; });
    bus.dispose();
    bus.dispatch("amplitude", 0.1);
    assert.equal(count, 0);
  });

  t("dispatch to a feature with no subscribers is a no-op", () => {
    const bus = createFeatureBus();
    assert.doesNotThrow(() => bus.dispatch("amplitude", 0));
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
