# Session I — Live Reactive Stage — Design Spec

**Status:** Draft, awaiting approval
**Date:** 2026-04-23
**Author:** Claude (with Amer; via the superpowers:brainstorming skill)
**Supersedes:** N/A — first formal spec in this spike. Sessions B–H are captured inline as SESSION_*_LOG.md artifacts in `node/`.
**Related:**
- Spike base: `/home/amay/Work/feed-looks-back-spike/node/` (Sessions B–H lineage, 131 inline tests green)
- Reference scaffold: `/home/amay/Work/Build_With_OPUS_4.7_hack/` (Day 1 parallel approach — lifted patterns listed in §3; otherwise not merged)

---

## 1. Goal

Transform Feed Looks Back from per-cycle static HTML snapshots into a **live reactive stage**: Opus compositional decisions (every ~6 s) render onto a persistent browser surface that *lives* and *reacts* to audio continuously (every audio frame). This work lands three coordinated capabilities in one session:

1. **Perception** — cached mood-board image input + triggered self-frame feedback
2. **Expression** — p5.js live-coding tools (1 background slot + up to 3 localized sketches)
3. **Temporality** — declarative audio-reactive property bindings on every placement tool

By completion, the stage holds state across cycles, sketches persist and evolve smoothly, and text/SVG/image elements breathe and pulse with live audio without requiring Opus to re-author motion each cycle.

---

## 2. Non-goals

- **Not UX-interactive.** No clicks, keyboard, or MIDI input. "Interactive" in this spec means *audio-reactive only*.
- **Not abstract.** Visuals must be figurative and human-relatable — recognizable things (lantern, silhouette, flowing textile, calligraphic stroke forming letters, architectural elements) — **not** flow fields, particle clouds, or pure geometric composition as form. This constraint propagates through mood-board curation, p5 sketch prompting, SVG guidance in `hijaz_base.md`, and image search queries.
- **Not a rewrite** of the six existing tools (addText, addSVG, addImage, setBackground, fadeElement, addCompositeScene). They evolve additively via an optional `reactivity` parameter; all current field names preserved.
- **Not a merge** of the spike with the Build_With_OPUS_4.7_hack scaffold. Consolidation is deferred to a future session; Session I *lifts patterns*, not code wholesale. See §3.
- **Not real-time collaborative** — single artistic voice per session.

---

## 3. Prior art & relationship to the Day 1 scaffold

A separate scaffold at `/home/amay/Work/Build_With_OPUS_4.7_hack/` was built Day 1 of the hackathon as a parallel design exploration. It embodies a materially different runtime architecture (phrase-boundary paced HTTP request-response, Three.js + ShaderMaterial uniform mutations, maqam-guitar "wrongness strategies" prompt corpus) and is **not** the Session I lineage. Session I lives in and extends the spike at `/home/amay/Work/feed-looks-back-spike/node/`.

However, four scaffold artifacts are **lifted** into Session I:

| Scaffold source | Session I destination | Lift form |
|---|---|---|
| `src/scene/mutation.ts` (UniformMutator) | `node/src/binding_easing.mjs` *(new)* | **Direct port.** `easeInOutCubic` + lerp Map pattern + `applyPatch` / `update` / `isIdle` API, adapted from shader-uniform targets to DOM-property targets (style.opacity, transform, filter). |
| `server/cache.ts` (persistent phrase cache) | `node/src/patch_cache.mjs` *(new)* | **Direct port.** In-memory Map + promise-chained write persistence + zod-validated load, adapted from phrase-hash → PhraseResponse to patch_seq → Patch for replay-on-reconnect. |
| `server/anthropic-adapter.ts` + `docs/prompt-caching.md` | `node/src/opus_client.mjs` evolution + `node/src/image_content.mjs` *(new)* | **Reference pattern.** Sequential text-block system prompt with `cache_control: ephemeral` on the final static block; `thinking: adaptive` + `output_config.effort: medium`; ephemeral breakpoint placement rules. Spike keeps open tool choice (no forced tool_use — Opus decides when to act). |
| `shared/schemas.ts` (Zod discipline) | `node/src/patch_protocol.mjs` *(new)* | **Reference pattern.** `z.discriminatedUnion` for the patch protocol; one schema file as single source of truth. |

**Nothing from the scaffold's Three.js scene, HUD, phrase-boundary model, capture mode, or maqam-guitar prompt corpus** enters Session I. Those belong to the scaffold's own system.

Also referenced but not ported: `docs/adr/0001-json-only-hot-path.md`. Its core observation — "perceptual coupling between musician's phrase and scene's response is the piece; latency *variance* breaks coupling more than consistent latency" — is honored in Session I by keeping the reactivity hot path (60 Hz binding engine) purely declarative JSON and confining model-authored code to the cycle path (~6 s) via sandboxed p5 iframes with watchdog.

---

## 4. Architecture

Three tiers joined by a WebSocket control plane (scene patches) and a WebSocket feature plane (audio features, live mode only). Both planes share a single WebSocket connection per client, multiplexed by `channel` discriminator.

