"""
summarizer.py — deterministic Block 2 prose generator.

Turns Block 1 numeric values into a single short paragraph following the
template:

    {silence_prefix}{intensity}, {trend}. {timbre} timbre.
    {articulation_clause}. {tonal_center_phrase} {position_phrase}

All band labels and threshold cutoffs live as named module-level constants so
they can be tuned during the calibration pass against real audio without
touching call-site code.

═══════════════════════════════════════════════════════════════════════════
BAND-BOUNDARY CONVENTION (read me before changing cutoffs)
═══════════════════════════════════════════════════════════════════════════
Percentile-driven bands (intensity, timbre, articulation):
    Lower bound INCLUSIVE, upper bound EXCLUSIVE,
    EXCEPT the final band which is INCLUSIVE on both ends (≥ pNN).

    Concretely for intensity on rms_mean against (rms_p33, rms_p66, rms_p90):
        x  <  rms_p33                      → "quiet"
        rms_p33  ≤  x  <  rms_p66          → "moderate intensity"
        rms_p66  ≤  x  <  rms_p90          → "intense"
        x  ≥  rms_p90                      → "peak intensity"

Trend bands on the dimensionless ``normalized_slope``:
    The spec uses mixed operators verbatim; the symmetric "sustained" band
    is INCLUSIVE on both ends:
        s  <  -0.5                         → "falling"
        -0.5  ≤  s  <  -0.15               → "easing"
        -0.15  ≤  s  ≤  0.15               → "sustained"   (symmetric)
        0.15  <  s  ≤  0.5                 → "building"
        s  >  0.5                          → "rising sharply"

Position-in-performance bands on ``elapsed_total_s``: lower inclusive,
upper exclusive (last band is unbounded above).
═══════════════════════════════════════════════════════════════════════════
"""

from __future__ import annotations

from typing import List, Optional, Tuple

import numpy as np

try:
    # Package-context import: when other modules do
    # ``from python.summarizer import generate_prose``.
    from .statistics import FileStatistics
    from .windowing import WINDOW_DURATION_S
except ImportError:
    # Direct execution fallback: ``python python/summarizer.py`` for the
    # self-test. We inject this file's directory on sys.path so the LOCAL
    # statistics.py resolves (not stdlib's `statistics` module). This branch
    # only runs in the self-test path, so the stdlib shadowing is contained.
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from statistics import FileStatistics  # type: ignore[no-redef]  # local file
    from windowing import WINDOW_DURATION_S  # type: ignore[no-redef]


# ─── Band labels ───────────────────────────────────────────────────────────
INTENSITY_LABELS: Tuple[str, str, str, str] = (
    "quiet", "moderate intensity", "intense", "peak intensity",
)
TIMBRE_LABELS: Tuple[str, str, str, str, str] = (
    "dark", "warm", "balanced", "bright", "very bright",
)
ARTICULATION_LABELS: Tuple[str, str, str, str, str] = (
    "very sparse articulation", "sparse articulation", "moderate articulation", "dense articulation", "rapid articulation",
)
TREND_LABELS: Tuple[str, str, str, str, str] = (
    "falling", "easing", "sustained", "building", "rising sharply",
)

# ─── Trend numeric cutoffs (on dimensionless normalized_slope) ─────────────
TREND_FALLING_MAX: float = -0.5     # s <  this           → "falling"
TREND_EASING_MAX: float = -0.15     # s <  this & ≥ above → "easing"
TREND_SUSTAINED_MAX: float = 0.15   # s ≤  this           → "sustained" (sym.)
TREND_BUILDING_MAX: float = 0.5     # s ≤  this           → "building"
                                    # s >  this           → "rising sharply"

# ─── Silence handling ──────────────────────────────────────────────────────
SILENCE_PREFIX_THRESHOLD: float = 0.5     # ≥ this → prepend "Much silence. "
SILENCE_SUFFIX_THRESHOLD: float = 0.2     # ≥ this & < prefix → " with space"
SILENCE_PREFIX_TEXT: str = "Much silence. "
SILENCE_SPACE_SUFFIX_TEXT: str = " with space"

# ─── Position-in-performance bands (absolute time, in seconds) ─────────────
POSITION_BANDS: Tuple[Tuple[float, str], ...] = (
    (20.0,  "Early in the performance, opening territory."),
    (60.0,  "Developing."),
    (120.0, "Mid-performance."),
    (240.0, "Deep into the performance."),
)
POSITION_LATE: str = "Late in the performance."

# ─── Slope normalization floor (avoids div-by-zero on dead-flat files) ─────
SLOPE_STD_FLOOR: float = 1e-8


# ─── Slope and trend ───────────────────────────────────────────────────────
def compute_normalized_slope(
    values: np.ndarray,
    times: np.ndarray,
    file_std: float,
    window_duration_s: float = WINDOW_DURATION_S,
) -> float:
    """
    Compute ``(slope * window_duration_s) / max(file_std, 1e-8)``.

    ``slope`` is the linear-regression slope of ``values`` over ``times``
    (units: value-units per second). Multiplying by the window duration and
    dividing by the file's standard deviation yields a dimensionless number
    on the same scale for RMS and centroid alike, so the trend cutoffs
    (-0.5, -0.15, 0.15, 0.5) apply uniformly.

    Sign convention: rising values over time → POSITIVE slope.
    """
    if len(values) < 2:
        return 0.0
    slope, _intercept = np.polyfit(times, values, 1)
    return float((slope * window_duration_s) / max(file_std, SLOPE_STD_FLOOR))


def categorize_trend(normalized_slope: float) -> str:
    """Map a dimensionless ``normalized_slope`` to one of the 5 trend labels."""
    if normalized_slope < TREND_FALLING_MAX:
        return TREND_LABELS[0]   # "falling"
    if normalized_slope < TREND_EASING_MAX:
        return TREND_LABELS[1]   # "easing"
    if normalized_slope <= TREND_SUSTAINED_MAX:
        return TREND_LABELS[2]   # "sustained"  (symmetric, inclusive both ends)
    if normalized_slope <= TREND_BUILDING_MAX:
        return TREND_LABELS[3]   # "building"
    return TREND_LABELS[4]       # "rising sharply"


