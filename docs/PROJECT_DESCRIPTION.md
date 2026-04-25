# The Feed Looks Back

*A live performance system where Claude Opus 4.7 listens to music and
authors the visuals on stage in real time.*

## The piece

You know that feeling when an algorithm guesses what you like and gets it
almost right, but never quite? The Feed Looks Back is built around that
feeling.

A musician plays in a tradition a general-purpose model wasn't optimised
for. Claude Opus 4.7 listens once per musical phrase, reads the moment,
and authors the visuals on stage — text that fades in, photographic
references that appear, p5 sketches and SVG fragments, motion bound to
amplitude and structural events in the music. Earnest, attentive, almost
right.

Most uses of generative AI optimise the mistranslation away — fix it,
hide it, retrain past it. I built a stage where it stays. The musician
plays in a tradition the model wasn't optimised for; Opus, given audio
features, current scene state, and a cultural briefing, tries with full
attention to render what should appear on screen. The result is sincere,
sometimes beautiful, never quite at home. Watched live, it reads as the
texture of the contemporary feed: algorithmically personal, never quite
for you, always almost.

The gap between what the music is and what the screen returns is the
piece.

## How Opus 4.7 is used

Every musical cycle (~5 seconds), the system asks Opus to do two things
back-to-back:

1. **Read** a dense structured snapshot of what just happened — audio
   features, current scene state, recent decisions, a cultural briefing
   about the music, mood-board metadata, and a small set of reference
   photographs.
2. **Emit** structured tool calls that will be executed against a live
   browser stage a few hundred milliseconds later — placements,
   transformations, palette shifts, p5 sketches, SVG fragments,
   composite scenes, fades.

Both halves need precision a previous model didn't reliably provide.
Opus 4.7's behaviour on long-running, structured, instruction-faithful
work is what makes the loop stable enough to perform with.

## Two temporal stances

The same architecture runs in two complementary temporal modes. Same
prompts, same tools, different relationship to time:

### Live / API — improvising stance

A microphone (or a recorded track) feeds the Python DSP layer. The Node
runtime assembles each prompt with current scene state and recent
decisions. Opus authors the next visual gesture in real time. A local
motion-effects layer (Chain A) keeps every element subtly bound to the
audio between cycles. Presence, latency, the risk of public response.

### Bake — composing stance

Three offline Opus passes over the whole track:

1. **Composition pass.** Reads the full work as multi-modal input —
   mel-spectrogram, DSP plots, full prose corpus, mood-board, reference
   photographs — and writes a per-cycle intent score under a generous
   extended-thinking budget.
2. **Parallel execution pass.** Generates each cycle under the plan,
   running in parallel for throughput.
3. **Critique-and-refine pass.** Opus reviews its own per-cycle output
   and rewrites the cycles it judges weak.

The refined score replays deterministically in sync with the original
audio. *Composition* in the literal sense: thinking across time.

The almost-right gap stays in both modes. What changes is the temporal
stance — Opus reaching live, or Opus composing across the whole piece.

## How the project evolved

I started this build thinking of Opus as a real-time visual performer.
Once the live system was working, I kept asking what else the same
architecture could be:

- A reactive prototype became a system with prompt audits and negative
  visual constraints, after the model's first instinct kept drifting
  toward generic-pretty defaults.
- Mood-board metadata and reference photographs were added to give the
  cultural briefing visual examples, not just prose.
- A local motion-effects layer (Chain A) was added so that elements
  could keep breathing between cycles instead of going still.
- Bake mode was added when it became clear that Opus's strongest
  authorial output came not from racing the clock in 5-second windows
  but from composing across the whole track and then critiquing its own
  output.

The deeper shift was conceptual. The project now uses Opus in two
complementary temporal stances: improviser when time is live,
composer-and-self-editor when time can be planned across. That shift,
more than any single feature, is what made Opus 4.7 feel like a creative
medium rather than a tool — a collaborator whose temperament changes
with the time you give it.

## Prize framing

| Prize | Why this submission fits |
|---|---|
| **Most Creative Opus 4.7 Exploration** *(primary)* | Opus is the live authoring layer of an artwork, not a helper. The piece treats the model's averaged visual priors as material to compose with rather than a flaw to optimise away. |
| **Keep Thinking** *(secondary)* | The same architecture became two pieces: a live improvisor and an offline composer-and-self-editor. The submission is the same code-base under two temporal stances. |

Not targeted: **Managed Agents.** The piece is a single model in a tight
relationship with the music. Introducing autonomous agents would have
changed what the project is about.

## Running it

See the top-level [`README.md`](../README.md) for setup, corpus
generation, live/API run commands, bake-mode commands, replay, and
validation. See [`docs/SUBMISSION.md`](SUBMISSION.md) for the public
runbook with rubric alignment, demo shape, and exact capture commands.
