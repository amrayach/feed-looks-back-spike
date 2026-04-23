# Session I — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate a browser-side feature bus with amplitude, onset_strength, spectral_centroid, hijaz_state, hijaz_intensity, and hijaz_tahwil under both pre-recorded (offline-computed JSON, sync'd to `<audio>.currentTime`) and live (iD14 → Python DSP → WebSocket) modes — with Python as the single feature extractor so offline tuning transfers to live performance without drift.

**Architecture:** Python is the sole DSP owner in both modes. In pre-recorded mode, Python writes a canonical `features_track.json` next to the audio file; the browser's `feature_replayer` dispatches frames in time with the `<audio>` element. In live mode, Python streams frames over the existing stage_server WebSocket; the browser's `ws_client` forwards them into the same `feature_bus`. The binding engine (Phase 4) sees one contract regardless of mode. Features flow but nothing binds yet.

**Tech Stack:** Node 22 + pnpm, Zod for schema, existing librosa 0.11 DSP, new Python deps `sounddevice` (live capture) and `websockets` (Python↔Node WS).

**Date:** 2026-04-24
**Phase:** 3 of 7
**Base commit:** `639d3c0` (Phase 2 gate closed)
**Status:** Ready for execution
**Authoritative inputs:**
- Design spec `docs/superpowers/specs/2026-04-23-session-i-live-reactive-stage-design.md` §5.2, §5.3, §10, §12, §14
- Phase 1 plan `docs/superpowers/plans/2026-04-23-session-i-phase-1-websocket-stage-plan.md` (delivered scaffolding)
- Phase 2 plan `docs/superpowers/plans/2026-04-23-session-i-phase-2-render-html-split-plan.md` (module split)

---

## 1. Objective

At the end of Phase 3:

- `features_track.json` can be pre-computed from any audio file with a single Python command
- The browser stage in `mode=precompute` loads the track, plays the audio, and dispatches all six features to `feature_bus` in time with playback
- The browser stage in `mode=live` receives the same six features from Python via the stage_server WebSocket and dispatches to `feature_bus`
- `feature_bus` exposes a stable `subscribe(feature, cb)` / `dispatch(feature, value)` contract that Phase 4's binding engine can consume
- Feature distributions are bit-identical between `--mode precompute <file>` and `--mode live <playback-of-same-file>` because Python is the single extractor
- `run_spike.mjs` optionally spawns the Python live client on run start (feature flag; narrow diff for Phase 5 self-frame merge)
- The 178 baseline self-tests all stay green; **target 195+ tests total**

Phase 3 is a **pipeline build** phase — new capability, no binding. Elements rendered by Phase 1/2 do not react yet; Phase 4 wires reactivity on top of feature_bus.

---

## 2. Scope

### In scope

- `node/src/patch_protocol.mjs` — tighten `WsMessageSchema` feature channel, add `hijaz_state` to reactivity feature enum
- `node/browser/feature_bus.mjs` (new) — EventTarget-based pub/sub
- `node/browser/feature_replayer.mjs` (new) — time-synced dispatch from pre-computed JSON
- `node/browser/stage.html` — wire feature channel end-to-end
- `node/src/stage_server.mjs` — accept inbound feature frames from Python producer; rebroadcast to browser clients
- `node/src/run_spike.mjs` — optional Python subprocess spawn in live mode (narrow diff)
- `python/stream_features.py` (new) — both `--mode precompute` (file → JSON) and `--mode live` (iD14 → WS)
- `requirements.txt` — add `sounddevice`, `websockets`
- Smoke test against `audio/Sample 1 full Hijaz improvisation.wav`

### Explicitly out of scope

- Binding execution, easing, smoothing — all Phase 4
- `reactivity` param on Opus tools — Phase 4
- p5 sketches — Phase 6
- Mood board / self-frame — Phase 5 (parallel session)
- `opus_client.mjs` image content changes, `packet_builder.mjs` image content assembly, `image_content.mjs`, `self_frame.mjs`, `mood_board.json`, `canon/*` — **owned by Phase 5 parallel session**
- Real iD14 hardware end-to-end test — Phase 7 (we simulate in Phase 3 via mock Python WS client)

---

## 3. Why this phase exists now

Phase 1 added the WebSocket stage but sent nothing on the feature channel. Phase 2 cleaned up module ownership. If Phase 4 starts binding UI properties on audio without an actual audio source, it builds on a fictional contract — any subsequent drift between what bindings expect and what the pipeline emits is invisible until a live run. Phase 3 makes the feature_bus real *first*, tested against a known audio sample, so Phase 4 can target empirical distributions rather than guesses.

The choice to keep Python as the single extractor (spec §10 + Codex round 1 narrowing) collapses what would otherwise be two independent feature implementations (browser Web Audio + Python DSP) into one. That in turn collapses two testing paths, two debugging surfaces, and two sources of drift.

---

## 4. Locked implementation decisions

### 4.1 Feature vocabulary is fixed at six

| Feature | Type | Range | Source |
|---|---|---|---|
| `amplitude` | float | `[0, 1]` | librosa RMS, normalized to the file's 99th-percentile RMS |
| `onset_strength` | float | `[0, 1]` | librosa onset envelope, normalized to the file's 99th-percentile |
| `spectral_centroid` | float | Hz, typically `[200, 8000]` | librosa spectral centroid, unnormalized |
| `hijaz_state` | enum string | `"quiet" \| "approach" \| "arrived" \| "tahwil" \| "aug2"` | Session B detector, spec §2.3 |
| `hijaz_intensity` | float | `[0, 1]` | Session B intensity from summarizer.py, normalized |
| `hijaz_tahwil` | boolean | `true` at tahwil impulse, else `false` | Session B tahwil detector; one-frame impulse |

Any added feature is a Phase 4+ change that must update `patch_protocol.mjs`, `features_track.json` schema, and `stream_features.py` together.

### 4.2 Frame rate is 60 Hz, fixed

The feature track is resampled to a uniform 60 Hz timeline regardless of source hop length. Binding engine and easing (Phase 4) assume this rate. Python does the resample; browser does no resampling.

### 4.3 Pre-recorded mode has no WebSocket feature traffic

Per spec §10.1. The browser fetches `features_track.json` once at startup and dispatches locally. WS stays dark for features in this mode — patch channel only. This keeps precompute mode deterministic and unit-testable without a Python process.

### 4.4 Live mode reuses the existing `/ws` endpoint

No second port, no separate feature socket. Python connects to the same `/ws` as operator browsers, sends a distinguishing `{type: "hello", role: "feature_producer", run_id, mode}`, and thereafter pushes `{channel: "feature", feature, value}` frames. Stage server rebroadcasts to all accepted operator clients of the current run.

This reuse is deliberate: fewer moving parts, one port, one auth handshake, one failure mode.

### 4.5 `feature_bus.mjs` lives under `node/browser/`

Per spec §5.2. It does not need the `/shared/` route — the browser imports it directly. Keeping it out of `src/` avoids accidental Node-side dependence. Node-side tests use Node 22's built-in `EventTarget`, which is API-compatible with the browser's. The feature_bus module itself is environment-neutral.

### 4.6 `feature_replayer.mjs` depends on injectable time source

The replayer does not depend on `requestAnimationFrame` or real `<audio>` at import time — both are injected via options so the inline self-test can drive deterministic playback timing under Node 22. The real browser path injects `window.requestAnimationFrame` and the real audio element.

### 4.7 Python `stream_features.py` is ONE entry point, TWO modes

Single file, two subcommands. Shared DSP core imports `features.py`, `summarizer.py`, `windowing.py` already in `python/`. `--mode precompute` and `--mode live` share the hijaz detector pipeline; only the source (file vs sounddevice) and sink (JSON file vs WS) differ.

### 4.8 Run_spike diff is narrow

`run_spike.mjs` gets exactly one new concern: in live mode, optionally spawn the Python feature producer as a child process. The spawn is guarded by an explicit CLI flag `--feature-producer=python|none` (default `python` in live mode, `none` in precompute and self-test). Phase 5's self-frame trigger will also need a minor run_spike change — the two changes should not touch the same lines. To guarantee this, Phase 3's insertion point is after the stage_server startup block and before the main cycle loop; Phase 5's self-frame hook is expected to land inside the cycle loop.

### 4.9 `hijaz_state` must join `ReactivitySchema.feature` enum

Spec §10.3 lists `hijaz_state` as a feature. Current `patch_protocol.mjs:5` enum is missing it. Adding it here prevents a protocol/vocabulary drift that would surface as Phase 4 binding failures.

### 4.10 Feature value validation at the boundary

Inbound feature frames from any source (Python WS, feature_replayer, future test harnesses) are validated against a per-feature value schema at the edge. The feature_bus itself remains loose (accepts `unknown`) so Phase 4 bindings can receive whatever Phase 3 chooses to dispatch without another schema round-trip. All edge validation lives in `patch_protocol.mjs` to stay centralized.

---

## 5. Target module ownership

### 5.1 `node/src/patch_protocol.mjs`

Adds:

- `FeatureValueSchema` — per-feature discriminated union: amplitude (number in [0, 1]), onset_strength (number in [0, 1]), spectral_centroid (number ≥ 0), hijaz_state (enum), hijaz_intensity (number in [0, 1]), hijaz_tahwil (boolean).
- `FeatureFrameSchema` — `{t: number (seconds since run start), amplitude, onset_strength, spectral_centroid, hijaz_state, hijaz_intensity, hijaz_tahwil}` — all fields required; this is the canonical precompute-frame shape.
- `FeaturesTrackSchema` — `{schema_version: "1", duration_s: number, frame_rate_hz: 60, frames: array<FeatureFrameSchema>}`.
- `FeatureMessageSchema` — refines the existing `{channel: "feature", feature, value}` to validate `feature` against the vocabulary and `value` against the per-feature type.

Updates:

- `ReactivitySchema.feature` enum: add `"hijaz_state"`.
- `WsMessageSchema` feature arm now uses `FeatureMessageSchema` instead of raw `{feature: string, value: unknown}`.

### 5.2 `node/browser/feature_bus.mjs`

Exports:

