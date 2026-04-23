"""
windowing.py — sliding-window snapshot logic.

Defines the canonical windowing parameters for the spike (window width 4 s,
stride 5 s, first snapshot at 5 s, end buffer 0.5 s) and the two helpers used
by ``generate_corpus.py`` to slice frame-level time series into per-cycle
chunks.

The first snapshot fires at T = 5.0 s, summarizing audio from 1.0 s to 5.0 s.
The initial 0.0–1.0 s of the file is intentionally excluded so every cycle
ends on a whole 5-second multiple of the file timeline.
"""

from __future__ import annotations

import numpy as np


# ─── Canonical windowing parameters (locked for the spike) ─────────────────
WINDOW_DURATION_S: float = 4.0      # width of the slice each cycle summarizes
SNAPSHOT_STRIDE_S: float = 5.0      # gap between consecutive snapshot times
SNAPSHOT_START_S: float = 5.0       # first snapshot fires at T = 5.0 s
END_BUFFER_S: float = 0.5           # don't fire a snapshot in the final 0.5 s


def compute_snapshot_times(
    duration: float,
    window: float = WINDOW_DURATION_S,
    stride: float = SNAPSHOT_STRIDE_S,
    start: float = SNAPSHOT_START_S,
    end_buffer: float = END_BUFFER_S,
) -> list[float]:
    """
    Generate the list of snapshot times for an audio file of length ``duration``.

    A snapshot at time T summarizes the window [T - window, T]. The first
    snapshot fires at ``start`` (default 5.0 s); subsequent snapshots step by
    ``stride`` (default 5.0 s). The sequence stops at the last value
    satisfying ``T <= duration - end_buffer``.

    For a 120 s file with defaults: snapshots at 5, 10, 15, ..., 115 → 23 cycles.

    The ``window`` parameter is unused inside this function (snapshots are
    purely time-stride driven), but kept in the signature so the canonical
    windowing parameters travel as one cohesive group.
    """
    del window  # not used here; included in signature for API symmetry
    if duration <= 0:
        return []
    times: list[float] = []
    t = start
    cutoff = duration - end_buffer
    while t <= cutoff + 1e-9:  # tiny epsilon so floating-point exact == cutoff hits
        times.append(round(t, 6))
        t += stride
    return times


def slice_window(
    values: np.ndarray,
    times: np.ndarray,
    snapshot_time: float,
    window: float = WINDOW_DURATION_S,
) -> np.ndarray:
    """
    Return the subset of ``values`` whose corresponding ``times`` fall within
    the closed window ``[snapshot_time - window, snapshot_time]``.

    For ergonomic chained masking by callers that need the times array too,
    use :func:`window_mask` and apply the mask manually.
    """
    return values[window_mask(times, snapshot_time, window)]


def window_mask(
    times: np.ndarray,
    snapshot_time: float,
    window: float = WINDOW_DURATION_S,
) -> np.ndarray:
    """
    Boolean mask selecting ``times`` inside ``[snapshot_time - window, snapshot_time]``.

    Exposed separately so callers needing both the values *and* the times
    inside the window can avoid double-masking.
    """
    window_start = snapshot_time - window
    return (times >= window_start) & (times <= snapshot_time)


if __name__ == "__main__":
    # Trivial self-tests against synthetic numpy arrays. No audio required.

    # ── compute_snapshot_times ────────────────────────────────────────────
    print("windowing.py self-test:")

    t = compute_snapshot_times(120.0)
    assert t[0] == 5.0, f"first snapshot must be at 5.0, got {t[0]}"
    assert t[1] == 10.0, f"second snapshot must be at 10.0, got {t[1]}"
    assert t[-1] == 115.0, f"last snapshot for 120s should be 115.0, got {t[-1]}"
    assert len(t) == 23, f"120s should yield 23 cycles, got {len(t)}"
    print(f"  120s file → {len(t)} cycles, first={t[0]}, last={t[-1]}  OK")

    # 30s file used by Phase 3 synthetic — should yield 5 or 6 cycles
    t30 = compute_snapshot_times(30.0)
    assert 5 <= len(t30) <= 6, f"30s file should yield 5-6 cycles, got {len(t30)}"
    print(f"  30s file → {len(t30)} cycles ({t30})  OK")

    # Edge: duration shorter than start → empty list
    t_short = compute_snapshot_times(3.0)
    assert t_short == [], f"3s file should yield no cycles, got {t_short}"
    print(f"  3s file → {len(t_short)} cycles  OK")

    # ── slice_window ──────────────────────────────────────────────────────
    times = np.linspace(0.0, 10.0, 100)
    values = np.arange(100, dtype=float)

    sliced = slice_window(values, times, snapshot_time=5.0)
    sliced_t = times[window_mask(times, 5.0)]
    assert sliced_t.min() >= 1.0 - 1e-9 and sliced_t.max() <= 5.0 + 1e-9, \
        f"sliced times {sliced_t.min()}..{sliced_t.max()} must be inside [1.0, 5.0]"
    assert len(sliced) == len(sliced_t), "values and times slices must match"
    print(f"  slice_window @ T=5s on 0..10s range → {len(sliced)} samples, "
          f"times in [{sliced_t.min():.3f}, {sliced_t.max():.3f}]  OK")

    print("  windowing.py: ALL OK")
