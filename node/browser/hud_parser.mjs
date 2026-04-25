// HUD log parser: turns a run_summary.json object into a time-ordered
// stream of events the HUD renderer can replay.
//
// The spike's cycle log only records per-cycle wall-clock elapsed_s (end
// of cycle). Individual tool calls don't carry their own timestamps, so
// for replay we stagger them evenly across each cycle's window. That
// gives a plausible "typing" cadence without fabricating precise per-call
// times we don't have.
//
// Pure data transform — no DOM, no fetch, no timers — so it can run in
// Node for tests and in the browser for the actual HUD.

export const HUD_EVENT_KINDS = Object.freeze({
  RUN_START: "run_start",
  CYCLE_BEGIN: "cycle_begin",
  TOOL_CALL: "tool_call",
  CYCLE_END: "cycle_end",
  RUN_END: "run_end",
});

function coerceElapsedMs(elapsed_s) {
  const n = Number(elapsed_s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1000);
}

export function parseRunSummary(summary) {
  if (!summary || typeof summary !== "object") {
    throw new TypeError("parseRunSummary: summary must be an object");
  }
  const per_cycle = Array.isArray(summary.per_cycle) ? summary.per_cycle : [];
  const events = [];

  events.push({
    t_ms: 0,
    kind: HUD_EVENT_KINDS.RUN_START,
    run_id: summary.run_id ?? null,
    config: summary.config ?? null,
    model: summary.model ?? null,
    mode: summary.mode ?? null,
    cycles_total: Number.isFinite(summary.cycles_total)
      ? summary.cycles_total
      : per_cycle.length,
    started_at: summary.started_at ?? null,
  });

  let prev_end_ms = 0;

  for (const entry of per_cycle) {
    const end_ms = coerceElapsedMs(entry?.elapsed_s);
    // Guard against non-monotonic or missing elapsed: clamp forward so
    // replay scheduling stays in order even with a broken summary.
    const safe_end_ms = end_ms == null || end_ms < prev_end_ms ? prev_end_ms : end_ms;
    const window_ms = Math.max(0, safe_end_ms - prev_end_ms);

    events.push({
      t_ms: prev_end_ms,
      kind: HUD_EVENT_KINDS.CYCLE_BEGIN,
      cycle_index: entry?.cycle_index ?? null,
      cycle_id: entry?.cycle_id ?? null,
      status: entry?.status ?? null,
      elapsed_s: entry?.elapsed_s ?? null,
    });

    const tool_calls = Array.isArray(entry?.tool_calls) ? entry.tool_calls : [];
    // Spread calls across the cycle's window with a gentle lead-in so the
    // first call doesn't fire at the exact moment of cycle_begin.
    const slot_count = Math.max(tool_calls.length, 1);
    for (let i = 0; i < tool_calls.length; i += 1) {
      const frac = (i + 1) / (slot_count + 1);
      const t_ms = Math.round(prev_end_ms + window_ms * frac);
      const call = tool_calls[i];
      events.push({
        t_ms,
        kind: HUD_EVENT_KINDS.TOOL_CALL,
        cycle_index: entry?.cycle_index ?? null,
        index_in_cycle: i,
        name: call?.name ?? "(unknown)",
        input: call?.input ?? {},
      });
    }

    events.push({
      t_ms: safe_end_ms,
      kind: HUD_EVENT_KINDS.CYCLE_END,
      cycle_index: entry?.cycle_index ?? null,
      status: entry?.status ?? null,
      error: entry?.error ?? null,
      tool_call_count: tool_calls.length,
      elapsed_s: entry?.elapsed_s ?? null,
    });

    prev_end_ms = safe_end_ms;
  }

  events.push({
    t_ms: prev_end_ms,
    kind: HUD_EVENT_KINDS.RUN_END,
    cycles_completed: per_cycle.length,
    finished_at: summary.finished_at ?? null,
  });

  // Stable sort by t_ms — same-timestamp events keep insertion order,
  // which matches the per_cycle ordering above.
  events.sort((a, b) => a.t_ms - b.t_ms);
  return events;
}

