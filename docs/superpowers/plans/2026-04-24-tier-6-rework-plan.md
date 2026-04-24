# Tier 6 Rework — Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to work this plan rework-tier by rework-tier. Each tier ends with the full test matrix plus a narrow grep check; every tier must be green before the next.

**Goal:** Resolve the Tier 6 Codex re-review findings on branch `codex-retroactive-patches` — 1 blocker, 3 majors, 1 minor — so the branch is actually pushable. The headline is an architectural fix: replace `postMessage(..., "*")` across the sandbox boundary with a `MessageChannel` capability-transfer pattern. The rest are tightening fixes and one spec rewrite that the retroactive batch left partially done.

**Date:** 2026-04-24
**Branch:** `codex-retroactive-patches` (local only)
**Current HEAD:** `fc38ab4` (Tier 4 tests)
**Base for this rework:** `c928fcb` (main; same as the original patches plan)
**Upstream target:** `main` via fast-forward after this rework + a focused Tier 6b Codex pass on the delta
**Test matrix at start:** 304 green. Target after rework: 308+.

---

## 1. Context

The retroactive patch batch (commits `6739cda..fc38ab4`, 11 commits) addressed the original 2 blockers + 6 majors + 1 medium from the parallel Phase 4 / Phase 6 Codex review. A Tier 6 re-review of that batch was run from `/home/amay/Work/feed-looks-back-spike` on 2026-04-24 with `--sandbox read-only`. Its verdict: **"Rework before push"**, with the findings below.

Each finding falls into one of three categories:

- **Architectural constraint I underestimated in the original plan.** The blocker — `postMessage(..., "*")` still present — is not a lazy implementation. `sandbox="allow-scripts"` without `allow-same-origin` gives the iframe origin `"null"` regardless of its src URL, so you literally cannot address it with `targetOrigin=<http-origin>`. The right fix isn't a stricter origin string; it's changing the transport from same-window `postMessage` to `MessageChannel`, which is capability-based and doesn't use origin at all once the port is transferred.
- **Unilateral scope narrowing by the executing session.** Two majors (Fix 6 browser-side retire-before-mount, Fix 8 zero-hit grep) were deliberately narrowed from what the plan specified, without coming back for sign-off. Rework re-aligns code to plan.
- **Test gaps and doc drift.** Tier 4 invariants and Tier 5 spec rewrite were both partial. Tier 4 tests have names that don't match what they actually assert; Tier 5 only edited the path string `/vendor/p5.min.js` → `/vendor/p5/p5.min.js` and missed the broader §7.3 + §13.4 drift.

---

## 2. Non-goals