```
┌──────────────────────────────────────────────────────────────┐
│ BROWSER STAGE — node/browser/stage.html (long-running tab)   │
│                                                               │
│   feature_replayer ──┐  (pre-rec: fetches features_track.json │
│   (sync to            │   from /run/<id>/…, dispatches all    │
│    <audio>.currentTime)│   features inc. amp/onset/centroid)  │
│                       ▼                                       │
│               feature_bus.mjs                                 │
│               (central audio-feature event bus, ~60 Hz)       │
│                       ▲                                       │
│   WebSocket ──────────┤                                       │
│   (channel=feature;                                           │
│    live mode only)    │                                       │
│                       ▼                                       │
│               binding_engine.mjs                              │
│               (reactivity → DOM properties, eased)            │
│                                                               │
│               p5_sandbox.mjs                                  │
│               (iframe-per-sketch, 1 bg + N=3 localized)       │
│                                                               │
│   WebSocket ──▶ scene_reducer.mjs                             │
│   (channel=patch)   (applies patches to DOM)                  │
│                                                               │
│   <audio src="/run/<id>/audio.wav">                           │
│   (pre-rec only; playback for humans, NOT a feature source)   │
└──────────────────────────────────────────────────────────────┘
           ▲ patches out              ▲ hot-reload (dev)
           │ {element.*, sketch.*, …} │ {prompt.replace, …}
┌──────────────────────────────────────────────────────────────┐
│ NODE PIPELINE — node/src/                                     │
│   run_spike.mjs                                              │
│     ├─ starts stage_server (WebSocket + static files)         │
│     ├─ starts feature stream bridge (Python WS, live mode)    │
│     ├─ holds stage connection across N cycles                 │
│     └─ per cycle: Opus → tool_handlers → patch_emitter        │
│                                                               │
│   opus_client.mjs                                             │
│     ├─ mood_board + self_frame image content blocks           │
│     └─ cache_control on static prefix (scaffold pattern)      │
└──────────────────────────────────────────────────────────────┘
           ▲ Hijaz events (WebSocket, channel=feature)
           │
┌──────────────────────────────────────────────────────────────┐
│ PYTHON DSP — feed-looks-back-spike/python/                    │
│   (existing Session 1 DSP; unchanged)                         │
│   + stream_features.py (new): iD14 or file → WS → stage       │
└──────────────────────────────────────────────────────────────┘
```

### Key architectural decisions (carried from brainstorming)

- **Long-running stage, not per-cycle snapshots** (Option A). Browser tab stays open; Node becomes a WebSocket server; scene_reducer applies patches in place.
- **Python is the sole feature extractor in both modes** (narrowed from initial Option C hybrid after the first Codex review; further narrowed in a second Codex pass that flagged cross-implementation drift between browser Web Audio and Python DSP). Live: iD14 → Python DSP → WebSocket → browser. Pre-recorded: audio file → Python pre-computes the full feature track (`features_track.json`, including amplitude/onset/centroid alongside Hijaz events) → browser `feature_replayer` dispatches in sync with `<audio>.currentTime`. The browser never analyzes audio. This eliminates offline-vs-live drift in feature distributions and timing (bindings tuned against pre-recorded audio hold live), eliminates the `getUserMedia` permission flow, and shrinks the browser's attack surface.
- **p5 scope: hybrid with N=3 cap** (Option C). One background slot + up to 3 localized sketches; 4th addition auto-retires oldest. Sketches run in `<iframe sandbox>` with CSP, heartbeat watchdog, and kill-and-replace.
- **Perception: cached mood board + event-triggered self-frame + every-5-cycle baseline** (Option D). Mood board lives in the cached system-message prefix; self-frame rides in the uncached user-message block on triggers.
- **Mood board: layered Z** — figurative positive references + tradition anchors + negative "not-this" references. Placeholder canon ships; artist swaps via `mood_board.json` config.

---

## 5. Components

### 5.1 Node modules

| Module | Status | Purpose |
|---|---|---|
| `run_spike.mjs` | **Changed** | Starts stage_server; holds stage WebSocket across cycles; coordinates Python feature streamer startup; orchestrates Opus cycles |
| `opus_client.mjs` | **Changed** | Accepts image content blocks (mood board + self-frame); applies `cache_control: ephemeral` at scaffold-recommended boundary; `thinking: adaptive` + `output_config.effort: medium` (lifted from scaffold adapter) |
| `packet_builder.mjs` | **Changed** | Composes messages as content-block array when images present; places cache breakpoint after mood-board label, before dynamic scene_state text |
| `tool_handlers.mjs` | **Changed** | Existing six handlers gain optional `reactivity` param handling; new handlers for `setP5Background` and `addP5Sketch`; every handler emits zero or more patches alongside scene_state mutations |
| `scene_state.mjs` | **Changed** | Tracks p5 slot state (background: id+started_at; localized: array with N=3 cap); self-frame trigger flags (hijaz_tahwil_fired, element_count, cycles_since_last_image); sketch info surfaces in SCENE OVERVIEW |
| `patch_emitter.mjs` | **New** | Pure function: (tool-call result) → structured Patch(es). Replaces the HTML-writing portion of `render_html.mjs`. |
| `patch_protocol.mjs` | **New** | Zod discriminated-union schemas for every patch type; single source of truth imported by emitter, handlers, tests, and browser reducer (served statically by stage_server) |
| `stage_server.mjs` | **New** | WebSocket server (`ws` lib) + static file server (Node `http` built-in) on the same port; handles connect/disconnect, broadcasts patches, replays from `patch_cache` on reconnect |
| `patch_cache.mjs` | **New — port of scaffold's `server/cache.ts`** | In-memory Map + persistent file; stores per-run patch stream; used for reconnect replay and post-run analysis |
| `sanitize.mjs` | **New — migrated from `render_html.mjs:258–316`** | SVG + CSS validators; called by tool_handlers before emitting patches with SVG/CSS content |
| `image_resolver.mjs` | **New — migrated from `render_html.mjs:845–888`** | Resolves `addImage` queries to local file paths via `image_fetch.mjs`; returns assets for `element.add` patches |
| `operator_views.mjs` | **New — migrated from `render_html.mjs:687–966`** | Server-side operator observability: composition history, scene-overview mirror, live monitor page, run statistics. Still writes `output/<run>/live_monitor.html`. |
| `binding_easing.mjs` | **New — port of scaffold's `UniformMutator`** | `easeInOutCubic` + lerp state Map + `applyPatch` / `update` / `isIdle` API; adapted to DOM-property targets |
| `image_content.mjs` | **New** | Loads mood-board JSON; validates MIME + size + resolution (downscales via `sharp` when needed); returns content-block array. Also `captureSelfFrame(stageUrl)` via Playwright headless. |
| `render_html.mjs` | **Removed** | Logic migrated per above to sanitize.mjs + image_resolver.mjs + operator_views.mjs (Node side) and scene_reducer.mjs (browser side) |

