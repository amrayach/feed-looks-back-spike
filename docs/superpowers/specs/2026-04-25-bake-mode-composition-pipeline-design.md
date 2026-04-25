# Bake Mode — Composition Pipeline — Design Spec

**Status:** Draft, awaiting approval
**Date:** 2026-04-25
**Author:** Claude (with Amer; via the superpowers:brainstorming skill)
**Supersedes:** N/A — first formal spec for offline bake architecture.
**Related:**
- Live architecture spec: `docs/superpowers/specs/2026-04-23-session-i-live-reactive-stage-design.md`
- Audit baseline: `/home/amay/Work/build_spikes_tests/deep_audit_report.md` — full Opus packet input surface, mood-board image-injection contract, Bayati cleanup status (162 tests green at audit time)
- Session J handoff: Hijaz front-loading + RECENT DECISIONS + softer reactivity defaults landed prior to this spec
- Tracks under bake: `/home/amay/Work/feed-looks-back-spike/audio/song 1.wav` (140.1 s, 27-cycle corpus already at `corpus_song1/`) and `/home/amay/Work/feed-looks-back-spike/audio/song 5wav_from_35s.wav` (152.4 s, corpus to be generated as `corpus_song5/`)

---

## 1. Goal

Produce a hackathon submission video by **moving Opus inference out of the live stage path and into an offline three-pass composition pipeline** that gives Opus a perceptual surface it cannot have at runtime: full-track mel-spectrogram, multi-panel DSP plots, the entire corpus prose, a curated reference-photo mood set, future preview of upcoming cycles, foreknowledge of the arc, and unbounded extended-thinking budget per cycle. The stage replays the baked decisions tightly synchronized to the audio (no 5 s API lag) and a headless Playwright capture writes the canvas to `submission/video.webm` per track.

The bake mode is **additive**. The live path (`run_spike.mjs --config <name>`) is untouched. Bake mode activates via a new `--use-baked <bake_dir>` flag.

Two tracks are baked:

1. `audio/song 1.wav` (140 s, 44.1 kHz stereo) → `bake_song1/`
2. `audio/song 5wav_from_35s.wav` (152 s, 44.1 kHz stereo) → `bake_song5/`

---

## 2. Non-goals

- **Not a replacement** of the live architecture. Bake mode is additive; the 162-test live path stays valid.
- **Not real-time** in the live-AI sense. Bake mode is honest about being pre-composed: Opus does the thinking offline, the stage replays. The artistic statement reframes — Opus composes the piece, the recording is the performance.
- **Not interactive.** No clicks, no MIDI, no live audio swap. Recording-grade playback only.
- **Not a corpus regeneration** for `corpus_song1/`. The 27-cycle corpus regenerated 2026-04-25 06:42 stays as-is. Only `corpus_song5/` needs to be generated from `song 5wav_from_35s.wav`.
- **Not a Bayati prompt rewrite.** All bake passes consume the existing audited `bayati_base.md`, `medium_rules.md`, `tools.json`, and `mood_board.json` unchanged.
- **Not a merge of v1 and v2 cycle artifacts.** Both versions are kept on disk; the stage replay reads v2 if present, else v1.
- **Not a multi-track narrative.** Each track is composed independently; no cross-track continuity contract.

---

## 3. Architecture overview

