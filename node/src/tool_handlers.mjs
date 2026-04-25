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
import {
  ReactivitySchema,
  MotionSchema,
  LAYER_TOKENS,
  TransformSpecSchema,
  PaletteTargetSchema,
  MorphTargetSchema,
  TEXT_ANIMATE_EFFECTS,
} from "./patch_protocol.mjs";

const TEXT_ANIMATE_EFFECT_SET = new Set(TEXT_ANIMATE_EFFECTS);

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

// v6.2: validate an optional layer string against LAYER_TOKENS. null /
// undefined → { ok, normalized: null } (meaning "use the per-type
// default"). Unknown tokens return an error so an LLM typo fails
// loudly rather than silently routing the element to the default band.
function validateLayer(raw) {
  if (raw === undefined || raw === null) return { ok: true, normalized: null };
  if (typeof raw !== "string" || !LAYER_TOKENS.includes(raw)) {
    return { error: `layer '${raw}' is not one of ${LAYER_TOKENS.join(", ")}` };
  }
  return { ok: true, normalized: raw };
}

// v6.2: validate an optional motion preset. A missing motion is legal
// (the element simply has no kernel attached). Delegates to the strict
// Zod schema so extras / Infinity / negative intensities reject here
// rather than at patch-ingress time.
function validateMotion(raw) {
  if (raw === undefined || raw === null) return { ok: true, normalized: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "motion must be an object" };
  }
  const parsed = MotionSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`)
      .join("; ");
    return { error: `motion invalid: ${issues}` };
  }
  return { ok: true, normalized: parsed.data };
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
  const layer = validateLayer(input.layer);
  if (layer.error) return { error: layer.error };
  const motion = validateMotion(input.motion);
  if (motion.error) return { error: motion.error };
  const id = addElement(state, {
    type: "text",
    content: { content: input.content, position: input.position, style: input.style },
    lifetime_s: input.lifetime_s ?? null,
    reactivity: reactivity.normalized,
    layer: layer.normalized,
    motion: motion.normalized,
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
  const layer = validateLayer(input.layer);
  if (layer.error) return { error: layer.error };
  const motion = validateMotion(input.motion);
  if (motion.error) return { error: motion.error };
  const id = addElement(state, {
    type: "svg",
    content: {
      svg_markup: input.svg_markup,
      position: input.position,
      semantic_label: input.semantic_label,
    },
    lifetime_s: input.lifetime_s,
    reactivity: reactivity.normalized,
    layer: layer.normalized,
    motion: motion.normalized,
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
  const layer = validateLayer(input.layer);
  if (layer.error) return { error: layer.error };
  const motion = validateMotion(input.motion);
  if (motion.error) return { error: motion.error };
  // Images default to the TTL path (scene_state honors DEFAULT_LIFETIMES.image).
  // Treat explicit null the same as omission here: live runs should not get
  // stuck on one permanent search result. Numeric values still override TTL.
  //
  // Preserve `undefined` (sentinel for "use the default") so scene_state
  // can apply DEFAULT_LIFETIMES[type]. Previously this handler collapsed
  // `undefined` to `null`, forcing the image permanent and bypassing the
  // new default TTL.
  const id = addElement(state, {
    type: "image",
    content: { query: input.query, position: input.position },
    lifetime_s: input.lifetime_s === null ? undefined : input.lifetime_s,
    reactivity: reactivity.normalized,
    layer: layer.normalized,
    motion: motion.normalized,
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
  const layer = validateLayer(input.layer);
  if (layer.error) return { error: layer.error };
  const { sketch_id, retired_id } = addP5SketchSlot(state, {
    position: input.position,
    size: input.size,
    code: input.code,
    audio_reactive: input.audio_reactive,
    lifetime_s: input.lifetime_s ?? null,
    layer: layer.normalized,
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
  const layer = validateLayer(el.layer);
  if (layer.error) return { error: `${prefix}: ${layer.error}` };
  const motion = validateMotion(el.motion);
  if (motion.error) return { error: `${prefix}: ${motion.error}` };
  return {
    ok: true,
    reactivity: reactivity.normalized,
    layer: layer.normalized,
    motion: motion.normalized,
  };
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
  // normalizes each member's reactivity / layer / motion; capture those
  // results here so the mutation pass below doesn't need to re-validate.
  const perMemberReactivity = [];
  const perMemberLayer = [];
  const perMemberMotion = [];
  for (let i = 0; i < input.elements.length; i += 1) {
    const result = validateCompositeElement(input.elements[i], i);
    if (result.error) return { error: result.error };
    perMemberReactivity.push(result.reactivity);
    perMemberLayer.push(result.layer);
    perMemberMotion.push(result.motion);
  }

  // Composite lifetime: an explicit numeric group lifetime wins for all
  // members. Otherwise each member uses its own type default so image turnover
  // is preserved even inside a text+image composite.
  const sharedLifetime =
    typeof input.lifetime_s === "number" && Number.isFinite(input.lifetime_s)
      ? input.lifetime_s
      : undefined;

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
      layer: perMemberLayer[i],
      motion: perMemberMotion[i],
    });
    elementIds.push(id);
  }

  return { composition_group_id: groupId, element_ids: elementIds };
}

// ─── Recompose tool handlers (expanded-tools) ──────────────────────
// All 5 recompose tools target an existing element_id (or the whole
// scene). They validate inputs, look up the element when applicable,
// and either echo {ok:true,...} or return {error:"..."}. morphElement
// is the only one that mutates state.elements — it rewrites the
// element's content in-place so later cycles' scene summary reflects
// the new asset.
function findElementById(state, elementId) {
  if (!Array.isArray(state?.elements)) return null;
  return state.elements.find((el) => el?.element_id === elementId) ?? null;
}

function requireFiniteNumber(input, field) {
  const v = input[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return { error: `field '${field}' must be a finite number` };
  }
  return null;
}

function handleTransformElement(state, input) {
  const idErr = requireString(input, "element_id");
  if (idErr) return idErr;
  const durErr = requireFiniteNumber(input, "duration_ms");
  if (durErr) return durErr;
  if (input.duration_ms < 0) return { error: "field 'duration_ms' must be >= 0" };
  if (!input.transform || typeof input.transform !== "object" || Array.isArray(input.transform)) {
    return { error: "missing required field 'transform'" };
  }
  const parsed = TransformSpecSchema.safeParse(input.transform);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`)
      .join("; ");
    return { error: `transform invalid: ${issues}` };
  }
  const el = findElementById(state, input.element_id);
  if (!el) return { error: "no such element" };
  return { ok: true, element_id: input.element_id, transform: parsed.data, duration_ms: input.duration_ms };
}

