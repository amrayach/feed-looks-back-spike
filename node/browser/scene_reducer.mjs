const { PatchSchema } = await import(
  import.meta.url.startsWith("file:")
    ? "../src/patch_protocol.mjs"
    : "/shared/patch_protocol.mjs"
);

function createStyle(initial = "") {
  return { cssText: initial };
}

function classifyPosition(position) {
  if (!position) return "center-center";
  const p = String(position).toLowerCase();
  if (/background/.test(p)) return "background";
  if (/full[- ]?(screen|canvas)|fullscreen/.test(p)) return "fullscreen";
  if (/(horizontal[- ]?band.*upper|upper.*horizontal[- ]?band)/.test(p)) return "horizontal-band-upper";
  if (/(horizontal[- ]?band.*lower|lower.*horizontal[- ]?band)/.test(p)) return "horizontal-band-lower";
  if (/horizontal[- ]?band|horizontal[- ]?line|wide[- ]?strip/.test(p)) return "horizontal-band-middle";
  if (/(vertical[- ]?column.*left|left.*vertical[- ]?column)/.test(p)) return "vertical-column-left";
  if (/(vertical[- ]?column.*right|right.*vertical[- ]?column)/.test(p)) return "vertical-column-right";
  if (/vertical[- ]?band|vertical[- ]?line/.test(p)) return "vertical-band-center";
  if (/(two[- ]?column[- ]?span.*upper|upper.*two[- ]?column[- ]?span)/.test(p)) return "two-column-span-upper";
  if (/(two[- ]?column[- ]?span.*lower|lower.*two[- ]?column[- ]?span)/.test(p)) return "two-column-span-lower";
  if (/(two[- ]?column[- ]?span.*left|left.*two[- ]?column[- ]?span)/.test(p)) return "two-column-span-left";
  if (/(two[- ]?column[- ]?span.*right|right.*two[- ]?column[- ]?span)/.test(p)) return "two-column-span-right";
  const isUpper = /upper|top/.test(p);
  const isLower = /lower|bottom/.test(p);
  const isLeft = /left/.test(p);
  const isRight = /right/.test(p);
  const vert = isUpper ? "upper" : isLower ? "lower" : "center";
  const horiz = isLeft ? "left" : isRight ? "right" : "center";
  return `${vert}-${horiz}`;
}

const TEXT_ANCHOR_CSS = {
  "upper-left": "top: 8%; left: 8%;",
  "upper-center": "top: 8%; left: 50%; transform: translateX(-50%);",
  "upper-right": "top: 8%; right: 8%;",
  "center-left": "top: 50%; left: 8%; transform: translateY(-50%);",
  "center-center": "top: 50%; left: 50%; transform: translate(-50%, -50%);",
  "center-right": "top: 50%; right: 8%; transform: translateY(-50%);",
  "lower-left": "bottom: 8%; left: 8%;",
  "lower-center": "bottom: 8%; left: 50%; transform: translateX(-50%);",
  "lower-right": "bottom: 8%; right: 8%;",
  background: "top: 50%; left: 50%; transform: translate(-50%, -50%);",
  fullscreen: "top: 50%; left: 50%; transform: translate(-50%, -50%);",
  "horizontal-band-upper": "top: 18%; left: 50%; transform: translate(-50%, -50%); text-align: center;",
  "horizontal-band-middle": "top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center;",
  "horizontal-band-lower": "top: 82%; left: 50%; transform: translate(-50%, -50%); text-align: center;",
  "vertical-column-left": "top: 50%; left: 18%; transform: translate(-50%, -50%);",
  "vertical-column-right": "top: 50%; left: 82%; transform: translate(-50%, -50%);",
  "vertical-band-center": "top: 50%; left: 50%; transform: translate(-50%, -50%);",
  "two-column-span-upper": "top: 18%; left: 50%; transform: translate(-50%, -50%); text-align: center;",
  "two-column-span-lower": "top: 82%; left: 50%; transform: translate(-50%, -50%); text-align: center;",
  "two-column-span-left": "top: 50%; left: 18%; transform: translate(-50%, -50%);",
  "two-column-span-right": "top: 50%; left: 82%; transform: translate(-50%, -50%);",
};

