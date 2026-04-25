# Final Deep Dive Check — 2026-04-25

Repository: `/home/amay/Work/feed-looks-back-spike`  
Branch: `test/integration-all-four`  
Purpose: pre-submission repository, README, documentation, and verification pass.

> **Latest update (2026-04-25 afternoon):** A second pass landed framing
> alignment with the locked submission strategy (solo voice, music-as-cultural-carrier,
> no collaborator naming in public copy), tightened reference-photo handling
> via `.gitignore`, and added a public-facing project description. Validation
> suite re-run after the doc pass. See "Second-pass changes" below.

## Current State

This repo is no longer just the original Session 1 DSP spike. It now contains:

- Python DSP corpus generation and feature-track precompute.
- Node Opus live runner.
- Browser stage, p5 sandbox, HUD, and Chain A effects layer.
- Bayati prompt package with Config A tool schema.
- Bake-mode Opus pipeline:
  - Pass 1: full-track composition plan.
  - Pass 2: per-cycle tool-call execution.
  - Pass 3: critique and refinement.
  - Replay/capture helpers.
- Two baked track bundles:
  - `bake_song1`: 27 cycles, refined v2 cycles present.
  - `bake_song5`: 30 cycles, refined v2 cycles present.

## Code Review Graph

`code-review-graph` was used as requested.

Results:

- `build_spikes_tests` staging folder: graph empty (`0 nodes`, `0 edges`).
- Actual repo `/home/amay/Work/feed-looks-back-spike`: `498 nodes`,
  `2787 edges`, `16 files`, languages `javascript` and `python`.
- Last graph update: `2026-04-25T06:31:17`.
- Minimal context risk: `medium (0.55)`.
- Impact radius over the dirty tree: high; `31 changed file(s)`,
  `388 nodes directly changed`, `83 nodes impacted within 2 hops`,
  `3 additional files affected`.
- Graph helper caveat: `get_knowledge_gaps_tool` and
  `get_suggested_questions_tool` errored with a path-resolution bug
  (`'str' object has no attribute 'resolve'`). Core stats and impact radius
  worked.

Interpretation: documentation cannot truthfully describe this as a tiny patch.
The repo is a broad integration branch with high blast radius, so the final
submission docs now foreground validation, residual risk, and run commands.

## Fixes Made During This Pass

### README and docs (first pass)

- Replaced stale top-level `README.md` with current repo map, setup,
  live/API mode, bake mode, replay, and validation instructions.
- Replaced stale `node/README.md` with current Node runtime and bake-mode
  commands.
- Added `docs/SUBMISSION.md` with launch-transcript-aligned rubric framing,
  demo structure, writeup draft, run commands, and asset-rights notes.
- Added this final audit document.

### Second-pass changes (2026-04-25 afternoon, framing alignment)

- Rewrote `README.md` to lead with the artistic statement (the *piece*
  before the directory layout), with explicit prize framing and pointers
  to the new public-facing description.
- Rewrote `docs/SUBMISSION.md` to remove the only `Bashar/` reference in
  any public-facing doc (was in the demo-shape table), pivot to
  music-as-cultural-carrier framing rather than Arab-specific framing,
  and replace the writeup draft with a public-safe distillation aligned
  to the locked submission strategy.
- Added `docs/PROJECT_DESCRIPTION.md` — a one-pager judges can read
  quickly. Distinct from internal form-field copy; public-safe.
- Rewrote `node/canon/reference_photos/ATTRIBUTION.md` to present only
  the five fully-attributed photos as the published canon, with a
  transparent note about seven locally-curated photos excluded from the
  public repo for rights diligence.
- Updated `.gitignore` to exclude:
  - The seven unrecoverable reference photos (`02_*`, `05_*`, `07_*`,
    `09_*`, `10_*`, `11_*`, `12_*`).
  - `.codex/` and `node/.codex-preflight-write-check`.
  - `docs/STATUS_FOR_BASHAR.md` and similar internal handoff docs that
    were untracked at scrub time (`COORDINATOR_*_evening.md`,
    `BAKE_MODE_HANDOFF_*.md`, `ULTRAREVIEW_*.md`,
    `2026-*-session-*.md`).
