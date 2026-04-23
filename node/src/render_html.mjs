import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { computeOverview, formatOverviewBlock } from "./scene_state.mjs";
import { fetchImage } from "./image_fetch.mjs";

// ============================================================================
// CONSTANTS
// ============================================================================

// Aging opacity is used for graceful exit, not persistent dimming. Permanent
// elements (lifetime_s === null, text/image default) always render at 1.0.
// Timed elements render at 1.0 until they enter the auto-fade grace window
// (within AUTO_FADE_OVERLAP_S of their fades_at_elapsed_s), at which point
// they drop to fadingOpacity to signal that Opus has seen them one last time.
// Once faded=true, render_html filters them out entirely.
export const AGING_OPACITY = Object.freeze({
  normal: 1.0,
  fading: 0.55,
});
// How many seconds before fades_at_elapsed_s the element starts visually
// easing out. Matches scene_state.AUTO_FADE_OVERLAP_S semantics: Opus sees
// "fading next cycle" and the renderer dims that same cycle.
export const FADING_GRACE_S = 5;

export const SCENE_VIEWBOX_W = 1000;
export const SCENE_VIEWBOX_H = 1000;
export const LIVE_MONITOR_REFRESH_SECONDS = 2;

// ============================================================================
// ESCAPING
// ============================================================================

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function elementContent(el) {
  return safeObject(el?.content);
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function textOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

// ============================================================================
// POSITION MAPPING
// ============================================================================

// nine-anchor grid plus named span/full-canvas specials. Opus emits free-form
// position strings; we classify them by keyword rather than require a fixed
// vocabulary. unknown strings fall through to center-center, which is visually
// safe.
export function classifyPosition(position) {
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
  "upper-left":    "top: 8%; left: 8%;",
  "upper-center":  "top: 8%; left: 50%; transform: translateX(-50%);",
  "upper-right":   "top: 8%; right: 8%;",
  "center-left":   "top: 50%; left: 8%; transform: translateY(-50%);",
  "center-center": "top: 50%; left: 50%; transform: translate(-50%, -50%);",
  "center-right":  "top: 50%; right: 8%; transform: translateY(-50%);",
  "lower-left":    "bottom: 8%; left: 8%;",
  "lower-center":  "bottom: 8%; left: 50%; transform: translateX(-50%);",
  "lower-right":   "bottom: 8%; right: 8%;",
  "background":    "top: 50%; left: 50%; transform: translate(-50%, -50%);",
  "fullscreen":    "top: 50%; left: 50%; transform: translate(-50%, -50%);",
  "horizontal-band-upper":  "top: 18%; left: 50%; transform: translate(-50%, -50%); text-align: center;",
  "horizontal-band-middle": "top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center;",
  "horizontal-band-lower":  "top: 82%; left: 50%; transform: translate(-50%, -50%); text-align: center;",
  "vertical-column-left":   "top: 50%; left: 18%; transform: translate(-50%, -50%);",
  "vertical-column-right":  "top: 50%; left: 82%; transform: translate(-50%, -50%);",
  "vertical-band-center":   "top: 50%; left: 50%; transform: translate(-50%, -50%);",
  "two-column-span-upper":  "top: 18%; left: 50%; transform: translate(-50%, -50%); text-align: center;",
  "two-column-span-lower":  "top: 82%; left: 50%; transform: translate(-50%, -50%); text-align: center;",
  "two-column-span-left":   "top: 50%; left: 18%; transform: translate(-50%, -50%);",
  "two-column-span-right":  "top: 50%; left: 82%; transform: translate(-50%, -50%);",
};

// Rectangles in the outer <svg viewBox="0 0 1000 1000"> canvas. Previous
// single-anchor slots were 250×250 inside a 1000×1000 canvas — 1/16th of
// canvas area — which pinched everything Opus authored into a thumbnail.
// These slots are now 420×420 with deliberate overlap, so "upper-left" and
// "center-center" share ~60 canvas units of common territory. Overlap is
// compositionally accurate: a form placed upper-left can touch the center;
// a form in the center can bleed outward. The band/column/fullscreen
// specials keep their existing large footprints.
const SVG_ANCHOR_RECT = {
  "upper-left":    { x: 0,   y: 0,   w: 460, h: 460 },
  "upper-center":  { x: 290, y: 0,   w: 460, h: 460 },
  "upper-right":   { x: 540, y: 0,   w: 460, h: 460 },
  "center-left":   { x: 0,   y: 290, w: 460, h: 460 },
  "center-center": { x: 270, y: 270, w: 460, h: 460 },
  "center-right":  { x: 540, y: 290, w: 460, h: 460 },
  "lower-left":    { x: 0,   y: 540, w: 460, h: 460 },
  "lower-center":  { x: 290, y: 540, w: 460, h: 460 },
  "lower-right":   { x: 540, y: 540, w: 460, h: 460 },
  "background":    { x: 0,   y: 0,   w: 1000, h: 1000 },
  "fullscreen":    { x: 0,   y: 0,   w: 1000, h: 1000 },
  "horizontal-band-upper":  { x: 0,   y: 0,   w: 1000, h: 380 },
  "horizontal-band-middle": { x: 0,   y: 310, w: 1000, h: 380 },
  "horizontal-band-lower":  { x: 0,   y: 620, w: 1000, h: 380 },
  "vertical-column-left":   { x: 0,   y: 0,   w: 380, h: 1000 },
  "vertical-column-right":  { x: 620, y: 0,   w: 380, h: 1000 },
  "vertical-band-center":   { x: 310, y: 0,   w: 380, h: 1000 },
  "two-column-span-upper":  { x: 100, y: 0,   w: 800, h: 380 },
  "two-column-span-lower":  { x: 100, y: 620, w: 800, h: 380 },
  "two-column-span-left":   { x: 0,   y: 290, w: 800, h: 420 },
  "two-column-span-right":  { x: 200, y: 290, w: 800, h: 420 },
};

function textAnchorCss(anchor) {
  return TEXT_ANCHOR_CSS[anchor] ?? TEXT_ANCHOR_CSS["center-center"];
}

function svgAnchorRect(anchor) {
  return SVG_ANCHOR_RECT[anchor] ?? SVG_ANCHOR_RECT["center-center"];
}

// ============================================================================
// AGING OPACITY
// ============================================================================

// Returns the opacity at which an active element should render given its
// fade schedule. Permanent elements (no fades_at_elapsed_s) stay at normal.
// Timed elements stay at normal until within FADING_GRACE_S of their fade
// time, then render at the reduced "fading" opacity for one final cycle
// before auto-fade removes them.
export function opacityForElement(el, currentElapsedS) {
  const fadesAt = el?.fades_at_elapsed_s;
  if (typeof fadesAt !== "number") return AGING_OPACITY.normal;
  const timeLeft = fadesAt - currentElapsedS;
  if (timeLeft <= FADING_GRACE_S) return AGING_OPACITY.fading;
  return AGING_OPACITY.normal;
}

// Back-compat shim retained for the render_html self-test which still calls
// the by-age helper directly. Matches the old behavior approximately: "old"
// is treated as the fading tier, everything else normal.
export function opacityForAge(ageS) {
  return ageS >= 16 ? AGING_OPACITY.fading : AGING_OPACITY.normal;
}

// ============================================================================
// SVG MARKUP VALIDATION
// ============================================================================

const UNSAFE_PROTOCOL_RE = /\b(?:javascript|vbscript)\s*:/i;
const UNSAFE_CSS_IMPORT_RE = /@import\b/i;
const UNSAFE_CSS_EXPRESSION_RE = /\bexpression\s*\(/i;
const UNSAFE_CSS_BEHAVIOR_RE = /\b(?:behavior|-moz-binding)\b/i;
const UNSAFE_HTML_DATA_URL_RE = /data\s*:\s*text\/html/i;
const UNSAFE_SVG_EVENT_HANDLER_RE = /\son[a-z0-9:-]+\s*=/i;
const SAFE_SVG_TAGS = new Set([
  "svg",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "pattern",
  "mask",
  "clippath",
  "filter",
  "fegaussianblur",
  "fecolormatrix",
  "feoffset",
  "femerge",
  "femergenode",
  "feflood",
  "fecomposite",
  "feturbulence",
  "fedisplacementmap",
  "animate",
  "animatetransform",
  "set",
  "g",
  "use",
  "symbol",
  "marker",
  "title",
  "desc",
  "path",
  "line",
  "rect",
  "circle",
  "ellipse",
  "polygon",
  "polyline",
  "text",
  "tspan",
]);
const SVG_TAG_NAME_RE = /<\/?\s*([a-zA-Z][\w:-]*)\b/g;
const SVG_HREF_ATTR_RE = /\b(?:href|xlink:href)\s*=\s*(['"])(.*?)\1/gi;

function hasUnsafeUrlFunction(source) {
  const text = String(source ?? "");
  const matches = text.matchAll(/url\s*\(\s*([^)]*?)\s*\)/gi);
  for (const match of matches) {
    const raw = match[1].trim().replace(/^['"]|['"]$/g, "");
    if (!raw.startsWith("#")) return true;
  }
  return false;
}

function getDisallowedSvgTag(markup) {
  const text = String(markup ?? "");
  for (const match of text.matchAll(SVG_TAG_NAME_RE)) {
    const name = match[1].toLowerCase();
    if (!SAFE_SVG_TAGS.has(name)) return match[1];
  }
  return null;
}

function getExternalSvgHref(markup) {
  const text = String(markup ?? "");
  for (const match of text.matchAll(SVG_HREF_ATTR_RE)) {
    const value = match[2].trim();
    if (!value.startsWith("#")) return value;
  }
  return null;
}

function getSvgMarkupIssue(markup) {
  if (typeof markup !== "string") return "svg_markup must be a string";
  const trimmed = markup.trim();
  if (trimmed.length === 0) return "svg_markup is empty";
  if (!/^<svg[\s>]/i.test(trimmed)) return "svg_markup must start with <svg>";
  if (!/<\/svg>\s*$/i.test(trimmed)) return "svg_markup must end with </svg>";
  const disallowedTag = getDisallowedSvgTag(trimmed);
  if (disallowedTag) return `disallowed SVG tag <${disallowedTag}>`;
  if (UNSAFE_SVG_EVENT_HANDLER_RE.test(trimmed)) return "SVG event handlers are not allowed";
  if (getExternalSvgHref(trimmed)) return "external SVG references are not allowed";
  if (UNSAFE_PROTOCOL_RE.test(trimmed)) return "script protocols are not allowed";
  if (UNSAFE_CSS_IMPORT_RE.test(trimmed)) return "CSS imports are not allowed";
  if (UNSAFE_CSS_EXPRESSION_RE.test(trimmed)) return "CSS expressions are not allowed";
  if (UNSAFE_CSS_BEHAVIOR_RE.test(trimmed)) return "legacy CSS behavior hooks are not allowed";
  if (UNSAFE_HTML_DATA_URL_RE.test(trimmed)) return "HTML data URLs are not allowed";
  if (hasUnsafeUrlFunction(trimmed)) return "external URL references are not allowed";
  const dquotes = (trimmed.match(/"/g) || []).length;
  const squotes = (trimmed.match(/'/g) || []).length;
  if (dquotes % 2 !== 0) return "double quotes are unbalanced";
  if (squotes % 2 !== 0) return "single quotes are unbalanced";
  return null;
}

export function isSvgMarkupValid(markup) {
  return getSvgMarkupIssue(markup) === null;
}

function getCssBackgroundIssue(css) {
  if (typeof css !== "string") return "css_background must be a string";
  const trimmed = css.trim();
  if (trimmed.length === 0) return "css_background is empty";
  if (UNSAFE_PROTOCOL_RE.test(trimmed)) return "script protocols are not allowed";
  if (UNSAFE_CSS_IMPORT_RE.test(trimmed)) return "CSS imports are not allowed";
  if (UNSAFE_CSS_EXPRESSION_RE.test(trimmed)) return "CSS expressions are not allowed";
  if (UNSAFE_CSS_BEHAVIOR_RE.test(trimmed)) return "legacy CSS behavior hooks are not allowed";
  if (UNSAFE_HTML_DATA_URL_RE.test(trimmed)) return "HTML data URLs are not allowed";
  if (hasUnsafeUrlFunction(trimmed)) return "external URL references are not allowed";
  return null;
}

export function sanitizeCssBackground(css) {
  const issue = getCssBackgroundIssue(css);
  if (issue) {
    return {
      ok: false,
      value: "#0a0a0d",
      reason: issue,
    };
  }
  return {
    ok: true,
    value: css.trim(),
    reason: null,
  };
}

function escapeAttr(value) {
  return escapeHtml(String(value ?? ""));
}

function fallbackBadge(reason) {
  return `<span class="renderer-fallback-badge">renderer fallback: ${escapeHtml(reason)}</span>`;
}

// ============================================================================
// TEXT STYLE HINTS
// ============================================================================

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
  // Text needs to carry weight on a full-page installation canvas. Sizes
  // are calibrated so "medium" text reads from across a room and "large"
  // text functions as a typographic event, not an accent.
  if (/huge|massive|display/.test(s)) parts.push("font-size: 5.2rem");
  else if (/large/.test(s)) parts.push("font-size: 3.8rem");
  else if (/small/.test(s)) parts.push("font-size: 1.6rem");
  else parts.push("font-size: 2.4rem");
  if (/tracking|spacing/.test(s)) parts.push("letter-spacing: 0.08em");
  parts.push("line-height: 1.15");
  return parts.join("; ");
}

// ============================================================================
// FINAL SCENE VIEW
// ============================================================================

function renderTextInScene(el, currentElapsedS) {
  const content = elementContent(el);
  const opacity = opacityForElement(el, currentElapsedS);
  const position = textOr(content.position);
  const anchor = classifyPosition(position);
  const posCss = textAnchorCss(anchor);
  const styleCss = textStyleCss(content.style);
  const body = escapeHtml(content.content);
  return (
    `    <div class="scene-element text-element" ` +
    `data-element-id="${escapeAttr(el?.element_id)}" ` +
    `data-position="${escapeAttr(position)}" ` +
    `data-created-at-cycle="${escapeAttr(el?.created_at_cycle)}" ` +
    `style="position: absolute; ${posCss} opacity: ${opacity}; z-index: 4; color: #f5f0e8; text-shadow: 0 2px 10px rgba(0,0,0,0.6); ${styleCss}">` +
    body +
    `</div>`
  );
}

// Size class for images driven by Opus's free-form position string. The
// previous renderer clamped every image to 220x150 regardless of intent; this
// lets "background", "full bleed", "large inset", "right half", "left half"
// actually render at a size that carries weight. "small inset" / "thumbnail"
// keeps the old tile size for deliberately small glimpses.
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

// Image dimensions, expressed as percentages of the scene container so they
// scale with the viewport instead of the fixed 220x150 pixel tile. Heights
// are tuned so "background" reads as a major foundation without hiding the
// rest of the scene, while "small" still leaves room for text/SVG beside it.
// z-index layering:
//   0 → sits behind SVG (for "background" / "full" images that act as a
//        painted atmosphere the rest of the scene composes on top of)
//   2 → sits in front of the SVG canvas (for discrete "inset" photos)
//   3 → text always on top
const IMAGE_DIMENSIONS = Object.freeze({
  full:       { width: "100%",  height: "100%", border: "0",                                 shadow: "none",                              z: 0 },
  background: { width: "72%",   height: "86%",  border: "1px solid rgba(138,126,106,0.35)",  shadow: "0 20px 60px rgba(0,0,0,0.5)",        z: 0 },
  half:       { width: "52%",   height: "78%",  border: "1px solid rgba(138,126,106,0.45)",  shadow: "0 18px 48px rgba(0,0,0,0.42)",       z: 2 },
  large:      { width: "44%",   height: "62%",  border: "1px solid rgba(138,126,106,0.5)",   shadow: "0 16px 40px rgba(0,0,0,0.36)",       z: 2 },
  medium:     { width: "30%",   height: "44%",  border: "1px solid rgba(138,126,106,0.55)",  shadow: "0 12px 28px rgba(0,0,0,0.28)",       z: 2 },
  small:      { width: "220px", height: "150px", border: "1px solid rgba(138,126,106,0.55)", shadow: "0 12px 28px rgba(0,0,0,0.28)",       z: 2 },
});

function imageDimensions(position) {
  return IMAGE_DIMENSIONS[imageSizeClass(position)];
}

function renderImageInScene(el, currentElapsedS) {
  const content = elementContent(el);
  const opacity = opacityForElement(el, currentElapsedS);
  const position = textOr(content.position);
  const anchor = classifyPosition(position);
  const posCss = textAnchorCss(anchor);
  const query = escapeHtml(content.query);
  const dim = imageDimensions(position);
  const asset = safeObject(el?.render_asset);
  if (typeof asset.src === "string" && asset.src) {
    const creditHref = escapeAttr(asset.attribution?.photo_url ?? "");
    const creditName = escapeHtml(asset.attribution?.photographer_name ?? "Unknown");
    const credit = asset.attribution?.photographer_name
      ? `<div style="position: absolute; right: 8px; bottom: 6px; padding: 3px 6px; background: rgba(10,10,13,0.72); color: #f5f0e8; font: 0.68rem/1.2 Georgia, serif; border-radius: 2px; max-width: 78%; text-align: right;">Photo by <a href="${creditHref}" target="_blank" rel="noreferrer noopener" style="color: #f5f0e8; text-decoration: underline;">${creditName}</a></div>`
      : "";
    return (
      `    <div class="scene-element image-element" ` +
      `data-element-id="${escapeAttr(el?.element_id)}" ` +
      `data-position="${escapeAttr(position)}" ` +
      `data-size-class="${escapeAttr(imageSizeClass(position))}" ` +
      `data-created-at-cycle="${escapeAttr(el?.created_at_cycle)}" ` +
      `style="position: absolute; ${posCss} opacity: ${opacity}; z-index: ${dim.z}; ` +
      `width: ${dim.width}; height: ${dim.height}; overflow: hidden; border: ${dim.border}; ` +
      `background: rgba(20,16,13,0.72); box-shadow: ${dim.shadow};">` +
      `<img src="${escapeAttr(asset.src)}" alt="${escapeAttr(content.query ?? "Unsplash image")}" ` +
      `style="display: block; width: 100%; height: 100%; object-fit: cover; filter: saturate(0.92) brightness(0.97);"/>` +
      credit +
      `</div>`
    );
  }
  return (
    `    <div class="scene-element image-placeholder" ` +
    `data-element-id="${escapeAttr(el?.element_id)}" ` +
    `data-position="${escapeAttr(position)}" ` +
    `data-size-class="${escapeAttr(imageSizeClass(position))}" ` +
    `data-created-at-cycle="${escapeAttr(el?.created_at_cycle)}" ` +
    `style="position: absolute; ${posCss} opacity: ${opacity}; z-index: ${dim.z}; ` +
    `width: ${dim.width}; height: ${dim.height}; border: 1px dashed #8a7e6a; ` +
    `background: rgba(40,32,26,0.4); color: #d9cbb2; ` +
    `display: flex; align-items: center; justify-content: center; text-align: center; padding: 12px; ` +
    `font: 0.85rem/1.2 Georgia, serif;">` +
    `<span>query=&ldquo;${query}&rdquo;</span>` +
    `</div>`
  );
}

function renderSvgInScene(el, currentElapsedS) {
  const content = elementContent(el);
  const opacity = opacityForElement(el, currentElapsedS);
  const position = textOr(content.position);
  const anchor = classifyPosition(position);
  const rect = svgAnchorRect(anchor);
  const semanticLabel = textOr(content.semantic_label, "untitled svg");
  const dataAttrs =
    `data-element-id="${escapeAttr(el?.element_id)}" ` +
    `data-semantic-label="${escapeAttr(semanticLabel)}" ` +
    `data-position="${escapeAttr(position)}" ` +
    `data-created-at-cycle="${escapeAttr(el?.created_at_cycle)}"`;

  const issue = getSvgMarkupIssue(content.svg_markup);
  if (!issue) {
    // nested <svg> gets its own coordinate system; we only specify the rect.
    const withRect = content.svg_markup.trim().replace(
      /^<svg\b/i,
      `<svg x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}"`,
    );
    return (
      `    <g class="scene-element svg-element" ${dataAttrs} opacity="${opacity}">` +
      withRect +
      `</g>`
    );
  }
  // unsafe or malformed markup — drop a labeled placeholder rectangle.
  const label = escapeHtml(semanticLabel);
  const reason = escapeHtml(issue);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return (
    `    <g class="scene-element svg-element svg-malformed" ${dataAttrs} data-renderer-fallback="true" opacity="${opacity}">` +
    `<title>renderer fallback: ${reason}</title>` +
    `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" ` +
    `fill="rgba(100,60,60,0.25)" stroke="#a33" stroke-dasharray="6 4" stroke-width="2"/>` +
    `<text x="${cx}" y="${cy - 14}" text-anchor="middle" dominant-baseline="middle" ` +
    `fill="#f5d0d0" font-family="Georgia, serif" font-size="16">renderer fallback</text>` +
    `<text x="${cx}" y="${cy + 10}" text-anchor="middle" dominant-baseline="middle" ` +
    `fill="#f5d0d0" font-family="Georgia, serif" font-size="14">unsafe SVG: ${label}</text>` +
    `<text x="${cx}" y="${cy + 32}" text-anchor="middle" dominant-baseline="middle" ` +
    `fill="#e6b8b8" font-family="monospace" font-size="10">${reason}</text>` +
    `</g>`
  );
}

function renderFinalScene(state) {
  const background = safeObject(state?.background);
  const bg = sanitizeCssBackground(background.css_background);
  const bgCss = bg.ok
    ? `background: ${escapeAttrStyleValue(bg.value)};`
    : "background: #0a0a0d;";
  const active = safeArray(state?.elements).filter((e) => !e?.faded);
  const currentElapsedS = numberOr(state?.current_elapsed_s, 0);

  const textEls = active.filter((e) => e.type === "text");
  const imgEls = active.filter((e) => e.type === "image");
  const svgEls = active.filter((e) => e.type === "svg");

  const textHtml = textEls.map((e) => renderTextInScene(e, currentElapsedS)).join("\n");
  const imgHtml = imgEls.map((e) => renderImageInScene(e, currentElapsedS)).join("\n");
  const svgHtml = svgEls.map((e) => renderSvgInScene(e, currentElapsedS)).join("\n");
  const backgroundNotice =
    !bg.ok && typeof background.css_background === "string" && background.css_background.trim().length > 0
      ? `  <div class="renderer-fallback-notice">${fallbackBadge(`unsafe background blocked (${bg.reason})`)}</div>\n`
      : "";

  return (
    // Structure: the section fills 86vh wide. CSS background covers the whole
    // rectangle. Images layered in DOM order — "background"/"full" images at
    // z-index 0 sit behind the SVG canvas, inset images at z-index 2 sit
    // above. SVG canvas uses meet so forms are not cropped at top/bottom when
    // the container is wider than tall; the empty flanks fall back to the CSS
    // background (never visually empty). Text sits at z-index 4 above all.
    `<section id="final-scene" style="position: relative; width: 100%; height: 86vh; overflow: hidden; ${bgCss}">\n` +
    `  <h2 style="position: absolute; top: 12px; left: 16px; margin: 0; z-index: 9; font: 0.9rem Georgia, serif; color: rgba(245,240,232,0.55); letter-spacing: 0.08em;">FINAL ACCUMULATED SCENE</h2>\n` +
    backgroundNotice +
    imgHtml +
    `\n  <svg class="scene-svg" viewBox="0 0 ${SCENE_VIEWBOX_W} ${SCENE_VIEWBOX_H}" preserveAspectRatio="xMidYMid meet" ` +
    `style="position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1;">\n` +
    svgHtml +
    `\n  </svg>\n` +
    textHtml +
    `\n</section>`
  );
}

// css values go into an attribute context via inline style. escape only the
// two characters that would break the style attribute: " (we wrap in ") and &.
// angle brackets are safe in attribute values per HTML spec.
function escapeAttrStyleValue(css) {
  return String(css ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// ============================================================================
// COMPOSITION HISTORY VIEW
// ============================================================================

// a timeline event is a tuple { cycle, elapsed_s, render() -> html }.
// we fold together element creations, background changes, and fadeElement
// calls (from per_cycle) into one chronology.
function buildTimelineEvents(state, summary) {
  const events = [];

  // element creations
  for (const el of safeArray(state?.elements)) {
    events.push({
      cycle: el.created_at_cycle,
      elapsed: el.created_at_elapsed_s,
      render: () => renderElementHistoryEntry(el),
    });
  }

  // background events (history + current)
  for (const bg of safeArray(state?.background_history)) {
    events.push({
      cycle: bg.set_at_cycle,
      elapsed: bg.set_at_elapsed_s,
      render: () => renderBackgroundHistoryEntry(bg),
    });
  }
  if (state?.background && state.background.css_background) {
    events.push({
      cycle: state.background.set_at_cycle,
      elapsed: state.background.set_at_elapsed_s,
      render: () => renderBackgroundHistoryEntry(state.background, true),
    });
  }

  // fadeElement calls from per_cycle (optional — adds context for history)
  if (summary && Array.isArray(summary.per_cycle)) {
    for (const cyc of summary.per_cycle) {
      const calls = Array.isArray(cyc.tool_calls) ? cyc.tool_calls : [];
      for (const call of calls) {
        if (call.name === "fadeElement") {
          events.push({
            cycle: cyc.cycle_index,
            elapsed: cyc.elapsed_s ?? 0,
            render: () => renderFadeHistoryEntry(cyc, call),
          });
        }
      }
    }
  }

  events.sort((a, b) => (a.elapsed - b.elapsed) || (a.cycle - b.cycle));
  return events;
}

function timestampPrefix(cycle, elapsed) {
  return `<span class="ts">[cycle ${cycle}, ${elapsed}s elapsed]</span>`;
}

function renderElementHistoryEntry(el) {
  const content = elementContent(el);
  const ts = timestampPrefix(numberOr(el?.created_at_cycle, "?"), numberOr(el?.created_at_elapsed_s, "?"));
  const id = escapeHtml(el?.element_id);
  const pos = escapeHtml(content.position ?? "");
  const fadedTag = el.faded
    ? `<span class="faded-tag">(faded by ${el.fades_at_elapsed_s}s)</span>`
    : `<span class="active-tag">(still active)</span>`;
  const lifetime = numberOr(el?.lifetime_s, "?");

  if (el.type === "text") {
    const text = escapeHtml(content.content ?? "");
    const style = escapeHtml(content.style ?? "");
    const styleCss = textStyleCss(content.style);
    return (
      `<div class="history-entry history-text">` +
      `${ts} <strong>TEXT</strong> [${id}] &ldquo;${text}&rdquo; ${fadedTag}\n` +
      `  <div class="history-meta">position: ${pos}, style: ${style}, lifetime: ${lifetime}s</div>\n` +
      `  <div class="history-preview text-preview" style="${styleCss}; color: #f5f0e8;">${text}</div>\n` +
      `</div>`
    );
  }
  if (el.type === "svg") {
    const label = escapeHtml(content.semantic_label ?? "");
    const markup = textOr(content.svg_markup);
    const issue = getSvgMarkupIssue(markup);
    const preview = !issue
      ? `<div class="history-preview svg-preview" style="width: 120px; height: 120px; border: 1px solid rgba(245,240,232,0.2); background: #1b1b20;">${markup}</div>`
      : `<div class="history-preview svg-preview svg-preview-malformed" style="width: 120px; min-height: 60px; border: 1px dashed #a33; padding: 6px; color: #f5d0d0; font: 0.75rem monospace;">${fallbackBadge(issue)}</div>`;
    return (
      `<div class="history-entry history-svg">` +
      `${ts} <strong>SVG</strong> [${id}] &ldquo;${label}&rdquo; ${fadedTag}\n` +
      `  <div class="history-meta">position: ${pos}, lifetime: ${lifetime}s</div>\n` +
      `  ${preview}\n` +
      `  <div class="history-markup"><code>${escapeHtml(markup)}</code></div>\n` +
      `</div>`
    );
  }
  // image
  const query = escapeHtml(content.query ?? "");
  return (
    `<div class="history-entry history-image">` +
    `${ts} <strong>IMAGE</strong> [${id}] query=&ldquo;${query}&rdquo; ${fadedTag}\n` +
    `  <div class="history-meta">position: ${pos}, lifetime: ${lifetime}s</div>\n` +
    `  <div class="history-preview image-preview" style="width: 180px; height: 120px; border: 1px dashed #8a7e6a; background: rgba(40,32,26,0.4); color: #d9cbb2; display: flex; align-items: center; justify-content: center; text-align: center; padding: 10px; font: 0.85rem Georgia, serif;">${query}</div>\n` +
    `</div>`
  );
}

function renderBackgroundHistoryEntry(bg, isCurrent = false) {
  const entry = safeObject(bg);
  const ts = timestampPrefix(numberOr(entry.set_at_cycle, "?"), numberOr(entry.set_at_elapsed_s, "?"));
  const cssEsc = escapeHtml(entry.css_background ?? "");
  const safeCss = sanitizeCssBackground(entry.css_background);
  const cssAttr = safeCss.ok
    ? `background: ${escapeAttrStyleValue(safeCss.value)};`
    : "background: repeating-linear-gradient(135deg, rgba(100,60,60,0.35), rgba(100,60,60,0.35) 10px, rgba(25,20,20,0.35) 10px, rgba(25,20,20,0.35) 20px);";
  const currentTag = isCurrent ? `<span class="active-tag">(current)</span>` : "";
  const fallback = !safeCss.ok ? `  <div class="history-meta">${fallbackBadge(`unsafe background blocked (${safeCss.reason})`)}</div>\n` : "";
  return (
    `<div class="history-entry history-background background-change">` +
    `${ts} <strong>SET BACKGROUND</strong> ${currentTag}\n` +
    `  <div class="history-preview background-strip" style="width: 100%; height: 26px; ${cssAttr} border: 1px solid rgba(245,240,232,0.15);"></div>\n` +
    fallback +
    `  <div class="history-markup"><code>${cssEsc}</code></div>\n` +
    `</div>`
  );
}

function renderFadeHistoryEntry(cycle, call) {
  const ts = timestampPrefix(cycle.cycle_index, cycle.elapsed_s ?? 0);
  const id = escapeHtml(call.input?.element_id ?? "?");
  return (
    `<div class="history-entry history-fade">` +
    `${ts} <strong>FADE</strong> [${id}]\n` +
    `</div>`
  );
}

function renderCompositionHistory(state, summary) {
  const events = buildTimelineEvents(state, summary);
  const body = events.map((e) => e.render()).join("\n");
  return (
    `<section id="composition-history">\n` +
    `  <h2>COMPOSITION HISTORY</h2>\n` +
    `  ${body}\n` +
    `</section>`
  );
}

// ============================================================================
// SCENE OVERVIEW VIEW (what Opus sees)
// ============================================================================

// Renders the same SCENE OVERVIEW text block that Opus receives in the user
// message, wrapped in a styled monospace block so operators can watch the
// signals that shape Opus's compositional decisions.
export function renderSceneOverview(state) {
  const overview = computeOverview(state ?? {});
  const block = formatOverviewBlock(overview);
  return (
    `<section id="scene-overview">\n` +
    `  <h2>SCENE OVERVIEW (what Opus sees)</h2>\n` +
    `  <pre class="scene-overview-block">${escapeHtml(block)}</pre>\n` +
    `</section>`
  );
}

// ============================================================================
// RUN STATISTICS VIEW
// ============================================================================

function renderStatistics(summary) {
  const totals = summary.totals ?? {};
  const statusCounts = totals.status_counts ?? {};
  const perCycle = Array.isArray(summary.per_cycle) ? summary.per_cycle : [];

  // tool-call distribution by type
  const byTool = new Map();
  for (const cyc of perCycle) {
    for (const tc of cyc.tool_calls ?? []) {
      byTool.set(tc.name, (byTool.get(tc.name) ?? 0) + 1);
    }
  }
  const byToolLines = Array.from(byTool.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `    <li>${escapeHtml(name)}: ${n}</li>`)
    .join("\n");

  // cache hit ratio if usage present
  let cacheRatio = "n/a";
  let cacheReadTotal = 0;
  let inputTotal = 0;
  for (const cyc of perCycle) {
    const u = cyc.usage;
    if (u && typeof u === "object") {
      cacheReadTotal += u.cache_read_input_tokens ?? 0;
      inputTotal += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
  }
  if (inputTotal > 0) {
    cacheRatio = `${((cacheReadTotal / inputTotal) * 100).toFixed(1)}% (${cacheReadTotal} / ${inputTotal} input tokens)`;
  }

  const statusLines = Object.entries(statusCounts)
    .map(([k, v]) => `    <li>${escapeHtml(k)}: ${v}</li>`)
    .join("\n");

  const cost = typeof totals.cost === "number" ? `$${totals.cost.toFixed(4)}` : "$0.0000";

  return (
    `<section id="run-statistics">\n` +
    `  <h2>RUN STATISTICS</h2>\n` +
    `  <dl>\n` +
    `    <dt>Run id</dt><dd>${escapeHtml(summary.run_id ?? "unknown")}</dd>\n` +
    `    <dt>Model</dt><dd>${escapeHtml(summary.model ?? "unknown")}</dd>\n` +
    `    <dt>Config</dt><dd>${escapeHtml(summary.config ?? "unknown")}</dd>\n` +
    `    <dt>Mode</dt><dd>${escapeHtml(summary.mode ?? "unknown")}</dd>\n` +
    `    <dt>Total cycles</dt><dd>${totals.total_cycles ?? perCycle.length}</dd>\n` +
    `    <dt>Tool calls total</dt><dd>${totals.tool_calls ?? 0}</dd>\n` +
    `    <dt>Cycles with tool calls</dt><dd>${totals.cycles_with_tool_calls ?? 0}</dd>\n` +
    `    <dt>Cycles silent</dt><dd>${totals.cycles_silent ?? 0}</dd>\n` +
    `    <dt>Ok count</dt><dd>${totals.ok_count ?? 0}</dd>\n` +
    `    <dt>Cost</dt><dd>${cost}</dd>\n` +
    `    <dt>Cache hit ratio</dt><dd>${cacheRatio}</dd>\n` +
    `    <dt>Started</dt><dd>${escapeHtml(summary.started_at ?? "")}</dd>\n` +
    `    <dt>Finished</dt><dd>${escapeHtml(summary.finished_at ?? "")}</dd>\n` +
    `  </dl>\n` +
    `  <h3>Status counts</h3>\n` +
    `  <ul>\n${statusLines}\n  </ul>\n` +
    `  <h3>Tool-call distribution</h3>\n` +
    `  <ul>\n${byToolLines || "    <li>(none)</li>"}\n  </ul>\n` +
    `</section>`
  );
}

// ============================================================================
// PAGE STYLES
// ============================================================================

const PAGE_CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; padding: 0; background: #0a0a0d; color: #f5f0e8; font: 16px/1.5 Georgia, 'Times New Roman', serif; }
  header { padding: 20px 32px; border-bottom: 1px solid rgba(245,240,232,0.12); }
  header h1 { margin: 0 0 4px 0; font-size: 1.4rem; letter-spacing: 0.04em; }
  header .subtitle { color: rgba(245,240,232,0.55); font-size: 0.9rem; }
  .live-monitor-banner { margin-top: 12px; display: inline-block; padding: 8px 12px; border: 1px dashed rgba(197,182,143,0.7); background: rgba(35,26,18,0.7); color: #e7d7b0; font: 0.82rem/1.35 monospace; }
  section { padding: 20px 32px; border-bottom: 1px solid rgba(245,240,232,0.08); }
  section h2 { margin: 0 0 14px 0; font-size: 0.9rem; letter-spacing: 0.12em; color: rgba(245,240,232,0.55); text-transform: uppercase; }
  section h3 { margin: 18px 0 6px 0; font-size: 0.85rem; letter-spacing: 0.1em; color: rgba(245,240,232,0.5); text-transform: uppercase; }
  .renderer-fallback-notice { position: absolute; top: 40px; left: 16px; z-index: 3; }
  .renderer-fallback-badge { display: inline-block; padding: 6px 10px; border: 1px dashed rgba(245, 176, 176, 0.65); background: rgba(60, 20, 20, 0.72); color: #f5d0d0; font: 0.78rem/1.3 monospace; }
  #composition-history .history-entry { margin: 14px 0; padding: 10px 12px; border-left: 2px solid rgba(245,240,232,0.15); background: rgba(245,240,232,0.02); }
  #composition-history .ts { color: rgba(245,240,232,0.45); font-family: monospace; font-size: 0.85rem; }
  #composition-history .history-meta { color: rgba(245,240,232,0.5); font-size: 0.85rem; margin-top: 4px; }
  #composition-history .history-preview { margin-top: 8px; }
  #composition-history .history-markup code { display: block; margin-top: 6px; padding: 6px 8px; background: rgba(0,0,0,0.35); color: #d9cbb2; font: 0.8rem/1.4 monospace; white-space: pre-wrap; word-break: break-all; }
  #composition-history .faded-tag { color: rgba(245,240,232,0.35); font-size: 0.8rem; }
  #composition-history .active-tag { color: #c5b68f; font-size: 0.8rem; }
  #run-statistics dl { display: grid; grid-template-columns: 220px 1fr; gap: 4px 16px; }
  #run-statistics dt { color: rgba(245,240,232,0.55); }
  #run-statistics dd { margin: 0; }
  #run-statistics ul { margin: 4px 0 0 0; padding-left: 22px; }
  #scene-overview .scene-overview-block { margin: 0; padding: 14px 18px; background: rgba(0,0,0,0.5); color: #e7d7b0; font: 0.85rem/1.5 ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace; white-space: pre-wrap; border-left: 2px solid rgba(197,182,143,0.45); border-radius: 2px; }
`;

// ============================================================================
// PUBLIC ENTRY
// ============================================================================

function renderLiveBanner(liveInfo) {
  if (!liveInfo) return "";
  const cycleText =
    typeof liveInfo.cycles_completed === "number" && typeof liveInfo.cycles_total === "number"
      ? `${liveInfo.cycles_completed}/${liveInfo.cycles_total} cycles complete`
      : "awaiting first cycle";
  const currentCycleText =
    typeof liveInfo.current_cycle_index === "number"
      ? `latest cycle: ${String(liveInfo.current_cycle_index).padStart(3, "0")}`
      : "latest cycle: none yet";
  const updatedText = liveInfo.last_updated_at
    ? `last update: ${escapeHtml(liveInfo.last_updated_at)}`
    : "last update: pending";
  const refreshText = typeof liveInfo.refresh_seconds === "number"
    ? `auto-refresh: ${liveInfo.refresh_seconds}s`
    : "auto-refresh enabled";
  return (
    `  <div class="live-monitor-banner">LIVE MONITOR · ${cycleText} · ${currentCycleText} · ${updatedText} · ${refreshText}</div>\n`
  );
}

function writeHtmlFile(filePath, html) {
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, html);
  renameSync(tempPath, filePath);
}

function imageQueryKey(query) {
  return textOr(query).trim().toLowerCase().replace(/\s+/g, " ");
}

async function resolveImageAssets(state, runDir, fetchImageImpl = fetchImage) {
  const activeImages = safeArray(state?.elements).filter((e) => e?.type === "image" && !e?.faded);
  const byQuery = new Map();

  await Promise.all(
    activeImages.map(async (el) => {
      const content = elementContent(el);
      const key = imageQueryKey(content.query);
      if (!key || byQuery.has(key)) return;
      const result = await fetchImageImpl(content.query);
      if (result?.path) {
        const relPath = relative(runDir, result.path).replace(/\\/g, "/");
        byQuery.set(key, {
          src: relPath,
          attribution: result.attribution ?? null,
          cached: Boolean(result.cached),
        });
      } else {
        byQuery.set(key, {
          src: null,
          attribution: null,
          error: result?.error ?? "image fetch failed",
        });
      }
    }),
  );

  const assets = {};
  for (const el of activeImages) {
    const key = imageQueryKey(elementContent(el).query);
    if (key && byQuery.has(key)) {
      assets[el.element_id] = byQuery.get(key);
    }
  }
  return assets;
}

export function renderHtmlString({ state, summary, liveInfo = null, imageAssets = {} }) {
  const stateWithAssets = {
    ...(state ?? {}),
    elements: safeArray(state?.elements).map((el) => ({
      ...el,
      render_asset: imageAssets[el?.element_id] ?? null,
    })),
  };
  const runId = escapeHtml(summary?.run_id ?? "unknown");
  const title = liveInfo
    ? `Feed Looks Back — live monitor — run ${runId}`
    : `Feed Looks Back — run ${runId}`;
  const mode = escapeHtml(summary?.mode ?? "unknown");
  const model = escapeHtml(summary?.model ?? "unknown");
  const refreshMeta = liveInfo
    ? `  <meta http-equiv="refresh" content="${liveInfo.refresh_seconds ?? LIVE_MONITOR_REFRESH_SECONDS}"/>\n`
    : "";
  const liveBanner = renderLiveBanner(liveInfo);

  const finalScene = renderFinalScene(stateWithAssets);
  const sceneOverview = renderSceneOverview(stateWithAssets);
  const history = renderCompositionHistory(stateWithAssets, summary);
  const statistics = renderStatistics(summary);

  return (
    `<!DOCTYPE html>\n` +
    `<html lang="en">\n` +
    `<head>\n` +
    `<meta charset="utf-8"/>\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"/>\n` +
    refreshMeta +
    `<title>${title}</title>\n` +
    `<style>${PAGE_CSS}</style>\n` +
    `</head>\n` +
    `<body>\n` +
    `<header>\n` +
    `  <h1>${title}</h1>\n` +
    `  <div class="subtitle">mode: ${mode} · model: ${model}</div>\n` +
    liveBanner +
    `</header>\n` +
    finalScene +
    `\n` +
    sceneOverview +
    `\n` +
    history +
    `\n` +
    statistics +
    `\n</body>\n</html>\n`
  );
}

export async function renderFinalHtml(runDir, artifacts = null, options = {}) {
  const state = artifacts?.state ?? JSON.parse(readFileSync(join(runDir, "scene_state.json"), "utf8"));
  const summary = artifacts?.summary ?? JSON.parse(readFileSync(join(runDir, "run_summary.json"), "utf8"));
  const imageAssets = await resolveImageAssets(state, runDir, options.fetchImageImpl ?? fetchImage);
  const html = renderHtmlString({ state, summary, imageAssets });
  const outPath = join(runDir, "final_scene.html");
  writeHtmlFile(outPath, html);
  return outPath;
}

export async function renderLiveHtml(runDir, artifacts = null, options = {}) {
  const state = artifacts?.state ?? JSON.parse(readFileSync(join(runDir, "scene_state.json"), "utf8"));
  const summary = artifacts?.summary ?? JSON.parse(readFileSync(join(runDir, "run_summary.json"), "utf8"));
  const refreshSeconds = options.refreshSeconds ?? LIVE_MONITOR_REFRESH_SECONDS;
  const liveInfo = {
    cycles_completed: summary?.per_cycle?.length ?? 0,
    cycles_total: summary?.cycles_total ?? summary?.totals?.total_cycles ?? null,
    current_cycle_index:
      summary?.per_cycle?.length > 0
        ? summary.per_cycle[summary.per_cycle.length - 1]?.cycle_index ?? null
        : null,
    last_updated_at: options.lastUpdatedAt ?? new Date().toISOString(),
    refresh_seconds: refreshSeconds,
  };
  const imageAssets = await resolveImageAssets(state, runDir, options.fetchImageImpl ?? fetchImage);
  const html = renderHtmlString({ state, summary, liveInfo, imageAssets });
  const outPath = join(runDir, "live_monitor.html");
  writeHtmlFile(outPath, html);
  return outPath;
}

// ============================================================================
// INLINE SELF-TEST
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import("node:assert/strict")).default;
  const { Parser } = await import("htmlparser2");
  const { mkdtempSync, readFileSync: readFileSyncTest } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  let pass = 0;
  let fail = 0;
  const tests = [];
  function t(desc, fn) {
    tests.push({ desc, fn });
  }

  // --- synthetic fixtures --------------------------------------------------

  function buildSyntheticState() {
    // 13 elements total: 5 active (2 svg incl one malformed, 2 text, 1 image)
    // + 8 faded (mixed types) to exercise history rendering.
    const elements = [];

    // FADED (oldest first) — indices 1..8
    for (let i = 1; i <= 8; i++) {
      const type = ["text", "svg", "image", "text", "text", "svg", "image", "text"][i - 1];
      const createdAtCycle = i;
      const createdAtS = i * 5;
      const lifetime = type === "text" ? 20 : type === "svg" ? 15 : 18;
      const content =
        type === "text"
          ? { content: `fragment-${i}`, position: "lower-left", style: "serif, large" }
          : type === "svg"
            ? {
                svg_markup: `<svg viewBox="0 0 100 100"><line x1="0" y1="${50 + i}" x2="100" y2="${50 - i}" stroke="white" stroke-width="2"/></svg>`,
                position: "horizontal band at mid-height",
                semantic_label: `angular break at cycle ${i}`,
              }
            : { query: `threshold light ${i}`, position: "background" };
      elements.push({
        element_id: `elem_${String(i).padStart(4, "0")}`,
        type,
        created_at_cycle: createdAtCycle,
        created_at_elapsed_s: createdAtS,
        lifetime_s: lifetime,
        fades_at_elapsed_s: createdAtS + lifetime,
        faded: true,
        content,
      });
    }

    // ACTIVE (5 elements) — indices 9..13
    elements.push({
      element_id: "elem_0009",
      type: "text",
      created_at_cycle: 25,
      created_at_elapsed_s: 130,
      lifetime_s: 20,
      fades_at_elapsed_s: 150,
      faded: false,
      content: { content: "what remains", position: "upper-right", style: "light, small" },
    });
    elements.push({
      element_id: "elem_0010",
      type: "text",
      created_at_cycle: 28,
      created_at_elapsed_s: 145,
      lifetime_s: 20,
      fades_at_elapsed_s: 165,
      faded: false,
      content: { content: "after", position: "lower-left", style: "serif" },
    });
    elements.push({
      element_id: "elem_0011",
      type: "svg",
      created_at_cycle: 29,
      created_at_elapsed_s: 150,
      lifetime_s: 15,
      fades_at_elapsed_s: 165,
      faded: false,
      content: {
        svg_markup:
          '<svg viewBox="0 0 100 100"><line x1="0" y1="50" x2="100" y2="50" stroke="white" stroke-width="2"/></svg>',
        position: "horizontal band at mid-height",
        semantic_label: "horizontal line mid",
      },
    });
    // DELIBERATELY MALFORMED SVG — no closing tag, unclosed attribute
    elements.push({
      element_id: "elem_0012",
      type: "svg",
      created_at_cycle: 29,
      created_at_elapsed_s: 152,
      lifetime_s: 15,
      fades_at_elapsed_s: 167,
      faded: false,
      content: {
        svg_markup: '<svg viewBox="0 0 100 100"><line x1="0 y1="50 broken<<',
        position: "center",
        semantic_label: "broken markup",
      },
    });
    elements.push({
      element_id: "elem_0013",
      type: "image",
      created_at_cycle: 30,
      created_at_elapsed_s: 155,
      lifetime_s: 18,
      fades_at_elapsed_s: 173,
      faded: false,
      content: { query: "exhausted land at dusk", position: "background" },
    });

    return {
      elements,
      background: {
        css_background: "linear-gradient(208deg, #1a1410 0%, #0d0908 100%)",
        set_at_cycle: 28,
        set_at_elapsed_s: 145,
      },
      background_history: [
        {
          css_background: "linear-gradient(180deg, #1a1410 0%, #0d0908 100%)",
          set_at_cycle: 0,
          set_at_elapsed_s: 5,
        },
        {
          css_background: "radial-gradient(circle at 30% 20%, rgba(180,140,90,0.45), rgba(10,10,12,0.95) 70%)",
          set_at_cycle: 15,
          set_at_elapsed_s: 80,
        },
      ],
      next_element_index: 14,
      current_cycle_index: 30,
      current_elapsed_s: 155,
    };
  }

  function buildSyntheticSummary() {
    return {
      run_id: "SELFTEST_RUN",
      config: "config_a",
      model: "claude-opus-4-7",
      mode: "dry-run",
      corpus_dir: "/fake/corpus",
      cycles_total: 31,
      cycles_range: null,
      started_at: "2026-04-23T00:00:00.000Z",
      per_cycle: [
        {
          cycle_index: 0,
          cycle_id: "cycle_000",
          elapsed_s: 5,
          status: "ok",
          error: null,
          tool_calls: [
            {
              name: "setBackground",
              input: { css_background: "linear-gradient(180deg, #1a1410 0%, #0d0908 100%)" },
            },
          ],
          tool_results: [
            { tool_use_id: "synth_0", name: "setBackground", result: { ok: true } },
          ],
          persistence_issues: [],
          stop_reason: "end_turn",
          usage: null,
          cost: null,
          active_after_cycle: 0,
        },
        {
          cycle_index: 1,
          cycle_id: "cycle_001",
          elapsed_s: 10,
          status: "ok",
          error: null,
          tool_calls: [
            {
              name: "addText",
              input: { content: "fragment-1", position: "lower-left", style: "serif, large" },
            },
          ],
          tool_results: [
            { tool_use_id: "synth_1", name: "addText", result: { element_id: "elem_0001" } },
          ],
          persistence_issues: [],
          stop_reason: "end_turn",
          usage: null,
          cost: null,
          active_after_cycle: 1,
        },
      ],
      totals: {
        total_cycles: 31,
        tool_calls: 31,
        cycles_with_tool_calls: 31,
        cycles_silent: 0,
        cost: 1.87,
        ok_count: 30,
        status_counts: {
          ok: 30,
          api_failure: 0,
          response_parse_failure: 1,
          persistence_failure: 0,
          tool_call_errors: 0,
        },
      },
      finished_at: "2026-04-23T00:10:00.000Z",
    };
  }

  function parseHtmlStrict(html) {
    const errors = [];
    const elements = new Map();
    const parser = new Parser(
      {
        onopentag(name) {
          elements.set(name, (elements.get(name) || 0) + 1);
        },
        onerror(err) {
          errors.push(err);
        },
      },
      { decodeEntities: true, recognizeSelfClosing: true, xmlMode: false },
    );
    parser.write(html);
    parser.end();
    return { errors, elements };
  }

  // --- assertions ----------------------------------------------------------

  const state = buildSyntheticState();
  const summary = buildSyntheticSummary();

  t("renderHtmlString produces a non-empty string that starts with a DOCTYPE", () => {
    const html = renderHtmlString({ state, summary });
    assert.equal(typeof html, "string");
    assert.match(html, /^<!DOCTYPE html>/i);
    assert.ok(html.length > 500, "html should be more than a stub");
  });

  t("rendered HTML parses with zero htmlparser2 errors", () => {
    const html = renderHtmlString({ state, summary });
    const { errors, elements } = parseHtmlStrict(html);
    assert.equal(errors.length, 0, `parse errors: ${errors.map((e) => e.message).join("; ")}`);
    assert.ok(elements.has("html"), "needs <html> root");
    assert.ok(elements.has("body"), "needs <body>");
    assert.ok(elements.has("section") || elements.has("div"), "needs content sections");
  });

  t("final scene view applies background css via inline style on a container", () => {
    const html = renderHtmlString({ state, summary });
    // background css must appear verbatim inside the final-scene container's style
    assert.match(html, /linear-gradient\(208deg, #1a1410 0%, #0d0908 100%\)/);
    // and must be tied to a final-scene container
    assert.match(html, /id="final-scene"/);
  });

  t("final scene view shows active text elements verbatim and hides faded ones", () => {
    const html = renderHtmlString({ state, summary });
    // active
    assert.match(html, /what remains/);
    assert.match(html, /after/);
    // faded: should still appear in history, but not in #final-scene.
    // strong check: the faded "fragment-3" content doesn't show inside the final-scene section.
    const finalMatch = html.match(/<section id="final-scene"[\s\S]*?<\/section>/);
    assert.ok(finalMatch, "final-scene section present");
    assert.doesNotMatch(finalMatch[0], /fragment-3/);
  });

  t("final scene view injects valid svg_markup into a containing <svg viewBox='0 0 1000 1000'>", () => {
    const html = renderHtmlString({ state, summary });
    // outer viewBox present
    assert.match(html, /viewBox="0 0 1000 1000"/);
    // valid svg_markup from elem_0011 present verbatim (its inner <line> is identifiable)
    assert.match(html, /<line x1="0" y1="50" x2="100" y2="50" stroke="white" stroke-width="2"\/>/);
    // data-attrs on the <g> wrapper
    assert.match(html, /data-element-id="elem_0011"/);
    assert.match(html, /data-semantic-label="horizontal line mid"/);
  });

  t("malformed svg_markup becomes a labeled placeholder, does not break html parsing", () => {
    const html = renderHtmlString({ state, summary });
    const { errors } = parseHtmlStrict(html);
    assert.equal(errors.length, 0);
    // elem_0012 has malformed markup. It must appear as a placeholder — not injected raw.
    assert.doesNotMatch(html, /<line x1="0 y1="50 broken<</); // raw broken markup must not appear
    // placeholder should mention "malformed" or the semantic label or the literal markup escaped
    assert.match(html, /elem_0012/);
    assert.ok(
      /malformed|broken markup|&lt;line x1="0/.test(html),
      "malformed placeholder should show label or escaped literal markup",
    );
  });

  t("image elements render as labeled placeholder boxes with the query text", () => {
    const html = renderHtmlString({ state, summary });
    assert.match(html, /exhausted land at dusk/);
    assert.match(html, /data-element-id="elem_0013"/);
    // placeholder classification hint
    assert.match(html, /class="[^"]*\bimage-placeholder\b[^"]*"/);
  });

  t("image elements render actual img tags and attribution when image assets are provided", () => {
    const html = renderHtmlString({
      state,
      summary,
      imageAssets: {
        elem_0013: {
          src: "../image_cache/example.jpg",
          attribution: {
            photographer_name: "Ada Example",
            photo_url: "https://unsplash.com/photos/example",
          },
        },
      },
    });
    assert.match(html, /<img src="\.\.\/image_cache\/example\.jpg"/);
    assert.match(html, /Photo by/);
    assert.match(html, /Ada Example/);
    assert.match(html, /https:\/\/unsplash\.com\/photos\/example/);
  });

  t("composition history view contains entries for every element (active and faded)", () => {
    const html = renderHtmlString({ state, summary });
    assert.match(html, /id="composition-history"/);
    // every element id must appear somewhere in history
    for (let i = 1; i <= 13; i++) {
      const id = `elem_${String(i).padStart(4, "0")}`;
      assert.ok(html.includes(id), `history should include ${id}`);
    }
  });

  t("composition history entries include cycle and elapsed_s labels", () => {
    const html = renderHtmlString({ state, summary });
    // an active element created at cycle 30, elapsed 155s
    assert.match(html, /cycle 30/);
    assert.match(html, /155/); // elapsed stamp
  });

  t("composition history includes setBackground entries as colored strips", () => {
    const html = renderHtmlString({ state, summary });
    // current background + history entries = 3 background events
    assert.match(html, /SET BACKGROUND|set background|background-change/i);
    // the strip contains the CSS verbatim
    assert.match(html, /radial-gradient\(circle at 30% 20%/);
  });

  t("run statistics view reflects totals from run_summary.json", () => {
    const html = renderHtmlString({ state, summary });
    assert.match(html, /id="run-statistics"/);
    assert.match(html, /31/); // total_cycles
    assert.match(html, /\$1\.87|1\.87/); // cost
    assert.match(html, /ok.*30|30.*ok/i);
  });

  t("opacityForElement stays at normal until inside the fade grace window", () => {
    // Permanent element (no fades_at_elapsed_s) never dims.
    assert.equal(
      opacityForElement(
        { fades_at_elapsed_s: null, created_at_elapsed_s: 0 },
        180,
      ),
      AGING_OPACITY.normal,
    );
    // Timed element well before fade: still at normal.
    assert.equal(
      opacityForElement(
        { fades_at_elapsed_s: 100, created_at_elapsed_s: 0 },
        50,
      ),
      AGING_OPACITY.normal,
    );
    // Timed element inside the grace window: drops to fading opacity.
    assert.equal(
      opacityForElement(
        { fades_at_elapsed_s: 100, created_at_elapsed_s: 0 },
        97,
      ),
      AGING_OPACITY.fading,
    );
    // At fade time exactly: still fading (<= threshold).
    assert.equal(
      opacityForElement(
        { fades_at_elapsed_s: 100, created_at_elapsed_s: 0 },
        100,
      ),
      AGING_OPACITY.fading,
    );
  });

  t("opacityForAge back-compat: normal outside 16s, fading beyond", () => {
    assert.equal(opacityForAge(0), AGING_OPACITY.normal);
    assert.equal(opacityForAge(8), AGING_OPACITY.normal);
    assert.equal(opacityForAge(15), AGING_OPACITY.normal);
    assert.equal(opacityForAge(16), AGING_OPACITY.fading);
    assert.equal(opacityForAge(30), AGING_OPACITY.fading);
  });

  t("classifyPosition maps common strings to 9-anchor names or named specials", () => {
    assert.equal(classifyPosition("lower-left"), "lower-left");
    assert.equal(classifyPosition("upper-right"), "upper-right");
    assert.equal(classifyPosition("center"), "center-center");
    assert.equal(classifyPosition("background"), "background");
    assert.equal(classifyPosition("horizontal band at mid-height"), "horizontal-band-middle");
    assert.equal(classifyPosition("fullscreen"), "fullscreen");
    assert.equal(classifyPosition("full canvas"), "fullscreen");
    assert.equal(classifyPosition("horizontal-band-upper"), "horizontal-band-upper");
    assert.equal(classifyPosition("vertical column right"), "vertical-column-right");
    assert.equal(classifyPosition("two-column-span-left"), "two-column-span-left");
    assert.equal(classifyPosition(""), "center-center");
    assert.equal(classifyPosition(null), "center-center");
  });

  t("escapeHtml escapes &, <, >, ', \"", () => {
    assert.equal(escapeHtml("a & b"), "a &amp; b");
    assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
    assert.equal(escapeHtml('"x\''), "&quot;x&#39;");
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
  });

  t("isSvgMarkupValid accepts real svg and rejects obvious malformed strings", () => {
    assert.equal(
      isSvgMarkupValid('<svg viewBox="0 0 100 100"><line x1="0" y1="50" x2="100" y2="50"/></svg>'),
      true,
    );
    assert.equal(isSvgMarkupValid('<svg viewBox="0 0 100 100"><line x1="0 y1="50 broken<<'), false);
    assert.equal(isSvgMarkupValid(""), false);
    assert.equal(isSvgMarkupValid(null), false);
    // script tags rejected (matches the prompt contract "no scripts")
    assert.equal(isSvgMarkupValid('<svg><script>alert(1)</script></svg>'), false);
    assert.equal(isSvgMarkupValid('<svg><rect width="10" height="10" onload="alert(1)"/></svg>'), false);
    assert.equal(isSvgMarkupValid('<svg><foreignObject><div>nope</div></foreignObject></svg>'), false);
    assert.equal(isSvgMarkupValid('<svg><rect fill="url(https://example.com/a)"/></svg>'), false);
    assert.equal(isSvgMarkupValid('<svg><rect fill="url(#grad)"/></svg>'), true);
  });

  t("isSvgMarkupValid allows local gradient/filter/animate/use markup within the SVG", () => {
    const markup =
      '<svg viewBox="0 0 1000 1000">' +
      '<defs>' +
      '<linearGradient id="grad"><stop offset="0%" stop-color="#111"/><stop offset="100%" stop-color="#999"/></linearGradient>' +
      '<filter id="blur"><feGaussianBlur stdDeviation="4"/></filter>' +
      '<symbol id="pulse"><circle cx="100" cy="100" r="80" fill="url(#grad)"><animate attributeName="opacity" values="0.2;0.5;0.2" dur="8s" repeatCount="indefinite"/></circle></symbol>' +
      '</defs>' +
      '<g filter="url(#blur)"><use href="#pulse"/></g>' +
      '</svg>';
    assert.equal(isSvgMarkupValid(markup), true);
  });

  t("isSvgMarkupValid rejects external href references even on otherwise safe tags", () => {
    assert.equal(
      isSvgMarkupValid('<svg><use href="https://example.com/shape.svg#x"/></svg>'),
      false,
    );
    assert.equal(
      isSvgMarkupValid('<svg><use xlink:href="http://example.com/shape.svg#x"/></svg>'),
      false,
    );
  });

  t("new SVG positions resolve to valid rectangles and fullscreen spans the full canvas", () => {
    const fullscreen = svgAnchorRect(classifyPosition("fullscreen"));
    assert.deepEqual(fullscreen, { x: 0, y: 0, w: 1000, h: 1000 });
    for (const anchor of [
      "horizontal-band-upper",
      "horizontal-band-middle",
      "horizontal-band-lower",
      "vertical-column-left",
      "vertical-column-right",
      "two-column-span-upper",
      "two-column-span-lower",
      "two-column-span-left",
      "two-column-span-right",
    ]) {
      const rect = svgAnchorRect(anchor);
      assert.ok(rect.w > 0 && rect.h > 0, `${anchor} should have positive size`);
      assert.ok(rect.x >= 0 && rect.y >= 0, `${anchor} should stay on-canvas`);
      assert.ok(rect.x + rect.w <= 1000, `${anchor} should fit horizontally`);
      assert.ok(rect.y + rect.h <= 1000, `${anchor} should fit vertically`);
    }
  });

  t("renderSvgInScene maps fullscreen SVG to the full master viewBox", () => {
    const el = {
      element_id: "elem_svg_full",
      created_at_cycle: 0,
      created_at_elapsed_s: 0,
      content: {
        position: "fullscreen",
        semantic_label: "full wash",
        svg_markup: '<svg viewBox="0 0 1000 1000"><rect width="1000" height="1000" fill="url(#grad)"/></svg>',
      },
    };
    const rendered = renderSvgInScene(el, 0);
    assert.match(rendered, /<svg x="0" y="0" width="1000" height="1000"/);
  });

  t("unsafe css backgrounds are blocked and clearly labeled as renderer fallbacks", () => {
    const unsafeState = {
      ...state,
      background: {
        ...state.background,
        css_background: "url(https://example.com/track-me.png)",
      },
    };
    const html = renderHtmlString({ state: unsafeState, summary });
    assert.match(html, /renderer fallback: unsafe background blocked/i);
    assert.doesNotMatch(html, /style="[^"]*url\(https:\/\/example\.com\/track-me\.png/i);
    const finalMatch = html.match(/<section id="final-scene"[\s\S]*?<\/section>/);
    assert.ok(finalMatch, "final scene section present");
    assert.doesNotMatch(finalMatch[0], /background:\s*url\(/i);
  });

  t("renderHtmlString tolerates malformed scene-state content objects", () => {
    const malformedState = {
      ...state,
      elements: [
        {
          element_id: "elem_broken_text",
          type: "text",
          created_at_cycle: 30,
          created_at_elapsed_s: 155,
          lifetime_s: 20,
          fades_at_elapsed_s: 175,
          faded: false,
          content: null,
        },
        {
          element_id: "elem_broken_svg",
          type: "svg",
          created_at_cycle: 30,
          created_at_elapsed_s: 155,
          lifetime_s: 15,
          fades_at_elapsed_s: 170,
          faded: false,
          content: { svg_markup: "<svg><script>boom</script></svg>" },
        },
      ],
    };
    const html = renderHtmlString({ state: malformedState, summary });
    assert.match(html, /elem_broken_text/);
    assert.match(html, /renderer fallback/i);
  });

  t("renderFinalHtml(runDir): disk round-trip produces final_scene.html", async () => {
    const { writeFileSync: wfs } = await import("node:fs");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "flb-render-io-"));
    wfs(path.join(tmp, "scene_state.json"), JSON.stringify(state));
    wfs(path.join(tmp, "run_summary.json"), JSON.stringify(summary));
    const outPath = await renderFinalHtml(tmp, { state, summary }, {
      fetchImageImpl: async () => ({ path: null, attribution: null, error: "disabled in self-test" }),
    });
    assert.ok(outPath.endsWith("final_scene.html"));
    const written = readFileSyncTest(outPath, "utf8");
    assert.match(written, /^<!DOCTYPE html>/i);
    assert.match(written, /exhausted land at dusk/);
    const { errors } = parseHtmlStrict(written);
    assert.equal(errors.length, 0);
  });

  t("renderFinalHtml accepts in-memory artifacts when run_summary.json is absent", async () => {
    const { writeFileSync: wfs } = await import("node:fs");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "flb-render-inline-"));
    wfs(path.join(tmp, "scene_state.json"), JSON.stringify(state));
    const outPath = await renderFinalHtml(tmp, { state, summary }, {
      fetchImageImpl: async () => ({ path: null, attribution: null, error: "disabled in self-test" }),
    });
    const written = readFileSyncTest(outPath, "utf8");
    assert.match(written, /^<!DOCTYPE html>/i);
    assert.match(written, /SELFTEST_RUN/);
  });

  t("renderHtmlString includes a live-monitor banner and refresh meta when liveInfo is provided", () => {
    const html = renderHtmlString({
      state,
      summary,
      liveInfo: {
        cycles_completed: 7,
        cycles_total: 31,
        current_cycle_index: 6,
        last_updated_at: "2026-04-23T00:02:00.000Z",
        refresh_seconds: 2,
      },
    });
    assert.match(html, /<meta http-equiv="refresh" content="2"\/>/);
    assert.match(html, /LIVE MONITOR/);
    assert.match(html, /7\/31 cycles complete/);
    assert.match(html, /latest cycle: 006/);
  });

  t("renderLiveHtml writes live_monitor.html with auto-refresh enabled", async () => {
    const { writeFileSync: wfs } = await import("node:fs");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "flb-render-live-"));
    wfs(path.join(tmp, "scene_state.json"), JSON.stringify(state));
    wfs(path.join(tmp, "run_summary.json"), JSON.stringify(summary));
    const outPath = await renderLiveHtml(tmp, { state, summary }, {
      refreshSeconds: 3,
      lastUpdatedAt: "2026-04-23T00:03:00.000Z",
      fetchImageImpl: async () => ({ path: null, attribution: null, error: "disabled in self-test" }),
    });
    assert.ok(outPath.endsWith("live_monitor.html"));
    const written = readFileSyncTest(outPath, "utf8");
    assert.match(written, /<meta http-equiv="refresh" content="3"\/>/);
    assert.match(written, /LIVE MONITOR/);
  });

  // --- Session D: SCENE OVERVIEW view ---------------------------------------

  t("renderHtmlString includes a SCENE OVERVIEW section with the overview block", () => {
    const html = renderHtmlString({ state, summary });
    assert.match(html, /id="scene-overview"/);
    assert.match(html, /SCENE OVERVIEW \(what Opus sees\)/);
    // the block content (from formatOverviewBlock) appears inside a <pre>.
    assert.match(html, /Elements active: 5 total/);
    assert.match(html, /Spatial: upper-left: 0 \| upper-center: 0/);
  });

  t("SCENE OVERVIEW section appears between the final scene and composition history", () => {
    const html = renderHtmlString({ state, summary });
    const finalIdx = html.indexOf('id="final-scene"');
    const overviewIdx = html.indexOf('id="scene-overview"');
    const historyIdx = html.indexOf('id="composition-history"');
    assert.ok(finalIdx > 0, "final scene present");
    assert.ok(overviewIdx > 0, "scene overview present");
    assert.ok(historyIdx > 0, "composition history present");
    assert.ok(finalIdx < overviewIdx, "overview should come after final scene");
    assert.ok(overviewIdx < historyIdx, "overview should come before composition history");
  });

  t("SCENE OVERVIEW block renders inside a styled monospace pre element", () => {
    const html = renderHtmlString({ state, summary });
    assert.match(html, /class="scene-overview-block"/);
    // CSS declares monospace font family on that class.
    assert.match(html, /#scene-overview \.scene-overview-block \{[^}]*monospace/);
  });

  t("renderSceneOverview tolerates states loaded from disk without cycle_history field", () => {
    const legacy = { ...state };
    delete legacy.cycle_history;
    const html = renderSceneOverview(legacy);
    assert.match(html, /SCENE OVERVIEW \(what Opus sees\)/);
    assert.match(html, /Elements active: 5 total/);
  });

  t("SCENE OVERVIEW view appears in renderLiveHtml output", async () => {
    const { writeFileSync: wfs } = await import("node:fs");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "flb-overview-live-"));
    wfs(path.join(tmp, "scene_state.json"), JSON.stringify(state));
    wfs(path.join(tmp, "run_summary.json"), JSON.stringify(summary));
    const outPath = await renderLiveHtml(tmp, { state, summary }, {
      refreshSeconds: 2,
      lastUpdatedAt: "2026-04-23T00:05:00.000Z",
      fetchImageImpl: async () => ({ path: null, attribution: null, error: "disabled in self-test" }),
    });
    const written = readFileSyncTest(outPath, "utf8");
    assert.match(written, /id="scene-overview"/);
    assert.match(written, /Density trajectory:/);
  });

  for (const { desc, fn } of tests) {
    try {
      await fn();
      pass += 1;
      process.stdout.write(`  ok  ${desc}\n`);
    } catch (err) {
      fail += 1;
      process.stdout.write(`  FAIL ${desc}\n    ${err.stack ?? err.message}\n`);
    }
  }

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
}
