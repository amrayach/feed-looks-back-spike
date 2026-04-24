# Session I — Phase 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Opus two new placement tools — `setP5Background` (one ambient sketch slot) and `addP5Sketch` (up to three localized slots) — whose sketches execute as sandboxed, audio-aware p5.js canvases. Sketches depict recognizable things (lanterns, textiles, calligraphic strokes), never abstract flow-fields; safety comes from iframe sandboxing + CSP + a heartbeat watchdog. Features flow from Phase 3's feature_bus into each sketch via `postMessage` at ~60 Hz.

**Architecture:** p5.min.js is vendored (npm install p5 → served at `/vendor/p5/`). Each sketch runs inside an iframe whose `srcdoc` inlines p5 source + the sketch code + a feature-bridge listener. The host (`p5_sandbox.mjs`) posts `{type:"features", values:{...}}` frames from the feature_bus and watches for `{type:"heartbeat"}` replies; no heartbeat for 2 s → kill iframe and emit a `sketch.retire` patch. N=3 enforced on both the tool-handler side (eviction-before-add) and the browser reducer (belt-and-suspenders). Scene_state tracks slot occupancy; patch protocol already declares the three sketch patch types from Phase 1.

**Tech Stack:** p5 (new npm dep), existing Zod for postMessage validation, feature_bus from Phase 3. No new Python.

**Date:** 2026-04-24
**Phase:** 6 of 7 (Phase 5 runs in parallel on the `phase-5` branch; Phase 6 does not depend on Phase 5 code)
**Base commit:** `93431b0` (Phase 4 wrap)
**Status:** Ready for execution
**Authoritative inputs:**
- Design spec §7 (Expression), §13.4 (new dependencies), §15 (open risks — CSP iframe attribute portability)
- Phase 3 plan (feature_bus contract), Phase 4 plan (reactivity conventions feed sketch guidance)

---

## 1. Objective

At the end of Phase 6:

- `setP5Background(code, audio_reactive)` replaces the single background p5 slot; the prior sketch is cleanly retired
- `addP5Sketch(position, size, code, audio_reactive, lifetime_s?)` adds a localized sketch; if 3 localized slots are already full, the oldest is retired automatically before the new sketch mounts; the caller gets a `sketch_id` in both cases
- Each sketch runs in an iframe with `sandbox="allow-scripts"` + CSP `default-src 'none'; script-src 'unsafe-inline'; img-src blob: data:`; no network egress, no parent-DOM access
- p5 is vendored under `node_modules/p5` and served via `/vendor/p5/p5.min.js`; no CDN
- Feature frames flow from feature_bus → parent → iframe via postMessage at ~60 Hz
- A sketch that fails to post a heartbeat for 2 s is auto-retired
- Opus sees clear figurative guidance in `hijaz_base.md` v6.1 — sketches MUST depict recognizable things
- All 244 Phase 4 tests stay green; **target 265+ tests total**

Phase 6 is a **new-capability** phase and a **safety** phase in equal measure. Nothing in the sandbox design is optional.

---

## 2. Scope

### In scope

- `node/vendor/p5/p5.min.js` (new — vendored at install time)
- `node/browser/p5_sandbox.html` (new — iframe srcdoc template, NOT a module; inlined as a string)
- `node/browser/p5_sandbox.mjs` (new — host-side manager)
- `node/src/stage_server.mjs` — serve `/vendor/p5/p5.min.js` and expose a read of the vendored p5 code for srcdoc inlining
- `node/src/tool_handlers.mjs` — `handleSetP5Background`, `handleAddP5Sketch`, `handleRetireSketch` (internal for eviction); wire into `applyToolCall`
- `node/src/scene_state.mjs` — `p5_background`, `p5_sketches` slot tracking; eviction helper
- `node/src/patch_emitter.mjs` — emit `sketch.background.set` / `sketch.add` / `sketch.retire` patches (types already in patch_protocol.mjs from Phase 1)
- `node/browser/scene_reducer.mjs` — dispatch sketch patches to `p5_sandbox.mjs`; belt-and-suspenders N=3 enforcement
- `node/browser/stage.html` — instantiate one sandbox manager per page
- `node/prompts/hijaz_base.md` — v6.0 → v6.1 with p5 sketch guidance + figurative enforcement
- `node/prompts/configs/config_a/tools.json` — add `setP5Background` and `addP5Sketch`
- `node/package.json` — add p5 dependency; `pnpm install`