- Scrubbed two collaborator-naming code comments in
  `python/summarizer.py` (lines 327-329 and 380-385) to use
  domain-generic phrasing.

### Chain A hardening

`node/browser/chain_a.mjs` now degrades cleanly in Node test harnesses:

- Falls back from `requestAnimationFrame` to `setTimeout`.
- Skips typewriter DOM wrapping when `document.createElement` is unavailable.
- Handles wrappers without `querySelectorAll` in the erosion path.

Production browser behavior is unchanged; the patch removes noisy caught hook
errors from `scene_reducer.mjs` tests.

### Python onset-density hardening

`python/generate_corpus.py` no longer calls `librosa.util.peak_pick` for onset
density. That function entered a numba gufunc path that segfaulted during
`stream_features.py --self-test` in this environment. A small pure-NumPy peak
picker now performs the local-max/local-average/wait logic directly.

Validation after the change:

- `stream_features.py --self-test` passes 4/4.
- `generate_corpus.py --print-example` on `audio/song 1.wav` completes.
- `test_enrich_track` passes under the intended env with writable cache dirs.

## Validation Results

Node checks run:

| Check | Result |
|---|---|
| `node node/src/run_spike.mjs --self-test` | 13/13 passed |
| `node node/src/stage_server.mjs` | 22/22 passed with localhost permission |
| `node node/browser/audio_visual_layer.mjs` | 9/9 passed |
| `node node/browser/binding_engine.mjs` | 22/22 passed |
| `node node/browser/feature_bus.mjs` | 7/7 passed |
| `node node/browser/feature_replayer.mjs` | 4/4 passed |
| `node node/browser/hud_parser.mjs` | 8/8 passed |
| `node node/browser/hud.mjs` | 1/1 passed |
| `node node/browser/p5_sandbox.mjs` | 22/22 passed |
| `node node/browser/scene_reducer.mjs` | 31/31 passed |
| `node node/browser/bootstrap.mjs` | 5/5 passed |
| `node node/browser/ws_client.mjs` | 2/2 passed |
| `node node/src/opus_client.mjs` | 6/6 passed |
| `node node/src/sanitize.mjs` | 7/7 passed |
| `node node/src/invariants.mjs` | 7/7 passed |
| `node node/src/prompts_aesthetic.mjs` | 4/4 passed |
| `node node/src/image_content.mjs` | 14/14 passed |
| `node node/src/image_fetch.mjs` | 4/4 passed |
| `node node/src/packet_builder.mjs` | 12/12 passed |
| `node node/src/scene_state.mjs` | 93/93 passed |
| `node node/src/tool_handlers.mjs` | 63/63 passed |
| `node node/src/patch_emitter.mjs` | 12/12 passed |
| `node node/src/operator_views.mjs` | 22/22 passed |
| `node node/src/patch_protocol.mjs` | 28/28 passed |
| `node node/src/scene_layout.mjs` | 6/6 passed |
| `node node/src/binding_easing.mjs` | 12/12 passed |
| `node node/src/patch_cache.mjs` | 4/4 passed |
| `node node/src/self_frame.mjs` | 7/7 passed with localhost permission |
| `node node/src/image_resolver.mjs` | 4/4 passed |
| `node node/src/bake_io.mjs` | 9/9 passed |
| `node node/src/bake_anthropic.mjs` | 5/5 passed |
| `node node/src/bake_composition.mjs --self-test` | 2/2 passed |
| `node node/src/bake_cycles.mjs --self-test` | 3/3 passed |
| `node node/src/bake_critique.mjs --self-test` | 7/7 passed |
| `node node/src/bake_player.mjs --self-test` | 9/9 passed |
| `node node/src/video_capture.mjs --self-test` | 3/3 passed; ffmpeg unavailable fallback path exercised |
| `node node/src/bake_render_plan.mjs --self-test` | 5/5 passed |
| `node node/src/bake_highlight_rationales.mjs --self-test` | 6/6 passed |

Python checks run:

| Check | Result |
|---|---|
| `python/statistics.py` | OK |
| `python/windowing.py` | OK |
| `python/sparklines.py` | OK |
| `python/summarizer.py` | OK |
| `python/features.py` under `ambi_audio` | OK |
| `python/stream_features.py --self-test` under `ambi_audio` with cache dirs | 4/4 passed |
| `python -m unittest python.tests.test_enrich_track` under `ambi_audio` with cache dirs | 2 tests OK |
| `generate_corpus.py "audio/song 1.wav" --print-example` | completed and printed cycle 013 |

Environment notes:

- System `python3` lacks `librosa`/`soundfile`; use the `ambi_audio` env.
- Some Python commands require writable cache dirs:
  `MPLCONFIGDIR=/tmp/mplconfig` and `NUMBA_CACHE_DIR=/tmp/numba-cache`.
- `stage_server.mjs` and `self_frame.mjs` require localhost binding; sandboxed
  execution returned `EPERM`, but the same tests pass when localhost binding is
  allowed.

## Launch Transcript Alignment

The kickoff transcript changes how the submission should be written:

- Emphasize **creative medium, not just a tool**.
- Emphasize **new work built during the hackathon**.
- Explain **exactly how Opus 4.7 is used**.
- Show **how thinking evolved** for the Keep Thinking prize.
- Treat the **three-minute demo** as a primary deliverable, not an afterthought.
- Keep the repo public and asset rights clean.

Concrete phrasing to use:

- Opus is the performance/composition layer.
- Claude Code enabled long-running integration work and deep iteration.
- Bake mode is an Opus 4.7 long-horizon composition path, not just a rendering
  optimization.
- The project moved from "AI visualizer" to "AI translation of culturally
  specific music into visual language."

## Residual Risks (post second pass)

1. **Reference photo attribution — DOCS RESOLVED, INDEX ACTION REQUIRED.**
   `node/canon/reference_photos/ATTRIBUTION.md` now presents the five
   fully-attributed photos as the canonical published set, and the seven
   unrecoverable photos are listed in `.gitignore`. **Important caveat:**
   all 12 photos are already tracked in earlier git history, so the
   gitignore rule by itself does not remove them from the index — it
   only prevents future re-adds. To actually drop them from the public
   submission, run before publishing:

   ```bash
   cd /home/amay/Work/feed-looks-back-spike
   git rm --cached \
     node/canon/reference_photos/02_moonlight_on_water_b.jpg \
     node/canon/reference_photos/05_solitary_figure_dusk.jpg \
     node/canon/reference_photos/07_head_bowed_shadow.jpg \
     node/canon/reference_photos/09_single_feather.jpg \
     node/canon/reference_photos/10_breath_on_glass.jpg \
     node/canon/reference_photos/11_cupped_flame.jpg \
     node/canon/reference_photos/12_thin_line_of_moonlight.jpg
   git commit -m "chore: untrack reference photos with unrecoverable provenance"
   ```

   The published bake outputs in `bake_song1/` and `bake_song5/` were
   generated when the wider local set was on disk and may reference the
   removed filenames as text in their stored rationales. That is
   metadata, not a load-time dependency, and replay does not require
   the removed photos. **This step is blocking for clean rights submission.**

2. **Dirty branch scope.** The working tree is a broad integration set.
   Do not squash into a vague commit message. The PR description should
   name: live stage, HUD, Bayati prompt, Chain A effects layer, bake-mode
   three-pass pipeline, and docs.

3. **Generated artefacts.** `bake_song1/`, `bake_song5/`, and
   `corpus_song1/` are untracked. Decision needed: commit them as
   reproducible submission artefacts, or keep them out and rely on
   generation commands documented in `README.md` and `docs/SUBMISSION.md`.
   Recommendation: **commit the bake outputs** because they are the
   deterministic source of the demo video; commit `corpus_song1/` because
   re-derivation requires the audio file.

4. **Local artefacts — gitignored.** `.codex/` and
   `node/.codex-preflight-write-check` are now in `.gitignore` and will
   not be staged.

5. **ffmpeg missing.** Automated MP4 capture in `video_capture.mjs`
   gracefully falls back when `ffmpeg` is not installed. Manual OBS or
   any system screen recorder is acceptable for the demo capture.

6. **Prompt naming drift — documented.** Runtime feature names still say
   `hijaz_*` for internal-contract compatibility while the artistic
   prompt is Bayati. This is mentioned once in `README.md`, once in
   `docs/SUBMISSION.md`, and is enforced by `node/src/invariants.mjs`
   tests that load `bayati_base.md` as the source of truth.