export function formatElapsedMmSs(ms) {
  const total_s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total_s / 60).toString().padStart(2, "0");
  const ss = (total_s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export function padCycleIndex(idx) {
  const n = Number(idx);
  return Number.isFinite(n) ? String(n).padStart(3, "0") : "???";
}

// Convert live WS patches into HUD tool-call-shaped records so live mode
// can render a similar stream without access to raw tool calls. Lossy by
// design — patches are applied state, not the original Opus call — but
// the reconstructed name + input reads naturally in the HUD.
export function patchToHudToolCall(patch) {
  if (!patch || typeof patch !== "object") return null;
  switch (patch.type) {
    case "background.set":
      return {
        name: "setBackground",
        input: { css_background: patch.css_background },
      };
    case "element.add": {
      const el = patch.element ?? {};
      const content = el.content ?? {};
      let name = "addElement";
      if (el.type === "text") name = "addText";
      else if (el.type === "image") name = "addImage";
      else if (el.type === "svg") name = "addSVG";
      return {
        name,
        input: {
          element_id: el.element_id,
          ...content,
          lifetime_s: el.lifetime_s ?? null,
          composition_group_id: el.composition_group_id ?? null,
        },
      };
    }
    case "element.retire":
      return { name: "retireElement", input: { element_id: patch.element_id } };
    case "sketch.add":
      return {
        name: "addP5Sketch",
        input: {
          sketch_id: patch.sketch_id,
          position: patch.position,
          size: patch.size,
          audio_reactive: patch.audio_reactive,
          lifetime_s: patch.lifetime_s ?? null,
          code: patch.code,
        },
      };
    case "sketch.background.set":
      return {
        name: "setP5Background",
        input: {
          sketch_id: patch.sketch_id,
          audio_reactive: patch.audio_reactive,
          code: patch.code,
        },
      };
    case "sketch.retire":
      return { name: "retireSketch", input: { sketch_id: patch.sketch_id } };
    default:
      return null;
  }
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const { readFileSync, existsSync, readdirSync } = await import("node:fs");
  const { join, dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  let pass = 0;
  let fail = 0;
  function t(desc, fn) {
    try {
      fn();
      pass += 1;
      process.stdout.write(`  ok  ${desc}\n`);
    } catch (err) {
      fail += 1;
      process.stdout.write(`  FAIL ${desc}\n    ${err.message}\n`);
    }
  }

  t("parseRunSummary rejects non-object input", () => {
    assert.throws(() => parseRunSummary(null), TypeError);
    assert.throws(() => parseRunSummary("oops"), TypeError);
  });

  t("parseRunSummary emits RUN_START / RUN_END with empty per_cycle", () => {
    const events = parseRunSummary({ run_id: "abc", per_cycle: [] });
    assert.equal(events[0].kind, HUD_EVENT_KINDS.RUN_START);
    assert.equal(events[0].run_id, "abc");
    assert.equal(events[events.length - 1].kind, HUD_EVENT_KINDS.RUN_END);
  });

  t("parseRunSummary staggers tool calls across a cycle window", () => {
    const events = parseRunSummary({
      run_id: "r",
      per_cycle: [
        {
          cycle_index: 0,
          cycle_id: "cycle_000",
          elapsed_s: 10,
          status: "ok",
          tool_calls: [
            { name: "setBackground", input: { css_background: "#000" } },
            { name: "addText", input: { content: "hi" } },
          ],
        },
      ],
    });
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, [
      HUD_EVENT_KINDS.RUN_START,
      HUD_EVENT_KINDS.CYCLE_BEGIN,
      HUD_EVENT_KINDS.TOOL_CALL,
      HUD_EVENT_KINDS.TOOL_CALL,
      HUD_EVENT_KINDS.CYCLE_END,
      HUD_EVENT_KINDS.RUN_END,
    ]);
    const calls = events.filter((e) => e.kind === HUD_EVENT_KINDS.TOOL_CALL);
    // Evenly spaced inside 0..10000 ms window with a lead-in: slots at 1/3, 2/3.
    assert.ok(calls[0].t_ms > 0 && calls[0].t_ms < calls[1].t_ms);
    assert.ok(calls[1].t_ms < 10000);
    assert.equal(calls[0].name, "setBackground");
    assert.equal(calls[1].name, "addText");
  });

  t("parseRunSummary clamps non-monotonic elapsed_s forward", () => {
    const events = parseRunSummary({
      run_id: "r",
      per_cycle: [
        { cycle_index: 0, cycle_id: "cycle_000", elapsed_s: 10, tool_calls: [] },
        { cycle_index: 1, cycle_id: "cycle_001", elapsed_s: 3, tool_calls: [] },
      ],
    });
    const ends = events.filter((e) => e.kind === HUD_EVENT_KINDS.CYCLE_END);
    assert.equal(ends[0].t_ms, 10000);
    // Cycle 1 end would go backward — parser clamps to prev_end_ms.
    assert.ok(ends[1].t_ms >= ends[0].t_ms);
  });

  t("formatElapsedMmSs zero-pads mm:ss", () => {
    assert.equal(formatElapsedMmSs(0), "00:00");
    assert.equal(formatElapsedMmSs(65_000), "01:05");
    assert.equal(formatElapsedMmSs(3661_000), "61:01");
  });

  t("padCycleIndex zero-pads to width 3", () => {
    assert.equal(padCycleIndex(0), "000");
    assert.equal(padCycleIndex(7), "007");
    assert.equal(padCycleIndex(143), "143");
  });

  t("patchToHudToolCall maps common patch types", () => {
    const bg = patchToHudToolCall({ type: "background.set", css_background: "#111" });
    assert.equal(bg.name, "setBackground");
    const text = patchToHudToolCall({
      type: "element.add",
      element: {
        element_id: "elem_0001",
        type: "text",
        content: { content: "hi", position: "center", style: "serif" },
      },
    });
    assert.equal(text.name, "addText");
    assert.equal(text.input.content, "hi");
    const sketch = patchToHudToolCall({
      type: "sketch.add",
      sketch_id: "sk_1",
      code: "draw(){}",
      audio_reactive: true,
      position: "center",
      size: "small",
    });
    assert.equal(sketch.name, "addP5Sketch");
    assert.equal(sketch.input.code, "draw(){}");
    const p5bg = patchToHudToolCall({
      type: "sketch.background.set",
      sketch_id: "sk_bg",
      code: "function draw(){}",
      audio_reactive: false,
    });
    assert.equal(p5bg.name, "setP5Background");
    const svg = patchToHudToolCall({
      type: "element.add",
      element: {
        element_id: "elem_0002",
        type: "svg",
        content: { svg_markup: "<svg></svg>", semantic_label: "mark" },
      },
    });
    assert.equal(svg.name, "addSVG");
    assert.equal(patchToHudToolCall(null), null);
    assert.equal(patchToHudToolCall({ type: "unknown" }), null);
  });

  // Real-world fixture: parse a real run_summary.json if present. This run
  // is not checked into this worktree (output/ is gitignored), so the
  // test is opportunistic — skipped when no sibling spike is available.
  t("parses a real run_summary.json fixture (best-effort)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const spikeOutput = resolve(here, "../../..", "feed-looks-back-spike/node/output");
    if (!existsSync(spikeOutput)) {
      process.stdout.write("    (skipped: no spike output tree visible)\n");
      return;
    }
    // Pick any non-empty summary with at least one OK cycle.
    const runs = readdirSync(spikeOutput)
      .filter((name) => name.startsWith("run_"))
      .map((name) => join(spikeOutput, name, "run_summary.json"))
      .filter((p) => existsSync(p));
    let summary = null;
    for (const p of runs) {
      try {
        const candidate = JSON.parse(readFileSync(p, "utf8"));
        if (
          Array.isArray(candidate.per_cycle) &&
          candidate.per_cycle.some((c) => (c.tool_calls ?? []).length > 0)
        ) {
          summary = candidate;
          break;
        }
      } catch {
        // ignore unreadable summaries
      }
    }
    if (!summary) {
      process.stdout.write("    (skipped: no summary with tool calls found)\n");
      return;
    }
    const events = parseRunSummary(summary);
    assert.ok(events.length >= 3, "at least run_start + cycle_begin + run_end");
    assert.equal(events[0].kind, HUD_EVENT_KINDS.RUN_START);
    assert.equal(events[events.length - 1].kind, HUD_EVENT_KINDS.RUN_END);
    const tool = events.find((e) => e.kind === HUD_EVENT_KINDS.TOOL_CALL);
    assert.ok(tool, "expected at least one tool_call event");
    assert.ok(typeof tool.name === "string" && tool.name.length > 0);
    assert.ok(tool.input && typeof tool.input === "object");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