# ─── Categorical mappers (intensity, timbre, articulation) ─────────────────
def categorize_intensity(rms_mean: float, stats: FileStatistics) -> str:
    if rms_mean < stats.rms_p33:
        return INTENSITY_LABELS[0]
    if rms_mean < stats.rms_p66:
        return INTENSITY_LABELS[1]
    if rms_mean < stats.rms_p90:
        return INTENSITY_LABELS[2]
    return INTENSITY_LABELS[3]


def categorize_timbre(centroid_mean_hz: float, stats: FileStatistics) -> str:
    if centroid_mean_hz < stats.centroid_p10:
        return TIMBRE_LABELS[0]
    if centroid_mean_hz < stats.centroid_p33:
        return TIMBRE_LABELS[1]
    if centroid_mean_hz < stats.centroid_p66:
        return TIMBRE_LABELS[2]
    if centroid_mean_hz < stats.centroid_p90:
        return TIMBRE_LABELS[3]
    return TIMBRE_LABELS[4]


def categorize_articulation(onset_density: float, density_pcts: dict) -> str:
    """``density_pcts`` is a dict with keys 'p10', 'p33', 'p66', 'p90'."""
    if onset_density < density_pcts["p10"]:
        return ARTICULATION_LABELS[0]
    if onset_density < density_pcts["p33"]:
        return ARTICULATION_LABELS[1]
    if onset_density < density_pcts["p66"]:
        return ARTICULATION_LABELS[2]
    if onset_density < density_pcts["p90"]:
        return ARTICULATION_LABELS[3]
    return ARTICULATION_LABELS[4]


def categorize_position(elapsed_total_s: float) -> str:
    for limit, phrase in POSITION_BANDS:
        if elapsed_total_s < limit:
            return phrase
    return POSITION_LATE


def silence_modifiers(silence_ratio: float) -> Tuple[str, str]:
    """
    Returns ``(prefix, articulation_suffix)`` according to silence_ratio.

    ≥ 0.5 → ("Much silence. ", "")
    ≥ 0.2 → ("", " with space")
    < 0.2 → ("", "")
    """
    if silence_ratio >= SILENCE_PREFIX_THRESHOLD:
        return (SILENCE_PREFIX_TEXT, "")
    if silence_ratio >= SILENCE_SUFFIX_THRESHOLD:
        return ("", SILENCE_SPACE_SUFFIX_TEXT)
    return ("", "")


def tonal_center_phrase(dominant: str, secondary: Optional[str]) -> str:
    if secondary:
        return f"Tonal center {dominant} with secondary emphasis on {secondary}."
    return f"Tonal center {dominant}."


# ─── Hijaz pattern detection (Block 2 enrichment) ──────────────────────────
#
# These detectors operate on the existing block_1_scalars dicts without
# introducing new audio-feature extraction. They turn the rolling pitch-class
# trajectory and silence ratio into named musical events that get appended
# to the deterministic Block 2 prose.
#
# The 2-of-last-3 rule (tonal gravity) requires at least 3 cycles of context;
# with fewer cycles available, classification falls back to ``transitional``.
# This avoids false-positive tahwil signals in the first two cycles of every
# performance.

# Augmented-second pitch classes: chroma_stft labels D# only — Eb is a
# spelling variant of the same pitch class. Treat both as members of the
# lower aug2 endpoint so external dicts using either spelling work.
AUG2_LOWER: frozenset = frozenset({"D#", "Eb"})
AUG2_UPPER: frozenset = frozenset({"F#"})

# Tonal-gravity rolling-window classification thresholds.
TONAL_GRAVITY_WINDOW: int = 3
TONAL_GRAVITY_MAJORITY: int = 2

# Silence-driven phrase-break thresholds (multi-cycle aware — distinct from
# silence_modifiers above, which only inspects the current window).
PHRASE_BREAK_CURRENT_MIN: float = 0.3
PHRASE_BREAK_PREVIOUS_MAX: float = 0.2


def detect_tonal_gravity(current: dict, history: List[dict]) -> str:
    """
    Classify the rolling tonal-gravity state from current cycle + history.

    Returns one of: ``'upper_tonic'``, ``'lower_tonic'``, ``'transitional'``.

    Rule: form a window of the last ``TONAL_GRAVITY_WINDOW`` (3) cycles
    (history + current). If 2 or more have ``pitch_class_dominant == 'G'``
    the state is ``upper_tonic`` (tahwil — gravity on the ghammaz).
    Else if 2 or more are ``'D'`` the state is ``lower_tonic`` (home).
    Otherwise ``transitional``.

    G is checked before D so that ties resolve in favour of upper_tonic
    (this matters when a window has 2 G's and 2 D's, which can never happen
    in a 3-window but would be a defensible default if the window expands).

    With fewer than 3 cycles available (``len(history) < 2``) the function
    returns ``'transitional'`` — there is not enough context to call a
    structural shift on the basis of one or two windows.
    """
    if len(history) < TONAL_GRAVITY_WINDOW - 1:
        return "transitional"
    window = history[-(TONAL_GRAVITY_WINDOW - 1):] + [current]
    dominants = [c.get("pitch_class_dominant") for c in window]
    g_count = sum(1 for d in dominants if d == "G")
    d_count = sum(1 for d in dominants if d == "D")
    if g_count >= TONAL_GRAVITY_MAJORITY:
        return "upper_tonic"
    if d_count >= TONAL_GRAVITY_MAJORITY:
        return "lower_tonic"
    return "transitional"


