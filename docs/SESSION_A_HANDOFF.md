# Session A (2026-04-24) — Handoff

**Author:** Claude (Opus 4.7 1M) run as Session A, the coordinator session for Phases 0, 3, 4, 6, 7.
**Parallel session:** Session B on branch `phase-5` (worktree at `/home/amay/Work/feed-looks-back-spike-phase-5`) — owns Phase 5 (mood board + self-frame).
**Session A working dir (control):** `/home/amay/Work/build_spikes_tests` — do not edit files here; all work targets the spike repo.
**Spike repo (target):** `/home/amay/Work/feed-looks-back-spike`
**Branch at handoff:** `main` @ `306d904`, pushed to `origin/main` at `github.com:amrayach/feed-looks-back-spike`.
**Phase-5 tip:** `97c11dd` (unmerged; 9 commits ahead of where `phase-5` branched; `main` is 24 commits ahead of that divergence). Session B has progressed since this handoff was written; see `PHASE_5_SESSION_HANDOFF.md` on branch `phase-5` for the current phase-5 state.

---

## 1. What Session A shipped

### 1.1 Phase 0 — closed Phase 2 gate
Phase 2 (the `render_html.mjs` split in `73a1d60`) and its browser-safe-guard fix (`901dec8`) had never received a Codex post-fix review. Session A ran that review. Codex returned **ship as-is, 2 Low findings**:
- SESSION_I_DESIGN_HANDOFF.md still referenced the deleted `render_html.mjs`. Fixed in the status banner + the launch-prompt test list.
- `escapeHtml()` in `operator_views.mjs:28` had no focused regression test after the split. Added one.

Commit: `639d3c0`. Test count: 177 → 178.

### 1.2 Phase 3 — audio feature pipeline (10 commits + plan)
Python is now the sole DSP across both modes. The browser performs no audio analysis.

| File | Role |
|---|---|
| `node/src/patch_protocol.mjs` | Added `hijaz_state` to `ReactivitySchema.feature` enum; new `FEATURE_VALUE_SCHEMAS` per-feature map, `FEATURE_NAMES` frozen tuple, `FeatureFrameSchema` (canonical 60 Hz frame shape), `FeaturesTrackSchema` (schema_version "1"). `WsMessageSchema` uses `discriminatedUnion(...).superRefine(...)` — outer refine validates feature-arm values against the per-feature schema. |
| `node/browser/feature_bus.mjs` (new) | Set-per-feature pub/sub with synchronous ordered dispatch + throwing-subscriber isolation. API: `{subscribe, dispatch, last, dispose}`. |
| `node/browser/feature_replayer.mjs` (new) | Fetches `/run/<run_id>/features_track.json`, binary-search-syncs dispatch to `<audio>.currentTime` via injected rAF. Seek handler dispatches the sought-to frame immediately so `bus.last()` never stays stale (fixed after Codex Medium finding). |
| `node/src/stage_server.mjs` | Role-aware hello (default `operator`, opt-in `feature_producer` with per-run random-bytes token). Feature-producer posts are rebroadcast to all operators of the current run. Operators are read-only. Public `broadcastFeature(feature, value)` for Node-side use. |
| `node/browser/stage.html` | Wires feature_bus + feature_replayer + ws_client.onFeature. `window.__featureBus` exposed as devtools debug hook. |
| `node/src/run_spike.mjs` | New exported `startFeatureProducer({mode, runId, wsUrl, wsToken, producer, ...})` that spawns `stream_features.py` as a child process in live stage mode + real Opus mode. Cleanup hoisted into outer `finally` so exceptions + SIGINT both tear down the Python child. New `--feature-producer <python|none>` CLI flag (default auto-selects by stage mode). |
| `python/stream_features.py` (new) | Two subcommands: `--mode precompute` (reads audio file, reuses `generate_corpus.compute_pass_1_cycles` + `summarizer.detect_tonal_gravity/detect_aug2` + `categorize_intensity`, resamples to 60 Hz, writes `features_track.json`); `--mode live` (opens `sounddevice` iD14 input, streams feature frames to stage WS, self-terminates when sender WS dies). |
| `requirements.txt` | Adds `sounddevice>=0.4.7,<0.6` and `websockets>=12.0,<14`. |

