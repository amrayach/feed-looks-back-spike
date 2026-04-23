"""
features.py — librosa time-series feature extraction.

Adapted from analyze_tracks.py. Strips plotting and full-file aggregations;
keeps only the per-frame time series needed for windowing.

Primary export: extract_timeseries(audio_path_or_array) -> dict
"""

from __future__ import annotations

import os
import tempfile
from typing import Tuple, Union

# Numba (used by librosa internals for JIT compilation) writes its cache next
# to librosa's site-packages files by default. In sandboxed shells, NFS mounts,
# or shared/read-only installs that path is not writable — librosa imports
# then fail with an obscure cache error before any feature code runs. Forcing
# the cache to a writable temp location keeps imports portable. setdefault
# preserves any value the caller already exported. Must be set BEFORE
# `import librosa`.
os.environ.setdefault(
    "NUMBA_CACHE_DIR",
    os.path.join(tempfile.gettempdir(), "flb-numba-cache"),
)

import numpy as np
import librosa


# Either a path-like to an audio file, or a (mono ndarray, sr) tuple.
# Tuple form is mono-only by contract — used by Phase 3 synthetic-audio
# structural validation so we never have to write a placeholder WAV. For
# stereo audio, pass a file path: librosa.load handles channel layout
# correctly on its own. We deliberately don't ship a channels-first vs.
# channels-last heuristic in the spike.
AudioInput = Union[str, "os.PathLike[str]", Tuple[np.ndarray, int]]


def extract_timeseries(audio_path_or_array: AudioInput) -> dict:
    """
    Extract per-frame audio features as a flat dict of numpy arrays.

    Parameters
    ----------
    audio_path_or_array
        Either a path to an audio file (WAV/MP3/FLAC — librosa handles all)
        or a pre-loaded ``(mono ndarray, sample_rate)`` tuple. Tuple form
        must be 1-D; stereo inputs go through the file-path branch where
        ``librosa.load`` performs the channel-layout-aware downmix.

    Returns
    -------
    dict with keys:
        sr               : int   — sample rate (Hz)
        duration         : float — total duration in seconds
        rms              : ndarray (n_frames,)            — RMS envelope
        rms_times        : ndarray (n_frames,)            — frame center times (s)
        centroid         : ndarray (n_frames,)            — spectral centroid (Hz)
        centroid_times   : ndarray (n_frames,)
        onset_strength   : ndarray (n_onset_frames,)      — onset envelope
        onset_times      : ndarray (n_onset_frames,)
        chroma           : ndarray (12, n_chroma_frames)  — via chroma_stft
        chroma_times     : ndarray (n_chroma_frames,)
    """
    # ── Load audio (or accept pre-loaded array) ─────────────────────────
    if isinstance(audio_path_or_array, tuple):
        y, sr = audio_path_or_array
        y = np.asarray(y, dtype=np.float32)
        if y.ndim != 1:
            # librosa.to_mono averages over axis=-2 (channels-first). A
            # channels-last (n_samples, 2) tuple would silently collapse the
            # wrong axis, so we reject anything non-mono outright instead of
            # guessing layout. File-path inputs go through librosa.load,
            # which handles both layouts correctly.
            raise ValueError(
                f"Tuple input must be a 1-D mono ndarray; got shape {y.shape}. "
                "For stereo audio, pass a file path — librosa.load handles "
                "channel-layout downmix correctly on its own."
            )
    else:
        # sr=None preserves native sample rate; mono=True downmixes stereo.
        y, sr = librosa.load(str(audio_path_or_array), sr=None, mono=True)

    duration = float(librosa.get_duration(y=y, sr=sr))

    # ── RMS energy envelope ─────────────────────────────────────────────
    rms = librosa.feature.rms(y=y)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr)

    # ── Spectral centroid ───────────────────────────────────────────────
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    centroid_times = librosa.frames_to_time(np.arange(len(centroid)), sr=sr)

    # ── Onset strength envelope ─────────────────────────────────────────
    onset_strength = librosa.onset.onset_strength(y=y, sr=sr)
    onset_times = librosa.frames_to_time(np.arange(len(onset_strength)), sr=sr)

    # Chroma via STFT — intentional spike choice. The Hijaz spec recommends
    # chroma_cqt for microtonal work, but that lives in the main scaffold;
    # the spike stays on chroma_stft for speed and parity with analyze_tracks.py.
    chroma = librosa.feature.chroma_stft(y=y, sr=sr)
    chroma_times = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=sr)

    return {
        "sr": int(sr),
        "duration": duration,
        "rms": rms,
        "rms_times": rms_times,
        "centroid": centroid,
        "centroid_times": centroid_times,
        "onset_strength": onset_strength,
        "onset_times": onset_times,
        "chroma": chroma,
        "chroma_times": chroma_times,
    }


if __name__ == "__main__":
    # Trivial self-test: synthesize 2s of sine + noise and run extraction.
    # No file I/O, no audio asset required.
    rng = np.random.default_rng(0)
    sr = 22050
    t = np.linspace(0, 2.0, int(sr * 2.0), endpoint=False)
    y = 0.4 * np.sin(2 * np.pi * 440 * t) + 0.05 * rng.standard_normal(len(t))

    ts = extract_timeseries((y.astype(np.float32), sr))

    print("features.py self-test:")
    print(f"  sr             = {ts['sr']}")
    print(f"  duration       = {ts['duration']:.3f}s")
    print(f"  rms shape      = {ts['rms'].shape}")
    print(f"  centroid shape = {ts['centroid'].shape}")
    print(f"  onset shape    = {ts['onset_strength'].shape}")
    print(f"  chroma shape   = {ts['chroma'].shape}  (must be 12 x n_frames)")
    assert ts["chroma"].shape[0] == 12, "chroma must have 12 pitch classes"
    assert ts["sr"] == sr
    assert abs(ts["duration"] - 2.0) < 0.05
    print("  OK")
