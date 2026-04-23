import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// null = permanent, only fades via explicit fadeElement.
export const DEFAULT_LIFETIMES = Object.freeze({
  text: null,
  svg: 35,
  image: null,
  background: null,
});

// auto-fade fires when an element's fades_at_elapsed_s is less than
// current_elapsed_s + AUTO_FADE_OVERLAP_S. opus sees the element one last
// time at the start of the cycle where this becomes true, annotated
// "fading next cycle" in the summary; by the next cycle it is gone from
// the active view.
export const AUTO_FADE_OVERLAP_S = 5;

export const SVG_MARKUP_MAX_SUMMARY_CHARS = 100;

// Size of the rolling cycle-count history retained for the SCENE OVERVIEW
// trajectory line. Four is the minimum we need (3 past + current), plus a
// small cushion so a short stall in beginCycle doesn't drop data mid-run.
export const CYCLE_HISTORY_MAX = 8;
export const ACTIVITY_HISTORY_MAX = 64;

// Crowding thresholds for SCENE OVERVIEW Line 2: a region is flagged as
// crowded when it holds at least this many non-faded elements AND that count
// is at least this share of the total non-faded elements.
export const CROWDED_MIN_COUNT = 3;
export const CROWDED_MIN_SHARE = 0.4;

// Density-trajectory classification thresholds. Difference between current
// count and 3-cycles-ago count beyond +/- this amount flips the label.
export const TRAJECTORY_DELTA_THRESHOLD = 3;
export const SCENE_OCCUPANCY_FLOOR = 6;

// Background floor: after this many cycles without a setBackground call,
// SCENE OVERVIEW emits a "due" signal so Opus has a visible handle on the
// cadence the prompt names.
export const SCENE_BACKGROUND_FLOOR_CYCLES = 12;

// Nine-region grid used by computeOverview, in the exact order emitted on
// the Spatial line so the format is stable for Opus.
export const SPATIAL_REGIONS = Object.freeze([
  "upper-left", "upper-center", "upper-right",
  "middle-left", "middle-center", "middle-right",
  "lower-left", "lower-center", "lower-right",
]);

export function createInitialState() {
  return {
    elements: [],
    background: {
      css_background: null,
      set_at_cycle: null,
      set_at_elapsed_s: null,
    },
    background_history: [],
    next_element_index: 1,
    next_group_index: 0,
    composition_groups: {},
    current_cycle_index: null,
    current_elapsed_s: null,
    cycle_history: [],
    activity_history: [],
  };
}

export function beginCycle(state, { cycleIndex, elapsedTotalS }) {
  // Snapshot the exiting cycle's final active count before moving on. The
  // snapshot represents state at the END of the prior cycle (post-autoFade),
  // which matches what Opus will see at the START of the new cycle. Skip the
  // snapshot on the first beginCycle call (no prior cycle exists).
  if (!Array.isArray(state.cycle_history)) state.cycle_history = [];
  if (state.current_cycle_index !== null) {
    state.cycle_history.push({
      cycle_index: state.current_cycle_index,
      elapsed_s: state.current_elapsed_s,
      active_count: state.elements.filter((e) => !e.faded).length,
    });
    if (state.cycle_history.length > CYCLE_HISTORY_MAX) state.cycle_history.shift();
  }
  state.current_cycle_index = cycleIndex;
  state.current_elapsed_s = elapsedTotalS;
}

function ensureActivityHistory(state) {
  if (!Array.isArray(state.activity_history)) state.activity_history = [];
  return state.activity_history;
}

function recordActivity(state, kind, count = 1) {
  const history = ensureActivityHistory(state);
  history.push({
    cycle_index: state.current_cycle_index,
    elapsed_s: state.current_elapsed_s,
    kind,
    count,
  });
  while (history.length > ACTIVITY_HISTORY_MAX) history.shift();
}

function mintElementId(state) {
  const id = `elem_${String(state.next_element_index).padStart(4, "0")}`;
  state.next_element_index += 1;
  return id;
}

function mintGroupId(state) {
  if (typeof state.next_group_index !== "number") state.next_group_index = 0;
  const id = `group_${String(state.next_group_index).padStart(4, "0")}`;
  state.next_group_index += 1;
  return id;
}

// Mints a fresh composition_group_id and registers its label + creation
// timestamps on state.composition_groups. The returned id is what callers
// stamp onto each member element's content.composition_group_id.
export function addCompositionGroup(state, { group_label }) {
  const id = mintGroupId(state);
  if (!state.composition_groups || typeof state.composition_groups !== "object") {
    state.composition_groups = {};
  }
  state.composition_groups[id] = {
    group_id: id,
    group_label,
    created_at_cycle: state.current_cycle_index,
    created_at_elapsed_s: state.current_elapsed_s,
  };
  recordActivity(state, "composite", 1);
  return id;
}

export const GROUP_ID_PATTERN = /^group_\d{4}$/;

export function addElement(state, { type, content, lifetime_s }) {
  const resolvedLifetime =
    lifetime_s === null
      ? null
      : typeof lifetime_s === "number" && Number.isFinite(lifetime_s)
      ? lifetime_s
      : DEFAULT_LIFETIMES[type];
  const createdAt = state.current_elapsed_s;
  const id = mintElementId(state);
  state.elements.push({
    element_id: id,
    type,
    created_at_cycle: state.current_cycle_index,
    created_at_elapsed_s: createdAt,
    lifetime_s: resolvedLifetime,
    fades_at_elapsed_s: resolvedLifetime === null ? null : createdAt + resolvedLifetime,
    faded: false,
    content,
  });
  if (!content?.composition_group_id) recordActivity(state, "placed", 1);
  return id;
}

export function setBackground(state, { css_background }) {
  if (state.background.css_background !== null) {
    state.background_history.push({ ...state.background });
  }
  state.background = {
    css_background,
    set_at_cycle: state.current_cycle_index,
    set_at_elapsed_s: state.current_elapsed_s,
  };
  recordActivity(state, "background", 1);
}

export function fadeElement(state, elementId) {
  // Composition-group fade: if the id matches group_NNNN, fade every
  // non-faded member in one pass. An unknown group id returns
  // "no such element"; a group whose members are all already faded
  // returns "already faded" (mirrors the single-element semantics).
  if (GROUP_ID_PATTERN.test(elementId)) {
    const allMembers = state.elements.filter(
      (e) => e.content?.composition_group_id === elementId,
    );
    const hasGroupRecord =
      state.composition_groups && state.composition_groups[elementId];
    if (allMembers.length === 0 && !hasGroupRecord) {
      return { error: "no such element" };
    }
    const active = allMembers.filter((e) => !e.faded);
    if (active.length === 0) {
      return { error: "already faded" };
    }
    for (const el of active) el.faded = true;
    recordActivity(state, "fade", 1);
    return {
      ok: true,
      faded_count: active.length,
      faded_element_ids: active.map((e) => e.element_id),
    };
  }

  const el = state.elements.find((e) => e.element_id === elementId);
  if (!el) return { error: "no such element" };
  if (el.faded) return { error: "already faded" };
  el.faded = true;
  recordActivity(state, "fade", 1);
  return { ok: true };
}

export function autoFade(state) {
  const threshold = state.current_elapsed_s + AUTO_FADE_OVERLAP_S;
  for (const el of state.elements) {
    if (
      !el.faded &&
      el.lifetime_s !== null &&
      typeof el.fades_at_elapsed_s === "number" &&
      el.fades_at_elapsed_s < threshold
    ) {
      el.faded = true;
    }
  }
}

function ageOf(el, currentElapsedS) {
  return Math.round(currentElapsedS - el.created_at_elapsed_s);
}

function isFadingNextCycle(el, currentElapsedS) {
  if (el.lifetime_s === null || typeof el.fades_at_elapsed_s !== "number") return false;
  return el.fades_at_elapsed_s < currentElapsedS + AUTO_FADE_OVERLAP_S;
}

function truncateMarkup(markup) {
  if (markup.length <= SVG_MARKUP_MAX_SUMMARY_CHARS) return markup;
  return markup.slice(0, SVG_MARKUP_MAX_SUMMARY_CHARS) + "...";
}

function buildMetaClause(el, currentElapsedS, trailing) {
  const parts = [`${ageOf(el, currentElapsedS)}s old`];
  if (isFadingNextCycle(el, currentElapsedS)) parts.push("fading next cycle");
  parts.push(`position "${el.content.position}"`);
  if (trailing) parts.push(trailing);
  return `(${parts.join(", ")})`;
}