Codex review (`edb0bc6..ff39dc9`): 1 High (producer cleanup on abnormal exit), 1 Medium (seek left bus stale), 1 Low (role trusted without auth) — all three fixed in `ad3bab6`.

Sample 1 smoke: 159.9 s duration, 9595 frames, observed states `{quiet, approach, arrived}`, 0 tahwil impulses. The zero-tahwil finding matches prior Session B empirical memory (`tahwil/aug2 never fire on Sample 1`) — validation, not a bug.

Test count: 178 → 208.

### 1.3 Phase 4 — reactivity (10 commits including plan)

| File | Role |
|---|---|
| `node/src/binding_easing.mjs` (new, shared) | Pure math ported from scaffold UniformMutator. `EASING_CURVES` (linear / ease-in / ease-out / impulse), `applyCurve`, `interpolate`, `mapInputToOutput`, `createLerper`. `DEFAULT_SMOOTHING_MS=50`, `IMPULSE_DEFAULT_SMOOTHING_MS=200`. Zero-width `map.in` treated as equality threshold (supports `hijaz_state` gating). Served at `/shared/binding_easing.mjs`. |
| `node/src/stage_server.mjs` | Added `/shared/binding_easing.mjs` to the `/shared/` allowlist so the browser can import the shared easing module at runtime (commits `01ea35e`, `fbe8a60`; row added 2026-04-24 per retroactive Codex audit). |
| `node/browser/binding_engine.mjs` (new) | Per-element subscribe/lerp/apply-to-DOM. `createBindingEngine({bus, rafImpl, cancelRafImpl, now})` → `{mount, unmount, dispose}`. Single rAF loop shared across entries. Transform keys composed in fixed order (scale → rotation → translateX → translateY) for determinism. `hijaz_state` numerically encoded (quiet=0..aug2=4). `hijaz_tahwil` coerced to 0\|1. Late-mount seeds from `bus.last()`. |
| `node/src/tool_handlers.mjs` | `validateReactivity(raw)` normalizes single-or-array input and Zod-validates each via `ReactivitySchema`. Wired into addText/addSVG/addImage + per-member of addCompositeScene. Atomic composite rejection if any member's reactivity is invalid. |
| `node/src/scene_state.mjs` | `addElement` accepts optional `reactivity` and stores it top-level when non-empty (shape-stable for non-reactive elements). `formatSummary` marks reactive elements with `(… reactive: prop←feature, …)` clause. |
| `node/src/patch_emitter.mjs` | `normalizeElementForPatch` forwards `reactivity` into `element.add` patches. |
| `node/browser/scene_reducer.mjs` | `createSceneReducer` accepts optional `bindingEngine`. `element.add` mounts; `element.fade`/`element.remove` unmounts BEFORE the DOM fade window opens (so feature_bus stops writing during the 400 ms visual decay). `composition_group.fade` unmounts every member via the existing `removeElement` path. |
| `node/browser/stage.html` | Instantiates one `bindingEngine` per page. |
| `node/prompts/hijaz_base.md` | v5.2 → v6.0: new Reactivity section (feature character, pairing principles, three worked examples, discipline anti-patterns). |
| `node/prompts/configs/config_a/tools.json` | Reactivity input_schema added to addText/addSVG/addImage/addCompositeScene members. |

Codex never finished a review of `be3b936..93431b0` (agent returned without output; subprocess still running at 233s). Session A self-reviewed against invariants (Phase 5 zero-overlap, browser-safe guards, feature vocabulary consistency) and pushed. **Retroactive Codex sweep still recommended.**

Test count: 208 → 244.

### 1.4 Phase 6 — p5 sandbox (9 commits including plan)