```
song.wav ──┬──> generate_corpus.py ─────> corpus_NAME/cycle_NNN.json
           │     (existing — applied to song5 only; song1 already baked)
           │
           ├──> enrich_track.py ──────────> bake_NAME/track_meta/
           │     (NEW)                          spectrogram.png
           │                                    dsp_panel.png
           │                                    summary.json
           │
           └──────────────┐
                          ↓
            bake_composition.mjs (NEW: Pass 1)
              1 Opus call · max thinking · multi-modal context
              → bake_NAME/composition_plan.json
                          │
                          ↓
            bake_cycles.mjs (NEW: Pass 2)
              N Opus calls · max thinking each · parallel batches of 5
              → bake_NAME/cycles/cycle_NNN.json
                bake_NAME/cycles/cycle_NNN_thinking.txt
                          │
                          ↓
            bake_critique.mjs (NEW: Pass 3)
              1 review call + K refine calls (one per flagged cycle)
              → bake_NAME/critique.json
                bake_NAME/cycles/cycle_NNN_v2.json (only flagged cycles)
                          │
                          ↓
            run_spike.mjs --use-baked bake_NAME --stage-audio song.wav
              (MODIFIED: short-circuit opus_client; load baked cycles via bake_player.mjs)
                          │
                          ↓
            video_capture.mjs (NEW: Playwright headless run + page.video())
              → bake_NAME/submission/video.webm
              → bake_NAME/submission/video.mp4 (ffmpeg mux of webm + audio.wav)
```

Two layers of state:

- **System prefix (cached across all calls per track):** `bayati_base.md`, `medium_rules.md`, `tools.json`, `mood_board.json` + 5 SVGs (existing system-prefix), plus the new track-specific images (`spectrogram.png`, `dsp_panel.png`) and the curated reference-photo set. Once cached, every subsequent call within a track reuses this prefix.
- **Per-call user message (changes per cycle):** the per-cycle Block 1/2/3 JSON, recent decisions (Pass 2/3), future-preview block (Pass 2/3), composition-plan excerpt (Pass 2/3), and critique notes (Pass 3 refine only).

---

## 4. New file layout

### Source code (under `feed-looks-back-spike/`)

```
python/
  enrich_track.py                    [NEW]   librosa mel-spectrogram + matplotlib DSP panel + summary.json

node/src/
  bake_composition.mjs               [NEW]   Pass 1 driver
  bake_cycles.mjs                    [NEW]   Pass 2 driver (parallel-batched)
  bake_critique.mjs                  [NEW]   Pass 3 driver (review + refine)
  bake_player.mjs                    [NEW]   loadBakedCycle(index) — feeds replay
  video_capture.mjs                  [NEW]   Playwright headless recording
  bake_io.mjs                        [NEW]   shared dir-layout helpers + JSON schema validators
  run_spike.mjs                      [MODIFIED] add --use-baked, --record-video flags

node/canon/reference_photos/         [NEW]   8–12 Bayati reference photos (CC0/CC-BY)
                                              moonlight_on_water_*.jpg
                                              open_palm_candlelight_*.jpg
                                              solitary_figure_dusk_*.jpg
                                              breath_on_glass_*.jpg
                                              loose_linen_*.jpg
                                              single_feather_*.jpg
                                              head_bowed_shadow_*.jpg
                                              back_at_window_night_*.jpg
                                              ATTRIBUTION.md

node/prompts/bake/                   [NEW]   bake-pass-specific prompt fragments
  composition_pass.md                        Pass 1 user-message template
  execution_pass.md                          Pass 2 user-message template
  critique_pass.md                           Pass 3a user-message template
  refine_pass.md                             Pass 3b user-message template
```

### Per-track bake artifacts (siblings of corpus directories)

```
bake_song1/
  track_meta/
    spectrogram.png                  high-res mel-spectrogram (≥1920×400)
    dsp_panel.png                    multi-panel: RMS / centroid / onset / Hijaz events / silence
    summary.json                     duration, peak windows, silence regions, event totals, cycle→sec map
  composition_plan.json              Pass 1 output (schema in §5.D)
  cycles/
    cycle_000.json                   Pass 2 output (tool calls + thinking ref + sig + meta)
    cycle_000_thinking.txt           extended-thinking trace
    cycle_000_v2.json                Pass 3 refinement (only when flagged)
    cycle_000_v2_thinking.txt
    …
  critique.json                      Pass 3a output (schema in §7)
  audio.wav                          symlink to ../audio/song 1.wav
  submission/
    video.webm                       Playwright canvas capture
    video.mp4                        ffmpeg mux (webm video + wav audio)
    composition_plan_rendered.html   one-page visual rendering of arc + per-cycle intent
    highlight_thinking_traces.md     selected 3–5 most articulate thinking excerpts
    README.md                        provenance, model id, thinking budgets, total tokens

bake_song5/
  (same layout)
```