- Not relaxing the plan to match the code. We are aligning the code to the plan, not the reverse. (That would be Path B; it was considered and rejected — the retroactive batch had 1 wildly divergent implementation choice and 1 scope narrowing, and approving both post hoc would mean future reviews can't catch unauthorized scope drift either.)
- Not modifying anything outside the Phase 4 / Phase 6 surface. Phase 5 files remain owned by branch `phase-5`; the cycle-loop body in `run_spike.mjs` remains untouched.
- Not adding new capabilities. Rework tightens existing capabilities; it does not add tools, prompts, or features.
- Not running the Phase 7 production run. Still user-triggered after this rework + phase-5 merge.

---

## 3. Rework tiers (strict order)

Each tier is a single commit (or a small chain for the biggest tier). Every tier ends with:

```bash
cd /home/amay/Work/feed-looks-back-spike/node
for f in src/*.mjs browser/*.mjs; do node "$f" 2>&1 | tail -1; done
node src/run_spike.mjs --self-test
/home/amay/miniconda3/envs/ambi_audio/bin/python ../python/stream_features.py --self-test
```

All green, no new failures, before moving on.

```
R1 → MessageChannel refactor (blocker)
R2 → Retire-before-mount (major)
R3 → Prompt scrub + strict-grep restoration (major)
R4 → Invariant test strengthening (major, 3 sub-fixes)
R5 → Spec §7.3 + §13.4 rewrite (minor)
R6 → Focused Codex re-review of the rework delta
R7 → Push + open PR
```

---

## 4. R1 — MessageChannel refactor (blocker)

**Codex finding:** `node/browser/p5_sandbox.mjs:179`, `node/browser/p5_bridge.js:40`, `node/browser/p5_bridge.js:56` — `postMessage(..., "*")` still present.

**Root cause:** the iframe has `sandbox="allow-scripts"` without `allow-same-origin`, so its effective origin is the literal string `"null"`. The browser will not deliver a post whose `targetOrigin` doesn't match the destination's origin, and you cannot name an opaque origin. So `targetOrigin=<parent-origin>` fails delivery; `targetOrigin="*"` works but is the charter violation.

**Fix:** switch parent↔iframe messaging from same-window `postMessage` to `MessageChannel`. Once the port is transferred, all messages flow over the port; no `targetOrigin` needed because the port itself is the capability.

One wildcard post **remains** — the one-time handshake that transfers `port2` to the iframe. That wildcard is load-bearing: you cannot transfer a port without posting, and you cannot post to an opaque origin with a named target. This single post is protected by:

1. An `event.source === window.parent` check on the bridge side.
2. A message-shape Zod validation (type `port-handoff`, exactly 1 transferred port).
3. The `{once: true}` listener — after handshake, the bridge closes its window listener entirely.

This residual wildcard is documented inline with a block comment citing this plan section and the Codex finding, so future readers don't mistake it for the original blocker.

### R1 implementation shape

**Files:**

- `node/browser/p5_sandbox.mjs` (host)
- `node/browser/p5_bridge.js` (iframe side)
- `node/src/patch_protocol.mjs` (`IframeMessageSchema` stays; add optional `handshake` type if not already in the enum)
- tests in `node/browser/p5_sandbox.mjs` self-test block and any bridge harness

**Host changes (`p5_sandbox.mjs`):**

```js
function mountIframe(slot, params) {
  const iframe = document.createElement('iframe');
  iframe.src = buildSandboxUrl(params);
  iframe.sandbox = 'allow-scripts';          // unchanged; do NOT add allow-same-origin

  const channel = new MessageChannel();
  const hostPort = channel.port1;
  const iframePort = channel.port2;

  iframe.addEventListener('load', () => {
    /*
     * This is the ONE intentional wildcard targetOrigin in the sandbox flow.
     * Required because sandbox=allow-scripts forces an opaque (null) iframe origin;
     * there is no way to name an opaque origin in targetOrigin. Protected by:
     *  (a) bridge-side event.source === window.parent check
     *  (b) bridge-side Zod validation of the handshake message shape
     *  (c) bridge closes its window listener after the first valid handshake
     * See plans/2026-04-24-tier-6-rework-plan.md §4 and Codex Tier 6 blocker.
     */
    iframe.contentWindow.postMessage(
      { type: 'port-handoff', sketch_id: params.sketch_id },
      '*',
      [iframePort],
    );
  }, { once: true });

  hostPort.onmessage = (event) => {
    const parsed = IframeMessageSchema.safeParse(event.data);
    if (!parsed.success) return;
    dispatchIframeMessage(slot, parsed.data);
  };

  // All outbound messages go over the port — NO postMessage on iframe.contentWindow
  slots[slot] = { iframe, hostPort, sketch_id: params.sketch_id };
}

function sendFeatures(slot, features) {
  const entry = slots[slot];
  if (!entry) return;
  entry.hostPort.postMessage({ type: 'features', values: features });
}
```

**Bridge changes (`p5_bridge.js`):**

```js
let parentPort = null;

const onHandshake = (event) => {
  if (event.source !== window.parent) return;
  if (!event.data || event.data.type !== 'port-handoff') return;
  if (!Array.isArray(event.ports) || event.ports.length !== 1) return;
  // shape validation passed; accept the port
  parentPort = event.ports[0];
  parentPort.onmessage = (e) => handleIncoming(e.data);
  parentPort.postMessage({ type: 'ready', sketch_id: event.data.sketch_id });
  // close the window listener — handshake is single-shot
  window.removeEventListener('message', onHandshake);
};
window.addEventListener('message', onHandshake);

function sendHeartbeat() {
  if (!parentPort) return;
  parentPort.postMessage({ type: 'heartbeat', ts: Date.now() });
}

function sendError(message) {
  if (!parentPort) return;
  parentPort.postMessage({ type: 'error', message });
}
```

Remove all other `window.postMessage(...)` and `parent.postMessage(...)` call sites on both host and bridge. Grep after the change:

```bash
grep -rn 'postMessage(' node/browser/ node/src/ | grep -v '\.port' | grep -v '^Binary'
```

Only the one handshake line should match (with its justification comment above it).

**R1 tests:**

- Host self-test: mounting an iframe creates a `MessageChannel`, posts `{type:'port-handoff'}` with exactly 1 transferable port on iframe `load`, and the target is `'*'` (asserted on the second argument).
- Bridge harness (via `vm.runInContext`): a handshake from `window.parent` with 1 port is accepted, and `parentPort` is set. A handshake from a non-parent source is rejected; `parentPort` stays null. A handshake with 0 ports or 2 ports is rejected.
- Integration: after handshake, `hostPort.postMessage(...)` from host delivers to bridge; `parentPort.postMessage(...)` from bridge delivers to host. Neither side uses `targetOrigin` on port sends.
- Regression: grep-based assertion in the self-test that no `postMessage(..., '*')` appears anywhere except the one documented handshake line. Use a line-precise grep so a future refactor that reintroduces `'*'` fails loudly.

**R1 commit message:**

```
fix(tier-6-r1): MessageChannel transport between host and p5 sandbox iframe

Resolves Codex Tier 6 blocker — postMessage(..., "*") on sandbox flow.

Root cause is sandbox=allow-scripts forcing opaque iframe origin regardless
of src URL; targetOrigin cannot name opaque origins. Fix replaces per-message
postMessage with MessageChannel capability transfer. Single residual
wildcard on the load-event handshake is required (opaque target) and
protected by event.source + Zod shape + single-shot listener.
```

---

## 5. R2 — retire-before-mount for background (major)

**Codex finding:** `node/browser/scene_reducer.mjs:244`, `node/browser/p5_sandbox.mjs:338`, `node/browser/scene_reducer.mjs:611` — background replacement still depends on a preceding `sketch.retire` patch. Fix 6 landed the server-side ID parity but skipped the browser-side belt-and-suspenders the plan §5 Fix 6 required.

**Fix:** in either `p5_sandbox.mjs.mountBackground` or `scene_reducer.mjs` (whichever is the single entry point for background sketch patches), check `currentBackgroundSketchId` and call `retireSketch(currentBackgroundSketchId)` if set, **before** mounting the new background iframe.

The invariant to guarantee: consecutive `sketch.background.set` patches without any `sketch.retire` between them must result in exactly 1 live background iframe, matching the new patch's `sketch_id`.

### R2 implementation shape

```js
function mountBackground(patch) {
  // Belt-and-suspenders: retire any existing background before mounting new one,
  // even if the server-side patch stream didn't include a sketch.retire.
  if (currentBackgroundSketchId && currentBackgroundSketchId !== patch.sketch_id) {
    retireSketch(currentBackgroundSketchId);
  }
  const iframe = mountIframe('background', patch);
  currentBackgroundSketchId = patch.sketch_id;
}
```

**R2 tests:**

- Two consecutive `sketch.background.set` patches with different `sketch_id` values, without any `sketch.retire` patch between them, result in:
  - Exactly 1 live iframe in the DOM tree under the background slot
  - The live iframe's `sketch_id` is the second patch's
  - The first iframe was unmounted (dispose called)
- Consecutive `sketch.background.set` patches with the **same** `sketch_id` are idempotent: no unmount, no remount (or re-mount with identical props — pick one and test it).

**R2 commit message:**

```
fix(tier-6-r2): retire previous background before mount (belt-and-suspenders)

Resolves Codex Tier 6 major — background replacement depended on preceding
sketch.retire patch. Reducer/sandbox now retires by currentBackgroundSketchId
before every sketch.background.set mount. Consecutive set without intervening
retire is now hermetic.
```

---

## 6. R3 — prompt scrub + strict-grep restoration (major)

**Codex finding:** `node/prompts/hijaz_base.md:582`, `node/prompts/configs/config_a/tools.json:251, 257`, `node/src/prompts_aesthetic.mjs:38, 87` — forbidden-vocabulary terms still appear in Opus-visible prompt text because Fix 8 swapped the zero-hit grep for a context-aware check.

**Fix:** align code to plan §6 Fix 8. The executing session's reasoning (that "rejection phrasing is pedagogical") is not what the plan authorized. Two changes:

1. **Prompt text:** rewrite the reactivity sections in `hijaz_base.md` and the tool descriptions in `tools.json` to avoid naming the forbidden aesthetic categories. Tell Opus what to DO (figurative motifs — candle flame, trembling leaves, breath, textiles, calligraphy, lantern glow), not what to avoid. The forbidden-term list stays in code as a test, not in the prompt as rejection guidance.
2. **Test:** `prompts_aesthetic.mjs` reverts to a **strict zero-occurrence** grep over `hijaz_base.md` + every `tools.json` under `configs/` for the canonical forbidden list:

```
['halo ring', 'pulsing line', 'flow field', 'flow-field',
 'particle', 'particles', 'particle system',
 'noise field', 'noise-field', 'noise loop',
 'perlin noise', 'perlin-noise']
```

Case-insensitive match, any hit fails the test.

### R3 implementation notes

- The test takes the list from a single source of truth (a top-level `FORBIDDEN_AESTHETIC_TERMS` const in `prompts_aesthetic.mjs`). Do not duplicate it.
- If a rewrite turns out to need a term for unavoidable reasons (e.g. "noise" in a non-aesthetic context), amend this plan, not the list. The list is a contract.
- Look for synonyms the list may miss as you rewrite — if you find "geometric pulse" or "abstract pattern" in prompt text, flag those too.

**R3 tests:**

- Strict zero-hit grep across the target files for every term in `FORBIDDEN_AESTHETIC_TERMS` (case-insensitive).
- Positive assertion that at least one figurative motif token ("candle", "leaf" or "leaves", "breath", "textile", "calligraphic", "lantern") appears in `hijaz_base.md` — so the test catches a future over-zealous scrub that strips all examples.
- `FORBIDDEN_AESTHETIC_TERMS` constant itself has a self-test confirming it contains all the terms the plan enumerates (guards against accidental deletion).

**R3 commit message:**

```
fix(tier-6-r3): scrub abstract vocabulary from prompts; restore strict grep

Resolves Codex Tier 6 major — prompts_aesthetic.mjs accepted rejection
phrasing, leaving forbidden terms in Opus-visible prompt text. Rewrote
hijaz_base.md reactivity section + tools.json entries to use only figurative
motifs. prompts_aesthetic.mjs now enforces zero-occurrence grep against a
canonical FORBIDDEN_AESTHETIC_TERMS list.
```

---

## 7. R4 — invariant test strengthening (major, 3 sub-fixes)

**Codex finding:** `node/src/invariants.mjs:50`, `:160`, `:189` — three Tier 4 tests have names that don't match what they actually assert.

### R4a — invariant 1: prompt/tool surface identity

**Current:** the test asserts feature-name identity across `patch_protocol.mjs`, `feature_replayer.mjs`, `stream_features.py`, `p5_bridge.js`. It does NOT check the prompt text or tool schemas.

**Fix:** extend the test to also assert:

- Every feature name in `FEATURE_NAMES` appears in `hijaz_base.md` (exact string match or word-boundary match).
- Every feature name in `FEATURE_NAMES` appears in the `tools.json` reactivity `feature` enum. (Parse the JSON, walk to the reactivity feature enum, compare sets.)
- Neither surface contains extra feature names not in `FEATURE_NAMES`.

This catches prompt drift that adds a 7th feature name informally or tool drift that removes one silently.

### R4b — invariant 10: negative parent/window access from sketch context

**Current:** the test asserts sandbox="allow-scripts" is present and `allow-same-origin` is absent. It does NOT exercise a simulated sketch attempting actual parent access.

**Fix:** build a `vm.runInContext` harness with a globals object that models the sandboxed iframe's view — no access to parent, no `document.domain` beyond the opaque origin string. Execute sketch-style code that attempts:

```js
const attempts = [
  () => window.top,
  () => window.parent.__anything,
  () => document.domain = 'attacker.example',
  () => document.cookie,
  () => fetch('http://evil.example'),
];
```

Assert each one either throws or returns a sentinel (`null`, `""`, `undefined` as appropriate to the browser's sandbox behavior), not the real thing. Document which attempts the test is mocking (not a real browser) and which are exercising real JS semantics.

The test name should make clear this is a harness-level assertion, not a real-browser assertion. The real-browser confirmation comes from the manual smoke (plan §8, run from phase-7 pre-flight).

### R4c — phase 6 invariant 1: actual mounted-iframe cardinality

**Current:** the test fires a 10-sketch burst and asserts the sandbox's internal `slots` map stays at ≤3 entries. It does NOT count actual `<iframe>` elements.

**Fix:** construct a FakeDocument (the existing pattern used by other Phase 6 tests) that tracks `createElement('iframe')` and `parentNode.removeChild(iframe)` calls. After the burst, assert:

- `countLiveIframes(fakeDocument) <= 3`
- `countLiveIframes(fakeDocument) === sandbox.getLocalizedSlotCount()`
- The evicted iframes had `dispose()` / `removeChild()` called on them

This is the end-to-end cardinality assertion the plan's Phase 6 invariant 1 requires.

### R4 implementation notes

- All three sub-fixes land in the same commit `test(tier-6-r4): …` — they share a file and the invariant-test idiom is shared.
- Keep each added test hermetic: no network, no real processes, no fixed ports.

**R4 tests:** themselves are tests. Run them and confirm they fail cleanly on the current code if you deliberately break each invariant (to prove they catch regressions), then unfail.

**R4 commit message:**

```
test(tier-6-r4): strengthen invariant tests for vocab, parent access, iframe count

Resolves Codex Tier 6 major — invariants.mjs tests had names that didn't
match what they assert. Invariant 1 now includes prompt/tool surfaces;
invariant 10 exercises a vm.runInContext harness for parent/top access;
phase-6-inv-1 counts actual mounted iframes via FakeDocument.
```

---

## 8. R5 — spec §7.3 + §13.4 rewrite (minor)

**Codex finding:** `docs/superpowers/specs/2026-04-23-session-i-live-reactive-stage-design.md:307, :320, :573` — §7.3 still describes `srcdoc` + iframe `csp=` attribute; §13.4 still describes `node_modules/p5` as the vendoring strategy.

**Fix:** rewrite those sections to match HEAD of `codex-retroactive-patches`:

- §7.3 "Sketch sandbox": iframe loads from `/p5/sandbox?sketch_id=...` HTTP route. HTTP `Content-Security-Policy` header enforces `default-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; …`. **After R1:** parent↔iframe messaging uses `MessageChannel` capability transfer, with a single documented wildcard handshake. Iframe keeps `sandbox="allow-scripts"` (no `allow-same-origin`). Bridge script served from `/p5/bridge.js`.
- §13.4 "New dependencies": `p5` appears as a dev dep for convenience, but the served asset is the checked-in `node/vendor/p5/p5.min.js` (963 KB, v2.2.3, LGPL-2.1). Refresh procedure documented in `node/vendor/p5/README.md`.

Grep the entire spec for `srcdoc`, `csp=`, `node_modules/p5` and rewrite any remaining matches consistently.

**R5 tests:** none (doc-only). Verification is manual + a grep-based doc test could be added but is out of scope.

**R5 commit message:**

```
docs(tier-6-r5): rewrite spec §7.3 + §13.4 to match HEAD sandbox contract

Resolves Codex Tier 6 minor — §7.3 described srcdoc + iframe csp= attribute,
§13.4 described node_modules/p5 vendoring. Rewritten to match HEAD:
/p5/sandbox HTTP route, HTTP CSP header, MessageChannel transport (after R1),
/p5/bridge.js, node/vendor/p5/p5.min.js.
```

---

## 9. R6 — focused Codex re-review

After R1–R5 land, run **one** Codex session scoped to the rework delta. The delta is small (~300 LOC), so a single read-only pass with focused prompt is enough.

**Scope:** `fc38ab4..HEAD` (i.e. just the R1–R5 commits, not the full retroactive batch).

**Focus areas:**

- R1: any lingering `postMessage(..., "*")` outside the one documented handshake? Is the handshake protection actually robust (source check + shape validation + single-shot)?
- R2: are consecutive background sets hermetic, including the same-id idempotency case?
- R3: run the same `grep -riE` sweep Codex uses; should return zero hits. Are the rewritten prompt exemplars figurative per memory `feedback_feed_looks_back_aesthetic`?
- R4: do the strengthened tests actually fail on a deliberate regression? Are they hermetic?
- R5: any remaining `srcdoc` / `csp=` / `node_modules/p5` in the spec?

**Expected verdict:** "Ready to push". If Codex returns any blocker or major, stay on the branch and iterate.

---

## 10. R7 — push + PR

Only after R6 returns clean:

```bash
git -C /home/amay/Work/feed-looks-back-spike push origin codex-retroactive-patches
gh pr create --title "…" --body "…"
```

PR body should reference:

- Original patches plan (`docs/superpowers/plans/2026-04-24-codex-retroactive-patches-plan.md`)
- This rework plan
- Both Codex reviews (scoped full-batch + focused delta)
- Test matrix totals before/after (272 → 304 → 308+)

After merge, signal Session B to rebase phase-5 onto the new main.

---

## 11. Non-touched files (hard rule)

These files MUST remain untouched by any rework commit. Violation is a blocker per Session A handoff §3 invariant 1.

- `node/src/opus_client.mjs`
- `node/src/packet_builder.mjs`
- `node/src/image_content.mjs`
- `node/src/self_frame.mjs`
- `node/canon/*`
- `node/prompts/mood_board.json`
- `node/src/run_spike.mjs` cycle-loop body (~lines 705–820 at `c928fcb`; re-verify at HEAD)

All five rework tiers can be completed without touching any of these. If you find yourself needing to, stop and ask.

---

## 12. Verification checklist

- [ ] R1: `grep -rn 'postMessage(' node/browser/ node/src/` returns only the one documented handshake line
- [ ] R1: MessageChannel test suite covers handshake accept/reject + port-based bidirectional messaging
- [ ] R2: consecutive-background-set-without-retire test passes; yields exactly 1 live iframe
- [ ] R3: `grep -riE 'halo ring|pulsing line|flow[- ]?field|particle|noise[- ]?field|perlin' node/prompts/` returns zero hits
- [ ] R3: figurative-motif positive assertion passes
- [ ] R4a: prompt/tool surface vocabulary identity assertion passes and catches a deliberate extra feature name
- [ ] R4b: parent-access harness asserts all 5 attempts are blocked/mocked appropriately
- [ ] R4c: mounted-iframe count ≤ 3 after 10-sketch burst, asserted on FakeDocument, not just slot map
- [ ] R5: spec grep for `srcdoc`, `csp=`, `node_modules/p5` returns zero hits under `docs/superpowers/specs/`
- [ ] Full test matrix green; target ≥ 308 total
- [ ] R6 Codex re-review: "Ready to push"
- [ ] Phase-5 scope files unchanged at HEAD

---

## 13. Risks and rollback

**Risk 1 — MessageChannel behavior in test harness.** The existing self-tests use FakeDocument / FakeElement, not a real browser. MessageChannel is available in Node 15+ via `node:worker_threads` (`MessageChannel` class). The test shim must import that; the browser runtime uses the built-in global. Mitigation: a one-line platform shim at the top of `p5_sandbox.mjs`'s test block.

**Risk 2 — port transfer requires a real event loop.** The `[port2]` transfer argument requires structured cloning with transfer semantics. In-memory FakeDocument may not support this. Mitigation: the host-side test asserts the `postMessage` call happened with the right arguments (including `[port2]`); the port's actual message-passing is exercised in a separate harness that uses the real `MessageChannel`.

**Risk 3 — prompt scrub changes Opus behavior.** Removing rejection phrasing may let Opus drift toward an abstract aesthetic again (since the warning is gone). Mitigation: the positive figurative motifs are strengthened in the same commit, and Phase 7 production run will catch any regression. If Opus drifts in Phase 7, it's a prompt-tuning question, not a sandbox-security one.

**Risk 4 — spec rewrite accidentally removes non-drift content.** Mitigation: R5 is diff-reviewable on the PR; surface any removal that isn't explicitly drift correction.

**Rollback:** every R-tier is a commit. `git revert <sha>` on the offending commit, push, continue. Branch stays live until merged.

---

## Appendix A — finding → tier cross-reference

| Finding | Severity | R-tier | Commit message prefix |
|---|---|---|---|
| `postMessage(..., "*")` still present | blocker | R1 | `fix(tier-6-r1)` |
| Background replacement needs preceding retire | major | R2 | `fix(tier-6-r2)` |
| Prompt guard weakened; abstract terms still present | major | R3 | `fix(tier-6-r3)` |
| Tier 4 tests don't assert their names (3×) | major | R4 | `test(tier-6-r4)` |
| Spec §7.3 + §13.4 describe old sandbox contract | minor | R5 | `docs(tier-6-r5)` |

---

## Appendix B — test additions cross-reference

| Test | R-tier | File | What it locks |
|---|---|---|---|
| Handshake accept/reject shape | R1 | `p5_sandbox.mjs` / bridge harness | MessageChannel handshake protected by source + Zod shape |
| Port-based bidirectional messaging | R1 | `p5_sandbox.mjs` | Features + heartbeat flow over port without origin |
| No-wildcard grep | R1 | `p5_sandbox.mjs` | Future regressions loudly fail |
| Consecutive-background-set hermetic | R2 | `scene_reducer.mjs` | Retire-before-mount without preceding retire patch |
| Forbidden-vocabulary zero-hit | R3 | `prompts_aesthetic.mjs` | Abstract aesthetic vocabulary stays out of prompts |
| Figurative-motif positive | R3 | `prompts_aesthetic.mjs` | Over-zealous scrubs fail loudly |
| Prompt/tool vocabulary identity | R4a | `invariants.mjs` | Feature surface stays 6 names, prompt + tools match |
| Parent-access harness | R4b | `invariants.mjs` | Sandbox-context JS can't reach parent/top |
| Mounted-iframe count | R4c | `invariants.mjs` | N=3 cap enforced on real DOM count, not just slot map |

---

**End of plan.** Execute R1→R5 on `codex-retroactive-patches`, run R6 focused Codex, then R7 push.
