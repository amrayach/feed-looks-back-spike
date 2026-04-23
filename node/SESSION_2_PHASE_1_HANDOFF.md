# Feed Looks Back — Session 2 Phase 1 Handoff

**Date:** 2026-04-23  
**Status:** Phase 1 complete, patched, and verified. Ready to bootstrap Phase 2 in a fresh session.

> Read this file and the original Session 2 prompt together. This doc is the Phase 1 state snapshot.

---

## TL;DR

Phase 1 created the Node-side scaffold at `~/Work/feed-looks-back-spike/node/`, installed the Anthropic SDK and dotenv, loaded Bashar's prompt into a cached system block, defined Config A tool schemas and medium rules, built the Phase 1 packet builder, and implemented a dry-run-only CLI that writes one API-shaped packet per cycle without spending credit.

Two Codex review fixes were then applied, followed by the v4 contract upgrade:

1. Empty scene-state summaries now use the current cycle's `elapsed_total_s` instead of hardcoding `0s since performance start`.
2. `README.md` now correctly says the runner consumes cycle JSONs from `../corpus/`, not `../python/`.
3. The Config A contract is now `v4`: `addSVG` takes real `svg_markup` and `setBackground` takes real `css_background`.

Fresh verification run:

- `run_id = 20260423_023506`
- output dir: `~/Work/feed-looks-back-spike/node/output/run_20260423_023506/`
- `cycle_015_packet.json` now shows `Current scene (0 elements visible, 80s since performance start)`
- the packet tool schemas now expose `svg_markup` and `css_background`

---

## What Phase 1 Delivered

Current Phase 1 tree under `~/Work/feed-looks-back-spike/node/`:

```text
node/
├── package.json                         (18)  — package metadata, deps, scripts, Node 22 engine
├── pnpm-lock.yaml                       (generated)
├── .env.example                         (2)   — ANTHROPIC_API_KEY / ANTHROPIC_MODEL template
├── .gitignore                           (6)   — node_modules, .env, output, logs
├── README.md                            (42)  — setup, run commands, architecture summary
├── prompts/
│   ├── hijaz_base.md                    (294) — cached base prompt body, patched to v4 SVG/CSS contract
│   └── configs/
│       └── config_a/
│           ├── tools.json               (104) — Anthropic tool schemas for Config A (v4 contract)
│           └── medium_rules.md          (13)  — Config A medium notes for real SVG/CSS payloads (199 words)
├── src/
│   ├── opus_client.mjs                  (41)  — SDK wrapper + model resolver + API call wrapper
│   ├── packet_builder.mjs               (74)  — cycle + scene state → Messages API packet
│   └── run_spike.mjs                    (183) — Phase 1 CLI, dry-run only
└── output/
    ├── run_20260423_015201/             — original Phase 1 dry-run output
    ├── run_20260423_021629/             — regenerated dry-run output after Codex fixes
    └── run_20260423_023506/             — regenerated dry-run output after final v4 contract lock
```

Not yet implemented in Phase 1:

- `src/scene_state.mjs`
- `src/tool_handlers.mjs`
- `src/render_html.mjs`

Those are Phase 2 / 3 work, not missing work from Phase 1.

---

## Package / Environment State

- Package manager: `pnpm`
- Node target: `>=22.0.0`
- Installed dependencies:
  - `@anthropic-ai/sdk ^0.90.0`
  - `dotenv ^16.4.5`
- Model string currently used by default: `claude-opus-4-7`
- Env vars loaded via `dotenv/config`:
  - `ANTHROPIC_API_KEY`
  - `ANTHROPIC_MODEL`

Notes:

- The original Session 2 prompt suggested `^0.40.0` or current stable. Phase 1 used `^0.90.0`, which was current stable at install time.
- The original prompt gave a date-suffixed Opus model string as illustrative. Phase 1 uses the canonical alias `claude-opus-4-7` and allows `.env` override.

---

## Public Interfaces

### `src/opus_client.mjs`

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
callOpus(client, { model, max_tokens, system, tools, messages })
```

- Thin wrapper around `client.messages.create(...)`
- Retries are handled by SDK client config (`maxRetries: 5`)
- Re-throws auth / bad-request / not-found failures as clearer spike-specific messages

### `src/packet_builder.mjs`

Exports:

```js
formatEmptySceneStateSummary(elapsedTotalS)
```

- Returns the empty scene-state text block using the current cycle elapsed time:

```text
Current scene (0 elements visible, <elapsed>s since performance start):

(empty — nothing has been placed yet)