---

## 5. Pass 1 — Composition planning

### A. Driver

`node/src/bake_composition.mjs` — node CLI:

```bash
node src/bake_composition.mjs \
  --corpus ../corpus_song1 \
  --audio "../audio/song 1.wav" \
  --bake-dir ../bake_song1 \
  --thinking-budget 49152 \
  [--max-output-tokens 16384] \
  [--reuse-cache]
```

The driver invokes `enrich_track.py` if `bake_NAME/track_meta/` is missing, then issues the Pass 1 Opus call.

### B. Track enrichment (prerequisite)

`python/enrich_track.py` invoked from the node driver via subprocess:

```bash
python python/enrich_track.py \
  --audio "audio/song 1.wav" \
  --corpus corpus_song1 \
  --out bake_song1/track_meta
```

Outputs:

- **`spectrogram.png`** — mel-spectrogram of the full track. 128 mel bins, log-power, viridis colormap, 1920×400 px, x-axis in seconds, y-axis in Hz. Generated via `librosa.feature.melspectrogram` + `matplotlib.pyplot.specshow`.
- **`dsp_panel.png`** — 5-panel matplotlib figure stacked vertically, all sharing the x-axis (seconds): RMS / spectral centroid / onset density / Hijaz event markers (vertical lines colored by event type: tahwil, aug2, phrase-break, returning-to-tonic, grounded-in-lower-jins) / silence regions (horizontal shaded bands). Y-axes labeled with units. 1920×1200 px.
- **`summary.json`**:
  ```json
  {
    "track_id": "song1",
    "duration_s": 140.1,
    "sample_rate": 44100,
    "channels": 2,
    "cycle_count": 27,
    "cycle_to_seconds": [0, 5, 10, 15, …],
    "peak_rms_window": { "start_s": 47.0, "end_s": 51.0, "value": 0.31 },
    "silence_regions": [{ "start_s": 0.0, "end_s": 4.6 }, …],
    "event_counts": { "tahwil": 2, "aug2": 0, "phrase-break": 5, "returning-to-tonic": 1, "grounded-in-lower-jins": 18 },
    "event_timeline": [
      { "cycle": 5, "event": "phrase-break", "time_s": 25.4 }, …
    ]
  }
  ```

### C. Opus call

- **Model:** `claude-opus-4-7` (or `claude-opus-4-7[1m]` if 1M context provides headroom for the multi-modal payload)
- **Extended thinking:** budget `49152` tokens (configurable via `--thinking-budget`)
- **`max_tokens`:** `16384` (composition plan target ≤ 8 KB JSON)
- **System prefix (cached):** bayati_base.md + medium_rules.md + tools.json + mood_board.json + 5 mood-board SVGs + 8–12 reference photos + `track_meta/spectrogram.png` + `track_meta/dsp_panel.png` + `track_meta/summary.json` (as text)
- **User message template** (`node/prompts/bake/composition_pass.md`):
  - The track corpus prose: `cycle_000.block_2_summary` … `cycle_NNN.block_2_summary` concatenated, each prefixed with `[cycle N · t=Xs]`
  - The block 1 scalars summary: per-cycle RMS / centroid / onset / pitch class / silence ratio in a compact table
  - Hijaz event timeline as a bullet list pulled from `summary.json.event_timeline`
  - Closing instruction: produce `composition_plan.json` with the exact schema in §5.D, no other text

### D. Composition plan schema (Opus output contract)

