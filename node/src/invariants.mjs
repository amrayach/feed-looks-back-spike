// node/src/invariants.mjs
// Cross-module invariant regression tests. Each test in this file
// asserts a property that spans multiple modules — if it ever flips
// red, the system is internally inconsistent in a way that no single
// module's self-test can catch.
//
// Invariants frozen here correspond to spec §12 and Session I handoff §3:
//   1   feature-vocabulary identity across node + python + browser
//  1p   feature vocabulary appears in hijaz_base.md (prompt surface)
//  1t   feature vocabulary appears in every tools.json reactivity enum
//   7   reactive keys on elements do NOT change operator_views HTML
//  10   p5 bridge does not read parent DOM or globals
// 10h   sandbox-context mock blocks parent/top/cookie/fetch access
//   ε   phase-6 N=3 cap holds under a malformed burst (DOM-level)

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

  // ─── Invariant 1p ────────────────────────────────────────────
  // The six canonical feature names must also appear in the prompt
  // the Opus author sees. If a name is missing here, Opus has no
  // way to reference the feature when authoring reactivity; if an
  // extra feature-name-shaped token appears, Opus may pattern-match
  // on a stale vocabulary. We enforce both: presence (word-boundary
  // match) and no-extras (every `window.features.X` reference names
  // a canonical feature).
  await t("invariant 1p (prompt surface): all six feature names appear in hijaz_base.md with no extras", async () => {
    const { FEATURE_NAMES } = await import("./patch_protocol.mjs");
    const canonical = [...FEATURE_NAMES];
    const body = read(join(NODE_ROOT, "prompts", "hijaz_base.md"));

    for (const name of canonical) {
      const re = new RegExp("\\b" + name + "\\b");
      assert.ok(re.test(body), `feature "${name}" is missing from hijaz_base.md`);
    }

    // No extras: every `window.features.X` reference in code blocks
    // or prose must name a canonical feature. This catches a 7th
    // informal feature name introduced via a doc edit.
    const referenced = [...body.matchAll(/window\.features\.([a-z_][a-z0-9_]*)/g)]
      .map((m) => m[1]);
    const extras = [...new Set(referenced.filter((n) => !canonical.includes(n)))];
    assert.deepEqual(
      extras,
      [],
      `hijaz_base.md references non-canonical features via window.features.X: ${extras.join(", ")}`,
    );
  });

  // ─── Invariant 1t ────────────────────────────────────────────
  // Every tools.json under prompts/configs/ defines a reactivity
  // feature enum that Opus tool-calls are validated against. The
  // enum's membership must exactly equal FEATURE_NAMES — no missing
  // (Opus would reject a valid call), no extras (Opus could author
  // a call that passes schema but crashes the feature bus).
  await t("invariant 1t (tool surface): all tools.json reactivity feature enums exactly match FEATURE_NAMES", async () => {
    const { FEATURE_NAMES } = await import("./patch_protocol.mjs");
    const canonicalSorted = [...FEATURE_NAMES].sort();
    const configsRoot = join(NODE_ROOT, "prompts", "configs");

    function collectFeatureEnums(node, acc) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) collectFeatureEnums(item, acc);
        return;
      }
      for (const [key, val] of Object.entries(node)) {
        if (
          key === "feature" &&
          val && typeof val === "object" &&
          val.type === "string" &&
          Array.isArray(val.enum)
        ) {
          acc.push(val.enum);
        }
        collectFeatureEnums(val, acc);
      }
    }

    let enumCount = 0;
    for (const cfg of readdirSync(configsRoot)) {
      const toolsPath = join(configsRoot, cfg, "tools.json");
      const doc = JSON.parse(read(toolsPath));
      const enums = [];
      collectFeatureEnums(doc, enums);
      assert.ok(
        enums.length > 0,
        `no reactivity feature enums found in ${toolsPath} — expected at least one`,
      );
      for (const e of enums) {
        enumCount += 1;
        assert.deepEqual(
          [...e].sort(),
          canonicalSorted,
          `${toolsPath} reactivity feature enum drift: [${e.join(",")}] vs canonical [${canonicalSorted.join(",")}]`,
        );
      }
    }
    assert.ok(enumCount > 0, "no reactivity feature enums found across any tools.json");
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
  //
  // Post Tier 6 R1 (MessageChannel transport): parent↔iframe traffic
  // flows over a transferred MessagePort, not window.parent.postMessage.
  // The positive assertion now verifies port-based signaling.
  await t("invariant 10: p5_bridge.js contains no forbidden parent-DOM access patterns", () => {
    const bridgeSrc = read(join(NODE_ROOT, "browser", "p5_bridge.js"));
    // These are the forms that would either throw at runtime (SOP
    // violation) or indicate an author forgot which side of the
    // boundary they're on. Port-based postMessage (parentPort) is the
    // sanctioned transport, wildcard-target window.postMessage is not.
    const forbidden = [
      /window\.parent\.document/,
      /window\.parent\.cookie/,
      /window\.parent\.localStorage/,
      /window\.parent\.sessionStorage/,
      /window\.parent\.location\s*=/,
      /window\.parent\.__\w+/,
      // R1: no wildcard-target window.parent.postMessage. The ONE
      // intentional wildcard in the sandbox flow is the host's
      // port-handoff post in p5_sandbox.mjs, not the bridge's.
      /window\.parent\.postMessage\s*\([^)]*["']\*["']/,
    ];
    for (const pat of forbidden) {
      assert.ok(!pat.test(bridgeSrc), `p5_bridge.js contains forbidden parent access: ${pat}`);
    }
    // Positive: bridge MUST use port-based messaging (parentPort) to
    // reach the host. If this regresses, the MessageChannel transport
    // is no longer the signaling path.
    assert.ok(
      /parentPort\.postMessage\s*\(/.test(bridgeSrc),
      "p5_bridge.js does not call parentPort.postMessage — MessageChannel transport is broken",
    );
    // Positive: handshake must be single-shot (listener detaches).
    assert.ok(
      /removeEventListener\s*\(\s*["']message["']/.test(bridgeSrc),
      "p5_bridge.js does not detach the handshake listener — single-shot invariant regressed",
    );
  });

  // ─── Invariant 10h (harness) ─────────────────────────────────
  // This test MOCKS the browser's sandbox-iframe semantics with a
  // vm.runInContext harness. Real enforcement comes from the browser's
  // same-origin policy + the /p5/sandbox HTTP CSP header; neither is
  // exercised here. The harness exists to catch a future code change
  // that accidentally exposes a real `window.parent`, `document`, or
  // `fetch` into a sketch-style execution context — e.g. a refactor
  // that widens the sandbox globals map beyond what the bridge should
  // see. Mock-level (not browser-level): every attempt hits a trap
  // defined in this file, so "passed" means "our understanding of the
  // contract holds", not "the browser enforces it."
  // Real-browser verification belongs in the Phase 7 Playwright smoke.
  await t("invariant 10h (harness): sketch-context mock blocks parent/top/cookie/fetch access", async () => {
    const vm = await import("node:vm");

    const parentError = "SOP: opaque origin cannot reach parent";
    const fetchError = "CSP connect-src 'none'";

    const sandboxGlobals = {
      window: new Proxy({}, {
        get(_target, prop) {
          if (prop === "top" || prop === "parent") throw new Error(parentError);
          return undefined;
        },
        set() { return true; },
      }),
      document: new Proxy({}, {
        get(_target, prop) {
          // Sentinel: real browsers return "" for cookies on an opaque
          // origin (no cookies available). We mirror that here.
          if (prop === "cookie" || prop === "domain") return "";
          return undefined;
        },
        set(_target, prop) {
          // Setting document.domain from an opaque origin throws in
          // real browsers; mirror that here.
          if (prop === "domain") throw new Error(parentError);
          return true;
        },
      }),
      fetch: () => { throw new TypeError(fetchError); },
    };
    vm.createContext(sandboxGlobals);

    // Attempt 1: window.top — must throw (SOP mock).
    assert.throws(
      () => vm.runInContext("window.top", sandboxGlobals),
      /SOP: opaque origin/,
      "window.top should throw under mock SOP",
    );

    // Attempt 2: window.parent.__anything — must throw on .parent access.
    assert.throws(
      () => vm.runInContext("window.parent.__anything", sandboxGlobals),
      /SOP: opaque origin/,
      "window.parent.__anything should throw under mock SOP",
    );

    // Attempt 3: document.domain = 'attacker.example' — must throw on set.
    assert.throws(
      () => vm.runInContext("document.domain = 'attacker.example'", sandboxGlobals),
      /SOP: opaque origin/,
      "document.domain assignment should throw under mock SOP",
    );

    // Attempt 4: document.cookie — sentinel (empty string), not a throw.
    const cookie = vm.runInContext("document.cookie", sandboxGlobals);
    assert.equal(cookie, "", "document.cookie should be empty-string sentinel in sandbox");

    // Attempt 5: fetch('http://evil.example') — must throw (CSP mock).
    assert.throws(
      () => vm.runInContext("fetch('http://evil.example')", sandboxGlobals),
      /CSP connect-src/,
      "fetch should throw under mock CSP connect-src 'none'",
    );
  });

  // ─── Phase 6 Invariant 1 (E2E) ───────────────────────────────
  // scene_reducer enforces a N=3 cap on localized sketches with a
  // belt-and-suspenders eviction: if a 4th sketch.add arrives without
  // a prior sketch.retire, the reducer evicts the oldest locally. A
  // malformed burst of 10 sketch.add patches arriving back-to-back
  // (hostile or buggy producer) must leave the stage with ≤3 iframes.
  await t("phase-6 invariant 1 (DOM-level): 10-sketch burst leaves ≤3 iframes mounted, matching slot count", async () => {
    const { createSceneReducer } = await import("../browser/scene_reducer.mjs");

    // FakeDocument that tracks iframe createElement + removeChild calls
    // at the DOM level. The cardinality assertion below counts REAL
    // iframe elements still attached to the mount tree, not just an
    // internal slot-map entry — so a future bug that detaches slot
    // bookkeeping from actual DOM lifecycle fails loudly here.
    const createLog = []; // every iframe createElement — in order
    const removeLog = []; // every iframe removeChild — in order (by sketch_id)

    function makeFakeElement(tag) {
      const el = {
        tagName: (tag ?? "div").toUpperCase(),
        children: [],
        dataset: {},
        style: {},
        _attributes: {},
        parent: null,
        appendChild(c) { this.children.push(c); c.parent = this; return c; },
        removeChild(c) {
          const i = this.children.indexOf(c);
          if (i !== -1) this.children.splice(i, 1);
          c.parent = null;
          if (c.tagName === "IFRAME") removeLog.push(c.dataset.sketchId ?? "<unknown>");
        },
        remove() {
          if (!this.parent) return;
          this.parent.removeChild(this);
        },
        setAttribute(n, v) { this._attributes[n] = v; },
        getAttribute(n) { return this._attributes[n]; },
      };
      return el;
    }

    const fakeDocument = {
      body: makeFakeElement("body"),
      createElement(tag) {
        const el = makeFakeElement(tag);
        if (el.tagName === "IFRAME") createLog.push(el);
        return el;
      },
    };
    const mount = fakeDocument.createElement("div");

    // Minimal iframe-tracking sandbox shim: mountLocalized creates an
    // iframe through the FakeDocument so createLog/removeLog see it.
    // retireSketch removes via the DOM, not an internal tracker. This
    // keeps the real N=3 eviction logic in scene_reducer in the test
    // path while giving us a DOM surface to count.
    const iframesBySketchId = new Map();
    const p5Sandbox = {
      mountBackground({ sketch_id }) {
        const iframe = fakeDocument.createElement("iframe");
        iframe.dataset.sketchId = sketch_id;
        iframe.dataset.slot = "background";
        mount.appendChild(iframe);
        iframesBySketchId.set(sketch_id, iframe);
      },
      mountLocalized({ sketch_id }) {
        const iframe = fakeDocument.createElement("iframe");
        iframe.dataset.sketchId = sketch_id;
        iframe.dataset.slot = "localized";
        mount.appendChild(iframe);
        iframesBySketchId.set(sketch_id, iframe);
      },
      retireSketch(sketch_id) {
        const iframe = iframesBySketchId.get(sketch_id);
        if (!iframe) return;
        iframe.remove();
        iframesBySketchId.delete(sketch_id);
      },
      dispose() {
        for (const id of [...iframesBySketchId.keys()]) this.retireSketch(id);
      },
      getLocalizedSlotCount() {
        let n = 0;
        for (const iframe of iframesBySketchId.values()) {
          if (iframe.dataset.slot === "localized") n += 1;
        }
        return n;
      },
    };

    const reducer = createSceneReducer({
      documentLike: fakeDocument,
      mount,
      readyTarget: fakeDocument.body,
      setTimeoutImpl: (fn) => fn(),
      p5Sandbox,
    });

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

    // Count live iframes attached to the mount (real DOM count, not
    // a bookkeeping Map).
    const liveIframes = mount.children.filter((c) => c.tagName === "IFRAME");

    assert.equal(createLog.length, 10, "expected 10 iframe createElement calls");
    assert.ok(
      liveIframes.length <= 3,
      `live iframes = ${liveIframes.length}, expected ≤3 after burst`,
    );
    assert.equal(
      liveIframes.length,
      p5Sandbox.getLocalizedSlotCount(),
      "DOM iframe count diverges from sandbox slot count — internal/external desync",
    );
    assert.equal(
      removeLog.length,
      7,
      `expected 7 iframe removeChild calls (10 created - 3 survivors), got ${removeLog.length}`,
    );
    // Evicted iframes should be the earliest 7, in insertion order.
    assert.deepEqual(
      removeLog,
      ["burst_0", "burst_1", "burst_2", "burst_3", "burst_4", "burst_5", "burst_6"],
      `eviction order mismatch: ${removeLog.join(",")}`,
    );
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