BACKGROUND: (not set)
```

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

- Strips top-level `_debug` from the cycle JSON before packet assembly
- Formats the per-cycle user message
- Returns a Messages API payload with:
  - `model`
  - `max_tokens`
  - `system` array of 2 text blocks
  - `tools`
  - `messages` containing a single user message string

Internal-only helper:

- `stripDebug(cycle)`
- `formatUserMessage(cycle, sceneStateSummary)`

---

## Packet Structure

Each dry-run output file under `output/run_<timestamp>/dry_run/cycle_NNN_packet.json` is shaped like:

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

### System blocks

Block 0:

- source: `prompts/hijaz_base.md`
- Bashar prompt body, patched to the v4 SVG/CSS contract
- cached with `cache_control: { type: "ephemeral" }`

Block 1:

- source: `prompts/configs/config_a/medium_rules.md`
- not cached
- updated for real SVG markup and CSS background values

### Tools

Defined in `prompts/configs/config_a/tools.json`:

- `addText(content, position, style, lifetime_s)`
- `addSVG(svg_markup, position, lifetime_s, semantic_label)`
- `addImage(query, position, lifetime_s)`
- `setBackground(css_background)`
- `fadeElement(element_id)`

Required vs optional parameters match the prompt:

- `lifetime_s` is optional on all add-tools
- `semantic_label` is required on `addSVG`
- `svg_markup` is required on `addSVG`
- `css_background` is required on `setBackground`
- `element_id` is required on `fadeElement`

### User message format

Per cycle:

```text
You are receiving cycle <cycle_index> of the performance.

BLOCK 1 — SCALAR SUMMARY (last 4 seconds):
<pretty JSON of block_1_scalars>

BLOCK 2 — DETERMINISTIC PROSE CAPTION:
<block_2_summary>

BLOCK 3 — SPARKLINES:
RMS:      <rms>
Onsets:   <onset>
Centroid: <centroid>

CURRENT SCENE STATE:
<scene state summary block>

Decide what to do, and act with the tools. You may call zero, one, or several tools. If silence is the right answer, call no tools.
```

`_debug` is stripped before this is assembled and is never sent.

---

## Scene State Contract for Phase 2

Phase 2 must implement `scene_state.json` as the source of truth:

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
      "content": {}
    }
  ],
  "background": {
    "css_background": "radial-gradient(circle at 30% 20%, rgba(180,140,90,0.45), rgba(10,10,12,0.95) 70%)" | null,
    "set_at_cycle": 5,
    "set_at_elapsed_s": 30.0
  },
  "next_element_index": 13,
  "current_cycle_index": 12
}
```

### Required scene-state rules

- Element IDs: `elem_NNNN`, zero-padded to 4 digits, monotonic
- Preserve real rendering payloads in state/logs:
  - text: `content`, `position`, `style`
  - svg: `svg_markup`, `position`, `semantic_label`
  - image: `query`, `position`
- Default lifetimes when tool call omits `lifetime_s`:
  - text: `20s`
  - svg: `15s`
  - image: `18s`
- Auto-fade rule after applying tool calls:
  - auto-fade elements whose `fades_at_elapsed_s < current elapsed_total_s + 5s`
- Faded elements remain in `elements` with `faded: true`
- Faded elements do **not** appear in the scene-state summary sent back to Opus

### Scene-state summary format for Opus

Phase 2 must format a readable text block like:

```text
Current scene (8 elements visible, 47s since performance start):

TEXT [3 active]:
- elem_0004 (4s old, position "lower-left"): "after"

IMAGES [1 active]:
- elem_0008 (15s old, position "background"): query="threshold light through a doorway"

SVG [3 active]:
- elem_0001 (2s old, position "lower-right"): label="angular break lower-right"

BACKGROUND: radial-gradient(circle at 30% 20%, rgba(180,140,90,0.45), rgba(10,10,12,0.95) 70%) (stable for 47s)
```

Exact ages in seconds. Humans-not-machines format. Do not dump full `svg_markup` into the scene-state summary; use `semantic_label` there and keep the real markup in state/log files.

---

## Tool-Use Loop Semantics

This was explicitly decided in the Session 2 prompt and must be preserved:

- One Opus call per cycle
- Parse any `tool_use` blocks from the initial response
- Validate and apply the tool calls to scene state
- Record tool results in logs / state for the next cycle
- **Do not** continue the conversation within the same cycle after returning tool results

So:

- `stop_reason: "tool_use"` => parse / validate / apply, then move on to next cycle
- `stop_reason: "end_turn"` with no tool calls => this cycle is compositional silence

This is a deliberate spike simplification to keep costs predictable.

---