```json
{
  "track_id": "song1",
  "duration_s": 140.1,
  "cycle_count": 27,
  "overall_arc": [
    {
      "act_index": 0,
      "name": "Whispered birth",
      "cycle_range": [0, 3],
      "intent": "stillness, near-silence, the room before the breath"
    },
    { "act_index": 1, "name": "...", "cycle_range": [4, 9], "intent": "..." }
  ],
  "per_cycle_intent": [
    { "cycle": 0, "active_act": 0, "intent": "...", "energy_hint": "low | rising | high | falling" }
    /* exactly cycle_count entries, indexed 0..cycle_count-1, in order */
  ],
  "element_vocabulary": {
    "anchors": ["thin line of moonlight", "open palm in low candlelight", "solitary figure"],
    "palette_progression": [
      { "cycle_range": [0, 9], "palette": "cool moonlight blues, low saturation" },
      { "cycle_range": [10, 22], "palette": "warm parchment introduces" }
    ],
    "introduce_at": { "moonlight_anchor": 0, "palm_anchor": 6 },
    "retire_at": { "moonlight_anchor": 22 }
  },
  "foreshadow_pairs": [
    { "plant_at": 8, "pay_off_at": 18, "note": "feather drifts in cycle 8, returns scaled in cycle 18" }
  ],
  "anticipation_offsets_ms": {
    "0": 0, "8": -200, "18": -300
  },
  "model": "claude-opus-4-7",
  "thinking_budget": 49152,
  "baked_at": "2026-04-25T...Z"
}
```

A schema validator runs immediately after the Opus response — invalid output triggers a retry (max 2 retries) before failing loudly.

---

## 6. Pass 2 — Per-cycle execution

### A. Driver

`node/src/bake_cycles.mjs`:

```bash
node src/bake_cycles.mjs \
  --bake-dir ../bake_song1 \
  --corpus ../corpus_song1 \
  --concurrency 5 \
  --thinking-budget 32768 \
  [--cycles N:M] \
  [--resume]
```

`--resume` skips cycles whose `cycle_NNN.json` already exists with a matching `input_signature`. This makes the pass cheaply re-runnable when the prompt template changes only for a subset of cycles.

### B. Parallelism

Cycles are issued in batches of `--concurrency` (default 5). Within a batch, cycles share the system-prefix cache hit. Anthropic SDK rate-limit retries are handled with exponential backoff. The `decision_history` for cycle N is populated from already-completed lower-index cycles in the batch ordering — to keep batches deterministic, batch boundaries are aligned to multiples of `concurrency` (e.g., cycles 0–4 in batch 0; once batch 0 returns, batch 1 = 5–9, etc.). Cycles within a batch see only decisions made in earlier batches, never sibling-cycle decisions still in flight.

This means batch 0 (cycles 0–4 at the default concurrency) runs without any prior decision history; the composition plan's `per_cycle_intent[0..4]` and `overall_arc[0]` are the sole prior-context sources for those cycles. This is acceptable because the composition plan exists precisely to scaffold the early arc, and Opus has full track foreknowledge from the cached system prefix.

This trades a small coherence loss for parallelism; if Pass 3 critique flags too many in-batch incoherences, drop concurrency to 1 and re-bake (see §13.3).

### C. Per-cycle Opus call

- **Model:** `claude-opus-4-7`
- **Extended thinking:** budget `32768` tokens (configurable; thinking trace persisted)
- **`max_tokens`:** sized to current live-mode default (~4096) plus headroom for tool calls
- **System prefix (cached):** same as Pass 1 + `composition_plan.json` (full)
- **User message** (`node/prompts/bake/execution_pass.md`):
  - **CURRENT CYCLE** — the cycle JSON Block 1/2/3 (identical to live mode)
  - **RECENT DECISIONS** — last 3 cycles' tool calls in the same `formatRecentDecisions` shape used today (already exists in `node/src/scene_state.mjs`)
  - **FUTURE PREVIEW** — next 3 cycles' Block 2 prose + event flags (max ~300 tokens)
  - **COMPOSITION INTENT** — `composition_plan.per_cycle_intent[N]` + `composition_plan.overall_arc[active_act]`
  - **TASK** — same instruction the live prompt closes with: emit tool calls
- **Tools:** identical `tools.json` as live mode

