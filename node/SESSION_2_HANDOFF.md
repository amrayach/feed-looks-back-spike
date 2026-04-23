# Feed Looks Back — Session 2 Handoff

**Date:** 2026-04-23  
**Status:** Phase 1 and Phase 2 complete, patched, and verified. Ready to bootstrap Phase 3 in a fresh session.

> Read this file and `~/Work/feed-looks-back-spike/SESSION_1_HANDOFF.md` together. This document supersedes the earlier `SESSION_2_PHASE_1_HANDOFF.md` by folding in completed Phase 2 work and the pre-Phase-3 error-handling patch.

---

## TL;DR

Session 1 produced the calibrated 31-cycle Bashar corpus under `~/Work/feed-looks-back-spike/corpus/`. Session 2 Phase 1 built the Node runner scaffold, prompt/config files, Anthropic SDK wrapper, packet builder, and dry-run CLI. Before Phase 2 started, Config A was upgraded from the placeholder-oriented `v3` contract to `v4`, meaning Opus now writes real `svg_markup` and real `css_background` values that flow verbatim through scene state and will be rendered directly in Phase 3.

Phase 2 then added the scene-state layer, tool dispatcher, dry-run synthetic state threading, and the real API code path in `run_spike.mjs` without spending credits. After Phase 2, an additional hardening patch landed in `run_spike.mjs` so a real run no longer crashes on the first API / parse / persistence error; each cycle now resolves to one of five statuses: `ok`, `api_failure`, `response_parse_failure`, `persistence_failure`, or `tool_call_errors`.

Fresh verification state:

- Phase 2 dry-run with threaded scene state: `output/run_20260423_031654/`
- Post-hardening dry-run: `output/run_20260423_033951/`
- `run_spike.mjs --self-test` passes `2/2`
- `node src/run_spike.mjs ../corpus --config config_a --dry-run` still completes all 31 cycles cleanly
- No real API calls have been made in Session 2 so far

---

## What Session 1 Produced

Session 1 built the Python DSP pipeline under `~/Work/feed-looks-back-spike/python/` and generated the calibrated real-audio corpus under `~/Work/feed-looks-back-spike/corpus/`.

The Node runner reads cycle JSONs from:

```text
~/Work/feed-looks-back-spike/corpus/cycle_000.json
...
~/Work/feed-looks-back-spike/corpus/cycle_030.json
```

Each cycle contains:

- `cycle_id`, `cycle_index`, `snapshot_time_s`, `elapsed_total_s`
- `block_1_scalars`
- `block_2_summary`
- `block_3_sparklines`
- `_debug` for Session 1 calibration only

Important contract rule:

- `_debug` is read from disk but **must never be sent to Opus**

The live corpus is Bashar’s 31-cycle real-performance run, not the earlier 5-cycle synthetic validation corpus.

---

## What Session 2 Phase 1 Delivered

Phase 1 created the Node-side scaffold under `~/Work/feed-looks-back-spike/node/`, installed dependencies, loaded Bashar’s prompt into a cached system block, defined Config A tool schemas and medium rules, built the packet builder, and implemented a dry-run-only CLI.

Current tree (Phase 1 + Phase 2 state) under `node/`:

```text
node/
├── package.json
├── pnpm-lock.yaml
├── .env.example
├── .gitignore
├── README.md
├── SESSION_2_PHASE_1_HANDOFF.md        # original Phase 1 handoff, retained for reference
├── SESSION_2_HANDOFF.md                # this file
├── prompts/
│   ├── hijaz_base.md
│   └── configs/
│       └── config_a/
│           ├── tools.json
│           └── medium_rules.md
├── src/
│   ├── opus_client.mjs
│   ├── packet_builder.mjs
│   ├── run_spike.mjs
│   ├── scene_state.mjs
│   └── tool_handlers.mjs
└── output/
    ├── run_20260423_015201/
    ├── run_20260423_021629/
    ├── run_20260423_023358/
    ├── run_20260423_023506/
    ├── run_20260423_031654/
    └── run_20260423_033951/
```

Key Phase 1 outputs that remain unchanged:

- `src/opus_client.mjs` — SDK wrapper + model resolver
- `src/packet_builder.mjs` — cycle + scene summary → Messages API packet
- `prompts/hijaz_base.md` — cached Hijaz base prompt
- `prompts/configs/config_a/tools.json` — Config A tool schemas
- `prompts/configs/config_a/medium_rules.md` — Config A medium notes

Phase 1 line counts that still matter:

- `src/opus_client.mjs` — 41 lines
- `src/packet_builder.mjs` — 74 lines

---

## v4 Contract State

Config A is now locked to the `v4` contract.

That means:

- `addText`, `addImage`, `fadeElement` remain ordinary tool calls with structured fields
- `addSVG` now requires Opus to author real inline `svg_markup`
- `setBackground` now requires Opus to author a real `css_background` value

These payloads are preserved verbatim in scene state and logs. Phase 3’s renderer is expected to inject them directly into the final HTML output rather than reinterpreting placeholder descriptions.

Current tool signatures:

- `addText(content, position, style, lifetime_s)`
- `addSVG(svg_markup, position, lifetime_s, semantic_label)`
- `addImage(query, position, lifetime_s)`
- `setBackground(css_background)`
- `fadeElement(element_id)`

Prompt/config files reflecting this contract:

- `prompts/hijaz_base.md`
- `prompts/configs/config_a/tools.json`
- `prompts/configs/config_a/medium_rules.md`

---

## Package / Environment State

- Package manager: `pnpm`
- Node target: `>=22.0.0`
- Installed dependencies:
  - `@anthropic-ai/sdk ^0.90.0`
  - `dotenv ^16.4.5`
- Default model string: `claude-opus-4-7`

