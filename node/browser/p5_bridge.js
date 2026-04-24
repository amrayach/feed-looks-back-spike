// node/browser/p5_bridge.js
// Iframe-side bridge, loaded from /p5/bridge.js inside the sandboxed
// iframe. Runs under CSP: default-src 'none'; script-src 'self'
// 'unsafe-eval'; connect-src 'none'; frame-src 'none'; style-src
// 'unsafe-inline'; img-src 'self' data: blob:.
//
// Contract:
//   - Reads user sketch code from <script type="application/json"
//     id="flb-sketch-code">. The script block is inert per CSP (not
//     JavaScript) so we can embed arbitrary text there without inline-
//     script execution.
//   - Installs a feature mirror on window.features so sketches written
//     in p5 global mode can read audio features directly.
//   - Forwards parent -> iframe postMessage feature frames into
//     window.features; rejects messages whose origin OR source doesn't
//     match the parent window.
//   - Posts {type:"ready"} once the bridge is ready to receive features,
//     {type:"heartbeat"} on a 500 ms interval, and {type:"error"} on
//     any sketch error. Outbound messages are targeted at the parent's
//     origin so they cannot be intercepted by a foreign origin.
//   - Executes the sketch via indirect eval so p5's global-mode hooks
//     (setup/draw) land on the global object. Requires 'unsafe-eval';
//     safe because the iframe has sandbox="allow-scripts" without
//     allow-same-origin, so the eval'd code has no parent DOM access,
//     no cookies, and connect-src 'none' denies any network egress.
//
// Companion host: node/browser/p5_sandbox.mjs (host-side manager).
// Companion server: node/src/stage_server.mjs (/p5/sandbox route).

(function () {
  // Even though the iframe is sandboxed without allow-same-origin
  // (making its document origin opaque -> window.location.origin is
  // "null"), window.location.href still contains the full URL the
  // iframe was loaded from. Parsing that URL gives us the parent's
  // origin, which is what postMessage targetOrigin must match.
  var parentOrigin;
  try {
    parentOrigin = new URL(window.location.href).origin;
  } catch (_err) {
    parentOrigin = "*";
  }

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

  function post(msg) {
    try {
      window.parent.postMessage(msg, parentOrigin);
    } catch (_err) {
      // best effort
    }
  }
  function postReady() {
    post({ type: "ready" });
  }
  function postHeartbeat() {
    post({
      type: "heartbeat",
      frame_count: window.__flb_frame_count,
      last_frame_time_ms: window.__flb_last_frame_time_ms,
    });
  }
  function postError(message) {
    post({ type: "error", message: String(message).slice(0, 500) });
  }

  window.addEventListener("message", function (event) {
    // Paired with the host's source+origin gate: only accept messages
    // from window.parent, and only if the origin line up. The parent
    // posts with its real origin; the iframe's document origin is
    // opaque so event.origin here is the real parent origin.
    if (event.source !== window.parent) return;
    if (event.origin !== parentOrigin && event.origin !== "null") return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "features" && data.values && typeof data.values === "object") {
      var values = data.values;
      for (var key in values) {
        if (Object.prototype.hasOwnProperty.call(values, key)) {
          window.features[key] = values[key];
        }
      }
    }
  });

  setInterval(postHeartbeat, 500);

  window.addEventListener("error", function (event) {
    postError(event && event.message ? event.message : "sketch error");
  });

  postReady();

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
})();
