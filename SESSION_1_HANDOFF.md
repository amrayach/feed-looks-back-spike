# Feed Looks Back — Session 1 Handoff

**Date:** 2026-04-22
**Status:** Session 1 (Python DSP pipeline) complete and Codex-reviewed at all three phase gates. Awaiting real Hijaz recording from Bashar for the calibration pass before Session 2.

> Paste this entire document into the next session as context.

---

## TL;DR

Built a deliberately-scrappy, self-contained Python pipeline at `~/Work/feed-looks-back-spike/` that turns an audio file into a corpus of small JSON "cycle" snapshots. The cycles will be fed to Claude Opus 4.7 in Session 2 to author visuals for a live performance installation in Arabic maqam. Spike intentionally avoids Hijaz-specific DSP (tahwil FSM, jins regions, microtonal pitch tracking) — those live in the main scaffold at `~/Work/Build_With_OPUS_4.7_hack/` and are out of scope for the spike. Code that survives the spike merges into the main scaffold later, after Session 3.

The next concrete step is the **calibration pass**: when Bashar's recording arrives, run the CLI, look at one mid-performance cycle JSON, and decide whether the band cutoffs need tuning before starting Session 2.

---

## Project context

**Feed Looks Back** is a live performance installation where Bashar plays guitar in Arabic maqam (Hijaz first) and Amer's visuals respond in real time via Claude Opus 4.7 acting as an audio-intelligence layer. The system listens to the audio, extracts structured features, and Opus authors small scene-state mutations that drive p5.js / Three.js visuals.

**Three-session spike pattern:**

| Session | Scope | State |
|---|---|---|
| 1 — Python DSP | offline pipeline: audio → cycle JSON corpus | **DONE** (this handoff) |
| 2 — Node runner | modular `hijaz_base.md` + 5 configs, p5.js / Three.js artifacts, first live Opus run | next, **after** calibration pass |
| 3 — Live integration | real-time audio capture → loop → render | future |

Session 1 was deliberately scoped to the Python half only. No Opus API calls. No Node. No git. No virtualenv creation. No tests beyond per-module self-tests. The spike is throwaway in spirit; the data contract (cycle JSON schema) is the part Session 2 reads.

---

## Spike directory structure (1740 lines total)

```
~/Work/feed-looks-back-spike/
├── README.md                       (26 lines)
├── requirements.txt                (librosa==0.11.0, numpy==2.4.4)
├── .gitignore                      (corpus/, audio/, __pycache__/, etc.)
├── SESSION_1_HANDOFF.md            (this file)
├── audio/                          (empty — drop input WAVs here)
├── corpus/                         (5 cycle JSONs from synthetic validation)
│   └── cycle_{000..004}.json
└── python/
    ├── __init__.py                 (empty)
    ├── features.py                 (140) — librosa wrappers
    ├── statistics.py               (117) — file-level percentile stats
    ├── windowing.py                (125) — sliding-window snapshot logic
    ├── summarizer.py               (357) — deterministic Block 2 prose
    ├── sparklines.py               (133) — Block 3 ASCII sparklines
    └── generate_corpus.py          (562) — CLI + Pass 1/Pass 2 + synthetic validation
```

**Conda env:** `/home/amay/miniconda3/envs/ambi_audio/bin/python` (librosa 0.11.0, numpy 2.4.4). Do not create a new env unless explicitly asked.

---

## Module-by-module summary

### `features.py` — librosa time-series extraction

```python
AudioInput = Union[str, "os.PathLike[str]", Tuple[np.ndarray, int]]

def extract_timeseries(audio_path_or_array: AudioInput) -> dict
    # Returns: sr, duration, rms, rms_times, centroid, centroid_times,
    #          onset_strength, onset_times, chroma (chroma_stft), chroma_times
```