### Explicitly out of scope

- `run_spike.mjs` — Phase 5 touches this heavily; Phase 6 leaves it alone. Sandbox cleanup on run end happens via `stage_server.close` (which already closes WS clients; extend to send a `sketch.retire-all` patch or let per-page dispose handle it via the reducer's own teardown).
- Phase 5 files (opus_client, packet_builder, image_content, self_frame, mood_board, canon/*) — untouched.
- Non-Chrome browser support — spec §15 excludes Firefox/Safari. iframe `csp` attribute behavior is Chrome-specific in some respects; we do not add polyfills.
- p5 source-map files.
- User-authored p5 linting or syntax validation — the iframe sandbox is the safety boundary.

---

## 3. Why this phase exists now

Reactivity (Phase 4) gave Opus continuous property control on DOM elements. p5 sketches give Opus **arbitrary** continuous visual authorship — the ability to invent a flickering-lantern renderer, a calligraphic brush, a woven textile animation, all audio-aware. This is the aesthetic peak of Session I; without p5 the stage remains bound to fixed DOM primitives.

Phase 6 is a safety-heavy phase because Opus-authored code is not trustworthy by construction. Iframes + CSP + heartbeat watchdog are the triple-redundant isolation that makes it safe to run hundreds of lines of model-generated JavaScript per cycle.

---

## 4. Locked implementation decisions

### 4.1 Vendored p5 — no CDN, no runtime fetch

p5 is an npm dep. `node_modules/p5/lib/p5.min.js` is read at stage_server startup (once) and held in memory as a UTF-8 string. Each sketch iframe's `srcdoc` is built by string-concatenation: p5 source + user code + feature-bridge code. This is what makes `connect-src 'none'` viable — the iframe doesn't need network access to load p5.

### 4.2 `allow-scripts` but NOT `allow-same-origin`

Full isolation: the iframe runs scripts but cannot read the parent DOM, cookies, storage, or open fetches. CSP `default-src 'none'; script-src 'unsafe-inline'; img-src blob: data:` closes the remaining holes (`'unsafe-inline'` is needed to execute the srcdoc-inlined scripts; `img-src blob:` allows sketches to manipulate image data generated in-sketch; no network sources).

### 4.3 One background, three localized — eviction-on-overflow, never rejection

- `p5_background` in scene_state holds at most one sketch id
- `p5_sketches` array holds at most three
- A 4th `addP5Sketch` call evicts the oldest: emit a `sketch.retire` patch for the oldest, then emit `sketch.add` for the new one
- The tool handler returns the new `sketch_id` in both initial-3 and overflow-evict cases — there is no error return path for slot overflow

### 4.4 Heartbeat watchdog lives in the host

Every 500 ms, each iframe sketch posts `{type:"heartbeat", frame_count, last_frame_time_ms}`. Host tracks last-seen time per sketch and runs a watchdog timer every 500 ms. If a sketch has been silent for ≥ 2000 ms, the host kills the iframe and emits a `sketch.retire` patch locally (browser-side retirement; no server round-trip). This is resilience against:
- Infinite loops in sketch code
- Memory leaks crashing the iframe
- Bad postMessage that doesn't trigger an error event

### 4.5 postMessage validation via Zod

The host accepts only three message types from iframes: `heartbeat`, `error`, `ready`. Any other shape is dropped silently with a console warning. Zod schemas live in `p5_sandbox.mjs` (not `patch_protocol.mjs`) because they're sandbox-internal, not on-wire.

### 4.6 Feature forwarding at ~60 Hz, batched

The host subscribes to feature_bus on mount of the first sketch. Each feature dispatch updates a host-side `latestFeatures` object. A rAF loop walks all active iframes and posts `{type:"features", values: latestFeatures}` to each. 60 Hz is the rAF tick rate, not the feature dispatch rate — sketches see the most recent feature values each frame even if the bus is quiet.

### 4.7 `hijaz_state` travels as the string, not the numeric encoding

The binding engine (Phase 4) encodes `hijaz_state` to a number because mapInputToOutput is numeric. Sketches read features directly — they should see the human-readable string (`"approach"`, `"tahwil"`, etc.) so code like `if (features.hijaz_state === "tahwil")` works without decoding. This is a deliberate asymmetry.

### 4.8 No `run_spike.mjs` changes

Phase 5 is on the `phase-5` branch and modifies `run_spike.mjs`. Phase 6 stays out of that file entirely. Sketch teardown on run end happens via the existing `stage_server.close` path (which already closes WS clients); the browser's sandbox manager watches for `unload` and retires sketches proactively if needed.

### 4.9 Figurative aesthetic enforced at the prompt, not at runtime

There is no AST scan for "flow field" patterns — that would be brittle and bypassable. The enforcement is:
- Tool description in `tools.json` explicitly states "must depict recognizable things"
- `hijaz_base.md` v6.1 adds a Sketches subsection with figurative guidance and examples
- Opus is expected to respect the instruction; if it doesn't, iteration on the prompt is the fix

### 4.10 scene_state gets a sketch slot field — not stored on `elements`

p5 sketches are distinct from text/svg/image. They live in their own arrays (`p5_background` scalar, `p5_sketches` array), not mixed into `state.elements`. This avoids confusing formatSummary, auto-fade, and composition_group logic with a fundamentally different entity.

---

## 5. Target module ownership

### 5.1 `node/vendor/p5/p5.min.js`

Checked in (binary-ish). Phase 6 task 1 does `pnpm add p5`, then creates a symlink or copies the minified file to `node/vendor/p5/p5.min.js` (which stage_server serves). If we can directly serve from `node_modules/p5/lib/p5.min.js`, we do that and skip the vendor/ copy — simpler.

### 5.2 `node/browser/p5_sandbox.html`

Not loaded directly as a page — it's a template read as a string and injected into each iframe's `srcdoc`. Contains:
- `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;overflow:hidden;}</style></head><body>`
- `<script>__P5_SOURCE__</script>` placeholder
- `<script>__FEATURE_BRIDGE__</script>` placeholder
- `<script>__USER_SKETCH__</script>` placeholder
- `</body></html>`

### 5.3 `node/browser/p5_sandbox.mjs`

Host-side. Exports:

- `createP5Sandbox({documentLike, mount, bus, fetchImpl, now, rafImpl})` → `{mountBackground, mountLocalized, retireBackground, retireLocalized, dispose}`

Behavior:
- `mountBackground(sketchSpec)` — create/replace the background iframe. If one already exists, retire it first (dispatch `sketch.retire` locally and remove iframe).
- `mountLocalized(sketchSpec)` — create an iframe at the specified position + size. Caller is responsible for N=3 eviction (reducer + tool handler do this).
- `retireBackground()` / `retireLocalized(sketch_id)` — tear down iframe, unsubscribe.
- Internal: watchdog loop every 500 ms checks heartbeat timestamps; expired sketches are force-retired.
- Internal: rAF loop forwards `latestFeatures` to every active iframe.
- postMessage: host listens on `window.message`, validates shape, updates heartbeat timestamps.

### 5.4 `node/src/stage_server.mjs`

Two extensions:
- Serve `/vendor/p5/p5.min.js` — resolve to `node_modules/p5/lib/p5.min.js`. Content-Type `text/javascript`.
- Serve `/browser/p5_sandbox.html` — the existing `/browser/*` route handles this once the file exists (stage_server serves `node/browser/*` verbatim).

That's it. The p5 source injection into iframe srcdoc happens **browser-side** in `p5_sandbox.mjs` — the host fetches `/vendor/p5/p5.min.js` once at init and keeps it in memory, same pattern the spec describes for server-side but simpler to do client-side.

### 5.5 `node/src/tool_handlers.mjs`

Two new handlers:
- `handleSetP5Background(state, input)` — validate {code: string, audio_reactive: boolean}; mint sketch_id; update scene_state.p5_background; return `{sketch_id}`
- `handleAddP5Sketch(state, input)` — validate {position, size, code, audio_reactive, lifetime_s?}; if scene_state.p5_sketches.length === 3, evict oldest (this emits a retire patch); mint new sketch_id; append; return `{sketch_id, retired_id?}`

Wire into `applyToolCall`. Neither handler takes `reactivity` — sketches read features directly.

### 5.6 `node/src/scene_state.mjs`

Add fields to `createInitialState()`:
```js
p5_background: null,   // {sketch_id, code, audio_reactive, created_at_cycle, created_at_elapsed_s} or null
p5_sketches: [],       // array of {sketch_id, position, size, code, audio_reactive, lifetime_s, created_at_cycle, created_at_elapsed_s}
next_sketch_index: 1,
```

Helpers:
- `addP5Background(state, {code, audio_reactive})` → returns new sketch_id; caller emits both retire-old and set-new patches
- `addP5Sketch(state, spec)` → returns `{sketch_id, retired_id?}`; evicts oldest localized sketch when full
- `retireP5Sketch(state, sketch_id)` → marks/removes from either slot

`formatSummary` gets a P5 SKETCHES block showing background + up-to-3 localized with age + audio_reactive flag + figurative label extracted from the first 60 chars of the code.

### 5.7 `node/src/patch_emitter.mjs`

Emit the three sketch patches for the corresponding tools + internal retirement events.

### 5.8 `node/browser/scene_reducer.mjs`

Handle `sketch.background.set`, `sketch.add`, `sketch.retire`. Delegate to p5_sandbox manager. Belt-and-suspenders N=3: if a 4th `sketch.add` arrives without preceding retire, log warning and evict locally.

### 5.9 `node/browser/stage.html`

Instantiate `createP5Sandbox` once per page, pass to reducer as `p5Sandbox` option.

### 5.10 `node/prompts/hijaz_base.md`

v6.0 → v6.1. New Sketches section covering:
- What the tools do and when to reach for each
- Figurative-only enforcement (not a suggestion — a load-bearing rule)
- Feature object access pattern from inside the sketch
- Concrete example sketches: flickering lantern, ink stroke forming letters, textile unfurl
- Anti-examples: flow fields, particle clouds, pure geometric loops — these are rejected compositional choices

### 5.11 `node/prompts/configs/config_a/tools.json`

Add `setP5Background` and `addP5Sketch` tool schemas.

---

## 6. Work breakdown

### Task 1: Vendor p5

**Files:** `node/package.json`, verify `node_modules/p5/lib/p5.min.js` exists.

- [ ] **Step 1.1 — Install p5 via pnpm**

```bash
cd /home/amay/Work/feed-looks-back-spike/node && pnpm add p5
ls -la /home/amay/Work/feed-looks-back-spike/node/node_modules/p5/lib/
```

Expected: `p5.min.js` present. Note the actual file size (sanity-check ~500 KB — if it's tiny, the package may have moved the file in a newer version).

- [ ] **Step 1.2 — Verify version pinned in package.json**

```bash
grep p5 /home/amay/Work/feed-looks-back-spike/node/package.json
```

- [ ] **Step 1.3 — Commit package.json + pnpm-lock.yaml**

Note: if Phase 5 has already added lock entries, merge conflicts may appear here. Resolve by running `pnpm install` after Phase 5 merges — lock is regenerated.

```bash
git -C /home/amay/Work/feed-looks-back-spike add node/package.json node/pnpm-lock.yaml
git -C /home/amay/Work/feed-looks-back-spike commit -m "feat(phase-6): vendor p5.js via pnpm add p5"
```

---

### Task 2: stage_server serves /vendor/p5/p5.min.js

**Files:** `node/src/stage_server.mjs`.

- [ ] **Step 2.1 — Add /vendor/p5/ route**

Extend the static branches in the request handler:

```js
} else if (url.pathname === "/vendor/p5/p5.min.js") {
  filePath = join(nodeRoot, "node_modules", "p5", "lib", "p5.min.js");
}
```

- [ ] **Step 2.2 — Add regression test**

Extend the "serves stage.html and static assets" test to also GET `/vendor/p5/p5.min.js` and assert 200 status + body length > 10000 (p5 minified is several hundred KB, but any install would be > 10 KB).

- [ ] **Step 2.3 — Run stage_server self-test**

- [ ] **Step 2.4 — Commit**

---

### Task 3: Write the iframe srcdoc template

**Files:** `node/browser/p5_sandbox.html` (NEW — loaded as a string, not a page).

- [ ] **Step 3.1 — Create the template**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;}canvas{display:block;}</style>
</head>
<body>
<script>/* __P5_SOURCE__ */</script>
<script>
// Feature bridge.
window.features = {
  amplitude: 0, onset_strength: 0, spectral_centroid: 0,
  hijaz_state: "unknown", hijaz_intensity: 0, hijaz_tahwil: false,
};
window.__flb_frame_count = 0;
window.__flb_last_frame_time_ms = 0;
window.addEventListener("message", (e) => {
  if (!e.data || typeof e.data !== "object") return;
  if (e.data.type === "features" && e.data.values && typeof e.data.values === "object") {
    Object.assign(window.features, e.data.values);
  }
});
function __flb_post_ready(){try{window.parent.postMessage({type:"ready"},"*");}catch(e){}}
function __flb_post_heartbeat(){try{window.parent.postMessage({type:"heartbeat",frame_count:window.__flb_frame_count,last_frame_time_ms:window.__flb_last_frame_time_ms},"*");}catch(e){}}
function __flb_post_error(message){try{window.parent.postMessage({type:"error",message:String(message).slice(0,500)},"*");}catch(e){}}
setInterval(__flb_post_heartbeat, 500);
window.addEventListener("error",(e)=>__flb_post_error(e?.message??"sketch error"));
__flb_post_ready();
</script>
<script>
try {
// __USER_SKETCH__
} catch (e) { __flb_post_error(e?.message ?? "sketch runtime error"); }
</script>
</body>
</html>
```

The `__P5_SOURCE__` and `__USER_SKETCH__` placeholders are replaced by p5_sandbox.mjs at iframe-mount time.

- [ ] **Step 3.2 — Commit**

---

### Task 4: p5_sandbox.mjs host-side manager

**Files:** `node/browser/p5_sandbox.mjs` (NEW).

- [ ] **Step 4.1 — Write the full module with inline self-tests**

Key pieces:

```js
const HeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  frame_count: z.number(),
  last_frame_time_ms: z.number(),
});
const ReadySchema = z.object({ type: z.literal("ready") });
const ErrorSchema = z.object({ type: z.literal("error"), message: z.string() });
const MessageSchema = z.discriminatedUnion("type", [HeartbeatSchema, ReadySchema, ErrorSchema]);