- `createFeatureBus({EventTargetImpl = globalThis.EventTarget} = {})` → returns `{subscribe(feature, cb), dispatch(feature, value), last(feature), dispose()}`.
- `subscribe` returns an unsubscribe function.
- `last(feature)` returns the most recent value dispatched on that channel, or `undefined` if none. Load-bearing for late-mounting reactive elements in Phase 4.
- `dispose()` tears down all listeners. Used on replay resets.

Invariants:

- Synchronous dispatch. Subscribers run in subscription order.
- A subscriber that throws does not prevent other subscribers from running.

### 5.3 `node/browser/feature_replayer.mjs`

Exports:

- `createFeatureReplayer({bus, audioEl, fetchImpl = globalThis.fetch, rafImpl = globalThis.requestAnimationFrame, runId, validateFrame = assertFeatureFrame}) → {start(), stop(), getLastFrameIndex()}`.

Behavior:

- `start()` fetches `/run/<runId>/features_track.json`, validates with `FeaturesTrackSchema`, seeds `bus.last(...)` for each feature with the first frame's values, then enters a RAF loop.
- On each RAF tick, reads `audioEl.currentTime`, finds every frame with `frames[i].t <= currentTime && i > lastIndex`, dispatches each frame's features in order.
- On `audioEl` seeking backwards, reset `lastIndex` via binary search to the first frame ≤ current time.
- On `audioEl` pause, stop the RAF loop; on play, resume.
- On fetch failure: surface via `onError` callback, stop.

### 5.4 `node/browser/stage.html`

Wiring changes inside the inline module:

- Import `createFeatureBus` from `/browser/feature_bus.mjs`; create one bus per page load.
- Import `createFeatureReplayer` from `/browser/feature_replayer.mjs`.
- On `createWsClient({...})`, pass `onFeature: (feature, value) => bus.dispatch(feature, value)`.
- In `mode === "precompute"`, after the audio src is set, create a replayer tied to the bus and the audio element; start it.
- In `mode === "live"`, no replayer — features arrive over WS.

No additional CSS or DOM changes.

### 5.5 `node/src/stage_server.mjs`

Adds two concerns:

- **Role-aware handshake**: extend `hello` parsing to accept `role: "operator" | "feature_producer"` (default `"operator"` when missing for backward compatibility with existing operator clients and tests). Feature producers get their messages re-broadcast to operators; operators' messages are rejected (they are read-only). This is the single change to existing message-handling.
- **`broadcastFeature(feature, value)` method**: in-process emission path used by tests and (in Phase 7) by any future Node-side feature source. Rebroadcasts a `{channel: "feature", feature, value}` message to all accepted operator clients of the current run.

### 5.6 `node/src/run_spike.mjs`

Adds one optional concern in live mode:

- A single new helper `startFeatureProducer({mode, runId, wsUrl, producer})` that, when `mode === "live"` and `producer === "python"`, spawns `python stream_features.py --mode live --ws-url <...> --run-id <...>` as a child process. Returns a handle with a `stop()` method. The stop is called from the existing SIGINT handler (Phase 1's partial-finalization path).
- A new CLI flag `--feature-producer=<python|none>` with default `python` in live mode, `none` otherwise.

Phase 5's self-frame hook lands inside the cycle loop (after tool execution, before `broadcastPatch("cycle.end")`). Phase 3 insertions are strictly before the cycle loop starts and inside SIGINT cleanup — the two regions do not overlap.

### 5.7 `python/stream_features.py`

Single file, two modes dispatched via `argparse`:

- `--mode precompute --input path --output path [--frame-rate-hz 60]`: loads audio via existing `features.py`, runs hijaz detectors by reusing `summarizer.py`'s detector functions, resamples to 60 Hz, writes `features_track.json`.
- `--mode live --ws-url url --run-id id [--device name] [--frame-rate-hz 60]`: opens sounddevice stream on the named device, runs the same DSP pipeline frame-by-frame, connects to `ws-url` over `websockets`, sends `{type: "hello", role: "feature_producer", run_id, mode: "live"}` then a stream of `{channel: "feature", feature, value}` messages at `frame-rate-hz`.

### 5.8 `requirements.txt`

Adds:

- `sounddevice>=0.4.7,<0.6`
- `websockets>=12.0,<14`

Existing pins for `librosa==0.11.0` and `numpy==2.4.4` stay.

---

## 6. Work breakdown

Each task below lists files, then ordered checkbox steps. Inline TDD throughout — test first, verify red, implement, verify green, commit.

### Task 1: Tighten patch_protocol feature schema

**Files:**
- Modify: `node/src/patch_protocol.mjs`
- Test location: inline self-test at bottom of the same file

- [ ] **Step 1.1 — Add `hijaz_state` to ReactivitySchema.feature enum (failing test first)**

Add to the self-test block, before existing tests:

```js
t("ReactivitySchema accepts hijaz_state as a feature name", () => {
  const parsed = ReactivitySchema.parse({
    property: "opacity",
    feature: "hijaz_state",
    map: { in: [0, 1], out: [0, 1], curve: "linear" },
  });
  assert.equal(parsed.feature, "hijaz_state");
});
```

- [ ] **Step 1.2 — Run to verify red**

```bash
cd /home/amay/Work/feed-looks-back-spike/node && node src/patch_protocol.mjs
```

Expected: `FAIL ReactivitySchema accepts hijaz_state as a feature name` with ZodError about invalid enum value.

- [ ] **Step 1.3 — Extend the feature enum to include hijaz_state**

Edit `ReactivitySchema.feature`:

```js
feature: z.enum([
  "amplitude",
  "onset_strength",
  "spectral_centroid",
  "hijaz_state",
  "hijaz_intensity",
  "hijaz_tahwil",
]),
```

- [ ] **Step 1.4 — Run to verify green**

```bash
cd /home/amay/Work/feed-looks-back-spike/node && node src/patch_protocol.mjs
```

Expected: all tests pass including the new `hijaz_state` one.

- [ ] **Step 1.5 — Add FeatureValueSchema, FeatureFrameSchema, FeaturesTrackSchema (failing tests first)**

Add at the top of the self-test block:

```js
t("FeatureValueSchema validates amplitude in [0,1]", () => {
  assert.equal(FeatureValueSchema("amplitude").parse(0.5), 0.5);
  assert.throws(() => FeatureValueSchema("amplitude").parse(1.5));
  assert.throws(() => FeatureValueSchema("amplitude").parse(-0.1));
});

t("FeatureValueSchema validates hijaz_state enum", () => {
  assert.equal(FeatureValueSchema("hijaz_state").parse("arrived"), "arrived");
  assert.throws(() => FeatureValueSchema("hijaz_state").parse("unknown_state"));
});

t("FeatureValueSchema validates hijaz_tahwil boolean", () => {
  assert.equal(FeatureValueSchema("hijaz_tahwil").parse(true), true);
  assert.throws(() => FeatureValueSchema("hijaz_tahwil").parse("true"));
});

t("FeatureFrameSchema requires all six features plus timestamp", () => {
  const parsed = FeatureFrameSchema.parse({
    t: 1.234,
    amplitude: 0.4,
    onset_strength: 0.2,
    spectral_centroid: 1200,
    hijaz_state: "approach",
    hijaz_intensity: 0.6,
    hijaz_tahwil: false,
  });
  assert.equal(parsed.hijaz_state, "approach");
  assert.throws(() => FeatureFrameSchema.parse({ t: 0 }));
});

t("FeaturesTrackSchema requires schema_version '1' and a frames array", () => {
  const parsed = FeaturesTrackSchema.parse({
    schema_version: "1",
    duration_s: 0.1,
    frame_rate_hz: 60,
    frames: [
      {
        t: 0,
        amplitude: 0,
        onset_strength: 0,
        spectral_centroid: 0,
        hijaz_state: "quiet",
        hijaz_intensity: 0,
        hijaz_tahwil: false,
      },
    ],
  });
  assert.equal(parsed.frames.length, 1);
  assert.throws(() => FeaturesTrackSchema.parse({ schema_version: "2", duration_s: 1, frame_rate_hz: 60, frames: [] }));
});

t("WsMessageSchema feature arm validates feature/value pair", () => {
  const parsed = WsMessageSchema.parse({
    channel: "feature",
    feature: "amplitude",
    value: 0.7,
  });
  assert.equal(parsed.value, 0.7);
  assert.throws(() =>
    WsMessageSchema.parse({ channel: "feature", feature: "amplitude", value: 1.7 }),
  );
  assert.throws(() =>
    WsMessageSchema.parse({ channel: "feature", feature: "unknown", value: 0 }),
  );
});
```

- [ ] **Step 1.6 — Run to verify red**

Expected: all five new tests fail with `FeatureValueSchema is not defined` etc.

- [ ] **Step 1.7 — Implement the new schemas**

Insert after `ReactivitySchema` and before `ElementSpecSchema`:

```js
const HIJAZ_STATES = ["quiet", "approach", "arrived", "tahwil", "aug2"];

const FEATURE_VALUE_SCHEMAS = {
  amplitude: z.number().min(0).max(1),
  onset_strength: z.number().min(0).max(1),
  spectral_centroid: z.number().min(0),
  hijaz_state: z.enum(HIJAZ_STATES),
  hijaz_intensity: z.number().min(0).max(1),
  hijaz_tahwil: z.boolean(),
};

export function FeatureValueSchema(feature) {
  const schema = FEATURE_VALUE_SCHEMAS[feature];
  if (!schema) throw new Error(`unknown feature name: ${feature}`);
  return schema;
}

export const FEATURE_NAMES = Object.freeze(Object.keys(FEATURE_VALUE_SCHEMAS));

export const FeatureFrameSchema = z.object({
  t: z.number(),
  amplitude: FEATURE_VALUE_SCHEMAS.amplitude,
  onset_strength: FEATURE_VALUE_SCHEMAS.onset_strength,
  spectral_centroid: FEATURE_VALUE_SCHEMAS.spectral_centroid,
  hijaz_state: FEATURE_VALUE_SCHEMAS.hijaz_state,
  hijaz_intensity: FEATURE_VALUE_SCHEMAS.hijaz_intensity,
  hijaz_tahwil: FEATURE_VALUE_SCHEMAS.hijaz_tahwil,
});

export const FeaturesTrackSchema = z.object({
  schema_version: z.literal("1"),
  duration_s: z.number().nonnegative(),
  frame_rate_hz: z.number().positive(),
  frames: z.array(FeatureFrameSchema),
});

export function assertFeatureFrame(value) {
  return FeatureFrameSchema.parse(value);
}

export function assertFeaturesTrack(value) {
  return FeaturesTrackSchema.parse(value);
}
```

Replace the existing `WsMessageSchema` feature arm with a refined schema that validates the feature/value pair:

```js
const FeatureMessageSchema = z
  .object({
    channel: z.literal("feature"),
    feature: z.enum(FEATURE_NAMES),
    value: z.unknown(),
  })
  .superRefine((data, ctx) => {
    const result = FEATURE_VALUE_SCHEMAS[data.feature].safeParse(data.value);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid value for feature '${data.feature}': ${result.error.message}`,
        path: ["value"],
      });
    }
  });