def detect_aug2(current: dict, history: List[dict]) -> dict:
    """
    Flag the augmented-second interval (Eb↔F#) — the sonic signature of Hijaz.

    Returns a dict with two booleans:

    * ``between_cycles`` — True iff the previous cycle's
      ``pitch_class_dominant`` and the current cycle's together span
      ``AUG2_LOWER`` and ``AUG2_UPPER`` (in either direction). Treats Eb
      and D# as equivalent (chroma_stft only spells D#, but external
      callers may use Eb; both belong to ``AUG2_LOWER``).

    * ``within_window`` — True iff the current cycle's dominant and
      secondary pitch classes themselves span the augmented-second
      interval. Both must be present and refer to *different* pitch
      classes (so ``dom=D#, sec=Eb`` doesn't trigger because they are
      the same class under the equivalence above).

    The two flags are independent: a cycle can fire one, both, or neither.
    """
    dom = current.get("pitch_class_dominant")
    sec = current.get("pitch_class_secondary")

    between_cycles = False
    if history:
        prev_dom = history[-1].get("pitch_class_dominant")
        if (prev_dom in AUG2_LOWER and dom in AUG2_UPPER) or \
           (prev_dom in AUG2_UPPER and dom in AUG2_LOWER):
            between_cycles = True

    within_window = False
    if sec is not None:
        if (dom in AUG2_LOWER and sec in AUG2_UPPER) or \
           (dom in AUG2_UPPER and sec in AUG2_LOWER):
            within_window = True

    return {"between_cycles": between_cycles, "within_window": within_window}


def detect_phrase_break(current: dict, history: List[dict]) -> bool:
    """
    Flag a phrase break — a transition from playing to extended silence.

    Triggers when current ``silence_ratio >= PHRASE_BREAK_CURRENT_MIN`` (0.3)
    AND the most recent prior cycle's was ``< PHRASE_BREAK_PREVIOUS_MAX`` (0.2).

    The asymmetric thresholds (≥ 0.3 for current, < 0.2 for previous) are
    intentional: they create a deliberate gap so a slow drift through the
    0.2-0.3 band cannot trigger the flag, and so an already-quiet stretch
    (e.g. 0.4 → 0.5) does not re-trigger every cycle. Sustained silence
    fires the flag exactly once at the entry.
    """
    if not history:
        return False
    current_silence = float(current.get("silence_ratio", 0.0))
    prev_silence = float(history[-1].get("silence_ratio", 0.0))
    return (current_silence >= PHRASE_BREAK_CURRENT_MIN
            and prev_silence < PHRASE_BREAK_PREVIOUS_MAX)


# ─── Hijaz clause selection (state-transition logic) ──────────────────────
# Block 2 enrichment clauses used by ``generate_prose``. Stored as named
# constants so the prose remains a one-line edit during a future
# calibration pass.
TAHWIL_FIRST_TIME: str = "Tahwil: tonal gravity has shifted to the ghammaz."
TAHWIL_SUSTAINED: str = "Sustained on ghammaz; upper jins active."
RETURNING_CLAUSE: str = "Returning motion toward the tonic."
GROUNDED_CLAUSE: str = "Grounded in lower jins."
AMBIGUOUS_CLAUSE: str = "Tonal gravity ambiguous."
AUG2_BETWEEN_CLAUSE: str = "Augmented-second interval crossed between phrases."
AUG2_WITHIN_CLAUSE: str = "Augmented-second interval present in this phrase."
PHRASE_BREAK_CLAUSE: str = "Phrase break."

# Approximate token budget for the assembled prose. Whitespace-split is a
# rough proxy for BPE tokens (real BPE will produce slightly more), but a
# 120-word ceiling keeps Block 2 well under any reasonable model token
# budget while leaving the deterministic core intact.
MAX_PROSE_TOKENS: int = 120


def _history_state_at(history: List[dict], idx: int) -> str:
    """
    Classify the tonal-gravity state of a prior cycle already inside history.

    ``idx`` is a zero-based index into ``history``. The cycle at ``history[idx]``
    is treated as the current cycle for that evaluation, and all earlier
    elements of ``history`` become its prior context. This lets the clause
    selector reason about true state transitions (previous cycle, previous two
    cycles) instead of falling back to dominant-note heuristics.

    If the index is out of range, or there is not enough prior context to make
    a 3-cycle tonal-gravity call, the result is ``'transitional'``.
    """
    if idx < 0 or idx >= len(history):
        return "transitional"
    return detect_tonal_gravity(history[idx], history[:idx])


def _select_tonal_gravity_clause(
    current: dict,
    history: List[dict],
) -> Optional[str]:
    """
    Pick the tonal-gravity clause to append, applying prompt-faithful
    state-transition rules.

    Returns:
      * upper_tonic with previous state upper_tonic:       SUSTAINED
      * upper_tonic otherwise:                             FIRST-TIME tahwil
      * lower_tonic after previous state upper_tonic:      RETURNING
      * lower_tonic after two prior lower_tonic states:    None (suppress)
      * lower_tonic otherwise:                             GROUNDED
      * transitional:                                      None (suppress)

    The transitional branch returns ``None`` so cycles with no Hijaz event
    keep their prose generic. The contrast between cycles that lead with a
    Hijaz clause and cycles that don't is itself meaningful and is what
    drives the calibration policy. ``AMBIGUOUS_CLAUSE`` is retained as a
    named constant in case it is brought back during a future tuning pass.

    Exact returning/suppression decisions require more than the minimum
    2-cycle history used by ``detect_tonal_gravity`` alone, because we must
    classify the immediately previous state (and, for suppression, the state
    before that) using their own rolling 3-cycle windows.
    """
    state = detect_tonal_gravity(current, history)
    prev_state = _history_state_at(history, len(history) - 1)
    prev2_state = _history_state_at(history, len(history) - 2)

    if state == "upper_tonic":
        return TAHWIL_SUSTAINED if prev_state == "upper_tonic" else TAHWIL_FIRST_TIME

    if state == "lower_tonic":
        if prev_state == "upper_tonic":
            return RETURNING_CLAUSE
        if prev_state == "lower_tonic" and prev2_state == "lower_tonic":
            return None  # suppress
        return GROUNDED_CLAUSE

    return None  # transitional → suppressed (no Hijaz clause)