function handleMorphElement(state, input) {
  const idErr = requireString(input, "element_id");
  if (idErr) return idErr;
  const durErr = requireFiniteNumber(input, "duration_ms");
  if (durErr) return durErr;
  if (input.duration_ms < 0) return { error: "field 'duration_ms' must be >= 0" };
  if (!input.to || typeof input.to !== "object" || Array.isArray(input.to)) {
    return { error: "missing required field 'to'" };
  }
  const parsed = MorphTargetSchema.safeParse(input.to);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`)
      .join("; ");
    return { error: `to invalid: ${issues}` };
  }
  const el = findElementById(state, input.element_id);
  if (!el) return { error: "no such element" };
  // Mutate the stored element's content so subsequent scene summaries
  // reflect the morph. The element_id stays; the type and content
  // change in place. This intentionally skips morphs onto text — the
  // recompose surface for text is textAnimate, not morphElement.
  if (el.type === "text") return { error: "morphElement not supported on text elements; use textAnimate" };
  el.type = parsed.data.type;
  el.content = el.content && typeof el.content === "object" ? { ...el.content } : {};
  if (parsed.data.type === "svg") {
    el.content.svg_markup = parsed.data.content_or_src;
    if (typeof el.content.semantic_label !== "string") {
      el.content.semantic_label = "morphed form";
    }
    delete el.content.query;
    delete el.content.browser_url;
    delete el.content.image_error;
    delete el.content.attribution;
  } else {
    el.content.query = parsed.data.content_or_src;
    el.content.browser_url = null;
    el.content.image_error = null;
    el.content.attribution = null;
    delete el.content.svg_markup;
    delete el.content.semantic_label;
  }
  return { ok: true, element_id: input.element_id, to: parsed.data, duration_ms: input.duration_ms };
}

function handlePulseScene(_state, input) {
  const intErr = requireFiniteNumber(input, "intensity");
  if (intErr) return intErr;
  if (input.intensity < 0 || input.intensity > 1) {
    return { error: "field 'intensity' must be between 0 and 1" };
  }
  const durErr = requireFiniteNumber(input, "duration_ms");
  if (durErr) return durErr;
  if (input.duration_ms < 0) return { error: "field 'duration_ms' must be >= 0" };
  if (input.color !== undefined && input.color !== null && typeof input.color !== "string") {
    return { error: "field 'color' must be a string when provided" };
  }
  return {
    ok: true,
    intensity: input.intensity,
    color: typeof input.color === "string" ? input.color : null,
    duration_ms: input.duration_ms,
  };
}

function handlePaletteShift(_state, input) {
  if (!input.target || typeof input.target !== "object" || Array.isArray(input.target)) {
    return { error: "missing required field 'target'" };
  }
  const parsed = PaletteTargetSchema.safeParse(input.target);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`)
      .join("; ");
    return { error: `target invalid: ${issues}` };
  }
  const durErr = requireFiniteNumber(input, "duration_ms");
  if (durErr) return durErr;
  if (input.duration_ms < 0) return { error: "field 'duration_ms' must be >= 0" };
  return { ok: true, target: parsed.data, duration_ms: input.duration_ms };
}

