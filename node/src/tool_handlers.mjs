import {
  addElement,
  setBackground,
  fadeElement,
  addCompositionGroup,
  DEFAULT_LIFETIMES,
} from "./scene_state.mjs";
import { emitPatchesForToolResult } from "./patch_emitter.mjs";

function requireString(input, field) {
  const v = input[field];
  if (v === undefined || v === null) {
    return { error: `missing required field '${field}'` };
  }
  if (typeof v !== "string") {
    return { error: `field '${field}' must be a string` };
  }
  return null;
}

function handleAddText(state, input) {
  for (const field of ["content", "position", "style"]) {
    const err = requireString(input, field);
    if (err) return err;
  }
  const id = addElement(state, {
    type: "text",
    content: { content: input.content, position: input.position, style: input.style },
    lifetime_s: input.lifetime_s ?? null,
  });
  return { element_id: id };
}

function handleAddSVG(state, input) {
  for (const field of ["svg_markup", "position", "semantic_label"]) {
    const err = requireString(input, field);
    if (err) return err;
  }
  const id = addElement(state, {
    type: "svg",
    content: {
      svg_markup: input.svg_markup,
      position: input.position,
      semantic_label: input.semantic_label,
    },
    lifetime_s: input.lifetime_s,
  });
  return { element_id: id };
}

function handleAddImage(state, input) {
  for (const field of ["query", "position"]) {
    const err = requireString(input, field);
    if (err) return err;
  }
  const id = addElement(state, {
    type: "image",
    content: { query: input.query, position: input.position },
    lifetime_s: input.lifetime_s ?? null,
  });
  return { element_id: id };
}

function handleSetBackground(state, input) {
  const err = requireString(input, "css_background");
  if (err) return err;
  setBackground(state, { css_background: input.css_background });
  return { ok: true };
}

function handleFadeElement(state, input) {
  const err = requireString(input, "element_id");
  if (err) return err;
  return fadeElement(state, input.element_id);
}

// Validate a single composite element entry. Returns null on success,
// or { error: "composite element N: ..." } on the first missing/invalid
// field. Kept pure (no state mutation) so the whole composite can fail
// atomically before any element is added.
function validateCompositeElement(el, index) {
  const prefix = `composite element ${index}`;
  if (!el || typeof el !== "object" || Array.isArray(el)) {
    return { error: `${prefix}: must be an object` };
  }
  if (typeof el.type !== "string" || !["text", "svg", "image"].includes(el.type)) {
    return { error: `${prefix}: invalid or missing 'type'` };
  }
  if (typeof el.position !== "string") {
    return { error: `${prefix}: missing required field 'position'` };
  }
  if (el.type === "text" && typeof el.content !== "string") {
    return { error: `${prefix}: missing required field 'content'` };
  }
  if (el.type === "svg") {
    if (typeof el.svg_markup !== "string") {
      return { error: `${prefix}: missing required field 'svg_markup'` };
    }
    if (typeof el.semantic_label !== "string") {
      return { error: `${prefix}: missing required field 'semantic_label'` };
    }
  }
  if (el.type === "image" && typeof el.query !== "string") {
    return { error: `${prefix}: missing required field 'query'` };
  }
  return null;
}