### 5.2 Browser modules (new — under `node/browser/`)

Served statically by `stage_server.mjs` at the same port as the WebSocket endpoint. Static serving paths:
- `/` → `node/browser/stage.html`
- `/browser/*.mjs` → `node/browser/*.mjs`
- `/shared/*.mjs` → `node/src/*.mjs` (narrow allowlist: `patch_protocol.mjs`, `binding_easing.mjs` — the two modules consumed by both Node and the browser). Serving only the allowlist avoids accidentally exposing `opus_client.mjs` or other Node-only code.
- `/vendor/p5.min.js` → read once from `node_modules/p5/lib/p5.min.js` at startup; cached in memory; served to any consumer. Used by stage_server when generating p5-iframe srcdoc (see §7.3) so sketches have no external-CDN dependency during performance.
- `/run/<run_id>/audio.wav` → `node/output/<run_id>/audio.wav` (pre-recorded mode source audio; file copied or symlinked into the run directory at run start)
- `/run/<run_id>/features_track.json` → `node/output/<run_id>/features_track.json` (Python `stream_features.py --mode precompute` output; includes ALL features — amplitude, onset_strength, spectral_centroid, and Hijaz events)
- `/run/<run_id>/assets/*` → `node/output/<run_id>/assets/*` (images fetched by `addImage`)

| Module | Purpose |
|---|---|
| `stage.html` | Single long-running page; loads modules as native ES modules via `<script type="module">`; holds `<audio>` element in pre-recorded mode |
| `scene_reducer.mjs` | Applies patches to DOM; owns layout and positioning logic migrated from `render_html.mjs`'s pure-layout portion; manages element lifecycle (add, update, fade with CSS transition, remove); renders composition groups within a shared container carrying `data-group-id` |
| `feature_bus.mjs` | Central EventTarget-based event bus; exposes `subscribe(feature, cb)` / `dispatch(feature, value)`; merges incoming feature streams into one observable surface |
| `feature_replayer.mjs` | **Pre-recorded mode only.** Fetches `/run/<run_id>/features_track.json` (pre-computed by Python with ALL features — amplitude, onset_strength, spectral_centroid, hijaz_state, hijaz_intensity, hijaz_tahwil); dispatches every feature to feature_bus synced to `<audio>.currentTime`. Browser performs no audio analysis. |
| `ws_client.mjs` | WebSocket client: receives scene patches + (live mode) Python feature events, both multiplexed by `channel`; forwards features to feature_bus, patches to scene_reducer |
| `binding_engine.mjs` | Reads each element's `reactivity` config; subscribes to feature_bus; updates DOM properties per audio frame using `binding_easing.mjs` (shared with Node). Handles multi-binding per element, smoothing_ms, curve easing. |
| `p5_sandbox.mjs` | Manages background slot + up to 3 localized sketch iframes; handles lifecycle (mount, retire on watchdog timeout / script error / N=3 overflow); injects feature bridge via postMessage |

### 5.3 Python modules

| Module | Status | Purpose |
|---|---|---|
| (existing DSP) | **Unchanged** | Librosa pipeline + Hijaz detectors from Sessions A/B |
| `stream_features.py` | **New** | In live mode: opens iD14 via sounddevice; runs DSP; pushes features via WebSocket at ~60 Hz. In pre-recorded mode: reads audio file; pre-computes full feature track; writes `features_track.json` for browser replayer. |

---

## 6. Perception

### 6.1 Mood board

Static reference imagery that anchors Opus's aesthetic choices. Always on. Always cached.

`prompts/mood_board.json`:
```json
[
  {"path": "assets/mood_board/positive_01.jpg", "role": "positive", "label": "figurative miniature painting — line weight, human figure, palette"},
  {"path": "assets/mood_board/positive_02.jpg", "role": "positive", "label": "architectural interior photography — light through threshold"},
  {"path": "assets/mood_board/positive_03.jpg", "role": "positive", "label": "calligraphic specimen — letterform as image"},
  {"path": "assets/mood_board/anchor_01.jpg", "role": "anchor", "label": "mihrab silhouette — tradition anchor"},
  {"path": "assets/mood_board/negative_01.jpg", "role": "negative", "label": "NOT this — generic AI generative-art aesthetic (abstract flow fields, pure particle compositions)"}
]
```

**Placeholder canon (Session I ships with):** three figurative positives (miniature painting, architectural photograph, calligraphic specimen) + one tradition anchor + one negative reference. **All five must depict recognizable things.** Pure geometric tile patterns are excluded from the anchor slot despite being tradition-adjacent, because they violate the figurative constraint (§2).

Artist swaps slots via config; no code change needed.

