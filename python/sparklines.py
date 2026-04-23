"""
sparklines.py — Block 3 ASCII sparkline generator.

Each cycle ships three sparklines (rms / onset / centroid), 20 characters wide,
drawn from the eight Unicode block-fill levels ▁▂▃▄▅▆▇█. Each character covers
a 200 ms slice of the 4-second window (4000 ms / 20 = 200 ms per char).

Edge cases are handled explicitly:
- Silent window (max abs value < 1e-6) → 20× ▁
- Flat signal (max == min over bins)   → 20× ▄ (middle char)
"""

from __future__ import annotations

import numpy as np


SPARKLINE_CHARS: str = "▁▂▃▄▅▆▇█"   # 8 levels, indices 0..7
SPARKLINE_WIDTH: int = 20            # characters per sparkline
SILENCE_FLOOR: float = 1e-6          # max(|values|) below this → silent
FLAT_CHAR_INDEX: int = 3             # ▄ — middle level for flat signals


def generate_sparkline(
    values: np.ndarray,
    times: np.ndarray,
    window_start: float,
    window_end: float,
    width: int = SPARKLINE_WIDTH,
) -> str:
    """
    Render ``values`` (sampled at ``times``) as a ``width``-character sparkline
    spanning the time interval ``[window_start, window_end]``.

    Algorithm: divide the window into ``width`` equal time bins, take the mean
    of all frame values whose time falls inside each bin, then min-max normalize
    the per-bin means onto the 0..7 character indices.

    Empty bins (no frames inside) carry forward the previous bin's value to
    avoid harsh dips. The very first bin defaults to 0.0 if empty.
    """
    # Slice to the window of interest
    in_window = (times >= window_start) & (times <= window_end)
    vals = np.asarray(values, dtype=np.float64)[in_window]
    win_times = np.asarray(times, dtype=np.float64)[in_window]

    # Silent window: short-circuit to 20× ▁
    if vals.size == 0 or float(np.max(np.abs(vals))) < SILENCE_FLOOR:
        return SPARKLINE_CHARS[0] * width

    # Bin the window into `width` equal time bins
    bin_edges = np.linspace(window_start, window_end, width + 1)
    bins = np.empty(width, dtype=np.float64)

    last_known = 0.0
    for i in range(width):
        low, high = bin_edges[i], bin_edges[i + 1]
        # Last bin is closed on both ends so endpoint sample doesn't get dropped
        if i < width - 1:
            mask = (win_times >= low) & (win_times < high)
        else:
            mask = (win_times >= low) & (win_times <= high)
        bin_vals = vals[mask]
        if bin_vals.size > 0:
            last_known = float(np.mean(bin_vals))
            bins[i] = last_known
        else:
            bins[i] = last_known

    bin_max = float(np.max(bins))
    bin_min = float(np.min(bins))

    # Flat signal: short-circuit to 20× ▄
    if bin_max == bin_min:
        return SPARKLINE_CHARS[FLAT_CHAR_INDEX] * width

    # Min-max normalize to indices 0..7
    indices = np.round((bins - bin_min) / (bin_max - bin_min) * 7).astype(int)
    indices = np.clip(indices, 0, 7)
    return "".join(SPARKLINE_CHARS[i] for i in indices)


if __name__ == "__main__":
    print("sparklines.py self-test:")

    times = np.linspace(0.0, 4.0, 200)

    # ── Rising signal ─────────────────────────────────────────────────────
    rising = np.linspace(0.0, 1.0, 200)
    s = generate_sparkline(rising, times, 0.0, 4.0)
    print(f"  rising:               '{s}'   (must visually ascend)")
    assert len(s) == 20
    assert s[0] == SPARKLINE_CHARS[0] and s[-1] == SPARKLINE_CHARS[7], \
        f"rising must start at ▁ and end at █, got {s!r}"

    # ── Falling signal ────────────────────────────────────────────────────
    falling = np.linspace(1.0, 0.0, 200)
    s = generate_sparkline(falling, times, 0.0, 4.0)
    print(f"  falling:              '{s}'   (must visually descend)")
    assert s[0] == SPARKLINE_CHARS[7] and s[-1] == SPARKLINE_CHARS[0], \
        f"falling must start at █ and end at ▁, got {s!r}"

    # ── Watch-item: rising-then-falling (triangular envelope) ─────────────
    triangle = np.concatenate([np.linspace(0.0, 1.0, 100), np.linspace(1.0, 0.0, 100)])
    s = generate_sparkline(triangle, times, 0.0, 4.0)
    print(f"  triangle (envelope):  '{s}'   (must show ▁..█..▁ arc)")
    # Peak should land roughly in the middle (index 9 or 10)
    peak_idx = int(np.argmax([SPARKLINE_CHARS.index(c) for c in s]))
    assert 7 <= peak_idx <= 12, \
        f"triangle peak should be near middle (idx 7-12), got idx {peak_idx}"
    assert SPARKLINE_CHARS.index(s[peak_idx]) == 7, \
        f"triangle peak char must be █, got {s[peak_idx]!r}"

    # ── Watch-item: silent window → 20× ▁ ─────────────────────────────────
    silent = np.zeros(200)
    s = generate_sparkline(silent, times, 0.0, 4.0)
    print(f"  silent (all zeros):   '{s}'   (must be 20× ▁)")
    assert s == SPARKLINE_CHARS[0] * 20, f"silent must be 20× ▁, got {s!r}"

    # ── Watch-item: flat non-zero signal → 20× ▄ ──────────────────────────
    flat = np.full(200, 0.5)
    s = generate_sparkline(flat, times, 0.0, 4.0)
    print(f"  flat (all 0.5):       '{s}'   (must be 20× ▄)")
    assert s == SPARKLINE_CHARS[FLAT_CHAR_INDEX] * 20, f"flat must be 20× ▄, got {s!r}"

    # ── Width-20 invariant across all real-shape outputs ──────────────────
    for label, sig in [("rising", rising), ("falling", falling), ("triangle", triangle)]:
        out = generate_sparkline(sig, times, 0.0, 4.0)
        assert len(out) == 20, f"{label} must produce exactly 20 chars, got {len(out)}"
        assert all(c in SPARKLINE_CHARS for c in out), \
            f"{label} sparkline contains a non-block character: {out!r}"

    print("  sparklines.py: ALL OK")