- **Adapted from `analyze_tracks.py`** (the Ambi audiovisual project's per-track feature script Amer attached). Strips plotting and full-file aggregations; keeps only the per-frame time-series extraction.
- **`chroma_stft`, NOT `chroma_cqt`** — intentional spike choice; the Hijaz spec recommends chroma_cqt for microtonal work but that lives in the main scaffold. The code comments make this explicit so coding agents don't "helpfully upgrade" it.
- **Tuple input contract is mono-only** (1-D ndarray). Stereo (any layout) raises `ValueError` pointing the caller at the file-path branch — `librosa.load` handles channels correctly via the file-path code path. This was narrowed after Codex caught that `librosa.to_mono` averages on `axis=-2` and would silently collapse a `(n_samples, 2)` channels-last tuple across the wrong axis.
- **Sets `NUMBA_CACHE_DIR` via `os.environ.setdefault` BEFORE `import librosa`** — librosa's numba JIT defaults to writing cache files next to its site-packages. In sandboxed shells, NFS mounts, or shared installs that path can be read-only and librosa imports fail with an obscure cache error. Setting `NUMBA_CACHE_DIR` to `/tmp/flb-numba-cache` keeps imports portable.

### `statistics.py` — file-level percentile statistics

```python
@dataclass
class FileStatistics:
    rms_p10, rms_p33, rms_p66, rms_p90: float
    centroid_p10, centroid_p33, centroid_p66, centroid_p90: float
    onset_strength_p90: float
    rms_std, centroid_std: float
    silence_threshold: float        # max(0.01, 0.5 * rms_p10)
    onset_peak_threshold: float     # max(1e-6, 0.5 * onset_strength_p90)

def compute_file_statistics(timeseries: dict) -> FileStatistics
```

- **`onset_density` percentiles are deliberately NOT here** — they need windowed aggregates that only exist after Pass 1 of the windowing pipeline. They're computed in `generate_corpus.py` after Pass 1 finishes.
- **`statistics.py` shadows stdlib `statistics`** — handled with try/except bootstrap in `summarizer.py` and `generate_corpus.py`. Package-context import (`from .statistics import ...`) is preferred; direct-execution fallback uses `sys.path` mutation. The stdlib shadowing only happens in the script-execution path and is contained to that process.

### `windowing.py` — sliding-window snapshot logic

```python
WINDOW_DURATION_S = 4.0   SNAPSHOT_STRIDE_S = 5.0   SNAPSHOT_START_S = 5.0   END_BUFFER_S = 0.5

def compute_snapshot_times(duration, window=4.0, stride=5.0, start=5.0, end_buffer=0.5) -> list[float]
def slice_window(values, times, snapshot_time, window=4.0) -> ndarray
def window_mask(times, snapshot_time, window=4.0) -> ndarray   # exposed for double-mask avoidance
```

- First snapshot fires at `T = 5.0s` summarizing audio from 1.0s to 5.0s. The initial 0.0–1.0s is intentionally excluded — keeps every cycle ending on a whole 5-second multiple of the file timeline. This is documented verbatim in `README.md`.
- Plan-locked parameters: window 4s, stride 5s, end buffer 0.5s. For a 120s file → 23 cycles. For the 30s synthetic test → 5 cycles (within plan's 5–6 range).

### `summarizer.py` — deterministic Block 2 prose

Constants at top (named, tunable during calibration without touching call-site code):

```python
INTENSITY_LABELS  = ("quiet", "moderate intensity", "intense", "peak intensity")
TIMBRE_LABELS     = ("dark", "warm", "balanced", "bright", "very bright")
ARTICULATION_LABELS = ("very sparse", "sparse", "moderate articulation", "dense", "rapid")
TREND_LABELS      = ("falling", "easing", "sustained", "building", "rising sharply")

TREND_FALLING_MAX, TREND_EASING_MAX, TREND_SUSTAINED_MAX, TREND_BUILDING_MAX  # cutoffs
SILENCE_PREFIX_THRESHOLD = 0.5   SILENCE_SUFFIX_THRESHOLD = 0.2
POSITION_BANDS = ((20.0, "Early..."), (60.0, "Developing."), (120.0, "Mid-performance."), (240.0, "Deep..."))
```

Functions:

```python
compute_normalized_slope(values, times, file_std, window_duration_s=4.0) -> float
    # (slope * window_duration_s) / max(file_std, 1e-8). Sign convention: rising → +.
categorize_trend(normalized_slope) -> str   # boundary-table verified at -0.6, -0.5, -0.3, -0.15, 0, 0.15, 0.3, 0.5, 0.6
categorize_intensity, categorize_timbre, categorize_articulation, categorize_position
silence_modifiers(silence_ratio) -> (prefix, suffix)
tonal_center_phrase(dominant, secondary) -> str
generate_prose(block_1: dict, file_stats: FileStatistics, density_pcts: dict) -> str
```

**Prose template (verbatim from spec):**

```
{silence_prefix}{intensity}, {trend}. {timbre} timbre. {articulation_clause}. {tonal_center_phrase} {position_phrase}
```

**Sentence-leading capitalization** is applied at use site in `generate_prose` via a private `_capitalize_lead` helper (uppercases only the first character, preserves the rest). Labels stay lowercase in the constants tuples because `trend` appears mid-sentence after a comma. Three sentence-leading slots get capitalized: `intensity`, `timbre`, `articulation_clause`. This was added after Codex caught lowercase sentence starts in Phase 2.

### `sparklines.py` — Block 3 ASCII sparklines

```python
SPARKLINE_CHARS = "▁▂▃▄▅▆▇█"   SPARKLINE_WIDTH = 20

def generate_sparkline(values, times, window_start, window_end, width=20) -> str
```

- 20 chars per sparkline (200ms per char over 4s window).
- Bin-and-mean downsampling; carry-forward fallback for empty bins.
- Edge cases asserted in self-test: silent (`max(|values|) < 1e-6`) → 20× `▁`; flat (`max == min`) → 20× `▄`.

### `generate_corpus.py` — CLI + Pass 1/Pass 2 + synthetic validation

```python
def run_pipeline(audio_input, source_file, output_dir=None, print_example=False) -> list[dict]
def make_synthetic_audio() -> tuple[ndarray, 22050]
def validate_synthetic_pipeline(output_dir="corpus", print_middle_cycle_json=True) -> list[dict]
def cli_main(argv=None) -> int
```

CLI:
- `python python/generate_corpus.py audio/file.wav corpus/`
- `python python/generate_corpus.py audio/file.wav --print-example`
- argparse contract: `audio_file_path` required positional; `output_dir` optional positional; `--print-example` skips file writes and pretty-prints the middle cycle. Argparse errors if neither `output_dir` nor `--print-example` is supplied.

Two-pass structure inside `run_pipeline`:
- **Pass 1** (`compute_pass_1_cycles`) computes per-cycle Block 1 numerics (rms_mean, rms_peak, centroid_mean_hz, onset_density, pitch_class_dominant/secondary, silence_ratio, etc.) plus normalized slopes for both RMS and centroid. Carries `_rms_norm_slope` and `_cent_norm_slope` as Pass 2 intermediates.
- After Pass 1: `compute_density_percentiles` derives onset_density p10/p33/p66/p90 across all cycles. Then `print_statistics_block` prints the formatted file-statistics block (now with density percentiles included).
- **Pass 2** (`assemble_cycle_json`) generates Block 2 prose, Block 3 sparklines, and the `_debug` block, then writes JSON to `<output_dir>/cycle_NNN.json`.

`SYNTHETIC_DISCLAIMER` lives as a module-level constant. `validate_synthetic_pipeline()` runs the full synthetic flow (corpus write + middle cycle JSON pretty-print + disclaimer) end-to-end. Single source of truth for Phase 3 reproduction — added after Codex caught that the disclaimer was only printed by the calling shell, not by code.

---

## Cycle JSON data contract — the soft contract Session 2 reads

```json
{
  "cycle_id": "cycle_002",
  "cycle_index": 2,
  "source_file": "synthetic_test.wav",
  "snapshot_time_s": 15.0,
  "elapsed_total_s": 15.0,
  "window_duration_s": 4.0,
  "window_start_s": 11.0,
  "window_end_s": 15.0,
  "block_1_scalars": {
    "rms_mean": 0.539, "rms_peak": 0.699, "rms_trend": "rising sharply",
    "centroid_mean_hz": 5508, "centroid_trend": "building",
    "onset_density": 8.0, "onset_peak_strength": 1.295,
    "pitch_class_dominant": "E", "pitch_class_secondary": "D#",
    "silence_ratio": 0.0,
    "window_duration_s": 4.0, "elapsed_total_s": 15.0
  },
  "block_2_summary": "Intense, rising sharply. Balanced timbre. Dense. Tonal center E with secondary emphasis on D#. Early in the performance, opening territory.",
  "block_3_sparklines": {
    "rms":      "▁▁▂▃▃█▃▄▄▅▅▅▆▇▆▇██▇█",
    "onset":    "▁▅▆█▅▆▆▅▅▇▃▄▅▄▆▆▄▆▂█",
    "centroid": "▇▇▆▆▅▁▅▆▅█▆▅▄█▅▅▇▄█▇"
  },
  "_debug": {
    "file_percentiles": {
      "rms_p10": ..., "rms_p33": ..., "rms_p66": ..., "rms_p90": ...,
      "centroid_p10": ..., "centroid_p33": ..., "centroid_p66": ..., "centroid_p90": ...,
      "onset_density_p10": ..., "onset_density_p33": ..., "onset_density_p66": ..., "onset_density_p90": ...,
      "onset_strength_p90": ...
    },
    "rms_std": ..., "centroid_std": ...,
    "silence_threshold": ..., "onset_peak_threshold": ...,
    "rms_normalized_slope": ..., "centroid_normalized_slope": ...
  }
}
```

**`_debug` schema convention** (Amer's polish edit): all percentiles nested under `file_percentiles`; all scalar stats (stds, thresholds, slopes) at `_debug` top level. May be stripped by Session 2; flagged as Session-1-only support for the calibration pass.

UTF-8 output, 2-space indent, Unicode block characters preserved verbatim in JSON.

---

## Band-boundary convention

**Percentile-driven bands (intensity, timbre, articulation):** lower bound INCLUSIVE, upper bound EXCLUSIVE, except the final band is INCLUSIVE on both ends (`≥ pNN`). Concretely for intensity on `rms_mean`:

```
x < rms_p33                  → "quiet"
rms_p33 ≤ x < rms_p66        → "moderate intensity"
rms_p66 ≤ x < rms_p90        → "intense"
x ≥ rms_p90                  → "peak intensity"
```

**Trend bands on `normalized_slope`** (mixed operators per spec; symmetric inclusive `"sustained"`):

```
s < -0.5             → "falling"
-0.5 ≤ s < -0.15     → "easing"
-0.15 ≤ s ≤ 0.15     → "sustained"     (symmetric inclusive)
0.15 < s ≤ 0.5       → "building"
s > 0.5              → "rising sharply"
```

**Position bands on `elapsed_total_s`** (lower inclusive, upper exclusive, last unbounded):

```
< 20    → "Early in the performance, opening territory."
< 60    → "Developing."
< 120   → "Mid-performance."
< 240   → "Deep into the performance."
≥ 240   → "Late in the performance."
```

Convention is documented as a fenced docstring block at the top of `summarizer.py` so the rule travels with the constants.

---

## Key technical decisions & gotchas

| Decision | Why | Where |
|---|---|---|
| `chroma_stft` not `chroma_cqt` | Spike scope choice; `chroma_cqt` is the main-scaffold path for microtonal work | `features.py:77` |
| Tuple input mono-only | `librosa.to_mono` averages `axis=-2` → channels-last tuple silently collapses wrong axis. Stereo files go through `librosa.load` | `features.py:74-79` |
| `NUMBA_CACHE_DIR` set in code | numba JIT cache defaults to read-only site-packages dir in sandboxed shells; library import fails | `features.py:18-27` |
| `statistics.py` filename shadows stdlib `statistics` | Plan-mandated name. Try/except bootstrap in importing modules; package-context branch wins, direct-execution branch mutates sys.path | `summarizer.py:50-66`, `generate_corpus.py:42-67` |
| Two-pass structure | `articulation` band needs onset_density percentiles, which need windowed aggregates → Pass 1 builds them, Pass 2 consumes | `generate_corpus.py:run_pipeline` |
| `_debug` percentiles nested, scalars top-level | Polish edit for schema consistency | `generate_corpus.py:assemble_cycle_json` |
| Sentence-leading prose capitalization at use site | Labels stay lowercase (mid-sentence trend uses lowercase); only sentence-starting slots get capitalized | `summarizer.py:_capitalize_lead` |
| `SYNTHETIC_DISCLAIMER` constant + `validate_synthetic_pipeline()` | Codex caught that the disclaimer was printed by the calling shell, not by code → no longer reproducible. Constant + function fixes that | `generate_corpus.py:88-93, 434-460` |

---

## How to run

**Synthetic structural validation** (single function call, all artifacts including disclaimer):

```bash
cd ~/Work/feed-looks-back-spike
/home/amay/miniconda3/envs/ambi_audio/bin/python -c "
import sys; sys.path.insert(0, 'python')
from generate_corpus import validate_synthetic_pipeline
validate_synthetic_pipeline()
"
```

**Real audio (Bashar's recording):**

```bash
cd ~/Work/feed-looks-back-spike
/home/amay/miniconda3/envs/ambi_audio/bin/python python/generate_corpus.py audio/<file>.wav corpus/
/home/amay/miniconda3/envs/ambi_audio/bin/python python/generate_corpus.py audio/<file>.wav --print-example
```

**Per-module self-tests** (each module is also runnable for self-verification):

```bash
/home/amay/miniconda3/envs/ambi_audio/bin/python python/features.py
/home/amay/miniconda3/envs/ambi_audio/bin/python python/statistics.py
/home/amay/miniconda3/envs/ambi_audio/bin/python python/windowing.py
/home/amay/miniconda3/envs/ambi_audio/bin/python python/summarizer.py
/home/amay/miniconda3/envs/ambi_audio/bin/python python/sparklines.py
```

---

## Synthetic test cycles (read directly from corpus, authoritative)

```
cycle_000: Quiet, rising sharply. Balanced timbre. Dense. Tonal center E with secondary emphasis on D#. Early in the performance, opening territory.
cycle_001: Moderate intensity, rising sharply. Balanced timbre. Rapid. Tonal center E with secondary emphasis on D#. Early in the performance, opening territory.
cycle_002: Intense, rising sharply. Balanced timbre. Dense. Tonal center E with secondary emphasis on D#. Early in the performance, opening territory.
cycle_003: Intense, falling. Balanced timbre. Sparse. Tonal center D# with secondary emphasis on E. Developing.
cycle_004: Moderate intensity, falling. Balanced timbre. Very sparse. Tonal center E with secondary emphasis on D. Developing.
```

Synthetic exercises three articulation labels (`Dense`, `Rapid`, `Sparse`, `Very sparse`), two tonal centers (`E`, `D#`), and two trend directions (`rising sharply`, `falling`) — band coverage is real, not nominal.

---

## Open questions for next session

1. **`"rapid"` vs `"Rapid articulation"`** — articulation labels list says `"rapid"` (bare adjective like `"sparse"`/`"dense"`), but example #3 in the original spec renders the slot as `"Rapid articulation."`. Spec is internally inconsistent. Currently shipping the literal label spec (`"Rapid."`). One-line edit either way once Amer decides.
2. **Synthetic-data oddities** — white noise produces uniform-ish chroma → dominant pitch collapses to whichever class wins by tiny margins (here mostly `E`/`D#`). Centroid stays ~5500 Hz across all 5 windows because flat-spectrum noise has near-constant centroid. Both vanish on real tonal content; flagging so they're not misread as bugs against real audio.
3. **No automated NaN/Inf or round-trip JSON assertions in `generate_corpus.py` post-write** — Phase 3 schema sweep was done via one-off inline script, not embedded. Plan is explicit that tests beyond per-module self-tests are out of scope, so this is a deliberate decision, not an oversight. One-line addition if Amer wants the assertions embedded for the real-audio runs.
4. **Calibration call** — when Bashar's recording lands, the `RMS p33/p66/p90` and `Centroid p33/p66/p90` cutoffs may produce labels that don't match what Amer hears. Band cutoffs are named constants in `summarizer.py` precisely for this — easy to tune.

---

## Codex review pattern (Amer's workflow)

Amer runs Codex against the spike after each phase gate. Codex returns structured findings with file paths and line numbers, plus a "paste-back" recommendation. Amer relays those verbatim and expects:

1. Verify each finding against the codebase (grep the named file/line). Don't trust the finding blindly — but in Session 1, every Codex finding was technically correct.
2. Push back with technical reasoning if a finding is wrong; just patch if it's right. No "great catch", no "you're absolutely right" — actions speak (per CLAUDE.md and the receiving-code-review skill).
3. Re-run any reproducibility test Codex asked for (e.g., the cold-cache numba run).
4. Re-present at the gate with diffs, evidence, and approval request.

Codex caught five real issues across Session 1's three gates:
- Phase 1: numba cache portability (env-specific state masked the bug locally) + stereo tuple shape collapse.
- Phase 2: sentence-initial lowercase prose.
- Phase 3: missing disclaimer in code path + narrated-not-read cycle_001 prose in the gate report.

External independent review on a different machine reliably surfaces things the implementer's environment masks.

---

## Calibration pass (the immediate next step)

When Bashar's real Hijaz recording lands, run the pipeline against it and bring back:

1. The full printed `File statistics` block from stdout (RMS percentiles, centroid percentiles, density percentiles, both stds, both thresholds).
2. One full cycle JSON from somewhere mid-performance (include `_debug`).
3. Amer's gut read: does the Block 2 prose match what he *hears* in that moment of the audio?

If band cutoffs need tuning (likely, since synthetic data can't predict where real audio lands in percentile space), they're named constants in `summarizer.py`. After the calibration pass, only then move to Session 2.

---

## Session 2 preview (what comes after calibration)

Per Amer's prior planning notes:
- Node runner that reads cycle JSONs and calls Opus.
- Modular `hijaz_base.md` + 5 configs architecture.
- Config-appropriate artifacts for p5.js and Three.js.
- First live Opus run.

The Hijaz-specific DSP from `hijaz-opus-prompt-dsp.md` (tahwil FSM, jins-region detection, microtonal pitch tracking, aug2 interval detection) is the main scaffold's work — out of scope for the spike. Session 2 may pull some of it in for the live Opus prompt, but the cycle-JSON pipeline stays generic.

---

## References

- **Spike (this directory):** `~/Work/feed-looks-back-spike/`
- **Main scaffold (DO NOT TOUCH during spike):** `~/Work/Build_With_OPUS_4.7_hack/`
- **Source files attached to Session 1 input:**
  - `~/Work/build_spikes_tests/analyze_tracks.py` (librosa per-track analyzer; source for `extract_timeseries` adaptation)
  - `~/Work/build_spikes_tests/hijaz-opus-prompt-dsp.md` (Opus prompt + DSP spec; CONTEXT ONLY for spike)
- **Conda env:** `/home/amay/miniconda3/envs/ambi_audio/bin/python` (librosa 0.11.0, numpy 2.4.4)
- **CLAUDE.md** at `~/CLAUDE.md` — code-review-graph MCP guidance for the main scaffold (not the spike itself)

---

*End of Session 1 handoff. Spike is ready for the calibration pass.*
