You are composing the visual narrative arc for a {{DURATION_S}}s
solo Bayati performance, divided into {{CYCLE_COUNT}} 5-second
cycles. You see the full track in advance: a mel-spectrogram, a
five-panel DSP timeline (RMS / centroid / onset / Hijaz events /
silence), the per-cycle deterministic prose, and the Bayati
visual register reference photos.

### TRACK CORPUS PROSE

{{CORPUS_PROSE_TABLE}}

### PER-CYCLE SCALARS

{{SCALARS_TABLE}}

### EVENT TIMELINE

{{EVENT_TIMELINE_BULLETS}}

### TASK

Compose the arc. Output **only** a single JSON object matching this
schema, no preface, no commentary, no markdown fences:

{{COMPOSITION_PLAN_SCHEMA_DOC}}

Constraints:
- `per_cycle_intent` MUST contain exactly {{CYCLE_COUNT}} entries,
  indexed 0..{{CYCLE_COUNT_MINUS_ONE}} in order. Missing or extra
  entries are validation failures and your response will be rejected.
- `anticipation_offsets_ms` keys are stringified cycle indices;
  values are integers in [-500, 0].
- `overall_arc[*].cycle_range` covers [0, {{CYCLE_COUNT_MINUS_ONE}}]
  contiguously without gaps or overlaps.
- All fields in the schema are required; do not invent extra keys.
- Keep `intent` strings concrete and in the Bayati visual register
  (moonlight on water, open palm in low candlelight, solitary figure,
  loose linen, breath on glass, single feather, head bowed in shadow,
  back at a window at night). Do not propose Hijaz architectural imagery.