**Loading pipeline (`image_content.mjs`):**
1. Read `mood_board.json`
2. For each entry: check file exists; MIME ∈ {jpeg, png, webp, gif}; size ≤ 5 MB; longest edge ≤ 1568 px; downscale via `sharp` if over
3. Base64-encode → `{type: "image", source: {type: "base64", media_type, data}}` content block
4. Prepend a text block with role labels so Opus understands what each image is for
5. On any failure for a slot: `console.warn`, skip that slot, proceed (mood board is best-effort)

**Placement in the Anthropic request (pattern lifted from scaffold):**
```
system: [
  {type: "text", text: hijaz_base_md},
  {type: "text", text: medium_rules},
  {type: "text", text: mood_board_label_and_instructions},
  ...moodBoardImageBlocks,
  {type: "text", text: "", cache_control: {type: "ephemeral"}}   // ← breakpoint
]
messages: [
  {role: "user", content: [
    {type: "text", text: dynamic_user_text},                     // scene_state + Hijaz context; uncached
    ...(selfFrameBlock ? [selfFrameBlock] : [])                  // uncached
  ]}
]
```

Cache TTL ~5 minutes (scaffold doc). For dead air longer than that (tuning breaks), run a trivial heartbeat request to keep the prefix warm. Known invalidators (per `scaffold/docs/prompt-caching.md`): reordering the static blocks, changing the tool schema mid-session, injecting non-deterministic content into the cached prefix, editing any of the static files between warm requests.

### 6.2 Self-frame

Dynamic reference: Opus sees its own previous rendered output at moments when composition decisions matter most.

**Triggers (OR-combined):**
- `hijaz_tahwil_fired` in the last cycle
- `element_count > 8` (scene may be too busy)
- `cycles_since_last_image > 4` (image weight may have drifted)
- Every 5th cycle as safety baseline

**Capture pipeline:**
1. Node calls `captureSelfFrame(stageUrl)` in `image_content.mjs`
2. Playwright headless browser (separate process, lazily launched on first trigger) loads the stage URL, waits for `data-stage-ready="1"` (set by scene_reducer only after the WebSocket `replay.begin`/`replay.end` handshake has completed AND the most recent cycle has been `cycle.end`-terminated — see §9 reconnect semantics). This two-condition gate guarantees Playwright never captures mid-replay or mid-cycle state. Takes a PNG screenshot.
3. PNG bytes → image content block (same shape as mood-board images, but no cache_control — self-frame changes every cycle)
4. Inject into next cycle's user message, labeled: `"Previous frame (cycle N). Elements=6, dominant=text, background_age=18s. Adjust if composition needs attention."`

**Budget note:** self-frame capture adds ~1500 tokens per triggered cycle. At ~40 % trigger rate over 31 cycles: ~12 captures × 1500 = ~18 k tokens input → roughly $0.05 per production run. Negligible.

---

## 7. Expression — new tools

### 7.1 setP5Background

```json
{
  "name": "setP5Background",
  "description": "Replace the background p5 sketch layer. Runs behind all other elements. Use for ambient, atmospheric scenes — a flickering oil-lamp interior, a slowly rippling textile, calligraphic strokes forming and fading. Sketches must depict recognizable things — no pure particle or flow-field abstractions. Only one background slot; each call replaces the prior.",
  "input_schema": {
    "type": "object",
    "properties": {
      "code": {
        "type": "string",
        "description": "Complete p5.js sketch as JavaScript. Runs in a sandboxed iframe. Access audio features via the injected `features` object: features.amplitude, features.onset_strength, features.spectral_centroid, features.hijaz_state, features.hijaz_intensity, features.hijaz_tahwil. No external network calls; no access to parent DOM. Depict recognizable things — not abstract patterns."
      },
      "audio_reactive": {
        "type": "boolean",
        "description": "If true, the sketch receives live audio features via the features object every frame. If false, it runs independently of audio."
      }
    },
    "required": ["code", "audio_reactive"]
  }
}
```

### 7.2 addP5Sketch

```json
{
  "name": "addP5Sketch",
  "description": "Place a localized p5.js sketch at a specific position. Used for gestural, short-lived visual responses — a lantern flickering, a hand drawing a line, a textile unfurling. Sketches must depict recognizable things. Up to 3 concurrent sketches (N=3 cap); adding a 4th auto-retires the oldest. Returns the new sketch_id.",
  "input_schema": {
    "type": "object",
    "properties": {
      "position": {
        "type": "string",
        "description": "One of nine anchor positions: top-left, top-center, top-right, mid-left, center, mid-right, bottom-left, bottom-center, bottom-right."
      },
      "size": {
        "type": "string",
        "enum": ["small", "medium", "large"],
        "description": "Sketch canvas size. small ≈ 300×300, medium ≈ 500×500, large ≈ 800×800."
      },
      "code": { "type": "string", "description": "Complete p5.js sketch (see setP5Background)." },
      "audio_reactive": { "type": "boolean" },
      "lifetime_s": {
        "type": "number",
        "description": "Optional. Omit for default permanence. Supply numeric for deliberately transient sketches."
      }
    },
    "required": ["position", "size", "code", "audio_reactive"]
  }
}
```

### 7.3 Sandbox & safety

Each sketch runs in an iframe whose `srcdoc` inlines the vendored p5 source + the user-authored sketch code + a feature-bridge listener. No external CDN is used; p5 is served locally (see §13.4 dependencies and §5.2 static paths).

