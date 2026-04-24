import {
  addElement,
  setBackground,
  fadeElement,
  addCompositionGroup,
  setP5Background,
  addP5SketchSlot,
  DEFAULT_LIFETIMES,
} from "./scene_state.mjs";
import { emitPatchesForToolResult } from "./patch_emitter.mjs";
import { ReactivitySchema } from "./patch_protocol.mjs";

const VALID_P5_POSITIONS = new Set([
  "top-left", "top-center", "top-right",
  "mid-left", "center", "mid-right",
  "bottom-left", "bottom-center", "bottom-right",
]);
const VALID_P5_SIZES = new Set(["small", "medium", "large"]);

// Accept either a single binding object or an array. Returns
// {ok: true, normalized: Reactivity[] | null} on success, or
// {error: "..."} on the first invalid binding. Normalized is null
// when the caller omitted reactivity (distinct from an empty array,
// which is legal and normalized to null here since an element with
// zero bindings is semantically the same as one with no reactivity).
function validateReactivity(raw) {
  if (raw === undefined || raw === null) return { ok: true, normalized: null };
  const arr = Array.isArray(raw) ? raw : [raw];
  if (arr.length === 0) return { ok: true, normalized: null };
  const normalized = [];
  for (let i = 0; i < arr.length; i++) {
    const parsed = ReactivitySchema.safeParse(arr[i]);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`)
        .join("; ");
      return { error: `reactivity[${i}] invalid: ${issues}` };
    }
    normalized.push(parsed.data);
  }
  return { ok: true, normalized };
}

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
  const reactivity = validateReactivity(input.reactivity);
  if (reactivity.error) return { error: reactivity.error };
  const id = addElement(state, {
    type: "text",
    content: { content: input.content, position: input.position, style: input.style },
    lifetime_s: input.lifetime_s ?? null,
    reactivity: reactivity.normalized,
  });
  return { element_id: id };
}

function handleAddSVG(state, input) {
  for (const field of ["svg_markup", "position", "semantic_label"]) {
    const err = requireString(input, field);
    if (err) return err;
  }
  const reactivity = validateReactivity(input.reactivity);
  if (reactivity.error) return { error: reactivity.error };
  const id = addElement(state, {
    type: "svg",
    content: {
      svg_markup: input.svg_markup,
      position: input.position,
      semantic_label: input.semantic_label,
    },
    lifetime_s: input.lifetime_s,
    reactivity: reactivity.normalized,
  });
  return { element_id: id };
}

function handleAddImage(state, input) {
  for (const field of ["query", "position"]) {
    const err = requireString(input, field);
    if (err) return err;
  }
  const reactivity = validateReactivity(input.reactivity);
  if (reactivity.error) return { error: reactivity.error };
  const id = addElement(state, {
    type: "image",
    content: { query: input.query, position: input.position },
    lifetime_s: input.lifetime_s ?? null,
    reactivity: reactivity.normalized,
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

function handleSetP5Background(state, input) {
  const err = requireString(input, "code");
  if (err) return err;
  if (typeof input.audio_reactive !== "boolean") {
    return { error: "field 'audio_reactive' must be a boolean" };
  }
  const { sketch_id, retired_id } = setP5Background(state, {
    code: input.code,
    audio_reactive: input.audio_reactive,
  });
  // retired_id surfaced to the caller so patch_emitter can emit
  // sketch.retire before sketch.background.set. Tool result stays terse.
  return retired_id
    ? { sketch_id, retired_id }
    : { sketch_id };
}

function handleAddP5Sketch(state, input) {
  for (const field of ["position", "code"]) {
    const err = requireString(input, field);
    if (err) return err;
  }
  if (!VALID_P5_POSITIONS.has(input.position)) {
    return { error: `invalid position '${input.position}'; expected one of ${[...VALID_P5_POSITIONS].join(", ")}` };
  }
  if (!VALID_P5_SIZES.has(input.size)) {
    return { error: `invalid size '${input.size}'; expected one of small|medium|large` };
  }
  if (typeof input.audio_reactive !== "boolean") {
    return { error: "field 'audio_reactive' must be a boolean" };
  }
  const { sketch_id, retired_id } = addP5SketchSlot(state, {
    position: input.position,
    size: input.size,
    code: input.code,
    audio_reactive: input.audio_reactive,
    lifetime_s: input.lifetime_s ?? null,
  });
  return retired_id
    ? { sketch_id, retired_id }
    : { sketch_id };
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
  const reactivity = validateReactivity(el.reactivity);
  if (reactivity.error) return { error: `${prefix}: ${reactivity.error}` };
  return { ok: true, reactivity: reactivity.normalized };
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
  // is rejected before any state mutation. validateCompositeElement also
  // normalizes each member's reactivity; capture those results here so the
  // mutation pass below doesn't need to re-validate.
  const perMemberReactivity = [];
  for (let i = 0; i < input.elements.length; i += 1) {
    const result = validateCompositeElement(input.elements[i], i);
    if (result.error) return { error: result.error };
    perMemberReactivity.push(result.reactivity);
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
  for (let i = 0; i < input.elements.length; i += 1) {
    const el = input.elements[i];
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
      reactivity: perMemberReactivity[i],
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
    case "setP5Background":
      return handleSetP5Background(state, input);
    case "addP5Sketch":
      return handleAddP5Sketch(state, input);
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

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
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

  t("applyToolCall addText accepts a single reactivity object (normalized to array)", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_r1",
      name: "addText",
      input: {
        content: "pulse",
        position: "center",
        style: "serif",
        reactivity: {
          property: "opacity",
          feature: "amplitude",
          map: { in: [0, 1], out: [0.5, 1.0], curve: "linear" },
        },
      },
    });
    assert.equal(r.element_id, "elem_0001");
    const stored = s.elements.find((e) => e.element_id === "elem_0001");
    assert.equal(Array.isArray(stored.reactivity), true);
    assert.equal(stored.reactivity.length, 1);
    assert.equal(stored.reactivity[0].property, "opacity");
  });

  t("applyToolCall addText accepts an array of reactivity bindings", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_r2",
      name: "addText",
      input: {
        content: "twin",
        position: "center",
        style: "serif",
        reactivity: [
          { property: "opacity", feature: "amplitude", map: { in: [0, 1], out: [0, 1], curve: "linear" } },
          { property: "scale", feature: "onset_strength", map: { in: [0, 1], out: [1, 1.2], curve: "impulse" }, smoothing_ms: 80 },
        ],
      },
    });
    assert.equal(r.element_id, "elem_0001");
    const stored = s.elements.find((e) => e.element_id === "elem_0001");
    assert.equal(stored.reactivity.length, 2);
    assert.equal(stored.reactivity[1].smoothing_ms, 80);
  });

  t("applyToolCall addText rejects invalid reactivity and does not mutate state", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_r3",
      name: "addText",
      input: {
        content: "broken",
        position: "center",
        style: "serif",
        reactivity: {
          property: "opacity",
          feature: "cowbell", // invalid feature
          map: { in: [0, 1], out: [0, 1], curve: "linear" },
        },
      },
    });
    assert.match(r.error, /reactivity/i);
    assert.equal(s.elements.length, 0);
  });

  t("applyToolCall addText rejects reactivity with unknown top-level key (strict)", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_r3s1",
      name: "addText",
      input: {
        content: "strict-extra-key",
        position: "center",
        style: "serif",
        reactivity: {
          property: "opacity",
          feature: "amplitude",
          map: { in: [0, 1], out: [0, 1], curve: "linear" },
          secret_knob: 42, // strict() should reject
        },
      },
    });
    assert.match(r.error, /reactivity/i);
    assert.equal(s.elements.length, 0);
  });

  t("applyToolCall addText rejects reactivity with unknown map sub-key (strict)", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_r3s2",
      name: "addText",
      input: {
        content: "strict-map-key",
        position: "center",
        style: "serif",
        reactivity: {
          property: "opacity",
          feature: "amplitude",
          map: { in: [0, 1], out: [0, 1], curve: "linear", domain: "time" },
        },
      },
    });
    assert.match(r.error, /reactivity/i);
    assert.equal(s.elements.length, 0);
  });

  t("applyToolCall addText rejects reactivity with negative smoothing_ms", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_r3s3",
      name: "addText",
      input: {
        content: "negative-smoothing",
        position: "center",
        style: "serif",
        reactivity: {
          property: "opacity",
          feature: "amplitude",
          map: { in: [0, 1], out: [0, 1], curve: "linear" },
          smoothing_ms: -10,
        },
      },
    });
    assert.match(r.error, /reactivity/i);
    assert.equal(s.elements.length, 0);
  });

  t("applyToolCall addText rejects reactivity with non-finite numbers (Infinity/NaN)", () => {
    for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const s = freshState();
      const r = applyToolCall(s, {
        type: "tool_use",
        id: "toolu_r3s4",
        name: "addText",
        input: {
          content: "non-finite-map",
          position: "center",
          style: "serif",
          reactivity: {
            property: "opacity",
            feature: "amplitude",
            map: { in: [0, bad], out: [0, 1], curve: "linear" },
          },
        },
      });
      assert.match(r.error, /reactivity/i, `expected rejection for ${bad}`);
      assert.equal(s.elements.length, 0);
    }
  });

  t("applyToolCall addText rejects reactivity whose value is not an object", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_r3s5",
      name: "addText",
      input: {
        content: "non-object",
        position: "center",
        style: "serif",
        reactivity: "opacity=amplitude",
      },
    });
    assert.match(r.error, /reactivity/i);
    assert.equal(s.elements.length, 0);
  });

  t("applyToolCall addSVG and addImage accept reactivity", () => {
    const s1 = freshState();
    const rSvg = applyToolCall(s1, {
      type: "tool_use",
      id: "toolu_r4",
      name: "addSVG",
      input: {
        svg_markup: "<svg viewBox='0 0 100 100'><circle cx='50' cy='50' r='30'/></svg>",
        position: "center",
        semantic_label: "ring",
        reactivity: [
          { property: "scale", feature: "hijaz_tahwil", map: { in: [0, 1], out: [1, 1.6], curve: "impulse" } },
        ],
      },
    });
    assert.equal(rSvg.element_id, "elem_0001");
    assert.equal(s1.elements[0].reactivity[0].feature, "hijaz_tahwil");

    const s2 = freshState();
    const rImg = applyToolCall(s2, {
      type: "tool_use",
      id: "toolu_r5",
      name: "addImage",
      input: {
        query: "stone wall in low sun",
        position: "background",
        reactivity: [
          { property: "color_hue", feature: "hijaz_intensity", map: { in: [0, 1], out: [-8, 8], curve: "ease-in" }, smoothing_ms: 2000 },
        ],
      },
    });
    assert.equal(rImg.element_id, "elem_0001");
    assert.equal(s2.elements[0].reactivity[0].property, "color_hue");
  });

  t("applyToolCall addCompositeScene accepts per-member reactivity (mixed with and without)", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_r6",
      name: "addCompositeScene",
      input: {
        group_label: "climax response",
        elements: [
          {
            type: "text",
            content: "now",
            position: "center",
            reactivity: [
              { property: "opacity", feature: "amplitude", map: { in: [0, 1], out: [0.5, 1], curve: "linear" } },
            ],
          },
          {
            type: "svg",
            svg_markup: "<svg viewBox='0 0 100 100'><line x1='0' y1='50' x2='100' y2='50'/></svg>",
            semantic_label: "horizon",
            position: "horizontal band at mid-height",
          },
        ],
      },
    });
    assert.equal(Array.isArray(r.element_ids), true);
    assert.equal(r.element_ids.length, 2);
    const first = s.elements.find((e) => e.element_id === r.element_ids[0]);
    const second = s.elements.find((e) => e.element_id === r.element_ids[1]);
    assert.equal(first.reactivity?.[0].property, "opacity");
    assert.equal("reactivity" in second, false);
  });

  t("applyToolCall setP5Background returns {sketch_id} on fresh slot", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_p1",
      name: "setP5Background",
      input: { code: "function draw(){ background(0); }", audio_reactive: true },
    });
    assert.ok(typeof r.sketch_id === "string" && r.sketch_id.startsWith("sketch_"));
    assert.equal(r.retired_id, undefined);
    assert.equal(s.p5_background.sketch_id, r.sketch_id);
  });

  t("applyToolCall setP5Background returns {sketch_id, retired_id} when replacing", () => {
    const s = freshState();
    const r1 = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_p2a",
      name: "setP5Background",
      input: { code: "first", audio_reactive: false },
    });
    const r2 = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_p2b",
      name: "setP5Background",
      input: { code: "second", audio_reactive: true },
    });
    assert.equal(r2.retired_id, r1.sketch_id);
  });

  t("applyToolCall setP5Background rejects missing/invalid fields", () => {
    const s = freshState();
    const r1 = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_p3a",
      name: "setP5Background",
      input: { audio_reactive: true },
    });
    assert.match(r1.error, /code/);
    const r2 = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_p3b",
      name: "setP5Background",
      input: { code: "ok", audio_reactive: "yes" },
    });
    assert.match(r2.error, /audio_reactive/);
    assert.equal(s.p5_background, null);
  });

  t("applyToolCall addP5Sketch validates position + size + audio_reactive", () => {
    const s = freshState();
    const good = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_p4a",
      name: "addP5Sketch",
      input: { position: "center", size: "small", code: "noop", audio_reactive: true },
    });
    assert.ok(good.sketch_id);

    const badPos = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_p4b",
      name: "addP5Sketch",
      input: { position: "nowhere", size: "small", code: "noop", audio_reactive: true },
    });
    assert.match(badPos.error, /invalid position/);

    const badSize = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_p4c",
      name: "addP5Sketch",
      input: { position: "center", size: "gigantic", code: "noop", audio_reactive: true },
    });
    assert.match(badSize.error, /invalid size/);

    const badReact = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_p4d",
      name: "addP5Sketch",
      input: { position: "center", size: "small", code: "noop", audio_reactive: "true" },
    });
    assert.match(badReact.error, /audio_reactive/);

    assert.equal(s.p5_sketches.length, 1);
  });

  t("applyToolCall addP5Sketch evicts oldest and surfaces retired_id on overflow", () => {
    const s = freshState();
    const r1 = applyToolCall(s, {
      type: "tool_use", id: "t1", name: "addP5Sketch",
      input: { position: "top-left", size: "small", code: "a", audio_reactive: false },
    });
    applyToolCall(s, {
      type: "tool_use", id: "t2", name: "addP5Sketch",
      input: { position: "center", size: "medium", code: "b", audio_reactive: false },
    });
    applyToolCall(s, {
      type: "tool_use", id: "t3", name: "addP5Sketch",
      input: { position: "bottom-right", size: "large", code: "c", audio_reactive: true },
    });
    const r4 = applyToolCall(s, {
      type: "tool_use", id: "t4", name: "addP5Sketch",
      input: { position: "mid-left", size: "small", code: "d", audio_reactive: true },
    });
    assert.equal(r4.retired_id, r1.sketch_id);
    assert.equal(s.p5_sketches.length, 3);
  });

  t("applyToolCall addCompositeScene rejects when any member has invalid reactivity (atomic)", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use",
      id: "toolu_r7",
      name: "addCompositeScene",
      input: {
        group_label: "doomed",
        elements: [
          {
            type: "text",
            content: "ok",
            position: "center",
          },
          {
            type: "text",
            content: "broken",
            position: "lower-left",
            reactivity: [
              { property: "opacity", feature: "amplitude", map: { in: [0, 1], out: [0, 1], curve: "nonexistent" } },
            ],
          },
        ],
      },
    });
    assert.match(r.error, /composite element 1|reactivity/i);
    assert.equal(s.elements.length, 0, "atomic failure — no members added");
    assert.equal(Object.keys(s.composition_groups).length, 0, "no group minted");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
}
