"""
stream_features.py — Python feature extractor, sole DSP owner across both modes.

Modes:
    --mode precompute --input <audio> --output <features_track.json>
        Runs the full DSP pipeline on an audio file offline, resamples all
        features to a uniform 60 Hz grid, writes features_track.json.

    --mode live --ws-url <ws://host:port/ws> --run-id <id> [--device <name>]
        Opens a sounddevice input stream on the selected device, runs the
        same DSP pipeline per audio callback chunk, streams JSON frames to
        the stage_server WebSocket as role=feature_producer.

Feature vocabulary (six, fixed — matches patch_protocol.mjs):
    amplitude          : float in [0, 1]   — RMS envelope, normalized
    onset_strength     : float in [0, 1]   — librosa onset, normalized
    spectral_centroid  : float ≥ 0 (Hz)    — unnormalized
    hijaz_state        : enum               — quiet|approach|arrived|tahwil|aug2
    hijaz_intensity    : float in [0, 1]   — rms_mean / rms_p90
    hijaz_tahwil       : bool               — one-frame impulse at tonal-gravity
                                               transitions INTO upper_tonic

Hijaz state mapping (spec §10.3 ← Session B vocabulary):
    aug2 flag on current or vs prior cycle   → "aug2"
    tonal_gravity == "upper_tonic"           → "tahwil"
    tonal_gravity == "lower_tonic"           → "arrived"
    intensity band == "quiet"                → "quiet"
    otherwise (transitional + non-quiet)     → "approach"
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

# Package-vs-direct import shim (matches summarizer.py convention).
try:
    from .features import extract_timeseries
    from .statistics import compute_file_statistics
    from .summarizer import (
        detect_tonal_gravity,
        detect_aug2,
        categorize_intensity,
    )
    from .windowing import compute_snapshot_times
    from .generate_corpus import compute_pass_1_cycles, build_block_1_scalars
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from features import extract_timeseries  # type: ignore[no-redef]
    from statistics import compute_file_statistics  # type: ignore[no-redef]
    from summarizer import (  # type: ignore[no-redef]
        detect_tonal_gravity,
        detect_aug2,
        categorize_intensity,
    )
    from windowing import compute_snapshot_times  # type: ignore[no-redef]
    from generate_corpus import compute_pass_1_cycles, build_block_1_scalars  # type: ignore[no-redef]


FRAME_RATE_HZ = 60
SCHEMA_VERSION = "1"
VALID_HIJAZ_STATES = {"quiet", "approach", "arrived", "tahwil", "aug2"}


# ─── Pre-computed (offline) feature track ──────────────────────────────────

def precompute_track(audio_path: Path, frame_rate_hz: int = FRAME_RATE_HZ) -> dict[str, Any]:
    """
    Compute the features_track.json payload for a finished audio file.

    All librosa + Hijaz features are resampled onto a uniform 60 Hz grid
    aligned with t=0. Returns the JSON-ready dict conforming to
    FeaturesTrackSchema in node/src/patch_protocol.mjs.
    """
    raw = extract_timeseries(str(audio_path))
    duration = float(raw["duration"])
    num_frames = int(duration * frame_rate_hz) + 1
    grid = np.arange(num_frames, dtype=np.float64) / frame_rate_hz

    # librosa envelopes (amplitude + onset_strength normalized, centroid raw)
    amplitude_grid = np.interp(
        grid,
        raw["rms_times"],
        _normalize_to_p99(raw["rms"]),
        left=0.0,
        right=0.0,
    )
    onset_grid = np.interp(
        grid,
        raw["onset_times"],
        _normalize_to_p99(raw["onset_strength"]),
        left=0.0,
        right=0.0,
    )
    centroid_grid = np.interp(
        grid,
        raw["centroid_times"],
        raw["centroid"],
        left=0.0,
        right=0.0,
    )

    # Session B detectors via existing corpus-generation pipeline
    hijaz_state_grid, hijaz_intensity_grid, hijaz_tahwil_grid = _hijaz_tracks_on_grid(
        raw, grid
    )

    amplitude_grid = np.clip(amplitude_grid, 0.0, 1.0)
    onset_grid = np.clip(onset_grid, 0.0, 1.0)
    centroid_grid = np.clip(centroid_grid, 0.0, None)
    hijaz_intensity_grid = np.clip(hijaz_intensity_grid, 0.0, 1.0)

    frames = []
    for i, t_val in enumerate(grid):
        frames.append(
            {
                "t": round(float(t_val), 6),
                "amplitude": round(float(amplitude_grid[i]), 6),
                "onset_strength": round(float(onset_grid[i]), 6),
                "spectral_centroid": round(float(centroid_grid[i]), 3),
                "hijaz_state": hijaz_state_grid[i],
                "hijaz_intensity": round(float(hijaz_intensity_grid[i]), 6),
                "hijaz_tahwil": bool(hijaz_tahwil_grid[i]),
            }
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "duration_s": duration,
        "frame_rate_hz": frame_rate_hz,
        "frames": frames,
    }


# ─── Helpers ────────────────────────────────────────────────────────────────

def _normalize_to_p99(values: np.ndarray) -> np.ndarray:
    if values.size == 0:
        return values
    p99 = float(np.percentile(values, 99))
    if p99 <= 0:
        return np.zeros_like(values)
    return values / p99


def _hijaz_tracks_on_grid(
    raw: dict[str, Any], grid: np.ndarray
) -> tuple[list[str], np.ndarray, np.ndarray]:
    """
    Run Session B Hijaz detectors on a sliding-window basis across the track
    and resample per-cycle detector outputs onto the uniform 60 Hz grid.
    """
    duration = float(raw["duration"])
    snapshot_times = compute_snapshot_times(duration)
    if not snapshot_times:
        return ["quiet"] * grid.size, np.zeros_like(grid), np.zeros(grid.size, dtype=bool)

    file_stats = compute_file_statistics(raw)
    pass_1 = compute_pass_1_cycles(raw, file_stats, snapshot_times)

    per_cycle_history: list[dict[str, Any]] = []
    per_cycle_states: list[str] = []
    per_cycle_intensities: list[float] = []
    per_cycle_tahwils: list[bool] = []
    prev_gravity = "transitional"

    for cycle in pass_1:
        block_1 = build_block_1_scalars(cycle)
        tonal = detect_tonal_gravity(block_1, per_cycle_history)
        aug2 = detect_aug2(block_1, per_cycle_history)
        intensity_band = categorize_intensity(block_1["rms_mean"], file_stats)

        if aug2.get("within_window") or aug2.get("between_cycles"):
            state = "aug2"
        elif tonal == "upper_tonic":
            state = "tahwil"
        elif tonal == "lower_tonic":
            state = "arrived"
        elif intensity_band == "quiet":
            state = "quiet"
        else:
            state = "approach"
        if state not in VALID_HIJAZ_STATES:
            state = "quiet"

        # hijaz_intensity: continuous rms_mean vs file rms_p90.
        rms_p90 = float(file_stats.rms_p90) or 1.0
        intensity_scalar = min(1.0, float(block_1["rms_mean"]) / rms_p90) if rms_p90 > 0 else 0.0

        # hijaz_tahwil: one-frame impulse only on transition INTO upper_tonic.
        tahwil_impulse = (tonal == "upper_tonic" and prev_gravity != "upper_tonic")

        per_cycle_history.append(block_1)
        per_cycle_states.append(state)
        per_cycle_intensities.append(intensity_scalar)
        per_cycle_tahwils.append(bool(tahwil_impulse))
        prev_gravity = tonal

    state_out: list[str] = []
    intensity_out = np.zeros(grid.size, dtype=np.float64)
    tahwil_out = np.zeros(grid.size, dtype=bool)

    for i, t_val in enumerate(grid):
        idx = _snapshot_index_for(t_val, snapshot_times)
        state_out.append(per_cycle_states[idx])
        intensity_out[i] = per_cycle_intensities[idx]
        if per_cycle_tahwils[idx] and _is_impulse_anchor(t_val, snapshot_times[idx]):
            tahwil_out[i] = True

    return state_out, intensity_out, tahwil_out


def _snapshot_index_for(t: float, snapshot_times: list[float]) -> int:
    for idx, cutoff in enumerate(snapshot_times):
        if t < cutoff:
            return max(0, idx - 1)
    return len(snapshot_times) - 1


def _is_impulse_anchor(t: float, snapshot_t: float) -> bool:
    """One-frame impulse: fires on the first grid cell at-or-after the snapshot."""
    return snapshot_t <= t < snapshot_t + 1.0 / FRAME_RATE_HZ


# ─── Live mode stub (filled in Task 7) ──────────────────────────────────────

def run_live(
    ws_url: str,
    run_id: str,
    device: str | None,
    frame_rate_hz: int = FRAME_RATE_HZ,
) -> int:
    raise NotImplementedError(
        f"live mode is wired in Phase 3 Task 7 "
        f"(ws_url={ws_url}, run_id={run_id}, device={device}, frame_rate_hz={frame_rate_hz})"
    )


# ─── CLI ────────────────────────────────────────────────────────────────────

def cli() -> int:
    parser = argparse.ArgumentParser(description="Feed Looks Back audio feature extractor.")
    parser.add_argument("--mode", choices=["precompute", "live"])
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--ws-url", dest="ws_url")
    parser.add_argument("--run-id", dest="run_id")
    parser.add_argument("--device")
    parser.add_argument(
        "--frame-rate-hz", dest="frame_rate_hz", type=int, default=FRAME_RATE_HZ
    )
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return _run_self_tests()

    if not args.mode:
        parser.error("--mode is required unless --self-test is passed")

    if args.mode == "precompute":
        if not args.input or not args.output:
            parser.error("--mode precompute requires --input and --output")
        track = precompute_track(args.input, args.frame_rate_hz)
        args.output.write_text(json.dumps(track))
        return 0

    if args.mode == "live":
        if not args.ws_url or not args.run_id:
            parser.error("--mode live requires --ws-url and --run-id")
        return run_live(
            ws_url=args.ws_url,
            run_id=args.run_id,
            device=args.device,
            frame_rate_hz=args.frame_rate_hz,
        )

    return 2


# ─── Inline self-tests ─────────────────────────────────────────────────────

def _run_self_tests() -> int:
    import tempfile

    passed = 0
    failed = 0

    def t(desc: str, fn):
        nonlocal passed, failed
        try:
            fn()
            passed += 1
            print(f"  ok  {desc}")
        except AssertionError as err:
            failed += 1
            print(f"  FAIL {desc}\n    {err}")
        except Exception as err:  # noqa: BLE001
            failed += 1
            print(f"  FAIL {desc}\n    {type(err).__name__}: {err}")

    def _synth_audio(
        duration_s: float = 15.0, sr: int = 22050
    ) -> tuple[np.ndarray, int]:
        """
        Deterministic sine sweep long enough to survive windowing
        (compute_snapshot_times defaults first-snapshot=5s, stride=5s, so
        a 15s buffer yields 3 cycles at t=5, 10, and 15 after we clear the
        end-buffer cutoff).
        """
        t_vec = np.linspace(
            0.0, duration_s, int(duration_s * sr), endpoint=False, dtype=np.float32
        )
        freqs = np.linspace(200.0, 1200.0, t_vec.size, dtype=np.float32)
        y = 0.5 * np.sin(2 * np.pi * freqs * t_vec).astype(np.float32)
        return y, sr

    def _write_synth_wav(path: Path) -> None:
        import wave
        y, sr = _synth_audio()
        pcm = (y * 32767).astype(np.int16)
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(pcm.tobytes())

    def _assert_track_structure(track: dict):
        assert track["schema_version"] == "1"
        assert track["frame_rate_hz"] == 60
        assert isinstance(track["frames"], list)
        assert len(track["frames"]) > 0, "track has no frames"
        # Uniform 60 Hz grid: successive t's differ by 1/60 s (± float slop).
        dts = np.diff([f["t"] for f in track["frames"]])
        assert np.allclose(dts, 1.0 / 60.0, atol=1e-4), f"non-uniform grid: {dts[:5]}"
        # All six features present on every frame.
        required = {
            "t", "amplitude", "onset_strength", "spectral_centroid",
            "hijaz_state", "hijaz_intensity", "hijaz_tahwil",
        }
        for i, frame in enumerate(track["frames"]):
            missing = required - frame.keys()
            assert not missing, f"frame {i} missing keys: {missing}"
        # Range checks on the normalized features.
        for f in track["frames"]:
            assert 0.0 <= f["amplitude"] <= 1.0, f"amplitude out of range: {f['amplitude']}"
            assert 0.0 <= f["onset_strength"] <= 1.0, f"onset out of range: {f['onset_strength']}"
            assert f["spectral_centroid"] >= 0
            assert f["hijaz_state"] in VALID_HIJAZ_STATES, f"bad state: {f['hijaz_state']}"
            assert 0.0 <= f["hijaz_intensity"] <= 1.0, f"intensity out of range: {f['hijaz_intensity']}"
            assert isinstance(f["hijaz_tahwil"], bool)

    def _check_synth_track():
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "synth.wav"
            _write_synth_wav(wav)
            track = precompute_track(wav)
            _assert_track_structure(track)

    def _check_boundaries():
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "synth.wav"
            _write_synth_wav(wav)
            track = precompute_track(wav)
            frames = track["frames"]
            assert frames[0]["t"] == 0.0
            assert frames[-1]["t"] <= track["duration_s"] + 1.0 / FRAME_RATE_HZ
            # duration_s and last frame should be within one frame period.
            assert abs(track["duration_s"] - frames[-1]["t"]) <= 1.0 / FRAME_RATE_HZ + 1e-6

    t("precompute_track returns a valid schema v1 track for a synth WAV", _check_synth_track)
    t("precompute_track first frame t=0, last frame within 1/60 s of duration", _check_boundaries)

    print(f"\n{passed}/{passed + failed} passed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(cli())