```html
<iframe class="p5-sketch"
        sandbox="allow-scripts"
        csp="default-src 'none'; script-src 'unsafe-inline'; img-src blob: data:;"
        srcdoc="<!DOCTYPE html><html><body>
                  <script><!-- p5.min.js content inlined by stage_server at mount --></script>
                  <script><!-- user-authored p5 sketch code --></script>
                  <script><!-- feature-bridge listener --></script>
                </body></html>">
```

**p5 vendoring.** p5 is an npm dependency (§13.4). At startup, stage_server reads `node_modules/p5/lib/p5.min.js` once, keeps it in memory, and inlines it into each sketch iframe's `srcdoc`. No network access is required at runtime, which is what makes `connect-src 'none'` viable.

**Runtime guards:**
- **No same-origin access.** Sandbox without `allow-same-origin` → iframe cannot read parent DOM, cookies, or storage.
- **No network egress.** `connect-src 'none'` blocks fetch, WebSocket, XHR. Sketches get audio features through the postMessage bridge only.
- **Heartbeat watchdog.** Iframe posts `{type:"heartbeat", frame_count, last_frame_time_ms}` every 500 ms. Parent kills the iframe on 2 s silence and emits a `sketch.retire` patch.
- **postMessage validation.** Parent accepts only `{type: "heartbeat" | "error" | "ready", ...}` with zod schema validation; unknown message types dropped silently.
- **Kill-and-replace.** Any error (load failure, script error, timeout) triggers removal without affecting other sketches or the parent stage. Errors logged to `operator_views` console for post-show review.
- **N=3 enforced on both ends, eviction-on-overflow semantics (never rejection).** When Opus calls `addP5Sketch` and all 3 localized slots are full, Node emits a `sketch.retire` patch for the oldest localized sketch *before* applying the new `sketch.add`. The tool handler returns the new sketch_id to Opus in both cases (initial-3 and overflow-evict); no rejection path. Browser reducer enforces the same cap as belt-and-suspenders: if a 4th `sketch.add` arrives without a preceding `sketch.retire`, browser evicts the oldest locally and logs a warning to operator_views.

**Sketch access to features:**
```js
// Injected into each iframe at mount:
window.features = {
  amplitude: 0, onset_strength: 0, spectral_centroid: 0,
  hijaz_state: "unknown", hijaz_intensity: 0, hijaz_tahwil: false
};
window.addEventListener("message", (e) => {
  if (e.data?.type === "features") Object.assign(window.features, e.data.values);
});
// Parent posts {type: "features", values: {...}} every audio frame (~60 Hz).
```

---

## 8. Temporality — reactivity

Every existing placement tool (addText, addSVG, addImage, and each `elements[]` entry in addCompositeScene) gains an optional `reactivity` parameter:

```ts
type Reactivity = {
  property: "opacity" | "scale" | "rotation" | "translateX" | "translateY" | "color_hue";
  feature: "amplitude" | "onset_strength" | "spectral_centroid" | "hijaz_intensity" | "hijaz_tahwil";
  map: { in: [number, number]; out: [number, number]; curve: "linear" | "ease-in" | "ease-out" | "impulse" };
  smoothing_ms?: number;  // default 50
};
// Multiple bindings allowed as array.
type ReactivityParam = Reactivity | Reactivity[];
```

Example:
```js
addText({
  content: "الحجاز",
  position: "center",
  style: "serif, large",
  reactivity: [
    { property: "opacity", feature: "amplitude", map: {in: [0,1], out: [0.5,1.0], curve: "linear"} },
    { property: "scale", feature: "onset_strength", map: {in: [0,1], out: [1.0,1.2], curve: "impulse"}, smoothing_ms: 80 }
  ]
})
```

**Feature → property alignment (guidance baked into `hijaz_base.md` v6.0):**
- Fast features (amplitude, onset_strength) pair with on-beat reactions (scale pulse, opacity pop)
- Slow features (hijaz_intensity, spectral_centroid) pair with lingering behaviors (color drift, slow rotation)
- `hijaz_tahwil` is impulse-shaped → use `curve: "impulse"` for ring-out-and-decay visuals

**Execution (`binding_engine.mjs`):**
- On element mount: parse reactivity array → subscribe each binding to feature_bus
- On feature dispatch: compute target from `map`; call `binding_easing.applyPatch({[property]: target}, smoothing_ms)` on the element's lerper
- On requestAnimationFrame: `lerper.update()` → apply DOM property (transform for scale/rotation/translate; style.opacity for opacity; filter: hue-rotate for color_hue)
- On element fade/remove: unsubscribe bindings, destroy lerper

---

## 9. Patch protocol

Zod discriminated union; single source of truth in `patch_protocol.mjs`. Patches travel WebSocket-encoded JSON.