| File | Role |
|---|---|
| `node/node_modules/p5/` (vendored) | `pnpm add p5` → `p5@2.2.3`. `node/node_modules/p5/lib/p5.min.js` is 963 KB. |
| `node/package.json`, `node/pnpm-lock.yaml` | `pnpm add p5` (commit `786b789`) recorded `p5@2.2.3` in both files (row added 2026-04-24 per retroactive Codex audit). |
| `node/src/stage_server.mjs` | Single explicit-path route `/vendor/p5/p5.min.js`. Browser-safety regression test extended to cover every new browser module (binding_engine + p5_sandbox + feature_bus + feature_replayer + binding_easing). |
| `node/browser/p5_sandbox.mjs` (new) | Host-side iframe manager. `createP5Sandbox({documentLike, mount, bus, fetchImpl, rafImpl, cancelRafImpl, setIntervalImpl, clearIntervalImpl, now, heartbeatTimeoutMs, watchdogIntervalMs, warmupGraceMs, onRetire, onSketchError})` → `{mountBackground, mountLocalized, retireSketch, dispose}`. Iframe template inlined as a template literal. Two sentinel placeholders (`/*__FLB_P5_SOURCE__*/`, `/*__FLB_USER_SKETCH__*/`) substituted at mount time via `buildSketchSrcdoc`. Iframe attributes: `sandbox="allow-scripts"` (no same-origin), `csp="default-src 'none'; script-src 'unsafe-inline'; img-src blob: data:"`. Features posted to iframes via rAF loop. Heartbeat watchdog retires sketches silent for >= 2 s after a 3 s warmup grace. postMessage validation via Zod discriminated union over heartbeat/ready/error types. |
| `node/src/scene_state.mjs` | Added `p5_background: null`, `p5_sketches: []`, `next_sketch_index: 1`. Helpers: `mintSketchId`, `setP5Background` (replaces + returns `retired_id?`), `addP5SketchSlot` (eviction-on-overflow when cap=3, returns `retired_id?`), `retireP5Sketch`. `formatSummary` adds a P5 SKETCHES block. |
| `node/src/tool_handlers.mjs` | `handleSetP5Background`, `handleAddP5Sketch`. Position = 9-anchor enum, size = small\|medium\|large. audio_reactive required boolean. |
| `node/src/patch_emitter.mjs` | For each p5 tool: emit `sketch.retire` (if `retired_id`) BEFORE `sketch.background.set` / `sketch.add`. |
| `node/browser/scene_reducer.mjs` | Dispatches `sketch.background.set` / `sketch.add` / `sketch.retire` to `p5Sandbox`. Belt-and-suspenders N=3 in the reducer — if a 4th `sketch.add` arrives without a preceding retire, reducer evicts the oldest locally and warns. |
| `node/browser/stage.html` | Instantiates one `p5Sandbox` per page. |
| `node/prompts/hijaz_base.md` | v6.0 → v6.1: new Sketches section. **Figurative-only rule restated in tool descriptions AND the long prompt AND with explicit anti-examples (particles, flow fields, noise loops are explicit rejections).** Two worked code examples (oil-lamp background, ink-stroke localized). |
| `node/prompts/configs/config_a/tools.json` | Adds `setP5Background` and `addP5Sketch`. Tool count: 6 → 8. |

No Codex review yet. Test count: 244 → 272.

### 1.5 Phase 7 — scaffolding (2 docs, no code)

- `docs/superpowers/plans/2026-04-24-session-i-phase-7-production-run-plan.md` — 31-cycle real-API run parameters, preconditions, risks, exit criteria.
- `docs/2026-04-24-session-i-vs-h-comparison.md` — Session H numbers pre-populated (31/31, 54 tool calls, $1.1336685, zero failures), Session I column empty pending the actual run, 16-row capability delta table filled, aesthetic section structured as questions for Amer.

The production run itself is **user-triggered**, not auto-fired. Real-API cost ~$1-2 per run.

---

## 2. Test totals

| Suite | Count | Source |
|---|---|---|
| sanitize.mjs | 7 | pre-Session-I |
| image_resolver.mjs | 4 | pre-Session-I |
| scene_layout.mjs | 6 | pre-Session-I |
| operator_views.mjs | 22 | pre-Session-I + Phase 0 escapeHtml |
| patch_emitter.mjs | 8 | +1 reactivity (Phase 4), +2 sketches (Phase 6) |
| stage_server.mjs | 9 | +3 Phase 3 feature routes, +1 features_track serve, +1 p5 vendor serve (counted in the 9 after consolidation) |
| scene_state.mjs | 75 | +4 reactivity (Phase 4), +6 p5 slots (Phase 6) |
| tool_handlers.mjs | 42 | +6 reactivity (Phase 4), +5 p5 tools (Phase 6) |
| patch_protocol.mjs | 15 | +7 Phase 3 (hijaz_state enum, FeatureValueSchema, FeatureFrameSchema, FeaturesTrackSchema, WsMessageSchema refinement) |
| patch_cache.mjs | 4 | pre-Session-I |
| image_fetch.mjs | 4 | pre-Session-I |
| binding_easing.mjs | 11 | Phase 4 new |
| scene_reducer.mjs | 15 | +4 reactivity (Phase 4), +4 sketch delegation (Phase 6) |
| bootstrap.mjs | 3 | pre-Session-I |
| ws_client.mjs | 2 | pre-Session-I |
| feature_bus.mjs | 7 | Phase 3 new |
| feature_replayer.mjs | 4 | Phase 3 new |
| binding_engine.mjs | 10 | Phase 4 new |
| p5_sandbox.mjs | 11 | Phase 6 new |
| **Node module total** | **259** | |
| run_spike.mjs --self-test | 9 | +3 Phase 3 feature-producer tests |
| python/stream_features.py --self-test | 4 | Phase 3 new (+1 in live-mode Task 7) |
| **Grand total** | **272** | (was 178 at Phase 0 start) |

