"""
statistics.py — per-file frame-level statistics for adaptive bands.

Computed once per audio file before windowing. Drives the percentile-based
band labels used in summarizer.py (intensity, timbre) and the adaptive
thresholds (silence_threshold, onset_peak_threshold) used in windowing.

Note: onset_density percentiles are NOT computed here — they require
windowed onset_density values, which only exist after Pass 1 of windowing.
That two-pass structure is documented in generate_corpus.py.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict

import numpy as np


@dataclass
class FileStatistics:
    """Per-file frame-level statistics. All values are scalars (float)."""

    # RMS percentiles (energy envelope, 0..1ish)
    rms_p10: float
    rms_p33: float
    rms_p66: float
    rms_p90: float

    # Spectral centroid percentiles (Hz)
    centroid_p10: float
    centroid_p33: float
    centroid_p66: float
    centroid_p90: float

    # Onset strength p90 — used to derive onset_peak_threshold (replaces
    # the older max-based threshold which was vulnerable to one rogue transient).
    onset_strength_p90: float

    # Standard deviations — denominator for normalized trend slope.
    rms_std: float
    centroid_std: float

    # Adaptive thresholds derived from the above. Floors guard against
    # pathologically silent files where percentiles collapse to ~0.
    silence_threshold: float        # max(0.01, 0.5 * rms_p10)
    onset_peak_threshold: float     # max(1e-6, 0.5 * onset_strength_p90)

    def as_dict(self) -> Dict[str, float]:
        return asdict(self)


def compute_file_statistics(timeseries: dict) -> FileStatistics:
    """
    Compute frame-level statistics from a ``features.extract_timeseries`` dict.

    Returns a ``FileStatistics`` with RMS/centroid percentiles, ``rms_std``,
    ``centroid_std``, ``onset_strength_p90``, and the two adaptive thresholds.

    onset_density percentiles are NOT computed here — they need per-window
    aggregates that only exist after Pass 1 of windowing. ``generate_corpus.py``
    builds those separately.
    """
    rms = np.asarray(timeseries["rms"], dtype=np.float64)
    centroid = np.asarray(timeseries["centroid"], dtype=np.float64)
    onset_strength = np.asarray(timeseries["onset_strength"], dtype=np.float64)

    rms_p10, rms_p33, rms_p66, rms_p90 = np.percentile(rms, [10, 33, 66, 90])
    cent_p10, cent_p33, cent_p66, cent_p90 = np.percentile(centroid, [10, 33, 66, 90])
    onset_p90 = float(np.percentile(onset_strength, 90))

    rms_std = float(np.std(rms))
    centroid_std = float(np.std(centroid))

    silence_threshold = max(0.01, 0.5 * float(rms_p10))
    onset_peak_threshold = max(1e-6, 0.5 * onset_p90)

    return FileStatistics(
        rms_p10=float(rms_p10),
        rms_p33=float(rms_p33),
        rms_p66=float(rms_p66),
        rms_p90=float(rms_p90),
        centroid_p10=float(cent_p10),
        centroid_p33=float(cent_p33),
        centroid_p66=float(cent_p66),
        centroid_p90=float(cent_p90),
        onset_strength_p90=onset_p90,
        rms_std=rms_std,
        centroid_std=centroid_std,
        silence_threshold=silence_threshold,
        onset_peak_threshold=onset_peak_threshold,
    )


if __name__ == "__main__":
    # Trivial self-test: build a fake timeseries with known shape and check
    # invariants (monotonic percentiles, threshold floors).
    rng = np.random.default_rng(42)
    fake = {
        "rms": rng.uniform(0.0, 0.5, size=1000),
        "centroid": rng.uniform(200.0, 4000.0, size=1000),
        "onset_strength": rng.uniform(0.0, 1.0, size=500),
    }
    stats = compute_file_statistics(fake)

    print("statistics.py self-test:")
    for k, v in stats.as_dict().items():
        print(f"  {k:<24} = {v:.4f}")

    assert stats.rms_p10 < stats.rms_p33 < stats.rms_p66 < stats.rms_p90, \
        "RMS percentiles must be monotonically increasing"
    assert stats.centroid_p10 < stats.centroid_p33 < stats.centroid_p66 < stats.centroid_p90, \
        "Centroid percentiles must be monotonically increasing"
    assert stats.silence_threshold >= 0.01, "silence_threshold floor must hold"
    assert stats.onset_peak_threshold >= 1e-6, "onset_peak_threshold floor must hold"
    print("  OK")