Environment variables:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`

Notes:

- The original Session 2 prompt suggested `^0.40.0 or current stable`; Phase 1 used `^0.90.0`, which was current stable at install time.
- The canonical model alias `claude-opus-4-7` is used by default; `.env` may override it.

---

## Public Interfaces

### `src/opus_client.mjs` — 41 lines

Exports:

```js
makeOpusClient()
```

- Reads `process.env.ANTHROPIC_API_KEY`
- Throws a clear error if the key is missing or still equals the example placeholder
- Returns `new Anthropic({ apiKey, maxRetries: 5 })`

```js
resolveModel()
```

- Returns `process.env.ANTHROPIC_MODEL || "claude-opus-4-7"`

```js
callOpus(client, payload)
```

- Thin wrapper around `client.messages.create(...)`
- SDK retries are handled via client config
- Re-throws clearer spike-specific errors for auth / bad-request / not-found classes

### `src/packet_builder.mjs` — 74 lines

Exports:

```js
formatEmptySceneStateSummary(elapsedTotalS)
```

- Returns the empty scene-state text block using the current cycle elapsed time

```js
buildPacket({
  cycle,
  sceneStateSummary,
  hijazBase,
  mediumRules,
  tools,
  model,
  maxTokens = 2000,
})
```

- Strips `_debug`
- Formats the user message
- Returns the Anthropic Messages API payload

### `src/scene_state.mjs` — 540 lines

Exports:

- `DEFAULT_LIFETIMES`
- `AUTO_FADE_OVERLAP_S`
- `SVG_MARKUP_MAX_SUMMARY_CHARS`
- `createInitialState()`
- `beginCycle(state, { cycleIndex, elapsedTotalS })`
- `addElement(state, { type, content, lifetime_s })`
- `setBackground(state, { css_background })`
- `fadeElement(state, elementId)`
- `autoFade(state)`
- `formatSummary(state)`
- `saveState(state, runDir)`
- `snapshotCycle(state, runDir)`

Inline self-test:

- `node src/scene_state.mjs`

### `src/tool_handlers.mjs` — 335 lines

Exports:

```js
applyToolCall(state, toolUseBlock)
```

- Dispatches to `addText`, `addSVG`, `addImage`, `setBackground`, `fadeElement`
- Performs defensive required-field and type checks
- Returns structured tool results instead of throwing

Inline self-test:

- `node src/tool_handlers.mjs`

### `src/run_spike.mjs` — 957 lines

Exports no public library API; acts as the CLI entry point and contains:

- dry-run path
- real-run path
- self-test path
- per-cycle status accounting
- run summary generation

Inline self-test:

- `node src/run_spike.mjs --self-test`

Real API path entry point:

- `processCycleReal(...)`

That path is reached by invoking the CLI **without** `--dry-run`.

---

## Packet Structure

Each packet written in dry-run looks like:

```json
{
  "model": "claude-opus-4-7",
  "max_tokens": 2000,
  "system": [
    {
      "type": "text",
      "text": "<HIJAZ_BASE_PROMPT_CONTENT>",
      "cache_control": { "type": "ephemeral" }
    },
    {
      "type": "text",
      "text": "<CONFIG_A_MEDIUM_RULES_CONTENT>"
    }
  ],
  "tools": [ ...5 tool definitions... ],
  "messages": [
    {
      "role": "user",
      "content": "<single formatted user-message string>"
    }
  ]
}
```

System blocks:

- Block 0: `prompts/hijaz_base.md`, cached with `cache_control: { type: "ephemeral" }`
- Block 1: `prompts/configs/config_a/medium_rules.md`, uncached

User message content:

- Block 1 scalar JSON
- Block 2 deterministic prose caption
- Block 3 sparklines
- formatted scene-state summary
- closing instruction: act with tools or choose silence

Important packet invariants already verified:

- cached base prompt block is present
- `_debug` is stripped from all packets
- v4 fields `svg_markup` and `css_background` are present in tool schemas
- empty scene-state summaries use the cycle’s real elapsed time

---

## Scene State Schema

Current Phase 2 scene-state shape:

```json
{
  "elements": [
    {
      "element_id": "elem_0001",
      "type": "text" | "svg" | "image",
      "created_at_cycle": 3,
      "created_at_elapsed_s": 20.0,
      "lifetime_s": 25.0,
      "fades_at_elapsed_s": 45.0,
      "faded": false,
      "content": {
        "...": "type-specific payload"
      }
    }
  ],
  "background": {
    "css_background": "linear-gradient(...)",
    "set_at_cycle": 5,
    "set_at_elapsed_s": 30.0
  },
  "background_history": [
    {
      "css_background": "earlier background",
      "set_at_cycle": 2,
      "set_at_elapsed_s": 15.0
    }
  ],
  "next_element_index": 13,
  "current_cycle_index": 12,
  "current_elapsed_s": 60.0
}
```

Type-specific `content` payloads:

- text:
  - `content`
  - `position`
  - `style`
- svg:
  - `svg_markup`
  - `position`
  - `semantic_label`
- image:
  - `query`
  - `position`

### Element ID rule

- Format: `elem_NNNN`
- Zero-padded to 4 digits
- Monotonic

### Lifetime defaults

- text: `20s`
- svg: `15s`
- image: `18s`

### Auto-fade rule

After applying tool calls each cycle:

- fade any element where `fades_at_elapsed_s < current_elapsed_s + 5s`

This `+5s` grace window is deliberate. It allows Opus to see an element in its final visible cycle with the `fading next cycle` annotation before it disappears.

### background_history

When `setBackground` replaces an existing background:

- the prior background object is pushed into `background_history`

This history is **not** emitted in the Opus-facing summary. It exists for Phase 3 rendering and post-hoc inspection.

### Persistence

Dual persistence is implemented:

- `output/run_<timestamp>/scene_state.json`
  - overwritten every cycle with current state
- `output/run_<timestamp>/scene_state_log/cycle_NNN.json`
  - append-only snapshots after each cycle

---

## Scene Summary Sent to Opus

`scene_state.mjs` formats the active scene into a humans-not-machines text block.

Current shape:

```text
Current scene (3 elements visible, 60s since performance start):

TEXT [1 active]:
- elem_0005 (15s old, position "lower-left"): "fragment-8"

IMAGES [1 active]:
- elem_0007 (5s old, position "background"): query="threshold light at cycle 10"

SVG [1 active]:
- elem_0006 (10s old, position "horizontal band at mid-height", "angular break at cycle 9"): <svg viewBox="0 0 100 100"><line x1="0" y1="59" x2="100" y2="41" stroke="white" stroke-width="2"/></...

