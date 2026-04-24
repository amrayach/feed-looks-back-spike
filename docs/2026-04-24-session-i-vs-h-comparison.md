# Session I vs Session H — Comparison

**Document date:** 2026-04-24
**Session H baseline run:** `node/output/run_20260423_185946/` (captured 2026-04-23)
**Session I production run:** *pending Amer-triggered production run (see Phase 7 plan)*

This document compares the Session H Feed Looks Back spike — the last pre-Session I checkpoint where the stage was static HTML snapshots and Opus had six tools (addText, addSVG, addImage, setBackground, fadeElement, addCompositeScene) — against the Session I pipeline with live reactivity, p5 sketches, feature streams, mood-board perception, and self-frame capture feedback.

The quantitative and capability tables are populated; the aesthetic section is scaffolded and left blank pending Amer's side-by-side review after the Session I production run lands.

---

## 1. One-paragraph summary

*(Populate after production run.)*

> Session I shifted Feed Looks Back from a per-cycle static-HTML stage to a live audio-reactive browser surface driven by a WebSocket patch protocol. Opus now sees what it's made (mood board + self-frame) and composes against live audio features (amplitude, onset, centroid, hijaz_*); the stage renders those compositions as reactive DOM elements and sandboxed p5 sketches that respond to the music at ~60 Hz. The baseline Session H run was a well-composed but fundamentally static scene; the Session I target is to preserve that compositional discipline while adding temporality — the scene should read as alive with the music, not just illustrated by it.

---

## 2. Quantitative comparison

| Metric | Session H (`run_20260423_185946`) | Session I (`run_session_i_smoke`) | Delta |
|---|---|---|---|
| Cycles completed | 31 / 31 | — | — |
| Status breakdown (ok / api_fail / parse_fail / persist_fail / tool_errors) | 31 / 0 / 0 / 0 / 0 | — | — |
| Tool calls total | 54 | — | — |
| Cycles with ≥ 1 tool call | 31 | — | — |
| Silent cycles | 0 | — | — |
| Cost (USD) | $1.1336685 | — | — |
| Mean tool calls / cycle | 1.74 | — | — |
| Session-duration (s, wall clock) | ~160 (1 cycle / 5 s × 31 cycles + API latency) | — | — |

### 2.1 Tool-call mix

| Tool | Session H count | Session I count | Δ |
|---|---|---|---|
| addText | — (extract from opus_log) | — | — |
| addSVG | — | — | — |
| addImage | — | — | — |
| setBackground | — | — | — |
| fadeElement | — | — | — |
| addCompositeScene | — | — | — |
| **setP5Background** (new in Session I) | 0 | — | +— |
| **addP5Sketch** (new in Session I) | 0 | — | +— |

### 2.2 Reactivity usage (Session I only)

| Binding | Count | Representative target |
|---|---|---|
| opacity ← amplitude | — | text / image fade with dynamics |
| scale ← hijaz_tahwil | — | SVG ring-out impulse |
| color_hue ← hijaz_intensity | — | image drift |
| translateY ← spectral_centroid | — | lift on brightness |
| Other | — | — |

### 2.3 p5 sketch activity (Session I only)

| Kind | Count | Retirements |
|---|---|---|
| setP5Background calls | — | — |
| addP5Sketch calls | — | — |
| Sketch retirements (heartbeat timeout) | — | — |
| Sketch errors (via onSketchError) | — | — |

---

## 3. Capability comparison

| Capability | Session H | Session I | Phase introducing it |
|---|---|---|---|
| Static HTML snapshot per cycle | ✅ | ✅ (preserved for operator observability) | Pre-Session I |
| Live WebSocket stage | ❌ | ✅ | Phase 1 |
| Module split (sanitize / image_resolver / operator_views / scene_layout) | ❌ (monolithic render_html.mjs) | ✅ | Phase 2 |
| Python as sole feature extractor | ❌ | ✅ | Phase 3 |
| feature_bus (browser pub/sub for audio features) | ❌ | ✅ | Phase 3 |
| feature_replayer (pre-recorded mode sync) | ❌ | ✅ | Phase 3 |
| Live-mode stream_features.py with iD14 | ❌ | ✅ | Phase 3 |
| ReactivitySchema + per-tool reactivity param | ❌ | ✅ | Phase 4 |
| binding_engine (60 Hz DOM property lerp) | ❌ | ✅ | Phase 4 |
| Mood board canon + perception | ❌ | ✅ | Phase 5 |
| Self-frame capture for visual feedback | ❌ | ✅ | Phase 5 |
| Vendored p5.js + CSP-sandboxed iframes | ❌ | ✅ | Phase 6 |
| setP5Background + addP5Sketch tools | ❌ | ✅ | Phase 6 |
| hijaz_state enum gating for bindings | ❌ | ✅ | Phase 4 |
| Heartbeat watchdog for sketches | ❌ | ✅ | Phase 6 |
| patch_cache.json WebSocket replay | ❌ | ✅ | Phase 1 |