```ts
import { z } from "zod";

const ReactivitySchema = z.object({
  property: z.enum(["opacity", "scale", "rotation", "translateX", "translateY", "color_hue"]),
  feature: z.enum(["amplitude", "onset_strength", "spectral_centroid", "hijaz_intensity", "hijaz_tahwil"]),
  map: z.object({
    in: z.tuple([z.number(), z.number()]),
    out: z.tuple([z.number(), z.number()]),
    curve: z.enum(["linear", "ease-in", "ease-out", "impulse"])
  }),
  smoothing_ms: z.number().optional()
});

const ElementSpec = z.object({
  element_id: z.string(),
  type: z.enum(["text", "svg", "image"]),
  content: z.record(z.string(), z.unknown()),
  lifetime_s: z.number().nullable(),
  composition_group_id: z.string().nullable(),
  reactivity: z.array(ReactivitySchema).optional()
});

const PatchSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("element.add"), element: ElementSpec }),
  z.object({ type: z.literal("element.update"), element_id: z.string(), changes: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("element.fade"), element_id: z.string(), duration_ms: z.number() }),
  z.object({ type: z.literal("element.remove"), element_id: z.string() }),
  z.object({ type: z.literal("composition_group.add"), group: z.object({
    group_id: z.string(), group_label: z.string(),
    member_element_ids: z.array(z.string()), lifetime_s: z.number().nullable()
  }) }),
  z.object({ type: z.literal("composition_group.fade"), group_id: z.string(), member_ids: z.array(z.string()), duration_ms: z.number() }),
  z.object({ type: z.literal("sketch.background.set"), code: z.string(), audio_reactive: z.boolean() }),
  z.object({ type: z.literal("sketch.add"), sketch_id: z.string(), position: z.string(),
             size: z.enum(["small", "medium", "large"]), code: z.string(),
             audio_reactive: z.boolean(), lifetime_s: z.number().nullable() }),
  z.object({ type: z.literal("sketch.retire"), sketch_id: z.string() }),
  z.object({ type: z.literal("cycle.begin"), cycle_n: z.number(), hijaz_state: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("cycle.end") }),
  z.object({ type: z.literal("prompt.replace"), version: z.string() }),
  z.object({ type: z.literal("replay.begin"), run_id: z.string() }),
  z.object({ type: z.literal("replay.end"), run_id: z.string() })
]);

// Multiplexed WS message
const WsMessageSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("patch"), patch: PatchSchema }),
  z.object({ channel: z.literal("feature"), feature: z.string(), value: z.unknown() })
]);
```

**Reconnect semantics.** On a new stage connection, the server performs a bracketed replay:

1. Emit `{type: "replay.begin", run_id}`.
2. Replay `patch_cache` as a sequence of `element.add`, `composition_group.add`, `sketch.add`, and `sketch.background.set` patches — current state only; `.fade` / `.remove` history is not replayed, and intermediate `.update`s are collapsed into the final element state.
3. Emit `{type: "replay.end", run_id}`.
4. Live stream resumes.

Browser `scene_reducer` tracks replay state as a small state machine:
- **initial** → on `replay.begin`: enter **replaying**, suspend DOM transitions/animations for speed.
- **replaying** → on `replay.end`: enter **synced**, re-enable transitions, mark state. DOM attribute `data-stage-ready` is **not yet set** — a cycle boundary hasn't been observed.
- **synced** → on next `cycle.end`: set `data-stage-ready="1"`.
- `data-stage-ready` is cleared on `cycle.begin` and re-set on the following `cycle.end` for the lifetime of the connection (so Playwright always captures a fully-committed cycle, never a mid-cycle state).

This gives self-frame capture a precise handshake and guarantees Playwright never screenshots a partially-replayed or mid-cycle scene.

**Composition-group field normalization.** The existing `tool_handlers.mjs` stores `composition_group_id` nested inside `element.content` (at `scene_state.mjs:148`). In Session I's patch protocol, `ElementSpec.composition_group_id` is a top-level field. `patch_emitter.mjs` is responsible for this one-way normalization: on emit, it reads `element.content.composition_group_id` and hoists it to `ElementSpec.composition_group_id`, leaving the content object otherwise intact. Scene_state's internal shape is unchanged (65 existing tests still pass); only the wire format is normalized. The browser's `scene_reducer.mjs` reads from the top-level field only.

---

## 10. Audio pipeline

### 10.1 Pre-recorded mode (development, testing, pre-performance)

- Python: `stream_features.py --mode precompute --input path/to/audio.wav --output features_track.json` runs DSP on the file offline, writing a full feature track keyed by timestamp. The track contains **all features** (amplitude, onset_strength, spectral_centroid, hijaz_state, hijaz_intensity, hijaz_tahwil). Python is the single feature extractor across both modes — no cross-implementation drift between offline tuning and live performance.
- Browser: `<audio src="/run/<run_id>/audio.wav">` plays the file for human listeners; `feature_replayer.mjs` fetches `/run/<run_id>/features_track.json` at startup (routes defined in §5.2), then dispatches every feature to `feature_bus` synced to `<audio>.currentTime`. The browser performs no audio analysis — `<audio>` is playback-only.
- No WebSocket feature channel in this mode — all features locally sourced from the pre-computed JSON.

### 10.2 Live mode (performance)

- Python: `stream_features.py --mode live --device "Audient iD14"` opens iD14 via sounddevice; runs DSP at ~60 Hz; connects to stage_server WebSocket and pushes all features (amplitude + onset + centroid + Hijaz) as `{channel: "feature", feature: <name>, value: <v>}` messages.
- Browser: no Web Audio at all; `ws_client.mjs` feeds features into feature_bus. Browser is a pure display client.
- Binding engine cannot distinguish modes — feature bus contract is identical.

### 10.3 Feature vocabulary

All features are normalized to [0, 1] where applicable (amplitude, onset_strength, hijaz_intensity) or have a documented natural range (spectral_centroid in Hz, hijaz_tahwil boolean impulse, hijaz_state string enum mirroring Session B detectors).

---

## 11. Sanitization & safety

- **SVG content** (addSVG, addCompositeScene svg elements) runs through `sanitize.mjs` validators lifted from `render_html.mjs:258–316` verbatim: disallowed tags, event handlers, external hrefs, script protocols, CSS imports, CSS expressions, unsafe data URLs, URL function filters, quote-balance check.
- **CSS backgrounds** (setBackground) run through the parallel CSS validator.
- **Rejected content**: handler returns `{error: "sanitization reason"}` as the tool result; no patch emitted; scene_state untouched. Opus sees the error on the next cycle.
- **p5 code** is not syntax-sanitized — the iframe sandbox (§7.3) is the safety boundary. Runtime errors trigger kill-and-replace without affecting the stage.
- **Image URLs** (addImage) go through existing `image_fetch.mjs` (already sanitized); only the orchestration moves into `image_resolver.mjs`.

