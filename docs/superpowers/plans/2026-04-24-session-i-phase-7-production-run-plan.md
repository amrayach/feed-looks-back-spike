# Session I — Phase 7 Production Run & Comparison Plan

**Date:** 2026-04-24
**Phase:** 7 of 7 — closing.
**Base commit:** `ef3ecfb` (Phase 6 wrap; Phase 5 merge required before run)
**Status:** Plan + comparison scaffold landed; **actual production run is user-triggered** because the 31-cycle real-API call has real cost (~$1–$2 per run) and should not auto-fire.

---

## 1. Objective

Run the full Session I pipeline end-to-end against Sample 1 for 31 cycles, identical in structure to the Session H baseline at `node/output/run_20260423_185946/`. Capture the same artifacts (`run_summary.json`, `scene_state.json`, `final_scene.html`, `live_monitor.html`, `opus_log/`, `scene_state_log/`) plus Session I–specific artifacts:
- `features_track.json` (precomputed from Sample 1)
- `patch_cache.json` (WebSocket patch log)
- Rendered stage screenshots (one per cycle if possible) or a final composition screenshot
- Any p5 sketch errors captured via the sandbox `onSketchError` callback

Generate a comparison document at `docs/2026-04-24-session-i-vs-h-comparison.md` that enumerates:
- Quantitative deltas (cost, timing, tool mix, failure counts)
- Capability deltas (what Session I does that Session H cannot)
- Subjective aesthetic observations (requires human review)

---

## 2. Preconditions

Before running:

1. **Phase 5 merged into main.** Phase 5 adds mood board + self-frame capture; without it, Opus runs blind to its own output and without the canon. Merge path:
   ```bash
   git -C /home/amay/Work/feed-looks-back-spike fetch origin
   git -C /home/amay/Work/feed-looks-back-spike merge --ff-only origin/phase-5
   ```
   If `phase-5` is not on origin yet, the parallel session must push it first. Lock-file / package.json conflicts are expected — resolve by `cd node && pnpm install`.

2. **Sample 1 precomputed.**
   ```bash
   mkdir -p /home/amay/Work/feed-looks-back-spike/node/output/run_session_i_smoke
   cp "/home/amay/Work/feed-looks-back-spike/audio/Sample 1 full Hijaz improvisation.wav" \
      /home/amay/Work/feed-looks-back-spike/node/output/run_session_i_smoke/audio.wav
   /home/amay/miniconda3/envs/ambi_audio/bin/python \
     /home/amay/Work/feed-looks-back-spike/python/stream_features.py \
     --mode precompute \
     --input /home/amay/Work/feed-looks-back-spike/node/output/run_session_i_smoke/audio.wav \
     --output /home/amay/Work/feed-looks-back-spike/node/output/run_session_i_smoke/features_track.json
   ```

3. **Environment.** `ANTHROPIC_API_KEY` set, `/home/amay/miniconda3/envs/ambi_audio/bin/python` has sounddevice + websockets installed (done in Phase 3), pnpm deps installed.

4. **All tests green.** Expected counts after Phase 6 + Phase 5 merge: ~300+ (280 Node + 4 Python + Phase 5 additions).

5. **Browser open.** The stage URL printed by `run_spike.mjs` must be loaded in Chrome so features render; the production run is not purely headless.

---

## 3. Run command

The run_spike.mjs CLI is:

```
node src/run_spike.mjs <corpus_dir> --config <name> [--cycles N:M] [--dry-run] [--feature-producer python|none]
```

For the Session I production run against Sample 1:

```bash
cd /home/amay/Work/feed-looks-back-spike/node && node src/run_spike.mjs \
  /home/amay/Work/feed-looks-back-spike/corpus \
  --config config_a \
  --feature-producer none
```

Note: `--feature-producer none` because we're using precompute mode (features_track.json already exists in the run dir), not live iD14 capture. The stage auto-detects precompute mode via `detectStageMode` when audio.wav + features_track.json are present.

Run ID is auto-generated; copy `audio.wav` + `features_track.json` into the generated run dir **before** the browser loads the stage URL — or pre-create the run dir and set `--run-id-override` (not yet wired; see Risks §5).

Expected duration: ~2.5 minutes (31 cycles × ~5s each). Expected cost: ~$1.00–$2.00 depending on cache hit rate.

---

## 4. Comparison dimensions

### 4.1 Quantitative (automated)