### D. Per-cycle output schema

`bake_song1/cycles/cycle_NNN.json`:

```json
{
  "cycle_index": 14,
  "cycle_id": "cycle_014",
  "model": "claude-opus-4-7",
  "thinking_budget": 32768,
  "tool_calls": [
    {
      "id": "toolu_…",
      "name": "addImage",
      "input": { /* identical to live mode tool_use block.input */ }
    }
  ],
  "thinking_trace_ref": "cycle_014_thinking.txt",
  "input_signature": "<sha256 of cycle JSON + decision_history + future_preview + composition_intent>",
  "stop_reason": "tool_use | end_turn",
  "usage": { "input_tokens": …, "output_tokens": …, "cache_read_input_tokens": …, "thinking_tokens": … },
  "baked_at": "2026-04-25T..."
}
```

`tool_calls[*]` is the **same shape that `applyToolCallDetailed` already consumes in the live path** — bake mode reuses the existing tool handler infrastructure. No tool-call schema migration.

---

## 7. Pass 3 — Critique and refine

### A. Pass 3a — Critique

`node/src/bake_critique.mjs --bake-dir ../bake_song1 --thinking-budget 32768`:

- **Single Opus call**, system prefix unchanged, user message:
  - The composition plan
  - All Pass 2 tool-call decisions concatenated (one block per cycle: `[cycle N intent: …] tool calls: …`)
  - Closing instruction: `Review your full sequence as a critic. Identify cycles that feel mechanical, drop coherence, or break the arc. Output critique.json with this schema: {…}.`
- **Output:** `bake_NAME/critique.json`:
  ```json
  {
    "weak_cycles": [
      {
        "cycle": 17,
        "issue": "introduces a fresh motif (loose linen) that never returns and contradicts the established palette progression",
        "suggestion": "either retire the motif here or carry it forward through cycles 18–22; if retiring, replace with a returning anchor"
      }
    ],
    "global_notes": "...",
    "model": "claude-opus-4-7",
    "thinking_budget": 32768,
    "critiqued_at": "2026-04-25T..."
  }
  ```

### B. Pass 3b — Refine

For each `weak_cycles[*]`, the driver issues a refine call:

- **System prefix:** same as Pass 2 (cached)
- **User message:** identical to Pass 2 for that cycle, plus a final block: `CRITIQUE NOTE: <issue> · SUGGESTION: <suggestion>`
- **Output:** `bake_NAME/cycles/cycle_NNN_v2.json` (and `_v2_thinking.txt`)

The v1 cycle output is preserved for diff inspection. The replay player prefers v2 when present.

### C. Termination

A single critique-and-refine round runs by default. A second round is opt-in via `--rounds 2`. The implementation may not loop further than 3 rounds total even if requested.

---

## 8. Stage replay

### A. New flag in `run_spike.mjs`

```bash
node src/run_spike.mjs --use-baked ../bake_song1 --stage-audio "../audio/song 1.wav" [--record-video]
```

- `--use-baked` is mutually exclusive with `--config` and `--feature-producer`. Live mode flags are rejected when `--use-baked` is set.
- `--cycles N:M` continues to work and slices the baked cycle range.
- `--dry-run` continues to work and writes the same dry-run artifacts as live mode, just sourced from the baked cycle JSONs instead of synthesized fixtures.

### B. Bake player module

`node/src/bake_player.mjs`:

```js
export function loadBakeDirectory(bakeDir) { /* validates layout, returns metadata */ }
export function getBakedCycle(bakeDir, cycleIndex) { /* returns parsed v2-or-v1 JSON */ }
export function getCompositionPlan(bakeDir) { /* parsed composition_plan.json */ }
export function getAnticipationOffsetMs(plan, cycleIndex) { /* clamped to [-500, 0] */ }
```

The player exposes the same `tool_calls` array shape that `applyToolCallDetailed` consumes today. The replay loop in `run_spike.mjs` becomes:

```
for cycle in baked.cycles:
    schedule_at = audio_start_wall_clock + cycle.snapshot_time_s + getAnticipationOffsetMs(plan, cycle.index)
    sleep_until(schedule_at)
    for toolCall in cycle.tool_calls:
        applyToolCallDetailed(toolCall)  # unchanged from live mode
        emit_patch_to_stage_server(toolCall)  # unchanged
```

### C. Audio-visual synchronization contract

- Audio playback start time `T0` is captured when the stage server reports `audio_started` (existing event, see `audio_visual_layer.mjs`).
- Cycle dispatch wall-clock target = `T0 + cycle.snapshot_time_s + anticipation_offset_ms`.
- `anticipation_offset_ms` is clamped to `[-500, 0]` ms to avoid scheduler races with patch transport.
- If the stage falls behind (rare), patches are dispatched in order without skipping; the next cycle's target time absorbs the slip.

### D. No live-path regressions

The 162 existing live-mode tests must stay green. The `--use-baked` code path is gated by an early return in `run_spike.mjs` — when not set, control flow is byte-identical to today's live path.

---

## 9. Video capture

### A. Recording mechanism

`node/src/video_capture.mjs` uses Playwright headless to:

1. Launch chromium with `--enable-features=VaapiVideoDecoder` and recorder support
2. Navigate to the stage server URL (existing dev server at `http://localhost:<port>/run/<run_id>/`)
3. Start `page.video()` recording into `bake_NAME/submission/video.webm`
4. Trigger audio playback start on the stage
5. Wait for the run to complete (signal via existing run-completion event or fixed `track.duration_s + 5s` buffer)
6. Stop recording

### B. Audio mux

The webm capture is canvas-only (no audio). After recording, an `ffmpeg` shell call muxes the webm with the original wav to produce `bake_NAME/submission/video.mp4`:

```bash
ffmpeg -y -i video.webm -i "../audio/song 1.wav" \
       -c:v libx264 -crf 18 -preset slow \
       -c:a aac -b:a 192k \
       -shortest video.mp4
```

`-shortest` ensures the output trims to the shorter of the two inputs (typically the wav).

### C. Determinism

The recording is reproducible: same bake → same canvas patches → same video output (modulo OS scheduling jitter on the canvas frame timestamps, which is below human perception).

---

## 10. Submission artifacts

Per track, the `bake_NAME/submission/` directory holds:

1. **`video.mp4`** — the headline submission asset
2. **`video.webm`** — the raw canvas capture (canvas-only, no audio)
3. **`composition_plan_rendered.html`** — single-page rendering of `composition_plan.json` using a small static template (act timeline, per-cycle intent grid, element-vocabulary legend, foreshadow arrows). Generated by a tiny `render_composition_plan.mjs` helper at the end of the pipeline.
4. **`highlight_thinking_traces.md`** — 3–5 most articulate thinking excerpts (selected by character-count and presence of structural-event language in the trace; see `node/src/bake_critique.mjs` post-processing). Each excerpt prefixed with cycle index and the resulting tool calls for context.
5. **`README.md`** — provenance: model id, thinking budgets per pass, total tokens spent, bake duration wall-clock, software versions of librosa / playwright / node, audit baseline reference.

These five files are what the submission write-up links to. The video is the headline; the composition plan and thinking traces are the "Keep Thinking" evidence.

---

## 11. Testing strategy

### A. Live path stays green

All 162 existing live-mode tests must pass after every commit. Bake mode adds no test deletion, no shared state mutation, no live-path code-path branching (other than the early-return `--use-baked` guard).

### B. New unit tests

