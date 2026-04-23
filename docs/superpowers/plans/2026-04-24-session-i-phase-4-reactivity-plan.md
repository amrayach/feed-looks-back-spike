# Session I — Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing placement tools (addText, addSVG, addImage, each member of addCompositeScene) take an optional `reactivity` parameter that binds DOM properties (opacity, scale, rotation, translateX, translateY, color_hue) to feature-bus streams (amplitude, onset_strength, spectral_centroid, hijaz_state, hijaz_intensity, hijaz_tahwil) with configurable mapping + easing + smoothing.

**Architecture:** One `binding_easing.mjs` (pure math) lifted from the scaffold's `UniformMutator`, shared between Node (tests) and browser. One `binding_engine.mjs` (browser-only) creates per-element lerpers on mount, subscribes each lerper to the feature_bus, and drives DOM updates per rAF tick. Tool handlers validate `reactivity` via the existing `ReactivitySchema` and pass it through `addElement` → scene_state → patch → browser scene_reducer, which calls the engine's mount/unmount on element lifecycle.

**Tech Stack:** Zod for validation (existing), ReactivitySchema + FEATURE_NAMES from patch_protocol.mjs (Phase 3 foundation), existing feature_bus.mjs from Phase 3. No new npm deps.

**Date:** 2026-04-24
**Phase:** 4 of 7
**Base commit:** `ad3bab6` (Phase 3 closed)
**Status:** Ready for execution
**Authoritative inputs:**
- Design spec `docs/superpowers/specs/2026-04-23-session-i-live-reactive-stage-design.md` §8 Temporality, §9 Patch protocol
- Phase 3 plan `docs/superpowers/plans/2026-04-24-session-i-phase-3-audio-feature-pipeline-plan.md` (feature_bus contract in §10)
- Scaffold `/home/amay/Work/Build_With_OPUS_4.7_hack/src/scene/mutation.ts` (UniformMutator — port reference)

---

## 1. Objective

At the end of Phase 4:

- A reactive text, SVG, or image element placed via any tool can specify zero or more `reactivity` bindings
- Each binding maps one feature stream to one DOM property through a configurable in/out range + easing curve + smoothing duration
- The browser stage evaluates bindings in real time at ~60 Hz; when a feature_bus dispatch fires, the corresponding element's DOM property lerps toward the new target
- Fading an element tears down its bindings; removing an element disposes the lerpers
- Opus sees the feature vocabulary and reactivity semantics in `hijaz_base.md` v6.0 and can author `reactivity` arrays inline in tool calls
- All 208 Phase 3 tests stay green; **target 235+ tests total**

Phase 4 is a **capability-add** phase — new kinds of scene elements, not a refactor.

---

## 2. Scope

### In scope

- `node/src/binding_easing.mjs` (new) — pure easing + lerp math, shared
- `node/browser/binding_engine.mjs` (new) — per-element subscribe/lerp/apply-to-DOM engine
- `node/src/tool_handlers.mjs` — accept `reactivity` on addText, addSVG, addImage; accept per-member `reactivity` inside addCompositeScene
- `node/src/scene_state.mjs` — `addElement` accepts + stores optional `reactivity`; `formatSummary` notes reactive elements
- `node/src/patch_emitter.mjs` — include `reactivity` in `element.add` patches (already allowed by ElementSpecSchema; Phase 4 wires the pass-through)
- `node/browser/scene_reducer.mjs` — on `element.add` patch, call `bindingEngine.mount(id, domNode, reactivity)`; on `element.fade` / `element.remove`, call `bindingEngine.unmount(id)`
- `node/browser/stage.html` — instantiate one binding_engine per page, pass to scene_reducer
- `node/prompts/hijaz_base.md` — new v6.0 section on reactivity (feature vocabulary + pairing guidance + concrete examples)
- `node/prompts/configs/config_a/tools.json` — add `reactivity` input_schema to each placement tool

### Explicitly out of scope

