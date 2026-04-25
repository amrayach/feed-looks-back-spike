# The Feed Looks Back — Submission Runbook

A public-safe runbook for the Build with Opus 4.7 submission. Internal
strategy and form-field copy live elsewhere; this document focuses on what
a judge or reproducer needs from inside the repo.

## What this project is

A live audiovisual performance system. A musician plays in a tradition a
general-purpose model wasn't optimised for. Claude Opus 4.7 listens — once
per musical phrase — and authors the visuals on stage in real time. Text
fades in, photographic references appear, p5 sketches and SVG fragments
arrive, every element subtly bound to amplitude and structural events in
the music. Earnest, attentive, almost right.

Most uses of generative AI optimise that almost-right gap away. This piece
keeps it. Watched live, the result reads as the texture of the contemporary
feed: algorithmically personal, never quite for you, always almost. The
gap between what the music is and what the screen returns is the piece.

## Two temporal modes

| Mode | What Opus does | What ships |
|---|---|---|
| **Live / API** | Authors the next visual gesture in real time, once per ~5 second cycle, given current audio features and current scene state. | The improvising stance. Latency, presence, the risk of public response. |
| **Bake** | Three offline passes over the whole track: a composition pass that reads the full work as multi-modal input and writes a per-cycle intent score; a parallel execution pass that generates each cycle under the plan; a critique-and-refine pass where Opus reviews its own cycles and rewrites the ones it judges weak. | The composing stance. Same prompts, same tools, different relationship to time. The refined score replays deterministically in sync with the original audio. |

The almost-right gap stays in both modes. What changes is the temporal
stance — Opus reaching live, or Opus composing across the whole piece.

## Submission Checklist

- [ ] Public GitHub repository, accessible without auth (verify in a private window).
- [ ] Written description that explains what was built, how Claude Opus 4.7 was used, and how the project evolved beyond the first idea.
- [ ] Three-minute demo video, hosted on YouTube, Loom, or a public drive link.
- [ ] Rights check for code, audio, images, and reference assets (see Asset & Rights below).
- [ ] No secrets in `.env`, run logs, request/response logs, or committed media.

## Recommended Prize Framing

**Primary: Most Creative Opus 4.7 Exploration.**

Position the system as a creative medium, not a tool. Opus is the live
authoring layer — it listens to the performance, reads the moment, chooses
scene operations, and composes across time when given the time to do so.

**Secondary: Keep Thinking.**

The strongest evolution story is short and load-bearing:

1. Started as a live Opus visual improvisor for a culturally-specific
   musical practice.
2. Found that the interesting artistic material wasn't generic reactivity
   — it was the gap between musical specificity and the model's averaged
   visual priors.
3. Reworked the prompt register, added negative visual constraints, added
   reference imagery, added a local Chain A motion-effects layer, and then
   built bake mode so Opus could compose across the whole track instead
   of only reacting in 5-second windows.

Both prizes share one architectural fact: bake mode is what makes the
submission eligible for both at once. It's not a rendering optimisation;
it's a second temporal stance for the same piece.

**Not targeted:** Managed Agents. The piece is a single model in a tight
relationship with the music; introducing autonomous agents would have
changed what the project is about. The honest answer is "no" with an
architectural reason.

## Judging Rubric Alignment

From the kickoff transcript, judges weight four criteria. Mapping for this
repo:

| Criterion | How this repo answers it |
|---|---|
| **Impact** | A working artwork that examines how AI systems translate culturally specific musical material into visual language; usable as a performance piece, a discussion artefact, or a research probe into model visual priors |
| **Demo** | Audio plays, the live or baked stage authors visuals in sync, the HUD exposes Opus's tool calls and reasoning as the scene evolves, baked mode lets the strongest visual passages be captured cleanly |
| **Opus 4.7 use** | Opus reads dense structured packets (DSP features, current scene state, recent decisions, cultural prompt, mood-board, reference images) and emits structured tool calls; the bake-mode composition pass uses the whole track as multi-modal input under a generous extended-thinking budget |
| **Depth and execution** | Python DSP, schema-validated packets, browser stage with p5 sandbox, HUD, prompt audit, Chain A effects, three-pass bake pipeline (composition → parallel execution → critique-and-refine), replay capture |

## Three-Minute Demo Shape