function handleTextAnimate(state, input) {
  const idErr = requireString(input, "element_id");
  if (idErr) return idErr;
  if (typeof input.effect !== "string" || !TEXT_ANIMATE_EFFECT_SET.has(input.effect)) {
    return { error: `field 'effect' must be one of ${[...TEXT_ANIMATE_EFFECT_SET].join(", ")}` };
  }
  const durErr = requireFiniteNumber(input, "duration_ms");
  if (durErr) return durErr;
  if (input.duration_ms < 0) return { error: "field 'duration_ms' must be >= 0" };
  const el = findElementById(state, input.element_id);
  if (!el) return { error: "no such element" };
  if (el.type !== "text") return { error: "textAnimate only applies to text elements" };
  return { ok: true, element_id: input.element_id, effect: input.effect, duration_ms: input.duration_ms };
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
    case "transformElement":
      return handleTransformElement(state, input);
    case "morphElement":
      return handleMorphElement(state, input);
    case "pulseScene":
      return handlePulseScene(state, input);
    case "paletteShift":
      return handlePaletteShift(state, input);
    case "textAnimate":
      return handleTextAnimate(state, input);
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
    // v6.2: images now default to a TTL rather than permanent. The exact
    // value lives in scene_state (IMAGE_DEFAULT_TTL_S); assert only that
    // a finite positive number landed so the tests don't hard-code the
    // constant.
    assert.equal(typeof s.elements[0].lifetime_s, "number");
    assert.ok(s.elements[0].lifetime_s > 0);
  });

  t("applyToolCall addImage with explicit lifetime_s: null still uses image TTL", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      name: "addImage",
      input: { query: "anchor", position: "background", lifetime_s: null },
    });
    assert.ok(r.element_id);
    assert.equal(typeof s.elements[0].lifetime_s, "number");
    assert.ok(s.elements[0].lifetime_s > 0);
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

  t("applyToolCall addCompositeScene uses per-type lifetimes when no group lifetime is supplied", () => {
    // Text can persist as accumulated testimony while visual members in the
    // same group still receive their own turnover defaults.
    const s = freshState(0, 10);
    applyToolCall(s, {
      type: "tool_use",
      id: "t",
      name: "addCompositeScene",
      input: {
        group_label: "g",
        elements: [
          { type: "svg", svg_markup: "<svg/>", position: "c", semantic_label: "x" },
          { type: "text", content: "permanent", position: "c", style: "s" },
        ],
      },
    });
    assert.equal(s.elements[0].lifetime_s, DEFAULT_LIFETIMES.svg);
    assert.equal(s.elements[1].lifetime_s, null);
    assert.equal(s.elements[0].fades_at_elapsed_s, 10 + DEFAULT_LIFETIMES.svg);
    assert.equal(s.elements[1].fades_at_elapsed_s, null);
  });

  t("applyToolCall addCompositeScene with svg + image preserves each default lifetime", () => {
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
    assert.equal(s.elements[0].lifetime_s, DEFAULT_LIFETIMES.svg);
    assert.equal(s.elements[1].lifetime_s, DEFAULT_LIFETIMES.image);
    assert.equal(s.elements[0].fades_at_elapsed_s, 10 + DEFAULT_LIFETIMES.svg);
    assert.equal(s.elements[1].fades_at_elapsed_s, 10 + DEFAULT_LIFETIMES.image);
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

  // ─── Recompose tools (expanded-tools) ────────────────────────────
  t("applyToolCall transformElement validates, looks up element, returns ok-echo", () => {
    const s = freshState();
    const addR = applyToolCall(s, {
      type: "tool_use", id: "ta", name: "addText",
      input: { content: "x", position: "c", style: "s" },
    });
    const r = applyToolCall(s, {
      type: "tool_use", id: "tt", name: "transformElement",
      input: {
        element_id: addR.element_id,
        transform: { rotate: 15, scale: 1.2 },
        duration_ms: 600,
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.element_id, addR.element_id);
    assert.equal(r.transform.rotate, 15);
  });

  t("applyToolCall transformElement rejects unknown element + empty transform + bad duration", () => {
    const s = freshState();
    const r1 = applyToolCall(s, {
      type: "tool_use", id: "t", name: "transformElement",
      input: { element_id: "elem_9999", transform: { rotate: 1 }, duration_ms: 100 },
    });
    assert.deepEqual(r1, { error: "no such element" });
    const addR = applyToolCall(s, {
      type: "tool_use", id: "ta", name: "addText",
      input: { content: "x", position: "c", style: "s" },
    });
    const r2 = applyToolCall(s, {
      type: "tool_use", id: "t2", name: "transformElement",
      input: { element_id: addR.element_id, transform: {}, duration_ms: 100 },
    });
    assert.match(r2.error, /transform invalid/);
    const r3 = applyToolCall(s, {
      type: "tool_use", id: "t3", name: "transformElement",
      input: { element_id: addR.element_id, transform: { rotate: 1 }, duration_ms: -5 },
    });
    assert.match(r3.error, /duration_ms/);
  });

  t("applyToolCall morphElement updates the stored element content in-place", () => {
    const s = freshState();
    const addR = applyToolCall(s, {
      type: "tool_use", id: "ta", name: "addSVG",
      input: {
        svg_markup: "<svg viewBox='0 0 10 10'><circle cx='5' cy='5' r='3'/></svg>",
        position: "center",
        semantic_label: "ring",
      },
    });
    const r = applyToolCall(s, {
      type: "tool_use", id: "tm", name: "morphElement",
      input: {
        element_id: addR.element_id,
        to: { type: "image", content_or_src: "minaret at dusk" },
        duration_ms: 800,
      },
    });
    assert.equal(r.ok, true);
    const stored = s.elements.find((e) => e.element_id === addR.element_id);
    assert.equal(stored.type, "image");
    assert.equal(stored.content.query, "minaret at dusk");
    assert.equal(stored.content.svg_markup, undefined);
  });

  t("applyToolCall morphElement rejects on text element type", () => {
    const s = freshState();
    const addR = applyToolCall(s, {
      type: "tool_use", id: "ta", name: "addText",
      input: { content: "x", position: "c", style: "s" },
    });
    const r = applyToolCall(s, {
      type: "tool_use", id: "tm", name: "morphElement",
      input: {
        element_id: addR.element_id,
        to: { type: "svg", content_or_src: "<svg/>" },
        duration_ms: 400,
      },
    });
    assert.match(r.error, /not supported on text/);
  });

  t("applyToolCall pulseScene validates intensity in [0,1] and returns ok-echo", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use", id: "tp", name: "pulseScene",
      input: { intensity: 0.6, color: "#d59c6a", duration_ms: 400 },
    });
    assert.equal(r.ok, true);
    assert.equal(r.color, "#d59c6a");
    const bad = applyToolCall(s, {
      type: "tool_use", id: "tp2", name: "pulseScene",
      input: { intensity: 1.7, duration_ms: 400 },
    });
    assert.match(bad.error, /intensity/);
  });

  t("applyToolCall paletteShift requires at least one of hue/saturation/lightness", () => {
    const s = freshState();
    const r = applyToolCall(s, {
      type: "tool_use", id: "tps", name: "paletteShift",
      input: { target: { hue: 20 }, duration_ms: 1200 },
    });
    assert.equal(r.ok, true);
    assert.equal(r.target.hue, 20);
    const bad = applyToolCall(s, {
      type: "tool_use", id: "tps2", name: "paletteShift",
      input: { target: {}, duration_ms: 1200 },
    });
    assert.match(bad.error, /target invalid/);
  });

  t("applyToolCall textAnimate rejects unknown effect and non-text elements", () => {
    const s = freshState();
    const tx = applyToolCall(s, {
      type: "tool_use", id: "ta", name: "addText",
      input: { content: "what remains", position: "center", style: "serif" },
    });
    const sv = applyToolCall(s, {
      type: "tool_use", id: "tb", name: "addSVG",
      input: { svg_markup: "<svg/>", position: "center", semantic_label: "x" },
    });
    const ok = applyToolCall(s, {
      type: "tool_use", id: "tc", name: "textAnimate",
      input: { element_id: tx.element_id, effect: "wordByWord", duration_ms: 600 },
    });
    assert.equal(ok.ok, true);
    const badEffect = applyToolCall(s, {
      type: "tool_use", id: "td", name: "textAnimate",
      input: { element_id: tx.element_id, effect: "spinaround", duration_ms: 600 },
    });
    assert.match(badEffect.error, /effect/);
    const wrongType = applyToolCall(s, {
      type: "tool_use", id: "te", name: "textAnimate",
      input: { element_id: sv.element_id, effect: "shake", duration_ms: 400 },
    });
    assert.match(wrongType.error, /text elements/);
  });

  t("applyToolCallDetailed for transformElement returns the element.transform patch", async () => {
    const s = freshState();
    const addR = applyToolCall(s, {
      type: "tool_use", id: "ta", name: "addText",
      input: { content: "x", position: "c", style: "s" },
    });
    const detailed = await applyToolCallDetailed(s, {
      type: "tool_use", id: "tt", name: "transformElement",
      input: {
        element_id: addR.element_id,
        transform: { translate: { x: 5, y: -3 } },
        duration_ms: 300,
      },
    });
    assert.equal(detailed.result.ok, true);
    assert.equal(detailed.patches.length, 1);
    assert.equal(detailed.patches[0].type, "element.transform");
    assert.equal(detailed.patches[0].element_id, addR.element_id);
    assert.equal(detailed.patches[0].transform.translate.x, 5);
  });

  t("applyToolCallDetailed for pulseScene returns scene.pulse patch with optional color", async () => {
    const s = freshState();
    const detailed = await applyToolCallDetailed(s, {
      type: "tool_use", id: "tp", name: "pulseScene",
      input: { intensity: 0.4, duration_ms: 600 },
    });
    assert.equal(detailed.patches.length, 1);
    assert.equal(detailed.patches[0].type, "scene.pulse");
    assert.equal(detailed.patches[0].intensity, 0.4);
    assert.equal("color" in detailed.patches[0], false);
  });

  // ─── Reactivity + lifecycle (feature/reactivity-lifecycle) ────────
  t("addText accepts optional layer + motion; invalid layer rejects", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const r = applyToolCall(s, {
      name: "addText",
      input: {
        content: "after", position: "center", style: "serif",
        layer: "foreground",
        motion: { preset: "breathe" },
      },
    });
    assert.ok(r.element_id);
    const stored = s.elements.find((e) => e.element_id === r.element_id);
    assert.equal(stored.layer, "foreground");
    assert.equal(stored.motion.preset, "breathe");
    const bad = applyToolCall(s, {
      name: "addText",
      input: { content: "x", position: "c", style: "s", layer: "hud" },
    });
    assert.match(bad.error, /layer/);
  });

  t("addImage default lifetime is TTL; explicit null is treated as default TTL", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const r1 = applyToolCall(s, {
      name: "addImage",
      input: { query: "lamp glow", position: "background" },
    });
    const r2 = applyToolCall(s, {
      name: "addImage",
      input: { query: "ttl anchor", position: "background", lifetime_s: null },
    });
    const e1 = s.elements.find((e) => e.element_id === r1.element_id);
    const e2 = s.elements.find((e) => e.element_id === r2.element_id);
    assert.equal(typeof e1.lifetime_s, "number");
    assert.ok(e1.lifetime_s > 0);
    assert.equal(typeof e2.lifetime_s, "number");
    assert.ok(e2.lifetime_s > 0);
  });

  t("addP5Sketch accepts optional layer; invalid layer rejects", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const good = applyToolCall(s, {
      name: "addP5Sketch",
      input: {
        position: "center", size: "medium", code: "noop()", audio_reactive: true,
        layer: "midground",
      },
    });
    assert.ok(good.sketch_id);
    const stored = s.p5_sketches.find((x) => x.sketch_id === good.sketch_id);
    assert.equal(stored.layer, "midground");
    const bad = applyToolCall(s, {
      name: "addP5Sketch",
      input: {
        position: "center", size: "medium", code: "noop()", audio_reactive: true,
        layer: "overlay",
      },
    });
    assert.match(bad.error, /layer/);
  });

  t("motion validator rejects unknown preset and Infinity intensity", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const badPreset = applyToolCall(s, {
      name: "addSVG",
      input: {
        svg_markup: "<svg></svg>", position: "center", semantic_label: "x",
        motion: { preset: "shimmer" },
      },
    });
    assert.match(badPreset.error, /motion/);
    const badIntensity = applyToolCall(s, {
      name: "addSVG",
      input: {
        svg_markup: "<svg></svg>", position: "center", semantic_label: "x",
        motion: { preset: "breathe", intensity: Infinity },
      },
    });
    assert.match(badIntensity.error, /motion/);
  });

  t("addCompositeScene accepts per-member layer + motion; invalid member layer rejects atomically", () => {
    const s = createInitialState();
    beginCycle(s, { cycleIndex: 0, elapsedTotalS: 5 });
    const ok = applyToolCall(s, {
      name: "addCompositeScene",
      input: {
        group_label: "threshold arrival",
        elements: [
          { type: "text", content: "after", position: "lower-left", style: "serif",
            layer: "foreground", motion: { preset: "breathe" } },
          { type: "image", query: "lamp glow", position: "background", layer: "background" },
        ],
      },
    });
    assert.ok(ok.composition_group_id);
    const txt = s.elements.find((e) => e.element_id === ok.element_ids[0]);
    const img = s.elements.find((e) => e.element_id === ok.element_ids[1]);
    assert.equal(txt.layer, "foreground");
    assert.equal(txt.motion.preset, "breathe");
    assert.equal(img.layer, "background");

    const bad = applyToolCall(s, {
      name: "addCompositeScene",
      input: {
        group_label: "bad composite",
        elements: [
          { type: "text", content: "a", position: "center", style: "s" },
          { type: "text", content: "b", position: "c", style: "s", layer: "overlay" },
        ],
      },
    });
    assert.match(bad.error, /composite element 1/);
    assert.equal(s.elements.length, 2, "bad composite did not touch state beyond the successful one");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
}
