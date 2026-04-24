# Coordinator Session (2026-04-24) — Handoff

**Role of this session:** coordinator/meta — not an implementation session. Responsible for launching parallel sub-sessions (Session A, Session B, first rework session), running retroactive Codex reviews, running Tier 6 Codex re-review, writing the two plan docs, responding to review findings, and producing launch prompts for downstream sessions. No code written; only plan docs and doc-accuracy fixes.

**Control directory (cwd):** `/home/amay/Work/build_spikes_tests`
**Target repo:** `/home/amay/Work/feed-looks-back-spike`
**Branch at handoff:** `codex-retroactive-patches` @ `68f2669` (local, not pushed)
**Phase-5 branch:** `97c11dd` (pushed to `origin/phase-5`, PR #1 open, unmerged)
**Main at handoff:** `c928fcb` (pushed to `origin/main`)

---

## 1. Session narrative — what happened

### 1.1 Parallelization planning (top of session)
User asked how to split remaining Session I work (Phases 3–7) across parallel sessions. Analysis of file-level contention identified:
- Phase 3 → Phase 4 is a hard serial dependency (feature bus → binding engine)
- Phase 6 shares `tool_handlers.mjs`, `scene_state.mjs`, `scene_reducer.mjs` with Phase 4 → serial
- Phase 5 (perception) is disjoint from Phase 3/4/6 files → parallel candidate
- Phase 7 is the final comparison run → after everything

Decision: **2 parallel sessions** — Session A (main worktree, sequential Phases 3→4→6→7-scaffold), Session B (phase-5 worktree, Phase 5 only). Git worktrees set up:
- `/home/amay/Work/feed-looks-back-spike` → main → Session A
- `/home/amay/Work/feed-looks-back-spike-phase-5` → phase-5 branch → Session B

Both sessions launched from `/home/amay/Work/build_spikes_tests` (control dir) so they shared memory, MCP config, and skills.

### 1.2 Session A + Session B execution (parallel)
Both sessions ran to completion:

**Session A** shipped Phases 0/3/4/6/7-scaffold at `c928fcb` on `main`:
- Phase 0: closed the Phase 2 gate with a retroactive Codex pass
- Phase 3: audio feature pipeline (feature_bus, feature_replayer, stream_features.py), Codex-reviewed, 10 commits
- Phase 4: reactivity (binding_engine, binding_easing, reactivity parameter) — **Codex agent timed out at 233 s; Session A self-reviewed and pushed without completing the review**
- Phase 6: p5 sandbox (iframe with sandbox=allow-scripts, postMessage bridge, vendored via pnpm, watchdog, N=3 enforcement) — **Session A ran out of time to run Codex; no review**
- Phase 7: plan + comparison scaffold only (no production run)

Shipped 272 tests green. Authored its own handoff: `docs/SESSION_A_HANDOFF.md`.

**Session B** shipped Phase 5 at `97c11dd` on `phase-5`:
- image_content.mjs (mood board loader + triggers + user-block builder)
- self_frame.mjs (Playwright headless capturer)
- opus_client.mjs adaptive thinking + cache_control on stable prefix
- packet_builder.mjs content-block assembly
- canon/ figurative SVG placeholders + mood_board.json
- run_spike.mjs narrow cycle-end self-frame hook
- Dependencies: playwright + sharp

9 commits total, Codex-reviewed once (2 legitimate mediums fixed, 1 stale-rebase phantom), 233 tests green. PR #1 open on GitHub against main. Authored: `PHASE_5_SESSION_HANDOFF.md` on branch `phase-5`.

### 1.3 Retroactive Codex review (3 parallel sessions)
Because Session A skipped Codex on Phase 4 + Phase 6, the coordinator session ran 3 parallel Codex passes from `/home/amay/Work/feed-looks-back-spike`:

| Target | Scope | Sev | Findings |
|---|---|---|---|
| Phase 4 retroactive | `be3b936..93431b0` | 0 B / 3 M / 1 med / 4 test gaps | permissive `validateReactivity`; collapsed `map.in` fires on `>=` not `===`; reactive-prompt examples canonize "halo ring" / "pulsing line"; rest-state uses `Math.min(map.out)` |
| Phase 6 retroactive | `162d6af..ef3ecfb` | **2 B** / 3 M / 8 test gaps | `postMessage(..., "*")` + no origin/source checks; iframe `csp=` attribute with no HTTP CSP header; thrown sketches don't retire; background sketch_id lifecycle broken; p5 served from `node_modules/p5/` not `vendor/`; broad test coverage gaps |
| Handoff audit | SESSION_A_HANDOFF.md claims | 0 B / 0 M, 4 inaccuracies + 1 spec drift | Phase 4 + Phase 6 commit counts off by one; stage_server.mjs missing from Phase 4 inventory; package.json + pnpm-lock.yaml missing from Phase 6 inventory; phase-5 state stale; spec `/vendor/p5.min.js` drift |

### 1.4 First retroactive patches plan + Tier 5 docs fix
Coordinator authored `docs/superpowers/plans/2026-04-24-codex-retroactive-patches-plan.md` (392 lines) on a new branch `codex-retroactive-patches` off `main`. Committed at `6739cda` alongside the Tier 5 doc-accuracy edits (Phase 4 + Phase 6 commit counts, stage_server.mjs + package.json rows added, phase-5 state refreshed, spec path drift fixed).

### 1.5 Tier 1–4 execution (first rework session)
Launched a fresh Claude Code session with a comprehensive launch prompt. That session landed 10 commits (`54f1218..fc38ab4`):

| Commit | Fix | Description |
|---|---|---|
| `54f1218` | Tier 1 Fix 2 | `/p5/sandbox` HTTP route with server-side CSP + `/p5/bridge.js` |
| `c49f143` | Tier 1 Fix 1 | Origin + source gate on sandbox postMessage |
| `d1cc03e` | Tier 2 Fix 3 | `strict()` + `finite()` + `nonnegative()` on ReactivitySchema |
| `9f22af5` | Tier 2 Fix 4 | Collapsed `map.in` = exact-match |
| `6eb6d2f` | Tier 2 Fix 5 | Retire thrown sketches with candle-flame SVG fallback |
| `3e73e06` | Tier 2 Fix 6 | Real sketch_id end-to-end on `sketch.background.set` |
| `9892bc5` | Tier 2 Fix 7 | Vendored `p5.min.js` at `node/vendor/p5/` (963 KB, v2.2.3, LGPL-2.1) |
| `fe6279a` | Tier 3 Fix 8 | De-geometrify reactive exemplars; new `prompts_aesthetic.mjs` guard |
| `07d2114` | Tier 3 Fix 9 | `restValueForBinding` returns `out[0]` verbatim |
| `fc38ab4` | Tier 4 | Cross-module invariant regression suite (`invariants.mjs`) |

Reported 304 tests green. Branch stayed local, never pushed.

### 1.6 Tier 6 Codex re-review
Coordinator ran a single Codex session from `/home/amay/Work/feed-looks-back-spike` with `--sandbox read-only` against diff `c928fcb..HEAD`. **Verdict: "Rework before push".**

| # | Sev | What | Where |
|---|---|---|---|
| 1 | **blocker** | `postMessage(..., "*")` still present across host + bridge | `p5_sandbox.mjs:179`, `p5_bridge.js:40,56` |
| 2 | major | Background replacement still depends on preceding `sketch.retire` patch | `scene_reducer.mjs:244,611`, `p5_sandbox.mjs:338` |
| 3 | major | Prompt guard weakened; forbidden aesthetic terms still in Opus-visible text | `hijaz_base.md:582`, `tools.json:251,257`, `prompts_aesthetic.mjs:38,87` |
| 4 | major | Tier 4 invariants 1, 10, and P6-E2E don't assert what their names claim | `invariants.mjs:50,160,189` |
| 5 | minor | Spec §7.3 + §13.4 still describe srcdoc + csp= + node_modules vendoring | `2026-04-23-session-i-live-reactive-stage-design.md:307,320,573` |

**Key architectural insight:** the blocker's root cause is that `sandbox="allow-scripts"` (without `allow-same-origin`) forces the iframe's effective origin to the literal string `"null"`, regardless of the src URL. `targetOrigin` cannot name an opaque origin, so the executing session kept `"*"` deliberately rather than as an oversight. The fix is not a stricter origin string — it's **replacing `postMessage` with `MessageChannel` capability transfer**. One wildcard remains on the load-event port-handoff post (unavoidable) but is protected by `event.source`, Zod shape, and a single-shot listener.

### 1.7 Tier 6 rework plan
Coordinator authored `docs/superpowers/plans/2026-04-24-tier-6-rework-plan.md` (487 lines) committed at `68f2669`. Sequences five rework tiers:

- R1: MessageChannel refactor (blocker)
- R2: browser-side retire-before-mount (major)
- R3: prompt scrub + strict-grep restoration (major)
- R4: strengthened invariant tests (3 sub-fixes, major)
- R5: spec §7.3 + §13.4 rewrite (minor)
- R6: focused Codex pass on `fc38ab4..HEAD`
- R7: push + PR

Plan includes code snippets for the MessageChannel pattern, per-fix commit message templates, file-touch lists, and a verification checklist.

### 1.8 Launch prompt drafted (not yet used)
Coordinator drafted the launch prompt for a fresh session to execute R1–R5. The prompt is captured in §5 of this handoff for the next session to use.

### 1.9 Real-API run discussion
User asked how close they are to a real-API run. Analysis:

| Target | Remaining | Cost | Wall |
|---|---|---|---|
| Quick API smoke on main (functional path) | **nothing** | ~$0.10–$0.30 | 10 min |
| Quick API smoke with Phase 5 perception | rework + push + phase-5 rebase + merge | ~$0.30 | ~4–5 hrs |
| Full Phase 7 production run | above + pre-flight smoke + run | ~$1–2 | ~6 hrs |

Key insight: the Codex blockers are **adversarial-input** blockers (sandbox escape), not happy-path blockers. A cooperative-input smoke by the user works today on `c928fcb` or `68f2669` identically.

### 1.10 Branch switching guidance
User asked how to switch to main for the smoke. Coordinator confirmed the working tree is clean except two untracked review artifacts (`.codex`, `node/.codex-preflight-write-check`) that survive branch checkouts. Gave checkout commands. Clarified that the rework branch is functionally identical to main for runtime (all branch commits are docs-only).

---

## 2. Current repo state

### 2.1 Branches

```
main                            c928fcb  pushed to origin/main
codex-retroactive-patches       68f2669  local only, 12 commits above main
phase-5                         97c11dd  pushed to origin/phase-5, PR #1 open
```

### 2.2 Commits on `codex-retroactive-patches` above `c928fcb` (12)

```
68f2669  docs: Tier 6 rework plan — address Codex re-review findings          [this session]
fc38ab4  test(tier-4): cross-module invariant regression suite                [first rework]
07d2114  fix(tier-3-fix-9): restValueForBinding returns out[0] verbatim       [first rework]
fe6279a  fix(tier-3-fix-8): de-geometrify reactive-prompt exemplars           [first rework]
9892bc5  fix(tier-2-fix-7): vendor p5.min.js under node/vendor/p5/            [first rework]
3e73e06  fix(tier-2-fix-6): carry real sketch_id through sketch.background.set [first rework]
6eb6d2f  fix(tier-2-fix-5): retire crashed sketches with figurative DOM fallback [first rework]
9f22af5  fix(tier-2-fix-4): collapsed map.in uses exact-match, not threshold  [first rework]
d1cc03e  fix(tier-2-fix-3): tighten ReactivitySchema with strict+finite+nonneg [first rework]
c49f143  fix(tier-1-fix-1): origin+source gate on sandbox postMessage path    [first rework]
54f1218  fix(tier-1-fix-2): serve p5 sandbox over HTTP with server-side CSP   [first rework]
6739cda  docs: Codex retroactive patch plan + Tier 5 accuracy fixes           [this session]
```

First and last commits are docs/plans from the coordinator session. The 10 in between are code changes from the first rework session.

### 2.3 Test totals
- 272 at `c928fcb` (Session A handoff)
- 304 after first rework session (`fc38ab4`) — 30+ new assertions in Tier 4
- Target after Tier 6 rework: 308+
- Phase-5 branch: 233 at `97c11dd` (independent count)

### 2.4 Untracked artifacts (keep untracked)
- `node/.codex-preflight-write-check` — Codex preflight artifact, harmless
- `.codex` — created this session when Codex Tier 6 re-review ran; Codex session metadata

### 2.5 Key authoritative docs
| Path | Purpose |
|---|---|
| `docs/SESSION_A_HANDOFF.md` | Session A state at `c928fcb`; Tier 5 corrections applied in `6739cda` |
| `PHASE_5_SESSION_HANDOFF.md` (on `phase-5` branch) | Session B state; rebase guidance |
| `docs/superpowers/specs/2026-04-23-session-i-live-reactive-stage-design.md` | Design contract; §7.3 + §13.4 still drift (pending R5) |
| `docs/superpowers/plans/2026-04-24-codex-retroactive-patches-plan.md` | Original patches plan (Tier 1–5 structure) |
| `docs/superpowers/plans/2026-04-24-tier-6-rework-plan.md` | Rework plan (R1–R7 structure) — authoritative for next session |
| `docs/COORDINATOR_SESSION_HANDOFF_2026_04_24.md` | This document |

---

## 3. Open loops — what is not done

### 3.1 Tier 6 rework (R1–R5) — **bottleneck**
Branch has the plan doc at `68f2669` but no code commits addressing the Tier 6 Codex findings. Blocker + 3 majors + 1 minor are outstanding until the rework session runs. Estimated ~3 hours of focused session work.

### 3.2 Tier 6 focused Codex pass (R6)
Scoped to `fc38ab4..HEAD` after rework lands. Small diff (~300 LOC), fast pass. Must return "Ready to push" before R7.

### 3.3 Push to origin + PR (R7)
`codex-retroactive-patches` is local only. Push → open PR into main → merge. PR body should reference both plan docs + both Codex reviews + test count progression (272 → 304 → 308+).

### 3.4 Phase-5 rebase onto new main
After R7 merges, `main` is ~12 commits ahead of `phase-5`'s current divergence point. Session B's existing handoff (`PHASE_5_SESSION_HANDOFF.md`) has the rebase launch prompt. Expected conflict region: `node/src/run_spike.mjs` (Session A edits outside the cycle loop, Phase 5 edits inside — syntactically non-overlapping but needs a three-way merge).

### 3.5 Phase-5 merge via PR #1
Once rebased, force-push-with-lease and merge PR #1 into main. Expected additional conflicts: `node/package.json` + `node/pnpm-lock.yaml` — resolve with `cd node && pnpm install` post-merge.

### 3.6 Pre-flight smoke (Chrome)
Plan §12 of the retroactive patches plan + §8 / §12 of the rework plan describe the manual browser check: start `run_spike` with a long cycle range (≥200 cycles in `--dry-run` mode), open the operator URL in Chrome, verify:
- `window.__featureBus`, `__bindingEngine`, `__p5Sandbox` are live
- `/p5/sandbox` GET returns HTTP `Content-Security-Policy` header with all required directives
- Throwing a p5 sketch via DevTools console retires the iframe and mounts the candle-flame DOM fallback
- Sketch context cannot read `window.parent.*` (sandbox isolation holds)

### 3.7 Phase 7 production run
31-cycle real-API run against the Session H baseline. User-triggered, ~$1–2. Plan at `docs/superpowers/plans/2026-04-24-session-i-phase-7-production-run-plan.md`.

### 3.8 Comparison doc quantitative tables
`docs/2026-04-24-session-i-vs-h-comparison.md` has Session H numbers pre-populated, Session I column empty. Populate after Phase 7 run lands artifacts.

### 3.9 Aesthetic section of comparison doc
Pending Amer's side-by-side review per memory `user_amer_artist`.

---

## 4. Critical path to Phase 7

Minimum happy-path sequence with estimated wall-clock:

```
1. (Optional) Quick real-API smoke on current branch           10 min    ~$0.30
2. Fresh session executes R1–R5 per rework plan               ~3 hrs
3. Tier 6 focused Codex pass on fc38ab4..HEAD                  10 min
4. Push codex-retroactive-patches → PR → merge to main         15 min
5. Session B rebases phase-5 onto new main                     ~40 min
6. Merge PR #1 (phase-5) into main                             15 min
7. Pre-flight smoke in Chrome                                  20 min
8. Phase 7 production run (31 cycles, real API)                60–90 min   ~$1–2
9. Populate comparison doc quantitative tables                 20 min
──────────────────────────────────────────────────────────
Total to completed Phase 7 artifacts:                         ~6–7 hours   ~$2
```

Step 1 is optional and independent — does not block any subsequent step. Steps 2→8 are serial.

---

## 5. Launch prompt for next session (primary)

Paste into a fresh Claude Code session started in `/home/amay/Work/build_spikes_tests`:

```
Continue Feed Looks Back Session I coordination. The previous coordinator
session ran retroactive Codex review, authored two plan docs, and set up
the Tier 6 rework. You are picking up from a committed, stable state.

CONTROL DIR (cwd): /home/amay/Work/build_spikes_tests
TARGET REPO (absolute paths; DO NOT cd into it): /home/amay/Work/feed-looks-back-spike
BRANCH AT HANDOFF: codex-retroactive-patches @ 68f2669 (local only)
MAIN AT HANDOFF: c928fcb
PHASE-5 BRANCH: 97c11dd (origin/phase-5, PR #1 open, unmerged)

READ FIRST, in order:
  1. /home/amay/Work/feed-looks-back-spike/docs/COORDINATOR_SESSION_HANDOFF_2026_04_24.md
     — authoritative state dump from the previous coordinator session.
     Has the full session narrative, open loops, and critical-path plan.
  2. /home/amay/Work/feed-looks-back-spike/docs/superpowers/plans/2026-04-24-tier-6-rework-plan.md
     — the rework execution plan. R1–R7 structure, code snippets, tests.
  3. /home/amay/Work/feed-looks-back-spike/docs/SESSION_A_HANDOFF.md §3
     — 12 load-bearing invariants to preserve.

CHECK MEMORY:
  - feedback_codex_review_pattern (verify findings, patch, re-review)
  - feedback_feed_looks_back_aesthetic (figurative not abstract; load-bearing)
  - project_feed_looks_back_session_i (Session I spec status)
  - reference_claude_api_skill (defaults: opus-4-7, adaptive thinking)
  - user_amer_artist (comparison doc aesthetic review pending)

OPERATING RULES:
  - Absolute paths only under /home/amay/Work/feed-looks-back-spike/
  - All git: `git -C /home/amay/Work/feed-looks-back-spike <cmd>`
  - Never cd into the target repo at shell top level; inside single Bash
    calls is fine.
  - Phase-5 DO NOT TOUCH (load-bearing invariant 1):
      node/src/opus_client.mjs
      node/src/packet_builder.mjs
      node/src/image_content.mjs
      node/src/self_frame.mjs
      node/canon/*
      node/prompts/mood_board.json
      node/src/run_spike.mjs cycle-loop body (~lines 705-820)

YOUR FIRST DECISION — ask the user which to do:

  (A) Quick real-API smoke first (10 min, ~$0.30, functional validation).
      Command: cd /home/amay/Work/feed-looks-back-spike/node && \
               node src/run_spike.mjs ../corpus --config config_a --cycles 0:3
      No --dry-run. Requires ANTHROPIC_API_KEY exported. Artifacts at
      node/output/run_<timestamp>/. Read run_summary.json afterward.

  (B) Start Tier 6 rework immediately (~3 hrs compute).
      Launch a fresh implementation session with the rework prompt from §6
      of this handoff (COORDINATOR_SESSION_HANDOFF_2026_04_24.md §6). That
      session executes R1–R5, commits per tier, reports green test matrix.

  (C) Run Tier 6 focused Codex pass first (only if user wants independent
      verification before rework).
      Session-level prompt available in rework-plan §9. Single terminal,
      cd /home/amay/Work/feed-looks-back-spike, codex --sandbox read-only.

  (D) Phase-5 merge first (NOT recommended; rework landing first is cleaner).
      This would involve merging PR #1 into main before the rework, which
      means phase-5 would need to re-rebase after the rework merges later.
      Avoid unless the user has a specific reason.

MOST LIKELY PATH: user wants (A) then (B). Confirm, then execute.

IF EXECUTING THE REWORK (B):
  Dispatch the rework prompt from §6 of this handoff into a fresh Claude
  Code session (user pastes it). When that session reports completion,
  come back here to coordinate R6 Codex pass + R7 push + phase-5 signal.

DO NOT:
  - Push codex-retroactive-patches before Tier 6 Codex re-review passes
  - Merge phase-5 before the rework branch merges
  - Commit code to codex-retroactive-patches from this coordinator session
    (that's the rework session's job)
  - Run Phase 7 production before pre-flight smoke
```

---

## 6. Launch prompt for Tier 6 rework executor (sub-session)

Paste into a fresh Claude Code session started in `/home/amay/Work/build_spikes_tests`. This is the session that actually executes R1–R5.

```
Execute the Tier 6 rework for Feed Looks Back on branch codex-retroactive-patches.

CONTROL DIR (cwd): /home/amay/Work/build_spikes_tests
TARGET REPO (absolute paths; DO NOT cd into it): /home/amay/Work/feed-looks-back-spike
BRANCH: codex-retroactive-patches @ 68f2669 (local only; not pushed)
BASE: main @ c928fcb

A previous session shipped 10 retroactive patches (commits 54f1218..fc38ab4).
Codex Tier 6 re-review returned "Rework before push" with 1 blocker + 3 majors
+ 1 minor. Your job is to land R1..R5 from the rework plan so the next
focused Codex pass returns clean.

READ FIRST, in order:
  1. /home/amay/Work/feed-looks-back-spike/docs/superpowers/plans/2026-04-24-tier-6-rework-plan.md
     — authoritative. R1..R7 execution shape, per-tier code snippets, test
     additions, verification checklist. This is your execution map.
  2. /home/amay/Work/feed-looks-back-spike/docs/superpowers/plans/2026-04-24-codex-retroactive-patches-plan.md
     — the parent plan these fixes are aligning to. Reference when rework
     needs to match the original intent.
  3. /home/amay/Work/feed-looks-back-spike/docs/SESSION_A_HANDOFF.md §3
     — 12 load-bearing invariants. Every rework commit must preserve all 12.
  4. /home/amay/Work/feed-looks-back-spike/docs/superpowers/specs/2026-04-23-session-i-live-reactive-stage-design.md
     — §4 Reactivity, §6 p5 Sandbox, §7.3 (rewritten in R5), §13.4 (rewritten in R5).

MEMORIES TO APPLY:
  - feedback_feed_looks_back_aesthetic — load-bearing. R3 directly enforces this.
    Figurative motifs only; abstract vocabulary stays out of prompts entirely.
  - feedback_codex_review_pattern — after R5, run one focused Codex pass on
    the rework delta (fc38ab4..HEAD) before pushing.

OPERATING RULES:
  - Absolute paths only under /home/amay/Work/feed-looks-back-spike/
  - All git: `git -C /home/amay/Work/feed-looks-back-spike <cmd>`
  - Never cd into the target repo at shell top level.
  - Phase-5 DO NOT TOUCH:
      opus_client.mjs, packet_builder.mjs, image_content.mjs, self_frame.mjs,
      canon/*, mood_board.json, run_spike.mjs cycle-loop body (~lines 705-820).

EXECUTION ORDER (strict, per rework plan §3):

  R1 — MessageChannel refactor (blocker)
    Host (node/browser/p5_sandbox.mjs) + bridge (node/browser/p5_bridge.js).
    One documented wildcard handshake post is acceptable; every other
    postMessage goes over a transferred MessageChannel port. See plan §4.
    After commit: `grep -rn 'postMessage(' node/browser/ node/src/` returns
    ONLY the one handshake line (with its block comment above it).

  R2 — retire-before-mount for background (major)
    Belt-and-suspenders. mountBackground retires currentBackgroundSketchId
    before mounting new. Consecutive sketch.background.set patches without
    intervening retire must yield exactly 1 live iframe. See plan §5.

  R3 — prompt scrub + strict-grep (major)
    Rewrite hijaz_base.md reactivity section + tools.json reactivity entries
    to use figurative motifs only. Remove rejection-phrasing that names
    forbidden categories. Restore zero-hit grep in prompts_aesthetic.mjs
    against FORBIDDEN_AESTHETIC_TERMS. Positive-motif assertion so scrubs
    fail loudly. See plan §6.

  R4 — invariant tests strengthen (major, 3 sub-fixes, one commit)
    a. Invariant 1: prompt/tool surface vocabulary identity.
    b. Invariant 10: vm.runInContext harness for window.top / parent / domain
       / cookie / fetch attempts.
    c. Phase 6 inv 1: count actual mounted iframes via FakeDocument.
    See plan §7 for each sub-fix's exact assertion shape.

  R5 — spec §7.3 + §13.4 rewrite (minor)
    Rewrite §7.3: /p5/sandbox HTTP route + HTTP CSP header + MessageChannel
    transport (post-R1) + /p5/bridge.js. Rewrite §13.4: node/vendor/p5/p5.min.js
    served path, dev-dep p5 for developer convenience. Grep full spec for
    `srcdoc`, `csp=`, `node_modules/p5` — fix every hit.

After R5:
  Full test matrix from node/:
    for f in src/*.mjs browser/*.mjs; do node "$f" 2>&1 | tail -1; done
    node src/run_spike.mjs --self-test
    /home/amay/miniconda3/envs/ambi_audio/bin/python ../python/stream_features.py --self-test
  Target: 308+ tests green.

Then STOP and report to the user. Do NOT push. The coordinator session will
run R6 focused Codex + R7 push.

WORKFLOW DISCIPLINE:
  - One R-tier = one commit. Commit message prefix per plan Appendix A.
  - TDD where it fits: write the test first, watch it fail, then fix.
  - Browser-safe self-test guards on any modified or new browser-reachable
    module (SESSION_A_HANDOFF.md §3 invariant 3).
  - Every tier ends with the full test matrix green before the next tier.

RISK CALLOUTS:
  - MessageChannel in node tests: use node:worker_threads MessageChannel in
    any self-test, real global in browser runtime. One-line shim.
  - Port transfer may not work cleanly in FakeDocument harnesses. Assert
    postMessage call arguments (including [port2]) rather than actual port
    message-passing in host-side tests; exercise real port behavior in a
    focused harness test using the real MessageChannel.
  - Prompt scrub may shift Opus's aesthetic. If Phase 7 shows abstract
    drift, that's a prompt-tuning issue, not a sandbox issue — do NOT add
    rejection phrasing back.

FIRST ACTION: read the rework plan end-to-end + parent patches plan §4 Fix 1
/ §5 Fix 6 / §6 Fix 8 / §7 / §8.2 (those are the passages the rework aligns
to). Then start R1. Do not start R2 until R1 is committed and its grep
verification passes.
```

---

## 7. Launch prompt for Tier 6 focused Codex pass (after rework)

Once the rework session reports green, run this in `/home/amay/Work/feed-looks-back-spike` with `codex --sandbox read-only`:

```
Tier 6b focused re-review of the Feed Looks Back rework delta.

REPO: /home/amay/Work/feed-looks-back-spike
BRANCH: codex-retroactive-patches
DIFF RANGE: fc38ab4..HEAD   (R1 through R5 commits only)

READ FIRST:
  1. docs/superpowers/plans/2026-04-24-tier-6-rework-plan.md — what the
     commits are supposed to do
  2. docs/SESSION_A_HANDOFF.md §3 — 12 invariants still in force
  3. prior Tier 6 review findings (cited in the rework plan §4-§8)

SCOPED FOCUS (narrow; fc38ab4..HEAD is the only diff that matters):
  - R1: any lingering postMessage(..., "*") outside the one documented
    handshake? Is the handshake guarded by source + Zod + single-shot?
  - R2: consecutive sketch.background.set patches hermetic?
  - R3: grep -riE 'halo ring|pulsing line|flow[- ]?field|particle|noise[- ]?field|perlin'
    across node/prompts/ returns zero?
  - R4: do the strengthened tests fail on deliberate regressions?
  - R5: any remaining srcdoc / csp= / node_modules/p5 in the spec?

SEVERITY CALIBRATION:
  - Wildcard postMessage anywhere except the load-event handshake → BLOCKER
  - Any iframe with allow-same-origin anywhere → BLOCKER
  - Forbidden vocabulary in prompt text → MAJOR
  - Tier 4 test that doesn't actually exercise its named invariant → MAJOR

OUTPUT: same format as prior Codex reviews (SEVERITY / LOCATION / WHAT /
WHY / SUGGESTED FIX; grouped by severity; explicit "no blockers"/"no
majors" if empty). OVERALL VERDICT: "Ready to push" or "Rework before push"
with specific rationale.

DO NOT apply patches. Read-only review.
```

---

## 8. Other references

### 8.1 Anthropic memory entries active this session
Located at `/home/amay/.claude/projects/-home-amay-Work-build-spikes-tests/memory/`:

- `user_amer_artist.md`
- `project_feed_looks_back.md`
- `project_feed_looks_back_hijaz_enrichment.md`
- `project_feed_looks_back_session_c.md`
- `project_feed_looks_back_session_i.md`
- `feedback_codex_review_pattern.md`
- `feedback_read_before_narrating.md`
- `feedback_feed_looks_back_aesthetic.md`
- `feedback_summarizer_clause_priority.md`
- `reference_spike_paths_and_env.md`
- `reference_claude_api_skill.md`

Next coordinator should verify these are still accurate; no explicit updates needed from this session.

### 8.2 GitHub state
- Repo: `amrayach/feed-looks-back-spike`
- `origin/main`: `c928fcb`
- `origin/phase-5`: `97c11dd`
- PR #1: Phase 5 perception → main, open, 9 commits, awaits rebase once rework merges

### 8.3 Session cost
This coordinator session was expensive in context (70%+ consumed by the 8-subsession flow + Codex output + plan writing). Future coordinators should not re-read this handoff linearly; skim §1 for narrative, reference §4 for path, jump straight to §5-7 for prompts.

---

**End of handoff.** Next coordinator: read §1–§4, then decide A/B/C/D per §5. If executing the rework, dispatch the §6 prompt into a fresh session.
