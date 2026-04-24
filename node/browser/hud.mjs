// Code-stream HUD: renders Opus tool calls as a live-looking text feed
// alongside the main stage. Two modes are supported, both served from
// /hud in the stage server:
//
//   posthoc — fetches /run/<id>/run_summary.json once and replays the
//             parsed tool-call stream against a real-time clock started
//             when the page loads. Safe for video editing; no run
//             needs to be in progress.
//
//   live    — subscribes to the stage WebSocket and converts incoming
//             patches into HUD tool-call records on the fly. Lossy vs.
//             the raw Opus calls (patches are applied state) but reads
//             correctly as a live code stream.
//
// Rendering is a simple append-and-auto-scroll feed: monospace, low
// contrast, muted keys and highlighted values. The stream scrolls with
// the newest line at the bottom.

import {
  HUD_EVENT_KINDS,
  parseRunSummary,
  formatElapsedMmSs,
  padCycleIndex,
  patchToHudToolCall,
} from "./hud_parser.mjs";

const MAX_CODE_CHARS = 2400; // cap huge p5 sketch code before rendering
const MAX_DOM_BLOCKS = 300; // trim oldest blocks so the feed stays light

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

// Minimal JSON pretty printer that emits <span class="hud-k|hud-v">
// wrappers so CSS can mute keys and highlight values without pulling in
// a syntax-highlighting library.
function renderJsonValue(value, indent = "  ", depth = 0) {
  const pad = indent.repeat(depth);
  const childPad = indent.repeat(depth + 1);
  if (value === null) {
    return `<span class="hud-v hud-v-null">null</span>`;
  }
  if (typeof value === "boolean") {
    return `<span class="hud-v hud-v-bool">${value}</span>`;
  }
  if (typeof value === "number") {
    return `<span class="hud-v hud-v-num">${Number.isFinite(value) ? value : "null"}</span>`;
  }
  if (typeof value === "string") {
    let s = value;
    if (s.length > MAX_CODE_CHARS) {
      s = `${s.slice(0, MAX_CODE_CHARS)}… [+${s.length - MAX_CODE_CHARS} chars]`;
    }
    const escaped = JSON.stringify(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<span class="hud-v hud-v-str">${escaped}</span>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `[]`;
    const parts = value.map((v) => `${childPad}${renderJsonValue(v, indent, depth + 1)}`);
    return `[\n${parts.join(",\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return `{}`;
    const parts = keys.map((k) => {
      const escapedKey = k.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `${childPad}<span class="hud-k">"${escapedKey}"</span>: ${renderJsonValue(
        value[k],
        indent,
        depth + 1,
      )}`;
    });
    return `{\n${parts.join(",\n")}\n${pad}}`;
  }
  return String(value);
}

function renderToolCallBlock({ name, input, cycle_index, t_ms }) {
  const block = el("div", "hud-block hud-tool");
  const header = el("div", "hud-tool-header");
  header.appendChild(
    el("span", "hud-tool-meta", `cycle ${padCycleIndex(cycle_index)} · ${formatElapsedMmSs(t_ms)}`),
  );
  header.appendChild(el("span", "hud-tool-name", name));
  block.appendChild(header);
  const pre = document.createElement("pre");
  pre.className = "hud-json";
  pre.innerHTML = renderJsonValue({ tool: name, input }, "  ", 0);
  block.appendChild(pre);
  return block;
}

function renderCycleHeaderBlock({ cycle_index, t_ms, status }) {
  const block = el("div", "hud-block hud-cycle-header");
  const label = `── CYCLE ${padCycleIndex(cycle_index)} ── ${formatElapsedMmSs(t_ms)} ──`;
  block.appendChild(el("span", "hud-cycle-label", label));
  if (status && status !== "ok") {
    block.appendChild(el("span", "hud-cycle-status", `[${status}]`));
  }
  return block;
}

function renderRunStartBlock(event) {
  const block = el("div", "hud-block hud-run-start");
  const parts = [
    `// feed-looks-back :: opus code stream`,
    `// run_id = ${event.run_id ?? "(unknown)"}`,
    `// model  = ${event.model ?? "(unknown)"}`,
    `// config = ${event.config ?? "(unknown)"}`,
    `// mode   = ${event.mode ?? "(unknown)"}`,
    `// cycles = ${event.cycles_total ?? "?"}`,
  ];
  for (const line of parts) block.appendChild(el("div", "hud-run-start-line", line));
  return block;
}

function renderRunEndBlock(event) {
  const block = el("div", "hud-block hud-run-end");
  const label = `── run complete ── ${event.cycles_completed ?? 0} cycles ──`;
  block.appendChild(el("span", "hud-cycle-label", label));
  return block;
}

function createFeed(root) {
  const stream = el("div", "hud-stream");
  root.appendChild(stream);
  let autoScroll = true;

  stream.addEventListener("scroll", () => {
    const atBottom =
      stream.scrollHeight - stream.scrollTop - stream.clientHeight < 8;
    autoScroll = atBottom;
  });

  function trim() {
    while (stream.children.length > MAX_DOM_BLOCKS) {
      stream.removeChild(stream.firstChild);
    }
  }

  function append(block) {
    stream.appendChild(block);
    trim();
    if (autoScroll) stream.scrollTop = stream.scrollHeight;
  }

  return { append };
}

function createStatusBar(root) {
  const bar = el("div", "hud-status");
  bar.appendChild(el("span", "hud-status-mode", ""));
  bar.appendChild(el("span", "hud-status-clock", ""));
  bar.appendChild(el("span", "hud-status-state", ""));
  root.appendChild(bar);
  return {
    set({ mode, clock_ms, state }) {
      if (mode != null) bar.children[0].textContent = mode;
      if (clock_ms != null) bar.children[1].textContent = formatElapsedMmSs(clock_ms);
      if (state != null) bar.children[2].textContent = state;
    },
  };
}

function dispatchEvent(event, feed) {
  switch (event.kind) {
    case HUD_EVENT_KINDS.RUN_START:
      feed.append(renderRunStartBlock(event));
      return;
    case HUD_EVENT_KINDS.CYCLE_BEGIN:
      feed.append(
        renderCycleHeaderBlock({
          cycle_index: event.cycle_index,
          t_ms: event.t_ms,
          status: event.status,
        }),
      );
      return;
    case HUD_EVENT_KINDS.TOOL_CALL:
      feed.append(
        renderToolCallBlock({
          name: event.name,
          input: event.input,
          cycle_index: event.cycle_index,
          t_ms: event.t_ms,
        }),
      );
      return;
    case HUD_EVENT_KINDS.CYCLE_END:
      // Cycle end is implied by the next cycle begin. Only surface on
      // non-ok to make failures visible in the stream.
      if (event.status && event.status !== "ok") {
        const block = el("div", "hud-block hud-cycle-error");
        block.appendChild(
          el("span", "hud-cycle-label", `└── cycle ${padCycleIndex(event.cycle_index)} ${event.status}`),
        );
        feed.append(block);
      }
      return;
    case HUD_EVENT_KINDS.RUN_END:
      feed.append(renderRunEndBlock(event));
      return;
    default:
      return;
  }
}

export async function mountPosthoc({
  root,
  run_id,
  fetchImpl = globalThis.fetch,
  speed = 1,
  autoStartDelayMs = 400,
  setTimeoutImpl = globalThis.setTimeout,
} = {}) {
  if (!root) throw new Error("mountPosthoc: root is required");
  if (!run_id) throw new Error("mountPosthoc: run_id is required");

  const feed = createFeed(root);
  const status = createStatusBar(root);
  status.set({ mode: "POST-HOC", state: "loading…", clock_ms: 0 });

  let summary;
  try {
    const res = await fetchImpl(`/run/${encodeURIComponent(run_id)}/run_summary.json`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    summary = await res.json();
  } catch (err) {
    status.set({ state: `load failed: ${err?.message ?? err}` });
    feed.append(el("div", "hud-block hud-cycle-error", `load failed: ${err?.message ?? err}`));
    return { stop() {} };
  }

  const events = parseRunSummary(summary);
  status.set({ state: `${events.length} events ready`, clock_ms: 0 });

  const effectiveSpeed = speed > 0 ? speed : 1;
  const start_wall = Date.now() + autoStartDelayMs;
  let idx = 0;
  let stopped = false;
  let tickHandle = null;

  function tick() {
    if (stopped) return;
    const elapsed = Math.max(0, (Date.now() - start_wall) * effectiveSpeed);
    status.set({ clock_ms: elapsed, state: idx < events.length ? "playing" : "done" });
    while (idx < events.length && events[idx].t_ms <= elapsed) {
      dispatchEvent(events[idx], feed);
      idx += 1;
    }
    if (idx < events.length) {
      const next_ms = events[idx].t_ms - elapsed;
      const delay = Math.max(30, Math.min(1000, next_ms / effectiveSpeed));
      tickHandle = setTimeoutImpl(tick, delay);
    } else {
      status.set({ state: "done" });
    }
  }

  tickHandle = setTimeoutImpl(tick, autoStartDelayMs);

  return {
    stop() {
      stopped = true;
      if (tickHandle != null && typeof clearTimeout === "function") clearTimeout(tickHandle);
    },
  };
}

// Lightweight live mode: subscribe to the stage WebSocket and translate
// patches into HUD tool-call records as they arrive. Reuses the stage's
// own ws_client for handshake/reconnect behavior. Elapsed clock starts
// at cycle.begin patches (cycle_n * estimated window) so the HUD header
// times line up roughly with the run's cycles.
export async function mountLive({
  root,
  run_id,
  mode = "live",
  createWsClientImpl,
} = {}) {
  if (!root) throw new Error("mountLive: root is required");
  if (!run_id) throw new Error("mountLive: run_id is required");

  const feed = createFeed(root);
  const status = createStatusBar(root);
  status.set({ mode: "LIVE", state: "connecting…", clock_ms: 0 });

  let ws_client = createWsClientImpl;
  if (!ws_client) {
    const mod = await import("./ws_client.mjs");
    ws_client = mod.createWsClient;
  }

  let start_wall = null;
  let current_cycle = null;
  let call_index_in_cycle = 0;

  function now_ms() {
    if (start_wall == null) return 0;
    return Date.now() - start_wall;
  }

  feed.append(
    renderRunStartBlock({
      run_id,
      model: "claude-opus-4-7",
      config: "(live)",
      mode,
      cycles_total: "?",
    }),
  );

  const client = ws_client({
    run_id,
    mode,
    onStatus: (evt) => {
      status.set({ state: evt.type, clock_ms: now_ms() });
    },
    onPatch: (patch) => {
      if (!patch) return;
      if (patch.type === "cycle.begin") {
        if (start_wall == null) start_wall = Date.now();
        current_cycle = patch.cycle_n ?? current_cycle;
        call_index_in_cycle = 0;
        feed.append(
          renderCycleHeaderBlock({
            cycle_index: current_cycle,
            t_ms: now_ms(),
            status: "ok",
          }),
        );
        status.set({ clock_ms: now_ms(), state: `cycle ${padCycleIndex(current_cycle)}` });
        return;
      }
      if (patch.type === "cycle.end" || patch.type === "replay.begin" || patch.type === "replay.end") {
        return;
      }
      const call = patchToHudToolCall(patch);
      if (!call) return;
      feed.append(
        renderToolCallBlock({
          name: call.name,
          input: call.input,
          cycle_index: current_cycle ?? 0,
          t_ms: now_ms(),
        }),
      );
      call_index_in_cycle += 1;
    },
    onFeature: () => {
      // HUD ignores feature messages — keep the stream focused on code.
    },
  });

  return {
    stop() {
      try {
        client.close();
      } catch {
        // ignore
      }
    },
  };
}

export async function bootstrapHud({ location = globalThis.location, document: doc = globalThis.document } = {}) {
  const root = doc.getElementById("hud-root");
  if (!root) throw new Error("bootstrapHud: #hud-root missing");
  const params = new URL(location.href).searchParams;
  const run_id = params.get("run_id");
  const mode = params.get("mode") === "live" ? "live" : "posthoc";
  const speed = Number(params.get("speed")) || 1;
  if (!run_id) {
    root.appendChild(
      el(
        "div",
        "hud-block hud-cycle-error",
        "missing ?run_id=... — open /hud?run_id=<run_id>&mode=posthoc to replay a run_summary.json",
      ),
    );
    return;
  }
  if (mode === "live") {
    await mountLive({ root, run_id });
  } else {
    await mountPosthoc({ root, run_id, speed });
  }
}

// Auto-bootstrap when loaded as a <script type="module"> in the browser.
if (typeof globalThis.document !== "undefined" && typeof globalThis.location !== "undefined") {
  const doc = globalThis.document;
  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", () => {
      void bootstrapHud();
    });
  } else {
    void bootstrapHud();
  }
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

  // Minimal DOM stub — just enough to exercise mountPosthoc without JSDOM.
  class FakeEl {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.className = "";
      this._text = "";
      this.innerHTML = "";
      this.scrollTop = 0;
      this.scrollHeight = 0;
      this.clientHeight = 0;
      this._listeners = new Map();
    }
    set textContent(v) {
      this._text = String(v);
    }
    get textContent() {
      if (this._text) return this._text;
      return this.children.map((c) => c.textContent || "").join(" ");
    }
    appendChild(child) {
      this.children.push(child);
      this.scrollHeight += 20;
      return child;
    }
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
    }
    get firstChild() {
      return this.children[0];
    }
    addEventListener(type, handler) {
      const list = this._listeners.get(type) ?? [];
      list.push(handler);
      this._listeners.set(type, list);
    }
  }
  const fakeDoc = {
    createElement(tag) {
      return new FakeEl(tag);
    },
  };
  globalThis.document = fakeDoc;

  await t("mountPosthoc renders events from a stubbed fetch", async () => {
    const root = new FakeEl("div");
    const summary = {
      run_id: "abc",
      config: "test",
      model: "claude-opus-4-7",
      mode: "precompute",
      cycles_total: 1,
      per_cycle: [
        {
          cycle_index: 0,
          cycle_id: "cycle_000",
          elapsed_s: 0.2,
          status: "ok",
          tool_calls: [{ name: "setBackground", input: { css_background: "#000" } }],
        },
      ],
    };
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return summary;
      },
    });
    const tasks = [];
    const setTimeoutImpl = (fn, _delay) => {
      tasks.push(fn);
      return tasks.length;
    };
    await mountPosthoc({
      root,
      run_id: "abc",
      fetchImpl,
      speed: 1000, // fast-forward: one sim-ms per real-ms
      autoStartDelayMs: 0,
      setTimeoutImpl,
    });
    // Drain the scheduled ticks.
    while (tasks.length) {
      const fn = tasks.shift();
      fn();
    }
    // At minimum we expect the status bar, stream, and several rendered blocks.
    assert.ok(root.children.length >= 2, "root should have stream + status bar");
    const stream = root.children[0];
    function collectText(node) {
      const self = [node.textContent, node.innerHTML].filter(Boolean).join(" ");
      const kids = (node.children || []).map(collectText).join(" ");
      return `${self} ${kids}`;
    }
    const blob = stream.children.map(collectText).join(" | ");
    assert.ok(/opus code stream/i.test(blob), "run_start block present");
    assert.ok(/CYCLE 000/.test(blob), "cycle_begin block present");
    assert.ok(/setBackground/.test(blob), "tool_call block with name rendered");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
