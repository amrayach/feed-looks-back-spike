# Session I — Design Handoff

**Date:** 2026-04-23
**Status:** Design locked pending final user approval. Ready for implementation.
**Authoritative spec:** `docs/superpowers/specs/2026-04-23-session-i-live-reactive-stage-design.md` (645 lines, commit `b4e792e`)

This handoff summarizes the design session so the next Claude session can pick up without re-reading the full conversation. The spec is the source of truth — this document is the lens onto how it got there, what was deferred, and what to do first.

---

## TL;DR

Session I transforms Feed Looks Back from per-cycle static HTML snapshots into a **live reactive stage**: Opus composes every ~6 s, the browser renders continuously (~60 Hz), and three new capabilities land together — **Perception** (cached mood board + triggered self-frames), **Expression** (p5.js live-coding tools, N=3 cap with iframe sandbox), **Temporality** (declarative audio-reactive property bindings). The spike is now a git repo (`feed-looks-back-spike/`, branch `main`). Two Codex review rounds closed. Next action: produce a Phase 1 implementation plan via `superpowers:writing-plans`.

---

## What got decided

### Architecture

| Decision | Value | Origin |
|---|---|---|
| Stage model | Long-running WebSocket stage (not per-cycle snapshots) | Brainstorm Option A |
| Audio capture | Python is the sole feature extractor in **both** modes | Codex round 1 narrowed from initial hybrid |
| Pre-recorded mode | Python pre-computes full feature track (amp/onset/centroid + Hijaz) → JSON → browser feature_replayer | Codex round 1 |
| Live mode | Python opens iD14 via sounddevice → streams all features via WebSocket | Brainstorm |
| p5 scope | Hybrid: 1 background slot + up to 3 localized sketches, eviction-on-overflow | Brainstorm Option C |
| p5 safety | iframe sandbox + CSP (`default-src 'none'; script-src 'unsafe-inline'; img-src blob: data:`) + vendored p5 (no CDN) + heartbeat watchdog + kill-and-replace | Codex rounds 1+2 |
| Perception cadence | Cached mood board always on + event-triggered self-frame + safety baseline every 5 cycles | Brainstorm Option D |
| Mood board style | Layered Z — figurative positives + tradition anchors + negative "not-this" references | Brainstorm |
| Reactivity grammar | Per-tool `reactivity` param: `{property, feature, map: {in, out, curve}, smoothing_ms?}`; array form for multi-binding | Brainstorm |
| Relationship to scaffold | Path A — stay in spike, lift 4 patterns, no wholesale merge | Brainstorm after scaffold explore |
| Bootstrap | Operator URL `http://host:port/?run_id=<id>&mode=<precompute|live>`; stage.html reads URLSearchParams | Codex round 2 |

### Aesthetic constraint (load-bearing)

**All Opus-authored visuals must be figurative and human-relatable** — recognizable things (lantern, silhouette, textile, calligraphic stroke forming letters, architectural elements). **Not** flow fields, particle clouds, or pure geometric composition as form. This propagates through mood-board curation, p5 sketch prompting, SVG guidance in `hijaz_base.md`, and image search queries.

Stored as user memory: `feedback_feed_looks_back_aesthetic.md`.

### Scaffold lifts (from `/home/amay/Work/Build_With_OPUS_4.7_hack/`)

Four targeted lifts only — nothing else merged:

| Scaffold source | Session I destination | Form |
|---|---|---|
| `src/scene/mutation.ts` (UniformMutator) | `node/src/binding_easing.mjs` | Direct port, adapted from shader uniforms to DOM properties |
| `server/cache.ts` (persistent phrase cache) | `node/src/patch_cache.mjs` | Direct port, adapted from phrase-hash→Response to patch_seq→Patch |
| `server/anthropic-adapter.ts` + `docs/prompt-caching.md` | `node/src/opus_client.mjs` evolution + `node/src/image_content.mjs` | Reference pattern: sequential text blocks, `cache_control: ephemeral` on final static block, `thinking: adaptive` + `effort: medium` |
| `shared/schemas.ts` (Zod discipline) | `node/src/patch_protocol.mjs` | Reference: `z.discriminatedUnion` for the patch protocol |

**Scaffold stays where it is.** Three.js scene, HUD, phrase-boundary model, maqam-guitar prompt corpus, and capture mode are *not* merged.

---

## What got built (this session)

### Git state

```
b4e792e  docs(spec): address second Codex pass — run_id bootstrap, image-cache route, stale metadata
3658e40  docs(spec): address Codex review — asset routes, replay handshake, unified feature extractor, vendored p5, N=3 semantics
d9cb82e  docs: Session I design spec + initial .gitignore       [root]
```

Branch: `main`. Repo freshly initialized this session.

