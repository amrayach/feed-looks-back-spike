# Feed Looks Back — Node Runner (Session 2)

Consumes cycle JSONs produced by the Python pipeline at `../corpus/` and drives Claude Opus 4.7 to author a visual scene. Config A renders to a static HTML scene at end of run.

## Setup

```
pnpm install
cp .env.example .env
# edit .env and add your ANTHROPIC_API_KEY
```

## Run

```
# Dry run — build packets, write them to disk, skip API calls
node src/run_spike.mjs ../corpus --config config_a --dry-run

# Real run — spends API credit (~$1.50–$3.00 for the 31-cycle corpus)
node src/run_spike.mjs ../corpus --config config_a

# Subset of cycles
node src/run_spike.mjs ../corpus --config config_a --cycles 0:10
```

Output lands under `output/run_<timestamp>/`:
- `scene_state.json` — current state (overwritten each cycle)
- `scene_state_log/cycle_NNN.json` — per-cycle snapshot
- `opus_log/cycle_NNN_{request,response}.json` — full API round trip
- `final_scene.html` — the deliverable for the Bashar checkpoint
- `run_summary.json` — cost, timings, tool-call counts

## Architecture

- `prompts/hijaz_base.md` — cached system prompt (Bashar v3)
- `prompts/configs/config_a/` — config-specific tool schemas + medium rules
- `src/opus_client.mjs` — SDK wrapper, prompt caching, retries
- `src/packet_builder.mjs` — cycle JSON + scene state → API request
- `src/scene_state.mjs` — in-memory state, auto-fade, disk persistence
- `src/tool_handlers.mjs` — validate + apply Opus's tool calls
- `src/operator_views.mjs` — final scene + live monitor HTML outputs
- `src/run_spike.mjs` — CLI entry, per-cycle loop
