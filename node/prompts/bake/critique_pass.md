You are reviewing your own composition as a critic. Below are all
{{CYCLE_COUNT}} cycles' tool-call decisions you produced, and the
composition plan you wrote.

### COMPOSITION PLAN

{{COMPOSITION_PLAN_JSON}}

### CYCLE DECISIONS

{{CYCLE_DECISIONS_BLOCK}}

### TASK

Identify cycles that feel mechanical, drop coherence, or break the
arc. Output a single JSON object matching this schema; no preface,
no commentary, no markdown fences:

{{CRITIQUE_SCHEMA_DOC}}

Be specific in `issue` and `suggestion`. If nothing is weak, return
`weak_cycles: []` with a `global_notes` paragraph.