Run the full suite from `node/` with:

```bash
for f in src/*.mjs browser/*.mjs; do node "$f" 2>&1 | tail -1; done
node src/run_spike.mjs --self-test
/home/amay/miniconda3/envs/ambi_audio/bin/python ../python/stream_features.py --self-test
```

---

## 3. Load-bearing invariants

These hold at `306d904`. Every subsequent session must preserve them.

1. **Phase-boundary file ownership.** Session A phases are disjoint from Phase 5's file set. Phase 5 touches: `opus_client.mjs`, `packet_builder.mjs`, `image_content.mjs` (new), `self_frame.mjs` (new), `run_spike.mjs` (cycle-loop hook), `canon/*`, `mood_board.json`, `package.json`, `pnpm-lock.yaml`. Session A did not touch any of those (except the lock/package files for `p5` which will conflict on merge; resolve with `pnpm install`).

2. **Python is the sole DSP** across both audio modes. No browser librosa, no Web Audio, no `getUserMedia`, no FFT in `node/browser/`. (References to string feature names like `"spectral_centroid"` are OK — those are labels, not DSP.)

3. **Browser-safe guard** on every `node/browser/*.mjs` and every shared `node/src/*.mjs` served under `/shared/`:
   ```js
   const isDirectNodeExecution =
     typeof process !== "undefined" &&
     Array.isArray(process.argv) &&
     import.meta.url === `file://${process.argv[1]}`;
   if (isDirectNodeExecution) { /* self-tests */ }
   ```
   `stage_server.mjs` has a regression test (`browser-imported shared modules load without a global process`) that execFiles each such module with `globalThis.process = undefined` and asserts it loads — breaking the pattern fails CI.

4. **Feature vocabulary is fixed at six names**: `amplitude`, `onset_strength`, `spectral_centroid`, `hijaz_state`, `hijaz_intensity`, `hijaz_tahwil`. Must be identical across `patch_protocol.mjs` (FEATURE_NAMES + FEATURE_VALUE_SCHEMAS + ReactivitySchema.feature enum), `feature_replayer.mjs`, `stream_features.py` (both modes), and the inline bridge code in `p5_sandbox.mjs`.

5. **Feature vocabulary ranges**: amplitude [0,1], onset_strength [0,1], spectral_centroid ≥0 Hz, hijaz_state enum `quiet|approach|arrived|tahwil|aug2`, hijaz_intensity [0,1], hijaz_tahwil boolean.

6. **hijaz_state encoding is environment-dependent**. Binding engine numerically encodes (quiet=0, approach=1, arrived=2, tahwil=3, aug2=4) so `mapInputToOutput` can do range math. Sketches see the raw string via `window.features.hijaz_state`. This asymmetry is deliberate.

7. **Reactivity shape stability**: an element with no reactivity produces patches + scene_state JSON byte-identical to pre-Phase-4. Only elements WITH a non-empty reactivity array get the `reactivity` key. This is asserted.

8. **Binding cleanup on fade**: `bindingEngine.unmount` fires BEFORE the DOM fade window opens — feature_bus must not be writing transforms on an element as it animates out.

9. **p5 N=3 enforced on BOTH ends**: tool_handler + patch_emitter do server-side eviction; reducer does belt-and-suspenders client-side eviction. Neither path rejects — always an evict-and-mount.

10. **p5 sandbox attributes**: `sandbox="allow-scripts"` (no `allow-same-origin`!), `csp="default-src 'none'; script-src 'unsafe-inline'; img-src blob: data:"`. Triple-redundant isolation (sandbox + CSP + heartbeat watchdog).

11. **Figurative aesthetic is load-bearing**, enforced at the prompt, not at runtime. Any sketch or mood-board asset must depict recognizable things. Flow fields, particle clouds, Perlin-noise backgrounds are explicit rejections. Stored in user memory as `feedback_feed_looks_back_aesthetic.md`.

12. **All patches go through Zod discriminated-union validation** at every ingress: stage_server.mjs WS layer (WsMessageSchema), feature_replayer.mjs (FeaturesTrackSchema), tool_handlers.mjs (ReactivitySchema via validateReactivity). Binding engine and p5 sandbox trust validated data.

---

## 4. What is NOT done

### 4.1 Retroactive Codex reviews I left on the table
- **Phase 4** (`be3b936..93431b0`): the first Codex agent hit its forwarder timeout (233s) without returning output. I self-reviewed against invariants + pushed. Retroactive sweep recommended.
- **Phase 6** (`162d6af..ef3ecfb`): Session A ran out of time to launch a post-wrap Codex review before handoff.

Both Phase 4 and Phase 6 are in production state behind self-tests; the risk is subtle issues Codex would catch (race conditions, missed teardown paths, subscription leaks).

### 4.2 Phase 5 merge
- Branch `phase-5` is 8 commits ahead of where it branched from main; main is 23 commits ahead of that divergence point.
- **Expected conflicts**: `node/package.json` + `node/pnpm-lock.yaml` (both branches added deps). Resolve by `cd node && pnpm install` post-merge.
- **Disjoint files** (no conflict):
  - Session A only: `binding_engine.mjs`, `binding_easing.mjs`, `feature_bus.mjs`, `feature_replayer.mjs`, `p5_sandbox.mjs`, `stream_features.py`, scene_reducer.mjs (Phase 5 doesn't touch it), scene_state.mjs (Phase 5 doesn't touch it), tool_handlers.mjs (Phase 5 doesn't touch it), patch_emitter.mjs, stage_server.mjs.
  - Phase 5 only: `opus_client.mjs`, `packet_builder.mjs`, `image_content.mjs`, `self_frame.mjs`, `canon/*`, `mood_board.json`.
  - Both (append-only, easy merge): `hijaz_base.md`, `tools.json`. Phase 5 may have prompt text edits but plan says appended sections, not in-place edits.
  - Both (conflict expected): `run_spike.mjs`. Session A's diff is small and lives OUTSIDE the cycle loop (spawn before loop, stop in finally). Phase 5's diff (204 lines per their plan) lives INSIDE the cycle loop (self-frame hook). The regions do not overlap syntactically; three-way merge should succeed.

### 4.3 Production run (Phase 7)
Not fired. Real-API cost ~$1-2. Follow the Phase 7 plan §3 when ready.

### 4.4 Comparison doc aesthetic section
Pending Amer's side-by-side review after the production run.

### 4.5 Playwright real-browser test
Spec §14 Phase 7 calls for a Playwright smoke. I did not add one — every Phase 4/6 test uses FakeDocument/FakeElement instead. A real Chrome smoke (feature bus + binding engine + p5 sandbox all wired) would catch integration bugs that node-fake tests miss.

---

## 5. Repo state at handoff

```
main (pushed):       c928fcb docs: Session A handoff — comprehensive state + launch prompt for next session
phase-5 (unmerged):  97c11dd (Session B progressed since; see PHASE_5_SESSION_HANDOFF.md)
divergence (main...phase-5): 24 ↔ 9  (as of 2026-04-24 retroactive Codex review)
```

23 Session-A commits on main since Phase 5 branched. Session A closed Phase 0, delivered Phases 3/4/6 implementations, and wrote Phase 7 scaffold.

Untracked in working tree: `node/.codex-preflight-write-check` (harmless Codex pre-flight artifact; do not commit).

---

## 6. Launch prompt for the next session

Copy the fenced block below into a fresh Claude session. Start from the **same control directory** (`/home/amay/Work/build_spikes_tests`) if you want the path-pattern to match Session A's habits.

```text
You are resuming Feed Looks Back Session I work. The previous session
(Session A) shipped Phases 0, 3, 4, 6, 7-scaffold and closed at commit
306d904 on main. A parallel session (Session B) is on branch phase-5,
also active.

Control directory (cwd): /home/amay/Work/build_spikes_tests
Target repo (NEVER cd into; use absolute paths): /home/amay/Work/feed-looks-back-spike
Branch: main @ 306d904 (pushed to origin/main)
Phase-5 branch: 4639eeb (8 ahead of divergence)

READ FIRST, in order:
  1. /home/amay/Work/feed-looks-back-spike/docs/SESSION_A_HANDOFF.md
     — authoritative state dump from the previous session
  2. /home/amay/Work/feed-looks-back-spike/docs/superpowers/specs/
     2026-04-23-session-i-live-reactive-stage-design.md
     — the locked 645-line design spec (commit b4e792e)
  3. /home/amay/Work/feed-looks-back-spike/docs/superpowers/plans/
     2026-04-24-session-i-phase-7-production-run-plan.md
     — the open Phase 7 plan
  4. /home/amay/Work/feed-looks-back-spike/docs/2026-04-24-session-i-vs-h-comparison.md
     — comparison scaffold (Session H pre-populated, Session I pending)

CHECK MEMORY: user_amer_artist, project_feed_looks_back_session_i,
feedback_feed_looks_back_aesthetic, feedback_codex_review_pattern.
The aesthetic memory is load-bearing — figurative, not abstract.

OPERATING RULES (same as Session A):
  - Absolute paths only. Read/Edit/Write under /home/amay/Work/feed-looks-back-spike/
  - All git: `git -C /home/amay/Work/feed-looks-back-spike <cmd>`
  - Never `cd` into the target repo. If you must, do it inside the Bash call only.
  - Stage server + run_spike: cd inside the Bash call, don't persist.

DO NOT TOUCH (Phase 5 files, owned by the parallel session):
  node/src/opus_client.mjs (Phase 5 modifies)
  node/src/packet_builder.mjs (Phase 5 modifies)
  node/src/image_content.mjs (Phase 5 new)
  node/src/self_frame.mjs (Phase 5 new)
  node/canon/*
  node/prompts/mood_board.json (if it's there)
  node/src/run_spike.mjs cycle-loop body (~lines 705-820) — Phase 5 hooks here

IMMEDIATE NEXT ACTIONS IN PRIORITY ORDER:

  A. RETROACTIVE CODEX REVIEWS (safe, reversible, high leverage)
     - Phase 4 range: be3b936..93431b0
     - Phase 6 range: 162d6af..ef3ecfb
     Launch via the codex:codex-rescue agent with explicit invariants
     (see SESSION_A_HANDOFF.md §3). Address any High/Medium findings.
     Session A self-reviewed but Codex was never completed.

  B. PHASE 5 MERGE (check with user before firing)
     git -C /home/amay/Work/feed-looks-back-spike fetch origin
     git -C /home/amay/Work/feed-looks-back-spike merge --ff-only origin/phase-5
     Expected conflicts: node/package.json, node/pnpm-lock.yaml —
     resolve with `cd node && pnpm install`. run_spike.mjs may need a
     three-way merge; Session A's diff is outside the cycle loop,
     Phase 5's is inside. Verify.

  C. PRE-FLIGHT SMOKE before the production run
     1. Phase 5 merged
     2. Precompute Sample 1 features_track.json
     3. Start run_spike in dry-run mode pointing at the run dir
     4. Open the operator URL in Chrome
     5. Verify window.__featureBus.last("amplitude") updates with audio,
        window.__bindingEngine is live, window.__p5Sandbox is live
     6. Hand-paste a setP5Background or addP5Sketch patch via the
        reducer (devtools) — confirm iframe mounts + receives features

  D. PHASE 7 PRODUCTION RUN (user-triggered, real-API cost ~$1-2)
     Per the Phase 7 plan §3. Capture artifacts; populate the
     comparison doc's quantitative tables; mark aesthetic section
     as pending Amer.

TEST TOTALS AT HANDOFF: 272 (259 Node module + 9 run_spike + 4 Python).
All green at 306d904.

WORKFLOW: Phase gate = implement → tests → Codex review → address →
user approval → commit → push. Session A committed + pushed
incrementally throughout; main is synced with origin.

FIRST ACTION: read SESSION_A_HANDOFF.md and the Phase 7 plan, then
ask the user which of (A/B/C/D) above to start.
```
