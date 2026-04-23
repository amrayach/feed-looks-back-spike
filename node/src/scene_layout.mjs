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

export const TEXT_ANCHOR_CSS = Object.freeze({
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
});

export function textAnchorCss(anchor) {
  return TEXT_ANCHOR_CSS[anchor] ?? TEXT_ANCHOR_CSS["center-center"];
}

export const SVG_ANCHOR_RECT = Object.freeze({
  "upper-left": { x: 0, y: 0, w: 460, h: 460 },
  "upper-center": { x: 290, y: 0, w: 460, h: 460 },
  "upper-right": { x: 540, y: 0, w: 460, h: 460 },
  "center-left": { x: 0, y: 290, w: 460, h: 460 },
  "center-center": { x: 270, y: 270, w: 460, h: 460 },
  "center-right": { x: 540, y: 290, w: 460, h: 460 },
  "lower-left": { x: 0, y: 540, w: 460, h: 460 },
  "lower-center": { x: 290, y: 540, w: 460, h: 460 },
  "lower-right": { x: 540, y: 540, w: 460, h: 460 },
  background: { x: 0, y: 0, w: 1000, h: 1000 },
  fullscreen: { x: 0, y: 0, w: 1000, h: 1000 },
  "horizontal-band-upper": { x: 0, y: 0, w: 1000, h: 380 },
  "horizontal-band-middle": { x: 0, y: 310, w: 1000, h: 380 },
  "horizontal-band-lower": { x: 0, y: 620, w: 1000, h: 380 },
  "vertical-column-left": { x: 0, y: 0, w: 380, h: 1000 },
  "vertical-column-right": { x: 620, y: 0, w: 380, h: 1000 },
  "vertical-band-center": { x: 310, y: 0, w: 380, h: 1000 },
  "two-column-span-upper": { x: 100, y: 0, w: 800, h: 380 },
  "two-column-span-lower": { x: 100, y: 620, w: 800, h: 380 },
  "two-column-span-left": { x: 0, y: 290, w: 800, h: 420 },
  "two-column-span-right": { x: 200, y: 290, w: 800, h: 420 },
});

export function svgAnchorRect(anchor) {
  return SVG_ANCHOR_RECT[anchor] ?? SVG_ANCHOR_RECT["center-center"];
}

export const RECT_CSS = Object.freeze({
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
});

export function imageSizeClass(position) {
  const p = String(position ?? "").toLowerCase();
  if (/\b(full[- ]?bleed|fullscreen|full[- ]?canvas|fill|entire|whole)\b/.test(p)) return "full";
  if (/\b(background|backdrop)\b/.test(p)) return "background";
  if (/\b(half|right[- ]?half|left[- ]?half|span)\b/.test(p)) return "half";
  if (/\b(large|big|occupying|wide)\b/.test(p)) return "large";
  if (/\b(small|thumbnail|tiny|inset)\b/.test(p)) return "small";
  if (/\b(medium|mid[- ]?size|mid[- ]?inset)\b/.test(p)) return "medium";
  return "medium";
}

export const IMAGE_DIMENSIONS = Object.freeze({
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

export function imageDimensions(position) {
  return IMAGE_DIMENSIONS[imageSizeClass(position)];
}

export function textStyleCss(styleHint) {
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
  return parts.join("; ");
}

export function scaleSvgMarkup(markup) {
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
      nextAttrs += ' style="display:block;width:100%;height:100%;"';
    }
    if (!/\bpreserveAspectRatio\s*=/.test(nextAttrs)) {
      nextAttrs += ' preserveAspectRatio="xMidYMid meet"';
    }
    return `<svg${nextAttrs}>`;
  });
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;

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

  t("classifyPosition maps common strings to anchors and named specials", () => {
    assert.equal(classifyPosition("lower-left"), "lower-left");
    assert.equal(classifyPosition("upper-right"), "upper-right");
    assert.equal(classifyPosition("center"), "center-center");
    assert.equal(classifyPosition("background"), "background");
    assert.equal(classifyPosition("horizontal band at mid-height"), "horizontal-band-middle");
    assert.equal(classifyPosition("fullscreen"), "fullscreen");
    assert.equal(classifyPosition("full canvas"), "fullscreen");
    assert.equal(classifyPosition("vertical column right"), "vertical-column-right");
    assert.equal(classifyPosition("two-column-span-left"), "two-column-span-left");
    assert.equal(classifyPosition(""), "center-center");
    assert.equal(classifyPosition(null), "center-center");
  });

  t("svgAnchorRect gives on-canvas rectangles for shared special positions", () => {
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

  t("textAnchorCss and RECT_CSS stay aligned for two-column span positions", () => {
    assert.match(textAnchorCss("two-column-span-left"), /left: 18%/);
    assert.match(RECT_CSS["two-column-span-left"], /width: 80%/);
  });

  t("imageSizeClass and imageDimensions recognize background and span placements", () => {
    assert.equal(imageSizeClass("background"), "background");
    assert.equal(imageSizeClass("right half span"), "half");
    assert.equal(imageDimensions("background").width, "72%");
    assert.equal(imageDimensions("small inset").height, "150px");
  });

  t("textStyleCss preserves typography hints without renderer-only color", () => {
    const css = textStyleCss("serif, large, italic, tracking");
    assert.match(css, /Georgia/);
    assert.match(css, /font-size: 3.8rem/);
    assert.match(css, /font-style: italic/);
    assert.doesNotMatch(css, /color:/);
  });

  t("scaleSvgMarkup forces full-slot sizing and preserveAspectRatio", () => {
    const scaled = scaleSvgMarkup('<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>');
    assert.match(scaled, /width:100%;height:100%/);
    assert.match(scaled, /preserveAspectRatio="xMidYMid meet"/);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
