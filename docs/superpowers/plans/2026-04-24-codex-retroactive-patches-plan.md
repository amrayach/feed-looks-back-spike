# Codex Retroactive Patches — Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to work this plan tier-by-tier. Each tier ends with `node src/run_spike.mjs --self-test` plus the full module sweep; all must stay green before moving to the next tier.

**Goal:** Close the Codex gate on Phases 4 and 6 and address the findings the retroactive review surfaced. Two Phase-6 security blockers, six majors across Phase 4 and Phase 6, one Phase-4 medium, a set of missing invariant tests, plus docs-accuracy corrections (Tier 5 — shipped in this commit alongside this plan).

**Date:** 2026-04-24
**Branch:** `codex-retroactive-patches` (from `main` @ `c928fcb`)
**Upstream target:** `main` via fast-forward after local verification + Codex re-review
**Status:** Ready for execution (Tiers 1–4) after this plan + Tier 5 commits are in

---

## 1. Context

Session A (2026-04-24) shipped Phases 0/3/4/6/7-scaffold to `main`. The phase-gate discipline calls for Codex review after each gate. Session A's Codex agent timed out on the Phase 4 range (`be3b936..93431b0`) and Phase 6 (`162d6af..ef3ecfb`) never received a review before handoff. The retroactive review we just completed — three parallel Codex sessions against `main` — returned:

- **Phase 4:** 0 blockers, 3 majors, 1 medium, 4 test gaps. One of the majors is a prompt-aesthetic drift (invariant #11, figurative-only), explicitly load-bearing per memory `feedback_feed_looks_back_aesthetic`.
- **Phase 6:** 2 blockers (both sandbox-escape surface), 3 majors, 8 test gaps. Phase 6 is the repo's highest-risk phase because the sandbox executes arbitrary Opus-authored code.
- **Handoff audit:** commit chain verified, 272 tests verified, no red flags in shipped code. Four inaccuracies in `SESSION_A_HANDOFF.md` (commit counts, missing file inventory rows, stale phase-5 state) and one spec-vs-code drift (`/vendor/p5.min.js` in the spec vs the `/vendor/p5/p5.min.js` namespaced path the implementation actually uses).

The phase-5 branch is still unmerged at `97c11dd`; this patch round must land on `main` **before** the phase-5 rebase so phase-5 rebases once against a clean base. None of the patch-target files overlap with phase-5's scope (`opus_client.mjs`, `packet_builder.mjs`, `image_content.mjs`, `self_frame.mjs`, `canon/*`, `mood_board.json`, the cycle-loop body of `run_spike.mjs`).

---

## 2. Non-goals

- Not implementing anything new from the Session I spec. Every change here is a fix to already-shipped Phase 4 / Phase 6 code.
- Not touching Phase 5 files. Enforced by the file ownership invariant (§3 of `SESSION_A_HANDOFF.md`).
- Not deferring the figurative-prompt fix. The "geometric pulse" examples currently steer Opus toward the exact aesthetic class memory `feedback_feed_looks_back_aesthetic` forbids.
- Not changing the spec's design, only its text where it has drifted from the implementation (Tier 5).
- Not running the Phase 7 production run. That stays user-triggered and happens after phase-5 has been merged.

---

## 3. Execution order (strict)

Each tier is a commit or small commit-chain. The order is load-bearing: security blockers land first so the sandbox is actually safe before anyone downstream (phase-5 rebase, Phase 7 run) exercises it. Tier 5 (docs accuracy) ships in the same commit-chain as this plan so the handoff is correct when the patch round begins.

```
Tier 5  → docs-accuracy fixes (this commit-chain)   [no tests needed]
Tier 1  → Phase 6 security blockers                  [security-critical]
Tier 2  → Phase 4 + Phase 6 correctness majors       [correctness]
Tier 3  → Phase 4 aesthetic + rest-state             [aesthetic, load-bearing]
Tier 4  → Missing invariant tests (fold into tiers 1–3 where natural)
Tier 6  → Codex re-review of the resulting diff       [gate]
Tier 7  → Push main, signal phase-5 rebase            [merge coordination]
```

Tiers 4 and 6 are numbered for cross-reference; in practice tier-4 tests land alongside the code they cover, and tier-6 is a review gate, not a code change.

---

## 4. Tier 1 — Phase 6 security blockers

**Must land before any phase-5 rebase or Phase 7 run.** Both blockers share a root cause: the current sandbox uses an `srcdoc` iframe with an attribute-only CSP (`csp=`) and `postMessage(..., "*")` with no origin/source checks. The attribute CSP is not a strong boundary (browser support is partial and server-enforced HTTP CSP is the portable answer), and `srcdoc` iframes inherit the embedding origin or `null`, which breaks origin validation on return messages.

The two fixes are paired: solving blocker 2 first (give the iframe a same-origin HTTP URL) is what makes blocker 1's origin checks meaningful.

### Fix 2 — real `/p5/sandbox` HTTP route with server-enforced CSP

**Files:** `node/src/stage_server.mjs`, `node/browser/p5_sandbox.mjs`

**Change shape:**

1. Move the inline sandbox HTML template out of `p5_sandbox.mjs` into either a constant in `stage_server.mjs` or a new file under `node/browser/p5_sandbox_template.html` that `stage_server.mjs` reads at startup. Keep the two sentinel placeholders (`/*__FLB_P5_SOURCE__*/`, `/*__FLB_USER_SKETCH__*/`) — template substitution still happens server-side per request.
2. Add a GET handler for `/p5/sandbox` in `stage_server.mjs`. The handler:
   - Requires query params `sketch_id` and `slot` (plus whatever else the host currently passes via srcdoc)
   - Reads sketch code from an in-memory per-run map (populated by the host when a tool-call emits a sketch patch; keyed by `sketch_id`)
   - Substitutes the two sentinels
   - Responds with `Content-Type: text/html; charset=utf-8` and an **HTTP** `Content-Security-Policy` header (see directives below)
3. Change iframe mount in `p5_sandbox.mjs` from `srcdoc=<template>` to `src="/p5/sandbox?sketch_id=<id>&slot=<slot>"`. Keep `sandbox="allow-scripts"`. **Drop the iframe `csp=` attribute** — the HTTP header replaces it.

**CSP directive set:**

```
default-src 'none';
connect-src 'none';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
img-src 'self' data: blob:;
style-src 'unsafe-inline';
script-src 'self' 'unsafe-eval';
```

- `script-src 'self'` permits the vendored `/vendor/p5/p5.min.js` and the inline bridge (bridge must live in a sourced `<script src>` served from `/p5/bridge.mjs` or similar, or the directive picks up a nonce — pick one strategy and stick to it).
- `'unsafe-eval'` is required because the bridge instantiates the user sketch via `new Function(code)(...)` or similar. This is acceptable inside a same-origin-isolated sandboxed iframe because `allow-same-origin` is absent, so `eval`'d code has no parent DOM or cookie access.
- `connect-src 'none'` forbids fetch/XHR/WebSocket egress. Feature frames still arrive via postMessage, which bypasses `connect-src`.
- `frame-src 'none'` forbids nested iframes (defense against sketch-inside-sketch escalation).
- `img-src 'self' data: blob:` permits canvas `drawImage` from data URLs and runtime-built blobs; `'self'` allows loading run-dir images if a sketch ever fetches them (extend the allowlist if that use case is wanted).

**Tests to add** (invariant 3, test gap 2):

- `stage_server.mjs` self-test: GET `/p5/sandbox?sketch_id=test&slot=bg` returns 200, body contains sentinel-substituted HTML, **and** the response carries a `content-security-policy` header whose value includes each of the directives above.
- Negative: GET `/p5/sandbox` without required query params returns 400.
- Regression: the existing `sandbox="allow-scripts"` attribute is preserved (no `allow-same-origin` regression).

### Fix 1 — origin + source checks on both ends of the postMessage boundary

**Files:** `node/browser/p5_sandbox.mjs` (host side + iframe bridge code embedded in the template)

**Change shape:**

Host side (in `p5_sandbox.mjs`, the message listener):

```js
const expectedOrigin = window.location.origin;

window.addEventListener('message', (event) => {
  if (event.origin !== expectedOrigin) return;
  const iframe = iframeForSlot(event.source);
  if (!iframe) return;                          // unknown source
  if (event.source !== iframe.contentWindow) return;
  // existing validated-Zod dispatch
});
```

And for outgoing posts:

```js
iframe.contentWindow.postMessage(message, expectedOrigin);
// not "*"
```

Iframe bridge side (template/bridge module):

```js
const parentOrigin = window.location.origin;  // same-origin because of Fix 2

window.addEventListener('message', (event) => {
  if (event.origin !== parentOrigin) return;
  if (event.source !== window.parent) return;
  // existing heartbeat/feature dispatch
});

window.parent.postMessage(heartbeatOrReady, parentOrigin);
```

**Tests to add** (invariant 9, test gap 9):

- Host-side unit test: a `MessageEvent` dispatched from a different `origin` is ignored (listener does not invoke the Zod validator or dispatch).
- Host-side unit test: a `MessageEvent` whose `source` is a non-iframe window is ignored.
- Bridge-side unit test (via FakeDocument or a small harness): same-origin mismatch from the bridge's perspective short-circuits.

**Interaction note:** the bridge lives inside the HTML the server sends for `/p5/sandbox`. It is NOT imported from `/browser/p5_sandbox.mjs` — the browser-side module is the *host*, and there's a separate small bridge script baked into the sandbox HTML. The browser-safe-guard pattern applies equally to both.

---

## 5. Tier 2 — correctness majors (Phase 4 + Phase 6)

### Fix 3 — strict Zod schema in `validateReactivity()`

**File:** `node/src/tool_handlers.mjs` (around line 17 per Codex)

**Change shape:**

- Make the binding map schema `.strict()` so unknown keys are rejected, not silently stripped.
- Make the outer reactivity-record schema also `.strict()` (or pair it with a `.refine` that rejects non-map value types).
- Require `smoothing_ms` to be `.nonnegative().finite()`. Negative values currently survive validation and get coerced downstream.
- Ensure every finite-number field uses `.finite()` (rejects `Infinity`, `-Infinity`, `NaN`).

**Tests to add** (invariant 4, test gap 1):

- A binding with an unknown key (e.g. `{feature, in, out, bogus_field}`) rejects the tool call with a validation error.
- A binding with `smoothing_ms: -50` rejects.
- A binding with `smoothing_ms: Infinity` rejects.
- A reactivity record whose value is a non-object rejects.

### Fix 4 — hijaz_state exact-match for collapsed ranges

**File:** `node/src/binding_easing.mjs:37` (and possibly `binding_engine.mjs` depending on where the range check lives)

**Change shape:**

When `map.in = [N, N]` (collapsed range):

- For discrete state features (specifically `hijaz_state`), the mapping fires only when the feature's numeric encoding equals `N` exactly. `N !== value` → return `map.out[0]` (rest endpoint).
- For continuous features, a collapsed range is meaningless; current behavior of clamping to `map.out[0]` or `map.out[1]` is fine but must be deterministic.

The generalization Codex recommended is the cleaner answer: **treat any collapsed `map.in` as exact-match equality**, not threshold. That removes the hijaz-state special case from the engine and keeps the easing library free of domain knowledge about which features are discrete.

**Tests to add** (invariant 7 collateral):

- `hijaz_state = "tahwil"` with `map.in = [3, 3]` fires (returns `map.out[1]`).
- `hijaz_state = "aug2"` with `map.in = [3, 3]` does NOT fire (returns `map.out[0]`). This is the regression test the Codex finding called for — currently `aug2` would trigger because `4 >= 3`.
- A continuous feature with collapsed `map.in = [0.5, 0.5]` is deterministic and documented.

### Fix 5 — retire thrown sketches and mount figurative fallback

**Files:** `node/browser/p5_sandbox.mjs` (host + bridge error path), `node/browser/stage.html` (wire `onSketchError` + `onRetire`)

**Change shape:**

- Extract a common `retireAndReplace(slot, reason)` function in `p5_sandbox.mjs`. It (a) unmounts the iframe, (b) frees the slot in the host-side state, (c) invokes `onRetire` and `onSketchError` callbacks so the reducer and stage.html can re-render, (d) mounts a figurative fallback (simple DOM element depicting a recognizable motif; not a p5 sketch — avoids the same error cascading).
- The heartbeat-timeout path calls `retireAndReplace(slot, "heartbeat-timeout")`.
- The new error path (bridge posts `{type:"error", message, stack}`) calls `retireAndReplace(slot, "sketch-error")`.
- `stage.html` wires both callbacks so operator_views does not drift (operator HTML does not render p5, so this is stage-html-only).

**Tests to add** (invariant 5, test gap 5):

- A simulated `{type:"error"}` postMessage triggers retire + fallback mount.
- Assertion: heartbeat-timeout path and error path both route through the same `retireAndReplace` function (not two independent code paths).

### Fix 6 — `sketch_id` on `sketch.background.set`

**Files:** `node/src/patch_protocol.mjs:103`, `node/src/patch_emitter.mjs:119-130`, `node/browser/scene_reducer.mjs:244-253, 275-283`

**Change shape:**

- Extend the `SketchBackgroundSetPatchSchema` to require a `sketch_id` string field.
- `patch_emitter.mjs` sets `sketch_id` from `scene_state.p5_background.id` (or mints a fresh server-side id before the emit if none exists).
- `scene_reducer.mjs` stops inventing `background_${Date.now()}` and uses the patch's `sketch_id`.
- `mountBackground` retires any existing background iframe (by its stored server-side id) before mounting the new one, guaranteeing the single-slot invariant.

**Tests to add** (Phase 6 invariant 1 collateral):

- Two consecutive `setP5Background` calls result in exactly one live background iframe, and the retire patch targets the first sketch's server-side id (not a host-invented timestamp id).

### Fix 7 — check-in vendored p5

**Files:** `node/vendor/p5/p5.min.js` (new, checked in), `node/src/stage_server.mjs:90-91`, possibly `node/.gitignore`

**Change shape:**

- Copy `node/node_modules/p5/lib/p5.min.js` (963 KB, `p5@2.2.3`) to `node/vendor/p5/p5.min.js`. Checked-in file, not a gitignored runtime artifact.
- Update `stage_server.mjs` to serve from `node/vendor/p5/p5.min.js`, not `node/node_modules/...`.
- `node/vendor/p5/README.md` documents the source version, license (LGPL-2.1 for p5), and refresh procedure.
- Keep `p5` in `node/package.json` as a dev-time convenience (so `pnpm install` still works for developers) but the runtime serve path is the vendored file.

**Tests to add** (Phase 6 invariant 4, test gap 4):

- `stage_server.mjs` self-test asserts `GET /vendor/p5/p5.min.js` returns the checked-in file's bytes (match a checksum or length from the committed file, not `node_modules`).
- Repo-wide grep assertion: no source file under `node/` references a `cdnjs.cloudflare.com` or `cdn.jsdelivr.net` p5 URL.

---

## 6. Tier 3 — Phase 4 aesthetic + rest-state

### Fix 8 — de-geometrify reactive prompt guidance

**Files:** `node/prompts/hijaz_base.md:498` (reactivity examples section), `node/prompts/configs/config_a/tools.json:74`

**Change shape:**

Current text canonizes "thin halo ring" and "pulsing line" as recommended reactive moves. Both are textbook abstract-reactive tropes that violate `feedback_feed_looks_back_aesthetic`. Replace with figurative exemplars the spec already approves:

- A candle flame's `scale` and `opacity` bound to `amplitude` — the flame flickers, staying a flame.
- Leaves on a branch whose `rotation` binds to `onset_strength` — they tremble with the phrase, staying leaves.
- Breath rising from a sleeping animal whose `translateY` binds to `hijaz_intensity` — the motion is figurative, the thing motioning is recognizable.

The replacement must be explicit in the tool-description text so Opus sees it at every tool-call decision point, not just in the long prompt.

**Tests to add** (invariant 8, test gap 8):

- Prompt-regression test: a grep over `node/prompts/hijaz_base.md` and `node/prompts/configs/config_a/tools.json` finds zero occurrences of `"halo ring"`, `"pulsing line"`, `"flow field"`, `"particle"`, `"noise field"`. (Use a curated forbidden-list; keep it updated as the aesthetic vocabulary evolves.)

### Fix 9 — authored-endpoint rest state

**File:** `node/browser/binding_engine.mjs:42`

**Change shape:**

- Rest-state initialization uses `map.out[0]` (the authored rest endpoint), not `Math.min(map.out[0], map.out[1])`. This lets authors write `map.out = [1, 0]` to create a "descend from rest" animation where the rest pose is 1.
- Covers the late-mount case where an element's reactivity is attached after the feature bus has already received frames — the initial DOM state must use the authored rest, not the numeric minimum.

**Tests to add:**

- `map.out = [1, 0]` with feature value at rest produces element state of 1, not 0.
- Late-mount: element mounts after feature bus has received several frames → initial DOM state matches `map.out[0]`, then updates correctly on next feature frame.

---

## 7. Tier 4 — remaining invariant test gaps

Fold these into the tier where the related fix lands. Listed here so none slip:

- **Invariant 1 (feature vocabulary identity):** a single assertion that reads `FEATURE_NAMES` from `patch_protocol.mjs`, the vocabulary from `feature_replayer.mjs`, and the prompt/tool surfaces — and asserts all four are byte-identical sets. Goes in `patch_protocol.mjs` self-test or a new cross-module identity test in `run_spike.mjs --self-test`.
- **Invariant 7 (reactive elements don't change operator_views):** fold into `operator_views.mjs` self-test. Assert that a scene_state with reactive elements produces identical `live_monitor.html` output to the same scene_state with the `reactivity` keys stripped.
- **Invariant 10 (postMessage-only negative):** fold into `p5_sandbox.mjs` self-test. The bridge harness should reject any attempt to read `window.parent.*` properties (the CSP + `allow-scripts`-only sandbox already forbids this, but the test cements it).
- **Phase 6 invariant 1 end-to-end:** a simulated 10-sketch malformed burst (via direct patch injection or tool-call chain) results in ≤3 mounted iframes. Covers both the server-side eviction and the browser reducer's belt-and-suspenders cap.

---

## 8. Tier 5 — docs accuracy (shipped with this plan)

The following edits ship alongside this plan doc in the same commit-chain on branch `codex-retroactive-patches`. No tests required (pure documentation).

### 8.1 `docs/SESSION_A_HANDOFF.md`

- **Line 8 (Phase-5 tip):** `4639eeb` → `97c11dd`; `8 commits ahead` → `9 commits ahead`; `23 commits` → `24 commits`. Add a parenthetical noting Session B has progressed since the original handoff was written.
- **Line 41 (Phase 4 count):** `(10 commits + plan)` → `(10 commits including plan)`. Codex verified the true count is 10 total, not 11.
- **Line 43 Phase 4 inventory:** add a row for `node/src/stage_server.mjs` (Phase 4 added `/shared/binding_easing.mjs` to the `/shared/` allowlist; commits `01ea35e`, `fbe8a60` per the audit).
- **Line 59 (Phase 6 count):** `(10 commits + plan)` → `(9 commits including plan)`. Verified total is 9.
- **Line 61 Phase 6 inventory:** add a row for `node/package.json` + `node/pnpm-lock.yaml` (commit `786b789` added `p5@2.2.3` via `pnpm add p5`).
- **Lines 191–194 repo-state block:** update the `main` tip to `c928fcb`, the phase-5 tip to `97c11dd`, and the divergence to `24 ↔ 9`. Note current-state timestamp.

### 8.2 `docs/superpowers/specs/2026-04-23-session-i-live-reactive-stage-design.md`

- **Line 146:** `/vendor/p5.min.js` → `/vendor/p5/p5.min.js`. The implementation uses the namespaced path under `/vendor/p5/`; the spec text was slightly off. Repo is internally consistent; only the spec line drifted.

These edits do NOT address Codex's Phase 6 Major #3 (p5 should be a genuinely checked-in `node/vendor/p5/p5.min.js`, not served from `node_modules`). That fix is **Tier 2 Fix 7** and lands when the code moves. Until then, the handoff's "vendored" characterization remains loosely accurate (it describes intent, even if the implementation is a runtime dep).

---

## 9. Tier 6 — Codex re-review

After tiers 1–4 land locally on `codex-retroactive-patches`, run a fresh Codex pass against the diff range `c928fcb..HEAD`. The prompt should focus on:

- Did the sandbox changes introduce a new escape vector? (specifically, the switch from `srcdoc` to `src="/p5/sandbox"` changes origin semantics — verify no cross-origin leakage)
- Did the strict Zod schema break any previously-valid binding shape? (if yes, it's a false tightening)
- Did the figurative-prompt rewrite introduce new abstract-reactive vocabulary elsewhere?
- Are the new invariant tests hermetic (no network, no real processes)?

If Codex returns clean, proceed to Tier 7. If Codex returns findings, address them on the same branch before the first push.

---

## 10. Tier 7 — push + signal phase-5 rebase

Only after Tier 6 returns clean:

1. `git -C /home/amay/Work/feed-looks-back-spike push origin codex-retroactive-patches`
2. Open a PR into `main` with the retroactive review findings + fixes documented in the description.
3. On merge, signal Session B to rebase phase-5 onto the new main tip. The rebase launch prompt in `PHASE_5_SESSION_HANDOFF.md` already handles this; the only change is that the `main` tip is now further ahead. Phase 5's scope does not overlap with any Tier 1-4 file except possibly `run_spike.mjs` at the cycle-loop boundary — confirm by diff before pushing.

---

## 11. Risks and rollback

**Risk 1 — unsafe-eval opens an unintended vector.** Mitigation: the iframe has `sandbox="allow-scripts"` without `allow-same-origin`, and CSP `connect-src 'none'` + `frame-src 'none'`. Arbitrary code runs but cannot reach parent DOM, cookies, other origins, or nested frames. Standard containment for untrusted code execution.

**Risk 2 — strict Zod breaks existing patch flows.** Mitigation: the self-test for Fix 3 seeds both valid and invalid shapes; a dry-run on an existing run's `patch_cache.json` catches regressions. If a previously-shipped binding shape is now rejected, that is a legitimate finding — the pre-fix schema was silently stripping keys, so any reliance on a stripped key was already broken.

**Risk 3 — figurative-prompt rewrite regresses Opus output quality.** Mitigation: a pre-flight smoke on a short corpus window (1–2 cycles real API, ~$0.05) before the push. Compare Opus output against a recent known-good run.

**Rollback:** every tier is a commit (or small commit-chain). Revert the offending commit, push, rebase phase-5, and continue. The branch stays live until merged.

---

## 12. Verification checklist

Before pushing:

- [ ] Tier 1–3 fixes all land with their associated tests
- [ ] Full module sweep green: `for f in node/src/*.mjs node/browser/*.mjs; do node "$f"; done`
- [ ] `node src/run_spike.mjs --self-test` green
- [ ] `python stream_features.py --self-test` green
- [ ] Tier 4 test gaps all closed (invariants 1, 7, 10; Phase 6 invariant 1 end-to-end)
- [ ] Tier 5 handoff + spec text verified against current repo state
- [ ] Tier 6 Codex re-review returns clean (no new blockers)
- [ ] Manual smoke: launch `stage_server` + `p5_sandbox` in Chrome, confirm CSP header is present and iframe origin checks work (`devtools → Network → /p5/sandbox → Response Headers`)

---

## Appendix A — Codex finding cross-reference

| Finding | Severity | Tier | Fix # |
|---|---|---|---|
| `postMessage(..., "*")` + no origin checks | blocker | 1 | Fix 1 |
| No `/p5/sandbox` route + no HTTP CSP | blocker | 1 | Fix 2 |
| `validateReactivity` permissive schema | major | 2 | Fix 3 |
| Collapsed `map.in` uses `>=` threshold | major | 2 | Fix 4 |
| Thrown sketches not retired | major | 2 | Fix 5 |
| Background sketch loses server-side id | major | 2 | Fix 6 |
| p5 served from `node_modules`, not vendored | major | 2 | Fix 7 |
| Reactive prompt canonizes geometric pulse | major | 3 | Fix 8 |
| Rest-state uses `Math.min(map.out)` | medium | 3 | Fix 9 |
| Handoff commit counts + inventories stale | audit | 5 | §8.1 |
| Spec drift `/vendor/p5.min.js` | audit | 5 | §8.2 |

---

## Appendix B — test gap cross-reference

| Gap | Invariant | Tier | Folded into |
|---|---|---|---|
| Feature vocabulary identity | 1 | 4 | `patch_protocol.mjs` |
| Reject extra binding keys + negative smoothing | 4 | 2 | Fix 3 tests |
| Reactive elements don't change operator_views | 7 | 4 | `operator_views.mjs` |
| Figurative prompt regression | 8 | 3 | Fix 8 test |
| End-to-end N=3 burst | P6 #1 | 4 | `scene_reducer.mjs` |
| `/p5/sandbox` HTTP CSP headers | P6 #3 | 1 | Fix 2 test |
| Vendored-p5 assertion | P6 #4 | 2 | Fix 7 test |
| Thrown-sketch retire + fallback | P6 #5 | 2 | Fix 5 test |
| postMessage origin/source | P6 #9 | 1 | Fix 1 test |
| Negative: no parent/window access | P6 #10 | 4 | `p5_sandbox.mjs` |

---

**End of plan.** Execute tier-by-tier on this branch. After Tier 7, the Phase 4/Phase 6 Codex gate is closed and `main` is ready for phase-5 rebase.