function handleAddCompositeScene(state, input) {
  if (!Array.isArray(input.elements)) {
    return { error: "missing required field 'elements'" };
  }
  if (input.elements.length < 2 || input.elements.length > 5) {
    return { error: "'elements' must contain between 2 and 5 items" };
  }
  const labelErr = requireString(input, "group_label");
  if (labelErr) return labelErr;

  // Atomic validation pass — if any element is invalid the whole composite
  // is rejected before any state mutation.
  for (let i = 0; i < input.elements.length; i += 1) {
    const err = validateCompositeElement(input.elements[i], i);
    if (err) return err;
  }

  // Shared lifetime: explicit numeric value wins; otherwise if any member's
  // default lifetime is permanent (null), the whole composite is permanent.
  // If every member is timed, use the longest of those defaults.
  let sharedLifetime;
  if (typeof input.lifetime_s === "number" && Number.isFinite(input.lifetime_s)) {
    sharedLifetime = input.lifetime_s;
  } else {
    const defaults = input.elements.map((el) => DEFAULT_LIFETIMES[el.type]);
    sharedLifetime = defaults.some((value) => value === null)
      ? null
      : Math.max(...defaults);
  }

  const groupId = addCompositionGroup(state, { group_label: input.group_label });

  const elementIds = [];
  for (const el of input.elements) {
    let content;
    if (el.type === "text") {
      content = {
        content: el.content,
        position: el.position,
        style: typeof el.style === "string" ? el.style : "",
        composition_group_id: groupId,
      };
    } else if (el.type === "svg") {
      content = {
        svg_markup: el.svg_markup,
        position: el.position,
        semantic_label: el.semantic_label,
        composition_group_id: groupId,
      };
    } else {
      content = {
        query: el.query,
        position: el.position,
        composition_group_id: groupId,
      };
    }
    const id = addElement(state, {
      type: el.type,
      content,
      lifetime_s: sharedLifetime,
    });
    elementIds.push(id);
  }

  return { composition_group_id: groupId, element_ids: elementIds };
}

export function applyToolCall(state, toolUseBlock) {
  const input = toolUseBlock?.input ?? {};
  switch (toolUseBlock?.name) {
    case "addText":
      return handleAddText(state, input);
    case "addSVG":
      return handleAddSVG(state, input);
    case "addImage":
      return handleAddImage(state, input);
    case "setBackground":
      return handleSetBackground(state, input);
    case "fadeElement":
      return handleFadeElement(state, input);
    case "addCompositeScene":
      return handleAddCompositeScene(state, input);
    default:
      return { error: `unknown tool '${toolUseBlock?.name}'` };
  }
}

