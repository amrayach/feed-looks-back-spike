// node/src/invariants.mjs
// Cross-module invariant regression tests. Each test in this file
// asserts a property that spans multiple modules — if it ever flips
// red, the system is internally inconsistent in a way that no single
// module's self-test can catch.
//
// Invariants frozen here correspond to spec §12 and Session I handoff §3:
//   1  feature-vocabulary identity across node + python + browser
//   7  reactive keys on elements do NOT change operator_views HTML
//  10  p5 bridge does not read parent DOM or globals
//  ε  phase-6 N=3 cap holds under a malformed burst

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_ROOT = join(__dirname, "..");
const REPO_ROOT = join(NODE_ROOT, "..");

function read(file) {
  return readFileSync(file, "utf8");
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  let pass = 0;
  let fail = 0;
  async function t(desc, fn) {
    try {
      await fn();
      pass += 1;
      process.stdout.write(`  ok  ${desc}\n`);
    } catch (err) {
      fail += 1;
      process.stdout.write(`  FAIL ${desc}\n    ${err.message}\n`);
    }
  }

  // ─── Invariant 1 ─────────────────────────────────────────────
  // The six audio feature names are the wire contract between the
  // Python producer, the Node patch protocol, the browser feature
  // replayer, and the sandbox bridge. A typo or reorder in any one
  // of the four silently desyncs the rest.
  await t("invariant 1: feature vocabulary is identical across patch_protocol, feature_replayer, bridge, stream_features.py", async () => {
    const { FEATURE_NAMES: protoNames } = await import("./patch_protocol.mjs");
    const { FEATURE_NAMES: replayerNames } = await import("../browser/feature_replayer.mjs");

    const canonical = [
      "amplitude",
      "onset_strength",
      "spectral_centroid",
      "hijaz_state",
      "hijaz_intensity",
      "hijaz_tahwil",
    ];

    // Node exports (byte-identical array ordering — not just set equality):
    assert.deepEqual(
      [...protoNames],
      canonical,
      `patch_protocol FEATURE_NAMES drift: ${[...protoNames].join(",")}`,
    );
    assert.deepEqual(
      [...replayerNames],
      canonical,
      `feature_replayer FEATURE_NAMES drift: ${[...replayerNames].join(",")}`,
    );

    // Bridge's window.features literal: parse p5_bridge.js, extract
    // the key list, compare as a SET (bridge uses object-literal
    // ordering which matters less than membership).
    const bridgeSrc = read(join(NODE_ROOT, "browser", "p5_bridge.js"));
    const bridgeBlockMatch = /window\.features\s*=\s*\{([\s\S]*?)\};/.exec(bridgeSrc);
    assert.ok(bridgeBlockMatch, "could not locate window.features initializer in p5_bridge.js");
    const bridgeKeys = [...bridgeBlockMatch[1].matchAll(/([a-z_][a-z0-9_]*)\s*:/gi)].map((m) => m[1]);
    assert.deepEqual(
      [...bridgeKeys].sort(),
      [...canonical].sort(),
      `p5_bridge.js window.features keys drift: ${bridgeKeys.join(",")}`,
    );

    // Python: stream_features.py builds a `required` set literal over
    // {"t", "amplitude", …}. Extract its members and assert exact
    // parity with the canonical vocabulary (plus "t", which is the
    // frame-time key that only the python producer carries).
    const pySrc = read(join(REPO_ROOT, "python", "stream_features.py"));
    const requiredBlock = /required\s*=\s*\{([\s\S]*?)\}/.exec(pySrc);
    assert.ok(requiredBlock, "could not locate `required = { ... }` set literal in stream_features.py");
    const pyKeys = [...requiredBlock[1].matchAll(/"([a-z_][a-z0-9_]*)"/gi)].map((m) => m[1]);
    assert.deepEqual(
      [...pyKeys].sort(),
      [...canonical, "t"].sort(),
      `stream_features.py required set drift: ${pyKeys.join(",")}`,
    );
  });

  // ─── Invariant 7 ─────────────────────────────────────────────
  // Operator views render a live textual description of scene state
  // for the operator console. Adding reactivity keys to an element
  // must NOT affect what the operator reads — reactivity is a runtime
  // concern the operator never sees.
  await t("invariant 7: element reactivity does not change operator_views HTML", async () => {
    const { createInitialState, addElement } = await import("./scene_state.mjs");
    const { renderSceneOverview } = await import("./operator_views.mjs");

    const withoutReactivity = createInitialState();
    addElement(withoutReactivity, {
      type: "text",
      content: { text: "after", style: "serif, large" },
      position: "center",
      lifetime_s: 35,
    });

    const withReactivity = createInitialState();
    addElement(withReactivity, {
      type: "text",
      content: { text: "after", style: "serif, large" },
      position: "center",
      lifetime_s: 35,
      reactivity: [
        {
          property: "opacity",
          feature: "amplitude",
          map: { in: [0, 1], out: [0.6, 1.0], curve: "linear" },
          smoothing_ms: 80,
        },
        {
          property: "scale",
          feature: "hijaz_tahwil",
          map: { in: [0, 1], out: [1, 1.4], curve: "impulse" },
        },
      ],
    });

    const a = renderSceneOverview(withoutReactivity);
    const b = renderSceneOverview(withReactivity);
    assert.equal(
      a,
      b,
      "operator_views HTML diverges when reactivity keys are added — reactivity must be invisible to the operator console",
    );
  });

  // ─── Invariant 10 ────────────────────────────────────────────
  // The p5 bridge runs in a sandbox iframe with `allow-scripts` but
  // WITHOUT `allow-same-origin`. The browser's same-origin policy
  // therefore blocks any attempt by the bridge to read parent DOM
  // (window.parent.document, cookies, localStorage). That guarantee
  // is enforced by the browser — but the bridge itself should not
  // even ATTEMPT those reads. A grep of p5_bridge.js for forbidden
  // access patterns catches the class of bug where a helpful-looking
  // "window.parent.postMessage(myself); window.parent.document…" line
  // slips in during a refactor.
  await t("invariant 10: p5_bridge.js contains no forbidden parent-DOM access patterns", () => {
    const bridgeSrc = read(join(NODE_ROOT, "browser", "p5_bridge.js"));
    // These are the forms that would either throw at runtime (SOP
    // violation) or indicate an author forgot which side of the
    // boundary they're on. postMessage is explicitly allowed.
    const forbidden = [
      /window\.parent\.document/,
      /window\.parent\.cookie/,
      /window\.parent\.localStorage/,
      /window\.parent\.sessionStorage/,
      /window\.parent\.location\s*=/,
      /window\.parent\.__\w+/,
    ];
    for (const pat of forbidden) {
      assert.ok(!pat.test(bridgeSrc), `p5_bridge.js contains forbidden parent access: ${pat}`);
    }
    // Positive: bridge MUST use postMessage to reach the parent.
    assert.ok(
      /window\.parent\.postMessage\s*\(/.test(bridgeSrc),
      "p5_bridge.js does not call window.parent.postMessage — how is it signaling the host?",
    );
  });

  // ─── Phase 6 Invariant 1 (E2E) ───────────────────────────────
  // scene_reducer enforces a N=3 cap on localized sketches with a
  // belt-and-suspenders eviction: if a 4th sketch.add arrives without
  // a prior sketch.retire, the reducer evicts the oldest locally. A
  // malformed burst of 10 sketch.add patches arriving back-to-back
  // (hostile or buggy producer) must leave the stage with ≤3 iframes.
  await t("phase-6 invariant 1: 10-sketch malformed burst leaves at most 3 iframes mounted", async () => {
    const { createSceneReducer } = await import("../browser/scene_reducer.mjs");

    function fakeDocument() {
      const body = { children: [], dataset: {} };
      return {
        body,
        createElement: (tag) => ({
          tagName: (tag ?? "div").toUpperCase(),
          children: [],
          style: {},
          dataset: {},
          _attributes: {},
          _listeners: new Map(),
          appendChild(c) { this.children.push(c); c.parent = this; return c; },
          remove() {
            if (!this.parent) return;
            const i = this.parent.children.indexOf(this);
            if (i !== -1) this.parent.children.splice(i, 1);
            this.parent = null;
          },
          setAttribute(n, v) { this._attributes[n] = v; },
          getAttribute(n) { return this._attributes[n]; },
          addEventListener(type, fn) {
            const list = this._listeners.get(type) ?? [];
            list.push(fn); this._listeners.set(type, list);
          },
          removeEventListener(type, fn) {
            const list = this._listeners.get(type) ?? [];
            this._listeners.set(type, list.filter((x) => x !== fn));
          },
          set innerHTML(v) { this._innerHTML = v; },
          get innerHTML() { return this._innerHTML ?? ""; },
        }),
      };
    }

    const doc = fakeDocument();
    const mount = doc.createElement("div");
    const mountedIds = [];
    const retiredIds = [];
    const p5Sandbox = {
      mountBackground() {},
      mountLocalized({ sketch_id }) { mountedIds.push(sketch_id); },
      retireSketch(sketch_id) { retiredIds.push(sketch_id); },
      dispose() {},
    };
    const reducer = createSceneReducer({
      documentLike: doc, mount, readyTarget: doc.body,
      setTimeoutImpl: (fn) => fn(),
      p5Sandbox,
    });
    // Silence the scene_reducer.warn the cap-exceeded message emits
    // — the test is asserting that eviction happens, so the warn is
    // expected noise.
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < 10; i++) {
        reducer.applyPatch({
          type: "sketch.add",
          sketch_id: `burst_${i}`,
          position: "center",
          size: "small",
          code: "noop()",
          audio_reactive: false,
          lifetime_s: null,
        });
      }
    } finally {
      console.warn = origWarn;
    }
    // 10 mount calls happened — but the belt-and-suspenders eviction
    // means 7 of them were evicted locally (oldest-first).
    assert.equal(mountedIds.length, 10);
    assert.equal(retiredIds.length, 7);
    // The three survivors should be the most recent three.
    assert.deepEqual(retiredIds, [
      "burst_0","burst_1","burst_2","burst_3","burst_4","burst_5","burst_6",
    ]);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