def _select_aug2_clause(current: dict, history: List[dict]) -> Optional[str]:
    """Pick the aug2 clause; between-cycles takes precedence over within-window."""
    flags = detect_aug2(current, history)
    if flags["between_cycles"]:
        return AUG2_BETWEEN_CLAUSE
    if flags["within_window"]:
        return AUG2_WITHIN_CLAUSE
    return None


def _approx_token_count(text: str) -> int:
    """Whitespace-split word count as a rough BPE-token proxy."""
    return len(text.split())


def _trim_to_budget(
    silence_prefix: str,
    base_without_silence: str,
    tonal_clause: Optional[str],
    aug2_clause: Optional[str],
    phrase_break_clause: Optional[str],
    max_tokens: int = MAX_PROSE_TOKENS,
) -> str:
    """
    Assemble silence_prefix + hijaz_prefix + base_without_silence respecting
    the token budget.

    Hijaz clauses (tonal + aug2 + phrase_break) LEAD the base prose so Opus
    sees the musical event before the generic descriptor. The silence prefix
    (when present) precedes the Hijaz prefix:

        {silence_prefix}{hijaz_prefix}{base_without_silence}

    Drop priority (lowest first): grounded → phrase-break → tahwil → aug2.
    The silence prefix and the deterministic core (base_without_silence)
    are never trimmed.

    The ``GROUNDED_CLAUSE`` is treated as the lowest-value tonal-gravity
    clause; other tonal-gravity clauses (tahwil, returning, sustained) are
    bundled under "tahwil" for trimming.
    """
    is_grounded = tonal_clause == GROUNDED_CLAUSE

    # Build (tag, clause) tuples in HIGH-to-LOW priority order for trim.
    ordered: List[Tuple[str, str]] = []
    if aug2_clause:
        ordered.append(("aug2", aug2_clause))
    if tonal_clause and not is_grounded:
        ordered.append(("tahwil", tonal_clause))
    if phrase_break_clause:
        ordered.append(("phrase_break", phrase_break_clause))
    if is_grounded and tonal_clause is not None:
        ordered.append(("grounded", tonal_clause))

    # OUTPUT order inside hijaz_prefix: tonal_gravity → aug2 → phrase_break.
    # The whole hijaz_prefix LEADS the base prose (post-silence).
    def render(active: set) -> str:
        hijaz_parts: List[str] = []
        if tonal_clause and (("tahwil" in active and not is_grounded)
                             or ("grounded" in active and is_grounded)):
            hijaz_parts.append(tonal_clause)
        if aug2_clause and "aug2" in active:
            hijaz_parts.append(aug2_clause)
        if phrase_break_clause and "phrase_break" in active:
            hijaz_parts.append(phrase_break_clause)

        hijaz_prefix = (" ".join(hijaz_parts) + " ") if hijaz_parts else ""
        return f"{silence_prefix}{hijaz_prefix}{base_without_silence}"

    active = {tag for tag, _ in ordered}
    text = render(active)

    # Drop from the END of the priority list (lowest priority) until under budget.
    for tag, _ in reversed(ordered):
        if _approx_token_count(text) <= max_tokens:
            break
        active.discard(tag)
        text = render(active)

    return text


# ─── Top-level prose assembly ──────────────────────────────────────────────
def _capitalize_lead(s: str) -> str:
    """
    Uppercase only the first character; preserve the rest.

    Used at sentence-leading slots in the prose template. We don't use
    ``str.capitalize()`` because that lowercases the rest of the string,
    which would mangle any label that ever contains a proper noun or
    intentional internal capitalization.
    """
    return s[:1].upper() + s[1:] if s else s


def generate_prose(
    block_1: dict,
    file_stats: FileStatistics,
    density_pcts: dict,
    history_context: Optional[List[dict]] = None,
) -> str:
    """
    Assemble a single Block 2 string from the given Block 1 numeric dict,
    file-level percentile stats, and onset-density percentile dict.

    Template (single line):
        {silence_prefix}{hijaz_prefix}{intensity}, {trend}. {timbre} timbre.
        {articulation_clause}. {tonal_center_phrase} {position_phrase}

    where ``{hijaz_prefix}`` is one or more of
    ``[{tonal_gravity_clause}] [{aug2_clause}] [{phrase_break_clause}]`` —
    appended only when the corresponding pattern is detected from the
    rolling ``history_context``. If no Hijaz event fires (transitional
    state with no aug2 or phrase break) the prefix is empty and the prose
    is fully generic — the contrast between Hijaz-leading cycles and
    generic cycles is itself information for downstream readers.

    The deterministic core (intensity / timbre / articulation /
    tonal-center / position) is the Phase 2 contract. The Phase 3 Hijaz
    enrichment now LEADS the prose (rather than trailing as in earlier
    revisions) so Opus reads the musical event before the generic
    descriptor.

    Labels are stored lowercase in the constants tuples (because ``trend``
    appears mid-sentence after a comma where lowercase is correct). At the
    three sentence-leading positions — ``intensity`` (post-prefix),
    ``timbre``, and ``articulation_clause`` — we capitalize the first
    character at use site so the prose is grammatical English.

    With ``history_context=None`` (or empty) no Hijaz clauses fire — the
    transitional branch is suppressed (AMBIGUOUS is no longer emitted),
    so cycles 0/1 and callers that don't thread history through receive
    fully generic prose.

    If the assembled prose exceeds ``MAX_PROSE_TOKENS`` the enrichment
    clauses are dropped in priority order (grounded < phrase_break <
    tahwil < aug2). The silence prefix and deterministic core are never
    trimmed.
    """
    intensity = categorize_intensity(block_1["rms_mean"], file_stats)
    trend = block_1["rms_trend"]   # already a label, computed upstream
    timbre = categorize_timbre(block_1["centroid_mean_hz"], file_stats)
    articulation = categorize_articulation(block_1["onset_density"], density_pcts)

    silence_prefix, silence_suffix = silence_modifiers(block_1["silence_ratio"])
    articulation_clause = articulation + silence_suffix

    tcp = tonal_center_phrase(
        block_1["pitch_class_dominant"],
        block_1.get("pitch_class_secondary"),
    )
    position = categorize_position(block_1["elapsed_total_s"])

    base_without_silence = (
        f"{_capitalize_lead(intensity)}, {trend}. "
        f"{_capitalize_lead(timbre)} timbre. "
        f"{_capitalize_lead(articulation_clause)}. "
        f"{tcp} {position}"
    )

    history = history_context or []
    tonal_clause = _select_tonal_gravity_clause(block_1, history)
    aug2_clause = _select_aug2_clause(block_1, history)
    phrase_break_clause = (
        PHRASE_BREAK_CLAUSE if detect_phrase_break(block_1, history) else None
    )

    return _trim_to_budget(
        silence_prefix, base_without_silence,
        tonal_clause, aug2_clause, phrase_break_clause,
    )