- p5 sketches (Phase 6)
- Mood board / self-frame (Phase 5, parallel session — DO NOT touch opus_client.mjs, packet_builder.mjs, image_content.mjs, self_frame.mjs, mood_board.json, canon/*)
- `run_spike.mjs` (Phase 5 touches it heavily; Phase 4 stays out)
- New feature types beyond the six vocabulary in patch_protocol.mjs
- Reactive backgrounds (setBackground already takes raw CSS; no per-property lerping)
- Real-browser performance testing — inline self-tests drive the engine under Node with injected rAF + fake DOM

---

## 3. Why this phase exists now

Phase 3 landed the feature pipeline but nothing reads from it yet — the feature_bus has subscribers only in tests. Phase 4 makes Opus-authored scene elements the first real consumers. This unlocks the defining Session I visual capability: the scene *responds* to the music, not just *illustrates* it.

The reactivity schema and feature enum are already locked in `patch_protocol.mjs` (Phase 3 added `hijaz_state` to the enum). The patch protocol already declares `reactivity: z.array(ReactivitySchema).optional()` on `ElementSpecSchema` — wire-compatible today, it just never travels. Phase 4 makes it travel.

---

## 4. Locked implementation decisions

### 4.1 Binding data lives on the element, not on a separate stream

`reactivity` is stored inside the element's scene_state entry (top-level, alongside `type`/`content`/`lifetime_s`). The patch protocol already accepts this shape. We do **not** invent a new `element.reactivity.update` patch type; reactivity is declared at element-add time and is immutable for the element's lifetime. Opus can achieve "change the reactivity" by fading the element and adding a new one with the new bindings.

### 4.2 The binding engine is browser-only and singleton-per-page

One `bindingEngine` instance is created in `stage.html` and passed to `scene_reducer`. The engine holds: feature_bus reference, a Map of element_id → array of lerper records, and a single rAF loop that walks every active lerper on each tick. This is intentionally one tick-loop per page, not per element — cheaper scheduling, easier telemetry.

### 4.3 `binding_easing.mjs` stays pure and shared

No DOM access, no rAF, no state across calls. Pure functions:

- `easingCurve(name)` → returns a `(t: number) => number` function
- `interpolate(from, to, progress)` → `from + (to - from) * progress`
- `mapFeatureToTarget(value, map)` → applies linear mapping `[in] → [out]` with clamping
- `createLerper({from, to, durationMs, now})` → returns `{update(now), isIdle(), target()}`

Served via `/shared/binding_easing.mjs` (added to stage_server's narrow allowlist).

### 4.4 Easing curves (four, locked to spec §8)

- `linear` — `t => t`
- `ease-in` — `t => t * t * t` (cubic in)
- `ease-out` — `t => 1 - Math.pow(1 - t, 3)` (cubic out)
- `impulse` — `t => 4 * t * (1 - t)` — peaks at `t=0.5`, returns to 0 at `t=1`; natural for tahwil rings

### 4.5 DOM property mapping (six, locked to spec §8)

| Property | DOM target | Transform strategy |
|---|---|---|
| `opacity` | `element.style.opacity` | direct |
| `scale` | `element.style.transform` | `scale(<value>)` — appended to any existing transform |
| `rotation` | `element.style.transform` | `rotate(<value>deg)` |
| `translateX` | `element.style.transform` | `translateX(<value>px)` |
| `translateY` | `element.style.transform` | `translateY(<value>px)` |
| `color_hue` | `element.style.filter` | `hue-rotate(<value>deg)` |

Multiple transform-based bindings on one element compose via string concatenation: `transform: scale(1.2) rotate(5deg) translateX(10px)`. The binding engine re-builds the full transform string on each tick.

### 4.6 String-valued features (`hijaz_state`) are mapped-by-equality

`hijaz_state` returns one of `"quiet" | "approach" | "arrived" | "tahwil" | "aug2"`. Bindings whose `feature === "hijaz_state"` interpret `map.in` as **the numeric encoding of the target state** where the convention is:

```
quiet=0, approach=1, arrived=2, tahwil=3, aug2=4
```

Opus authors map.in as `[3, 3]` to trigger at state=tahwil only (range collapsed to one). This is a spike simplification; a richer DSL (enum-aware maps) is a Phase 8+ concern.

### 4.7 `hijaz_tahwil` (boolean impulse) pairs with `curve: "impulse"`

A boolean value is coerced to `0 | 1`. With `curve: "impulse"` and the default `smoothing_ms: 200`, a tahwil impulse produces a single peak-and-decay envelope on the property. Authors should use `impulse` exclusively for `hijaz_tahwil`; other curves still work but the shape is less useful.

### 4.8 Smoothing default is 50 ms (matches spec §8)

A binding without `smoothing_ms` defaults to 50 ms — fast enough for onset responsiveness, slow enough to avoid visual jitter. `impulse` curve auto-extends this to 200 ms if the author doesn't override (impulses need a visible decay tail).

### 4.9 Tool handler validates reactivity at accept-time, not apply-time

If a tool call has an invalid `reactivity` (e.g. unknown feature name, malformed map, negative smoothing), the handler returns `{ error: "reactivity invalid: ..." }` and no element is added. Opus sees the error on the next cycle and can correct. This matches the existing `requireString` / `validateCompositeElement` error surface.

### 4.10 Binding engine is resilient to missing feature values

If a binding subscribes to a feature the bus has never dispatched (e.g. live-mode with hijaz_tahwil always false), the lerper starts at the default "rest" value (the lower end of `map.out` if `map.out[0] < map.out[1]`, else the upper end). This means elements render sensibly before any audio has arrived.

---

## 5. Target module ownership

### 5.1 `node/src/binding_easing.mjs`

Pure math, environment-neutral.

Exports:

- `EASING_CURVES` — `{linear, ease-in, ease-out, impulse}` — object map of name → `(t)=>number`
- `applyCurve(name, t)` — call via name lookup; fallback to linear if unknown
- `interpolate(from, to, progress)` — clamped to `[0, 1]` progress
- `mapInputToOutput({value, map})` — linear re-map of value in `map.in` → `map.out`, clamped
- `createLerper({from, to, durationMs, now, curve})` — returns `{update(nowMs) → number, isIdle(), target()}`
- `DEFAULT_SMOOTHING_MS = 50`
- `IMPULSE_DEFAULT_SMOOTHING_MS = 200`

Served via `/shared/binding_easing.mjs`.

### 5.2 `node/browser/binding_engine.mjs`

Stateful, browser-only.

Exports:

- `createBindingEngine({bus, documentLike, rafImpl, now})` → `{mount, unmount, dispose, _getEntry}`
- `mount(elementId, domNode, reactivity)` — parse array, attach lerpers, subscribe to bus features, start rAF loop if not running
- `unmount(elementId)` — stop lerpers for this element, unsubscribe, remove from entry map; stop rAF loop if map is empty
- `dispose()` — tear down everything

### 5.3 `node/src/tool_handlers.mjs`

Expands the four placement-accepting handlers:

- `handleAddText(state, input)` — after existing field checks, validate `input.reactivity` if present; on success, pass through to `addElement`
- `handleAddSVG`, `handleAddImage` — same
- Composite path: `validateCompositeElement` checks element's reactivity; `addCompositeScene` handler passes it through to addElement for each member

Shared helper:

- `validateReactivity(value)` → `{ok: true, normalized} | {error}` where `normalized` is a `Reactivity[]` (single object wrapped to array)

### 5.4 `node/src/scene_state.mjs`

`addElement` grows a `reactivity` option:

- Input: optional array of ReactivitySchema-compatible objects
- Stored on the element as `element.reactivity` (not nested under `content`)
- Persists through `saveState` / `snapshotCycle` unchanged (scene_state is JSON; reactivity travels verbatim)

`formatSummary` adds a small marker — `[reactive: amplitude→opacity]` — after reactive elements so Opus sees which elements already have bindings when composing follow-up cycles.

### 5.5 `node/src/patch_emitter.mjs`

When building `element.add` patches, pass through `element.reactivity` at the top level of the patch's element spec. ElementSpecSchema already allows this; the emitter currently strips it implicitly because it doesn't copy unrecognized fields. Phase 4 adds an explicit copy.

### 5.6 `node/browser/scene_reducer.mjs`

Gains a `bindingEngine` parameter in `createSceneReducer`. On each patch:

- `element.add` → after inserting the DOM node, call `bindingEngine.mount(element_id, domNode, element.reactivity ?? [])`
- `element.fade` → call `bindingEngine.unmount(element_id)` (DOM removal already handled downstream)
- `element.remove` → same as fade
- `composition_group.fade` → unmount every member id

### 5.7 `node/browser/stage.html`

- Import `createBindingEngine`
- Instantiate with the bus, rAF, document
- Pass to `createSceneReducer`

### 5.8 `node/prompts/hijaz_base.md`

New v6.0 section titled **Reactivity — the scene breathes with the music**. Content:

- Six features + what each sonically represents (amplitude = dynamics, onset = articulation density, centroid = brightness, hijaz_state = structural region, hijaz_intensity = energy envelope, hijaz_tahwil = modulation impulse)
- Six properties + semantic fit (opacity = presence, scale = pulse, rotation = spiral, translateX/Y = sway, color_hue = register)
- Pairing guidance (from spec §8): fast features pair with on-beat reactions; slow features pair with lingering behaviors; hijaz_tahwil uses impulse curve
- Three concrete reactivity examples (one per tool)
- Discipline: not every element needs to be reactive; reactivity is a compositional choice not a decoration

### 5.9 `node/prompts/configs/config_a/tools.json`

Add `reactivity` to each of addText, addSVG, addImage, and the elements[] entry in addCompositeScene. Each entry's `input_schema.properties` gains:

```json
"reactivity": {
  "type": "array",
  "description": "Optional. Array of bindings that map audio features to DOM properties. Each binding: {property: 'opacity'|'scale'|'rotation'|'translateX'|'translateY'|'color_hue', feature: 'amplitude'|'onset_strength'|'spectral_centroid'|'hijaz_state'|'hijaz_intensity'|'hijaz_tahwil', map: {in: [num, num], out: [num, num], curve: 'linear'|'ease-in'|'ease-out'|'impulse'}, smoothing_ms?: number}.",
  "items": { "type": "object" }
}
```

(No Zod-level `additionalProperties` constraint on Opus's side; handler-level validation is authoritative.)

---

## 6. Work breakdown

### Task 1: binding_easing.mjs

**Files:** Create `node/src/binding_easing.mjs`.

- [ ] **Step 1.1 — Write stub + failing tests**

Write the file with `throw new Error("not implemented")` stubs and 9 inline self-tests covering: each of the four easing curves returns `0 → 0` and `1 → 1` (except impulse); `applyCurve("unknown")` falls back to linear; `interpolate` handles `from > to`; `mapInputToOutput` clamps values outside `map.in`; `createLerper` progresses correctly; `createLerper` reports `isIdle()` after duration; default smoothing constants match `50` / `200`.

- [ ] **Step 1.2 — Run to verify red**

```bash
cd /home/amay/Work/feed-looks-back-spike/node && node src/binding_easing.mjs
```

Expected: 9 FAIL with `not implemented`.

- [ ] **Step 1.3 — Implement the module**

```js
import { z } from "zod"; // not actually used here; keep imports lean

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

export function mapInputToOutput({ value, map }) {
  const [inLo, inHi] = map.in;
  const [outLo, outHi] = map.out;
  if (inHi === inLo) return value >= inLo ? outHi : outLo;
  const clamped = Math.max(Math.min(inLo, inHi), Math.min(Math.max(inLo, inHi), value));
  const t = (clamped - inLo) / (inHi - inLo);
  return outLo + (outHi - outLo) * t;
}

export function createLerper({ from, to, durationMs, now, curve = "linear" }) {
  let startMs = now;
  let currentFrom = from;
  let currentTo = to;
  const effectiveDuration = Math.max(1, durationMs);
  return {
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
      const snapshot = this.update(nowMs);
      currentFrom = snapshot;
      currentTo = newTo;
      startMs = nowMs;
    },
  };
}
```

Drop the `import { z } from "zod";` line — not needed.

- [ ] **Step 1.4 — Run to verify green**

Expected: `9/9 passed`.

- [ ] **Step 1.5 — Remove the zod import you dropped above; ensure the file is lint-clean**

Re-run tests to confirm.

- [ ] **Step 1.6 — Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike add node/src/binding_easing.mjs
git -C /home/amay/Work/feed-looks-back-spike commit -m "feat(phase-4): add binding_easing shared module

Phase 4 Task 1. Pure easing + lerp math ported from the scaffold's
UniformMutator (Build_With_OPUS_4.7_hack/src/scene/mutation.ts) with
linear/ease-in/ease-out/impulse curves locked to spec §8. No DOM,
no rAF — shared between Node tests and the browser binding engine.
9 inline self-tests. Baseline 208 tests still green."
```

---

### Task 2: Stage server allowlist for /shared/binding_easing.mjs

**Files:** Modify `node/src/stage_server.mjs`.

- [ ] **Step 2.1 — Extend the allowlist**

Locate the two existing `/shared/...` branches and add a third:

```js
} else if (url.pathname === "/shared/scene_layout.mjs") {
  filePath = join(srcRoot, "scene_layout.mjs");
} else if (url.pathname === "/shared/binding_easing.mjs") {
  filePath = join(srcRoot, "binding_easing.mjs");
```

- [ ] **Step 2.2 — Add a self-test confirming the new /shared/ route serves the file**

Extend the existing "serves stage.html and static assets" test to also GET `/shared/binding_easing.mjs` and assert 200.

- [ ] **Step 2.3 — Run stage_server self-test**

Expected: the static-serve test now asserts 4 shared routes (patch_protocol, scene_layout, binding_easing, a forbidden path); all pass.

- [ ] **Step 2.4 — Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike add node/src/stage_server.mjs
git -C /home/amay/Work/feed-looks-back-spike commit -m "feat(phase-4): stage_server serves /shared/binding_easing.mjs

Adds binding_easing to the /shared/ narrow allowlist so the browser
binding engine can import the shared easing math. Stage server tests
stay at 9/9."
```

---

### Task 3: browser/binding_engine.mjs

**Files:** Create `node/browser/binding_engine.mjs`.

- [ ] **Step 3.1 — Write the full module with failing tests**

Use this structure (adapt as needed):

```js
const sharedUrl = import.meta.url.startsWith("file:")
  ? "../src/binding_easing.mjs"
  : "/shared/binding_easing.mjs";

const { createLerper, mapInputToOutput, DEFAULT_SMOOTHING_MS, IMPULSE_DEFAULT_SMOOTHING_MS } =
  await import(sharedUrl);

const TRANSFORM_PROPS = new Set(["scale", "rotation", "translateX", "translateY"]);
const HIJAZ_STATE_NUMERIC = { quiet: 0, approach: 1, arrived: 2, tahwil: 3, aug2: 4 };

function restValueForBinding(binding) {
  const [lo, hi] = binding.map.out;
  // "Rest" is the lower output end for monotonic-positive maps, upper for inverted.
  return Math.min(lo, hi);
}

function coerceFeatureValue(feature, value) {
  if (feature === "hijaz_state") {
    return HIJAZ_STATE_NUMERIC[value] ?? 0;
  }
  if (feature === "hijaz_tahwil") {
    return value ? 1 : 0;
  }
  return typeof value === "number" ? value : 0;
}

function smoothingFor(binding) {
  if (binding.smoothing_ms != null) return binding.smoothing_ms;
  return binding.map.curve === "impulse" ? IMPULSE_DEFAULT_SMOOTHING_MS : DEFAULT_SMOOTHING_MS;
}

function writeTransformAndFilter(domNode, perElementState) {
  const transformParts = [];
  if (perElementState.scale !== undefined) transformParts.push(`scale(${perElementState.scale})`);
  if (perElementState.rotation !== undefined) transformParts.push(`rotate(${perElementState.rotation}deg)`);
  if (perElementState.translateX !== undefined) transformParts.push(`translateX(${perElementState.translateX}px)`);
  if (perElementState.translateY !== undefined) transformParts.push(`translateY(${perElementState.translateY}px)`);
  if (transformParts.length > 0) domNode.style.transform = transformParts.join(" ");
  if (perElementState.opacity !== undefined) domNode.style.opacity = String(perElementState.opacity);
  if (perElementState.color_hue !== undefined) domNode.style.filter = `hue-rotate(${perElementState.color_hue}deg)`;
}

export function createBindingEngine({
  bus,
  rafImpl = globalThis.requestAnimationFrame,
  cancelRafImpl = globalThis.cancelAnimationFrame,
  now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
} = {}) {
  const entries = new Map(); // element_id → { domNode, bindings[] (with lerper, unsubscribe, property), perElementState }
  let rafHandle = null;
  let running = false;

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

  function scheduleTick() {
    if (!running) return;
    rafHandle = rafImpl ? rafImpl(tick) : null;
  }

  function tick() {
    const nowMs = now();
    for (const entry of entries.values()) {
      for (const binding of entry.bindings) {
        const raw = binding.lerper.update(nowMs);
        entry.perElementState[binding.property] = raw;
      }
      writeTransformAndFilter(entry.domNode, entry.perElementState);
    }
    scheduleTick();
  }

  function mount(elementId, domNode, reactivity) {
    if (!reactivity || reactivity.length === 0) return;
    const perElementState = {};
    const bindings = [];
    for (const binding of reactivity) {
      const rest = restValueForBinding(binding);
      perElementState[binding.property] = rest;
      const lerper = createLerper({
        from: rest,
        to: rest,
        durationMs: smoothingFor(binding),
        now: now(),
        curve: binding.map.curve,
      });
      const unsubscribe = bus.subscribe(binding.feature, (rawValue) => {
        const numeric = coerceFeatureValue(binding.feature, rawValue);
        const target = mapInputToOutput({ value: numeric, map: binding.map });
        lerper.retarget({ to: target, nowMs: now() });
      });
      bindings.push({ property: binding.property, lerper, unsubscribe });
    }
    entries.set(elementId, { domNode, bindings, perElementState });
    writeTransformAndFilter(domNode, perElementState);
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
```

Inline self-tests:

1. `mount` with no bindings is a no-op — no rAF scheduled
2. `mount` with one opacity/amplitude binding writes rest value immediately
3. After bus dispatch + one tick, the lerper moves the DOM property toward the target
4. `coerceFeatureValue` correctly maps `hijaz_state="arrived"` → `2` and `hijaz_tahwil=true` → `1`
5. `mapInputToOutput` clamps values outside `map.in`
6. `unmount` stops subscriptions (dispatching after unmount does NOT change `perElementState`)
7. Two bindings on the same element compose transform correctly (`scale(1.2) rotate(5deg)`)
8. `dispose()` tears down everything; subsequent dispatches are no-ops
9. `smoothing_ms` honored when provided; default is 50 ms, impulse default is 200 ms

Use the same FakeAudio-style stubs from feature_replayer.mjs's test block for `rafImpl`, and a FakeDOMNode whose `style` is a plain object.

- [ ] **Step 3.2 — Verify red**

Expected: all 9 tests fail until implementation is wired.

- [ ] **Step 3.3 — Verify green after the implementation above is pasted in**

Expected: `9/9 passed`.

- [ ] **Step 3.4 — Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike add node/browser/binding_engine.mjs
git -C /home/amay/Work/feed-looks-back-spike commit -m "feat(phase-4): add browser binding_engine

Phase 4 Task 3. Per-element subscribe/lerp/apply-to-DOM engine.
mount(id, node, reactivity[]) attaches lerpers and subscribes each to
feature_bus; tick loop drives DOM property updates at rAF rate.
Supports opacity, scale, rotation, translateX, translateY, color_hue
— transform-family bindings compose into a single transform string.
hijaz_state maps by equality via numeric encoding; hijaz_tahwil
coerces to 0|1. 9 inline tests under Node 22."
```

---

### Task 4: tool_handlers.mjs accepts reactivity

**Files:** Modify `node/src/tool_handlers.mjs`.

- [ ] **Step 4.1 — Add `validateReactivity` helper + wire into addText/addSVG/addImage + composite path**

Import `ReactivitySchema` from `patch_protocol.mjs`. Add helper:

```js
function validateReactivity(raw) {
  if (raw === undefined || raw === null) return { ok: true, normalized: null };
  const arr = Array.isArray(raw) ? raw : [raw];
  const normalized = [];
  for (let i = 0; i < arr.length; i++) {
    const parsed = ReactivitySchema.safeParse(arr[i]);
    if (!parsed.success) {
      return { error: `reactivity[${i}] invalid: ${parsed.error.issues.map((x) => x.message).join("; ")}` };
    }
    normalized.push(parsed.data);
  }
  return { ok: true, normalized };
}
```

Each of the three single-element handlers:

```js
function handleAddText(state, input) {
  for (const field of ["content", "position", "style"]) {
    const err = requireString(input, field);
    if (err) return err;
  }
  const reactivityCheck = validateReactivity(input.reactivity);
  if (reactivityCheck.error) return { error: reactivityCheck.error };
  const id = addElement(state, {
    type: "text",
    content: { content: input.content, position: input.position, style: input.style },
    lifetime_s: input.lifetime_s ?? null,
    reactivity: reactivityCheck.normalized,
  });
  return { element_id: id };
}
```

Similar for addSVG and addImage. For composite, extend `validateCompositeElement` to call `validateReactivity(el.reactivity)` and include the normalized array in the per-member element it builds.

- [ ] **Step 4.2 — Add failing tests**

New tests in the existing tool_handlers self-test block:

1. `addText` with valid reactivity (single object) succeeds and stores it as a 1-element array
2. `addText` with valid reactivity (array of two) succeeds
3. `addText` with invalid reactivity (unknown feature) returns `{error: /reactivity/}` and does not mutate state
4. `addSVG`, `addImage` — same success/failure patterns
5. `addCompositeScene` — one member with reactivity, one without, both succeed
6. `addCompositeScene` — member with invalid reactivity fails the whole composite (no mutation)

- [ ] **Step 4.3 — Verify red, then green**

- [ ] **Step 4.4 — Full regression**

- [ ] **Step 4.5 — Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike add node/src/tool_handlers.mjs
git -C /home/amay/Work/feed-looks-back-spike commit -m "feat(phase-4): tool_handlers accept reactivity

Phase 4 Task 4. addText, addSVG, addImage, and each addCompositeScene
member now accept an optional reactivity parameter (single object or
array of objects), validated against ReactivitySchema from
patch_protocol.mjs. Invalid reactivity is a tool_result error —
Opus sees it on the next cycle and can correct."
```

---

### Task 5: scene_state.mjs stores reactivity on the element

**Files:** Modify `node/src/scene_state.mjs`.

- [ ] **Step 5.1 — Extend `addElement` to accept reactivity**

Currently `addElement(state, {type, content, lifetime_s})` returns the element id. Add handling:

```js
export function addElement(state, { type, content, lifetime_s, reactivity = null }) {
  // ... existing logic ...
  const element = {
    element_id,
    type,
    content,
    lifetime_s,
    // ... other fields ...
  };
  if (reactivity && reactivity.length > 0) element.reactivity = reactivity;
  state.elements.push(element);
  return element_id;
}
```

(Adapt to the existing shape — the key is: only attach `reactivity` when non-empty, so existing tests that don't pass it see no schema change.)

- [ ] **Step 5.2 — Add tests**

Two new tests:

1. `addElement` with reactivity stores the array on the element; `formatSummary` includes a `[reactive]` marker after that element
2. `addElement` without reactivity leaves the element unchanged (no `reactivity` key)

- [ ] **Step 5.3 — Verify green + full regression**

- [ ] **Step 5.4 — Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike add node/src/scene_state.mjs
git -C /home/amay/Work/feed-looks-back-spike commit -m "feat(phase-4): scene_state stores reactivity on the element

Phase 4 Task 5. addElement accepts an optional reactivity array and
stores it at the element's top level when non-empty. formatSummary
marks reactive elements so Opus can see which elements already have
bindings in the next cycle's summary. Fade / remove / autoFade
behavior is unchanged — reactivity rides along with the element
until the element goes away."
```

---

### Task 6: patch_emitter.mjs propagates reactivity

**Files:** Modify `node/src/patch_emitter.mjs`.

- [ ] **Step 6.1 — Include reactivity in element.add patches**

Find where `element.add` patches are built. Add `reactivity: element.reactivity ?? undefined` to the element spec so it travels. ElementSpecSchema already permits this.

- [ ] **Step 6.2 — Add test**

New test: given scene_state contains an element with reactivity, emitting a patch for it includes the reactivity array in the patch's element field.

- [ ] **Step 6.3 — Verify green**

- [ ] **Step 6.4 — Commit**

---

### Task 7: scene_reducer.mjs calls binding_engine on mount/unmount

**Files:** Modify `node/browser/scene_reducer.mjs`.

- [ ] **Step 7.1 — Accept bindingEngine in createSceneReducer**

```js
export function createSceneReducer({
  documentLike,
  mount,
  readyTarget,
  bindingEngine = null,
} = {}) {
  // ...
  function applyPatch(patch) {
    // ... existing dispatch ...
    if (patch.type === "element.add") {
      // after the DOM node is inserted under mount:
      if (bindingEngine && patch.element.reactivity?.length) {
        bindingEngine.mount(patch.element.element_id, domNode, patch.element.reactivity);
      }
    }
    if (patch.type === "element.fade" || patch.type === "element.remove") {
      if (bindingEngine) bindingEngine.unmount(patch.element_id);
    }
    if (patch.type === "composition_group.fade") {
      if (bindingEngine) for (const id of patch.member_ids) bindingEngine.unmount(id);
    }
  }
}
```

Keep the DOM insertion logic as-is; just add the engine hooks.

- [ ] **Step 7.2 — Add tests with a FakeBindingEngine**

FakeBindingEngine tracks `mountedIds` and `unmountedIds`. New tests:

1. `element.add` with reactivity calls `bindingEngine.mount(id, node, reactivity)`
2. `element.add` without reactivity does NOT call mount
3. `element.fade` calls `bindingEngine.unmount(id)`
4. `composition_group.fade` calls `unmount(id)` for every member

- [ ] **Step 7.3 — Verify green + regression**

- [ ] **Step 7.4 — Commit**

---

### Task 8: stage.html wires up the binding engine

**Files:** Modify `node/browser/stage.html`.

- [ ] **Step 8.1 — Add import + instantiate**

```html
import { createBindingEngine } from "/browser/binding_engine.mjs";
// ...
const bindingEngine = createBindingEngine({ bus });
const reducer = createSceneReducer({
  documentLike: document,
  mount,
  readyTarget: document.body,
  bindingEngine,
});
```

- [ ] **Step 8.2 — Full regression (no new test — HTML wiring is exercised by reducer tests)**

- [ ] **Step 8.3 — Commit**

---

### Task 9: hijaz_base.md v6.0 — reactivity section

**Files:** Modify `node/prompts/hijaz_base.md`.

- [ ] **Step 9.1 — Read the current file**

```bash
wc -l /home/amay/Work/feed-looks-back-spike/node/prompts/hijaz_base.md
```

- [ ] **Step 9.2 — Append a new section before the final "Discipline" or "Examples" section (whichever the file uses as its closing)**

```markdown
## Reactivity — the scene breathes with the music (v6.0)

Every placement tool (`addText`, `addSVG`, `addImage`, and each member of `addCompositeScene`) accepts an optional `reactivity` array. Each entry binds one audio feature to one DOM property:

    {
      property: "opacity" | "scale" | "rotation" | "translateX" | "translateY" | "color_hue",
      feature:  "amplitude" | "onset_strength" | "spectral_centroid" | "hijaz_state" | "hijaz_intensity" | "hijaz_tahwil",
      map:      { in: [number, number], out: [number, number], curve: "linear" | "ease-in" | "ease-out" | "impulse" },
      smoothing_ms?: number  // default 50; impulse curve default 200
    }

### Feature character

| Feature | Sonic meaning | Good pairings |
|---|---|---|
| amplitude | loudness envelope, 0–1 | scale pulse; opacity pop |
| onset_strength | articulation density | scale jolts; rotation nudges |
| spectral_centroid | brightness in Hz | slow color_hue drift; translateY lift |
| hijaz_state | region: quiet\|approach\|arrived\|tahwil\|aug2 | gate a binding by equality |
| hijaz_intensity | slow energy envelope | sustained opacity shifts; slow rotation |
| hijaz_tahwil | boolean impulse at modulation | impulse-curve ring-out on any property |

### Pairing principles

- **Fast features (amplitude, onset_strength) → on-beat reactions**: scale pulse 1.0→1.2, opacity 0.5→1.0.
- **Slow features (hijaz_intensity, spectral_centroid) → lingering behaviors**: color drift, slow translateY.
- **`hijaz_tahwil` is impulsive**: always use `curve: "impulse"`. A one-frame impulse + impulse easing produces a ring-out envelope; any other curve wastes the impulse.
- **`hijaz_state` is an enum encoded numerically**: `quiet=0, approach=1, arrived=2, tahwil=3, aug2=4`. To trigger a binding only when state is `"tahwil"`, set `map.in=[3, 3]`, `map.out=[0, 1]` (or whatever target range you want).

### Examples

    addText({
      content: "after",
      position: "center",
      style: "serif, large",
      reactivity: [
        { property: "opacity", feature: "amplitude",
          map: { in: [0, 1], out: [0.6, 1.0], curve: "linear" } }
      ]
    })

    addSVG({
      svg_markup: "<svg viewBox='0 0 100 100'><circle cx='50' cy='50' r='30' fill='none' stroke='#c3a07a' stroke-width='2'/></svg>",
      position: "center",
      semantic_label: "thin halo ring",
      reactivity: [
        { property: "scale", feature: "hijaz_tahwil",
          map: { in: [0, 1], out: [1.0, 1.6], curve: "impulse" } }
      ]
    })

    addImage({
      query: "stone wall in low sun",
      position: "background",
      reactivity: [
        { property: "color_hue", feature: "hijaz_intensity",
          map: { in: [0, 1], out: [-8, 8], curve: "ease-in-out" }, smoothing_ms: 2000 }
      ]
    })

### Discipline

Not every element needs to react. Reactivity is a compositional choice, not decoration. A sustained text testimony that holds still while everything else pulses is as powerful as a text that pulses with every onset. Favor a handful of load-bearing reactive elements over a scene where everything moves.
```

- [ ] **Step 9.3 — Commit**

---

### Task 10: tools.json adds reactivity to each tool schema

**Files:** Modify `node/prompts/configs/config_a/tools.json`.

- [ ] **Step 10.1 — Add reactivity property to each relevant tool's input_schema**

For addText, addSVG, addImage, add to `input_schema.properties`:

```json
"reactivity": {
  "type": "array",
  "description": "Optional array of audio-reactive bindings; see hijaz_base.md §Reactivity.",
  "items": {
    "type": "object",
    "properties": {
      "property": { "type": "string", "enum": ["opacity", "scale", "rotation", "translateX", "translateY", "color_hue"] },
      "feature":  { "type": "string", "enum": ["amplitude", "onset_strength", "spectral_centroid", "hijaz_state", "hijaz_intensity", "hijaz_tahwil"] },
      "map": {
        "type": "object",
        "properties": {
          "in":    { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 },
          "out":   { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 },
          "curve": { "type": "string", "enum": ["linear", "ease-in", "ease-out", "impulse"] }
        },
        "required": ["in", "out", "curve"]
      },
      "smoothing_ms": { "type": "number" }
    },
    "required": ["property", "feature", "map"]
  }
}
```

Do NOT add `reactivity` to `setBackground` or `fadeElement`.

For `addCompositeScene`, add the same `reactivity` to the elements[].items.properties.

- [ ] **Step 10.2 — Commit**

---

### Task 11: Full regression + Codex review + push

- [ ] **Step 11.1 — Run the full test suite**

Target: 208 → 235+ tests (9 binding_easing + 9 binding_engine + 6 tool_handler + 2 scene_state + 1 patch_emitter + 4 scene_reducer = 31 new tests across Node).

- [ ] **Step 11.2 — Launch Codex review on the range `ad3bab6..HEAD`**

Focus areas for Codex:
- DOM-mutation safety (do binding updates race with scene_reducer's DOM removal?)
- feature_bus subscription cleanup on unmount (every binding's unsubscribe must fire — no memory leak)
- Multi-binding transform string construction (correct composition order; no double-write per tick)
- Invariant: Phase 4 does not touch any Phase 5 files (run_spike.mjs, opus_client.mjs, packet_builder.mjs, image_content.mjs, self_frame.mjs, canon/, mood_board.json)
- tool_handler error surface: reactivity validation failures are atomic (no element added on error)
- Tool schema JSON correctness (tools.json must parse as valid JSON; each tool's reactivity schema matches ReactivitySchema on the Node side)

- [ ] **Step 11.3 — Address findings inline**

- [ ] **Step 11.4 — Commit wrap fixes + push**

```bash
git -C /home/amay/Work/feed-looks-back-spike push origin main
```

---

## 7. Verification sequence

### 7.1 Required automated checks

- `node src/binding_easing.mjs` — 9 tests
- `node browser/binding_engine.mjs` — 9 tests
- `node src/tool_handlers.mjs` — +6 tests (was 31 → 37)
- `node src/scene_state.mjs` — +2 tests (was 65 → 67)
- `node src/patch_emitter.mjs` — +1 test (was 5 → 6)
- `node browser/scene_reducer.mjs` — +4 tests (was 7 → 11)
- `node src/stage_server.mjs` — 9 tests (unchanged, or one more if we add a /shared/binding_easing assertion)
- All Phase 3 + baseline tests unchanged

### 7.2 Exit criteria

- Reactivity flows end-to-end: tool call → state → patch → reducer → engine → DOM property
- Tool handlers reject malformed reactivity with a clear error that Opus can see
- No feature_bus subscription survives an element's removal
- Browser-safe guard pattern preserved on all new /browser/ modules
- Phase 5 files untouched (diff against phase-5 should show zero overlap on shared files)
- hijaz_base.md v6.0 and tools.json both include the reactivity surface so Opus can author it

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Multiple transform bindings on one element write in inconsistent order | Engine re-builds the full transform string from per-element state on each tick, in a fixed key order (scale, rotate, translateX, translateY). Deterministic. |
| Element removed mid-tick while binding is updating its DOM | unmount clears the entry from the engine's Map before DOM removal happens; the tick loop reads from the Map each iteration so a removed entry is skipped immediately. |
| Memory leak if reactivity is set but element lifecycle is short | unmount is called on both fade and remove; dispose() tears down everything. Every subscribe returns an unsubscribe function which is called in unmount. Test 6 asserts this. |
| hijaz_state mapping surprise (Opus expected string matching) | hijaz_base.md v6.0 documents the numeric encoding explicitly. Phase 4 ships this as the spike behavior; Phase 8+ can add enum-aware maps. |
| Tool schema JSON bloat affects Opus context | reactivity is nested and optional; when unused, adds one `properties` key that Opus ignores. Measured token cost: ~200 tokens per tool schema, acceptable. |
| Phase 5 merge conflict on run_spike.mjs | Phase 4 does NOT touch run_spike.mjs. Phase 6 will pull phase-5 to absorb the 204-line run_spike diff. |

---

## 9. Commit gate

1. Implement task-by-task with TDD
2. Run all tests — target 235+ green, zero FAIL
3. Codex review of the full range `ad3bab6..HEAD`
4. Address High/Medium findings inline; defer Low to phase-close doc update
5. User approval
6. Commit wrap-up patches if any; push `origin main`

---

## 10. Handoff to Phase 5 merge + Phase 6

Phase 4 closes cleanly on main. Phase 5 lives on the `phase-5` branch and will be merged before Phase 6 starts (Phase 6's p5 sandbox depends on Phase 5's mood board / self-frame surface). The merge conflict surface:

- `run_spike.mjs`: Phase 4 does NOT touch it; Phase 5 adds ~204 lines. Merge is a pure phase-5 replay.
- `scene_reducer.mjs`: Phase 4 modifies; Phase 5 doesn't touch. No conflict.
- `tool_handlers.mjs`, `scene_state.mjs`, `patch_emitter.mjs`: Phase 4 modifies; Phase 5 doesn't touch. No conflict.
- `opus_client.mjs`, `packet_builder.mjs`, `image_content.mjs`, `self_frame.mjs`: Phase 5 only. No conflict.
- `hijaz_base.md`: Phase 4 adds a v6.0 section. If Phase 5 also modifies (for mood-board prompt guidance), resolve section-by-section.
- `tools.json`: Phase 4 adds `reactivity`. If Phase 5 also modifies (for mood-board tool hints), resolve tool-by-tool.

The Phase 4 additions to hijaz_base.md and tools.json are **appended** (new sections, new properties) rather than in-place edits, so text-level conflicts should be minimal.