7. **Already-tracked internal handoff docs — INDEX ACTION RECOMMENDED.**
   The following are committed in earlier history and contain
   collaborator-naming or in-progress framing decisions; the new
   `.gitignore` patterns prevent re-adds but cannot untrack them:

   - `SESSION_1_HANDOFF.md`
   - `SESSION_I_DESIGN_HANDOFF.md`
   - `PHASE_5_SESSION_HANDOFF.md`
   - `node/SESSION_2_HANDOFF.md`
   - `node/SESSION_2_PHASE_1_HANDOFF.md`
   - `node/SESSION_H_LOG.md`
   - `docs/SESSION_A_HANDOFF.md`
   - `docs/COORDINATOR_SESSION_HANDOFF_2026_04_24.md`
   - `docs/2026-04-24-session-i-vs-h-comparison.md`
   - `docs/superpowers/plans/2026-04-24-session-i-phase-5-perception-plan.md`
   - `docs/superpowers/plans/2026-04-24-session-i-phase-6-p5-sandbox-plan.md`
   - `docs/superpowers/plans/2026-04-24-session-i-phase-7-production-run-plan.md`
   - `docs/superpowers/plans/2026-04-25-bake-mode-composition-pipeline.md`

   Recommended pre-publish action:

   ```bash
   cd /home/amay/Work/feed-looks-back-spike
   git rm --cached \
     SESSION_1_HANDOFF.md \
     SESSION_I_DESIGN_HANDOFF.md \
     PHASE_5_SESSION_HANDOFF.md \
     node/SESSION_2_HANDOFF.md \
     node/SESSION_2_PHASE_1_HANDOFF.md \
     node/SESSION_H_LOG.md \
     docs/SESSION_A_HANDOFF.md \
     docs/COORDINATOR_SESSION_HANDOFF_2026_04_24.md \
     docs/2026-04-24-session-i-vs-h-comparison.md
   git rm --cached -r docs/superpowers/
   git commit -m "chore: untrack internal session handoffs from public submission"
   ```

   Files remain on disk locally for personal reference. Judges almost
   certainly won't dig for these, but the rigorous path is to remove.

8. **Pre-existing Pyright diagnostic.** `python/summarizer.py:124`
   reports an unused `_intercept` variable. Pre-existing, not introduced
   by this pass; cosmetic, does not affect any test.

## Recommended Next Action (post second pass)

1. **Run one baked replay and capture the stage + HUD.** This is the
   demo deliverable.
2. **Generate submission helper artefacts:**
   ```bash
   cd /home/amay/Work/feed-looks-back-spike/node
   node src/bake_render_plan.mjs ../bake_song1
   node src/bake_highlight_rationales.mjs --bake-dir ../bake_song1 --top 5
   ```
3. **Stage `node/browser/chain_a.mjs`** for commit — it is currently
   untracked but is loaded by `node/browser/scene_reducer.mjs` and is
   load-bearing for the live and replay paths.
4. **Decide on bake artefact commit.** Recommendation: include
   `bake_song1/` and `bake_song5/` so the submission is reproducible
   from a clean clone without re-spending API budget.
5. **Optional final scrub:** `git rm --cached` on the eight tracked
   internal handoff docs listed under residual risk #7.
6. **Pre-publish secrets and placeholder scan.** Public-repo-targeted
   scan (excludes the now-gitignored noise):
   ```bash
   git status --short
   git diff --stat
   git ls-files | xargs rg -l "ANTHROPIC_API_KEY|sk-ant" 2>/dev/null
   git ls-files | xargs rg -l "<fill>" 2>/dev/null
   git ls-files | xargs rg -l "source unrecoverable" 2>/dev/null
   ```
7. **Confirm public-facing docs render:** open `README.md`,
   `docs/PROJECT_DESCRIPTION.md`, `docs/SUBMISSION.md`, and this audit
   in a markdown preview to catch any broken table or link.
8. **Submit before 2026-04-26 8:00 PM EST** with the public repo URL,
   demo video URL, and form-field copy from the locked submission
   form draft.