export function createP5Sandbox({
  documentLike = globalThis.document,
  mount,
  bus,
  p5SourcePromise = null,
  templatePromise = null,
  fetchImpl = globalThis.fetch,
  rafImpl = globalThis.requestAnimationFrame,
  now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
  HEARTBEAT_TIMEOUT_MS = 2000,
} = {}) {
  // Lazy-load p5 and the template string; first mount kicks both fetches.
  // Active iframes keyed by sketch_id; {iframe, lastHeartbeat, retireReason}
  // rAF loop walks all active iframes, posts {type:"features"} from latest bus values
  // watchdog interval walks all iframes, retires any silent > HEARTBEAT_TIMEOUT_MS
  // global message listener validates via MessageSchema and updates timestamps
}
```

Tests (target 10+):
1. mountBackground injects p5 source + sketch code + feature bridge into iframe srcdoc
2. mountLocalized positions the iframe based on position + size
3. feature dispatch on bus → postMessage to each active iframe on next rAF
4. heartbeat received → lastHeartbeat updated
5. no heartbeat for 2000 ms → iframe retired + `onRetire` callback fired
6. retireBackground clears the slot
7. retireLocalized removes the iframe
8. invalid postMessage shape silently dropped
9. dispose tears down everything (watchdog, rAF, message listener)
10. same sketch_id mount twice — second replaces first

Use a FakeDocument with an append-only children list and a fake postMessage target.

- [ ] **Step 4.2 — Verify red, then green iteratively**

- [ ] **Step 4.3 — Commit**

---

### Task 5: scene_state.mjs p5 slots + tool handlers

**Files:** `node/src/scene_state.mjs`, `node/src/tool_handlers.mjs`.

- [ ] **Step 5.1 — Extend createInitialState + add helpers**

Add `p5_background: null`, `p5_sketches: []`, `next_sketch_index: 1` to initial state. Add:

- `mintSketchId(state)` → `sketch_<NNNN>`
- `setP5Background(state, {code, audio_reactive})` — returns `{sketch_id, retired_id?}`. If existing, capture old id for retirement.
- `addP5Sketch(state, {position, size, code, audio_reactive, lifetime_s})` — returns `{sketch_id, retired_id?}`. If length === 3, shift oldest off, capture its id.
- `retireP5Sketch(state, sketch_id)` — remove from whichever slot.

- [ ] **Step 5.2 — Wire tool handlers**

- [ ] **Step 5.3 — Add tests (target 10+ across both files)**

- [ ] **Step 5.4 — Commit**

---

### Task 6: patch_emitter.mjs emits sketch patches

**Files:** `node/src/patch_emitter.mjs`.

- [ ] **Step 6.1 — Emit `sketch.background.set`, `sketch.add`, `sketch.retire`**

For setP5Background: emit a retire patch for the old id (if any) + a `sketch.background.set` with the new code.

For addP5Sketch: emit a retire patch for the evicted id (if any) + a `sketch.add`.

- [ ] **Step 6.2 — Tests**

- [ ] **Step 6.3 — Commit**

---

### Task 7: scene_reducer delegates to p5_sandbox

**Files:** `node/browser/scene_reducer.mjs`.

- [ ] **Step 7.1 — Accept `p5Sandbox` parameter; dispatch on sketch.* patches**

- [ ] **Step 7.2 — Belt-and-suspenders N=3 check**

- [ ] **Step 7.3 — Tests with a FakeP5Sandbox**

- [ ] **Step 7.4 — Commit**

---

### Task 8: stage.html wires everything

**Files:** `node/browser/stage.html`.

- [ ] **Step 8.1 — Import createP5Sandbox, instantiate, pass to reducer**

---

### Task 9: hijaz_base.md v6.1 — Sketches section

**Files:** `node/prompts/hijaz_base.md`.

- [ ] **Step 9.1 — Add Sketches section with figurative enforcement + 3 concrete examples**

Explicit anti-examples: flow fields, particle clouds, Perlin-noise backgrounds. Explicit positive examples: flickering oil lamp, ink stroke forming an Arabic letter, textile rippling, architectural threshold.

---

### Task 10: tools.json adds p5 tools

**Files:** `node/prompts/configs/config_a/tools.json`.

- [ ] **Step 10.1 — Add setP5Background and addP5Sketch schemas**

Validate JSON with `JSON.parse` after edit.

---

### Task 11: Phase 6 wrap

- [ ] **Step 11.1 — Full regression**
- [ ] **Step 11.2 — Codex review against `93431b0..HEAD`**
- [ ] **Step 11.3 — Address findings**
- [ ] **Step 11.4 — Push**

---

## 7. Verification sequence

### 7.1 Required automated checks

- `node src/stage_server.mjs` — 10 tests (was 9)
- `node src/scene_state.mjs` — target 74 (was 69)
- `node src/tool_handlers.mjs` — target 42 (was 37)
- `node src/patch_emitter.mjs` — target 9 (was 6)
- `node browser/scene_reducer.mjs` — target 14 (was 11)
- `node browser/p5_sandbox.mjs` — 10+ new tests
- All other files unchanged

### 7.2 Required manual checks

1. Pre-compute a Sample 1 run and open the stage in Chrome. Inject via devtools:
   ```js
   window.__bindingEngine // (debug hook from Phase 4)
   ```
   Issue a synthetic `addP5Sketch` patch via `createSceneReducer` handle if reachable, or author a short sketch by hand and paste into the reducer.
2. Verify sketch iframe mounts, receives feature postMessages, heartbeats are received.
3. Verify CSP blocks `fetch("https://example.com")` from inside the iframe (devtools Network tab).
4. Verify N=3 eviction fires a retire before the 4th add.

### 7.3 Exit criteria

- `addP5Sketch` / `setP5Background` flow end-to-end from tool call to rendered iframe
- Heartbeat watchdog retires hung sketches within 2 s
- N=3 eviction is atomic (retire precedes add in the patch stream)
- CSP + sandbox isolation verified in Chrome devtools
- Figurative guidance in the prompt is visible and explicit

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| p5 npm package updates break vendored path | Pin p5 version in package.json; grep the lock file post-install to confirm |
| `sandbox` + `csp` interaction differs per browser | Scope explicitly to Chrome (spec §15); don't attempt cross-browser |
| Opus writes abstract sketches despite prompt | Phase 6 ships the prompt; iteration on examples is a follow-up phase |
| Phase 5 merge introduces conflicts in run_spike | Phase 6 does not touch run_spike; merge conflicts, if any, are Phase 5's responsibility |
| Feature postMessage storm at 60 Hz × up to 4 iframes | Batch into single rAF tick; each frame posts once per iframe (max 4 posts/frame). Well under Chrome's postMessage budget. |
| Sketch iframe takes long enough to load that first heartbeat misses the 2 s window | Initial heartbeat scheduled by setInterval starts at +500 ms; timeout begins at iframe creation, not at ready. Add a warmup grace of 3 s for first heartbeat. |
| p5.min.js is ~900 KB; re-downloading into every iframe's srcdoc is wasteful | Each iframe creates a new JavaScript context, so srcdoc-inlined p5 is the simplest correct path. If memory becomes an issue, investigate `blob:` URL sharing in Phase 7+. |

---

## 9. Commit gate

Standard: implement → tests green → Codex review → address → commit → push.

---

## 10. Handoff to Phase 7

Phase 6 closes leaves the full Opus-authored visual surface live:
- DOM elements (text/svg/image) with reactivity (Phase 4)
- p5 sketches — ambient background + up to 3 localized — audio-aware (Phase 6)
- Mood board perception + self-frame (Phase 5, parallel branch)

Phase 7 is the production run: a full 31-cycle real-API performance against Sample 1 (or Bashar's canonical recording if available), with operator-side comparison against the Session H baseline in `node/output/run_20260423_185946/`.