### Files written/modified (tracked)

- `docs/superpowers/specs/2026-04-23-session-i-live-reactive-stage-design.md` — 645-line design spec, 17 sections
- `.gitignore` — extended with Node/Python/Playwright/output patterns
- `SESSION_I_DESIGN_HANDOFF.md` — this document

### Files intentionally untracked

All existing Sessions B–H work (~6000 LoC + 131 inline tests) remains untracked in the new repo:
- `node/src/*.mjs` (run_spike, opus_client, packet_builder, tool_handlers, scene_state, render_html, image_fetch)
- `node/prompts/` (hijaz_base.md v5.2 + configs/)
- `node/output/` (all prior run artifacts, including the Session H baseline `run_20260423_185946/`)
- `node/image_cache/`, `node/node_modules/`, `node/package.json`, `node/pnpm-lock.yaml`
- `python/`, `audio/`, `corpus/`, `README.md`, `SESSION_1_HANDOFF.md`, `requirements.txt`

Amer's call when/how to commit these. Recommended: one "Sessions B–H baseline" commit separating this work from Session I changes.

---

## Codex review loops

### Round 1 (against `d9cb82e`) — 5 findings + 1 open question — resolved in `3658e40`

| # | Level | Finding | Fix |
|---|---|---|---|
| 1 | High | render_html.mjs treated as pure layout; actually bundles sanitization (258–316), image resolution (845–888), operator views (687–966) | Split into 4 named destinations: `sanitize.mjs`, `image_resolver.mjs`, `operator_views.mjs`, browser `scene_reducer.mjs` |
| 2 | High | addCompositeScene + composition_groups were first-class in scene_state but dropped from patch protocol | Added `composition_group.add` / `composition_group.fade` patches; `patch_emitter` hoists `composition_group_id` from `content` to top-level `ElementSpec` |
| 3 | High | p5 "isolated iframe" alone is not a sandbox | Added CSP, heartbeat watchdog (500 ms heartbeat, 2 s timeout), postMessage zod validation, kill-and-replace, N=3 both-ends enforcement |
| 4 | Medium | Image content block plumbing had no owner; packet_builder.mjs was text-only, opus_client.mjs pass-through | New `image_content.mjs`: `loadMoodBoard()` + `captureSelfFrame()` with MIME/size/resolution validation and sharp-based downscaling |
| 5 | Medium | Test-surface miscount (said 131 in scene_state; actually 65+30+32+4 spread across 4 files) | Table corrected; render_html.mjs's 32 tests distributed across the new destinations |
| OQ | — | `scene.snapshot_request` in protocol but unused | Deferred to round 2 |

### Round 2 (against `3658e40`) — 4 findings — resolved in `b4e792e`

| # | Level | Finding | Fix |
|---|---|---|---|
| 1 | High | stage.html had no mechanism to learn active `run_id` / `mode` — `/run/<run_id>/*` routes were unreachable from browser | Added operator URL convention `?run_id=<id>&mode=<precompute|live>`; stage.html reads URLSearchParams; `run_spike.mjs` prints URL on startup; Playwright uses same URL |
| 2 | Medium | `/run/<run_id>/assets/*` route didn't match existing `image_fetch.mjs` layout (which writes to `node/image_cache/`, shared) | Replaced with `/image_cache/<filename>` → `node/image_cache/<filename>`; `image_resolver.mjs` returns `{browser_url, fs_path, attribution, cached}` |
| 3 | Low | §16 said "4 npm deps" but §13.4 listed 5 | Updated to 5 (`zod`, `ws`, `playwright`, `sharp`, `p5`) |
| 4 | Low | §17 approval gate frozen at initial-commit state | Rewritten as status checklist |

### Codex re-paste incident

After the first round's fixes landed in `3658e40`, the user pasted the **same** Codex output verbatim. Verified by grep that all flagged strings were absent from the current spec; pushed back with evidence (`grep` results, current commit hash); asked for either confirmation of re-paste or a fresh run. User then supplied the genuine round-2 output. Pattern to repeat next session: when Codex findings' line numbers point into your patched region, verify against current state before re-applying.

---

## Deferred / to-verify during implementation

| Item | Where | When |
|---|---|---|
| **Zod in browser** without a build step | §15 spec risks | Phase 1 — pick between `<script type="importmap">` → local `node_modules/zod/lib/index.mjs` OR copy-at-startup to `browser/vendor/zod.mjs` |
| **Mood board placeholder canon** image files | §6.1 | Phase 5 — initial canon ships with 5 figurative images (3 positive, 1 anchor, 1 negative); Amer swaps via `mood_board.json` |
| **`sounddevice` in ambi_audio env** | §10.2 | Phase 3 — verify availability; if missing, `pip install sounddevice` into the conda env |
| **Chrome-only compatibility** | §15 | Phase 6 — verify iframe CSP attribute behavior in the target browser; scope explicitly excludes Firefox/Safari |
| **Bashar's real Hijaz recording** | From prior memory | Outside Session I — feature_replayer works with any source; the spike has been exercised against Sample 1 in Sessions B–H |

