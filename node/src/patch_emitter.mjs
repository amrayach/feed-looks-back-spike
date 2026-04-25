import { basename } from "node:path";

import { fetchImage } from "./image_fetch.mjs";
import { sanitizeCssBackground, isSvgMarkupValid } from "./sanitize.mjs";
import { resolveAutoFadeDurationMs, IMAGE_AUTO_FADE_DURATION_MS } from "./scene_state.mjs";

const DEFAULT_FADE_DURATION_MS = 400;

function clone(value) {
  return structuredClone(value);
}

function findElement(state, elementId) {
  return state?.elements?.find((element) => element?.element_id === elementId) ?? null;
}

function findGroup(state, groupId) {
  return state?.composition_groups?.[groupId] ?? null;
}

function normalizeElementForPatch(element, contentOverrides = null) {
  const patch = {
    element_id: element.element_id,
    type: element.type,
    content: contentOverrides ? { ...clone(element.content), ...contentOverrides } : clone(element.content),
    lifetime_s: element.lifetime_s ?? null,
    composition_group_id: element.content?.composition_group_id ?? null,
  };
  // ElementSpecSchema accepts reactivity as an optional top-level array.
  // We forward the stored array verbatim — scene_state only attaches
  // reactivity when non-empty, so the wire shape stays stable for
  // non-reactive elements.
  if (Array.isArray(element.reactivity) && element.reactivity.length > 0) {
    patch.reactivity = clone(element.reactivity);
  }
  // v6.2 additions: layer + motion. Same shape-stability rule — only
  // forward when the element actually carries them, so non-layered /
  // non-motion elements stay byte-identical with pre-v6.2 wire format.
  if (typeof element.layer === "string" && element.layer.length > 0) {
    patch.layer = element.layer;
  }
  if (element.motion && typeof element.motion === "object") {
    patch.motion = clone(element.motion);
  }
  return patch;
}

// Exported helper used by run_spike.collectAutoFadePatches so the fade
// duration is type-aware: images get a long dissolve (8 s), everything
// else gets the short default. Keeping the resolution here (rather than
// inlined in run_spike) means a future type addition only touches the
// scene_state + emitter pair.
export function autoFadeDurationForElement(element, fallbackMs = DEFAULT_FADE_DURATION_MS) {
  const typed = resolveAutoFadeDurationMs(element);
  return typeof typed === "number" && Number.isFinite(typed) ? typed : fallbackMs;
}

