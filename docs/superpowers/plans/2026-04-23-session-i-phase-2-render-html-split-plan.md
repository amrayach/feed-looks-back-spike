# Session I — Phase 2 Implementation Plan

**Date:** 2026-04-23  
**Status:** Ready for execution  
**Authoritative inputs:** `docs/superpowers/specs/2026-04-23-session-i-live-reactive-stage-design.md` at `b4e792e`, `SESSION_I_DESIGN_HANDOFF.md` at `ef553c8`  
**Base code commit:** `20d4222`  
**Phase:** 2 of 7 — `render_html.mjs` split

---

## 1. Objective

Remove `node/src/render_html.mjs` as the monolithic owner of rendering-side helpers and replace it with small modules that match the post-Phase-1 architecture.

At the end of Phase 2:

- the browser stage remains the primary live output
- `live_monitor.html` and `final_scene.html` still get written for operator observability
- sanitization no longer lives inside the HTML renderer
- image asset resolution no longer lives inside the HTML renderer
- the browser reducer and operator views share one source of truth for layout vocabulary instead of copying constants
- `render_html.mjs` is deleted

Phase 2 is an **ownership cleanup and parity phase**, not a new-feature phase.

---

## 2. Scope

### In scope

- `node/src/sanitize.mjs`
- `node/src/image_resolver.mjs`
- `node/src/operator_views.mjs`
- `node/src/scene_layout.mjs`
- `node/src/run_spike.mjs`
- `node/src/patch_emitter.mjs`
- `node/src/stage_server.mjs`
- `node/browser/scene_reducer.mjs`
- test migration out of `render_html.mjs`

### Explicitly out of scope

- audio feature transport
- reactivity execution
- p5 sandbox
- mood board / self-frame / perception work
- prompt changes
- patch protocol expansion beyond what Phase 1 already added

---

## 3. Why this phase exists now

Phase 1 deliberately dual-wrote: the live browser stage was added without deleting the legacy HTML path. That was the right move, but the resulting codebase still has one structural problem:

- `render_html.mjs` owns sanitization, asset resolution, final/live monitor HTML, and layout primitives
- `scene_reducer.mjs` already copied part of that layout vocabulary for browser rendering
- `patch_emitter.mjs` imports sanitization helpers from the renderer, which is the wrong dependency direction

If Phase 3 starts on top of that shape, audio/reactivity work will compound drift instead of reducing it.

---

## 4. Locked implementation decisions

### 4.1 `render_html.mjs` gets deleted, not preserved as a compatibility shell

Keep the export names stable where that reduces churn, but move ownership fully into the new files during this phase. Do not leave a one-line shim module behind unless a test migration forces it temporarily during the branch.

### 4.2 Add a shared layout module in this phase

The spec names `sanitize.mjs`, `image_resolver.mjs`, and `operator_views.mjs`. In the current codebase that is not enough, because layout/render vocabulary is duplicated between Node and browser.

Phase 2 should therefore add:

- `node/src/scene_layout.mjs`

This is a Phase 2 ownership correction, not a new feature.

### 4.3 Keep operator-view entrypoints stable

`run_spike.mjs` should continue to call the same conceptual entrypoints:

- `renderFinalHtml(runDir, artifacts, options)`
- `renderLiveHtml(runDir, artifacts, options)`

Those exports should simply come from `operator_views.mjs` instead of `render_html.mjs`.

### 4.4 Browser access to shared pure modules stays explicit

`stage_server.mjs` currently serves exactly one shared module path: `/shared/patch_protocol.mjs`.

Phase 2 should expand that to a narrow allowlist, not an open directory mount. Recommended shared allowlist after this phase:

- `/shared/patch_protocol.mjs`
- `/shared/scene_layout.mjs`

### 4.5 Use the completed short real run as the parity baseline

The approved short real run is:

- `node/output/run_20260423_231835`

Use that run’s `final_scene.html`, `live_monitor.html`, and operator-visible behavior as the concrete regression check after the split.

---

## 5. Target module ownership

### 5.1 `sanitize.mjs`

Owns all input-safety decisions that are currently trapped inside `render_html.mjs`.

Expected exports:

