// node/src/binding_easing.mjs
// Pure easing + lerp math. Ported from the scaffold UniformMutator
// (Build_With_OPUS_4.7_hack/src/scene/mutation.ts) with the curve set
// locked to spec §8: linear, ease-in, ease-out, impulse.
//
// Shared between Node (tests) and browser (binding_engine). No DOM, no
// rAF, no hidden state — every function is referentially transparent
// except createLerper, which encapsulates its own lifecycle.

export const DEFAULT_SMOOTHING_MS = 50;
export const IMPULSE_DEFAULT_SMOOTHING_MS = 200;

export const EASING_CURVES = Object.freeze({
  linear: (t) => t,
  "ease-in": (t) => t * t * t,
  "ease-out": (t) => 1 - Math.pow(1 - t, 3),
  impulse: (t) => 4 * t * (1 - t),
});

export function applyCurve(name, t) {
  const fn = EASING_CURVES[name] ?? EASING_CURVES.linear;
  const clamped = Math.max(0, Math.min(1, t));
  return fn(clamped);
}

export function interpolate(from, to, progress) {
  const p = Math.max(0, Math.min(1, progress));
  return from + (to - from) * p;
}

// Linear map of `value` from map.in to map.out, clamped at the
// endpoints. Handles inverted ranges (map.in[0] > map.in[1]) correctly
// by normalizing against the span regardless of orientation.
export function mapInputToOutput({ value, map }) {
  const [inLo, inHi] = map.in;
  const [outLo, outHi] = map.out;
  if (inHi === inLo) {
    // Zero-width input range: exact-match gate. Only the pivot value
    // produces outHi; everything else (below OR above) returns outLo.
    // Rationale: collapsed map.in is used to gate a binding on a
    // specific enum state — e.g. hijaz_state == "tahwil" → map.in=[3,3].
    // Threshold semantics would wrongly fire on "aug2" (=4) as well.
    return value === inLo ? outHi : outLo;
  }
  const lo = Math.min(inLo, inHi);
  const hi = Math.max(inLo, inHi);
  const clamped = Math.max(lo, Math.min(hi, value));
  const t = (clamped - inLo) / (inHi - inLo);
  return outLo + (outHi - outLo) * t;
}