function invalidSvgPlaceholder(reason, label) {
  const safeLabel = String(label ?? "invalid svg").replace(/[<&>"]/g, "");
  const safeReason = String(reason ?? "invalid svg").replace(/[<&>"]/g, "");
  return (
    `<svg viewBox="0 0 1000 220" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="0" y="0" width="1000" height="220" rx="24" fill="#140d0d" stroke="#d59c6a" stroke-width="4"/>` +
      `<text x="40" y="92" fill="#f2d2b5" font-size="42" font-family="Georgia, serif">${safeLabel}</text>` +
      `<text x="40" y="148" fill="#d59c6a" font-size="24" font-family="monospace">renderer fallback: ${safeReason}</text>` +
    `</svg>`
  );
}

async function emitAddImagePatch({ state, result, fetchImageImpl }) {
  const element = findElement(state, result.element_id);
  if (!element) return [];

  return [await createElementAddPatch(element, { fetchImageImpl })];
}

async function imageContentOverrides(element, fetchImageImpl) {
  const imageResult = await fetchImageImpl(element.content.query);
  let browser_url = null;
  let image_error = null;
  let attribution = null;
  if (imageResult?.path) {
    browser_url = `/image_cache/${basename(imageResult.path)}`;
    attribution = imageResult.attribution ?? null;
  } else {
    image_error = imageResult?.error ?? "image fetch failed";
  }

  return { browser_url, image_error, attribution };
}

async function createElementAddPatch(element, { fetchImageImpl }) {
  if (element.type === "image") {
    const overrides = await imageContentOverrides(element, fetchImageImpl);
    return {
      type: "element.add",
      element: normalizeElementForPatch(element, overrides),
    };
  }
  if (element.type === "svg") {
    const svg_markup = isSvgMarkupValid(element.content?.svg_markup)
      ? element.content.svg_markup
      : invalidSvgPlaceholder("invalid svg_markup", element.content?.semantic_label);
    return {
      type: "element.add",
      element: normalizeElementForPatch(element, { svg_markup }),
    };
  }
  return { type: "element.add", element: normalizeElementForPatch(element) };
}

export async function emitPatchesForToolResult({
  state,
  toolUseBlock,
  result,
  fetchImageImpl = fetchImage,
}) {
  if (!result || typeof result !== "object" || result.error) return [];

  switch (toolUseBlock?.name) {
    case "addText": {
      const element = findElement(state, result.element_id);
      return element ? [{ type: "element.add", element: normalizeElementForPatch(element) }] : [];
    }
    case "addSVG": {
      const element = findElement(state, result.element_id);
      return element ? [await createElementAddPatch(element, { fetchImageImpl })] : [];
    }
    case "addImage":
      return emitAddImagePatch({ state, result, fetchImageImpl });
    case "setBackground": {
      const sanitized = sanitizeCssBackground(state?.background?.css_background ?? toolUseBlock?.input?.css_background);
      return [{
        type: "background.set",
        css_background: sanitized.value,
        fallback_reason: sanitized.reason ?? null,
        original_css_background: toolUseBlock?.input?.css_background ?? null,
      }];
    }
    case "fadeElement": {
      const targetId = toolUseBlock?.input?.element_id;
      if (typeof targetId !== "string") return [];
      if (targetId.startsWith("group_")) {
        return [{
          type: "composition_group.fade",
          group_id: targetId,
          member_ids: result.faded_element_ids ?? [],
          duration_ms: DEFAULT_FADE_DURATION_MS,
        }];
      }
      return [{ type: "element.fade", element_id: targetId, duration_ms: DEFAULT_FADE_DURATION_MS }];
    }
    case "setP5Background": {
      if (!result?.sketch_id || !state?.p5_background) return [];
      const patches = [];
      if (result.retired_id) {
        patches.push({ type: "sketch.retire", sketch_id: result.retired_id });
      }
      patches.push({
        type: "sketch.background.set",
        sketch_id: state.p5_background.sketch_id,
        code: state.p5_background.code,
        audio_reactive: Boolean(state.p5_background.audio_reactive),
      });
      return patches;
    }
    case "addP5Sketch": {
      if (!result?.sketch_id) return [];
      const sketch = (state?.p5_sketches ?? []).find((s) => s.sketch_id === result.sketch_id);
      if (!sketch) return [];
      const patches = [];
      if (result.retired_id) {
        patches.push({ type: "sketch.retire", sketch_id: result.retired_id });
      }
      const addPatch = {
        type: "sketch.add",
        sketch_id: sketch.sketch_id,
        position: sketch.position,
        size: sketch.size,
        code: sketch.code,
        audio_reactive: Boolean(sketch.audio_reactive),
        lifetime_s: sketch.lifetime_s ?? null,
      };
      // v6.2: forward layer when the slot carries one. Absent layer
      // keeps the wire shape stable with pre-v6.2 patches.
      if (typeof sketch.layer === "string" && sketch.layer.length > 0) {
        addPatch.layer = sketch.layer;
      }
      patches.push(addPatch);
      return patches;
    }
    // ─── Recompose tool emissions (expanded-tools) ────────────────
    // Each tool's handler validated inputs and returned an echo of the
    // accepted parameters; we translate that echo into the matching
    // patch. Patches are transient (patch_cache treats them as
    // no-ops). morphElement also wrote the new content into
    // scene_state.elements via its handler — that's how subsequent
    // scene summaries see the morphed state.
    case "transformElement":
      return [{
        type: "element.transform",
        element_id: result.element_id,
        transform: result.transform,
        duration_ms: result.duration_ms,
      }];
    case "morphElement":
      return [{
        type: "element.morph",
        element_id: result.element_id,
        to: result.to,
        duration_ms: result.duration_ms,
      }];
    case "pulseScene": {
      const patch = {
        type: "scene.pulse",
        intensity: result.intensity,
        duration_ms: result.duration_ms,
      };
      if (result.color) patch.color = result.color;
      return [patch];
    }
    case "paletteShift":
      return [{
        type: "scene.palette_shift",
        target: result.target,
        duration_ms: result.duration_ms,
      }];
    case "textAnimate":
      return [{
        type: "text.animate",
        element_id: result.element_id,
        effect: result.effect,
        duration_ms: result.duration_ms,
      }];
    case "addCompositeScene": {
      const element_ids = Array.isArray(result.element_ids) ? result.element_ids : [];
      const groupId = result.composition_group_id;
      const elements = element_ids
        .map((elementId) => findElement(state, elementId))
        .filter(Boolean);
      const elementPatches = [];
      for (const element of elements) {
        elementPatches.push(await createElementAddPatch(element, { fetchImageImpl }));
      }
      const group = groupId ? findGroup(state, groupId) : null;
      const groupPatch = group
        ? [{
            type: "composition_group.add",
            group: {
              group_id: group.group_id,
              group_label: group.group_label,
              member_element_ids: [...element_ids],
              lifetime_s:
                element_ids
                  .map((elementId) => findElement(state, elementId)?.lifetime_s)
                  .find((value) => value !== undefined) ?? null,
            },
          }]
        : [];
      return [...elementPatches, ...groupPatch];
    }
    default:
      return [];
  }
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const {
    createInitialState,
    beginCycle,
    addElement,
    setBackground,
    addCompositionGroup,
    fadeElement,
  } = await import("./scene_state.mjs");

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

  function freshState() {
    const state = createInitialState();
    beginCycle(state, { cycleIndex: 0, elapsedTotalS: 5 });
    return state;
  }

  await t("addText emits element.add", async () => {
    const state = freshState();
    const element_id = addElement(state, {
      type: "text",
      content: { content: "after", position: "lower-left", style: "serif, large" },
      lifetime_s: null,
    });
    const block = { name: "addText", input: { content: "after", position: "lower-left", style: "serif, large" } };
    const result = { element_id };
    const patches = await emitPatchesForToolResult({ state, toolUseBlock: block, result });
    assert.equal(patches[0].type, "element.add");
    assert.equal(patches[0].element.element_id, element_id);
  });

  await t("setBackground emits sanitized background.set", async () => {
    const state = freshState();
    const block = { name: "setBackground", input: { css_background: "javascript:alert(1)" } };
    setBackground(state, { css_background: "javascript:alert(1)" });
    const result = { ok: true };
    const patches = await emitPatchesForToolResult({ state, toolUseBlock: block, result });
    assert.equal(patches[0].type, "background.set");
    assert.equal(patches[0].css_background, "#0a0a0d");
  });

  await t("fadeElement on group emits composition_group.fade", async () => {
    const state = freshState();
    const groupId = addCompositionGroup(state, { group_label: "threshold arrival" });
    const firstId = addElement(state, {
      type: "text",
      content: { content: "after", position: "lower-left", style: "", composition_group_id: groupId },
      lifetime_s: null,
    });
    const secondId = addElement(state, {
      type: "image",
      content: { query: "threshold light", position: "background", composition_group_id: groupId },
      lifetime_s: null,
    });
    const fade = { name: "fadeElement", input: { element_id: groupId } };
    const fadeResult = fadeElement(state, groupId);
    const patches = await emitPatchesForToolResult({ state, toolUseBlock: fade, result: fadeResult });
    assert.equal(patches[0].type, "composition_group.fade");
    assert.equal(patches[0].member_ids.length, 2);
    assert.deepEqual(patches[0].member_ids, [firstId, secondId]);
  });

  await t("addCompositeScene emits member element.add patches and group patch", async () => {
    const state = freshState();
    const groupId = addCompositionGroup(state, { group_label: "threshold arrival" });
    const firstId = addElement(state, {
      type: "text",
      content: { content: "after", position: "lower-left", style: "", composition_group_id: groupId },
      lifetime_s: null,
    });
    const secondId = addElement(state, {
      type: "svg",
      content: {
        svg_markup: "<svg></svg>",
        position: "center",
        semantic_label: "band",
        composition_group_id: groupId,
      },
      lifetime_s: 35,
    });
    const block = { name: "addCompositeScene", input: { group_label: "threshold arrival" } };
    const result = { composition_group_id: groupId, element_ids: [firstId, secondId] };
    const patches = await emitPatchesForToolResult({ state, toolUseBlock: block, result });
    assert.equal(patches.filter((patch) => patch.type === "element.add").length, 2);
    assert.equal(patches.find((patch) => patch.type === "composition_group.add").group.group_id, groupId);
  });

  await t("addCompositeScene image members fetch and carry browser_url", async () => {
    const state = freshState();
    const groupId = addCompositionGroup(state, { group_label: "threshold arrival" });
    const imageId = addElement(state, {
      type: "image",
      content: { query: "threshold light", position: "background", composition_group_id: groupId },
      lifetime_s: null,
    });
    const textId = addElement(state, {
      type: "text",
      content: { content: "after", position: "lower-left", style: "", composition_group_id: groupId },
      lifetime_s: null,
    });
    const block = { name: "addCompositeScene", input: { group_label: "threshold arrival" } };
    const result = { composition_group_id: groupId, element_ids: [imageId, textId] };
    const patches = await emitPatchesForToolResult({
      state,
      toolUseBlock: block,
      result,
      fetchImageImpl: async () => ({
        path: "/tmp/image_cache/composite123.jpg",
        attribution: { photographer_name: "A", photographer_url: "u", photo_url: "p" },
        cached: true,
      }),
    });
    const imagePatch = patches.find((patch) => patch.element?.element_id === imageId);
    assert.equal(imagePatch.element.content.browser_url, "/image_cache/composite123.jpg");
    assert.equal(imagePatch.element.content.image_error, null);
    assert.equal(imagePatch.element.content.attribution.photographer_name, "A");
  });

  await t("element.add patch carries reactivity when the stored element has it", async () => {
    const state = freshState();
    const reactivity = [
      { property: "opacity", feature: "amplitude", map: { in: [0, 1], out: [0.5, 1], curve: "linear" } },
    ];
    const element_id = addElement(state, {
      type: "text",
      content: { content: "pulse", position: "center", style: "serif" },
      lifetime_s: null,
      reactivity,
    });
    const block = { name: "addText", input: { content: "pulse", position: "center", style: "serif" } };
    const patches = await emitPatchesForToolResult({ state, toolUseBlock: block, result: { element_id } });
    assert.equal(patches[0].type, "element.add");
    assert.deepEqual(patches[0].element.reactivity, reactivity);
    // Non-reactive elements still don't carry the key:
    const plainId = addElement(state, {
      type: "text",
      content: { content: "plain", position: "center", style: "serif" },
      lifetime_s: null,
    });
    const plainPatches = await emitPatchesForToolResult({
      state,
      toolUseBlock: { name: "addText", input: { content: "plain", position: "center", style: "serif" } },
      result: { element_id: plainId },
    });
    assert.equal("reactivity" in plainPatches[0].element, false);
  });

  await t("setP5Background emits sketch.background.set; adds sketch.retire before it when replacing", async () => {
    const { setP5Background } = await import("./scene_state.mjs");
    const state = freshState();
    // First set — no prior background, one patch.
    const r1 = setP5Background(state, { code: "FIRST_CODE", audio_reactive: true });
    const patches1 = await emitPatchesForToolResult({
      state,
      toolUseBlock: { name: "setP5Background", input: { code: "FIRST_CODE", audio_reactive: true } },
      result: r1,
    });
    assert.equal(patches1.length, 1);
    assert.equal(patches1[0].type, "sketch.background.set");
    // Fix 6: the emitted patch carries the server-minted sketch_id.
    assert.equal(patches1[0].sketch_id, r1.sketch_id);
    assert.equal(patches1[0].code, "FIRST_CODE");
    assert.equal(patches1[0].audio_reactive, true);
    // Second set — prior id retires first, then new background set.
    const r2 = setP5Background(state, { code: "SECOND_CODE", audio_reactive: false });
    const patches2 = await emitPatchesForToolResult({
      state,
      toolUseBlock: { name: "setP5Background", input: { code: "SECOND_CODE", audio_reactive: false } },
      result: r2,
    });
    assert.equal(patches2.length, 2);
    assert.equal(patches2[0].type, "sketch.retire");
    assert.equal(patches2[0].sketch_id, r1.sketch_id);
    assert.equal(patches2[1].type, "sketch.background.set");
    assert.equal(patches2[1].sketch_id, r2.sketch_id);
    assert.equal(patches2[1].code, "SECOND_CODE");
  });

  await t("addP5Sketch emits sketch.add; adds sketch.retire before it on overflow", async () => {
    const { addP5SketchSlot } = await import("./scene_state.mjs");
    const state = freshState();
    // Three sketches without overflow.
    const a = addP5SketchSlot(state, { position: "top-left", size: "small", code: "A", audio_reactive: true });
    const b = addP5SketchSlot(state, { position: "center", size: "medium", code: "B", audio_reactive: false });
    const c = addP5SketchSlot(state, { position: "bottom-right", size: "large", code: "C", audio_reactive: true });
    const patchesC = await emitPatchesForToolResult({
      state,
      toolUseBlock: { name: "addP5Sketch", input: { position: "bottom-right", size: "large", code: "C", audio_reactive: true } },
      result: c,
    });
    assert.equal(patchesC.length, 1);
    assert.equal(patchesC[0].type, "sketch.add");
    assert.equal(patchesC[0].sketch_id, c.sketch_id);
    assert.equal(patchesC[0].code, "C");
    assert.equal(patchesC[0].position, "bottom-right");
    assert.equal(patchesC[0].size, "large");
    // Fourth sketch — evicts oldest (a). Patch stream: retire(a) then add(d).
    const d = addP5SketchSlot(state, { position: "mid-left", size: "small", code: "D", audio_reactive: false });
    assert.equal(d.retired_id, a.sketch_id);
    const patchesD = await emitPatchesForToolResult({
      state,
      toolUseBlock: { name: "addP5Sketch", input: { position: "mid-left", size: "small", code: "D", audio_reactive: false } },
      result: d,
    });
    assert.equal(patchesD.length, 2);
    assert.equal(patchesD[0].type, "sketch.retire");
    assert.equal(patchesD[0].sketch_id, a.sketch_id);
    assert.equal(patchesD[1].type, "sketch.add");
    assert.equal(patchesD[1].sketch_id, d.sketch_id);
    // Defensive silence-of-b assertion so the test surface reads the
    // eviction intent clearly.
    assert.equal(b.retired_id, null);
  });

  await t("element.add patch carries layer + motion when the element has them", async () => {
    const state = freshState();
    const reactivity = [
      { property: "opacity", feature: "amplitude", map: { in: [0, 1], out: [0.5, 1], curve: "linear" } },
    ];
    const element_id = addElement(state, {
      type: "image",
      content: { query: "lamp glow", position: "background" },
      reactivity,
      layer: "midground",
      motion: { preset: "breathe", intensity: 0.8 },
    });
    const patches = await emitPatchesForToolResult({
      state,
      toolUseBlock: { name: "addImage", input: { query: "lamp glow", position: "background" } },
      result: { element_id },
      fetchImageImpl: async () => ({ path: "/tmp/image_cache/abc.jpg", attribution: null }),
    });
    assert.equal(patches[0].element.layer, "midground");
    assert.deepEqual(patches[0].element.motion, { preset: "breathe", intensity: 0.8 });
    // Byte-stability: non-layered element carries no layer key.
    const plainId = addElement(state, {
      type: "text",
      content: { content: "plain", position: "c", style: "s" },
      lifetime_s: null,
    });
    const plainPatches = await emitPatchesForToolResult({
      state,
      toolUseBlock: { name: "addText", input: { content: "plain", position: "c", style: "s" } },
      result: { element_id: plainId },
    });
    assert.equal("layer" in plainPatches[0].element, false);
    assert.equal("motion" in plainPatches[0].element, false);
  });

  await t("autoFadeDurationForElement returns IMAGE_AUTO_FADE_DURATION_MS for image, fallback otherwise", async () => {
    assert.equal(autoFadeDurationForElement({ type: "image" }), IMAGE_AUTO_FADE_DURATION_MS);
    assert.equal(autoFadeDurationForElement({ type: "text" }), 400);
    // Custom fallback is honored for non-image:
    assert.equal(autoFadeDurationForElement({ type: "svg" }, 600), 600);
  });

  await t("sketch.add patch carries layer when the sketch slot has one", async () => {
    const { addP5SketchSlot } = await import("./scene_state.mjs");
    const state = freshState();
    const result = addP5SketchSlot(state, {
      position: "center", size: "medium", code: "noop()", audio_reactive: false,
      layer: "midground",
    });
    const patches = await emitPatchesForToolResult({
      state,
      toolUseBlock: { name: "addP5Sketch", input: { position: "center", size: "medium", code: "", audio_reactive: false } },
      result,
    });
    const addPatch = patches.find((p) => p.type === "sketch.add");
    assert.equal(addPatch.layer, "midground");
    // Without layer, the patch stays shape-stable (no key):
    const result2 = addP5SketchSlot(state, {
      position: "bottom-right", size: "small", code: "", audio_reactive: false,
    });
    const patches2 = await emitPatchesForToolResult({
      state,
      toolUseBlock: { name: "addP5Sketch", input: { position: "bottom-right", size: "small", code: "", audio_reactive: false } },
      result: result2,
    });
    const addPatch2 = patches2.find((p) => p.type === "sketch.add");
    assert.equal("layer" in addPatch2, false);
  });

  await t("addImage emits browser_url when fetch succeeds", async () => {
    const state = freshState();
    const element_id = addElement(state, {
      type: "image",
      content: { query: "threshold light", position: "background" },
      lifetime_s: null,
    });
    const block = { name: "addImage", input: { query: "threshold light", position: "background" } };
    const result = { element_id };
    const patches = await emitPatchesForToolResult({
      state,
      toolUseBlock: block,
      result,
      fetchImageImpl: async () => ({
        path: "/tmp/image_cache/abc123.jpg",
        attribution: { photographer_name: "A", photographer_url: "u", photo_url: "p" },
        cached: true,
      }),
    });
    assert.equal(patches[0].element.content.browser_url, "/image_cache/abc123.jpg");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