- `isSvgMarkupValid(markup)`
- `sanitizeCssBackground(css)`

Internal helpers may move with them:

- unsafe URL / event-handler detection
- SVG tag allowlist checks
- CSS background issue detection

Callers after the split:

- `patch_emitter.mjs`
- `operator_views.mjs`

### 5.2 `image_resolver.mjs`

Owns browser-facing image asset resolution and attribution lookup for operator HTML output.

Expected exports:

- `resolveImageAssets(state, runDir, fetchImageImpl = fetchImage)`

Internal helpers may move with it:

- `imageQueryKey`

Callers after the split:

- `operator_views.mjs`

### 5.3 `scene_layout.mjs`

Owns the shared scene-layout vocabulary used by both the browser stage and the operator HTML path.

Expected exports:

- `classifyPosition(position)`
- text-anchor mappings for absolutely positioned HTML elements
- SVG anchor rectangles
- image sizing classification and dimensions
- `textStyleCss(styleHint)`
- `scaleSvgMarkup(markup)`

The key rule is simple: if the browser reducer and operator views both need the same semantic mapping, it lives here once.

### 5.4 `operator_views.mjs`

Owns the legacy HTML outputs that remain after the live stage exists.

Expected exports:

- `renderSceneOverview(state)`
- `renderHtmlString({ state, summary, liveInfo, imageAssets })`
- `renderFinalHtml(runDir, artifacts, options)`
- `renderLiveHtml(runDir, artifacts, options)`

This module may also own private helpers for:

- final scene composition
- composition history
- statistics
- page CSS
- atomic HTML file writes

### 5.5 `run_spike.mjs`

Owns orchestration only.

After the split it should import:

- operator HTML writers from `operator_views.mjs`

It should not own sanitization, asset resolution, or layout rules.

### 5.6 `patch_emitter.mjs`

Owns patch generation only.

After the split it should import:

- `sanitizeCssBackground`
- `isSvgMarkupValid`

from `sanitize.mjs`, not from the operator renderer.

---

## 6. Work breakdown

## 6.1 Extract `sanitize.mjs`

**Files**

- `node/src/sanitize.mjs`
- `node/src/patch_emitter.mjs`
- temporary edits in `node/src/render_html.mjs` during extraction

**Actions**

- move SVG and CSS background safety logic into `sanitize.mjs`
- keep the public behavior byte-for-byte equivalent where possible
- repoint `patch_emitter.mjs` to `sanitize.mjs`
- remove duplicated sanitization code from the old renderer body

**Tests**

- safe SVG accepted
- disallowed SVG tags rejected
- event-handler SVG rejected
- safe CSS background accepted
- unsafe URL / script protocol CSS rejected

## 6.2 Extract `image_resolver.mjs`

**Files**

- `node/src/image_resolver.mjs`
- `node/src/operator_views.mjs` or temporary `render_html.mjs`

**Actions**

- move active-image discovery and fetch/dedup logic into `image_resolver.mjs`
- preserve the current shared-cache contract:
  - `image_fetch.mjs` returns filesystem paths inside `node/image_cache`
  - operator HTML continues to use paths relative to the active run directory where needed
- keep attribution/cached metadata unchanged

**Tests**

- duplicate image queries fetch once
- active image elements get assets by `element_id`
- failed image fetch becomes a stable placeholder entry
- inactive/faded image elements are excluded

## 6.3 Extract `scene_layout.mjs` and remove browser/renderer drift

**Files**

- `node/src/scene_layout.mjs`
- `node/browser/scene_reducer.mjs`
- `node/src/operator_views.mjs`
- `node/src/stage_server.mjs`

**Actions**

- move shared layout/render primitives out of the old renderer:
  - `classifyPosition`
  - anchor mappings
  - image sizing
  - text style hints
  - SVG scaling helper
- import those primitives into both:
  - `scene_reducer.mjs`
  - `operator_views.mjs`
- extend `stage_server.mjs` with a strict shared-module allowlist for `scene_layout.mjs`

**Important rule**

Do not leave copied constants behind in `scene_reducer.mjs`. If browser rendering still has its own position table after Phase 2, this phase has failed its main purpose.

**Tests**