export async function applyToolCallDetailed(state, toolUseBlock, options = {}) {
  const result = applyToolCall(state, toolUseBlock);
  const patches = await emitPatchesForToolResult({
    state,
    toolUseBlock,
    result,
    fetchImageImpl: options.fetchImageImpl,
  });
  return { result, patches };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import("node:assert/strict")).default;
  const { createInitialState, beginCycle } = await import("./scene_state.mjs");

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

  function freshState(cycleIndex = 0, elapsedTotalS = 5) {
    const s = createInitialState();
    beginCycle(s, { cycleIndex, elapsedTotalS });
    return s;
  }

  t("applyToolCall addText with valid input returns {element_id} and adds element", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_1",
      name: "addText",
      input: { content: "after", position: "lower-left", style: "serif, large" },
    });
    assert.equal(r.element_id, "elem_0001");
    assert.equal(s.elements.length, 1);
    assert.equal(s.elements[0].content.content, "after");
    assert.equal(s.elements[0].lifetime_s, null);
  });

  t("applyToolCall addText missing required field returns error tool_result", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_x",
      name: "addText",
      input: { position: "c", style: "s" },
    });
    assert.deepEqual(r, { error: "missing required field 'content'" });
    assert.equal(s.elements.length, 0);
  });

  t("applyToolCall addText with non-string content returns error", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addText",
      input: { content: 42, position: "c", style: "s" },
    });
    assert.match(r.error, /content/);
    assert.equal(s.elements.length, 0);
  });

  t("applyToolCall addSVG with valid input returns {element_id}", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addSVG",
      input: {
        svg_markup: "<svg><line x1='0' y1='0' x2='50' y2='50'/></svg>",
        position: "left edge",
        semantic_label: "diagonal line",
      },
    });
    assert.equal(r.element_id, "elem_0001");
    assert.equal(s.elements[0].content.svg_markup, "<svg><line x1='0' y1='0' x2='50' y2='50'/></svg>");
    assert.equal(s.elements[0].content.semantic_label, "diagonal line");
  });

  t("applyToolCall addSVG without svg_markup returns error", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addSVG",
      input: { position: "center", semantic_label: "x" },
    });
    assert.deepEqual(r, { error: "missing required field 'svg_markup'" });
  });

  t("applyToolCall addSVG without semantic_label returns error", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addSVG",
      input: { svg_markup: "<svg/>", position: "center" },
    });
    assert.deepEqual(r, { error: "missing required field 'semantic_label'" });
  });

  t("applyToolCall addImage with valid input returns {element_id}", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addImage",
      input: { query: "threshold light", position: "background" },
    });
    assert.equal(r.element_id, "elem_0001");
    assert.equal(s.elements[0].content.query, "threshold light");
    assert.equal(s.elements[0].lifetime_s, null);
  });

  t("applyToolCall addImage without query returns error", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addImage",
      input: { position: "background" },
    });
    assert.deepEqual(r, { error: "missing required field 'query'" });
  });

  t("applyToolCall setBackground with valid css returns {ok:true}", () => {
    const s = freshState(3, 20);
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "setBackground",
      input: { css_background: "linear-gradient(180deg, #111, #222)" },
    });
    assert.deepEqual(r, { ok: true });
    assert.equal(s.background.css_background, "linear-gradient(180deg, #111, #222)");
  });

  t("applyToolCall setBackground without css_background returns error", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "setBackground",
      input: {},
    });
    assert.deepEqual(r, { error: "missing required field 'css_background'" });
  });

  t("applyToolCall setBackground with non-string css_background returns error", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "setBackground",
      input: { css_background: 42 },
    });
    assert.match(r.error, /css_background/);
  });

  t("applyToolCall fadeElement with existing id returns {ok:true}", () => {
    const s = freshState();
    const addR = applyToolCall(s, {
      type: "tool_use",
      id: "t1",
      name: "addText",
      input: { content: "x", position: "c", style: "s" },
    });
    const fadeR = applyToolCall(s, {
      type: "tool_use",
      id: "t2",
      name: "fadeElement",
      input: { element_id: addR.element_id },
    });
    assert.deepEqual(fadeR, { ok: true });
  });

  t("applyToolCall fadeElement with unknown id returns 'no such element'", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "fadeElement",
      input: { element_id: "elem_9999" },
    });
    assert.deepEqual(r, { error: "no such element" });
  });

  t("applyToolCall fadeElement on already-faded returns 'already faded'", () => {
    const s = freshState();
    const addR = applyToolCall(s, {
      type: "tool_use",
      id: "t1",
      name: "addText",
      input: { content: "x", position: "c", style: "s" },
    });
    applyToolCall(s, {
      type: "tool_use",
      id: "t2",
      name: "fadeElement",
      input: { element_id: addR.element_id },
    });
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t3",
      name: "fadeElement",
      input: { element_id: addR.element_id },
    });
    assert.deepEqual(r, { error: "already faded" });
  });

  t("applyToolCall fadeElement without element_id returns missing-field error", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "fadeElement",
      input: {},
    });
    assert.deepEqual(r, { error: "missing required field 'element_id'" });
  });

  t("applyToolCall with unknown tool name returns error", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "delete_universe",
      input: {},
    });
    assert.match(r.error, /unknown tool/);
  });

  t("applyToolCall addText honors optional lifetime_s override", () => {
    const s = freshState(0, 10);
    applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addText",
      input: { content: "x", position: "c", style: "s", lifetime_s: 50 },
    });
    assert.equal(s.elements[0].lifetime_s, 50);
    assert.equal(s.elements[0].fades_at_elapsed_s, 60);
  });

  // ==========================================================================
  // addCompositeScene tests (Session C)
  // ==========================================================================

  t("applyToolCall addCompositeScene with valid 3-element group returns {composition_group_id, element_ids}", () => {
    const s = freshState(2, 15);
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addCompositeScene",
      input: {
        group_label: "the room someone just left",
        elements: [
          { type: "text", content: "what remains", position: "upper-right", style: "serif" },
          {
            type: "svg",
            svg_markup: "<svg viewBox='0 0 100 100'><line x1='0' y1='50' x2='100' y2='50'/></svg>",
            position: "horizontal band lower",
            semantic_label: "thin horizontal line",
          },
          { type: "image", query: "stone wall in afternoon sun", position: "background" },
        ],
      },
    });
    assert.equal(r.composition_group_id, "group_0000");
    assert.deepEqual(r.element_ids, ["elem_0001", "elem_0002", "elem_0003"]);
    assert.equal(s.elements.length, 3);
    assert.equal(s.elements[0].content.composition_group_id, "group_0000");
    assert.equal(s.elements[1].content.composition_group_id, "group_0000");
    assert.equal(s.elements[2].content.composition_group_id, "group_0000");
    assert.equal(s.composition_groups["group_0000"].group_label, "the room someone just left");
  });

  t("applyToolCall addCompositeScene with elements missing returns error and no state mutation", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addCompositeScene",
      input: { group_label: "g" },
    });
    assert.match(r.error, /elements/);
    assert.equal(s.elements.length, 0);
    assert.equal(s.next_group_index, 0);
  });

  t("applyToolCall addCompositeScene with <2 elements rejects", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addCompositeScene",
      input: {
        group_label: "g",
        elements: [{ type: "text", content: "solo", position: "c", style: "s" }],
      },
    });
    assert.match(r.error, /2 and 5/);
    assert.equal(s.elements.length, 0);
  });

  t("applyToolCall addCompositeScene with >5 elements rejects", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addCompositeScene",
      input: {
        group_label: "g",
        elements: Array.from({ length: 6 }, (_, i) => ({
          type: "text",
          content: `e${i}`,
          position: "c",
          style: "s",
        })),
      },
    });
    assert.match(r.error, /2 and 5/);
    assert.equal(s.elements.length, 0);
  });

  t("applyToolCall addCompositeScene without group_label rejects", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addCompositeScene",
      input: {
        elements: [
          { type: "text", content: "a", position: "c", style: "s" },
          { type: "text", content: "b", position: "c", style: "s" },
        ],
      },
    });
    assert.deepEqual(r, { error: "missing required field 'group_label'" });
    assert.equal(s.elements.length, 0);
  });

  t("applyToolCall addCompositeScene rejects with 'composite element N:' prefix on per-element failure", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addCompositeScene",
      input: {
        group_label: "g",
        elements: [
          { type: "text", content: "ok", position: "c", style: "s" },
          { type: "svg", position: "c" }, // missing svg_markup + semantic_label
        ],
      },
    });
    assert.match(r.error, /^composite element 1:/);
    assert.match(r.error, /svg_markup/);
    // Atomic: no elements added, no group minted.
    assert.equal(s.elements.length, 0);
    assert.equal(s.next_group_index, 0);
    assert.deepEqual(s.composition_groups, {});
  });

  t("applyToolCall addCompositeScene rejects invalid type with 'composite element N: invalid or missing type'", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addCompositeScene",
      input: {
        group_label: "g",
        elements: [
          { type: "text", content: "ok", position: "c", style: "s" },
          { type: "video", position: "c" },
        ],
      },
    });
    assert.match(r.error, /^composite element 1: invalid or missing 'type'/);
    assert.equal(s.elements.length, 0);
  });

  t("applyToolCall addCompositeScene becomes permanent when any member type has null default lifetime", () => {
    const s = freshState(0, 10);
    applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addCompositeScene",
      input: {
        group_label: "g",
        elements: [
          { type: "svg", svg_markup: "<svg/>", position: "c", semantic_label: "x" },
          { type: "image", query: "q", position: "c" },
        ],
      },
    });
    assert.equal(s.elements[0].lifetime_s, null);
    assert.equal(s.elements[1].lifetime_s, null);
    assert.equal(s.elements[0].fades_at_elapsed_s, null);
    assert.equal(s.elements[1].fades_at_elapsed_s, null);
  });

  t("applyToolCall addCompositeScene with only SVG members uses the timed SVG default", () => {
    const s = freshState(0, 10);
    applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addCompositeScene",
      input: {
        group_label: "g",
        elements: [
          { type: "svg", svg_markup: "<svg/>", position: "c", semantic_label: "x" },
          { type: "svg", svg_markup: "<svg/>", position: "c", semantic_label: "y" },
        ],
      },
    });
    assert.equal(s.elements[0].lifetime_s, 35);
    assert.equal(s.elements[1].lifetime_s, 35);
    assert.equal(s.elements[0].fades_at_elapsed_s, 45);
  });

  t("applyToolCall addCompositeScene honors explicit lifetime_s override for all members", () => {
    const s = freshState(0, 10);
    applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addCompositeScene",
      input: {
        group_label: "g",
        lifetime_s: 42,
        elements: [
          { type: "text", content: "a", position: "c", style: "s" },
          { type: "svg", svg_markup: "<svg/>", position: "c", semantic_label: "x" },
        ],
      },
    });
    assert.equal(s.elements[0].lifetime_s, 42);
    assert.equal(s.elements[1].lifetime_s, 42);
    assert.equal(s.elements[0].fades_at_elapsed_s, 52);
    assert.equal(s.elements[1].fades_at_elapsed_s, 52);
  });

  t("applyToolCall fadeElement by composition_group_id fades all members via dispatcher", () => {
    const s = freshState(0, 5);
    const addR = applyToolCall(s, {
      type: "tool_use",
      id: "t1",
      name: "addCompositeScene",
      input: {
        group_label: "g",
        elements: [
          { type: "text", content: "a", position: "c", style: "s" },
          { type: "text", content: "b", position: "c", style: "s" },
        ],
      },
    });
    const fadeR = applyToolCall(s, {
      type: "tool_use",
      id: "t2",
      name: "fadeElement",
      input: { element_id: addR.composition_group_id },
    });
    assert.equal(fadeR.ok, true);
    assert.equal(fadeR.faded_count, 2);
    assert.ok(s.elements.every((e) => e.faded));
  });

  t("applyToolCall addCompositeScene tolerates missing optional 'style' on composite text elements", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addCompositeScene",
      input: {
        group_label: "g",
        elements: [
          { type: "text", content: "no-style", position: "upper-left" },
          { type: "text", content: "also-no-style", position: "lower-right" },
        ],
      },
    });
    assert.ok(r.composition_group_id, "should succeed without style field");
    assert.equal(s.elements[0].content.style, "");
    assert.equal(s.elements[1].content.style, "");
  });

  t("applyToolCall addCompositeScene: all members share created_at_cycle and created_at_elapsed_s", () => {
    const s = freshState(7, 35);
    applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addCompositeScene",
      input: {
        group_label: "moment",
        elements: [
          { type: "text", content: "a", position: "c", style: "s" },
          { type: "svg", svg_markup: "<svg/>", position: "c", semantic_label: "x" },
          { type: "image", query: "q", position: "background" },
        ],
      },
    });
    assert.equal(s.elements.length, 3);
    for (const el of s.elements) {
      assert.equal(el.created_at_cycle, 7);
      assert.equal(el.created_at_elapsed_s, 35);
    }
  });

  try {
    const s = freshState();
    const detailed = await applyToolCallDetailed(s, {
      type: "tool_use",
      id: "detail_1",
      name: "addText",
      input: { content: "after", position: "lower-left", style: "serif, large" },
    });
    assert.equal(detailed.result.element_id, "elem_0001");
    assert.equal(detailed.patches.length, 1);
    assert.equal(detailed.patches[0].type, "element.add");
    pass++;
    process.stdout.write("  ok  applyToolCallDetailed returns the legacy result and a patch list\n");
  } catch (err) {
    fail++;
    process.stdout.write(`  FAIL applyToolCallDetailed returns the legacy result and a patch list\n    ${err.message}\n`);
  }

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
}