---

## 4. Aesthetic observations *(pending Amer review)*

### 4.1 Does the Session I scene feel alive?

*(Amer's answer here, verbatim.)*

### 4.2 Did Opus respect the figurative-only rule for p5 sketches?

Quick filter check (automated):
- Scan each `setP5Background` and `addP5Sketch` code field for anti-pattern strings: `particles`, `flowField`, `noise(`, `perlin`, `for (let i = 0; i < 1000`. Flag any match for manual review.

*(Count + specific offenders here.)*

### 4.3 Does the reactivity track the music legibly?

*(Amer's answer here. Prompt: "Play the recording and watch the stage — is the opacity / scale / color response something you can feel as tied to the music, or does it read as generic audio-visualizer flicker?")*

### 4.4 What did Opus avoid in Session I that Session H would have attempted?

*(Amer's observations on compositional self-restraint.)*

### 4.5 What does Session I afford that Session H could not express?

*(Amer's observations on new expressive vocabulary — e.g. a passage where the background is a p5 textile rippling slowly + a text element pulsing on each onset + an SVG line scaling on tahwil.)*

---

## 5. Failure-mode notes

*(Populate after production run.)*

- Were any cycles degraded but not failed (e.g., p5 sketch retired via heartbeat)?
- Were any reactivity params malformed and rejected by tool_handler?
- Did the stage reconnect cleanly if the browser was refreshed?
- Did `--feature-producer none` correctly skip the Python spawn?

---

## 6. Known limitations in the Session I run

These are acknowledged in spec §15 and the plans; they do not invalidate the production run.

- **Live-mode Hijaz state is simplified** — `quiet | approach` threshold by amplitude only; full tonal-gravity + aug2 + phrase-break integration is deferred to Phase 8+ (requires a streaming FileStatistics buffer).
- **Browser scope is Chrome** — spec §15 explicitly excludes Firefox / Safari; iframe `csp` attribute behavior is not portable.
- **p5 vendoring inlines the 963 KB source into each iframe srcdoc** — fine for N ≤ 4 iframes; a shared-blob delivery is Phase 8+.
- **Enum features in reactivity maps are numerically encoded** (`hijaz_state`: quiet=0, approach=1, arrived=2, tahwil=3, aug2=4) — an enum-aware `equals` operator is cleaner but out of scope.

---

## 7. Run artifact pointers

*(Fill in after run completes.)*

- Session I run dir: `node/output/run_<timestamp>/`
- Key artifacts:
  - `run_summary.json`
  - `scene_state.json`
  - `final_scene.html`
  - `live_monitor.html`
  - `patch_cache.json`
  - `features_track.json`
  - `scene_state_log/cycle_NNN.json`
  - `opus_log/cycle_NNN.json`

Session H baseline artifacts for comparison: `node/output/run_20260423_185946/`.

---

## 8. Close

The Session I production run marks the close of the 7-phase arc. Follow-up work tracked as Phase 8+ candidates:

- Online Hijaz detector for live mode (spec §15 open risk)
- Shared-blob p5 vendor delivery (Phase 6 optimization)
- Enum-aware reactivity `equals` operator (Phase 4 follow-up)
- Prompt iteration driven by Session I's actual patterns (post-production observation)
- Second real-audio sample beyond Sample 1 for detector coverage (tahwil/aug2 currently don't fire on Sample 1; Bashar's canonical recording when available)

Session I design spec: `docs/superpowers/specs/2026-04-23-session-i-live-reactive-stage-design.md`
Full phase plans: `docs/superpowers/plans/2026-04-23-session-i-phase-{1,2}-*` + `docs/superpowers/plans/2026-04-24-session-i-phase-{3,4,5,6,7}-*`