- browser reducer still renders the full supported position vocabulary, including `two-column-span-*`
- operator HTML and browser reducer agree on image size classes and text styling semantics
- `stage_server.mjs` serves `/shared/scene_layout.mjs` and still rejects unrelated source files

## 6.4 Assemble `operator_views.mjs`

**Files**

- `node/src/operator_views.mjs`
- `node/src/run_spike.mjs`

**Actions**

- move the legacy HTML output pipeline into `operator_views.mjs`
- keep final/live monitor behavior stable:
  - `final_scene.html`
  - `live_monitor.html`
  - scene overview block
  - composition history
  - run statistics
- update `run_spike.mjs` imports to point at `operator_views.mjs`
- keep live-monitor refresh behavior unchanged

**Tests**

- `renderFinalHtml(...)` still writes `final_scene.html`
- `renderLiveHtml(...)` still writes `live_monitor.html`
- unsafe backgrounds still degrade to a labeled fallback
- malformed SVG still degrades to a labeled fallback

## 6.5 Delete `render_html.mjs` and migrate tests to their new homes

**Files**

- `node/src/render_html.mjs` deleted
- inline tests redistributed to:
  - `sanitize.mjs`
  - `image_resolver.mjs`
  - `scene_layout.mjs`
  - `operator_views.mjs`

**Actions**

- move the current inline self-tests instead of dropping them
- preserve the existing zero-dependency inline test style already used in this repo
- update any test imports or helper fixtures to use the new modules

**Target**

The old `render_html.mjs` file should be completely absent from the tree by the end of the phase.

---

## 7. Test migration map

Use the existing `render_html.mjs` inline tests as the source inventory, then redistribute them by ownership:

- `sanitize.mjs`
  - SVG validation acceptance/rejection cases
  - CSS background sanitization cases
- `scene_layout.mjs`
  - `classifyPosition(...)`
  - anchor/rect mapping invariants
  - image size classification
  - SVG scaling behavior
- `image_resolver.mjs`
  - image dedup and asset assignment cases
- `operator_views.mjs`
  - final scene rendering
  - operator history rendering
  - live monitor refresh/meta
  - fallback labels for unsafe background / malformed SVG

Keep the current repo convention:

- inline test runner at the bottom of each `.mjs`
- `node:assert/strict`
- no new external test framework

---

## 8. Verification sequence

### 8.1 Required automated checks

From `node/`:

- `node src/sanitize.mjs`
- `node src/image_resolver.mjs`
- `node src/scene_layout.mjs`
- `node src/operator_views.mjs`
- `node src/patch_emitter.mjs`
- `node src/stage_server.mjs`
- `node browser/scene_reducer.mjs`
- `node src/run_spike.mjs --self-test`
- plus the untouched baseline suites:
  - `node src/scene_state.mjs`
  - `node src/tool_handlers.mjs`

### 8.2 Required manual checks

1. Run a short dry run and confirm `final_scene.html` and `live_monitor.html` still render.
2. Run a short real run and open the live stage.
3. Compare the operator outputs against the known good short real baseline:
   - `node/output/run_20260423_231835`

### 8.3 Exit criteria

- `render_html.mjs` deleted
- test suite still green after migration
- browser stage still renders correctly
- operator HTML outputs still write correctly
- no duplicated layout vocabulary remains between `scene_reducer.mjs` and the operator-view stack

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Layout helper extraction accidentally changes visuals | Keep `scene_layout.mjs` behavior identical first, then deduplicate callers without altering constants |
| Test migration drops useful coverage | Move tests by ownership before deleting `render_html.mjs`; do not treat deletion as cleanup-only |
| `/shared/` serving becomes too broad | Use an explicit allowlist for `scene_layout.mjs` rather than mounting `node/src/` |
| `patch_emitter.mjs` behavior changes when sanitization moves | Repoint imports only; preserve the same sanitizer return shapes and rejection semantics |
| Operator HTML and browser stage still drift after the split | Treat remaining duplicated layout constants as a phase blocker, not follow-up polish |

---

## 10. Commit gate

Phase 2 follows the established workflow:

1. implement
2. tests pass
3. Codex review
4. address findings
5. user approval
6. commit

Do not start Phase 3 work on top of a half-migrated renderer split.