function formatTextLine(el, currentElapsedS) {
  const meta = buildMetaClause(el, currentElapsedS, null);
  return `- ${el.element_id} ${meta}: "${el.content.content}"`;
}

function formatImageLine(el, currentElapsedS) {
  const meta = buildMetaClause(el, currentElapsedS, null);
  return `- ${el.element_id} ${meta}: query="${el.content.query}"`;
}

function formatSvgLine(el, currentElapsedS) {
  const meta = buildMetaClause(el, currentElapsedS, `"${el.content.semantic_label}"`);
  return `- ${el.element_id} ${meta}: ${truncateMarkup(el.content.svg_markup)}`;
}

// Per-element line inside a COMPOSITION GROUP block. Same metadata shape as
// the top-level TEXT/IMAGES/SVG sections (age + fade warning + position),
// but rendered with an indented bullet so it reads as a child of the group.
function formatCompositeMemberLines(el, currentElapsedS) {
  const posParts = [`${ageOf(el, currentElapsedS)}s old`];
  if (isFadingNextCycle(el, currentElapsedS)) posParts.push("fading next cycle");
  posParts.push(`position "${el.content.position}"`);
  const meta = `(${posParts.join(", ")})`;
  if (el.type === "text") {
    return [`  - ${el.element_id} TEXT ${meta}: "${el.content.content}"`];
  }
  if (el.type === "image") {
    return [`  - ${el.element_id} IMAGE ${meta}: query="${el.content.query}"`];
  }
  if (el.type === "svg") {
    return [
      `  - ${el.element_id} SVG ${meta}: "${el.content.semantic_label}"`,
      `    markup: ${truncateMarkup(el.content.svg_markup)}`,
    ];
  }
  return [`  - ${el.element_id} ${el.type} ${meta}`];
}

function formatCompositionGroupBlock(groupId, meta, members, currentElapsedS) {
  const label = meta?.group_label ?? "(unlabeled)";
  const anchor =
    typeof meta?.created_at_elapsed_s === "number"
      ? meta.created_at_elapsed_s
      : members[0]?.created_at_elapsed_s ?? currentElapsedS;
  const age = Math.round(currentElapsedS - anchor);
  const count = members.length;
  const header = `COMPOSITION GROUP [${groupId}] "${label}" (${age}s old, ${count} ${count === 1 ? "element" : "elements"}):`;
  const ordered = [...members].sort((a, b) =>
    a.element_id.localeCompare(b.element_id),
  );
  const lines = [header];
  for (const el of ordered) {
    for (const ln of formatCompositeMemberLines(el, currentElapsedS)) lines.push(ln);
  }
  return lines.join("\n");
}

function pluralize(n, word) {
  return n === 1 ? `1 ${word}` : `${n} ${word}s`;
}

// Map a free-form Opus position string to one of the nine SPATIAL_REGIONS.
// Strings lacking any row or column keyword fall through to middle-center,
// which matches the broad "background" / "horizontal-band" behaviour of
// render_html.classifyPosition without forcing a fixed vocabulary on Opus.
function classifyPositionToRegion(position) {
  const p = (position ?? "").toString().toLowerCase();
  const row = /upper|top/.test(p)
    ? "upper"
    : /lower|bottom/.test(p)
      ? "lower"
      : "middle";
  const col = /left/.test(p) ? "left" : /right/.test(p) ? "right" : "center";
  return `${row}-${col}`;
}

function emptySpatialGrid() {
  const grid = {};
  for (const r of SPATIAL_REGIONS) grid[r] = 0;
  return grid;
}

export function computeOverview(state) {
  const elements = Array.isArray(state.elements) ? state.elements : [];
  const active = elements.filter((e) => !e.faded);
  const fadedTotal = elements.length - active.length;

  const elementsByType = {
    text: active.filter((e) => e.type === "text").length,
    svg: active.filter((e) => e.type === "svg").length,
    image: active.filter((e) => e.type === "image").length,
  };

  const spatial = emptySpatialGrid();
  for (const el of active) {
    const region = classifyPositionToRegion(el.content?.position);
    if (region in spatial) spatial[region] += 1;
  }

  // Crowded region: the most-populated region that clears both thresholds.
  let crowdedRegion = null;
  if (active.length > 0) {
    let best = null;
    for (const region of SPATIAL_REGIONS) {
      const count = spatial[region];
      if (count >= CROWDED_MIN_COUNT && count / active.length >= CROWDED_MIN_SHARE) {
        if (best === null || count > best.count) best = { name: region, count };
      }
    }
    crowdedRegion = best;
  }

  // Trajectory: pull up to 3 snapshots from cycle_history that correspond
  // to cycles immediately preceding the current one, then append the current
  // active count. Using cycle_index adjacency means gaps in cycle numbering
  // do not produce misleading trajectory lines.
  const history = Array.isArray(state.cycle_history) ? state.cycle_history : [];
  const currentCycle = state.current_cycle_index;
  const counts = [];
  const cycleIndices = [];
  if (typeof currentCycle === "number") {
    for (let offset = 3; offset >= 1; offset -= 1) {
      const target = currentCycle - offset;
      const hit = history.find((h) => h.cycle_index === target);
      if (hit) {
        counts.push(hit.active_count);
        cycleIndices.push(target);
      }
    }
    counts.push(active.length);
    cycleIndices.push(currentCycle);
  }
  let classification = null;
  if (counts.length >= 4) {
    const delta = counts[counts.length - 1] - counts[0];
    classification = delta >= TRAJECTORY_DELTA_THRESHOLD
      ? "Growing"
      : delta <= -TRAJECTORY_DELTA_THRESHOLD
        ? "Thinning"
        : "Stable";
  }

  // Recent activity: count actual scene-mutating tool events recorded by the
  // state mutators. Packet summaries are built after beginCycle but before the
  // current cycle's tools run, so when no current-cycle events exist we report
  // the previous three applied cycles. Live monitor renders after current-cycle
  // tools have run, so current-cycle events are included there.
  const activityHistory = Array.isArray(state.activity_history) ? state.activity_history : [];
  const hasCurrentActivity =
    typeof currentCycle === "number" &&
    activityHistory.some((e) => e.cycle_index === currentCycle);
  const recentEndCycle =
    typeof currentCycle === "number"
      ? currentCycle - (hasCurrentActivity ? 0 : 1)
      : null;
  const recentStartCycle =
    recentEndCycle === null ? null : recentEndCycle - 2;
  const recent = { placed: 0, composites: 0, fades: 0, backgrounds: 0 };
  if (recentStartCycle !== null) {
    for (const event of activityHistory) {
      if (
        typeof event.cycle_index !== "number" ||
        event.cycle_index < recentStartCycle ||
        event.cycle_index > recentEndCycle
      ) {
        continue;
      }
      const count = typeof event.count === "number" ? event.count : 1;
      if (event.kind === "placed") recent.placed += count;
      else if (event.kind === "composite") recent.composites += count;
      else if (event.kind === "fade") recent.fades += count;
      else if (event.kind === "background") recent.backgrounds += count;
    }
  }
  const toolCalls = recent.placed + recent.composites + recent.fades + recent.backgrounds;
  const occupancyStatus =
    active.length < SCENE_OCCUPANCY_FLOOR
      ? "below"
      : active.length === SCENE_OCCUPANCY_FLOOR
        ? "at"
        : "above";

  // Background age signal: the prompt names a 12-cycle floor for
  // setBackground. Without an explicit signal, Opus tended to call it only
  // once and drift. Surface the cycles-since-last-change in the overview
  // so the floor is visible on every packet.
  const bgSetAtCycle =
    state.background && typeof state.background.set_at_cycle === "number"
      ? state.background.set_at_cycle
      : null;
  const bgCyclesSince =
    bgSetAtCycle !== null && typeof currentCycle === "number"
      ? currentCycle - bgSetAtCycle
      : null;
  const bgStatus =
    bgSetAtCycle === null
      ? "never"
      : bgCyclesSince >= SCENE_BACKGROUND_FLOOR_CYCLES
        ? "due"
        : "fresh";

  return {
    elements: {
      total: active.length,
      text: elementsByType.text,
      svg: elementsByType.svg,
      image: elementsByType.image,
      faded_total: fadedTotal,
    },
    spatial,
    crowded_region: crowdedRegion,
    trajectory: { counts, cycle_indices: cycleIndices, classification },
    recent: {
      tool_calls: toolCalls,
      placed: recent.placed,
      composites: recent.composites,
      fades: recent.fades,
      backgrounds: recent.backgrounds,
      background_changes: recent.backgrounds,
      window_start_cycle: recentStartCycle,
      window_end_cycle: recentEndCycle,
    },
    occupancy: {
      active: active.length,
      floor: SCENE_OCCUPANCY_FLOOR,
      status: occupancyStatus,
    },
    background_age: {
      cycles_since: bgCyclesSince,
      floor: SCENE_BACKGROUND_FLOOR_CYCLES,
      status: bgStatus,
    },
  };
}

