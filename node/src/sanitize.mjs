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

export function getSvgMarkupIssue(markup) {
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

if (import.meta.url === `file://${process.argv[1]}`) {
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

  t("isSvgMarkupValid accepts simple safe SVG", () => {
    assert.equal(
      isSvgMarkupValid('<svg viewBox="0 0 100 100"><line x1="0" y1="50" x2="100" y2="50"/></svg>'),
      true,
    );
  });

  t("isSvgMarkupValid rejects malformed or empty SVG", () => {
    assert.equal(isSvgMarkupValid('<svg viewBox="0 0 100 100"><line x1="0 y1="50 broken<<'), false);
    assert.equal(isSvgMarkupValid(""), false);
    assert.equal(isSvgMarkupValid(null), false);
  });

  t("isSvgMarkupValid rejects scripts, event handlers, foreignObject, and external URLs", () => {
    assert.equal(isSvgMarkupValid('<svg><script>alert(1)</script></svg>'), false);
    assert.equal(isSvgMarkupValid('<svg><rect width="10" height="10" onload="alert(1)"/></svg>'), false);
    assert.equal(isSvgMarkupValid('<svg><foreignObject><div>nope</div></foreignObject></svg>'), false);
    assert.equal(isSvgMarkupValid('<svg><rect fill="url(https://example.com/a)"/></svg>'), false);
  });

  t("isSvgMarkupValid allows local gradient/filter/animate/use markup", () => {
    const markup =
      '<svg viewBox="0 0 1000 1000">' +
      '<defs>' +
      '<linearGradient id="grad"><stop offset="0%" stop-color="#111"/><stop offset="100%" stop-color="#999"/></linearGradient>' +
      '<filter id="blur"><feGaussianBlur stdDeviation="4"/></filter>' +
      '<symbol id="pulse"><circle cx="100" cy="100" r="80" fill="url(#grad)"><animate attributeName="opacity" values="0.2;0.5;0.2" dur="8s" repeatCount="indefinite"/></circle></symbol>' +
      '</defs>' +
      '<g filter="url(#blur)"><use href="#pulse"/></g>' +
      "</svg>";
    assert.equal(isSvgMarkupValid(markup), true);
  });

  t("isSvgMarkupValid rejects external href references", () => {
    assert.equal(
      isSvgMarkupValid('<svg><use href="https://example.com/shape.svg#x"/></svg>'),
      false,
    );
    assert.equal(
      isSvgMarkupValid('<svg><use xlink:href="http://example.com/shape.svg#x"/></svg>'),
      false,
    );
  });

  t("sanitizeCssBackground accepts safe gradients and rejects unsafe URLs", () => {
    assert.deepEqual(
      sanitizeCssBackground("linear-gradient(180deg, #111, #000)"),
      { ok: true, value: "linear-gradient(180deg, #111, #000)", reason: null },
    );
    assert.deepEqual(
      sanitizeCssBackground("url(https://example.com/track-me.png)"),
      { ok: false, value: "#0a0a0d", reason: "external URL references are not allowed" },
    );
  });

  t("sanitizeCssBackground rejects script protocols and empty strings", () => {
    assert.equal(sanitizeCssBackground("javascript:alert(1)").ok, false);
    assert.equal(sanitizeCssBackground("").reason, "css_background is empty");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