const RECT_CSS = {
  "upper-left": "left: 0%; top: 0%; width: 46%; height: 46%;",
  "upper-center": "left: 27%; top: 0%; width: 46%; height: 46%;",
  "upper-right": "right: 0%; top: 0%; width: 46%; height: 46%;",
  "center-left": "left: 0%; top: 27%; width: 46%; height: 46%;",
  "center-center": "left: 27%; top: 27%; width: 46%; height: 46%;",
  "center-right": "right: 0%; top: 27%; width: 46%; height: 46%;",
  "lower-left": "left: 0%; bottom: 0%; width: 46%; height: 46%;",
  "lower-center": "left: 27%; bottom: 0%; width: 46%; height: 46%;",
  "lower-right": "right: 0%; bottom: 0%; width: 46%; height: 46%;",
  background: "inset: 0;",
  fullscreen: "inset: 0;",
  "horizontal-band-upper": "left: 0; top: 0; width: 100%; height: 38%;",
  "horizontal-band-middle": "left: 0; top: 31%; width: 100%; height: 38%;",
  "horizontal-band-lower": "left: 0; bottom: 0; width: 100%; height: 38%;",
  "vertical-column-left": "left: 0; top: 0; width: 38%; height: 100%;",
  "vertical-column-right": "right: 0; top: 0; width: 38%; height: 100%;",
  "vertical-band-center": "left: 31%; top: 0; width: 38%; height: 100%;",
  "two-column-span-upper": "left: 10%; top: 0; width: 80%; height: 38%;",
  "two-column-span-lower": "left: 10%; bottom: 0; width: 80%; height: 38%;",
  "two-column-span-left": "left: 0; top: 29%; width: 80%; height: 42%;",
  "two-column-span-right": "left: 20%; top: 29%; width: 80%; height: 42%;",
};

function imageSizeClass(position) {
  const p = String(position ?? "").toLowerCase();
  if (/\b(full[- ]?bleed|fullscreen|full[- ]?canvas|fill|entire|whole)\b/.test(p)) return "full";
  if (/\b(background|backdrop)\b/.test(p)) return "background";
  if (/\b(half|right[- ]?half|left[- ]?half|span)\b/.test(p)) return "half";
  if (/\b(large|big|occupying|wide)\b/.test(p)) return "large";
  if (/\b(small|thumbnail|tiny|inset)\b/.test(p)) return "small";
  if (/\b(medium|mid[- ]?size|mid[- ]?inset)\b/.test(p)) return "medium";
  return "medium";
}

const IMAGE_DIMENSIONS = Object.freeze({
  full: { width: "100%", height: "100%", border: "0", shadow: "none", z: 0 },
  background: {
    width: "72%",
    height: "86%",
    border: "1px solid rgba(138,126,106,0.35)",
    shadow: "0 20px 60px rgba(0,0,0,0.5)",
    z: 0,
  },
  half: {
    width: "52%",
    height: "78%",
    border: "1px solid rgba(138,126,106,0.45)",
    shadow: "0 18px 48px rgba(0,0,0,0.42)",
    z: 2,
  },
  large: {
    width: "44%",
    height: "62%",
    border: "1px solid rgba(138,126,106,0.5)",
    shadow: "0 16px 40px rgba(0,0,0,0.36)",
    z: 2,
  },
  medium: {
    width: "30%",
    height: "44%",
    border: "1px solid rgba(138,126,106,0.55)",
    shadow: "0 12px 28px rgba(0,0,0,0.28)",
    z: 2,
  },
  small: {
    width: "220px",
    height: "150px",
    border: "1px solid rgba(138,126,106,0.55)",
    shadow: "0 12px 28px rgba(0,0,0,0.28)",
    z: 2,
  },
});