export function formatOverviewBlock(overview) {
  const lines = ["SCENE OVERVIEW:"];
  const { elements, spatial, crowded_region, trajectory, recent } = overview;
  lines.push(
    `Elements active: ${elements.total} total ` +
    `(${elements.text} text, ${elements.svg} SVG, ${elements.image} images) — ` +
    `faded this session: ${elements.faded_total}`,
  );
  lines.push(
    "Spatial: " +
    SPATIAL_REGIONS.map((r) => `${r}: ${spatial[r]}`).join(" | "),
  );
  if (crowded_region) {
    lines.push(
      `Crowded region: ${crowded_region.name} ` +
      `(${crowded_region.count} elements of ${elements.total} total).`,
    );
  }
  lines.push(formatTrajectoryLine(trajectory));
  lines.push(
    `Recent: ${pluralize(recent.tool_calls, "tool call")} in last 3 applied cycles. ` +
    `Placed: ${pluralize(recent.placed, "element")}, ` +
    `${pluralize(recent.composites, "composite")}, ` +
    `${pluralize(recent.fades, "fade")}, ` +
    `${pluralize(recent.backgrounds ?? recent.background_changes ?? 0, "background")}.`,
  );
  const { occupancy } = overview;
  if (occupancy.status === "below") {
    lines.push(
      `Occupancy: ${occupancy.active} active, floor ${occupancy.floor}. ` +
      `Below floor — favor adding over fading.`,
    );
  } else if (occupancy.status === "at") {
    lines.push(`Occupancy: ${occupancy.active} active, at floor ${occupancy.floor}.`);
  } else {
    lines.push(`Occupancy: ${occupancy.active} active, above floor ${occupancy.floor}.`);
  }
  const { background_age } = overview;
  if (background_age) {
    if (background_age.status === "never") {
      lines.push(
        `Background: never set. ` +
        `Commit early — the scene has no atmospheric container yet.`,
      );
    } else if (background_age.status === "due") {
      lines.push(
        `Background: ${background_age.cycles_since} cycles since last shift, ` +
        `floor ${background_age.floor}. Due for a new atmosphere if the music ` +
        `has moved into new territory.`,
      );
    } else {
      lines.push(
        `Background: ${background_age.cycles_since} cycles since last shift, ` +
        `floor ${background_age.floor}. Fresh — no pressure to change.`,
      );
    }
  }
  return lines.join("\n");
}

function formatTrajectoryLine(trajectory) {
  const { counts, classification } = trajectory;
  if (!counts || counts.length === 0) {
    return "Density trajectory: (no prior cycles).";
  }
  const arrow = counts.join(" → ");
  // Offset labels match the spec exactly: "current", "1 ago", then "N cycles
  // ago" for the oldest slot when it is at least two cycles back, and just
  // "N ago" for intermediate slots.
  const offsets = [];
  const span = counts.length;
  for (let i = 0; i < span; i += 1) {
    const back = span - 1 - i;
    if (back === 0) offsets.push("current");
    else if (back === 1) offsets.push("1 ago");
    else if (i === 0) offsets.push(`${back} cycles ago`);
    else offsets.push(`${back} ago`);
  }
  const label = offsets.join(" → ");
  const base = `Density trajectory: ${arrow} (${label}).`;
  return classification ? `${base} ${classification}.` : base;
}

function formatBackgroundLine(state, elapsed) {
  if (state.background.css_background === null) {
    return "BACKGROUND: (not set)";
  }
  const age = Math.round(elapsed - state.background.set_at_elapsed_s);
  return `BACKGROUND: ${state.background.css_background} (set ${age}s ago)`;
}

export function formatSummary(state) {
  const elapsed = state.current_elapsed_s;
  const active = state.elements.filter((e) => !e.faded);

  // Partition active elements by whether they belong to a composition group.
  // Grouped members render only inside the COMPOSITION GROUP block below;
  // ungrouped elements flow through the existing TEXT / IMAGES / SVG
  // sections unchanged.
  const grouped = active.filter((e) => e.content?.composition_group_id);
  const ungrouped = active.filter((e) => !e.content?.composition_group_id);
  const textEls = ungrouped.filter((e) => e.type === "text");
  const imgEls = ungrouped.filter((e) => e.type === "image");
  const svgEls = ungrouped.filter((e) => e.type === "svg");

  const header = `Current scene (${pluralize(active.length, "element")} visible, ${elapsed}s since performance start):`;

  const lines = [header, ""];

  // SCENE OVERVIEW block (Session D): spatial + density + recent-activity
  // signals that let Opus reason compositionally before it sees the per-
  // element listings below.
  const overview = computeOverview(state);
  lines.push(formatOverviewBlock(overview));
  lines.push("");

  // BACKGROUND appears before composition groups and per-type sections. This
  // keeps composite groups literally between BACKGROUND and the first TEXT
  // listing, as specified for Session C.
  lines.push(formatBackgroundLine(state, elapsed));
  lines.push("");

  // COMPOSITION GROUPS (Session C): render groups as first-class structural
  // units after BACKGROUND and before per-type listings so Opus sees its own
  // composed moments as a coherent unit and can reference them by group_id.
  if (grouped.length > 0) {
    const byGroup = new Map();
    for (const el of grouped) {
      const gid = el.content.composition_group_id;
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid).push(el);
    }
    const sortedGroupIds = Array.from(byGroup.keys()).sort();
    for (const gid of sortedGroupIds) {
      const meta = state.composition_groups?.[gid];
      const members = byGroup.get(gid);
      lines.push(formatCompositionGroupBlock(gid, meta, members, elapsed));
      lines.push("");
    }
  }

  if (active.length === 0) {
    lines.push("(empty — nothing has been placed yet)");
  } else {
    if (textEls.length > 0) {
      lines.push(`TEXT [${textEls.length} active]:`);
      for (const el of textEls) lines.push(formatTextLine(el, elapsed));
      lines.push("");
    }
    if (imgEls.length > 0) {
      lines.push(`IMAGES [${imgEls.length} active]:`);
      for (const el of imgEls) lines.push(formatImageLine(el, elapsed));
      lines.push("");
    }
    if (svgEls.length > 0) {
      lines.push(`SVG [${svgEls.length} active]:`);
      for (const el of svgEls) lines.push(formatSvgLine(el, elapsed));
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function saveState(state, runDir) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "scene_state.json"), JSON.stringify(state, null, 2));
}