---

## 12. Testing

### 12.1 Preserved — 131 current tests all stay green

| File | Tests | Plan |
|---|---|---|
| `scene_state.mjs` | 65 | Extended with composition-group + p5-slot tests; existing unchanged |
| `tool_handlers.mjs` | 30 | Extended with reactivity param + new p5 tool tests |
| `render_html.mjs` | 32 | **Migrates as the file splits:** 14 validation tests → `sanitize.mjs`; 7 image-resolver tests → `image_resolver.mjs`; 6 operator-view tests → `operator_views.mjs`; 5 pure-layout tests → browser-side `scene_reducer.mjs` (jsdom inside node:test) |
| `run_spike.mjs` | 4 | Extended with stage_server lifecycle tests |

### 12.2 New inline self-tests (one per new `.mjs`)

`patch_protocol.mjs`, `patch_emitter.mjs`, `patch_cache.mjs`, `stage_server.mjs`, `sanitize.mjs`, `image_resolver.mjs`, `operator_views.mjs`, `binding_easing.mjs`, `image_content.mjs`, `scene_reducer.mjs`, `feature_bus.mjs`, `feature_replayer.mjs`, `binding_engine.mjs`, `p5_sandbox.mjs`.

### 12.3 Integration

- **Dry-run retained**: deterministic 7-cycle rotation now produces patches (not `final_scene.html`); assertions on final patch stream shape
- **Mock-WS integration**: browser modules run against a mock WebSocket; assertions on final DOM tree via jsdom
- **Real-API smoke**: 3-cycle run with real Opus, mood board loaded, one self-frame trigger; verifies content-block assembly, cache hit on cycle 2, and stage liveness

**Target: 131 → 150+ tests, all green, zero loss.**

---

## 13. File layout

### 13.1 New files

```
feed-looks-back-spike/
├── .gitignore                       [EXTENDED]
├── docs/superpowers/specs/
│   └── 2026-04-23-session-i-live-reactive-stage-design.md   [THIS FILE]
└── node/
    ├── src/
    │   ├── patch_protocol.mjs       [NEW]
    │   ├── patch_emitter.mjs        [NEW]
    │   ├── patch_cache.mjs          [NEW — port of scaffold/server/cache.ts]
    │   ├── stage_server.mjs         [NEW]
    │   ├── sanitize.mjs             [NEW — migrated from render_html.mjs:258–316]
    │   ├── image_resolver.mjs       [NEW — migrated from render_html.mjs:845–888]
    │   ├── operator_views.mjs       [NEW — migrated from render_html.mjs:687–966]
    │   ├── binding_easing.mjs       [NEW — port of scaffold/src/scene/mutation.ts]
    │   └── image_content.mjs        [NEW]
    ├── browser/
    │   ├── stage.html               [NEW]
    │   ├── scene_reducer.mjs        [NEW]
    │   ├── feature_bus.mjs          [NEW]
    │   ├── feature_replayer.mjs     [NEW]
    │   ├── ws_client.mjs            [NEW]
    │   ├── binding_engine.mjs       [NEW]
    │   └── p5_sandbox.mjs           [NEW]
    ├── assets/
    │   └── mood_board/              [NEW — placeholder canon images + artist swaps]
    └── prompts/
        └── mood_board.json          [NEW]

python/
└── stream_features.py               [NEW]
```

### 13.2 Changed files

- `node/src/run_spike.mjs` — start stage_server, coordinate feature streamer, hold stage across cycles
- `node/src/opus_client.mjs` — image content blocks, cache_control, thinking=adaptive, effort=medium
- `node/src/packet_builder.mjs` — mood_board + self-frame content-block assembly; cache breakpoint placement
- `node/src/tool_handlers.mjs` — reactivity param, new p5 handlers, patch emission
- `node/src/scene_state.mjs` — sketch slots, self-frame triggers, SCENE OVERVIEW additions
- `node/prompts/hijaz_base.md` — v5.2 → v6.0 with reactivity guidance, p5 sketch guidance, explicit figurative-aesthetic emphasis
- `node/prompts/configs/*/tools.json` — add setP5Background, addP5Sketch; add optional `reactivity` property to existing placement tools; preserve all existing field names (`content`, `svg_markup`, `query`, `css_background`, `element_id`, `elements`, `group_label`)

### 13.3 Removed files

- `node/src/render_html.mjs` — logic migrated per §13.1

### 13.4 New dependencies (via `pnpm` — spike already uses pnpm)

- `zod` — patch protocol + image_content validation (lifted discipline from scaffold)
- `ws` — WebSocket server (stage_server)
- `playwright` — headless self-frame capture
- `sharp` — mood-board image downscaling
- `p5` — vendored locally. stage_server reads `node_modules/p5/lib/p5.min.js` once at startup and inlines it into each sketch iframe's srcdoc (see §7.3). No CDN dependency during performance; satisfies iframe `connect-src 'none'`.

Python (in the existing `ambi_audio` conda env per memory):
- `websockets` (WS client)
- `sounddevice` (likely already available — to verify during Phase 3)

---

## 14. Phased implementation (7 phases)

Each phase is independently shippable and follows the established Codex-review pattern: implement → tests pass → Codex review → address findings → user approval → commit → next phase.