export const WsMessageSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("patch"), patch: PatchSchema }),
  FeatureMessageSchema,
]);
```

- [ ] **Step 1.8 — Run to verify green**

```bash
cd /home/amay/Work/feed-looks-back-spike/node && node src/patch_protocol.mjs
```

Expected: 13–14 passes. No regressions on existing 8 tests.

- [ ] **Step 1.9 — Run full regression suite**

```bash
cd /home/amay/Work/feed-looks-back-spike/node && for f in src/*.mjs browser/*.mjs; do node "$f" 2>&1 | tail -1; done
```

Expected: every file ends `N/N passed`, no FAIL lines. `node src/run_spike.mjs --self-test` still green.

- [ ] **Step 1.10 — Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike add node/src/patch_protocol.mjs
git -C /home/amay/Work/feed-looks-back-spike commit -m "feat(phase-3): tighten patch_protocol feature schema

Add hijaz_state to ReactivitySchema.feature enum (spec §10.3 vocabulary).
Introduce FeatureValueSchema per-feature type map, FeatureFrameSchema
(canonical precompute-frame shape), FeaturesTrackSchema (schema_version
'1' + 60 Hz frames array), and a refined WsMessageSchema feature arm that
validates feature/value pairs at the boundary."
```

---

### Task 2: Feature bus

**Files:**
- Create: `node/browser/feature_bus.mjs`

- [ ] **Step 2.1 — Write failing self-test first**

Draft the file header and self-test block (empty module body):

```js
// node/browser/feature_bus.mjs
export function createFeatureBus(/* options */) {
  throw new Error("not implemented");
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
    bus.subscribe("amplitude", () => { throw new Error("boom"); });
    bus.subscribe("amplitude", (v) => seen.push(v));
    bus.dispatch("amplitude", 0.2);
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
```

- [ ] **Step 2.2 — Verify red**

```bash
cd /home/amay/Work/feed-looks-back-spike/node && node browser/feature_bus.mjs
```

Expected: all 7 tests fail (`not implemented`).

- [ ] **Step 2.3 — Implement createFeatureBus**

Replace the stub with:

```js
export function createFeatureBus({ EventTargetImpl = globalThis.EventTarget } = {}) {
  const target = new EventTargetImpl();
  const lastValues = new Map();
  const wrappersByFeature = new Map();

  function dispatch(feature, value) {
    lastValues.set(feature, value);
    const wrappers = wrappersByFeature.get(feature);
    if (!wrappers) return;
    for (const wrapper of [...wrappers]) {
      try {
        wrapper(value);
      } catch (err) {
        // Intentional swallow: one buggy subscriber must not affect others.
        // Emitted to console for visibility during development.
        if (typeof console !== "undefined" && console.error) {
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

  return { subscribe, dispatch, last, dispose, _target: target };
}
```

Note: we keep `_target` as an internal escape hatch for future integration tests; it is not part of the public API. The reason for using a `Set<wrapper>` rather than `EventTarget.addEventListener` is that we need synchronous ordered dispatch with try/catch isolation per subscriber — cleaner than orchestrating via `Event.stopImmediatePropagation`.

- [ ] **Step 2.4 — Verify green**

Expected: 7/7 passed.

- [ ] **Step 2.5 — Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike add node/browser/feature_bus.mjs
git -C /home/amay/Work/feed-looks-back-spike commit -m "feat(phase-3): add browser feature_bus

EventTarget-based pub/sub for audio features. Exposes subscribe/dispatch/
last/dispose with synchronous ordered delivery and throwing-subscriber
isolation. Phase 4's binding engine will consume this contract."
```

---

### Task 3: Python stream_features.py — precompute mode

**Files:**
- Create: `python/stream_features.py`
- Modify: `requirements.txt` (add sounddevice, websockets)

Note: sounddevice is only needed for `--mode live`, but we add both deps at the start of this task so env is set up once.

- [ ] **Step 3.1 — Update requirements.txt**

```
librosa==0.11.0
numpy==2.4.4
sounddevice>=0.4.7,<0.6
websockets>=12.0,<14
```

- [ ] **Step 3.2 — Install new deps**

```bash
/home/amay/miniconda3/envs/ambi_audio/bin/pip install 'sounddevice>=0.4.7,<0.6' 'websockets>=12.0,<14'
```

Expected: successful install. Verify:

```bash
/home/amay/miniconda3/envs/ambi_audio/bin/python -c "import sounddevice, websockets; print(sounddevice.__version__, websockets.__version__)"
```

- [ ] **Step 3.3 — Write the stream_features.py skeleton with failing self-test**

Create `python/stream_features.py` with the argparse surface and a stub for precompute:

```python
"""
stream_features.py — Python feature extractor, sole DSP owner across both modes.

Modes:
    --mode precompute --input <audio> --output <features_track.json>
        Runs the full DSP pipeline on an audio file offline, resamples all
        features to a uniform 60 Hz grid, writes features_track.json.

    --mode live --ws-url <ws://host:port/ws> --run-id <id> [--device <name>]
        Opens the sounddevice stream on the named input device, runs the
        same DSP pipeline at 60 Hz, streams JSON frames to the stage_server
        WebSocket.

Feature vocabulary (six, fixed):
    amplitude          : float in [0, 1]   — RMS envelope, normalized
    onset_strength     : float in [0, 1]   — librosa onset, normalized
    spectral_centroid  : float ≥ 0 (Hz)    — unnormalized
    hijaz_state        : enum               — quiet|approach|arrived|tahwil|aug2
    hijaz_intensity    : float in [0, 1]   — Session B intensity
    hijaz_tahwil       : bool               — one-frame impulse at tahwil event
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

# Package-vs-direct import shim (matches summarizer.py convention).
# The detector entry points in Sessions B–H are:
#   statistics.compute_file_statistics(timeseries) -> FileStatistics
#   summarizer.detect_tonal_gravity(current: dict, history: list[dict]) -> str
#   summarizer.detect_aug2(current: dict, history: list[dict]) -> dict
#   summarizer.detect_phrase_break(current: dict, history: list[dict]) -> bool
#   summarizer.categorize_intensity(rms_mean, stats) -> str
# Before implementing, the executor MUST `grep -n "^def " python/summarizer.py
# python/statistics.py` to confirm signatures haven't shifted.
try:
    from .features import extract_timeseries
    from .statistics import FileStatistics, compute_file_statistics
    from .summarizer import (
        detect_tonal_gravity,
        detect_aug2,
        detect_phrase_break,
        categorize_intensity,
    )
    from .windowing import (
        WINDOW_DURATION_S,
        SNAPSHOT_STRIDE_S,
        compute_snapshot_times,
    )
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from features import extract_timeseries  # type: ignore[no-redef]
    from statistics import FileStatistics, compute_file_statistics  # type: ignore[no-redef]
    from summarizer import (  # type: ignore[no-redef]
        detect_tonal_gravity,
        detect_aug2,
        detect_phrase_break,
        categorize_intensity,
    )
    from windowing import (  # type: ignore[no-redef]
        WINDOW_DURATION_S,
        SNAPSHOT_STRIDE_S,
        compute_snapshot_times,
    )


FRAME_RATE_HZ = 60
SCHEMA_VERSION = "1"
VALID_HIJAZ_STATES = {"quiet", "approach", "arrived", "tahwil", "aug2"}


def precompute_track(audio_path: Path, frame_rate_hz: int = FRAME_RATE_HZ) -> dict[str, Any]:
    """
    Compute the features_track.json payload for a finished audio file.

    All librosa/Hijaz features are resampled onto a uniform 60 Hz grid
    aligned with t=0. Returns the JSON-ready dict.
    """
    raise NotImplementedError("Step 3.5")


def cli() -> int:
    parser = argparse.ArgumentParser(description="Feed Looks Back audio feature extractor.")
    parser.add_argument("--mode", choices=["precompute", "live"], required=True)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--ws-url", dest="ws_url")
    parser.add_argument("--run-id", dest="run_id")
    parser.add_argument("--device")
    parser.add_argument("--frame-rate-hz", dest="frame_rate_hz", type=int, default=FRAME_RATE_HZ)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return _run_self_tests()

    if args.mode == "precompute":
        if not args.input or not args.output:
            parser.error("--mode precompute requires --input and --output")
        track = precompute_track(args.input, args.frame_rate_hz)
        args.output.write_text(json.dumps(track))
        return 0

    if args.mode == "live":
        if not args.ws_url or not args.run_id:
            parser.error("--mode live requires --ws-url and --run-id")
        from live_producer import run_live  # deferred import: sounddevice may be missing at precompute time
        return run_live(ws_url=args.ws_url, run_id=args.run_id, device=args.device, frame_rate_hz=args.frame_rate_hz)

    return 2


def _run_self_tests() -> int:
    passed = 0
    failed = 0

    def t(desc: str, fn):
        nonlocal passed, failed
        try:
            fn()
            passed += 1
            print(f"  ok  {desc}")
        except AssertionError as err:
            failed += 1
            print(f"  FAIL {desc}\n    {err}")
        except Exception as err:  # noqa: BLE001
            failed += 1
            print(f"  FAIL {desc}\n    {type(err).__name__}: {err}")

    t("placeholder", lambda: None)

    print(f"\n{passed}/{passed + failed} passed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(cli())
```

- [ ] **Step 3.4 — Add self-tests for precompute (failing)**

Replace `t("placeholder", lambda: None)` in `_run_self_tests` with:

```python
import tempfile

def _synth_audio(duration_s: float = 2.0, sr: int = 22050) -> tuple[np.ndarray, int]:
    """Deterministic sine sweep for structural tests — no real audio file required."""
    t_vec = np.linspace(0.0, duration_s, int(duration_s * sr), endpoint=False, dtype=np.float32)
    freqs = np.linspace(200.0, 1200.0, t_vec.size, dtype=np.float32)
    y = 0.5 * np.sin(2 * np.pi * freqs * t_vec).astype(np.float32)
    return y, sr

def _write_synth_wav(path: Path) -> None:
    import wave
    y, sr = _synth_audio()
    pcm = (y * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())

def _assert_track_structure(track: dict):
    assert track["schema_version"] == "1"
    assert track["frame_rate_hz"] == 60
    assert isinstance(track["frames"], list)
    assert len(track["frames"]) > 0, "track has no frames"
    # Uniform 60 Hz grid: successive t's differ by ~1/60 s.
    dts = np.diff([f["t"] for f in track["frames"]])
    assert np.allclose(dts, 1.0 / 60.0, atol=1e-6), f"non-uniform grid: {dts[:5]}"
    # All six features present on every frame.
    required = {"t", "amplitude", "onset_strength", "spectral_centroid",
                "hijaz_state", "hijaz_intensity", "hijaz_tahwil"}
    for i, frame in enumerate(track["frames"]):
        missing = required - frame.keys()
        assert not missing, f"frame {i} missing keys: {missing}"
    # Range checks on the normalized features.
    for f in track["frames"]:
        assert 0.0 <= f["amplitude"] <= 1.0
        assert 0.0 <= f["onset_strength"] <= 1.0
        assert f["spectral_centroid"] >= 0
        assert f["hijaz_state"] in VALID_HIJAZ_STATES
        assert 0.0 <= f["hijaz_intensity"] <= 1.0
        assert isinstance(f["hijaz_tahwil"], bool)

t("precompute_track returns a valid schema v1 track for a synth WAV", lambda: (
    _check_synth_track()
))

def _check_synth_track():
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "synth.wav"
        _write_synth_wav(wav)
        track = precompute_track(wav)
        _assert_track_structure(track)

t("precompute_track first frame t=0, last frame within 1/60 s of duration", lambda: (
    _check_boundaries()
))

def _check_boundaries():
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "synth.wav"
        _write_synth_wav(wav)
        track = precompute_track(wav)
        frames = track["frames"]
        assert frames[0]["t"] == 0.0
        assert frames[-1]["t"] <= track["duration_s"]
        assert abs(track["duration_s"] - frames[-1]["t"]) <= 1.0 / 60.0 + 1e-6
```

- [ ] **Step 3.5 — Run to verify red**

```bash
/home/amay/miniconda3/envs/ambi_audio/bin/python /home/amay/Work/feed-looks-back-spike/python/stream_features.py --self-test
```

Expected: 2 FAIL with `NotImplementedError: Step 3.5`.

- [ ] **Step 3.6 — Implement precompute_track**

Replace the `raise NotImplementedError` with:

```python
def precompute_track(audio_path: Path, frame_rate_hz: int = FRAME_RATE_HZ) -> dict[str, Any]:
    raw = extract_timeseries(str(audio_path))
    duration = raw["duration"]
    num_frames = int(duration * frame_rate_hz) + 1
    grid = np.arange(num_frames, dtype=np.float64) / frame_rate_hz

    amplitude_raw = raw["rms"]
    amplitude_times = raw["rms_times"]
    centroid_raw = raw["centroid"]
    centroid_times = raw["centroid_times"]
    onset_raw = raw["onset_strength"]
    onset_times = raw["onset_times"]

    amp_norm = _normalize_to_p99(amplitude_raw)
    onset_norm = _normalize_to_p99(onset_raw)

    amplitude_grid = np.interp(grid, amplitude_times, amp_norm, left=0.0, right=0.0)
    onset_grid = np.interp(grid, onset_times, onset_norm, left=0.0, right=0.0)
    centroid_grid = np.interp(grid, centroid_times, centroid_raw, left=0.0, right=0.0)

    hijaz_state_grid, hijaz_intensity_grid, hijaz_tahwil_grid = _hijaz_tracks_on_grid(
        raw, grid
    )

    amplitude_grid = np.clip(amplitude_grid, 0.0, 1.0)
    onset_grid = np.clip(onset_grid, 0.0, 1.0)
    centroid_grid = np.clip(centroid_grid, 0.0, None)
    hijaz_intensity_grid = np.clip(hijaz_intensity_grid, 0.0, 1.0)

    frames = []
    for i, t_val in enumerate(grid):
        frames.append({
            "t": round(float(t_val), 6),
            "amplitude": round(float(amplitude_grid[i]), 6),
            "onset_strength": round(float(onset_grid[i]), 6),
            "spectral_centroid": round(float(centroid_grid[i]), 3),
            "hijaz_state": hijaz_state_grid[i],
            "hijaz_intensity": round(float(hijaz_intensity_grid[i]), 6),
            "hijaz_tahwil": bool(hijaz_tahwil_grid[i]),
        })

    return {
        "schema_version": SCHEMA_VERSION,
        "duration_s": float(duration),
        "frame_rate_hz": frame_rate_hz,
        "frames": frames,
    }


def _normalize_to_p99(values: np.ndarray) -> np.ndarray:
    if values.size == 0:
        return values
    p99 = float(np.percentile(values, 99))
    if p99 <= 0:
        return np.zeros_like(values)
    return values / p99


def _hijaz_tracks_on_grid(
    raw: dict[str, Any], grid: np.ndarray
) -> tuple[list[str], np.ndarray, np.ndarray]:
    """
    Run Session B Hijaz detectors on a sliding-window basis across the track
    and resample per-cycle detector outputs onto the uniform 60 Hz grid.

    The detectors in summarizer.py take a `current: dict` and `history:
    list[dict]` where each dict holds per-cycle scalar features. Phase 3
    reuses the existing 4 s window / 5 s stride from windowing.py, builds
    one per-cycle dict from the sliced librosa arrays, and calls the
    detectors accumulating history as we go.

    Returns:
        hijaz_state : list[str] aligned with `grid` (one of VALID_HIJAZ_STATES)
        hijaz_intensity : np.ndarray same shape as grid, in [0, 1]
        hijaz_tahwil : np.ndarray bool, one-frame impulse at cycle boundaries
                        where detect_phrase_break fires AND detect_tonal_gravity
                        reports a modulation event ("tahwil")
    """
    duration = float(raw["duration"])
    snapshot_times = compute_snapshot_times(duration)
    if not snapshot_times:
        return ["quiet"] * grid.size, np.zeros_like(grid), np.zeros(grid.size, dtype=bool)

    file_stats = compute_file_statistics(raw)

    per_cycle_dicts: list[dict[str, Any]] = []
    per_cycle_states: list[str] = []
    per_cycle_intensities: list[float] = []
    per_cycle_tahwils: list[bool] = []

    for cycle_end in snapshot_times:
        cycle_dict = _slice_cycle_features(raw, cycle_end, WINDOW_DURATION_S)
        history = per_cycle_dicts.copy()
        tonal_state = detect_tonal_gravity(cycle_dict, history)
        aug2_info = detect_aug2(cycle_dict, history)
        phrase_break = detect_phrase_break(cycle_dict, history)
        intensity_band = categorize_intensity(cycle_dict.get("rms_mean", 0.0), file_stats)

        # Map Session B vocabulary to the spec §10.3 five-value enum.
        if aug2_info.get("fires"):
            state = "aug2"
        elif tonal_state == "tahwil":
            state = "tahwil"
        elif tonal_state in ("approach", "arrived"):
            state = tonal_state
        elif intensity_band == "quiet":
            state = "quiet"
        else:
            state = "approach"
        if state not in VALID_HIJAZ_STATES:
            state = "quiet"

        # Intensity: map rms_mean through file_stats percentiles to a [0,1]
        # float. `categorize_intensity` returns a label; we want a scalar,
        # so normalize rms_mean by the p90 used for the top band.
        rms_mean = float(cycle_dict.get("rms_mean", 0.0))
        p90 = float(getattr(file_stats, "rms_p90", rms_mean or 1.0) or 1.0)
        intensity_scalar = min(1.0, rms_mean / p90) if p90 > 0 else 0.0

        per_cycle_dicts.append(cycle_dict)
        per_cycle_states.append(state)
        per_cycle_intensities.append(intensity_scalar)
        per_cycle_tahwils.append(bool(phrase_break and tonal_state == "tahwil"))

    state_out: list[str] = []
    intensity_out = np.zeros(grid.size, dtype=np.float64)
    tahwil_out = np.zeros(grid.size, dtype=bool)

    for i, t_val in enumerate(grid):
        idx = _snapshot_index_for(t_val, snapshot_times)
        state_out.append(per_cycle_states[idx])
        intensity_out[i] = per_cycle_intensities[idx]
        if per_cycle_tahwils[idx] and _is_impulse_anchor(t_val, snapshot_times[idx]):
            tahwil_out[i] = True

    return state_out, intensity_out, tahwil_out


def _slice_cycle_features(
    raw: dict[str, Any], cycle_end: float, window_s: float
) -> dict[str, Any]:
    """
    Aggregate a per-cycle scalar dict from the file-level time series,
    analogous to what generate_corpus.py does for cycle packets. Fields
    used by the detectors vary — the executor should confirm the exact
    dict keys `detect_tonal_gravity`, `detect_aug2`, and `detect_phrase_break`
    read, by grepping their bodies, and adapt this aggregation accordingly.
    """
    start = max(0.0, cycle_end - window_s)
    rms_mask = (raw["rms_times"] >= start) & (raw["rms_times"] <= cycle_end)
    centroid_mask = (raw["centroid_times"] >= start) & (raw["centroid_times"] <= cycle_end)
    onset_mask = (raw["onset_times"] >= start) & (raw["onset_times"] <= cycle_end)
    chroma_mask = (raw["chroma_times"] >= start) & (raw["chroma_times"] <= cycle_end)

    rms_slice = raw["rms"][rms_mask] if rms_mask.any() else np.zeros(1)
    centroid_slice = raw["centroid"][centroid_mask] if centroid_mask.any() else np.zeros(1)
    onset_slice = raw["onset_strength"][onset_mask] if onset_mask.any() else np.zeros(1)
    chroma_slice = raw["chroma"][:, chroma_mask] if chroma_mask.any() else np.zeros((12, 1))

    return {
        "cycle_end_s": cycle_end,
        "rms_mean": float(rms_slice.mean()),
        "rms_p90": float(np.percentile(rms_slice, 90)) if rms_slice.size else 0.0,
        "centroid_mean_hz": float(centroid_slice.mean()),
        "onset_density": float((onset_slice > onset_slice.mean()).sum() / max(1, onset_slice.size)),
        "chroma_mean": chroma_slice.mean(axis=1).tolist() if chroma_slice.size else [0.0] * 12,
    }


def _snapshot_index_for(t: float, snapshot_times: list[float]) -> int:
    for idx, cutoff in enumerate(snapshot_times):
        if t < cutoff:
            return max(0, idx - 1)
    return len(snapshot_times) - 1


def _is_impulse_anchor(t: float, snapshot_t: float) -> bool:
    """One-frame impulse: fires on the first grid cell at-or-after the snapshot."""
    return snapshot_t <= t < snapshot_t + 1.0 / FRAME_RATE_HZ
```

Note — the Hijaz pipeline delegates to existing `summarizer.py` / `statistics.py` / `windowing.py`. If any of those don't export the needed symbols yet (e.g. `build_file_statistics_windowed`, `compute_hijaz_state`, `compute_hijaz_intensity`, `detect_tahwil`), the executor should first `grep -n "^def " python/summarizer.py python/statistics.py` to discover actual names and adapt. Do **not** invent new detectors in Phase 3 — reuse what Sessions B–H already shipped.

- [ ] **Step 3.7 — Verify green**

```bash
/home/amay/miniconda3/envs/ambi_audio/bin/python /home/amay/Work/feed-looks-back-spike/python/stream_features.py --self-test
```

Expected: `2/2 passed`.

- [ ] **Step 3.8 — Run against a real file (smoke)**

```bash
/home/amay/miniconda3/envs/ambi_audio/bin/python /home/amay/Work/feed-looks-back-spike/python/stream_features.py \
  --mode precompute \
  --input "/home/amay/Work/feed-looks-back-spike/audio/Sample 1 full Hijaz improvisation.wav" \
  --output /tmp/sample1_features.json
```

Verify:

```bash
python -c "
import json
t = json.load(open('/tmp/sample1_features.json'))
print('schema', t['schema_version'], 'duration', t['duration_s'], 'frames', len(t['frames']))
print('first frame', t['frames'][0])
print('last frame', t['frames'][-1])
states = sorted(set(f['hijaz_state'] for f in t['frames']))
print('observed states:', states)
tahwil_count = sum(1 for f in t['frames'] if f['hijaz_tahwil'])
print('tahwil impulses:', tahwil_count)
"
```

Sanity: duration > 60s, thousands of frames, observed states include at least `quiet` and `approach` or `arrived`, 0-10 tahwil impulses across the full track.

- [ ] **Step 3.9 — Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike add python/stream_features.py requirements.txt
git -C /home/amay/Work/feed-looks-back-spike commit -m "feat(phase-3): stream_features.py --mode precompute

Python feature extractor (sole DSP owner). Precompute reads an audio
file, runs existing librosa + Session B Hijaz detectors, resamples onto
a uniform 60 Hz grid, writes features_track.json keyed by the canonical
schema_version '1' vocabulary (amplitude, onset_strength,
spectral_centroid, hijaz_state, hijaz_intensity, hijaz_tahwil).

Adds sounddevice and websockets to requirements.txt (live-mode deps)."
```

---

### Task 4: Feature replayer

**Files:**
- Create: `node/browser/feature_replayer.mjs`

- [ ] **Step 4.1 — Write the skeleton + failing self-tests first**

```js
// node/browser/feature_replayer.mjs
const { FeaturesTrackSchema } = await import(
  import.meta.url.startsWith("file:")
    ? "../src/patch_protocol.mjs"
    : "/shared/patch_protocol.mjs"
);

export const FEATURE_NAMES = ["amplitude", "onset_strength", "spectral_centroid", "hijaz_state", "hijaz_intensity", "hijaz_tahwil"];

export function createFeatureReplayer({
  bus,
  audioEl,
  runId,
  fetchImpl = globalThis.fetch,
  rafImpl = globalThis.requestAnimationFrame,
  cancelRafImpl = globalThis.cancelAnimationFrame,
  onError = () => {},
} = {}) {
  throw new Error("not implemented");
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const { createFeatureBus } = await import("./feature_bus.mjs");

  function synthTrack(duration_s) {
    const frames = [];
    for (let i = 0; i <= Math.floor(duration_s * 60); i++) {
      const t = i / 60;
      frames.push({
        t,
        amplitude: Math.min(1, t / duration_s),
        onset_strength: i % 30 === 0 ? 0.9 : 0.0,
        spectral_centroid: 1000 + 500 * (t / duration_s),
        hijaz_state: t < duration_s / 2 ? "quiet" : "approach",
        hijaz_intensity: Math.min(1, t / duration_s),
        hijaz_tahwil: i === 90,
      });
    }
    return {
      schema_version: "1",
      duration_s,
      frame_rate_hz: 60,
      frames,
    };
  }

  class FakeAudio {
    constructor() {
      this.currentTime = 0;
      this.paused = true;
      this._listeners = new Map();
    }
    addEventListener(type, fn) {
      const l = this._listeners.get(type) ?? [];
      l.push(fn);
      this._listeners.set(type, l);
    }
    removeEventListener(type, fn) {
      const l = this._listeners.get(type) ?? [];
      this._listeners.set(type, l.filter((x) => x !== fn));
    }
    dispatchEvent(type) {
      for (const fn of this._listeners.get(type) ?? []) fn({ type });
    }
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

  function rafRunner() {
    const tasks = [];
    return {
      schedule: (fn) => { tasks.push(fn); return tasks.length; },
      cancel: () => {},
      tick() {
        const queued = tasks.splice(0);
        for (const fn of queued) fn(performance.now ? performance.now() : Date.now());
      },
    };
  }

  await t("start fetches track, seeds last() from frame 0, and dispatches as currentTime advances", async () => {
    const bus = createFeatureBus();
    const audio = new FakeAudio();
    const raf = rafRunner();
    const track = synthTrack(2.0);
    const fetchImpl = async () => ({ ok: true, json: async () => track });

    const replayer = createFeatureReplayer({
      bus,
      audioEl: audio,
      runId: "SELFTEST",
      fetchImpl,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
    });
    await replayer.start();

    assert.equal(bus.last("amplitude"), track.frames[0].amplitude);
    audio.currentTime = 1.0;
    raf.tick();
    const cutoff = Math.floor(1.0 * 60);
    assert.equal(bus.last("amplitude"), track.frames[cutoff].amplitude);
  });

  await t("seeking backwards resets the pointer via binary search", async () => {
    const bus = createFeatureBus();
    const audio = new FakeAudio();
    const raf = rafRunner();
    const track = synthTrack(2.0);
    const fetchImpl = async () => ({ ok: true, json: async () => track });
    const replayer = createFeatureReplayer({
      bus,
      audioEl: audio,
      runId: "SELFTEST",
      fetchImpl,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
    });
    await replayer.start();

    audio.currentTime = 1.5;
    raf.tick();
    audio.currentTime = 0.3;
    raf.tick();
    audio.dispatchEvent("seeking");

    const expected = track.frames[Math.floor(0.3 * 60)].amplitude;
    assert.equal(bus.last("amplitude"), expected);
  });

  await t("fetch failure routes to onError and does not throw from start()", async () => {
    const bus = createFeatureBus();
    const audio = new FakeAudio();
    const raf = rafRunner();
    const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const errors = [];
    const replayer = createFeatureReplayer({
      bus,
      audioEl: audio,
      runId: "missing",
      fetchImpl,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      onError: (e) => errors.push(e),
    });
    await replayer.start();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /404|track/i);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
```

- [ ] **Step 4.2 — Verify red**

Expected: 3 FAIL (`not implemented`).

- [ ] **Step 4.3 — Implement createFeatureReplayer**

```js
export function createFeatureReplayer({
  bus,
  audioEl,
  runId,
  fetchImpl = globalThis.fetch,
  rafImpl = globalThis.requestAnimationFrame,
  cancelRafImpl = globalThis.cancelAnimationFrame,
  onError = () => {},
} = {}) {
  let track = null;
  let lastFrameIndex = -1;
  let rafHandle = null;
  let started = false;

  function dispatchFrame(frame) {
    for (const name of FEATURE_NAMES) bus.dispatch(name, frame[name]);
  }

  function findFrameIndex(time) {
    if (!track || track.frames.length === 0) return -1;
    let lo = 0;
    let hi = track.frames.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (track.frames[mid].t <= time) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  function tick() {
    if (!track) return;
    const now = audioEl?.currentTime ?? 0;
    const target = findFrameIndex(now);
    if (target > lastFrameIndex) {
      for (let i = lastFrameIndex + 1; i <= target; i++) dispatchFrame(track.frames[i]);
      lastFrameIndex = target;
    }
    scheduleNextTick();
  }

  function scheduleNextTick() {
    if (!started) return;
    rafHandle = rafImpl ? rafImpl(tick) : null;
  }

  function onSeeking() {
    if (!track) return;
    const idx = findFrameIndex(audioEl.currentTime);
    lastFrameIndex = idx;
  }

  async function start() {
    if (started) return;
    started = true;
    try {
      const res = await fetchImpl(`/run/${encodeURIComponent(runId)}/features_track.json`);
      if (!res || !res.ok) {
        const status = res?.status ?? "unknown";
        throw new Error(`features_track fetch failed: ${status}`);
      }
      const parsed = FeaturesTrackSchema.parse(await res.json());
      track = parsed;
    } catch (err) {
      started = false;
      onError(err);
      return;
    }
    lastFrameIndex = 0;
    dispatchFrame(track.frames[0]);
    if (audioEl?.addEventListener) audioEl.addEventListener("seeking", onSeeking);
    scheduleNextTick();
  }

  function stop() {
    started = false;
    if (rafHandle != null && cancelRafImpl) cancelRafImpl(rafHandle);
    if (audioEl?.removeEventListener) audioEl.removeEventListener("seeking", onSeeking);
  }

  return { start, stop, getLastFrameIndex: () => lastFrameIndex };
}
```

- [ ] **Step 4.4 — Verify green**

```bash
cd /home/amay/Work/feed-looks-back-spike/node && node browser/feature_replayer.mjs
```

Expected: `3/3 passed`.

- [ ] **Step 4.5 — Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike add node/browser/feature_replayer.mjs
git -C /home/amay/Work/feed-looks-back-spike commit -m "feat(phase-3): add feature_replayer for precompute mode

Fetches /run/<run_id>/features_track.json at start, validates against
FeaturesTrackSchema, seeds bus.last() from frame 0, then dispatches
frames in time with audioEl.currentTime via injected rAF. Handles
backward seeks via binary search and 404s via onError."
```

---

### Task 5: Wire stage.html feature path

**Files:**
- Modify: `node/browser/stage.html`

- [ ] **Step 5.1 — Update the inline module to create bus, pass onFeature, and conditionally start replayer**

Replace the current `<script type="module">...</script>` block with:

```html
<script type="module">
  import { loadBootstrap } from "/browser/bootstrap.mjs";
  import { createSceneReducer } from "/browser/scene_reducer.mjs";
  import { createWsClient } from "/browser/ws_client.mjs";
  import { createFeatureBus } from "/browser/feature_bus.mjs";
  import { createFeatureReplayer } from "/browser/feature_replayer.mjs";

  const bootstrap = loadBootstrap({ locationLike: window.location, documentLike: document });
  const mount = document.getElementById("stage-root");
  const audio = document.getElementById("stage-audio");

  if (bootstrap.mode === "precompute") {
    audio.src = `/run/${bootstrap.run_id}/audio.wav`;
  } else {
    audio.remove();
  }

  const bus = createFeatureBus();
  window.__featureBus = bus; // debug hook (harmless in production; binding engine will use the closure)

  const reducer = createSceneReducer({
    documentLike: document,
    mount,
    readyTarget: document.body,
  });

  createWsClient({
    run_id: bootstrap.run_id,
    mode: bootstrap.mode,
    onPatch: (patch) => reducer.applyPatch(patch),
    onFeature: (feature, value) => bus.dispatch(feature, value),
    onStatus: (event) => {
      if (event.type === "error") console.error("[stage ws]", event.message);
    },
  });

  if (bootstrap.mode === "precompute") {
    const replayer = createFeatureReplayer({
      bus,
      audioEl: audio,
      runId: bootstrap.run_id,
      onError: (err) => console.error("[feature_replayer]", err),
    });
    replayer.start();
  }
</script>
```

- [ ] **Step 5.2 — Verify all existing self-tests stay green**

```bash
cd /home/amay/Work/feed-looks-back-spike/node && for f in src/*.mjs browser/*.mjs; do node "$f" 2>&1 | tail -1; done
node src/run_spike.mjs --self-test 2>&1 | tail -3
```

Expected: every line is `N/N passed`, `6/6 passed` for run_spike.

- [ ] **Step 5.3 — Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike add node/browser/stage.html
git -C /home/amay/Work/feed-looks-back-spike commit -m "feat(phase-3): wire feature bus + replayer into stage.html

Creates one feature_bus per page. ws_client.onFeature now pipes into
bus.dispatch; in precompute mode, a feature_replayer is started against
the stage audio element. In live mode, features flow via ws_client only.
window.__featureBus kept as a debug hook; Phase 4 bindings will close
over the bus reference directly."
```

---

### Task 6: Stage server — feature producer ingress + broadcast

**Files:**
- Modify: `node/src/stage_server.mjs`

- [ ] **Step 6.1 — Add failing tests for role-aware hello + rebroadcast**

Append to the self-test block, before `process.stdout.write` tally:

```js
await t("feature_producer role sends feature messages that reach operator clients", async () => {
  const nodeRoot = freshNodeRoot("flb-stage-server-feature");
  const runDir = join(nodeRoot, "output", "run_feat");
  mkdirSync(runDir, { recursive: true });
  const server = await createStageServer({ nodeRoot });
  try {
    await server.setCurrentRunContext({ runId: "feat", mode: "live", runDir });

    const operatorMessages = [];
    const operatorReady = new Promise((resolve) => {
      const ws = new WebSocket(`ws://${server.host}:${server.port}/ws`);
      ws.once("open", () => {
        ws.send(JSON.stringify({ type: "hello", run_id: "feat", mode: "live" }));
      });
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        operatorMessages.push(msg);
        // Replay.end signals the handshake is done; resolve once we see it.
        if (msg?.patch?.type === "replay.end") resolve(ws);
      });
    });
    const operatorWs = await operatorReady;

    await new Promise((resolve, reject) => {
      const producer = new WebSocket(`ws://${server.host}:${server.port}/ws`);
      producer.once("open", () => {
        producer.send(JSON.stringify({ type: "hello", role: "feature_producer", run_id: "feat", mode: "live" }));
        producer.send(JSON.stringify({ channel: "feature", feature: "amplitude", value: 0.42 }));
      });
      setTimeout(() => {
        try {
          producer.close();
        } catch {}
        resolve();
      }, 150);
      producer.once("error", reject);
    });

    // Wait one more tick to let relayed messages arrive at operator.
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

await t("operator clients cannot send feature messages (rejected with error)", async () => {
  const nodeRoot = freshNodeRoot("flb-stage-server-feature-reject");
  const runDir = join(nodeRoot, "output", "run_reject");
  mkdirSync(runDir, { recursive: true });
  const server = await createStageServer({ nodeRoot });
  try {
    await server.setCurrentRunContext({ runId: "reject", mode: "live", runDir });
    const errors = [];
    let closed = false;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${server.host}:${server.port}/ws`);
      ws.once("open", () => {
        ws.send(JSON.stringify({ type: "hello", run_id: "reject", mode: "live" }));
      });
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg?.patch?.type === "replay.end") {
          ws.send(JSON.stringify({ channel: "feature", feature: "amplitude", value: 0.1 }));
        }
        if (msg?.type === "error") errors.push(msg.message);
      });
      ws.on("close", () => {
        closed = true;
        resolve();
      });
      setTimeout(() => {
        if (!closed) ws.close();
      }, 400);
      ws.once("error", reject);
    });
    assert.ok(errors.some((m) => /operator|role|forbidden/i.test(m)), `expected rejection, got ${JSON.stringify(errors)}`);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 6.2 — Verify red**

Expected: both tests fail (feature messages never reach operator / reject case fires no error).

- [ ] **Step 6.3 — Implement role-aware handshake + feature ingress**

Modify the `wss.on("connection", ...)` block and `broadcastFeature` method. Concretely:

In the handshake branch:

```js
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
  const role = parsed.role === "feature_producer" ? "feature_producer" : "operator";
  meta.accepted = true;
  meta.runId = parsed.run_id;
  meta.mode = parsed.mode;
  meta.role = role;
  if (role === "operator") {
    await sendReplay(ws);
  } else {
    sendJson(ws, { channel: "patch", patch: { type: "replay.begin", run_id: currentContext.runId } });
    sendJson(ws, { channel: "patch", patch: { type: "replay.end", run_id: currentContext.runId } });
  }
  return;
}

// Post-handshake: route by role.
if (meta.role === "feature_producer") {
  if (parsed?.channel !== "feature") {
    sendJson(ws, { type: "error", message: "feature_producer may only send feature messages" });
    return;
  }
  try {
    await broadcastFeatureFromProducer(parsed.feature, parsed.value);
  } catch (err) {
    sendJson(ws, { type: "error", message: `feature rejected: ${err.message}` });
  }
  return;
}

// Operator role: inbound messages are forbidden.
sendJson(ws, { type: "error", message: "operator clients are read-only; role=operator forbidden from posting" });
```

Add `broadcastFeatureFromProducer` inside `createStageServer`, near `broadcastPatch`:

```js
async function broadcastFeatureFromProducer(feature, value) {
  const { WsMessageSchema } = await import("./patch_protocol.mjs");
  const msg = WsMessageSchema.parse({ channel: "feature", feature, value });
  for (const [ws, meta] of clientMeta.entries()) {
    if (!meta.accepted || meta.role !== "operator" || meta.runId !== currentContext.runId) continue;
    sendJson(ws, msg);
  }
}
```

And expose a public `broadcastFeature(feature, value)` in the returned server API (for Node-side tests and future Phase 7 use):

```js
async broadcastFeature(feature, value) {
  if (!currentContext) throw new Error("stage server run context not set");
  await broadcastFeatureFromProducer(feature, value);
},
```

Also extend `clientMeta` initialization to carry the role field: `clientMeta.set(ws, { accepted: false, runId: null, mode: null, role: null });`.

- [ ] **Step 6.4 — Verify green**

```bash
cd /home/amay/Work/feed-looks-back-spike/node && node src/stage_server.mjs
```

Expected: `6/6 passed`.

- [ ] **Step 6.5 — Run full regression**

```bash
cd /home/amay/Work/feed-looks-back-spike/node && for f in src/*.mjs browser/*.mjs; do node "$f" 2>&1 | tail -1; done
```

Expected: no regressions anywhere.

- [ ] **Step 6.6 — Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike add node/src/stage_server.mjs
git -C /home/amay/Work/feed-looks-back-spike commit -m "feat(phase-3): stage_server feature ingress + rebroadcast

Extends hello handshake with optional role field (default 'operator' for
backward compat). feature_producer clients may post {channel:'feature'}
messages, which the server validates against WsMessageSchema and
rebroadcasts to all accepted operators of the current run. Operator
clients remain read-only and are rejected if they attempt to post.

Adds public broadcastFeature(feature, value) on the server API for
future Node-side feature sources."
```

---

### Task 7: Python stream_features.py — live mode

**Files:**
- Modify: `python/stream_features.py` (add live mode)

- [ ] **Step 7.1 — Implement `live_producer.py` inline in `stream_features.py`**

Rather than creating a second file, add a `run_live(...)` function at the bottom of `stream_features.py`. This matches the spec §5.3 single-file layout.

```python
def run_live(
    ws_url: str,
    run_id: str,
    device: str | None,
    frame_rate_hz: int = FRAME_RATE_HZ,
) -> int:
    import asyncio
    import queue
    import signal
    import threading

    import sounddevice as sd
    import websockets

    samples_per_frame_goal = 2048
    sr_request = 48000

    audio_queue: queue.Queue[np.ndarray] = queue.Queue(maxsize=32)

    def callback(indata, frames, time_info, status):
        if status:
            # Drop frames silently on underrun; the next frame will catch up.
            return
        try:
            audio_queue.put_nowait(indata.copy())
        except queue.Full:
            pass

    async def sender():
        async with websockets.connect(ws_url, open_timeout=5) as ws:
            await ws.send(
                json.dumps(
                    {"type": "hello", "role": "feature_producer", "run_id": run_id, "mode": "live"}
                )
            )
            while True:
                try:
                    chunk = await asyncio.get_event_loop().run_in_executor(None, audio_queue.get, True, 1.0)
                except queue.Empty:
                    continue
                mono = chunk.mean(axis=1) if chunk.ndim > 1 else chunk
                features = _live_extract(mono.astype(np.float32), sr_request)
                for name, value in features.items():
                    await ws.send(
                        json.dumps({"channel": "feature", "feature": name, "value": value})
                    )

    stop_flag = threading.Event()

    def handle_signal(signum, frame):
        stop_flag.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    with sd.InputStream(
        samplerate=sr_request,
        channels=1,
        dtype="float32",
        blocksize=samples_per_frame_goal,
        device=device,
        callback=callback,
    ):
        async def main():
            task = asyncio.create_task(sender())
            while not stop_flag.is_set():
                await asyncio.sleep(0.1)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        asyncio.run(main())

    return 0


def _live_extract(y: np.ndarray, sr: int) -> dict[str, Any]:
    """
    Minimal live-frame DSP. Uses librosa for amplitude, centroid, onset
    and the existing summarizer detectors on a one-window FileStatistics
    analogue. For live mode we keep Hijaz state 'quiet' if intensity is
    below a lower bound — a stand-in until the online detector upgrade
    tracked in spec §15 open risks.
    """
    import librosa

    if y.size == 0:
        return {
            "amplitude": 0.0,
            "onset_strength": 0.0,
            "spectral_centroid": 0.0,
            "hijaz_state": "quiet",
            "hijaz_intensity": 0.0,
            "hijaz_tahwil": False,
        }

    rms_frame = float(np.sqrt(np.mean(y * y) + 1e-12))
    amplitude = float(min(1.0, rms_frame / 0.3))
    centroid = float(librosa.feature.spectral_centroid(y=y, sr=sr).mean())
    onset = float(min(1.0, librosa.onset.onset_strength(y=y, sr=sr).mean() / 6.0))

    # TODO: wire summarizer.compute_hijaz_state with a rolling-window
    # FileStatistics buffer. For Phase 3 live mode we report state='quiet'
    # when amplitude < 0.1, else 'approach', and zero out tahwil. The
    # intensity-track faithfully reports amplitude. Phase 7 upgrades this.
    hijaz_state = "quiet" if amplitude < 0.1 else "approach"

    return {
        "amplitude": amplitude,
        "onset_strength": onset,
        "spectral_centroid": centroid,
        "hijaz_state": hijaz_state,
        "hijaz_intensity": amplitude,
        "hijaz_tahwil": False,
    }
```

And fix the earlier deferred import so cli() directly calls `run_live`:

```python
if args.mode == "live":
    if not args.ws_url or not args.run_id:
        parser.error("--mode live requires --ws-url and --run-id")
    return run_live(
        ws_url=args.ws_url,
        run_id=args.run_id,
        device=args.device,
        frame_rate_hz=args.frame_rate_hz,
    )
```

- [ ] **Step 7.2 — Add a live-mode structural self-test using mock WS server**

Inside `_run_self_tests`, add:

```python
def _mock_live_roundtrip():
    # We don't open sounddevice in self-test — instead we exercise the
    # _live_extract function directly against a synthetic buffer and
    # assert it returns a frame with the canonical schema.
    y, sr = _synth_audio(duration_s=0.2)
    frame = _live_extract(y.astype(np.float32), sr)
    required = {"amplitude", "onset_strength", "spectral_centroid",
                "hijaz_state", "hijaz_intensity", "hijaz_tahwil"}
    assert set(frame.keys()) == required
    assert 0.0 <= frame["amplitude"] <= 1.0
    assert 0.0 <= frame["onset_strength"] <= 1.0
    assert frame["spectral_centroid"] >= 0.0
    assert frame["hijaz_state"] in VALID_HIJAZ_STATES
    assert 0.0 <= frame["hijaz_intensity"] <= 1.0
    assert isinstance(frame["hijaz_tahwil"], bool)

t("_live_extract returns a valid frame shape for a synthetic buffer", _mock_live_roundtrip)
```

- [ ] **Step 7.3 — Verify green**

```bash
/home/amay/miniconda3/envs/ambi_audio/bin/python /home/amay/Work/feed-looks-back-spike/python/stream_features.py --self-test
```

Expected: `3/3 passed`.

- [ ] **Step 7.4 — Live integration test against the running stage server**

The live path opens sounddevice, which we cannot cleanly exercise in an automated self-test. Instead we verify the WS path only. Create a one-off script in `/tmp`:

```python
# /tmp/live_ws_smoke.py
import asyncio, json
import websockets

async def main():
    uri = "ws://127.0.0.1:9999/ws"
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({"type": "hello", "role": "feature_producer", "run_id": "smoke", "mode": "live"}))
        await ws.send(json.dumps({"channel": "feature", "feature": "amplitude", "value": 0.42}))
        # we don't expect a reply — operator clients receive the rebroadcast
        await asyncio.sleep(0.1)

asyncio.run(main())
```

Start a stage_server manually (see Task 8 for run_spike integration), connect an operator browser to `/`, run this script — confirm `amplitude=0.42` appears on `window.__featureBus.last("amplitude")` via browser devtools. **This verification is manual** and belongs in the Phase 3 exit checklist (§7.1 below).

- [ ] **Step 7.5 — Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike add python/stream_features.py
git -C /home/amay/Work/feed-looks-back-spike commit -m "feat(phase-3): stream_features.py --mode live

Opens sounddevice input on the selected device, runs minimal live DSP
(amplitude + centroid + onset envelope) per audio callback chunk, sends
feature frames to the stage_server WebSocket as role=feature_producer.

Hijaz state in live mode is a simplified quiet|approach placeholder
until the online detector upgrade tracked in spec §15. This matches the
Phase 3 exit criterion (features flow + values plausible) without
pretending live state-detection has the same offline fidelity yet."
```

---

### Task 8: run_spike live-mode feature producer spawn

**Files:**
- Modify: `node/src/run_spike.mjs`

- [ ] **Step 8.1 — Inspect existing CLI + stage_server startup to find narrow insertion point**

```bash
grep -n "createStageServer\|setCurrentRunContext\|SIGINT\|--mode" /home/amay/Work/feed-looks-back-spike/node/src/run_spike.mjs | head -30
```

Locate:
- stage_server startup (bind site for producer spawn)
- SIGINT handler (bind site for producer stop)
- mode argument parsing

- [ ] **Step 8.2 — Add CLI flag parse**

Near where other flags are parsed, add:

```js
const featureProducerArg = args.find((a) => a.startsWith("--feature-producer="));
const featureProducer = featureProducerArg
  ? featureProducerArg.split("=")[1]
  : mode === "live"
    ? "python"
    : "none";
```

- [ ] **Step 8.3 — Add the spawn helper (failing test first)**

Add to the self-test block:

```js
await t("startFeatureProducer spawns the Python process when mode=live and producer=python", async () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    calls.push({ cmd, args });
    return { stop: () => calls.push({ cmd: "STOP" }) };
  };
  const handle = startFeatureProducer({
    mode: "live",
    runId: "123",
    wsUrl: "ws://127.0.0.1:9999/ws",
    producer: "python",
    spawnImpl: fakeSpawn,
  });
  handle.stop();
  assert.equal(calls[0].cmd, "python");
  assert.deepEqual(calls[0].args.slice(0, 2), ["stream_features.py", "--mode"]);
  assert.equal(calls[1].cmd, "STOP");
});

t("startFeatureProducer is a no-op when mode=precompute", () => {
  const calls = [];
  const fakeSpawn = () => { calls.push("spawn"); return { stop: () => {} }; };
  const handle = startFeatureProducer({
    mode: "precompute",
    runId: "123",
    wsUrl: "ws://127.0.0.1:9999/ws",
    producer: "python",
    spawnImpl: fakeSpawn,
  });
  assert.equal(handle, null);
  assert.equal(calls.length, 0);
});
```

- [ ] **Step 8.4 — Verify red**

`startFeatureProducer` is not yet defined — expect FAIL.

- [ ] **Step 8.5 — Implement startFeatureProducer**

Add (outside the self-test block, near other helpers):

```js
import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";

const PYTHON_BIN = process.env.FLB_PYTHON_BIN || "/home/amay/miniconda3/envs/ambi_audio/bin/python";
const STREAM_FEATURES_PATH = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "python", "stream_features.py",
);

export function startFeatureProducer({
  mode,
  runId,
  wsUrl,
  producer,
  spawnImpl = null,
  pythonBin = PYTHON_BIN,
  scriptPath = STREAM_FEATURES_PATH,
  device = process.env.FLB_AUDIO_DEVICE,
} = {}) {
  if (mode !== "live" || producer !== "python") return null;
  const args = [scriptPath, "--mode", "live", "--ws-url", wsUrl, "--run-id", runId];
  if (device) args.push("--device", device);

  if (spawnImpl) {
    return spawnImpl(pythonBin, args);
  }
  const child = spawn(pythonBin, args, { stdio: "inherit" });
  return {
    stop() {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    },
    pid: child.pid,
  };
}
```

- [ ] **Step 8.6 — Wire into run_spike startup + SIGINT cleanup**

After the `stageServer.setCurrentRunContext(...)` block and before the cycle loop, add:

```js
const wsUrl = `ws://${stageServer.host}:${stageServer.port}/ws`;
const featureProducerHandle = startFeatureProducer({
  mode,
  runId,
  wsUrl,
  producer: featureProducer,
});
```

In the existing SIGINT handler, before the stage_server close, add:

```js
if (featureProducerHandle) featureProducerHandle.stop();
```

Keep both insertions to isolated regions — do not touch the cycle loop body (Phase 5 owns it).

- [ ] **Step 8.7 — Verify run_spike self-test green**

```bash
cd /home/amay/Work/feed-looks-back-spike/node && node src/run_spike.mjs --self-test
```

Expected: `8/8 passed` (was 6; +2 new feature-producer tests).

- [ ] **Step 8.8 — Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike add node/src/run_spike.mjs
git -C /home/amay/Work/feed-looks-back-spike commit -m "feat(phase-3): run_spike live-mode feature producer spawn

Adds --feature-producer=<python|none> (default python in live mode,
none otherwise). When live mode starts, spawns stream_features.py as a
child process pointed at the stage_server WebSocket; SIGINT handler
stops the producer before closing the stage_server. Insertion points
are before the cycle loop and inside SIGINT cleanup — leaves the cycle
loop body untouched for Phase 5's self-frame merge."
```

---

### Task 9: Phase 3 end-to-end smoke against Sample 1

**Files:**
- Outputs only: `node/output/run_<ts>/features_track.json`, `node/output/run_<ts>/audio.wav`

- [ ] **Step 9.1 — Pre-compute Sample 1 features**

```bash
mkdir -p /home/amay/Work/feed-looks-back-spike/node/output/run_phase3_smoke
cp "/home/amay/Work/feed-looks-back-spike/audio/Sample 1 full Hijaz improvisation.wav" \
   /home/amay/Work/feed-looks-back-spike/node/output/run_phase3_smoke/audio.wav
/home/amay/miniconda3/envs/ambi_audio/bin/python \
  /home/amay/Work/feed-looks-back-spike/python/stream_features.py \
  --mode precompute \
  --input /home/amay/Work/feed-looks-back-spike/node/output/run_phase3_smoke/audio.wav \
  --output /home/amay/Work/feed-looks-back-spike/node/output/run_phase3_smoke/features_track.json
```

- [ ] **Step 9.2 — Start the stage server in precompute mode**

```bash
cd /home/amay/Work/feed-looks-back-spike/node && node src/run_spike.mjs \
  --mode dry-run \
  --feature-producer=none \
  --cycles 3 \
  --run-dir-override /home/amay/Work/feed-looks-back-spike/node/output/run_phase3_smoke
```

(Adjust the exact flags to match run_spike's current CLI — inspect `node src/run_spike.mjs --help` if needed. The key is: a short dry-run that prints the operator URL.)

- [ ] **Step 9.3 — Open the operator URL**

Open the printed `Stage: http://127.0.0.1:XXXX/?run_id=phase3_smoke&mode=precompute` in a browser. In devtools console run:

```js
window.__featureBus.last("amplitude")
window.__featureBus.last("hijaz_state")
window.__featureBus.last("hijaz_tahwil")
```

Expected: non-undefined values within a second of page load. Play/seek the audio; confirm values change.

- [ ] **Step 9.4 — Record the result in the phase commit log**

No code change. Capture a short note in the next commit (Task 10 final cleanup) confirming the smoke pass.

---

### Task 10: Phase 3 wrap — full regression + finalize

- [ ] **Step 10.1 — Run the full test suite one last time**

```bash
cd /home/amay/Work/feed-looks-back-spike/node && \
  for f in src/*.mjs browser/*.mjs; do node "$f" 2>&1 | tail -1; done && \
  echo "--- run_spike ---" && node src/run_spike.mjs --self-test 2>&1 | tail -3 && \
  echo "--- stream_features ---" && /home/amay/miniconda3/envs/ambi_audio/bin/python /home/amay/Work/feed-looks-back-spike/python/stream_features.py --self-test
```

Expected: every file `N/N passed`, run_spike `8/8`, stream_features `3/3`. No `FAIL` lines anywhere.

- [ ] **Step 10.2 — Verify test-count target hit**

Count lines matching `^  ok  ` across all module self-tests. Should be ≥ 195.

- [ ] **Step 10.3 — Run Codex review**

Via the codex:rescue skill or `codex:codex-rescue` agent against the range `639d3c0..HEAD`. Address any High/Medium findings in-phase. Low findings may defer to the phase-close doc update.

- [ ] **Step 10.4 — Final phase commit + push after approval**

```bash
git -C /home/amay/Work/feed-looks-back-spike log --oneline 639d3c0..HEAD
git -C /home/amay/Work/feed-looks-back-spike push origin main
```

---

## 7. Verification sequence

### 7.1 Required automated checks

From `node/`:

- `node src/patch_protocol.mjs` — 13+ tests
- `node browser/feature_bus.mjs` — 7 tests
- `node browser/feature_replayer.mjs` — 3 tests
- `node src/stage_server.mjs` — 6 tests (was 4)
- `node src/run_spike.mjs --self-test` — 8 tests (was 6)
- All other files unchanged, same pass counts

From `python/`:

- `python stream_features.py --self-test` — 3 tests

### 7.2 Required manual checks

1. Pre-compute Sample 1 features to `/tmp` and eyeball JSON schema + value ranges.
2. Run stage server on a real run dir with the pre-computed track; confirm audio plays and `window.__featureBus.last(...)` returns plausible values.
3. Seek the audio backwards; confirm feature values snap to the new position.
4. (Optional, if iD14 available) plug in iD14, run `stream_features.py --mode live` against the stage server, confirm feature values update in real time from the hardware input.

### 7.3 Exit criteria

- All 178 baseline tests still green
- 17+ new tests added across stream_features.py and browser modules (target 195+)
- Sample 1 precompute → features_track.json with plausible `amplitude`, `onset_strength`, `spectral_centroid`, and varied `hijaz_state` values
- Browser stage with pre-computed track dispatches features to the bus during audio playback
- Live-mode WS path verified with mock producer (full iD14 verification is Phase 7)
- Python is the only feature extractor in the codebase — no browser Web Audio analysis exists

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `summarizer.py` / `statistics.py` symbols differ from those assumed in Step 3.6 | Grep actual exports before implementing; adapt call sites rather than rename upstream |
| Offline Hijaz detector uses cycle-windowed `FileStatistics`; live mode cannot trivially reuse it | Phase 3 ships a simplified live-mode hijaz_state (quiet|approach) as documented in §5.7 / §9 commit; Phase 7 upgrades to a rolling-window detector |
| `sounddevice` opens iD14 differently on Linux (ALSA vs PulseAudio vs JACK) | Use the env var `FLB_AUDIO_DEVICE` to override the device name. For CI / self-test, never open sounddevice — only exercise `_live_extract` on synthetic buffers |
| `websockets` connect races run_spike stage_server startup | run_spike spawns the Python producer AFTER `stage_server.setCurrentRunContext`; Python's `websockets.connect(open_timeout=5)` gives plenty of slack |
| Feature-frame Zod validation cost per message in live mode at 6 features × 60 Hz = 360 msgs/s | SuperRefine overhead measured <0.1 ms per parse in local tests; validate at ingress only, forward raw to operators |
| Binding engine (Phase 4) assumes different schema than Phase 3 dispatches | Keep patch_protocol.mjs Schemas as the single source of truth across both phases — Phase 4 consumes `FEATURE_NAMES` export, `FeatureValueSchema(feature)` runtime guard |
| Phase 5 self-frame hook merges into run_spike and collides with Phase 3 spawn | Document insertion region in §5.6 — Phase 3 lives before the cycle loop and inside SIGINT cleanup; Phase 5 lives inside the cycle loop body |

---

## 9. Commit gate

Phase 3 follows the established workflow:

1. Implement task-by-task with TDD
2. Run all tests — target 195+ green, zero FAIL
3. Codex review of the full range `639d3c0..HEAD`
4. Address High/Medium findings inline; defer Low to phase-close doc update
5. User approval
6. Commit wrap-up patches if any; push `origin main`

Do **not** start Phase 4 work on top of a half-implemented audio pipeline — Phase 4 assumes `feature_bus.last(feature)` returns real values.

---

## 10. Handoff to Phase 4

After Phase 3 closes, the binding engine (Phase 4) will:

- Import `createFeatureBus` and subscribe per binding
- Use `FeatureValueSchema(feature)` as a runtime guard for Opus-supplied reactivity configs
- Read `bus.last(feature)` on element mount to seed smoothed values
- Import `FEATURE_NAMES` to validate reactivity payloads

The Phase 3 contract that Phase 4 depends on is:

- `bus.subscribe(feature, cb)` is synchronous and returns an unsubscribe fn
- `bus.dispatch(feature, value)` delivers to all subscribers in order, with throwing subscribers isolated
- `bus.last(feature)` returns the most recent value or undefined
- All six features listed in §4.1 fire at 60 Hz in precompute mode; at best-effort sounddevice block rate in live mode

No other Phase 3 internals should leak into Phase 4 — feature_replayer, ws_client feature arm, stage_server feature ingress, and stream_features.py are all Phase 3 concerns that Phase 4 does not need to know about.