BACKGROUND: linear-gradient(187deg, #1a1410 0%, #0d0908 100%) (set 20s ago)
```

Important summary rules:

- exact ages are shown in seconds
- faded elements do not appear
- empty scenes still use the current cycle’s elapsed time
- SVG entries show:
  - `semantic_label`
  - truncated markup excerpt (about 100 chars, `...` suffix if needed)
- backgrounds show the CSS string verbatim
- elements near expiry are annotated `fading next cycle`

---

## Tool Handlers and Validation

`src/tool_handlers.mjs` is the API-boundary dispatcher. It validates required fields and returns structured tool results instead of throwing.

Validation behavior:

- missing required field → `{ error: "missing required field 'X'" }`
- wrong type → `{ error: "field 'X' must be a string" }`
- unknown tool → `{ error: "unknown tool '...'" }`
- `fadeElement` on a missing id → `{ error: "no such element" }`
- `fadeElement` on an already faded id → `{ error: "already faded" }`

For `addSVG` / `setBackground`:

- only presence and string-type are validated
- well-formed SVG and valid CSS are **not** validated in Phase 2
- malformed markup/CSS will be Phase 3 renderer concerns

---

## Tool-Use Loop Semantics

This remains locked to the spike’s single-shot model:

1. One Opus call per cycle
2. Parse all `tool_use` blocks from the initial response
3. Validate each tool call
4. Apply each tool call to scene state
5. Record tool results in logs / summary
6. **Do not** continue the conversation within the same cycle

Interpretation:

- `stop_reason: "tool_use"` → apply tool calls, move to next cycle
- `stop_reason: "end_turn"` with no tool calls → compositional silence

There is no in-cycle tool-result round-trip.

---

## Per-Cycle Status Model

The pre-Phase-3 hardening patch added five status values to `run_summary.json` and the per-cycle loop:

- `ok`
  - cycle completed normally
  - no API/parse/persistence failures
  - no structured tool-call validation errors
- `api_failure`
  - `callOpus(...)` threw after SDK retries were exhausted
  - examples: network failure, 5xx, 429, 401, timeout surfaced by SDK
- `response_parse_failure`
  - response structure was unusable
  - examples: missing `content`, unexpected `stop_reason`, malformed `tool_use` block
- `persistence_failure`
  - request/response or scene-state persistence failed after retry
  - in-memory run continues
- `tool_call_errors`
  - cycle otherwise completed, but one or more individual tool calls returned structured `{ error: ... }`

Current `run_summary.json` top-level totals now include:

- `total_cycles`
- `tool_calls`
- `cycles_with_tool_calls`
- `cycles_silent`
- `cost`
- `ok_count`
- `status_counts`

The post-hardening dry-run summary at `output/run_20260423_033951/run_summary.json` shows:

- `total_cycles: 31`
- `ok_count: 31`
- zero failures of all four error types

---

## Real API Code Path and Error Handling

Real-run logic lives in:

- `src/run_spike.mjs`
- function: `processCycleReal(...)`

How it is reached:

- invoke the CLI without `--dry-run`

Current real-run behavior:

1. write request log
2. call Opus
3. write response log
4. parse response
5. on parse failure, dump raw response to `opus_log/cycle_NNN_response_raw.json`
6. apply tool calls
7. auto-fade scene
8. persist scene state
9. record per-cycle status and continue

Persistence behavior:

- state persistence retries once after `100ms`
- if still failing, the cycle is marked `persistence_failure`
- the run continues

Important guarantee after the patch:

- a Phase 3 run is no longer crash-on-first-error at the per-cycle level
- the runner should process the full corpus and leave status evidence in `run_summary.json`

This hardening patch landed after Phase 2 approval specifically to protect the first credit-spend run.

---

## Verification Evidence

### Phase 2 self-tests

Fresh runs completed:

- `node src/scene_state.mjs`
  - `20/20 passed`
- `node src/tool_handlers.mjs`
  - `17/17 passed`
- `node src/run_spike.mjs --self-test`
  - `2/2 passed`

The `run_spike.mjs` self-tests cover:

1. mocked real-mode run with:
   - one normal silent cycle
   - one API failure
   - one malformed response / parse failure
2. dry-run with injected persistence failure on cycle 0

### Dry-run verification

Key runs:

- `output/run_20260423_031654/`
  - first threaded scene-state Phase 2 dry-run
- `output/run_20260423_033951/`
  - post-hardening dry-run proving no regression

`output/run_20260423_033951/run_summary.json` confirms:

- 31 cycles processed
- all 31 status = `ok`
- zero failures

No `opus_log/` exists in dry-run runs, which is expected.

---

## Reproduction Recipes

From `~/Work/feed-looks-back-spike/node/`:

### Install

```bash
pnpm install
```

### Scene-state self-test

```bash
node src/scene_state.mjs
```

### Tool-handler self-test

```bash
node src/tool_handlers.mjs
```

### Runner self-test

```bash
node src/run_spike.mjs --self-test
```

### Dry-run the full Bashar corpus

```bash
node src/run_spike.mjs ../corpus --config config_a --dry-run
```

### Verify cache marker exists

```bash
rg -n '"cache_control"' output/run_20260423_033951/dry_run/cycle_000_packet.json
```

### Verify `_debug` is stripped

```bash
rg -n '"_debug"' output/run_20260423_033951/dry_run/cycle_000_packet.json
```

Expected: no matches.

### Verify the v4 contract markers

```bash
rg -n '"svg_markup"|"css_background"' output/run_20260423_033951/dry_run/cycle_015_packet.json
```

### Verify elapsed time in the empty-scene case

```bash
rg -n '80s since performance start' output/run_20260423_033951/dry_run/cycle_015_packet.json
```

---

## Phase 3 Scope

Phase 3 should do only the remaining end-to-end work:

1. Build `src/render_html.mjs`
2. Wire it into `run_spike.mjs` so a completed run produces:
   - `final_scene.html`
   - updated `run_summary.json`
3. Run the full 31-cycle Bashar corpus in real API mode
4. Present the resulting artifact paths and run summary

Renderer expectations:

- render real `svg_markup`
- render `css_background` directly
- show current scene plus composition history
- respect faded-state visibility/history split

Phase 3 run-summary additions should include:

- total cost
- cache hit ratio or equivalent cache usage summary
- tool-call distribution by type
- any errors / warnings
- enough detail for Bashar-facing evaluation

Credits are first spent in Phase 3, not before.

---

## Codex Audit Pattern

Use the same pattern that worked in Session 1 and early Session 2:

- phase gates are handled live during implementation
- run Codex once at the end of Phase 3 against:
  - `src/render_html.mjs`
  - final `run_spike.mjs`
  - final `run_summary.json`
  - the real-run output directory
  - the produced `final_scene.html`

Audit for:

- renderer contract conformance
- real-run logging and summary integrity
- tool-use semantics
- scene-state persistence
- final artifact existence and completeness

If something feels off mid-Phase-3, an earlier targeted Codex pass is reasonable, but the default is still end-state audit.

---

## Deviations from the Original Session 2 Prompt

These are the intentional contract differences now in effect:

1. SDK version is `^0.90.0`, not `^0.40.0`
   - original prompt allowed current stable

2. Default model string is `claude-opus-4-7`
   - cleaner canonical alias, still env-overridable

3. Config A moved from `v3` placeholder payloads to `v4` real rendering payloads
   - `addSVG` now carries `svg_markup`
   - `setBackground` now carries `css_background`
   - this change was made between Phase 1 and Phase 2 so the rest of the architecture could target the correct final contract

4. Phase 2 added `background_history`
   - useful for Phase 3 rendering and debugging
   - not emitted to Opus

5. Post-Phase-2 hardening patch added per-cycle error handling to `run_spike.mjs`
   - API failures no longer abort the full run
   - parse failures dump raw response files
   - persistence failures retry once and continue
   - `run_summary.json` now records per-cycle status

These are now part of the effective external contract.

---

## Recommended Next Step

Start a fresh session with:

1. `~/Work/feed-looks-back-spike/SESSION_1_HANDOFF.md`
2. this `~/Work/feed-looks-back-spike/node/SESSION_2_HANDOFF.md`
3. the original Session 2 Phase 3 prompt / bootstrap message
4. the current `node/` directory

Then do Phase 3 only:

- renderer
- final summary wiring
- first real run
- no contract churn unless a real blocker appears

This handoff is intended to make that fresh session fully reconstructable without relying on prior conversational context.