function imageDimensions(position) {
  return IMAGE_DIMENSIONS[imageSizeClass(position)];
}

function textStyleCss(styleHint) {
  const s = String(styleHint ?? "").toLowerCase();
  const parts = [];
  if (/serif/.test(s)) parts.push("font-family: Georgia, 'Times New Roman', serif");
  else if (/mono/.test(s)) parts.push("font-family: monospace");
  else if (/sans/.test(s)) parts.push("font-family: sans-serif");
  else parts.push("font-family: Georgia, 'Times New Roman', serif");
  if (/italic/.test(s)) parts.push("font-style: italic");
  if (/bold/.test(s)) parts.push("font-weight: 700");
  else if (/light/.test(s)) parts.push("font-weight: 300");
  if (/huge|massive|display/.test(s)) parts.push("font-size: 5.2rem");
  else if (/large/.test(s)) parts.push("font-size: 3.8rem");
  else if (/small/.test(s)) parts.push("font-size: 1.6rem");
  else parts.push("font-size: 2.4rem");
  if (/tracking|spacing/.test(s)) parts.push("letter-spacing: 0.08em");
  parts.push("line-height: 1.15");
  parts.push("color: #f4e5d2");
  parts.push("text-shadow: 0 2px 12px rgba(0,0,0,0.35)");
  return parts.join("; ");
}