| Time | Content |
|---|---|
| 0:00 - 0:20 | Audio enters; title card establishes the piece — model listening, authoring live |
| 0:20 - 0:55 | Stage changes while HUD exposes Opus's tool calls in real time |
| 0:55 - 1:35 | Core loop annotated: DSP windows → Opus packet → tool calls → browser scene |
| 1:35 - 2:15 | Bake mode: composition plan → per-cycle execution → critique-and-refine |
| 2:15 - 2:45 | Strongest visual passage full-screen; let the result breathe |
| 2:45 - 3:00 | One-sentence close: Opus as performer/composer, not just assistant |

Spend more time showing the result than explaining the internals.

## Short Project Description (public-safe distillation)

The Feed Looks Back is a live performance system where Claude Opus 4.7
listens to a musical recording and authors a visual scene in real time.
The Python layer extracts loudness, onset, spectral, pitch-class, silence,
and structural features. The Node runner packages those features with a
cultural prompt, the current scene state, recent decisions, mood-board
references, and tool schemas. Opus responds with tool calls that place
text, SVG, photographic references, p5 sketches, composite scenes,
transforms, pulses, palette shifts, and fades. The browser stage renders
the result while a HUD shows the model's authorship as it happens.

The project treats Opus 4.7 as a creative medium. The interesting question
is not whether an AI can produce a pretty visualiser — it is what visual
language appears when a frontier model is asked to respond to musical
material a general-purpose distribution wasn't optimised for. During the
build the project moved from a reactive prototype to a system with prompt
audits, negative visual constraints, reference imagery, local motion
effects, and an offline bake mode that lets Opus compose across the whole
track before replaying the result deterministically in sync with audio.

## Exact Commands For Final Capture

Live / API smoke (dry-run, no API spend):

```bash
cd /home/amay/Work/feed-looks-back-spike/node
node src/run_spike.mjs ../corpus_song1 --config config_a --dry-run --stage-audio "../audio/song 1.wav"
```

Live / API run against real Opus:

```bash
cd /home/amay/Work/feed-looks-back-spike/node
node src/run_spike.mjs ../corpus_song1 --config config_a --stage-audio "../audio/song 1.wav"
```

Baked replay through the normal stage:

```bash
cd /home/amay/Work/feed-looks-back-spike/node
node src/run_spike.mjs --use-baked ../bake_song1 --stage-audio "../audio/song 1.wav"
```

Watch-only baked playback (browser opens; clean for capture):

```bash
cd /home/amay/Work/feed-looks-back-spike/node
node src/bake_watch.mjs --use-baked ../bake_song1 --stage-audio "../audio/song 1.wav"
```

Submission helper artefacts:

```bash
cd /home/amay/Work/feed-looks-back-spike/node
node src/bake_render_plan.mjs ../bake_song1
node src/bake_highlight_rationales.mjs --bake-dir ../bake_song1 --top 5
```

Capture: `video_capture.mjs` falls back to manual screen recording when
`ffmpeg` is unavailable. OBS or any system screen recorder is acceptable
for the demo; the visible stage and HUD are what matter, not the codec.

## Asset & Rights Notes

- Audio files under `audio/` are gitignored. Submit only with rights
  confirmed and the file intended to be public.
- `node/canon/reference_photos/` ships **five** photos with full source
  attribution; see `ATTRIBUTION.md` in that directory. Seven additional
  photos that were used during local development have been excluded from
  the public repo via `.gitignore` because their provenance could not be
  reconstructed reliably. The published bake outputs were generated when
  the wider local set was present and may reference the excluded
  filenames as text in their stored rationales — this is metadata, not a
  load-time dependency, and replay does not require the excluded photos.
- Do not commit `.env`, `.codex/`, `node/output/`, or `node/image_cache/`.
- Internal session-handoff documents that name collaborators or contain
  in-progress framing decisions are not part of the public submission.
  New ones are gitignored; older ones already tracked in earlier history
  can be untracked with `git rm --cached <path>` before publishing if
  desired (see `docs/FINAL_DEEP_DIVE_CHECK_2026_04_25.md` for the list).

## A note on naming

The runtime feature contract (DSP feature names, patch-protocol fields)
still uses `hijaz_*` identifiers from an earlier maqam phase. The current
artistic prompt is Bayati. The two are intentionally decoupled: feature
names are an internal contract between the DSP layer and the patch
emitter; the prompt and the local effects layer remap those signals into
Bayati semantics. The `bayati_base.md` prompt is the sole source of truth
for the visual register; `hijaz_base.md` is retained only for diff-style
inspection of the older register.