| Dimension | Session H baseline | Session I target |
|---|---|---|
| Cycles completed | 31/31 ok | 31/31 ok |
| Tool calls total | 54 | TBD (expect +sketch + reactivity) |
| Tool mix (addText / addSVG / addImage / addCompositeScene) | TBD extract | TBD |
| New tool calls (setP5Background / addP5Sketch) | 0 (not available) | ≥ 1 |
| Reactive elements (count) | 0 (not available) | ≥ 3 |
| Cost | $1.1336685 | TBD |
| Run duration | TBD | TBD |
| API failures | 0 | target 0 |
| Tool call errors | 0 | target ≤ 1 |

### 4.2 Capability (qualitative)

| Capability | Session H | Session I |
|---|---|---|
| Live reactive stage | ❌ (static HTML snapshots) | ✅ (WebSocket patches @ 60 Hz) |
| Audio-reactive DOM properties | ❌ | ✅ (amplitude/onset/centroid/hijaz bindings) |
| p5 sketches | ❌ | ✅ (1 bg + 3 localized, sandboxed) |
| Mood board perception | ❌ | ✅ (from Phase 5) |
| Self-frame capture feedback | ❌ | ✅ (from Phase 5) |
| hijaz_state enum gating | ❌ | ✅ |

### 4.3 Aesthetic (human review — requires Amer)

Not automatable. Amer reviews both `final_scene.html` renderings side by side and answers:
- Does the Session I scene feel more *alive* than Session H, or just *busier*?
- Do the p5 sketches read as figurative things (lanterns, textiles, strokes), or did Opus default to abstract patterns despite the prompt?
- Does the reactive pulsing track the music in a musically legible way, or does it create generic audio-visualizer flicker?
- Is the load-bearing aesthetic rule (recognizable > abstract) respected?

Document Amer's answers verbatim in the comparison doc — they're the real success metric.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Run dir mismatch: `run_spike` auto-creates a new timestamped run dir each call, but precompute mode expects `audio.wav` + `features_track.json` in that dir | Pre-create `run_session_i_smoke/` and either add a `--run-id-override` flag to run_spike.mjs (small change) or symlink the auto-created run dir to our pre-populated one at startup. |
| Browser not open during run | Stage renders only when a client is connected; patches buffer in patch_cache but the `live_monitor.html` auto-refresh mitigates. Confirm operator URL is loaded before starting the real-API call. |
| p5 sketch produces invalid JavaScript | Sandbox catches the error and retires via heartbeat timeout. Expect 0–2 sketch retirements per run in practice. |
| Phase 5 merge conflict on run_spike.mjs | Phase 4 and Phase 6 do not touch run_spike. Phase 5's added 204 lines are the only changes there — clean merge from main's perspective. |
| Real-API cost overrun | Set `MAX_COST_USD=3.00` env var (not wired yet; honor-system check on the printed running total). |
| `features_track.json` route vs generated run dir | The route `/run/<run_id>/features_track.json` resolves to `node/output/run_<run_id>/features_track.json`. As long as the run_id in bootstrap matches the file, it serves. Verify with `curl` before starting. |

---

## 6. Exit criteria

Phase 7 closes when:

1. A 31-cycle Session I real-API run completes with `cycles_total: 31` and `api_failure: 0`.
2. Run artifacts include all Session H fields plus `features_track.json`, `patch_cache.json`, and ≥ 1 p5 sketch patch in the cycle log.
3. Comparison doc `docs/2026-04-24-session-i-vs-h-comparison.md` is populated with quantitative + capability deltas; aesthetic section is either populated (Amer reviewed) or explicitly marked "pending Amer review".
4. Final commit pushed; CHANGELOG/README updated to note Session I completion.

---

## 7. Handoff

Phase 7 is the last phase in the original 7-phase arc. The artifact set after close:

- 7 plans under `docs/superpowers/plans/`
- 1 spec under `docs/superpowers/specs/`
- 1 comparison doc under `docs/`
- 19 Node self-test files (~275+ tests) + 1 Python self-test file (~4 tests)
- ~30 commits across 7 phases
- 1 Session I baseline run (`run_session_i_smoke` or Amer-chosen timestamp)
- 1 Session H baseline run (`run_20260423_185946`) preserved for reference

Follow-ups outside this session (tracked as Phase 8+ candidates):
- Online Hijaz detector for live mode (§15 open risk from the spec)
- Shared-blob p5 vendor delivery (reduce memory footprint from 4× p5 source inlining)
- Enum-aware reactivity maps (hijaz_state gating via `equals` rather than numeric threshold)
- Prompt iteration after observing Opus's actual reactivity + sketch authorship patterns in real runs
