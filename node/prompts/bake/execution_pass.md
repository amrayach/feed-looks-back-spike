You are placing visual elements for cycle {{CYCLE_INDEX}} of
{{CYCLE_COUNT}} (t={{SNAPSHOT_TIME_S}}s) in the composition you
already planned. Your composition plan is in the system prefix.

Begin your response with a single 1-2 sentence text block stating
your compositional choice for this cycle (this becomes the visible
"rationale" persisted alongside your tool calls; it is NOT private
chain-of-thought). Then make tool calls.

### CURRENT CYCLE

{{CURRENT_CYCLE_BLOCK}}

### RECENT DECISIONS

{{RECENT_DECISIONS_BLOCK}}

### FUTURE PREVIEW

{{FUTURE_PREVIEW_BLOCK}}

### COMPOSITION INTENT FOR THIS CYCLE

Active act: {{ACTIVE_ACT_NAME}} ({{ACTIVE_ACT_INTENT}})
Cycle intent: {{CYCLE_INTENT}}
Energy hint: {{ENERGY_HINT}}

### TASK

Emit tool calls per `tools.json` (in the system prefix). Honor the
audited Bayati visual vocabulary. Do not output anything other than
the rationale text block followed by tool calls.