export function snapshotCycle(state, runDir) {
  const logDir = join(runDir, "scene_state_log");
  mkdirSync(logDir, { recursive: true });
  const filename = `cycle_${String(state.current_cycle_index).padStart(3, "0")}.json`;
  writeFileSync(join(logDir, filename), JSON.stringify(state, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import("node:assert/strict")).default;
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  let pass = 0;
  let fail = 0;
  function t(desc, fn) {
    try {
      fn();
      pass++;
      process.stdout.write(`  ok  ${desc}\n`);
    } catch (err) {
      fail++;
      process.stdout.write(`  FAIL ${desc}\n    ${err.message}\n`);
    }
  }

  t("createInitialState returns expected shape", () => {
    const s = createInitialState();
    assert.deepEqual(s.elements, []);
    assert.deepEqual(s.background, {
      css_background: null,
      set_at_cycle: null,
      set_at_elapsed_s: null,
    });
    assert.deepEqual(s.background_history, []);
    assert.equal(s.next_element_index, 1);
    assert.equal(s.current_cycle_index, null);
    assert.equal(s.current_elapsed_s, null);
    assert.deepEqual(s.activity_history, []);
  });

  t("beginCycle updates current cycle/elapsed tracking", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 3, elapsedTotalS: 20 });
    assert.equal(s.current_cycle_index, 3);
    assert.equal(s.current_elapsed_s, 20);
  });

  t("addElement mints monotonic elem_NNNN IDs zero-padded to 4 digits", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const id1 = addElement(s, {
      type: "text",
      content: { content: "after", position: "lower-left", style: "serif, large" },
    });
    const id2 = addElement(s, {
      type: "svg",
      content: { svg_markup: "<svg/>", position: "center", semantic_label: "x" },
    });
    assert.equal(id1, "elem_0001");
    assert.equal(id2, "elem_0002");
    assert.equal(s.next_element_index, 3);
    assert.equal(s.elements.length, 2);
  });

  t("addElement uses Session F default lifetime per type (text/image permanent, svg=35)", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 10 });
    const tid = addElement(s, {
      type: "text",
      content: { content: "x", position: "c", style: "s" },
    });
    const vid = addElement(s, {
      type: "svg",
      content: { svg_markup: "<svg/>", position: "c", semantic_label: "l" },
    });
    const iid = addElement(s, {
      type: "image",
      content: { query: "q", position: "background" },
    });
    const te = s.elements.find((e) => e.element_id === tid);
    const ve = s.elements.find((e) => e.element_id === vid);
    const ie = s.elements.find((e) => e.element_id === iid);
    assert.equal(te.lifetime_s, null);
    assert.equal(te.fades_at_elapsed_s, null);
    assert.equal(ve.lifetime_s, 35);
    assert.equal(ve.fades_at_elapsed_s, 45);
    assert.equal(ie.lifetime_s, null);
    assert.equal(ie.fades_at_elapsed_s, null);
  });

  t("addElement honors explicit lifetime_s override", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 10 });
    const id = addElement(s, {
      type: "svg",
      content: { svg_markup: "<svg/>", position: "c", semantic_label: "l" },
      lifetime_s: 40,
    });
    const el = s.elements.find((e) => e.element_id === id);
    assert.equal(el.lifetime_s, 40);
    assert.equal(el.fades_at_elapsed_s, 50);
  });

  t("addElement preserves content verbatim including svg_markup and semantic_label", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const markup = '<svg viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10"/></svg>';
    const id = addElement(s, {
      type: "svg",
      content: { svg_markup: markup, position: "center", semantic_label: "diagonal" },
    });
    const el = s.elements.find((e) => e.element_id === id);
    assert.equal(el.type, "svg");
    assert.equal(el.content.svg_markup, markup);
    assert.equal(el.content.semantic_label, "diagonal");
    assert.equal(el.content.position, "center");
    assert.equal(el.created_at_cycle, 0);
    assert.equal(el.created_at_elapsed_s, 5);
    assert.equal(el.faded, false);
  });

  t("setBackground sets first background with no history entry", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 1, elapsedTotalS: 10 });
    setBackground(s, { css_background: "linear-gradient(180deg, #111, #222)" });
    assert.equal(s.background.css_background, "linear-gradient(180deg, #111, #222)");
    assert.equal(s.background.set_at_cycle, 1);
    assert.equal(s.background.set_at_elapsed_s, 10);
    assert.equal(s.background_history.length, 0);
  });

  t("setBackground pushes prior background to background_history on replacement", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 1, elapsedTotalS: 10 });
    setBackground(s, { css_background: "linear-gradient(180deg, #111, #222)" });
    beginCycle(s, { cycleIndex: 5, elapsedTotalS: 30 });
    setBackground(s, { css_background: "radial-gradient(circle, #333, #444)" });
    assert.equal(s.background.css_background, "radial-gradient(circle, #333, #444)");
    assert.equal(s.background_history.length, 1);
    assert.equal(s.background_history[0].css_background, "linear-gradient(180deg, #111, #222)");
    assert.equal(s.background_history[0].set_at_cycle, 1);
    assert.equal(s.background_history[0].set_at_elapsed_s, 10);
  });

  t("fadeElement on existing element marks faded and returns {ok:true}", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const id = addElement(s, {
      type: "text",
      content: { content: "x", position: "c", style: "s" },
    });
    const r = fadeElement(s, id);
    assert.deepEqual(r, { ok: true });
    assert.equal(s.elements.find((e) => e.element_id === id).faded, true);
  });

  t("fadeElement on unknown ID returns {error:'no such element'}", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const r = fadeElement(s, "elem_9999");
    assert.deepEqual(r, { error: "no such element" });
  });

  t("fadeElement on already-faded returns {error:'already faded'}", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const id = addElement(s, {
      type: "text",
      content: { content: "x", position: "c", style: "s" },
    });
    fadeElement(s, id);
    const r = fadeElement(s, id);
    assert.deepEqual(r, { error: "already faded" });
  });

  t("autoFade marks elements where fades_at < current_elapsed + 5 as faded", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 10 });
    const shortId = addElement(s, {
      type: "text",
      content: { content: "short", position: "c", style: "s" },
      lifetime_s: 10,
    });
    const longId = addElement(s, {
      type: "text",
      content: { content: "long", position: "c", style: "s" },
      lifetime_s: 40,
    });
    beginCycle(s, { cycleIndex: 3, elapsedTotalS: 25 });
    autoFade(s);
    const shortEl = s.elements.find((e) => e.element_id === shortId);
    const longEl = s.elements.find((e) => e.element_id === longId);
    assert.equal(shortEl.faded, true);
    assert.equal(longEl.faded, false);
  });

  t("autoFade does not re-fade already-faded elements (idempotent)", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 10 });
    const id = addElement(s, {
      type: "text",
      content: { content: "x", position: "c", style: "s" },
      lifetime_s: 5,
    });
    beginCycle(s, { cycleIndex: 1, elapsedTotalS: 15 });
    autoFade(s);
    autoFade(s);
    const el = s.elements.find((e) => e.element_id === id);
    assert.equal(el.faded, true);
  });

  t("autoFade never removes permanent elements", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 10 });
    const textId = addElement(s, {
      type: "text",
      content: { content: "permanent", position: "c", style: "s" },
    });
    const imageId = addElement(s, {
      type: "image",
      content: { query: "permanent image", position: "background" },
    });
    beginCycle(s, { cycleIndex: 30, elapsedTotalS: 155 });
    autoFade(s);
    assert.equal(s.elements.find((e) => e.element_id === textId).faded, false);
    assert.equal(s.elements.find((e) => e.element_id === imageId).faded, false);
  });

  t("fadeElement still removes a permanent element explicitly", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 10 });
    const id = addElement(s, {
      type: "text",
      content: { content: "manual exit", position: "c", style: "s" },
    });
    const result = fadeElement(s, id);
    assert.deepEqual(result, { ok: true });
    assert.equal(s.elements.find((e) => e.element_id === id).faded, true);
  });

  t("permanent text placed at cycle 0 remains active at cycle 30", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const id = addElement(s, {
      type: "text",
      content: { content: "witness", position: "lower-left", style: "serif" },
    });
    beginCycle(s, { cycleIndex: 30, elapsedTotalS: 155 });
    autoFade(s);
    const el = s.elements.find((e) => e.element_id === id);
    assert.equal(el.faded, false);
    assert.equal(el.lifetime_s, null);
  });

  t("formatSummary for empty state uses current elapsed_total_s (not 0)", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 16, elapsedTotalS: 80 });
    const summary = formatSummary(s);
    assert.match(summary, /0 elements visible, 80s since performance start/);
    assert.match(summary, /BACKGROUND: \(not set\)/);
  });

  t("formatSummary excludes faded elements from sections and count", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    addElement(s, {
      type: "text",
      content: { content: "visible-one", position: "c", style: "s" },
    });
    const hidden = addElement(s, {
      type: "text",
      content: { content: "HIDDEN-ONE", position: "c", style: "s" },
    });
    fadeElement(s, hidden);
    const summary = formatSummary(s);
    assert.match(summary, /visible-one/);
    assert.doesNotMatch(summary, /HIDDEN-ONE/);
    assert.match(summary, /1 element/);
  });

  t("formatSummary SVG entries include semantic_label AND truncated svg_markup", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const longMarkup =
      '<svg viewBox="0 0 100 100">' +
      '<line x1="0" y1="0" x2="100" y2="100" stroke="white" stroke-width="2"/>' +
      '<line x1="0" y1="100" x2="100" y2="0" stroke="white" stroke-width="2"/>' +
      "</svg>";
    addElement(s, {
      type: "svg",
      content: {
        svg_markup: longMarkup,
        position: "center",
        semantic_label: "crossed lines center",
      },
    });
    const summary = formatSummary(s);
    assert.match(summary, /"crossed lines center"/);
    assert.match(summary, /<svg viewBox="0 0 100 100">/);
    assert.match(summary, /\.\.\./);
    const svgLine = summary.split("\n").find((ln) => ln.includes("crossed lines center"));
    assert.ok(svgLine.length < longMarkup.length + 80);
  });

  t("formatSummary annotates elements close to auto-fade as 'fading next cycle'", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    addElement(s, {
      type: "text",
      content: { content: "about-to-go", position: "c", style: "s" },
      lifetime_s: 5,
    });
    beginCycle(s, { cycleIndex: 2, elapsedTotalS: 8 });
    const summary = formatSummary(s);
    assert.match(summary, /fading next cycle/);
  });

  t("formatSummary shows background with '(set Ns ago)' wording", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 1, elapsedTotalS: 10 });
    setBackground(s, { css_background: "linear-gradient(180deg, #1a1410, #0d0908)" });
    beginCycle(s, { cycleIndex: 11, elapsedTotalS: 57 });
    const summary = formatSummary(s);
    assert.match(summary, /linear-gradient\(180deg, #1a1410, #0d0908\)/);
    assert.match(summary, /\(set 47s ago\)/);
  });

  t("saveState and snapshotCycle write JSON files to runDir", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "flb-scene-state-"));
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 3, elapsedTotalS: 20 });
    addElement(s, {
      type: "text",
      content: { content: "snap-test", position: "c", style: "s" },
    });
    saveState(s, tmp);
    snapshotCycle(s, tmp);
    const current = JSON.parse(readFileSync(path.join(tmp, "scene_state.json"), "utf8"));
    const snap = JSON.parse(readFileSync(path.join(tmp, "scene_state_log", "cycle_003.json"), "utf8"));
    assert.equal(current.elements.length, 1);
    assert.equal(snap.elements.length, 1);
    assert.equal(current.elements[0].content.content, "snap-test");
  });

  t("end-to-end multi-cycle scenario", () => {
    const s = createInitialState();

    beginCycle(s, { cycleIndex: 2, elapsedTotalS: 15 });
    const textId = addElement(s, {
      type: "text",
      content: { content: "after", position: "lower-left", style: "serif, large" },
    });
    autoFade(s);

    beginCycle(s, { cycleIndex: 3, elapsedTotalS: 20 });
    addElement(s, {
      type: "svg",
      content: {
        svg_markup: "<svg><line x1='0' y1='0' x2='50' y2='50'/></svg>",
        position: "left edge",
        semantic_label: "diagonal line",
      },
    });
    setBackground(s, { css_background: "linear-gradient(180deg, #1a1410, #0d0908)" });
    autoFade(s);

    beginCycle(s, { cycleIndex: 4, elapsedTotalS: 25 });
    const ephemeralId = addElement(s, {
      type: "text",
      content: { content: "will-fade-fast", position: "c", style: "s" },
      lifetime_s: 5,
    });
    autoFade(s);

    beginCycle(s, { cycleIndex: 5, elapsedTotalS: 30 });
    addElement(s, {
      type: "image",
      content: { query: "threshold light through a doorway", position: "background" },
    });
    setBackground(s, { css_background: "radial-gradient(circle, #333, #444)" });
    autoFade(s);

    assert.equal(s.background_history.length, 1);
    assert.equal(
      s.background_history[0].css_background,
      "linear-gradient(180deg, #1a1410, #0d0908)",
    );
    assert.equal(s.elements.find((e) => e.element_id === ephemeralId).faded, true);
    assert.equal(s.elements.find((e) => e.element_id === textId).faded, false);

    const summary = formatSummary(s);
    assert.doesNotMatch(summary, /will-fade-fast/);
    assert.match(summary, /after/);
    assert.match(summary, /diagonal line/);
    assert.match(summary, /threshold light through a doorway/);
    assert.match(summary, /radial-gradient\(circle, #333, #444\)/);
  });

  // ==========================================================================
  // SCENE OVERVIEW tests (Session D)
  // ==========================================================================

  t("computeOverview on empty state returns zero counts and no crowding", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    const o = computeOverview(s);
    assert.equal(o.elements.total, 0);
    assert.equal(o.elements.text, 0);
    assert.equal(o.elements.svg, 0);
    assert.equal(o.elements.image, 0);
    assert.equal(o.elements.faded_total, 0);
    const spatialSum = Object.values(o.spatial).reduce((a, b) => a + b, 0);
    assert.equal(spatialSum, 0);
    assert.equal(o.crowded_region, null);
    assert.equal(o.trajectory.classification, null);
    assert.equal(o.recent.tool_calls, 0);
    assert.equal(o.recent.placed, 0);
    assert.equal(o.recent.composites, 0);
    assert.equal(o.recent.fades, 0);
    assert.equal(o.occupancy.active, 0);
    assert.equal(o.occupancy.floor, SCENE_OCCUPANCY_FLOOR);
    assert.equal(o.occupancy.status, "below");
  });

  t("computeOverview spatial classification: counts sum to total active", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    addElement(s, { type: "text", content: { content: "a", position: "upper-left", style: "s" } });
    addElement(s, { type: "text", content: { content: "b", position: "upper center", style: "s" } });
    addElement(s, { type: "svg", content: { svg_markup: "<svg/>", position: "middle right", semantic_label: "x" } });
    addElement(s, { type: "image", content: { query: "q", position: "lower-left" } });
    addElement(s, { type: "svg", content: { svg_markup: "<svg/>", position: "background", semantic_label: "y" } });
    const o = computeOverview(s);
    assert.equal(o.elements.total, 5);
    const spatialSum = Object.values(o.spatial).reduce((a, b) => a + b, 0);
    assert.equal(spatialSum, 5);
    assert.equal(o.spatial["upper-left"], 1);
    assert.equal(o.spatial["upper-center"], 1);
    assert.equal(o.spatial["middle-right"], 1);
    assert.equal(o.spatial["lower-left"], 1);
    assert.equal(o.spatial["middle-center"], 1); // background → middle-center fallback
  });

  t("computeOverview spatial counts classify 'top'/'bottom' as upper/lower and 'centre' as center", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    addElement(s, { type: "text", content: { content: "a", position: "top right", style: "s" } });
    addElement(s, { type: "text", content: { content: "b", position: "bottom centre", style: "s" } });
    addElement(s, { type: "text", content: { content: "c", position: "middle", style: "s" } });
    const o = computeOverview(s);
    assert.equal(o.spatial["upper-right"], 1);
    assert.equal(o.spatial["lower-center"], 1);
    assert.equal(o.spatial["middle-center"], 1);
  });

  t("computeOverview excludes faded elements from spatial counts", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const idHide = addElement(s, { type: "text", content: { content: "x", position: "upper-left", style: "s" } });
    addElement(s, { type: "text", content: { content: "y", position: "upper-right", style: "s" } });
    fadeElement(s, idHide);
    const o = computeOverview(s);
    assert.equal(o.elements.total, 1);
    assert.equal(o.elements.faded_total, 1);
    assert.equal(o.spatial["upper-left"], 0);
    assert.equal(o.spatial["upper-right"], 1);
  });

  t("computeOverview crowded region: 4 of 10 in upper-right triggers note (>=3 AND >=40%)", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    for (let i = 0; i < 4; i++) {
      addElement(s, { type: "text", content: { content: `u${i}`, position: "upper right", style: "s" } });
    }
    for (let i = 0; i < 6; i++) {
      addElement(s, { type: "svg", content: { svg_markup: "<svg/>", position: i < 3 ? "lower-left" : "middle-center", semantic_label: "x" } });
    }
    const o = computeOverview(s);
    assert.equal(o.elements.total, 10);
    assert.ok(o.crowded_region, "expected crowded_region to be populated");
    assert.equal(o.crowded_region.name, "upper-right");
    assert.equal(o.crowded_region.count, 4);
  });

  t("computeOverview no crowded region: 3 of 10 (30%) fails the percentage threshold", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    // upper-right: 3 (30%) — clears count but fails share threshold. Others
    // spread thin so no competing region triggers either.
    for (let i = 0; i < 3; i++) {
      addElement(s, { type: "text", content: { content: `u${i}`, position: "upper right", style: "s" } });
    }
    addElement(s, { type: "svg", content: { svg_markup: "<svg/>", position: "lower-left", semantic_label: "a" } });
    addElement(s, { type: "svg", content: { svg_markup: "<svg/>", position: "lower-left", semantic_label: "b" } });
    addElement(s, { type: "svg", content: { svg_markup: "<svg/>", position: "middle-center", semantic_label: "c" } });
    addElement(s, { type: "svg", content: { svg_markup: "<svg/>", position: "middle-center", semantic_label: "d" } });
    addElement(s, { type: "text", content: { content: "e", position: "upper-center", style: "s" } });
    addElement(s, { type: "text", content: { content: "f", position: "middle-right", style: "s" } });
    addElement(s, { type: "text", content: { content: "g", position: "lower-right", style: "s" } });
    const o = computeOverview(s);
    assert.equal(o.elements.total, 10);
    assert.equal(o.spatial["upper-right"], 3);
    assert.equal(o.crowded_region, null);
  });

  t("computeOverview no crowded region: 2 elements fails count threshold even at 100%", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    addElement(s, { type: "text", content: { content: "a", position: "upper-right", style: "s" } });
    addElement(s, { type: "text", content: { content: "b", position: "upper-right", style: "s" } });
    const o = computeOverview(s);
    assert.equal(o.crowded_region, null);
  });

  t("computeOverview trajectory: 4-cycle window with growing classification", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    addElement(s, { type: "text", content: { content: "a", position: "c", style: "s" }, lifetime_s: 9999 });
    addElement(s, { type: "text", content: { content: "b", position: "c", style: "s" }, lifetime_s: 9999 });
    beginCycle(s, { cycleIndex: 1, elapsedTotalS: 5 });
    for (let i = 0; i < 3; i++) addElement(s, { type: "text", content: { content: `x${i}`, position: "c", style: "s" }, lifetime_s: 9999 });
    beginCycle(s, { cycleIndex: 2, elapsedTotalS: 10 });
    for (let i = 0; i < 2; i++) addElement(s, { type: "text", content: { content: `y${i}`, position: "c", style: "s" }, lifetime_s: 9999 });
    beginCycle(s, { cycleIndex: 3, elapsedTotalS: 15 });
    const o = computeOverview(s);
    assert.deepEqual(o.trajectory.counts, [2, 5, 7, 7]);
    assert.deepEqual(o.trajectory.cycle_indices, [0, 1, 2, 3]);
    assert.equal(o.trajectory.classification, "Growing");
  });

  t("computeOverview trajectory: thinning classification when shedding 3+", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push(addElement(s, { type: "text", content: { content: `a${i}`, position: "c", style: "s" }, lifetime_s: 9999 }));
    beginCycle(s, { cycleIndex: 1, elapsedTotalS: 5 });
    fadeElement(s, ids[0]);
    fadeElement(s, ids[1]);
    beginCycle(s, { cycleIndex: 2, elapsedTotalS: 10 });
    fadeElement(s, ids[2]);
    fadeElement(s, ids[3]);
    beginCycle(s, { cycleIndex: 3, elapsedTotalS: 15 });
    fadeElement(s, ids[4]);
    const o = computeOverview(s);
    assert.deepEqual(o.trajectory.counts, [8, 6, 4, 3]);
    assert.equal(o.trajectory.classification, "Thinning");
  });

  t("computeOverview trajectory: stable classification when within +/-2", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    addElement(s, { type: "text", content: { content: "a", position: "c", style: "s" }, lifetime_s: 9999 });
    addElement(s, { type: "text", content: { content: "b", position: "c", style: "s" }, lifetime_s: 9999 });
    addElement(s, { type: "text", content: { content: "c", position: "c", style: "s" }, lifetime_s: 9999 });
    beginCycle(s, { cycleIndex: 1, elapsedTotalS: 5 });
    addElement(s, { type: "text", content: { content: "d", position: "c", style: "s" }, lifetime_s: 9999 });
    beginCycle(s, { cycleIndex: 2, elapsedTotalS: 10 });
    beginCycle(s, { cycleIndex: 3, elapsedTotalS: 15 });
    const o = computeOverview(s);
    assert.deepEqual(o.trajectory.counts, [3, 4, 4, 4]);
    assert.equal(o.trajectory.classification, "Stable");
  });

  t("computeOverview trajectory: early cycles (0-2) returns partial data and null classification", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    addElement(s, { type: "text", content: { content: "a", position: "c", style: "s" }, lifetime_s: 9999 });
    beginCycle(s, { cycleIndex: 1, elapsedTotalS: 5 });
    addElement(s, { type: "text", content: { content: "b", position: "c", style: "s" }, lifetime_s: 9999 });
    addElement(s, { type: "text", content: { content: "c", position: "c", style: "s" }, lifetime_s: 9999 });
    const o = computeOverview(s);
    // Only cycle 0 snapshot + current cycle 1 → 2 data points
    assert.deepEqual(o.trajectory.counts, [1, 3]);
    assert.deepEqual(o.trajectory.cycle_indices, [0, 1]);
    assert.equal(o.trajectory.classification, null);
  });

  t("computeOverview recent activity: packet-time window uses previous 3 applied cycles", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    setBackground(s, { css_background: "linear-gradient(#111, #222)" });
    beginCycle(s, { cycleIndex: 1, elapsedTotalS: 5 });
    addElement(s, { type: "text", content: { content: "one", position: "c", style: "s" }, lifetime_s: 9999 });
    beginCycle(s, { cycleIndex: 2, elapsedTotalS: 10 });
    addElement(s, { type: "svg", content: { svg_markup: "<svg/>", position: "c", semantic_label: "x" }, lifetime_s: 9999 });
    beginCycle(s, { cycleIndex: 3, elapsedTotalS: 15 });
    const o = computeOverview(s);
    // Cycle 3 has no events yet, matching the packet-building moment before
    // current-cycle tools run. Recent therefore covers applied cycles 0, 1, 2.
    assert.equal(o.recent.tool_calls, 3);
    assert.equal(o.recent.placed, 2);
    assert.equal(o.recent.backgrounds, 1);
    assert.equal(o.recent.window_start_cycle, 0);
    assert.equal(o.recent.window_end_cycle, 2);
  });

  t("computeOverview recent activity: includes current cycle after tools have run", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    beginCycle(s, { cycleIndex: 3, elapsedTotalS: 15 });
    addElement(s, { type: "text", content: { content: "mid1", position: "c", style: "s" }, lifetime_s: 9999 });
    beginCycle(s, { cycleIndex: 4, elapsedTotalS: 20 });
    addElement(s, { type: "text", content: { content: "mid2", position: "c", style: "s" }, lifetime_s: 9999 });
    addElement(s, { type: "svg", content: { svg_markup: "<svg/>", position: "c", semantic_label: "x" }, lifetime_s: 9999 });
    beginCycle(s, { cycleIndex: 5, elapsedTotalS: 25 });
    addElement(s, { type: "image", content: { query: "q", position: "c" }, lifetime_s: 9999 });
    const o = computeOverview(s);
    assert.equal(o.recent.tool_calls, 4);
    assert.equal(o.recent.placed, 4);
    assert.equal(o.recent.window_start_cycle, 3);
    assert.equal(o.recent.window_end_cycle, 5);
  });

  t("computeOverview recent activity: counts manual fades but not auto-fades", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    const manual = addElement(s, { type: "text", content: { content: "manual", position: "c", style: "s" }, lifetime_s: 9999 });
    addElement(s, { type: "text", content: { content: "auto", position: "c", style: "s" }, lifetime_s: 10 });
    beginCycle(s, { cycleIndex: 1, elapsedTotalS: 10 });
    fadeElement(s, manual);
    autoFade(s);
    beginCycle(s, { cycleIndex: 2, elapsedTotalS: 15 });
    const o = computeOverview(s);
    assert.equal(o.recent.fades, 1);
    assert.equal(o.recent.tool_calls, 3); // two placements + one manual fade
  });

  t("formatOverviewBlock empty state renders zero line without crowded-region note", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    const block = formatOverviewBlock(computeOverview(s));
    assert.match(block, /^SCENE OVERVIEW:/m);
    assert.match(block, /Elements active: 0 total \(0 text, 0 SVG, 0 images\) — faded this session: 0/);
    assert.match(block, /Spatial: upper-left: 0 \| upper-center: 0 \| upper-right: 0 \| middle-left: 0 \| middle-center: 0 \| middle-right: 0 \| lower-left: 0 \| lower-center: 0 \| lower-right: 0/);
    assert.doesNotMatch(block, /Crowded region:/);
  });

  t("formatOverviewBlock shows crowded region note when triggered", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    for (let i = 0; i < 5; i++) {
      addElement(s, { type: "text", content: { content: `u${i}`, position: "upper-right", style: "s" } });
    }
    for (let i = 0; i < 5; i++) {
      addElement(s, { type: "svg", content: { svg_markup: "<svg/>", position: "lower-left", semantic_label: "x" } });
    }
    const block = formatOverviewBlock(computeOverview(s));
    assert.match(block, /Crowded region: upper-right \(5 elements of 10 total\)\./);
  });

  t("formatOverviewBlock renders density trajectory with classification when full", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    addElement(s, { type: "text", content: { content: "a", position: "c", style: "s" }, lifetime_s: 9999 });
    addElement(s, { type: "text", content: { content: "b", position: "c", style: "s" }, lifetime_s: 9999 });
    beginCycle(s, { cycleIndex: 1, elapsedTotalS: 5 });
    for (let i = 0; i < 3; i++) addElement(s, { type: "text", content: { content: `x${i}`, position: "c", style: "s" }, lifetime_s: 9999 });
    beginCycle(s, { cycleIndex: 2, elapsedTotalS: 10 });
    for (let i = 0; i < 2; i++) addElement(s, { type: "text", content: { content: `y${i}`, position: "c", style: "s" }, lifetime_s: 9999 });
    beginCycle(s, { cycleIndex: 3, elapsedTotalS: 15 });
    const block = formatOverviewBlock(computeOverview(s));
    assert.match(block, /Density trajectory: 2 → 5 → 7 → 7 \(3 cycles ago → 2 ago → 1 ago → current\)\. Growing\./);
  });

  t("formatOverviewBlock renders partial trajectory for early cycles without classification", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    addElement(s, { type: "text", content: { content: "a", position: "c", style: "s" }, lifetime_s: 9999 });
    beginCycle(s, { cycleIndex: 1, elapsedTotalS: 5 });
    addElement(s, { type: "text", content: { content: "b", position: "c", style: "s" }, lifetime_s: 9999 });
    addElement(s, { type: "text", content: { content: "c", position: "c", style: "s" }, lifetime_s: 9999 });
    const block = formatOverviewBlock(computeOverview(s));
    // Two data points; no classification suffix.
    assert.match(block, /Density trajectory: 1 → 3 \(1 ago → current\)\./);
    assert.doesNotMatch(block, /Growing|Thinning|Stable/);
  });

  t("formatOverviewBlock renders recent activity line with fixed wording", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    setBackground(s, { css_background: "linear-gradient(#111, #222)" });
    const block = formatOverviewBlock(computeOverview(s));
    assert.match(block, /Recent: 1 tool call in last 3 applied cycles\. Placed: 0 elements, 0 composites, 0 fades, 1 background\./);
  });

  t("formatOverviewBlock renders occupancy guidance below the floor", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    addElement(s, { type: "text", content: { content: "a", position: "c", style: "s" } });
    const block = formatOverviewBlock(computeOverview(s));
    assert.match(block, /Occupancy: 1 active, floor 6\. Below floor — favor adding over fading\./);
  });

  t("formatOverviewBlock renders occupancy line at the floor", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    for (let i = 0; i < SCENE_OCCUPANCY_FLOOR; i += 1) {
      addElement(s, { type: "text", content: { content: `t${i}`, position: "c", style: "s" } });
    }
    const block = formatOverviewBlock(computeOverview(s));
    assert.match(block, /Occupancy: 6 active, at floor 6\./);
  });

  t("formatOverviewBlock renders occupancy line above the floor", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    for (let i = 0; i < SCENE_OCCUPANCY_FLOOR + 1; i += 1) {
      addElement(s, { type: "text", content: { content: `t${i}`, position: "c", style: "s" } });
    }
    const block = formatOverviewBlock(computeOverview(s));
    assert.match(block, /Occupancy: 7 active, above floor 6\./);
  });

  t("formatOverviewBlock renders 'Background: never set' when nothing has been placed", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 3, elapsedTotalS: 15 });
    const block = formatOverviewBlock(computeOverview(s));
    assert.match(block, /Background: never set/);
  });

  t("formatOverviewBlock renders 'fresh' status inside the 12-cycle floor", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    setBackground(s, { css_background: "#111" });
    beginCycle(s, { cycleIndex: 5, elapsedTotalS: 25 });
    const block = formatOverviewBlock(computeOverview(s));
    assert.match(block, /Background: 5 cycles since last shift, floor 12\. Fresh/);
  });

  t("formatOverviewBlock renders 'due' status at or past the 12-cycle floor", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 0 });
    setBackground(s, { css_background: "#111" });
    beginCycle(s, { cycleIndex: 14, elapsedTotalS: 70 });
    const block = formatOverviewBlock(computeOverview(s));
    assert.match(block, /Background: 14 cycles since last shift, floor 12\. Due/);
  });

  t("formatSummary inserts SCENE OVERVIEW block immediately after the header line", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 5, elapsedTotalS: 25 });
    addElement(s, { type: "text", content: { content: "hello", position: "upper-left", style: "s" } });
    const summary = formatSummary(s);
    const lines = summary.split("\n");
    // Line 0 is the header; next non-blank line should be the SCENE OVERVIEW marker.
    assert.match(lines[0], /^Current scene /);
    const idx = lines.findIndex((l) => l.startsWith("SCENE OVERVIEW:"));
    assert.ok(idx > 0 && idx <= 3, "SCENE OVERVIEW should appear near the top");
    // And the ORIGINAL listing sections still appear later.
    assert.ok(summary.indexOf("TEXT [1 active]:") > summary.indexOf("SCENE OVERVIEW:"));
  });

  t("formatSummary still works for empty state (overview + empty-scene message + background)", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 16, elapsedTotalS: 80 });
    const summary = formatSummary(s);
    assert.match(summary, /0 elements visible, 80s since performance start/);
    assert.match(summary, /SCENE OVERVIEW:/);
    assert.match(summary, /Elements active: 0 total/);
    assert.match(summary, /\(empty — nothing has been placed yet\)/);
    assert.match(summary, /BACKGROUND: \(not set\)/);
  });

  t("computeOverview tolerates state loaded from disk without cycle_history field", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 4, elapsedTotalS: 20 });
    addElement(s, { type: "text", content: { content: "legacy", position: "upper-left", style: "s" } });
    // Simulate an older persisted state that lacks the field.
    delete s.cycle_history;
    const o = computeOverview(s);
    assert.equal(o.elements.total, 1);
    assert.deepEqual(o.trajectory.counts, [1]);
    assert.equal(o.trajectory.classification, null);
  });

  // ==========================================================================
  // COMPOSITION GROUP tests (Session C)
  // ==========================================================================

  t("createInitialState includes next_group_index and empty composition_groups", () => {
    const s = createInitialState();
    assert.equal(s.next_group_index, 0);
    assert.deepEqual(s.composition_groups, {});
  });

  t("addCompositionGroup mints monotonic group_NNNN ids and records metadata", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 4, elapsedTotalS: 22 });
    const g1 = addCompositionGroup(s, { group_label: "threshold arrival" });
    const g2 = addCompositionGroup(s, { group_label: "what remained" });
    assert.equal(g1, "group_0000");
    assert.equal(g2, "group_0001");
    assert.equal(s.next_group_index, 2);
    assert.equal(s.composition_groups[g1].group_label, "threshold arrival");
    assert.equal(s.composition_groups[g1].created_at_cycle, 4);
    assert.equal(s.composition_groups[g1].created_at_elapsed_s, 22);
    assert.equal(s.composition_groups[g2].group_label, "what remained");
  });

  t("fadeElement by group_id fades all non-faded members in the group", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 2, elapsedTotalS: 10 });
    const gid = addCompositionGroup(s, { group_label: "g" });
    const a = addElement(s, {
      type: "text",
      content: { content: "a", position: "upper-right", style: "s", composition_group_id: gid },
    });
    const b = addElement(s, {
      type: "svg",
      content: { svg_markup: "<svg/>", position: "lower-left", semantic_label: "x", composition_group_id: gid },
    });
    const loose = addElement(s, {
      type: "text",
      content: { content: "loose", position: "c", style: "s" },
    });
    const r = fadeElement(s, gid);
    assert.equal(r.ok, true);
    assert.equal(r.faded_count, 2);
    assert.deepEqual(r.faded_element_ids.sort(), [a, b].sort());
    assert.equal(s.elements.find((e) => e.element_id === a).faded, true);
    assert.equal(s.elements.find((e) => e.element_id === b).faded, true);
    assert.equal(s.elements.find((e) => e.element_id === loose).faded, false);
  });

  t("fadeElement by unknown group_id returns 'no such element'", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const r = fadeElement(s, "group_9999");
    assert.deepEqual(r, { error: "no such element" });
  });

  t("fadeElement by group_id where all members already faded returns 'already faded'", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const gid = addCompositionGroup(s, { group_label: "g" });
    const a = addElement(s, {
      type: "text",
      content: { content: "a", position: "c", style: "s", composition_group_id: gid },
    });
    const b = addElement(s, {
      type: "image",
      content: { query: "q", position: "background", composition_group_id: gid },
    });
    fadeElement(s, a);
    fadeElement(s, b);
    const r = fadeElement(s, gid);
    assert.deepEqual(r, { error: "already faded" });
  });

  t("fadeElement by element_id on a group member leaves siblings active", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const gid = addCompositionGroup(s, { group_label: "g" });
    const a = addElement(s, {
      type: "text",
      content: { content: "a", position: "c", style: "s", composition_group_id: gid },
    });
    const b = addElement(s, {
      type: "text",
      content: { content: "b", position: "c", style: "s", composition_group_id: gid },
    });
    fadeElement(s, a);
    assert.equal(s.elements.find((e) => e.element_id === a).faded, true);
    assert.equal(s.elements.find((e) => e.element_id === b).faded, false);
  });

  t("formatSummary renders COMPOSITION GROUP block with label, age, element count", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 3, elapsedTotalS: 20 });
    const gid = addCompositionGroup(s, { group_label: "the room someone just left" });
    addElement(s, {
      type: "text",
      content: { content: "what remains", position: "upper-right", style: "serif", composition_group_id: gid },
    });
    addElement(s, {
      type: "svg",
      content: {
        svg_markup: '<svg viewBox="0 0 100 100"><line x1="0" y1="50" x2="100" y2="50"/></svg>',
        position: "horizontal band lower",
        semantic_label: "thin horizontal line, pale",
        composition_group_id: gid,
      },
    });
    addElement(s, {
      type: "image",
      content: { query: "stone wall in afternoon sun", position: "background", composition_group_id: gid },
    });
    beginCycle(s, { cycleIndex: 4, elapsedTotalS: 25 });
    const summary = formatSummary(s);
    assert.match(summary, /COMPOSITION GROUP \[group_0000\] "the room someone just left" \(5s old, 3 elements\):/);
    assert.match(summary, /- elem_0001 TEXT .*"what remains"/);
    assert.match(summary, /- elem_0002 SVG .*"thin horizontal line, pale"/);
    assert.match(summary, /markup: <svg viewBox="0 0 100 100">/);
    assert.match(summary, /- elem_0003 IMAGE .*query="stone wall in afternoon sun"/);
  });

  t("formatSummary excludes grouped elements from TEXT/IMAGES/SVG sections", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const gid = addCompositionGroup(s, { group_label: "composed" });
    addElement(s, {
      type: "text",
      content: { content: "GROUPED_ONE", position: "upper-left", style: "s", composition_group_id: gid },
    });
    addElement(s, {
      type: "text",
      content: { content: "SOLO_ONE", position: "lower-right", style: "s" },
    });
    const summary = formatSummary(s);
    // Grouped text appears inside the group block but not a second time in TEXT section.
    const groupedOccurrences = summary.match(/GROUPED_ONE/g) || [];
    assert.equal(groupedOccurrences.length, 1);
    const soloOccurrences = summary.match(/SOLO_ONE/g) || [];
    assert.equal(soloOccurrences.length, 1);
    assert.match(summary, /TEXT \[1 active\]:/);
  });

  t("formatSummary places composition groups between BACKGROUND and TEXT section", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const gid = addCompositionGroup(s, { group_label: "g" });
    addElement(s, {
      type: "text",
      content: { content: "inside", position: "c", style: "s", composition_group_id: gid },
    });
    addElement(s, {
      type: "svg",
      content: { svg_markup: "<svg/>", position: "c", semantic_label: "also", composition_group_id: gid },
    });
    addElement(s, {
      type: "text",
      content: { content: "ungrouped", position: "c", style: "s" },
    });
    const summary = formatSummary(s);
    const overviewIdx = summary.indexOf("SCENE OVERVIEW:");
    const backgroundIdx = summary.indexOf("BACKGROUND:");
    const groupIdx = summary.indexOf("COMPOSITION GROUP [group_0000]");
    const textIdx = summary.indexOf("TEXT [1 active]:");
    assert.ok(overviewIdx >= 0);
    assert.ok(backgroundIdx > overviewIdx);
    assert.ok(groupIdx > backgroundIdx);
    assert.ok(textIdx > groupIdx);
  });

  t("formatSummary still renders groups when all active elements are grouped", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const gid = addCompositionGroup(s, { group_label: "pair" });
    addElement(s, {
      type: "text",
      content: { content: "a", position: "c", style: "s", composition_group_id: gid },
    });
    addElement(s, {
      type: "image",
      content: { query: "q", position: "background", composition_group_id: gid },
    });
    const summary = formatSummary(s);
    assert.match(summary, /COMPOSITION GROUP \[group_0000\] "pair" \(0s old, 2 elements\):/);
    assert.doesNotMatch(summary, /^TEXT \[/m);
    assert.doesNotMatch(summary, /^IMAGES \[/m);
    assert.doesNotMatch(summary, /\(empty — nothing has been placed yet\)/);
  });

  t("formatSummary marks composition-group members 'fading next cycle' individually", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const gid = addCompositionGroup(s, { group_label: "g" });
    addElement(s, {
      type: "text",
      content: { content: "short", position: "c", style: "s", composition_group_id: gid },
      lifetime_s: 5,
    });
    addElement(s, {
      type: "text",
      content: { content: "long", position: "c", style: "s", composition_group_id: gid },
      lifetime_s: 60,
    });
    beginCycle(s, { cycleIndex: 2, elapsedTotalS: 8 });
    const summary = formatSummary(s);
    // The short-lifetime member should be annotated; the long one should not.
    const shortLine = summary.split("\n").find((ln) => ln.includes('"short"'));
    const longLine = summary.split("\n").find((ln) => ln.includes('"long"'));
    assert.match(shortLine, /fading next cycle/);
    assert.doesNotMatch(longLine, /fading next cycle/);
  });

  t("computeOverview recent composites counter tracks distinct groups in window", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 3, elapsedTotalS: 15 });
    const g1 = addCompositionGroup(s, { group_label: "a" });
    addElement(s, {
      type: "text",
      content: { content: "a1", position: "c", style: "s", composition_group_id: g1 },
    });
    addElement(s, {
      type: "svg",
      content: { svg_markup: "<svg/>", position: "c", semantic_label: "x", composition_group_id: g1 },
    });
    addElement(s, {
      type: "image",
      content: { query: "q", position: "c", composition_group_id: g1 },
    });
    beginCycle(s, { cycleIndex: 4, elapsedTotalS: 20 });
    const g2 = addCompositionGroup(s, { group_label: "b" });
    addElement(s, {
      type: "text",
      content: { content: "b1", position: "c", style: "s", composition_group_id: g2 },
    });
    addElement(s, {
      type: "text",
      content: { content: "b2", position: "c", style: "s", composition_group_id: g2 },
    });
    addElement(s, {
      type: "text",
      content: { content: "loose", position: "c", style: "s" },
    });
    beginCycle(s, { cycleIndex: 5, elapsedTotalS: 25 });
    const o = computeOverview(s);
    // Window: cycles 3-5. Two distinct groups (g1, g2) + one ungrouped element.
    assert.equal(o.recent.composites, 2);
    assert.equal(o.recent.placed, 1);
  });

  t("legacy state without composition_groups still renders summary cleanly", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 4, elapsedTotalS: 20 });
    addElement(s, {
      type: "text",
      content: { content: "legacy", position: "upper-left", style: "s" },
    });
    delete s.composition_groups;
    delete s.next_group_index;
    // Should not throw; summary should still render.
    const summary = formatSummary(s);
    assert.match(summary, /Current scene/);
    assert.match(summary, /"legacy"/);
    assert.doesNotMatch(summary, /COMPOSITION GROUP/);
  });

  t("GROUP_ID_PATTERN matches group_0000/group_0001 and not elem_0001 or group_001", () => {
    assert.ok(GROUP_ID_PATTERN.test("group_0000"));
    assert.ok(GROUP_ID_PATTERN.test("group_0001"));
    assert.ok(GROUP_ID_PATTERN.test("group_0123"));
    assert.ok(!GROUP_ID_PATTERN.test("elem_0001"));
    assert.ok(!GROUP_ID_PATTERN.test("group_001"));
    assert.ok(!GROUP_ID_PATTERN.test("group_00001"));
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
}