function scaleSvgMarkup(markup) {
  const text = String(markup ?? "");
  return text.replace(/^<svg\b([^>]*)>/i, (_match, attrs) => {
    let nextAttrs = attrs ?? "";
    if (/\bstyle\s*=/.test(nextAttrs)) {
      nextAttrs = nextAttrs.replace(
        /\bstyle\s*=\s*(['"])(.*?)\1/i,
        (_m, quote, styleValue) =>
          `style=${quote}${styleValue};display:block;width:100%;height:100%;${quote}`,
      );
    } else {
      nextAttrs += ` style="display:block;width:100%;height:100%;"`;
    }
    if (!/\bpreserveAspectRatio\s*=/.test(nextAttrs)) {
      nextAttrs += ` preserveAspectRatio="xMidYMid meet"`;
    }
    return `<svg${nextAttrs}>`;
  });
}

function applyReady(readyTarget, isReady) {
  if (!readyTarget?.setAttribute) return;
  if (isReady) readyTarget.setAttribute("data-stage-ready", "1");
  else readyTarget.removeAttribute("data-stage-ready");
}

function makeElementNode(documentLike, elementSpec) {
  const content = elementSpec.content ?? {};
  const position = classifyPosition(content.position);
  const node = documentLike.createElement("div");
  node.dataset.elementId = elementSpec.element_id;
  node.dataset.elementType = elementSpec.type;
  node.style = node.style ?? createStyle();
  node.style.cssText = [
    "position: absolute",
    "box-sizing: border-box",
    "transition: opacity 0.3s ease",
  ].join("; ");

  if (elementSpec.type === "text") {
    node.style.cssText += `; ${TEXT_ANCHOR_CSS[position] ?? TEXT_ANCHOR_CSS["center-center"]}; ${textStyleCss(content.style)}`;
    node.textContent = content.content ?? "";
    return node;
  }

  if (elementSpec.type === "image") {
    const dimensions = imageDimensions(content.position);
    node.style.cssText += `; ${TEXT_ANCHOR_CSS[position] ?? TEXT_ANCHOR_CSS["center-center"]}; overflow: hidden; border-radius: 24px; width: ${dimensions.width}; height: ${dimensions.height}; border: ${dimensions.border}; box-shadow: ${dimensions.shadow}; z-index: ${dimensions.z}; background: rgba(20,16,13,0.72);`;
    if (content.browser_url) {
      const img = documentLike.createElement("img");
      img.src = content.browser_url;
      img.alt = content.query ?? "image";
      img.style = img.style ?? createStyle();
      img.style.cssText = "display: block; width: 100%; height: 100%; object-fit: cover; filter: saturate(0.92) brightness(0.97);";
      node.appendChild(img);
      if (content.attribution?.photographer_name) {
        const credit = documentLike.createElement("div");
        credit.textContent = `Photo by ${content.attribution.photographer_name}`;
        credit.style = credit.style ?? createStyle();
        credit.style.cssText = "position: absolute; right: 8px; bottom: 6px; padding: 3px 6px; background: rgba(10,10,13,0.72); color: #f5f0e8; font: 0.68rem/1.2 Georgia, serif; border-radius: 2px; max-width: 78%; text-align: right;";
        node.appendChild(credit);
      }
    } else {
      node.textContent = content.query ?? content.image_error ?? "image";
      node.style.cssText += "; display: flex; align-items: center; justify-content: center; background: rgba(40,32,26,0.4); color: #d9cbb2; text-align: center; padding: 12px; font: 0.85rem/1.2 Georgia, serif;";
    }
    return node;
  }

  node.style.cssText += `; ${RECT_CSS[position] ?? RECT_CSS["center-center"]}; overflow: hidden;`;
  node.innerHTML = scaleSvgMarkup(content.svg_markup ?? "");
  return node;
}

export function createSceneReducer({
  documentLike = globalThis.document,
  mount,
  readyTarget = documentLike?.body ?? mount,
  setTimeoutImpl = globalThis.setTimeout,
} = {}) {
  if (!mount) throw new Error("mount is required");

  const root = mount;
  root.innerHTML = "";
  root.style = root.style ?? createStyle();
  root.style.cssText = [
    "position: relative",
    "width: 100vw",
    "height: 100vh",
    "overflow: hidden",
    "background: #0a0a0d",
  ].join("; ");

  const freeLayer = documentLike.createElement("div");
  freeLayer.dataset.layer = "free";
  freeLayer.style = freeLayer.style ?? createStyle();
  freeLayer.style.cssText = "position: absolute; inset: 0;";
  root.appendChild(freeLayer);

  const groupsLayer = documentLike.createElement("div");
  groupsLayer.dataset.layer = "groups";
  groupsLayer.style = groupsLayer.style ?? createStyle();
  groupsLayer.style.cssText = "position: absolute; inset: 0;";
  root.appendChild(groupsLayer);

  const nodes = new Map();
  const elementSpecs = new Map();
  const groupNodes = new Map();
  const groupSpecs = new Map();
  let replayState = "initial";

  function placeNode(elementSpec, node) {
    const groupId = elementSpec.composition_group_id;
    const groupNode = groupId ? groupNodes.get(groupId) : null;
    if (groupNode) groupNode.appendChild(node);
    else freeLayer.appendChild(node);
  }

  function upsertElement(elementSpec) {
    const existing = nodes.get(elementSpec.element_id);
    if (existing) existing.remove();
    const node = makeElementNode(documentLike, elementSpec);
    nodes.set(elementSpec.element_id, node);
    elementSpecs.set(elementSpec.element_id, elementSpec);
    placeNode(elementSpec, node);
  }

  function removeElement(elementId, durationMs = 0) {
    const node = nodes.get(elementId);
    if (!node) return;
    const removeNow = () => {
      node.remove();
      nodes.delete(elementId);
      elementSpecs.delete(elementId);
      for (const [groupId, spec] of groupSpecs.entries()) {
        const filtered = spec.member_element_ids.filter((id) => id !== elementId);
        if (filtered.length === 0) {
          groupNodes.get(groupId)?.remove();
          groupNodes.delete(groupId);
          groupSpecs.delete(groupId);
        } else if (filtered.length !== spec.member_element_ids.length) {
          groupSpecs.set(groupId, { ...spec, member_element_ids: filtered });
        }
      }
    };
    if (durationMs > 0) {
      node.style.cssText += "; opacity: 0;";
      if (typeof setTimeoutImpl === "function") setTimeoutImpl(removeNow, durationMs);
      else removeNow();
    } else {
      removeNow();
    }
  }

  function upsertGroup(group) {
    let groupNode = groupNodes.get(group.group_id);
    if (!groupNode) {
      groupNode = documentLike.createElement("div");
      groupNode.dataset.groupId = group.group_id;
      groupNode.style = groupNode.style ?? createStyle();
      groupNode.style.cssText = "position: absolute; inset: 0;";
      groupNodes.set(group.group_id, groupNode);
      groupsLayer.appendChild(groupNode);
    }
    groupSpecs.set(group.group_id, group);
    for (const memberId of group.member_element_ids) {
      const memberNode = nodes.get(memberId);
      if (memberNode) groupNode.appendChild(memberNode);
    }
  }

  function applyPatch(patch) {
    const parsed = PatchSchema.parse(patch);
    switch (parsed.type) {
      case "background.set":
        root.style.cssText = root.style.cssText.replace(/background:[^;]+;?/g, "");
        root.style.cssText += `; background: ${parsed.css_background};`;
        break;
      case "element.add":
        upsertElement(parsed.element);
        break;
      case "element.update": {
        const current = elementSpecs.get(parsed.element_id);
        if (!current) break;
        const next = {
          ...current,
          ...parsed.changes,
          content:
            parsed.changes.content && typeof parsed.changes.content === "object" && !Array.isArray(parsed.changes.content)
              ? { ...(current.content ?? {}), ...parsed.changes.content }
              : current.content,
        };
        upsertElement(next);
        break;
      }
      case "element.fade":
        removeElement(parsed.element_id, parsed.duration_ms);
        break;
      case "element.remove":
        removeElement(parsed.element_id, 0);
        break;
      case "composition_group.add":
        upsertGroup(parsed.group);
        break;
      case "composition_group.fade":
        for (const memberId of parsed.member_ids) removeElement(memberId, parsed.duration_ms);
        groupNodes.get(parsed.group_id)?.remove();
        groupNodes.delete(parsed.group_id);
        groupSpecs.delete(parsed.group_id);
        break;
      case "cycle.begin":
        applyReady(readyTarget, false);
        break;
      case "cycle.end":
        if (replayState === "synced") applyReady(readyTarget, true);
        break;
      case "replay.begin":
        replayState = "replaying";
        root.dataset.replayState = replayState;
        applyReady(readyTarget, false);
        break;
      case "replay.end":
        replayState = "synced";
        root.dataset.replayState = replayState;
        break;
      case "prompt.replace":
      case "sketch.background.set":
      case "sketch.add":
      case "sketch.retire":
        break;
    }
  }

  return {
    applyPatch,
    getState() {
      return {
        replayState,
        elementCount: nodes.size,
        groupCount: groupNodes.size,
      };
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import("node:assert/strict")).default;

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.dataset = {};
      this.attributes = new Map();
      this.style = createStyle();
      this.innerHTML = "";
      this.textContent = "";
    }
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child);
      child.parentNode = null;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
    removeAttribute(name) {
      this.attributes.delete(name);
    }
  }

  class FakeDocument {
    constructor() {
      this.body = new FakeElement("body");
    }
    createElement(tagName) {
      return new FakeElement(tagName);
    }
  }

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

  t("background.set updates stage background", () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const reducer = createSceneReducer({ documentLike, mount, readyTarget: documentLike.body, setTimeoutImpl: (fn) => fn() });
    reducer.applyPatch({ type: "background.set", css_background: "linear-gradient(180deg, #111, #000)" });
    assert.match(mount.style.cssText, /background: linear-gradient/);
  });

  t("element.add renders text and composition_group.add moves grouped members", () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const reducer = createSceneReducer({ documentLike, mount, readyTarget: documentLike.body, setTimeoutImpl: (fn) => fn() });
    reducer.applyPatch({
      type: "element.add",
      element: {
        element_id: "elem_0001",
        type: "text",
        content: { content: "after", position: "lower-left", style: "serif, large" },
        lifetime_s: null,
        composition_group_id: "group_0001",
      },
    });
    reducer.applyPatch({
      type: "composition_group.add",
      group: {
        group_id: "group_0001",
        group_label: "threshold arrival",
        member_element_ids: ["elem_0001"],
        lifetime_s: null,
      },
    });
    assert.equal(reducer.getState().groupCount, 1);
  });

  t("replay.begin and cycle boundaries manage data-stage-ready", () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const reducer = createSceneReducer({ documentLike, mount, readyTarget: documentLike.body, setTimeoutImpl: (fn) => fn() });
    reducer.applyPatch({ type: "replay.begin", run_id: "123" });
    assert.equal(documentLike.body.attributes.has("data-stage-ready"), false);
    reducer.applyPatch({ type: "replay.end", run_id: "123" });
    reducer.applyPatch({ type: "cycle.end" });
    assert.equal(documentLike.body.attributes.get("data-stage-ready"), "1");
    reducer.applyPatch({ type: "cycle.begin", cycle_n: 1, hijaz_state: {} });
    assert.equal(documentLike.body.attributes.has("data-stage-ready"), false);
  });

  t("element.fade removes the node", () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const reducer = createSceneReducer({ documentLike, mount, readyTarget: documentLike.body, setTimeoutImpl: (fn) => fn() });
    reducer.applyPatch({
      type: "element.add",
      element: {
        element_id: "elem_0001",
        type: "image",
        content: { query: "threshold light", position: "background", browser_url: null },
        lifetime_s: null,
        composition_group_id: null,
      },
    });
    reducer.applyPatch({ type: "element.fade", element_id: "elem_0001", duration_ms: 1 });
    assert.equal(reducer.getState().elementCount, 0);
  });

  t("two-column span positions match the renderer layout vocabulary", () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const reducer = createSceneReducer({ documentLike, mount, readyTarget: documentLike.body, setTimeoutImpl: (fn) => fn() });
    reducer.applyPatch({
      type: "element.add",
      element: {
        element_id: "elem_0009",
        type: "text",
        content: { content: "after", position: "two-column-span-left", style: "serif, large" },
        lifetime_s: null,
        composition_group_id: null,
      },
    });
    const freeLayer = mount.children[0];
    const textNode = freeLayer.children[0];
    assert.match(textNode.style.cssText, /left: 18%/);
  });

  t("background images use the renderer-sized inset treatment instead of fullscreen", () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const reducer = createSceneReducer({ documentLike, mount, readyTarget: documentLike.body, setTimeoutImpl: (fn) => fn() });
    reducer.applyPatch({
      type: "element.add",
      element: {
        element_id: "elem_0010",
        type: "image",
        content: { query: "threshold light", position: "background", browser_url: null },
        lifetime_s: null,
        composition_group_id: null,
      },
    });
    const freeLayer = mount.children[0];
    const imageNode = freeLayer.children[0];
    assert.match(imageNode.style.cssText, /width: 72%/);
    assert.match(imageNode.style.cssText, /height: 86%/);
  });

  t("svg markup is scaled to fill the positioned slot", () => {
    const documentLike = new FakeDocument();
    const mount = documentLike.createElement("div");
    const reducer = createSceneReducer({ documentLike, mount, readyTarget: documentLike.body, setTimeoutImpl: (fn) => fn() });
    reducer.applyPatch({
      type: "element.add",
      element: {
        element_id: "elem_0011",
        type: "svg",
        content: {
          svg_markup: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>',
          position: "center",
          semantic_label: "circle",
        },
        lifetime_s: 35,
        composition_group_id: null,
      },
    });
    const freeLayer = mount.children[0];
    const svgNode = freeLayer.children[0];
    assert.match(svgNode.innerHTML, /width:100%;height:100%/);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