| Module | Test file | Cases |
|---|---|---|
| `bake_io.mjs` | `bake_io.test.mjs` | dir-layout helpers, schema validators (composition plan, cycle output, critique) |
| `bake_player.mjs` | `bake_player.test.mjs` | v1/v2 fallback, tool-call shape compatibility, anticipation-offset clamping |
| `bake_composition.mjs` | `bake_composition.test.mjs` | mock Opus response → schema validation; retry-on-invalid logic |
| `bake_cycles.mjs` | `bake_cycles.test.mjs` | mock Opus per-cycle responses; concurrency batching; `--resume` signature match |
| `bake_critique.mjs` | `bake_critique.test.mjs` | mock critique response → refine call generation; v2 file write |
| `enrich_track.py` | `tests/test_enrich_track.py` | tiny synthetic 10 s wav → spectrogram + dsp panel files exist + summary.json schema |
| `video_capture.mjs` | `video_capture.test.mjs` | mock Playwright; verifies CLI args + output path; the actual recording is integration-tested separately |
| `run_spike.mjs` | `run_spike.test.mjs` | new test: `--use-baked` round-trip — given a synthetic bake directory, the run dispatches the expected patch sequence to a fake stage server in the expected order and timing |

### C. End-to-end smoke

Before declaring the spec done:

1. Generate `corpus_song5/` from `song 5wav_from_35s.wav`
2. Run full bake on `song 1.wav` (corpus already exists) — verify all bake artifacts appear with valid schemas
3. Run stage replay with `--use-baked bake_song1 --stage-audio "audio/song 1.wav"` — verify audio plays, patches dispatch, no errors in stage server log
4. Run video capture — verify `submission/video.mp4` exists and plays back synced
5. Eyeball the rendered video for visual quality

### D. Schema compatibility check

A targeted test verifies `cycle_NNN.tool_calls[*]` is structurally identical to a captured live-mode `tool_use` block. The check uses an existing live-mode run artifact as ground truth.

---

## 12. Risk register

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| 1 | Pass 1 output exceeds `max_tokens` | Medium | `max_tokens=16384`, structured-only output, retry on invalid JSON, 2 retries before failing |
| 2 | Reference photo set licensing | Low | Curate from Wikimedia Commons + Unsplash CC0 only, commit `ATTRIBUTION.md`, skip any photo with unclear license |
| 3 | Parallel batch in-batch coherence loss | Medium | Default concurrency 5; if Pass 3 flags too many in-batch issues, fall back to concurrency 1 and re-bake (covered by `--resume`) |
| 4 | Anticipation offsets create scheduler races | Low | Hard clamp to `[-500, 0]` ms; offsets applied as `setTimeout` delta from `T0`, never as negative wall-clock |
| 5 | Playwright canvas capture frame drops | Medium | Use deterministic clock plugin if available; otherwise accept ≤1% frame drop and validate visually |
| 6 | `corpus_song5` cycle count or prose flavor unexpected | Medium | Generate corpus early in implementation Phase 0; if cycle count or event distribution is degenerate, decide mitigation before proceeding to Pass 1 wiring |
| 7 | Total bake cost on 2 tracks exceeds practical patience | Low (cost is not a budget constraint) | Pipeline is staged + resumable; can pause between passes |
| 8 | Audio file with space in name (`song 1.wav`) breaks shell pipelines | Low | All shell calls quote audio paths; `bake_io.mjs` paths use absolute resolution |
| 9 | Drift between live-mode prompt updates and bake-mode prompt fragments | Medium | Bake passes consume the same `bayati_base.md` / `tools.json` as live; only the `node/prompts/bake/*.md` user-message fragments are bake-specific. Existing `prompts_aesthetic.test.mjs` runs against the shared assets |
| 10 | Submission deadline pressure | Medium | Implementation phasing (§14) sequences video capture as the last earnable artifact; if time runs short, fall back to OS screen recording of a manual replay |

---

## 13. Open questions and defaults

Each is captured here so reviewers can object before implementation. Defaults will be chosen if not contested.

