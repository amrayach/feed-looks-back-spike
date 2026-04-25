# Feed Looks Back — Node Runtime

Node runtime for the browser stage, Opus packet loop, HUD, and bake-mode
composition pipeline.

## Setup

```bash
pnpm install
cp .env.example .env
# add ANTHROPIC_API_KEY for real Opus calls
```

The package expects Node 22+.

## Live / API Mode

Dry-run packet and renderer smoke:

```bash
node src/run_spike.mjs ../corpus_song1 --config config_a --dry-run
```

Real Opus run:

```bash
node src/run_spike.mjs ../corpus_song1 --config config_a --stage-audio "../audio/song 1.wav"
```

Useful flags:

| Flag | Purpose |
|---|---|
| `--cycles N:M` | Run an inclusive cycle subset |
| `--dry-run` | Build packets and synthesize local tool calls without API spend |
| `--stage-audio <wav>` | Copy a WAV into the run dir and expose it to the browser stage |
| `--feature-producer none` | Disable live Python feature streaming |
| `--self-test` | Run `run_spike.mjs` inline tests |

Run output lands in `node/output/run_<timestamp>/` and includes:

- `run_summary.json`
- `scene_state.json`
- `scene_state_log/cycle_NNN.json`
- `opus_log/cycle_NNN_{request,response}.json`
- `final_scene.html`
- live stage/HUD URLs printed by the CLI

## Bake Mode

Bake mode is the submission-friendly path: Opus thinks deeply offline, then the
browser replays the model's completed plan in sync with the track.

Pass 1, full-track composition plan:

```bash
node src/bake_composition.mjs \
  --corpus ../corpus_song1 \
  --audio "../audio/song 1.wav" \
  --bake-dir ../bake_song1
```

Pass 2, per-cycle tool calls:

```bash
node src/bake_cycles.mjs \
  --bake-dir ../bake_song1 \
  --corpus ../corpus_song1 \
  --concurrency 5 \
  --resume
```

Pass 3, critique and refinement:

```bash
node src/bake_critique.mjs --bake-dir ../bake_song1 --max-refines 6
```

Replay a baked bundle through the normal stage:

```bash
node src/run_spike.mjs --use-baked ../bake_song1 --stage-audio "../audio/song 1.wav"
```

Watch-only playback:

```bash
node src/bake_watch.mjs --use-baked ../bake_song1 --stage-audio "../audio/song 1.wav"
```

Submission helpers:

```bash
node src/bake_render_plan.mjs ../bake_song1
node src/bake_highlight_rationales.mjs --bake-dir ../bake_song1 --top 5
node src/video_capture.mjs --self-test
```

## Architecture

| Area | Files |
|---|---|
| Opus live loop | `src/run_spike.mjs`, `src/packet_builder.mjs`, `src/opus_client.mjs` |
| Scene state and tool handling | `src/scene_state.mjs`, `src/tool_handlers.mjs`, `src/patch_emitter.mjs` |
| Stage server | `src/stage_server.mjs`, `browser/stage.html`, `browser/show.html` |
| Browser rendering | `browser/scene_reducer.mjs`, `browser/p5_sandbox.mjs`, `browser/audio_visual_layer.mjs` |
| HUD | `browser/hud.*`, `browser/hud_parser.mjs` |
| Audio feature replay | `browser/feature_bus.mjs`, `browser/feature_replayer.mjs` |
| Chain A effects | `browser/chain_a.mjs` |
| Bake mode | `src/bake_*.mjs`, `prompts/bake/*.md` |
| Prompt and tools | `prompts/bayati_base.md`, `prompts/configs/config_a/*` |

## Validation

Common runtime checks:

```bash
node src/run_spike.mjs --self-test
node src/stage_server.mjs
node browser/scene_reducer.mjs
node browser/binding_engine.mjs
node browser/p5_sandbox.mjs
node src/tool_handlers.mjs
node src/patch_protocol.mjs
node src/scene_state.mjs
```

Bake checks:

```bash
node src/bake_io.mjs
node src/bake_anthropic.mjs
node src/bake_composition.mjs --self-test
node src/bake_cycles.mjs --self-test
node src/bake_critique.mjs --self-test
node src/bake_player.mjs --self-test
node src/bake_render_plan.mjs --self-test
node src/bake_highlight_rationales.mjs --self-test
```

`stage_server.mjs` binds localhost during tests. If a sandbox blocks binding,
run that suite from a normal shell or allow localhost binding.