## Phase 2 Scope

Phase 2 should implement only:

- `src/scene_state.mjs`
- `src/tool_handlers.mjs`
- real API wiring in `src/run_spike.mjs`
- per-module self-tests where reasonable
  - especially for scene-state mutation / element IDs / auto-fade
- dry-run verification using non-empty synthetic scene state

Phase 2 gate requirements:

- show self-test outputs
- show an example packet with non-empty scene state
- confirm API integration is ready
- **do not spend real API credit yet**

---

## Phase 3 Scope

Phase 3 is only:

- `src/render_html.mjs`
- first real run over the 31-cycle corpus
- output under `output/run_<timestamp>/`
- real rendering of authored SVG markup and CSS background values
- final summary:
  - total cost
  - total cycles with tool calls vs silence
  - tool-call distribution
  - 3–5 example tool calls
  - errors / warnings

Phase 3 is the first point where API credits should be spent in Session 2.

---

## Reproduction / Verification

From `~/Work/feed-looks-back-spike/node/`:

### Install

```bash
pnpm install
```

### Dry-run all 31 cycles

```bash
node src/run_spike.mjs ../corpus --config config_a --dry-run
```

### Verify cache marker exists on the base prompt block

```bash
rg -n '"cache_control"' output/run_20260423_023506/dry_run/cycle_000_packet.json
```

### Verify `_debug` is not present in the packet

```bash
rg -n '"_debug"' output/run_20260423_023506/dry_run/cycle_000_packet.json
```

Expected: no matches.

### Verify the v4 contract in the packet

```bash
rg -n '"svg_markup"|"css_background"' output/run_20260423_023506/dry_run/cycle_015_packet.json
```

### Verify the Codex elapsed-time fix on cycle 15

```bash
rg -n '80s since performance start' output/run_20260423_023506/dry_run/cycle_015_packet.json
```

### Phase 2 self-tests

Not present yet. Add them in Phase 2 and document the commands in the new modules once they exist.

---

## Codex Review Pattern

Use the same pattern that worked in Session 1:

- Phase gates are handled live during implementation
- After Phase 3 completes, run one end-state Codex audit against the original Session 2 prompt
- Audit for:
  - schema conformance
  - packet shape
  - tool-use semantics
  - state persistence
  - HTML output existence and summary integrity

Do not spend time running Codex between Phase 2 and Phase 3 unless something feels off.

---

## Codex Phase 1 Fixes Applied

### 1. Empty scene-state elapsed time

Problem:

- The original Phase 1 packet builder hardcoded:

```text
Current scene (0 elements visible, 0s since performance start)
```

for every cycle, including mid-performance packets.

Fix:

- Replaced the constant export with:

```js
formatEmptySceneStateSummary(elapsedTotalS)
```

- `run_spike.mjs` now passes `cycle.elapsed_total_s` into that helper for dry-run packet generation.

Verified:

- `output/run_20260423_023506/dry_run/cycle_015_packet.json` now shows `80s since performance start`

### 2. README input-path drift

Problem:

- `README.md` said the runner consumed cycle JSONs from `../python/`

Fix:

- Corrected to `../corpus/`

---

## Deviations from the Original Session 2 Prompt

These are the intentional deviations currently present:

1. SDK version is `^0.90.0`, not `^0.40.0`
   - Reason: prompt explicitly allowed current stable; this was current stable at install time.

2. Default model string is `claude-opus-4-7`, not a date-suffixed illustrative id
   - Reason: canonical alias is cleaner and still env-overridable.

3. User message content is emitted as one string rather than an array of text blocks
   - Reason: simpler, valid for Messages API, and matches the spec's illustrative shape.

4. Phase 1 runner hard-blocks real calls unless `--dry-run` is provided
   - Reason: enforce the phase gate and prevent accidental spend before Phase 2 review.

5. Codex patch replaced the constant empty-scene summary with a function
   - Reason: fixes elapsed-time correctness for mid-performance dry-run packets.

6. Config A was upgraded from the placeholder-oriented v3 contract to the v4 real-rendering contract
   - Reason: lock the actual SVG/CSS payload surface before Phase 2 so scene state, tool handling, and the renderer target the intended artistic contract.

These are the effective external contract decisions that Phase 2 should now implement against.

---

## Recommended Next Step

Start a fresh session with:

1. the original Session 2 prompt
2. this handoff doc
3. the current `node/` directory

Then implement Phase 2 only:

- scene state
- tool handlers
- API wiring
- self-tests
- dry-run packet with non-empty scene state

Do not do real API calls until the Phase 2 gate is reviewed.
