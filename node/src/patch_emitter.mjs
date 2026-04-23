import { basename } from "node:path";

import { fetchImage } from "./image_fetch.mjs";
import { sanitizeCssBackground, isSvgMarkupValid } from "./render_html.mjs";

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
  return {
    element_id: element.element_id,
    type: element.type,
    content: contentOverrides ? { ...clone(element.content), ...contentOverrides } : clone(element.content),
    lifetime_s: element.lifetime_s ?? null,
    composition_group_id: element.content?.composition_group_id ?? null,
  };
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

  return [{
    type: "element.add",
    element: normalizeElementForPatch(element, { browser_url, image_error, attribution }),
  }];
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
      if (!element) return [];
      const svg_markup = isSvgMarkupValid(element.content?.svg_markup)
        ? element.content.svg_markup
        : invalidSvgPlaceholder("invalid svg_markup", element.content?.semantic_label);
      return [{
        type: "element.add",
        element: normalizeElementForPatch(element, { svg_markup }),
      }];
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
    case "addCompositeScene": {
      const element_ids = Array.isArray(result.element_ids) ? result.element_ids : [];
      const groupId = result.composition_group_id;
      const elementPatches = element_ids
        .map((elementId) => findElement(state, elementId))
        .filter(Boolean)
        .map((element) => ({ type: "element.add", element: normalizeElementForPatch(element) }));
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