| # | Question | Default |
|---|---|---|
| 1 | Reference photo source | Wikimedia Commons + Unsplash CC0; 12 photos hand-curated and committed under `node/canon/reference_photos/` with `ATTRIBUTION.md` |
| 2 | Pass 2 default concurrency | 5 |
| 3 | Pass 3 trigger threshold | Refine any cycle Opus flags as weak; no minimum count, no maximum cap |
| 4 | Anticipation offset clamp | `[-500, 0]` ms |
| 5 | Video format pipeline | webm via Playwright → mp4 via ffmpeg mux with original wav |
| 6 | Whether to regenerate `corpus_song1/` | No — keep the 06:42 corpus; only generate `corpus_song5/` |
| 7 | Thinking budgets | Pass 1: 49152 · Pass 2: 32768 per cycle · Pass 3a: 32768 · Pass 3b: 32768 per refine |
| 8 | Critique rounds | 1 by default; opt-in `--rounds 2` |
| 9 | Audio path resolution | Bake driver resolves `--audio` to an absolute path; copies/symlinks to `bake_NAME/audio.wav` for self-containedness |
| 10 | Stage server port for headless capture | Reuse the existing port allocator; capture script reads the port from the dev server stdout |

---

## 14. Implementation phasing

The implementation plan (produced by `superpowers:writing-plans` after this spec is approved) will sequence work as:

**Phase 0 — Inputs**
- Generate `corpus_song5/` from `song 5wav_from_35s.wav` (existing tooling)
- Curate the 12 reference photos and `ATTRIBUTION.md`

**Phase 1 — Track enrichment**
- `python/enrich_track.py` + tests
- Generate `track_meta/` for both songs

**Phase 2 — Pass 1 (composition planning)**
- `node/src/bake_composition.mjs` + composition-plan schema validator + tests
- Run Pass 1 for both songs; eyeball plans

**Phase 3 — Pass 2 (per-cycle execution)**
- `node/src/bake_cycles.mjs` + per-cycle output validator + concurrency batching + `--resume` + tests
- Run Pass 2 for both songs

**Phase 4 — Pass 3 (critique and refine)**
- `node/src/bake_critique.mjs` + critique-output schema + tests
- Run Pass 3 for both songs

**Phase 5 — Stage replay**
- `node/src/bake_player.mjs` + tests
- Modify `node/src/run_spike.mjs` to add `--use-baked` flag (early-return guard)
- Add anticipation-offset scheduler
- Live-path regression run (162 tests must still pass)

**Phase 6 — Video capture and submission artifacts**
- `node/src/video_capture.mjs` + tests
- Render composition plan to HTML
- Select highlight thinking traces
- Final run: bake + replay + record + mux for both tracks
- End-to-end visual eyeball

If time runs short before submission, the order of fall-back is: drop Pass 3 (Phase 4), then drop Playwright capture (Phase 6) in favor of OS screen recording, then ship with a single track (`song1`) and add `song5` post-submission.

---

## 15. Success criteria

The spec is satisfied when:

1. Both `bake_song1/` and `bake_song5/` directories exist with the full layout from §4
2. `corpus_song1/` is unchanged from the 06:42 baseline
3. `corpus_song5/` contains a valid 27–31 cycle JSON sequence (152 s ÷ 5 s window pacing yields ~30; exact count is whatever `generate_corpus.py` produces)
4. `composition_plan.json` validates against the §5.D schema for both tracks
5. Each `cycle_NNN.json` validates against the §6.D schema; `tool_calls[*]` round-trips through `applyToolCallDetailed` without error
6. `critique.json` validates and at least one `cycle_NNN_v2.json` exists for each track (or critique outputs `weak_cycles: []` with explicit global notes)
7. `submission/video.mp4` plays back synchronized to audio for both tracks
8. All 162 live-mode tests pass; the new test suite (per §11.B) passes
9. The submission write-up can link directly to the artifacts in `submission/` for both tracks

---

## 16. Out of scope (explicit)

- Mobile / web-app deployment of the stage replay
- Multi-track narrative continuity contract
- Live-audio bake-on-demand (i.e., live replanning during stage playback)
- Migration of the live path to consume baked composition plans as priors
- Cost telemetry / token-budget governance (`auto-mode` removes the cost ceiling)
- Public release of reference photos beyond their original licenses