---

## Next actions

### Before writing any code

1. **User final approval** of the spec as it stands at `b4e792e`
2. **Optional third Codex pass** against `b4e792e` if Amer wants one more check

### First implementation session (Phase 1)

Invoke `superpowers:writing-plans` to produce a detailed implementation plan from §14 Phase 1 of the spec.

**Phase 1 deliverables** (per spec §14):
- `node/src/patch_protocol.mjs` (Zod discriminated union + inline tests)
- `node/src/patch_cache.mjs` (port from scaffold `server/cache.ts`)
- `node/src/patch_emitter.mjs` (tool call → patch(es), including composition_group_id normalization)
- `node/src/stage_server.mjs` (WebSocket + static file server on one port)
- `node/browser/stage.html` (bootstrap: reads URLSearchParams for run_id/mode)
- `node/browser/scene_reducer.mjs` (apply patches to DOM; state machine with `replay.begin` / `replay.end` / `data-stage-ready` gating)
- `node/browser/ws_client.mjs` (multiplexed channels; sends `{run_id, mode}` on connect)

**Phase 1 exit criterion:** existing 6 tools still work (handlers emit patches in addition to updating scene_state); `render_html.mjs` still runs in parallel for sanity; 7-cycle dry run shows visual parity with Session H baseline `run_20260423_185946` on the stage.

### All 7 phases (expected sequence)

1. WebSocket stage scaffolding  ← start here
2. `render_html.mjs` split (sanitize/image_resolver/operator_views + scene_reducer migration)
3. Audio pipeline (feature_bus, feature_replayer, Python `stream_features.py`)
4. Reactivity (binding_easing, binding_engine, `reactivity` param on tools)
5. Perception (mood_board.json + canon assets, `image_content.mjs`, cache_control, self-frame via Playwright)
6. p5 sandbox (`setP5Background`, `addP5Sketch`, CSP/watchdog/vendored-p5)
7. Production run + comparison — full 31-cycle real-API against Session H baseline

Each phase follows: implement → tests green → Codex review → address findings → user approval → commit → next.

---

## Launch prompt for the next Claude session

Paste this into a fresh Claude session to resume:

```
Resuming Session I of Feed Looks Back. Design is locked and committed;
your job is to produce the Phase 1 implementation plan and then execute
it with phase-gate discipline.

READ FIRST, in order:
1. /home/amay/Work/feed-looks-back-spike/SESSION_I_DESIGN_HANDOFF.md
   (summary of the design session — decisions, commits, deferred items)
2. /home/amay/Work/feed-looks-back-spike/docs/superpowers/specs/
   2026-04-23-session-i-live-reactive-stage-design.md
   (authoritative 645-line spec, 17 sections)

CHECK MEMORY: user_amer_artist, project_feed_looks_back_session_i,
feedback_feed_looks_back_aesthetic, feedback_codex_review_pattern.
The aesthetic memory is load-bearing — figurative, not abstract.

REPO STATE:
- /home/amay/Work/feed-looks-back-spike/ is a git repo on branch `main`
- Three commits: d9cb82e → 3658e40 → b4e792e (run `git log --oneline`)
- Existing Sessions B–H code (~6000 LoC + 131 tests) is UNTRACKED
  pending Amer's commit decision; do not commit it without asking
- Session H baseline run: node/output/run_20260423_185946/

REFERENCE ONLY (read patterns, do not modify):
/home/amay/Work/Build_With_OPUS_4.7_hack/ — Day 1 scaffold. Four
patterns are lifted per spec §3 (UniformMutator, cache, anthropic-
adapter + prompt-caching.md, Zod discipline). Nothing else is merged.

FIRST ACTION: invoke superpowers:writing-plans to produce the Phase 1
implementation plan. Phase 1 scope and exit criterion are in spec §14.
Before generating the plan, verify:
  - All 131 existing inline tests still pass (run each of
    scene_state.mjs, tool_handlers.mjs, render_html.mjs, run_spike.mjs
    directly with node)
  - pnpm install succeeds in node/
  - git status shows working tree clean except intentional untracked

WORKFLOW: Amer uses Codex review after each phase gate. Pattern:
implement → tests pass → Codex review → address findings → request
approval → commit → next phase. When Codex output's line numbers point
into your already-patched region, verify against current state (grep,
commit hash) before re-applying.
```
