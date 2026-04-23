# Session I — Phase 1 Implementation Plan

**Date:** 2026-04-23
**Status:** Ready for execution
**Authoritative inputs:** `docs/superpowers/specs/2026-04-23-session-i-live-reactive-stage-design.md` at `b4e792e`, `SESSION_I_DESIGN_HANDOFF.md` at `ef553c8`
**Phase:** 1 of 7 — WebSocket stage scaffolding

---

## 1. Objective

Land the first shippable version of the long-running browser stage without deleting the existing renderer. At the end of Phase 1:

- the six existing tools still mutate `scene_state` exactly as they do now
- those same tool calls also emit structured patches
- a browser stage connected over WebSocket can replay and render current scene state
- `render_html.mjs` still produces `final_scene.html` and `live_monitor.html` in parallel for parity checks

This is a **dual-write** phase, not a renderer migration phase.

---

## 2. Scope

### In scope

- `node/src/patch_protocol.mjs`
- `node/src/patch_cache.mjs`
- `node/src/patch_emitter.mjs`
- `node/src/stage_server.mjs`
- `node/browser/stage.html`
- `node/browser/bootstrap.mjs`
- `node/browser/ws_client.mjs`
- `node/browser/scene_reducer.mjs`
- targeted integration changes in `node/src/run_spike.mjs`
- backward-compatible integration changes in `node/src/tool_handlers.mjs`

### Explicitly out of scope

- `render_html.mjs` split into `sanitize.mjs`, `image_resolver.mjs`, `operator_views.mjs`
- audio feature transport and `feature_bus`
- `reactivity` execution
- mood board, self-frame, or other image-content plumbing
- p5 sandbox
- prompt changes

Phase 1 is allowed to add narrow compatibility hooks to existing files if that avoids pulling Phase 2 work forward.

---

## 3. Locked implementation decisions

### 3.1 Browser bootstrap

Use **`/browser/bootstrap.mjs`**, not `window.__stage`, as the single bootstrap path.

Reasons:

- keeps browser state module-scoped instead of global
- makes `run_id` / `mode` parsing testable in isolation
- matches the rest of the browser-stage architecture, which is ES-module based

`stage.html` should import `bootstrap.mjs`, which:

- reads `new URLSearchParams(location.search)`
- validates `run_id` and `mode`
- exports a frozen bootstrap object
- renders a loud blocking error page if either param is missing or invalid

### 3.2 Zod in the browser

Use a **no-copy importmap approach**, not startup-time file copying.

Implementation shape:

- `stage_server.mjs` serves a narrow `/vendor/zod/*` alias to the installed `zod` ESM files
- `stage.html` defines an importmap mapping `"zod"` to the served entrypoint
- browser code imports `zod` normally

This keeps the git tree clean and avoids a generated `browser/vendor/` surface.

### 3.3 Patch for CSS backgrounds

Add a new `background.set` patch type in Phase 1.

Reason:

- the spec's current patch schema includes `sketch.background.set` for future p5 work
- the existing `setBackground` tool has no live-stage equivalent without a dedicated CSS background patch
- Phase 1 parity requires the browser stage to receive background changes

This is a small implementation addendum, not a scope expansion.

### 3.4 Node publishes patches directly

`run_spike.mjs` should not open a WebSocket client to its own server.

Instead, `stage_server.mjs` should expose an imperative API:

- `broadcastPatch(patch)`
- `setCurrentRunContext({ runId, mode, runDir })`
- `close()`

The browser remains the only WebSocket client in Phase 1.

### 3.5 Backward-compatible tool handler API

Do **not** break the existing `applyToolCall(state, toolUseBlock)` return shape.

Implementation pattern:

- keep `applyToolCall(...) -> result` for current self-tests and existing call sites
- add a second exported entrypoint such as `applyToolCallDetailed(...) -> { result, patches }`
- have `run_spike.mjs` use the detailed path in Phase 1

This keeps the old tests stable while enabling patch emission.

---

## 4. Git and commit hygiene

The repo is currently **docs-tracked, code-untracked**. `node/` and `python/` are still untracked in git.

That means Phase 1 can be implemented in the working tree, but the eventual commit step needs an explicit choice:

1. Preferred: make a separate baseline commit for Sessions B–H first, then commit Phase 1 on top.
2. Fallback: create one larger commit that introduces the baseline plus Phase 1 together.

This is not a coding blocker, but it **is** a phase-gate blocker for the eventual commit.

Do not accidentally mix docs-only history with an ad hoc partial add of the `node/` tree.

---

## 5. Work breakdown

## 5.1 Dependency and directory prep

**Files**

- `node/package.json`
- `node/pnpm-lock.yaml`
- `node/browser/` (new directory)

