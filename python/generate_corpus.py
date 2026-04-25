"""
generate_corpus.py — CLI entry point for the spike pipeline.

Flow per audio file:
    extract_timeseries → compute_file_statistics →
    Pass 1 (per-cycle Block 1 numerics + onset_density percentiles) →
    Pass 2 (prose + sparklines + _debug block + JSON write) →
    print summary

CLI:
    python python/generate_corpus.py audio/file.wav corpus/
    python python/generate_corpus.py audio/file.wav --print-example

The --print-example flag processes only the middle cycle, pretty-prints its
full JSON to stdout, and writes no files. ``output_dir`` is then optional and
ignored if supplied.

The two-pass structure exists because the articulation band labels in the
prose generator depend on per-window onset_density percentiles, which can
only be computed after every cycle's raw onset_density value has been seen.
Frame-level percentiles (RMS, centroid, onset_strength) are file-static and
land in the FileStatistics object before either pass runs.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

# Local sibling-module imports. Same try/except pattern as summarizer.py:
# the package-context branch is preferred when this is imported as
# ``python.generate_corpus``; the fallback supports direct execution via
# ``python python/generate_corpus.py``. The fallback's sys.path mutation
# makes the LOCAL statistics.py win over stdlib `statistics` — that is
# intentional and contained to the script-execution path.
try:
    from .features import extract_timeseries, AudioInput
    from .statistics import FileStatistics, compute_file_statistics
    from .windowing import (
        WINDOW_DURATION_S,
        compute_snapshot_times,
        window_mask,
    )
    from .summarizer import (
        compute_normalized_slope,
        categorize_trend,
        generate_prose,
    )
    from .sparklines import generate_sparkline
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from features import extract_timeseries, AudioInput  # type: ignore[no-redef]
    from statistics import FileStatistics, compute_file_statistics  # type: ignore[no-redef]
    from windowing import (  # type: ignore[no-redef]
        WINDOW_DURATION_S,
        compute_snapshot_times,
        window_mask,
    )
    from summarizer import (  # type: ignore[no-redef]
        compute_normalized_slope,
        categorize_trend,
        generate_prose,
    )
    from sparklines import generate_sparkline  # type: ignore[no-redef]

# ─── Constants ─────────────────────────────────────────────────────────────
PITCH_CLASSES: Tuple[str, ...] = (
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
)
SECONDARY_CHROMA_RATIO: float = 0.7   # secondary must be ≥ 0.7 × dominant mean
SILENT_CHROMA_FLOOR: float = 1e-9     # below this → no meaningful tonal center

# librosa.util.peak_pick parameters tuned for onset_strength envelopes.
# Small max windows because the envelope is already smoothed; larger avg
# windows give a meaningful local-mean baseline; delta=0.0 because we
# filter externally with the file-derived onset_peak_threshold.
PEAK_PICK_PRE_MAX = 3
PEAK_PICK_POST_MAX = 3
PEAK_PICK_PRE_AVG = 10
PEAK_PICK_POST_AVG = 10
PEAK_PICK_DELTA = 0.0
PEAK_PICK_WAIT = 2

# Rolling history window passed to generate_prose for Hijaz pattern detection.
# Exact tonal-gravity transition logic needs more than the 2-cycle window used
# by detect_tonal_gravity itself: returning-to-tonic looks at the previous
# cycle's classified state, and grounded-clause suppression looks at the two
# previous classified states. That requires up to 4 prior cycles so those
# earlier states can each be evaluated on their own 3-cycle windows.
HISTORY_WINDOW_SIZE = 4

# Verbatim Phase 3 structural-validation disclaimer. Lives as a module-level
# constant so the synthetic-validation flow has a single source of truth and
# the disclaimer is emitted by code, not narrated by a calling shell command.
SYNTHETIC_DISCLAIMER: str = (
    "NOTE: This synthetic signal is for structural validation only.\n"
    "Block 2 prose quality and artistic fit can only be evaluated against real audio."
)


# ─── Window slicing helper (returns both values & times in one mask op) ───
def _slice_window(values: np.ndarray, times: np.ndarray, snapshot_time: float):
    mask = window_mask(times, snapshot_time)
    return values[mask], times[mask]


# ─── Pitch-class extraction ────────────────────────────────────────────────
def _compute_pitch_classes(
    chroma: np.ndarray,
    chroma_times: np.ndarray,
    snapshot_time: float,
) -> Tuple[str, Optional[str]]:
    """
    Return ``(dominant_letter, secondary_letter_or_None)`` for the window.

    Secondary is reported only if its mean chroma is ≥ ``SECONDARY_CHROMA_RATIO``
    times the dominant's mean — and only if the dominant itself is above the
    silent-chroma floor (a near-silent window has no meaningful tonal center,
    so neither letter is reliable).
    """
    mask = window_mask(chroma_times, snapshot_time)
    chroma_window = chroma[:, mask]
    if chroma_window.shape[1] == 0:
        return ("C", None)
    means = chroma_window.mean(axis=1)
    sorted_idx = np.argsort(means)[::-1]
    dominant_idx = int(sorted_idx[0])
    second_idx = int(sorted_idx[1])
    dominant_mean = float(means[dominant_idx])

    if dominant_mean < SILENT_CHROMA_FLOOR:
        # Whole window is essentially silent — chroma argmax is meaningless.
        return ("C", None)

    secondary: Optional[str] = None
    if float(means[second_idx]) >= SECONDARY_CHROMA_RATIO * dominant_mean:
        secondary = PITCH_CLASSES[second_idx]
    return (PITCH_CLASSES[dominant_idx], secondary)


# ─── Onset density and peak strength in a window ──────────────────────────
def _peak_pick_numpy(
    values: np.ndarray,
    *,
    pre_max: int,
    post_max: int,
    pre_avg: int,
    post_avg: int,
    delta: float,
    wait: int,
) -> np.ndarray:
    """
    Pure-NumPy equivalent of the small ``librosa.util.peak_pick`` subset this
    pipeline needs. Avoids numba's compiled gufunc path, which can segfault in
    restricted/sandboxed environments while importing librosa peak picking.
    """
    peaks: list[int] = []
    last_peak = -wait - 1
    for i, value in enumerate(values):
        max_start = max(0, i - pre_max)
        max_end = min(values.size, i + post_max + 1)
        avg_start = max(0, i - pre_avg)
        avg_end = min(values.size, i + post_avg + 1)
        if value < np.max(values[max_start:max_end]):
            continue
        if value < (float(np.mean(values[avg_start:avg_end])) + delta):
            continue
        if i <= last_peak + wait:
            continue
        peaks.append(i)
        last_peak = i
    return np.asarray(peaks, dtype=np.int64)


def _compute_onset_density(
    onset_strength: np.ndarray,
    onset_times: np.ndarray,
    snapshot_time: float,
    onset_peak_threshold: float,
) -> Tuple[float, float]:
    """
    Return ``(onset_density_per_s, onset_peak_strength)`` for the window.

    Workflow: slice the onset-strength envelope to the window, run a local
    peak picker for indices, filter peaks below the file's
    ``onset_peak_threshold``, divide by window duration.
    """
    win_values, _win_times = _slice_window(onset_strength, onset_times, snapshot_time)
    if win_values.size == 0:
        return 0.0, 0.0
    onset_peak_strength = float(np.max(win_values))

    peak_idx = _peak_pick_numpy(
        win_values,
        pre_max=PEAK_PICK_PRE_MAX,
        post_max=PEAK_PICK_POST_MAX,
        pre_avg=PEAK_PICK_PRE_AVG,
        post_avg=PEAK_PICK_POST_AVG,
        delta=PEAK_PICK_DELTA,
        wait=PEAK_PICK_WAIT,
    )
    if peak_idx.size == 0:
        return 0.0, onset_peak_strength
    above_threshold = win_values[peak_idx] >= onset_peak_threshold
    count = int(np.sum(above_threshold))
    return count / WINDOW_DURATION_S, onset_peak_strength


def _compute_active_centroid_mean(
    centroid_window: np.ndarray,
    centroid_window_times: np.ndarray,
    rms: np.ndarray,
    rms_times: np.ndarray,
    silence_threshold: float,
) -> float:
    """
    Compute windowed centroid mean using only frames above the silence threshold.

    Quiet trailing decays can leave a few thin high-frequency frames that push a
    plain centroid mean upward. We align RMS onto the centroid frame times and
    drop centroid samples whose interpolated RMS is below the file-level
    ``silence_threshold``. If a window has no active centroid frames, we fall
    back to the full-window centroid mean.
    """
    if centroid_window.size == 0:
        return 0.0

    rms_at_centroid_times = np.interp(
        centroid_window_times,
        rms_times,
        rms,
        left=float(rms[0]),
        right=float(rms[-1]),
    )
    active_centroid = centroid_window[rms_at_centroid_times >= silence_threshold]
    if active_centroid.size == 0:
        return float(np.mean(centroid_window))
    return float(np.mean(active_centroid))


# ─── Pass 1 — per-cycle Block 1 numeric values ────────────────────────────
def compute_pass_1_cycles(
    timeseries: dict,
    file_stats: FileStatistics,
    snapshot_times: list[float],
) -> list[dict]:
    """
    For each snapshot time, compute the raw Block 1 numeric values plus the
    intermediates Pass 2 will need (normalized slopes for the _debug block).

    Returned dicts are intentionally a SUPERSET of the Block 1 schema —
    extra fields are prefixed with ``_`` and consumed in Pass 2; they never
    reach the output JSON.
    """
    cycles: list[dict] = []
    rms = timeseries["rms"]
    rms_times = timeseries["rms_times"]
    cent = timeseries["centroid"]
    cent_times = timeseries["centroid_times"]
    onset = timeseries["onset_strength"]
    onset_times = timeseries["onset_times"]
    chroma = timeseries["chroma"]
    chroma_times = timeseries["chroma_times"]

    for idx, snapshot_t in enumerate(snapshot_times):
        rms_w, rms_w_t = _slice_window(rms, rms_times, snapshot_t)
        cent_w, cent_w_t = _slice_window(cent, cent_times, snapshot_t)

        rms_mean = float(np.mean(rms_w)) if rms_w.size else 0.0
        rms_peak = float(np.max(rms_w)) if rms_w.size else 0.0
        centroid_mean_hz = _compute_active_centroid_mean(
            cent_w,
            cent_w_t,
            rms,
            rms_times,
            file_stats.silence_threshold,
        )
        silence_ratio = (
            float(np.sum(rms_w < file_stats.silence_threshold) / rms_w.size)
            if rms_w.size else 0.0
        )

        onset_density, onset_peak_strength = _compute_onset_density(
            onset, onset_times, snapshot_t, file_stats.onset_peak_threshold,
        )

        dominant, secondary = _compute_pitch_classes(chroma, chroma_times, snapshot_t)

        rms_norm_slope = compute_normalized_slope(rms_w, rms_w_t, file_stats.rms_std)
        cent_norm_slope = compute_normalized_slope(cent_w, cent_w_t, file_stats.centroid_std)

        cycles.append({
            "cycle_index": idx,
            "snapshot_time_s": float(snapshot_t),
            "window_start_s": float(snapshot_t - WINDOW_DURATION_S),
            "window_end_s": float(snapshot_t),

            # Block 1 numeric values (rounded per spec)
            "rms_mean": round(rms_mean, 3),
            "rms_peak": round(rms_peak, 3),
            "rms_trend": categorize_trend(rms_norm_slope),
            "centroid_mean_hz": int(round(centroid_mean_hz)),
            "centroid_trend": categorize_trend(cent_norm_slope),
            "onset_density": round(onset_density, 3),
            "onset_peak_strength": round(onset_peak_strength, 3),
            "pitch_class_dominant": dominant,
            "pitch_class_secondary": secondary,
            "silence_ratio": round(silence_ratio, 3),
            "elapsed_total_s": round(float(snapshot_t), 1),

            # Pass 2 intermediates — never serialized into block_1_scalars
            "_rms_norm_slope": rms_norm_slope,
            "_cent_norm_slope": cent_norm_slope,
        })

    return cycles


# ─── Onset density percentiles (computed AFTER Pass 1) ────────────────────
def compute_density_percentiles(cycles: list[dict]) -> dict:
    """Return p10/p33/p66/p90 of onset_density across all cycles."""
    if not cycles:
        return {"p10": 0.0, "p33": 0.0, "p66": 0.0, "p90": 0.0}
    densities = np.array([c["onset_density"] for c in cycles], dtype=np.float64)
    p10, p33, p66, p90 = np.percentile(densities, [10, 33, 66, 90])
    return {"p10": float(p10), "p33": float(p33), "p66": float(p66), "p90": float(p90)}


# ─── Block 1 scalars helper (shared between Pass 2 and history building) ──
def build_block_1_scalars(cycle: dict) -> dict:
    """
    Project a Pass-1 cycle dict into the block_1_scalars schema.

    Shared by ``assemble_cycle_json`` (the cycle being written out) and the
    rolling-history accumulator (the prior cycles' block_1 dicts passed to
    ``generate_prose`` for Hijaz pattern detection). Keeping a single source
    of truth means a future block_1 schema change touches one function.
    """
    return {
        "rms_mean": cycle["rms_mean"],
        "rms_peak": cycle["rms_peak"],
        "rms_trend": cycle["rms_trend"],
        "centroid_mean_hz": cycle["centroid_mean_hz"],
        "centroid_trend": cycle["centroid_trend"],
        "onset_density": cycle["onset_density"],
        "onset_peak_strength": cycle["onset_peak_strength"],
        "pitch_class_dominant": cycle["pitch_class_dominant"],
        "pitch_class_secondary": cycle["pitch_class_secondary"],
        "silence_ratio": cycle["silence_ratio"],
        "window_duration_s": WINDOW_DURATION_S,
        "elapsed_total_s": cycle["elapsed_total_s"],
    }


# ─── Pass 2 — assemble final cycle JSON ───────────────────────────────────
def assemble_cycle_json(
    cycle: dict,
    file_stats: FileStatistics,
    density_pcts: dict,
    timeseries: dict,
    source_file: str,
    history_context: Optional[list] = None,
) -> dict:
    """
    Build the final cycle JSON dict matching the schema in the prompt.

    ``history_context`` is the rolling list of up to ``HISTORY_WINDOW_SIZE``
    (4) prior cycles' block_1_scalars dicts, passed verbatim to
    ``generate_prose`` for Hijaz pattern detection. ``None`` (the default)
    is treated as empty history — Block 2 then degrades to deterministic
    core + the AMBIGUOUS clause, which is correct behaviour for the first
    two cycles of a performance and for ad-hoc per-cycle invocations.
    """
    cycle_index = cycle["cycle_index"]
    cycle_id = f"cycle_{cycle_index:03d}"

    block_1_scalars = build_block_1_scalars(cycle)

    block_2_summary = generate_prose(
        block_1_scalars, file_stats, density_pcts,
        history_context=history_context,
    )

    block_3_sparklines = {
        "rms": generate_sparkline(
            timeseries["rms"], timeseries["rms_times"],
            cycle["window_start_s"], cycle["window_end_s"],
        ),
        "onset": generate_sparkline(
            timeseries["onset_strength"], timeseries["onset_times"],
            cycle["window_start_s"], cycle["window_end_s"],
        ),
        "centroid": generate_sparkline(
            timeseries["centroid"], timeseries["centroid_times"],
            cycle["window_start_s"], cycle["window_end_s"],
        ),
    }

    debug = {
        # All percentiles (file-level frame stats + per-window onset density)
        "file_percentiles": {
            "rms_p10": file_stats.rms_p10,
            "rms_p33": file_stats.rms_p33,
            "rms_p66": file_stats.rms_p66,
            "rms_p90": file_stats.rms_p90,
            "centroid_p10": file_stats.centroid_p10,
            "centroid_p33": file_stats.centroid_p33,
            "centroid_p66": file_stats.centroid_p66,
            "centroid_p90": file_stats.centroid_p90,
            "onset_density_p10": density_pcts["p10"],
            "onset_density_p33": density_pcts["p33"],
            "onset_density_p66": density_pcts["p66"],
            "onset_density_p90": density_pcts["p90"],
            "onset_strength_p90": file_stats.onset_strength_p90,
        },
        # Scalar stats live at _debug top-level (per the polish edit consistency rule)
        "rms_std": file_stats.rms_std,
        "centroid_std": file_stats.centroid_std,
        "silence_threshold": file_stats.silence_threshold,
        "onset_peak_threshold": file_stats.onset_peak_threshold,
        "rms_normalized_slope": cycle["_rms_norm_slope"],
        "centroid_normalized_slope": cycle["_cent_norm_slope"],
    }

    return {
        "cycle_id": cycle_id,
        "cycle_index": cycle_index,
        "source_file": source_file,
        "snapshot_time_s": cycle["snapshot_time_s"],
        "elapsed_total_s": cycle["elapsed_total_s"],
        "window_duration_s": WINDOW_DURATION_S,
        "window_start_s": cycle["window_start_s"],
        "window_end_s": cycle["window_end_s"],
        "block_1_scalars": block_1_scalars,
        "block_2_summary": block_2_summary,
        "block_3_sparklines": block_3_sparklines,
        "_debug": debug,
    }


# ─── Stats printing ────────────────────────────────────────────────────────
def print_statistics_block(
    file_stats: FileStatistics,
    density_pcts: dict,
    source_file: str,
    duration: float,
) -> None:
    """Print the formatted file-statistics block to stdout."""
    print(f"File statistics for {source_file} (duration {duration:.1f}s):")
    print(f"  RMS percentiles:        "
          f"p10={file_stats.rms_p10:.3f}  p33={file_stats.rms_p33:.3f}  "
          f"p66={file_stats.rms_p66:.3f}  p90={file_stats.rms_p90:.3f}")
    print(f"  Centroid percentiles:   "
          f"p10={file_stats.centroid_p10:.0f}Hz  p33={file_stats.centroid_p33:.0f}Hz  "
          f"p66={file_stats.centroid_p66:.0f}Hz  p90={file_stats.centroid_p90:.0f}Hz")
    print(f"  Onset density pct:      "
          f"p10={density_pcts['p10']:.2f}   p33={density_pcts['p33']:.2f}   "
          f"p66={density_pcts['p66']:.2f}   p90={density_pcts['p90']:.2f}")
    print(f"  Onset strength p90:     {file_stats.onset_strength_p90:.3f}")
    print(f"  RMS std:                {file_stats.rms_std:.3f}")
    print(f"  Centroid std:           {file_stats.centroid_std:.0f} Hz")
    print(f"  Silence threshold:      {file_stats.silence_threshold:.3f}   "
          f"(max(0.01, 0.5 × rms_p10))")
    print(f"  Onset peak threshold:   {file_stats.onset_peak_threshold:.3f}   "
          f"(max(1e-6, 0.5 × onset_strength_p90))")


# ─── Top-level pipeline ────────────────────────────────────────────────────
def run_pipeline(
    audio_input: AudioInput,
    source_file: str,
    output_dir: Optional[str] = None,
    print_example: bool = False,
) -> list[dict]:
    """
    Run the full pipeline. Returns the list of assembled cycle JSON dicts.

    print_example=True processes only the middle cycle, pretty-prints its
    full JSON to stdout, and skips file writes. ``output_dir`` is ignored.
    """
    timeseries = extract_timeseries(audio_input)
    duration = timeseries["duration"]

    file_stats = compute_file_statistics(timeseries)
    snapshot_times = compute_snapshot_times(duration)

    cycles_pass_1 = compute_pass_1_cycles(timeseries, file_stats, snapshot_times)
    density_pcts = compute_density_percentiles(cycles_pass_1)

    print_statistics_block(file_stats, density_pcts, source_file, duration)

    if not cycles_pass_1:
        print(f"\n  WARNING: audio shorter than first snapshot — no cycles produced "
              f"(duration={duration:.2f}s).")
        return []

    if print_example:
        middle_idx = len(cycles_pass_1) // 2
        cycle = cycles_pass_1[middle_idx]
        # Build proper history context for the middle cycle so the printed
        # example reflects the same Block 2 enrichment the file-write path
        # would produce.
        prior_cycles = cycles_pass_1[max(0, middle_idx - HISTORY_WINDOW_SIZE): middle_idx]
        history_context = [build_block_1_scalars(c) for c in prior_cycles]
        full = assemble_cycle_json(
            cycle, file_stats, density_pcts, timeseries, source_file,
            history_context=history_context,
        )
        print(f"\n  --print-example: middle cycle "
              f"(index {middle_idx} of {len(cycles_pass_1)} total)")
        print(json.dumps(full, indent=2, ensure_ascii=False))
        return [full]

    if output_dir is None:
        # Should be unreachable thanks to argparse validation, but guard anyway.
        raise ValueError("output_dir is required when print_example=False")

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    all_full: list[dict] = []
    history_context: list[dict] = []
    for cycle in cycles_pass_1:
        full = assemble_cycle_json(
            cycle, file_stats, density_pcts, timeseries, source_file,
            history_context=history_context,
        )
        all_full.append(full)
        # Roll history forward AFTER processing this cycle so detection sees
        # only PRIOR cycles. Truncate to the window size from the front.
        history_context.append(full["block_1_scalars"])
        if len(history_context) > HISTORY_WINDOW_SIZE:
            history_context = history_context[-HISTORY_WINDOW_SIZE:]
        out_file = output_path / f"{full['cycle_id']}.json"
        with out_file.open("w", encoding="utf-8") as f:
            json.dump(full, f, indent=2, ensure_ascii=False)
            f.write("\n")

    print(f"\nWrote {len(all_full)} cycle JSON files to {output_path}/")
    print(f"Audio duration: {duration:.1f}s")
    print(f"  cycle 0       : {all_full[0]['block_2_summary']}")
    if len(all_full) > 1:
        mid_idx = len(all_full) // 2
        print(f"  cycle {mid_idx:<7}: {all_full[mid_idx]['block_2_summary']}")
    last_idx = len(all_full) - 1
    if last_idx not in (0, len(all_full) // 2):
        print(f"  cycle {last_idx:<7}: {all_full[last_idx]['block_2_summary']}")

    return all_full


# ─── Synthetic audio for Phase 3 structural validation ────────────────────
def make_synthetic_audio() -> Tuple[np.ndarray, int]:
    """
    Build the Phase 3 30-second synthetic test audio per spec:

    - White noise at 22050 Hz.
    - Linear amplitude envelope: 0.1 → 0.6 over 0–15 s; brief hold; 0.6 → 0.05
      by second 30.
    - Six transients at seconds 3, 8, 12, 18, 23, 27 (amplitude 0.8, ~0.1 s wide,
      triangle-shaped so they have actual onset character).

    Seeded with ``rng = np.random.default_rng(0)`` for reproducibility.
    """
    sr = 22050
    duration_s = 30.0
    n = int(sr * duration_s)
    rng = np.random.default_rng(0)

    y = rng.standard_normal(n).astype(np.float32)

    t = np.arange(n) / sr
    env = np.empty(n, dtype=np.float32)
    rise_end_s = 15.0
    hold_end_s = 17.0   # tiny hold per "hold briefly" in spec
    rise_mask = t < rise_end_s
    env[rise_mask] = np.interp(t[rise_mask], [0.0, rise_end_s], [0.1, 0.6])
    hold_mask = (t >= rise_end_s) & (t < hold_end_s)
    env[hold_mask] = 0.6
    fall_mask = t >= hold_end_s
    env[fall_mask] = np.interp(t[fall_mask], [hold_end_s, duration_s], [0.6, 0.05])
    y *= env

    transient_seconds = (3.0, 8.0, 12.0, 18.0, 23.0, 27.0)
    transient_width = int(0.1 * sr)
    half = transient_width // 2
    burst_template = np.concatenate([
        np.linspace(0.0, 0.8, half, dtype=np.float32),
        np.linspace(0.8, 0.0, half, dtype=np.float32),
    ])
    for sec in transient_seconds:
        start = int(sec * sr)
        end = min(start + len(burst_template), n)
        y[start:end] += burst_template[: end - start]

    return y, sr


def validate_synthetic_pipeline(
    output_dir: Optional[str] = "corpus",
    print_middle_cycle_json: bool = True,
) -> list[dict]:
    """
    Run the full pipeline against in-memory synthetic audio per Phase 3 spec
    and emit the verbatim structural-validation disclaimer.

    Single source of truth for the synthetic validation flow — invoking this
    one function reproduces every Phase 3 gate artifact (stats block, written
    cycle JSONs, middle-cycle JSON pretty-print, the disclaimer line).
    """
    y, sr = make_synthetic_audio()
    cycles = run_pipeline(
        (y, sr),
        source_file="synthetic_test.wav",
        output_dir=output_dir,
    )

    if print_middle_cycle_json and cycles:
        middle = cycles[len(cycles) // 2]
        print()
        print(f"  middle cycle (index {middle['cycle_index']}) full JSON:")
        print(json.dumps(middle, indent=2, ensure_ascii=False))

    print()
    print(SYNTHETIC_DISCLAIMER)
    return cycles


# ─── argparse / CLI ────────────────────────────────────────────────────────
def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Feed Looks Back spike — generate per-cycle JSON corpus from an audio file."
        ),
    )
    parser.add_argument("audio_file_path", help="Path to input audio (WAV/MP3/FLAC).")
    parser.add_argument(
        "output_dir",
        nargs="?",
        default=None,
        help=(
            "Directory where cycle_NNN.json files are written. "
            "Required UNLESS --print-example is supplied."
        ),
    )
    parser.add_argument(
        "--print-example",
        action="store_true",
        help=(
            "Process only the middle cycle and pretty-print its full JSON to stdout. "
            "Skips all file writes; output_dir is ignored when present."
        ),
    )
    args = parser.parse_args(argv)
    if args.output_dir is None and not args.print_example:
        parser.error("output_dir is required unless --print-example is specified")
    return args


def cli_main(argv=None) -> int:
    args = parse_args(argv)
    audio_path = Path(args.audio_file_path)
    if not audio_path.exists():
        print(f"ERROR: audio file not found: {audio_path}", file=sys.stderr)
        return 2
    run_pipeline(
        audio_input=str(audio_path),
        source_file=audio_path.name,
        output_dir=args.output_dir,
        print_example=args.print_example,
    )
    return 0


if __name__ == "__main__":
    sys.exit(cli_main())