if __name__ == "__main__":
    # ── Synthetic FileStatistics for the self-tests ────────────────────────
    fake_stats = FileStatistics(
        rms_p10=0.02, rms_p33=0.05, rms_p66=0.10, rms_p90=0.20,
        centroid_p10=600, centroid_p33=1000, centroid_p66=1500, centroid_p90=2200,
        onset_strength_p90=0.5,
        rms_std=0.05, centroid_std=400,
        silence_threshold=0.01, onset_peak_threshold=0.25,
    )
    fake_density = {"p10": 0.25, "p33": 0.75, "p66": 1.5, "p90": 3.0}

    print("summarizer.py self-test:")

    # ── Watch-item: normalized-slope sign on rising / falling / flat ──────
    t = np.linspace(0.0, 4.0, 40)

    rising = np.linspace(0.05, 0.40, 40)
    falling = np.linspace(0.40, 0.05, 40)
    flat = np.full_like(t, 0.20)

    s_rising = compute_normalized_slope(rising, t, fake_stats.rms_std)
    s_falling = compute_normalized_slope(falling, t, fake_stats.rms_std)
    s_flat = compute_normalized_slope(flat, t, fake_stats.rms_std)
    print(f"  slope rising  = {s_rising:+.4f}  (must be POSITIVE)")
    print(f"  slope falling = {s_falling:+.4f}  (must be NEGATIVE)")
    print(f"  slope flat    = {s_flat:+.4f}  (must be ~0)")
    assert s_rising > 0.5, f"rising slope must be positive and large, got {s_rising}"
    assert s_falling < -0.5, f"falling slope must be negative and large, got {s_falling}"
    assert abs(s_flat) < 1e-6, f"flat slope must be ~0, got {s_flat}"

    # ── Watch-item: categorize_trend at exact band boundaries ─────────────
    boundary_cases = [
        (-0.6,  "falling"),
        (-0.5,  "easing"),         # left-inclusive
        (-0.3,  "easing"),
        (-0.15, "sustained"),      # symmetric inclusive
        ( 0.0,  "sustained"),
        ( 0.15, "sustained"),      # symmetric inclusive
        ( 0.3,  "building"),
        ( 0.5,  "building"),       # right-inclusive
        ( 0.6,  "rising sharply"),
    ]
    print("  trend boundary table:")
    for s, expected in boundary_cases:
        actual = categorize_trend(s)
        ok = "OK " if actual == expected else "FAIL"
        print(f"    {ok}  s={s:+.2f} → {actual!r} (expected {expected!r})")
        assert actual == expected, f"boundary {s} expected {expected}, got {actual}"

    # ── Watch-item: three distinct prose strings, exact template ──────────
    case_a = {
        "rms_mean": 0.03, "rms_trend": "sustained",
        "centroid_mean_hz": 500,
        "onset_density": 0.10,
        "silence_ratio": 0.05,
        "elapsed_total_s": 5.0,
        "pitch_class_dominant": "G", "pitch_class_secondary": None,
    }
    case_b = {
        "rms_mean": 0.30, "rms_trend": "rising sharply",
        "centroid_mean_hz": 2400,
        "onset_density": 4.0,
        "silence_ratio": 0.0,
        "elapsed_total_s": 45.0,
        "pitch_class_dominant": "D", "pitch_class_secondary": "F#",
    }
    case_c = {
        "rms_mean": 0.04, "rms_trend": "easing",
        "centroid_mean_hz": 800,
        "onset_density": 0.10,
        "silence_ratio": 0.6,            # triggers prefix
        "elapsed_total_s": 90.0,
        "pitch_class_dominant": "A", "pitch_class_secondary": None,
    }
    case_d = {
        "rms_mean": 0.07, "rms_trend": "building",
        "centroid_mean_hz": 1200,
        "onset_density": 0.5,
        "silence_ratio": 0.3,            # triggers " with space" suffix
        "elapsed_total_s": 130.0,
        "pitch_class_dominant": "E", "pitch_class_secondary": "B",
    }

    print("  prose samples:")
    for label, case in [("A", case_a), ("B", case_b), ("C", case_c), ("D", case_d)]:
        prose = generate_prose(case, fake_stats, fake_density)
        print(f"    [{label}] {prose}")

    # Spot-check exact phrases (not the whole string — that's user-visible above)
    assert generate_prose(case_a, fake_stats, fake_density).startswith("Quiet, sustained."), \
        "case A must lead with capitalized 'Quiet'"
    assert "Tonal center D with secondary emphasis on F#." in generate_prose(case_b, fake_stats, fake_density)
    assert generate_prose(case_c, fake_stats, fake_density).startswith("Much silence. Quiet, easing."), \
        "case C must capitalize the second sentence after 'Much silence. '"
    assert " with space." in generate_prose(case_d, fake_stats, fake_density)
    assert generate_prose(case_d, fake_stats, fake_density).startswith("Moderate intensity, building."), \
        "case D must lead with capitalized 'Moderate intensity'"

    # ── Hijaz pattern detection — detect_tonal_gravity ────────────────────
    print("  detect_tonal_gravity:")

    def _pcd(letter):  # tiny helper for readable test fixtures
        return {"pitch_class_dominant": letter}

    # upper_tonic trigger: 2 of last 3 are G (current G, history [G, G])
    state = detect_tonal_gravity(_pcd("G"), [_pcd("G"), _pcd("G")])
    assert state == "upper_tonic", f"GGG must be upper_tonic, got {state}"
    print(f"    OK   (G,G,G) → {state}")

    # upper_tonic with mixed but 2/3 G: history [D, G], current G
    state = detect_tonal_gravity(_pcd("G"), [_pcd("D"), _pcd("G")])
    assert state == "upper_tonic", f"(D,G,G) must be upper_tonic, got {state}"
    print(f"    OK   (D,G,G) → {state}")

    # lower_tonic trigger: 2 of last 3 are D (current D, history [D, D])
    state = detect_tonal_gravity(_pcd("D"), [_pcd("D"), _pcd("D")])
    assert state == "lower_tonic", f"DDD must be lower_tonic, got {state}"
    print(f"    OK   (D,D,D) → {state}")

    # transitional: mixed without 2/3 majority on G or D
    state = detect_tonal_gravity(_pcd("A"), [_pcd("F#"), _pcd("E")])
    assert state == "transitional", f"mixed must be transitional, got {state}"
    print(f"    OK   (F#,E,A) → {state}")

    # First-cycle edge case: empty history → transitional (not enough data)
    state = detect_tonal_gravity(_pcd("G"), [])
    assert state == "transitional", f"empty history must be transitional, got {state}"
    print(f"    OK   (—, —, G) → {state}")

    # Single-history-item edge case: only 2 cycles total → transitional
    state = detect_tonal_gravity(_pcd("G"), [_pcd("G")])
    assert state == "transitional", f"len-1 history must be transitional, got {state}"
    print(f"    OK   (—, G, G) → {state}")

    # Tie between G and D where 2/3 G wins (G priority per spec ordering)
    state = detect_tonal_gravity(_pcd("G"), [_pcd("G"), _pcd("D")])
    assert state == "upper_tonic", f"(G,D,G) must prefer upper_tonic, got {state}"
    print(f"    OK   (G,D,G) → {state}")

    # ── Hijaz pattern detection — detect_aug2 ─────────────────────────────
    print("  detect_aug2:")

    def _aug(dom, sec=None):  # tiny fixture helper
        return {"pitch_class_dominant": dom, "pitch_class_secondary": sec}

    # Between-cycles: D# → F#
    flags = detect_aug2(_aug("F#"), [_aug("D"), _aug("D#")])
    assert flags["between_cycles"] is True and flags["within_window"] is False, \
        f"D#→F# must trigger between_cycles, got {flags}"
    print(f"    OK   D#→F# → {flags}")

    # Between-cycles: F# → D# (vice versa)
    flags = detect_aug2(_aug("D#"), [_aug("D"), _aug("F#")])
    assert flags["between_cycles"] is True and flags["within_window"] is False, \
        f"F#→D# must trigger between_cycles, got {flags}"
    print(f"    OK   F#→D# → {flags}")

    # Eb/D# equivalence: Eb → F# treated same as D# → F#
    flags = detect_aug2(_aug("F#"), [_aug("D"), _aug("Eb")])
    assert flags["between_cycles"] is True, \
        f"Eb→F# must trigger between_cycles (Eb≡D#), got {flags}"
    print(f"    OK   Eb→F# (Eb≡D#) → {flags}")

    # Within-window: dom D#, sec F# (different & both in aug2 set)
    flags = detect_aug2(_aug("D#", "F#"), [])
    assert flags["within_window"] is True, \
        f"D#+F# within window must trigger, got {flags}"
    print(f"    OK   dom=D# sec=F# → {flags}")

    # Within-window: dom F#, sec D# (other direction)
    flags = detect_aug2(_aug("F#", "D#"), [])
    assert flags["within_window"] is True, \
        f"F#+D# within window must trigger, got {flags}"
    print(f"    OK   dom=F# sec=D# → {flags}")

    # Within-window with Eb: dom Eb, sec F#
    flags = detect_aug2(_aug("Eb", "F#"), [])
    assert flags["within_window"] is True, \
        f"Eb+F# within window must trigger (Eb≡D#), got {flags}"
    print(f"    OK   dom=Eb sec=F# → {flags}")

    # No aug2: D and A — neither in aug2 sets
    flags = detect_aug2(_aug("A"), [_aug("D"), _aug("D")])
    assert flags["between_cycles"] is False and flags["within_window"] is False, \
        f"D…A must not trigger any aug2, got {flags}"
    print(f"    OK   D,D,A (no aug2) → {flags}")

    # Within-window with same pitch class twice should NOT trigger (must differ)
    flags = detect_aug2(_aug("D#", "D#"), [])
    assert flags["within_window"] is False, \
        f"D#+D# (same class) must not trigger within_window, got {flags}"
    print(f"    OK   dom=D# sec=D# → {flags}")

    # Empty history → between_cycles is False but within_window can still fire
    flags = detect_aug2(_aug("D#", "F#"), [])
    assert flags["between_cycles"] is False and flags["within_window"] is True, \
        f"empty history with D#+F# must give within only, got {flags}"
    print(f"    OK   empty history dom=D# sec=F# → {flags}")

    # Both can fire simultaneously: prev D#, current F# with secondary D#
    flags = detect_aug2(_aug("F#", "D#"), [_aug("D"), _aug("D#")])
    assert flags["between_cycles"] is True and flags["within_window"] is True, \
        f"both flags must be possible, got {flags}"
    print(f"    OK   D#→F# with D# sec → {flags}")

    # ── Hijaz pattern detection — detect_phrase_break ────────────────────
    print("  detect_phrase_break:")

    def _sil(ratio):  # tiny fixture helper
        return {"silence_ratio": ratio}

    # Trigger: silence transition 0.1 → 0.4 (playing → quiet)
    pb = detect_phrase_break(_sil(0.4), [_sil(0.1)])
    assert pb is True, f"0.1→0.4 must trigger phrase break, got {pb}"
    print(f"    OK   0.1→0.4 → {pb}")

    # No trigger: no transition (0.1 → 0.1)
    pb = detect_phrase_break(_sil(0.1), [_sil(0.1)])
    assert pb is False, f"0.1→0.1 must NOT trigger, got {pb}"
    print(f"    OK   0.1→0.1 → {pb}")

    # No trigger: silence already high (0.4 → 0.5 — prev was NOT < 0.2)
    pb = detect_phrase_break(_sil(0.5), [_sil(0.4)])
    assert pb is False, f"0.4→0.5 must NOT trigger (already high), got {pb}"
    print(f"    OK   0.4→0.5 → {pb}")

    # Empty history → never triggers (no prev to compare)
    pb = detect_phrase_break(_sil(0.5), [])
    assert pb is False, f"empty history must NOT trigger, got {pb}"
    print(f"    OK   (—)→0.5 → {pb}")

    # Boundary: prev = 0.19 (< 0.2 ok), current = 0.3 (≥ 0.3 ok) → triggers
    pb = detect_phrase_break(_sil(0.3), [_sil(0.19)])
    assert pb is True, f"0.19→0.3 boundary must trigger, got {pb}"
    print(f"    OK   0.19→0.3 → {pb}")

    # Boundary: prev = 0.2 exactly (NOT < 0.2 per spec), current = 0.3 → no trigger
    pb = detect_phrase_break(_sil(0.3), [_sil(0.2)])
    assert pb is False, f"0.2→0.3 must NOT trigger (prev not < 0.2), got {pb}"
    print(f"    OK   0.2→0.3 → {pb}")

    # Boundary: current = 0.29 (NOT ≥ 0.3) → no trigger
    pb = detect_phrase_break(_sil(0.29), [_sil(0.05)])
    assert pb is False, f"0.05→0.29 must NOT trigger (current < 0.3), got {pb}"
    print(f"    OK   0.05→0.29 → {pb}")

    # ── generate_prose with history_context (integration tests) ───────────
    print("  generate_prose with history_context:")

    def _full_block(dom, sec=None, sil=0.0):
        return {
            "rms_mean": 0.07,
            "rms_trend": "building",
            "centroid_mean_hz": 1200,
            "onset_density": 0.5,
            "silence_ratio": sil,
            "elapsed_total_s": 30.0,
            "pitch_class_dominant": dom,
            "pitch_class_secondary": sec,
        }

    # Cycle 0 (empty history) → transitional → AMBIGUOUS suppressed; generic prose only
    p = generate_prose(_full_block("D"), fake_stats, fake_density, history_context=[])
    assert "Tonal gravity ambiguous." not in p, \
        f"empty history must NOT include ambiguous tag (suppressed), got: {p!r}"
    assert p.startswith("Moderate intensity, building."), \
        f"empty history must lead with generic prose (no Hijaz prefix), got: {p!r}"
    print(f"    OK   cycle 0 → generic prose, no ambiguous")

    # (A, D, G, G, G) → current upper_tonic, previous state upper_tonic → sustained
    history = [_full_block("A"), _full_block("D"), _full_block("G"), _full_block("G")]
    p = generate_prose(_full_block("G"), fake_stats, fake_density, history_context=history)
    assert "Sustained on ghammaz; upper jins active." in p, \
        f"(A,D,G,G,G) must yield sustained-ghammaz clause, got: {p!r}"
    print(f"    OK   (A,D,G,G,G) → sustained")

    # (A, D, D, G, G) → current upper_tonic, previous state lower_tonic → first-time tahwil
    history = [_full_block("A"), _full_block("D"), _full_block("D"), _full_block("G")]
    p = generate_prose(_full_block("G"), fake_stats, fake_density, history_context=history)
    assert "Tahwil: tonal gravity has shifted to the ghammaz." in p, \
        f"(A,D,D,G,G) must yield tahwil first-time, got: {p!r}"
    print(f"    OK   (A,D,D,G,G) → tahwil first-time")

    # (A, G, G, D, D) → current lower_tonic, previous state upper_tonic → "Returning motion"
    history = [_full_block("A"), _full_block("G"), _full_block("G"), _full_block("D")]
    p = generate_prose(_full_block("D"), fake_stats, fake_density, history_context=history)
    assert "Returning motion toward the tonic." in p, \
        f"(A,G,G,D,D) must yield returning, got: {p!r}"
    print(f"    OK   (A,G,G,D,D) → returning")

    # (A, A, D, D, D) → previous state lower_tonic, state before transitional → grounded
    history = [_full_block("A"), _full_block("A"), _full_block("D"), _full_block("D")]
    p = generate_prose(_full_block("D"), fake_stats, fake_density, history_context=history)
    assert "Grounded in lower jins." in p, \
        f"(A,A,D,D,D) must yield grounded clause, got: {p!r}"
    print(f"    OK   (A,A,D,D,D) → grounded")

    # (A, D, D, D, D) → lower_tonic and prior 2 cycles already lower_tonic → suppress grounded
    history = [_full_block("A"), _full_block("D"), _full_block("D"), _full_block("D")]
    p = generate_prose(_full_block("D"), fake_stats, fake_density, history_context=history)
    assert "Grounded in lower jins." not in p, \
        f"(A,D,D,D,D) must suppress grounded (avoid repetition), got: {p!r}"
    assert "Tonal gravity ambiguous." not in p, \
        f"(A,D,D,D,D) is lower_tonic, not transitional, got: {p!r}"
    assert "Returning motion toward the tonic." not in p, \
        f"(A,D,D,D,D) must not be misread as returning, got: {p!r}"
    print(f"    OK   (A,D,D,D,D) → grounded suppressed")

    # Aug2 within window: dom F#, sec D# → "present in this phrase"
    p = generate_prose(_full_block("F#", "D#"), fake_stats, fake_density, history_context=[])
    assert "Augmented-second interval present in this phrase." in p, \
        f"F#+D# must add within-window aug2 clause, got: {p!r}"
    print(f"    OK   F# + D# within window → aug2 'present'")

    # Aug2 between cycles: prev D# → current F# → "crossed between phrases"
    history = [_full_block("D"), _full_block("D#")]
    p = generate_prose(_full_block("F#"), fake_stats, fake_density, history_context=history)
    assert "Augmented-second interval crossed between phrases." in p, \
        f"D#→F# must add between-cycles aug2 clause, got: {p!r}"
    # Spec: between dominates if both flags set; here only between fires (no sec)
    print(f"    OK   D#→F# between → aug2 'crossed'")

    # Phrase break: prev silence 0.1 → current 0.4 → "Phrase break."
    history = [_full_block("D", sil=0.1)]
    p = generate_prose(_full_block("D", sil=0.4), fake_stats, fake_density, history_context=history)
    assert "Phrase break." in p, \
        f"silence transition must add phrase-break clause, got: {p!r}"
    print(f"    OK   silence 0.1→0.4 → phrase break")

    # All clauses: aug2 between + phrase break + tahwil — preserved in spec order
    history = [_full_block("D", sil=0.05), _full_block("D#", sil=0.1)]
    current = _full_block("F#", "D", sil=0.4)
    # Force F# in history would change tonal-gravity classification; simpler check:
    p = generate_prose(current, fake_stats, fake_density, history_context=history)
    assert "Augmented-second interval crossed between phrases." in p
    assert "Phrase break." in p
    # Order check: aug2 must precede phrase break in the output
    aug2_pos = p.index("Augmented-second")
    pb_pos = p.index("Phrase break.")
    assert aug2_pos < pb_pos, \
        f"aug2 clause must precede phrase break, got: {p!r}"
    print(f"    OK   multi-clause order preserved (aug2 < phrase_break)")

    # Backward compatibility: omitting history_context still works (no Hijaz prefix)
    p = generate_prose(_full_block("D"), fake_stats, fake_density)
    assert "Tonal gravity ambiguous." not in p, \
        f"omitted history_context must NOT include ambiguous tag (suppressed), got: {p!r}"
    assert p.startswith("Moderate intensity, building."), \
        f"omitted history_context must lead with generic prose, got: {p!r}"
    print(f"    OK   omitted history_context defaults to empty (no ambiguous)")

    # ── Front-load ordering tests (rev. 4: Hijaz clauses LEAD the prose) ──
    print("  Hijaz prefix ordering (front-loaded):")

    # Test F1: no history / no event → no Hijaz prefix at all, no AMBIGUOUS
    p = generate_prose(_full_block("A"), fake_stats, fake_density, history_context=[])
    assert "Tahwil" not in p and "Augmented-second" not in p \
        and "Phrase break." not in p and "Tonal gravity ambiguous." not in p, \
        f"no-event cycle must have NO Hijaz prefix, got: {p!r}"
    print(f"    OK   no event → no Hijaz prefix")

    # Test F2: phrase break only → "Phrase break. " leads the post-silence portion
    history = [_full_block("A", sil=0.05)]
    p = generate_prose(_full_block("A", sil=0.4), fake_stats, fake_density, history_context=history)
    assert p.startswith("Phrase break. "), \
        f"phrase break only must LEAD the prose, got: {p!r}"
    print(f"    OK   phrase break only → leads prose")

    # Test F3: tahwil + aug2 (within-window) → tahwil before aug2, both before generic prose
    # history=[G, G], current=F# with sec=D# → upper_tonic (window has 2 G's), prev transitional
    # → first-time tahwil; aug2 within_window also fires (dom=F# upper, sec=D# lower)
    history = [_full_block("G"), _full_block("G")]
    p = generate_prose(_full_block("F#", "D#"), fake_stats, fake_density, history_context=history)
    tahwil_pos = p.find("Tahwil:")
    aug2_pos = p.find("Augmented-second")
    moderate_pos = p.find("Moderate intensity")
    assert tahwil_pos == 0, f"tahwil must LEAD the prose, got pos {tahwil_pos}: {p!r}"
    assert tahwil_pos < aug2_pos < moderate_pos, \
        f"order must be tahwil < aug2 < generic, got positions " \
        f"{tahwil_pos}/{aug2_pos}/{moderate_pos}: {p!r}"
    print(f"    OK   tahwil + aug2 → tahwil leads, aug2 follows, both before generic")

    # Test F4: silence + tahwil → "Much silence. Tahwil: ..."
    # history=[D, G], current=G with sil=0.6 → upper_tonic, prev transitional → first-time tahwil
    history = [_full_block("D"), _full_block("G")]
    p = generate_prose(_full_block("G", sil=0.6), fake_stats, fake_density, history_context=history)
    assert p.startswith("Much silence. Tahwil:"), \
        f"silence + tahwil must read 'Much silence. Tahwil:...', got: {p!r}"
    print(f"    OK   silence + tahwil → 'Much silence. Tahwil:...'")

    print("  summarizer.py: ALL OK")