**Actions**

- add runtime deps: `zod`, `ws`
- create `node/browser/`
- do **not** add later-phase deps (`playwright`, `sharp`, `p5`) in this phase unless they are already being installed as part of a broader repo sync

**Verification**

- `pnpm install` succeeds
- `package.json` reflects only the deps actually needed for Phase 1 runtime

## 5.2 Shared patch protocol

**Files**

- `node/src/patch_protocol.mjs`

**Actions**

- implement `ReactivitySchema`, `ElementSpec`, `PatchSchema`, and `WsMessageSchema`
- include the spec patch types already defined for:
  - `element.add`
  - `element.update`
  - `element.fade`
  - `element.remove`
  - `composition_group.add`
  - `composition_group.fade`
  - `cycle.begin`
  - `cycle.end`
  - `prompt.replace`
  - `replay.begin`
  - `replay.end`
- add the Phase 1 addendum patch:
  - `background.set`
- export parsers/validators used by both Node and browser

**Tests**

- valid parse for each Phase 1 patch type
- reject unknown patch `type`
- reject malformed `WsMessageSchema` channel payloads
- accept `composition_group_id` only at the top level of `ElementSpec`

## 5.3 Patch cache

**Files**

- `node/src/patch_cache.mjs`
- scaffold reference: `/home/amay/Work/Build_With_OPUS_4.7_hack/server/cache.ts`

**Actions**

- port the scaffold's Map + promise-chained persistence pattern
- make cache state run-scoped
- store enough materialized state to replay the **current** scene, not raw history
- public API should support:
  - `load()`
  - `apply(patch)`
  - `getReplayPatches()`
  - `size()`
- replay output should produce only current-state patches

**Replay materialization rules for Phase 1**

- latest `background.set`
- active `element.add` state only
- active `composition_group.add` state only
- exclude already-applied `fade` / `remove` history from replay body
- no sketch handling yet in Phase 1

**Tests**

- load missing cache file without error
- persist and reload cache state
- apply add + fade + remove and confirm replay omits inactive entities
- replay order is deterministic

## 5.4 Patch emitter

**Files**

- `node/src/patch_emitter.mjs`
- `node/src/tool_handlers.mjs`
- temporary compatibility reuse from `node/src/render_html.mjs`

**Actions**

- implement a pure emitter that converts a tool call result plus current tool input into zero or more patches
- cover all six existing tools:
  - `addText` -> `element.add`
  - `addSVG` -> `element.add`
  - `addImage` -> `element.add`
  - `setBackground` -> `background.set`
  - `fadeElement` on single element -> `element.fade`
  - `fadeElement` on group id -> `composition_group.fade`
  - `addCompositeScene` -> N `element.add` + 1 `composition_group.add`
- hoist `composition_group_id` from `element.content` to top-level `ElementSpec.composition_group_id`

**Temporary compatibility rule**

Do not perform the full Phase 2 split yet. For parity and safety:

- reuse the current SVG validation logic from `render_html.mjs`
- add a narrow export for CSS background validation or sanitization from `render_html.mjs` if needed
- keep image lookup logic local to Phase 1 code by delegating straight to `image_fetch.mjs` and producing `browser_url: "/image_cache/<filename>"`

The point is to avoid duplicating validation logic before Phase 2 extracts it properly.

**Tests**

- one case per tool mapping
- `addCompositeScene` emits both member-element patches and a group patch
- `fadeElement(group_...)` emits `composition_group.fade`
- invalid tool results emit zero patches
- `addImage` produces `/image_cache/<filename>` browser URLs

## 5.5 Stage server

**Files**

- `node/src/stage_server.mjs`

**Actions**

- serve HTTP and WebSocket on the same port
- static routes:
  - `/`
  - `/browser/*.mjs`
  - `/shared/*.mjs` allowlist limited to `patch_protocol.mjs`
  - `/vendor/zod/*`
  - `/run/<run_id>/audio.wav`
  - `/run/<run_id>/features_track.json`
  - `/image_cache/<filename>`
- reject non-allowlisted `node/src/*.mjs` requests
- accept browser WebSocket connections
- require an initial client hello carrying `{ run_id, mode }`
- route each client to the active run context
- on connect:
  - send `replay.begin`
  - send `patch_cache.getReplayPatches()`
  - send `replay.end`

**Tests**

- serves `stage.html`
- serves browser modules
- denies a Node-only module request
- serves an image-cache asset
- replay handshake order is `replay.begin` -> body -> `replay.end`
- client with wrong `run_id` is rejected or ignored loudly

## 5.6 Browser stage

**Files**

