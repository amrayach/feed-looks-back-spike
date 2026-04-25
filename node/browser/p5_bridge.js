// node/browser/p5_bridge.js
// Iframe-side bridge, loaded from /p5/bridge.js inside the sandboxed
// iframe. Runs under CSP: default-src 'none'; script-src 'self'
// 'unsafe-eval'; connect-src 'none'; frame-src 'none'; style-src
// 'unsafe-inline'; img-src 'self' data: blob:.
//
// Contract (post Tier 6 R1 MessageChannel refactor):
//   - Reads user sketch code from <script type="application/json"
//     id="flb-sketch-code">. The script block is inert per CSP (not
//     JavaScript) so we can embed arbitrary text there without inline-
//     script execution.
//   - Installs a feature mirror on window.features so sketches written
//     in p5 global mode can read audio features directly.
//   - On load, the parent posts ONE wildcard-target message carrying a
//     transferred MessagePort (handshake type="port-handoff"). After
//     that, ALL parent↔iframe traffic flows over the port — no more
//     window.postMessage. Origin disappears as a concept once the port
//     is installed; the port itself is the capability.
//   - Rejects any handshake whose source is not window.parent, or
//     whose shape is not {type:"port-handoff", ports:[1 port]}. Detaches
//     the window listener after the first valid handshake, so a later
//     attacker who somehow reaches window.postMessage cannot hand us a
//     second port and hijack the transport.
//   - Posts {type:"ready"} once the port is up, {type:"heartbeat"}
//     on a 500 ms interval, {type:"error"} on any sketch error. All
//     outbound messages go over parentPort.postMessage(...). No
//     targetOrigin anywhere on the port path — ports do not use
//     origin for addressing.
//   - Executes the sketch via indirect eval so p5's global-mode hooks
//     (setup/draw) land on the global object. Requires 'unsafe-eval';
//     safe because the iframe has sandbox="allow-scripts" without
//     allow-same-origin, so the eval'd code has no parent DOM access,
//     no cookies, and connect-src 'none' denies any network egress.
//
// Companion host: node/browser/p5_sandbox.mjs (host-side manager).
// Companion server: node/src/stage_server.mjs (/p5/sandbox route).

(function () {
  var parentPort = null;
  var heartbeatIntervalId = null;
  var pendingLogs = [];
  var consoleLike = typeof console !== "undefined"
    ? console
    : { log: function () {}, warn: function () {}, error: function () {} };

  window.features = {
    amplitude: 0,
    onset_strength: 0,
    spectral_centroid: 0,
    hijaz_state: "unknown",
    hijaz_intensity: 0,
    hijaz_tahwil: false,
  };
  window.__flb_frame_count = 0;
  window.__flb_last_frame_time_ms = 0;

  function portPost(msg) {
    if (!parentPort) return;
    try {
      parentPort.postMessage(msg);
    } catch (_err) {
      // best effort — port may have been closed by the host
    }
  }
  function postReady(sketchId) {
    portPost({ type: "ready", sketch_id: sketchId || null });
  }
  function postHeartbeat() {
    portPost({
      type: "heartbeat",
      frame_count: window.__flb_frame_count,
      last_frame_time_ms: window.__flb_last_frame_time_ms,
    });
  }
  function postError(message) {
    portPost({ type: "error", message: String(message).slice(0, 500) });
  }
  function formatLogArg(arg) {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack || arg.message || String(arg);
    try {
      return JSON.stringify(arg);
    } catch (_err) {
      return String(arg);
    }
  }
  function postLog(level, args) {
    var message = Array.prototype.slice.call(args).map(formatLogArg).join(" ").slice(0, 1000);
    var payload = { type: "log", level: level, message: message };
    if (!parentPort) {
      pendingLogs.push(payload);
      if (pendingLogs.length > 20) pendingLogs.shift();
      return;
    }
    portPost(payload);
  }
  ["log", "warn", "error"].forEach(function (level) {
    var original = consoleLike[level] && consoleLike[level].bind(consoleLike);
    consoleLike[level] = function () {
      if (original) original.apply(consoleLike, arguments);
      postLog(level, arguments);
    };
  });
  function flushPendingLogs() {
    while (pendingLogs.length > 0) {
      portPost(pendingLogs.shift());
    }
  }

  function handleIncoming(data) {
    if (!data || typeof data !== "object") return;
    if (data.type === "features" && data.values && typeof data.values === "object") {
      var values = data.values;
      for (var key in values) {
        if (Object.prototype.hasOwnProperty.call(values, key)) {
          window.features[key] = values[key];
        }
      }
    }
  }

  // Single-shot handshake listener. The ONE intentional wildcard-target
  // postMessage in the whole sandbox flow is the parent's load-event
  // post that delivers port2 to us. Iframe's sandbox=allow-scripts
  // (no allow-same-origin) forces an opaque document origin, and
  // targetOrigin cannot name opaque origins — so the handshake is
  // protected by three layers instead:
  //   (a) event.source === window.parent
  //   (b) message shape (type="port-handoff", exactly 1 transferred port)
  //   (c) the listener detaches after the first valid handshake
  // See docs/superpowers/plans/2026-04-24-tier-6-rework-plan.md §4 and
  // the Codex Tier 6 blocker that drove this refactor.
  function onHandshake(event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type !== "port-handoff") return;
    if (!event.ports || event.ports.length !== 1) return;
    parentPort = event.ports[0];
    parentPort.onmessage = function (portEvent) {
      handleIncoming(portEvent.data);
    };
    // Single-shot: remove ourselves so an attacker who somehow reaches
    // window.postMessage cannot hand us a second port.
    window.removeEventListener("message", onHandshake);
    // Signal readiness to the host via the port. No targetOrigin; the
    // port IS the capability.
    postReady(data.sketch_id);
    flushPendingLogs();
    // Only start heartbeats once the port is up; before then, there is
    // no receiver, so heartbeats would be silently dropped.
    heartbeatIntervalId = setInterval(postHeartbeat, 500);
  }
  window.addEventListener("message", onHandshake);

  window.addEventListener("error", function (event) {
    postError(event && event.message ? event.message : "sketch error");
  });

  var codeEl = document.getElementById("flb-sketch-code");
  var code = "";
  if (codeEl) {
    try {
      var parsed = JSON.parse(codeEl.textContent || "\"\"");
      code = typeof parsed === "string" ? parsed : "";
    } catch (_err) {
      code = "";
    }
  }

  try {
    // Indirect eval runs the sketch at global scope so p5's global-mode
    // hooks (setup, draw, etc.) land on window. Direct eval would scope
    // those declarations to this IIFE and p5 would never find them.
    (0, eval)(code);
  } catch (err) {
    postError(err && err.message ? err.message : "sketch runtime error");
  }

  // Expose a small teardown hook for tests that embed this bridge in a
  // vm context. In a real browser the iframe unload tears down the
  // interval; the harness doesn't. Harmless at runtime.
  window.__flb_bridge_teardown = function () {
    if (heartbeatIntervalId != null) {
      try { clearInterval(heartbeatIntervalId); } catch (_err) { /* ignore */ }
      heartbeatIntervalId = null;
    }
    if (parentPort) {
      try { parentPort.close && parentPort.close(); } catch (_err) { /* ignore */ }
      parentPort = null;
    }
  };
})();