**Phase 1 — WebSocket stage scaffolding.**
Deliverables: `stage_server.mjs`, `patch_protocol.mjs`, `patch_emitter.mjs`, `patch_cache.mjs`, `stage.html`, `scene_reducer.mjs`, `ws_client.mjs`. Existing six tools still work (handlers emit patches); `render_html.mjs` also still runs in parallel for sanity. **Exit criterion:** visual parity with Session H baseline on the stage over a 7-cycle dry run.

**Phase 2 — `render_html.mjs` split.**
Deliverables: `sanitize.mjs`, `image_resolver.mjs`, `operator_views.mjs` (with tests migrated). `render_html.mjs` deleted at end of phase. Stage becomes the primary output; `operator_views` still writes a parallel `live_monitor.html` for operator observability. **Exit criterion:** 131 tests still green across their new homes; operator view looks right.

**Phase 3 — Audio pipeline.**
Deliverables: `feature_bus.mjs`, `feature_replayer.mjs`, `ws_client.mjs` feature channel, Python `stream_features.py` (both modes — `--mode precompute` and `--mode live`). Features flow but nothing binds yet. **Exit criterion:** feature_bus populated under both modes; values plausible on a known audio sample; offline-vs-live feature distribution identical for the same source audio (since Python is the single extractor).

**Phase 4 — Reactivity.**
Deliverables: `binding_easing.mjs`, `binding_engine.mjs`, reactivity param on existing tools, prompt updates. **Exit criterion:** first audio-reactive visuals observable in a dry-run; real-API 3-cycle smoke produces at least one reactive element per cycle.

**Phase 5 — Perception.**
Deliverables: `image_content.mjs`, `mood_board.json` + placeholder canon assets, packet_builder + opus_client updates for content blocks + cache_control, self-frame Playwright capture. **Exit criterion:** real-API 3-cycle smoke with mood board loaded; cache-read metrics visible in `run_summary.json` on cycle 2+.

**Phase 6 — p5 sandbox.**
Deliverables: `p5_sandbox.mjs`, `setP5Background`, `addP5Sketch` tools + prompt guidance, watchdog + CSP + kill-replace. **Exit criterion:** real-API smoke produces at least one non-abstract p5 sketch; watchdog verified by deliberately injecting a hanging sketch in a test.

**Phase 7 — Production run & comparison.**
Full 31-cycle real-API run on the same audio as Session H baseline (`run_20260423_185946`). **Measurements:** mean active elements, sketch density, reactivity responsiveness, cache hit rate, cost, figurative-vs-abstract qualitative review. Produce `SESSION_I_LOG.md` with diagnostic reasoning and side-by-side comparison.

---

## 15. Open risks & mitigations

| Risk | Mitigation |
|---|---|
| Playwright adds a process dependency and ~100 MB RAM | Accept cost; run on the same machine; launch lazily on first self-frame trigger, not at startup |
| `ws` edge cases (half-open connections, reconnect storm) | `ws` with keepalive + explicit reconnect backoff in browser `ws_client`; exercised in Phase 1 |
| Mood-board cache invalidates mid-session when prompt files or tool schemas are edited | Document in operator notes (matches scaffold's `prompt-caching.md` known-invalidator list); provide a `--keep-warm` heartbeat mode |
| Iframe CSP inheritance inconsistencies across browsers | Target Chrome only (already the operator browser); verify in Phase 6 |
| Opus generates abstract p5 sketches despite prompt guidance | Three-layer mitigation: prompt prose (hijaz_base.md emphasis on figurative), mood-board negative reference image, explicit tool-description text calling out "depict recognizable things." Iterate prompt in Phase 6 smoke runs if needed. |
| Feature bus 60 Hz jank on slower machines | Measure in Phase 4; fall back to 30 Hz if needed; `smoothing_ms` absorbs frame-rate variance |
| Self-frame capture races ahead of WebSocket patch propagation | Playwright waits for a `data-stage-ready` DOM attribute that scene_reducer sets after applying the cycle's last patch |
| Reconnect replay rebuilds large scenes slowly | Acceptable for post-disconnect recovery; not a live-performance concern |
| Zod import in the browser without a build step | Path A commits to no-build. Resolved in Phase 1 by either (a) an `<script type="importmap">` block mapping `"zod"` to a locally-served `node_modules/zod/lib/index.mjs`, or (b) a one-line Node copy step at stage_server startup that writes zod's ESM build to `node/browser/vendor/zod.mjs`. Decision made and documented in Phase 1 handoff. |

---

## 16. Cost estimate

- **LoC net new:** ~2000–2500 (including ported scaffold code + new tests + prompt edits)
- **LoC removed:** ~800 (`render_html.mjs`, migrated not lost)
- **API cost per 31-cycle production run:**
  - Session H baseline: $1.13
  - Session I projection: $1.30–$1.50 (mood-board image tokens + occasional self-frame; cached prefix amortizes most of the mood-board cost after cycle 1)
- **New dependencies:** 4 npm (`zod`, `ws`, `playwright`, `sharp`), 1–2 Python (`websockets`, possibly `sounddevice`)
- **Implementation timeline:** 7 phases with review gates; roughly one phase per session

---

## 17. Approval gate

Written. Awaiting:

1. **User review** of this spec in written form
2. **Spec commit** to git (initial commit of `feed-looks-back-spike/` alongside extended `.gitignore`)
3. **Codex review** of this spec as a versioned artifact (first gate Codex can review as a git-tracked file)
4. **User final approval**
5. **Transition** to `superpowers:writing-plans` skill for the detailed Phase 1 implementation plan