- `node/browser/stage.html`
- `node/browser/bootstrap.mjs`
- `node/browser/ws_client.mjs`
- `node/browser/scene_reducer.mjs`

**Actions**

- `stage.html`
  - importmap for `zod`
  - import `bootstrap.mjs`
  - mount stage root and pre-recorded `<audio>` element
- `bootstrap.mjs`
  - parse and validate `run_id` / `mode`
  - export immutable config
  - render loud error page on invalid bootstrap
- `ws_client.mjs`
  - connect to server
  - send initial hello `{ run_id, mode }`
  - dispatch incoming `patch` messages to reducer
  - keep reconnect logic minimal but explicit
- `scene_reducer.mjs`
  - implement replay state machine
  - manage `data-stage-ready`
  - render CSS background, text, SVG, image, and composition groups
  - reuse the current position vocabulary from `render_html.mjs`
  - keep DOM shape simple: background layer + group layer + free element layer

**Important parity rule**

Phase 1 should mirror the current `render_html.mjs` visual mapping closely enough to compare against Session H. That means copying or adapting the current position-classification and layout rules is acceptable here. Ownership migration of that logic is Phase 2.

**Tests**

Use a lightweight handwritten DOM stub for Phase 1 rather than introducing `jsdom` early.

Cover:

- bootstrap success and bootstrap failure
- `background.set`
- `element.add` for text, SVG, and image
- `composition_group.add`
- replay state machine sets and clears `data-stage-ready` correctly
- `element.fade` / `composition_group.fade` remove or mark the correct nodes

## 5.7 Runner integration

**Files**

- `node/src/run_spike.mjs`
- `node/src/tool_handlers.mjs`

**Actions**

- start `stage_server` at run start
- set current run context immediately after `runId` / `runDir` are known
- print the operator URL:
  - `http://<host>:<port>/?run_id=<run_id>&mode=<precompute|live>`
- before each cycle's tool processing:
  - emit `cycle.begin`
- after each tool result:
  - apply patches to `patch_cache`
  - broadcast patches to connected browsers
- after each cycle's tool processing:
  - emit `cycle.end`
- keep all existing persistence, summary, and `render_html` flows intact

**Compatibility note**

Phase 1 should not change the current dry-run semantics except for the additional patch side effects and stage URL output.

**Tests**

- existing 4 `run_spike` self-tests remain green
- add one lifecycle test for server startup/shutdown
- add one dry-run integration test that confirms patches are emitted while `final_scene.html` still renders

---

## 6. Execution order

Implement in this order:

1. dependency prep
2. `patch_protocol.mjs`
3. `patch_cache.mjs`
4. `patch_emitter.mjs`
5. `tool_handlers.mjs` detailed entrypoint
6. `stage_server.mjs`
7. `bootstrap.mjs`
8. `stage.html`
9. `scene_reducer.mjs`
10. `ws_client.mjs`
11. `run_spike.mjs` integration
12. self-tests and dry-run parity pass

This keeps shared schemas and server primitives stable before touching the runner.

---

## 7. Verification plan

### Required green tests

- `node src/scene_state.mjs`
- `node src/tool_handlers.mjs`
- `node src/render_html.mjs`
- `node src/run_spike.mjs --self-test`
- `node src/patch_protocol.mjs`
- `node src/patch_cache.mjs`
- `node src/patch_emitter.mjs`
- `node src/stage_server.mjs`
- `node browser/bootstrap.mjs` or equivalent self-test entry
- `node browser/scene_reducer.mjs` or equivalent self-test entry
- `node browser/ws_client.mjs` or equivalent self-test entry

### Manual verification

- run a 7-cycle dry run against the existing corpus
- open the printed operator URL
- compare stage output against:
  - `final_scene.html`
  - Session H baseline `node/output/run_20260423_185946/`
- verify reconnect replay rebuilds current state correctly
- verify `data-stage-ready` only flips true after replay completion plus `cycle.end`

---

## 8. Phase 1 exit criteria

Phase 1 is complete only when all of the following are true:

- the six current tools still work in both dry-run and real paths
- the browser stage stays connected across cycles
- reconnect replay restores the current scene
- `render_html.mjs` still produces the legacy artifacts in parallel
- all existing 131 tests remain green
- new Phase 1 self-tests are green
- a 7-cycle dry run shows visual parity close enough for Codex review

---

## 9. Codex review packet after implementation

When Phase 1 is ready for review, the packet should include:

- the exact commit hash under review
- the dry-run command used
- the operator URL format
- the list of new files
- the decision to use `bootstrap.mjs`
- the decision to use importmap-based browser Zod
- the `background.set` addendum to the patch schema

And per the established workflow: if Codex feedback points into an already-patched area, verify against current file contents and commit hash before re-applying.