// Stateful lerp. createLerper is the only call that closes over state;
// consumers drive it via update(nowMs) and retarget({to, nowMs}).
export function createLerper({ from, to, durationMs, now, curve = "linear" }) {
  let startMs = now;
  let currentFrom = from;
  let currentTo = to;
  const effectiveDuration = Math.max(1, durationMs);
  const api = {
    update(nowMs) {
      const raw = (nowMs - startMs) / effectiveDuration;
      const eased = applyCurve(curve, raw);
      return interpolate(currentFrom, currentTo, eased);
    },
    isIdle(nowMs) {
      return nowMs - startMs >= effectiveDuration;
    },
    target() {
      return currentTo;
    },
    retarget({ to: newTo, nowMs }) {
      // Snapshot the current eased value and start a new lerp from
      // there. Prevents snap-back when a new target arrives mid-lerp.
      const snapshot = api.update(nowMs);
      currentFrom = snapshot;
      currentTo = newTo;
      startMs = nowMs;
    },
  };
  return api;
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

  t("EASING_CURVES.linear is identity", () => {
    assert.equal(EASING_CURVES.linear(0), 0);
    assert.equal(EASING_CURVES.linear(0.5), 0.5);
    assert.equal(EASING_CURVES.linear(1), 1);
  });

  t("ease-in and ease-out match their cubic definitions at 0.5", () => {
    assert.equal(EASING_CURVES["ease-in"](0), 0);
    assert.equal(EASING_CURVES["ease-in"](1), 1);
    assert.ok(EASING_CURVES["ease-in"](0.5) < 0.5, "ease-in should be slow at the start");
    assert.equal(EASING_CURVES["ease-out"](0), 0);
    assert.equal(EASING_CURVES["ease-out"](1), 1);
    assert.ok(EASING_CURVES["ease-out"](0.5) > 0.5, "ease-out should be fast at the start");
  });

  t("impulse peaks at t=0.5 and returns to 0 at t=0 and t=1", () => {
    assert.equal(EASING_CURVES.impulse(0), 0);
    assert.equal(EASING_CURVES.impulse(1), 0);
    assert.equal(EASING_CURVES.impulse(0.5), 1);
  });

  t("applyCurve clamps t to [0,1] and falls back to linear on unknown name", () => {
    assert.equal(applyCurve("linear", -0.5), 0);
    assert.equal(applyCurve("linear", 1.5), 1);
    // Unknown curve name falls back to linear (t=0.3 → 0.3)
    assert.equal(applyCurve("unknown-curve", 0.3), 0.3);
  });

  t("interpolate handles from > to (inverted range)", () => {
    assert.equal(interpolate(1, 0, 0), 1);
    assert.equal(interpolate(1, 0, 0.5), 0.5);
    assert.equal(interpolate(1, 0, 1), 0);
  });

  t("mapInputToOutput maps linearly across the input range", () => {
    const map = { in: [0, 1], out: [0.5, 1.0], curve: "linear" };
    assert.equal(mapInputToOutput({ value: 0, map }), 0.5);
    assert.equal(mapInputToOutput({ value: 0.5, map }), 0.75);
    assert.equal(mapInputToOutput({ value: 1, map }), 1.0);
  });

  t("mapInputToOutput clamps values outside map.in", () => {
    const map = { in: [0, 1], out: [0, 100], curve: "linear" };
    assert.equal(mapInputToOutput({ value: -5, map }), 0);
    assert.equal(mapInputToOutput({ value: 5, map }), 100);
  });

  t("mapInputToOutput treats zero-width input as exact-match (gates hijaz_state only on target)", () => {
    // map.in=[3, 3] encodes "only fire when value === 3 (tahwil)".
    // Above AND below the pivot return outLo — "aug2" (=4) must NOT
    // trigger a tahwil-gated binding, which is what the old threshold
    // semantics did.
    const map = { in: [3, 3], out: [0, 1], curve: "linear" };
    assert.equal(mapInputToOutput({ value: 2, map }), 0); // below pivot
    assert.equal(mapInputToOutput({ value: 3, map }), 1); // at pivot
    assert.equal(mapInputToOutput({ value: 4, map }), 0); // above pivot — must NOT fire
    // Continuous features with a collapsed range effectively never
    // fire unless the value lands exactly on the pivot — that's the
    // intended behavior for enum-gated bindings.
    assert.equal(mapInputToOutput({ value: 2.9999, map }), 0);
    assert.equal(mapInputToOutput({ value: 3.0001, map }), 0);
  });

  t("mapInputToOutput zero-width input respects the authored out tuple (not just [0,1])", () => {
    // authors can map the gate to any output — verify we're not hardcoding.
    const map = { in: [1, 1], out: [42, 99], curve: "linear" };
    assert.equal(mapInputToOutput({ value: 0, map }), 42);
    assert.equal(mapInputToOutput({ value: 1, map }), 99);
    assert.equal(mapInputToOutput({ value: 2, map }), 42);
  });

  t("createLerper advances from 'from' to 'to' over durationMs under linear curve", () => {
    const lerper = createLerper({ from: 0, to: 10, durationMs: 100, now: 0, curve: "linear" });
    assert.equal(lerper.update(0), 0);
    assert.equal(lerper.update(50), 5);
    assert.equal(lerper.update(100), 10);
    assert.equal(lerper.update(200), 10);
    assert.equal(lerper.target(), 10);
    assert.equal(lerper.isIdle(50), false);
    assert.equal(lerper.isIdle(100), true);
  });

  t("createLerper retarget snapshots current value and prevents snap-back", () => {
    const lerper = createLerper({ from: 0, to: 10, durationMs: 100, now: 0, curve: "linear" });
    lerper.update(50); // value at t=50 is 5
    lerper.retarget({ to: 0, nowMs: 50 });
    assert.equal(lerper.update(50), 5);
    assert.equal(lerper.update(100), 2.5);
    assert.equal(lerper.update(150), 0);
  });

  t("default smoothing constants match spec §8 (50ms, impulse 200ms)", () => {
    assert.equal(DEFAULT_SMOOTHING_MS, 50);
    assert.equal(IMPULSE_DEFAULT_SMOOTHING_MS, 200);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
