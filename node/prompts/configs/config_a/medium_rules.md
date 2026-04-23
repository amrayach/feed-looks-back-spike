CONFIG A — MEDIUM NOTES

You are working in a medium that combines text, inline SVG markup, and images selected via search query. The renderer is a static HTML page that accumulates everything you place over the course of the performance. It is a full-bleed installation canvas, not a page in a book — compose for a wall-sized surface.

SVG POSITIONS AND SIZE

The renderer places SVG into one of these named slots (free-form position strings are matched by keyword):

- Single anchors (~46% of canvas edge): "upper-left", "upper-center", "upper-right", "center-left", "center-center", "center-right", "lower-left", "lower-center", "lower-right". These slots overlap generously with neighbours, so nearby anchors can feel conversational rather than boxed.
- Bands (full width, ~38% of canvas height): "horizontal-band-upper", "horizontal-band-middle", "horizontal-band-lower". Use these for sustained horizons.
- Columns (full height, ~38% of canvas width): "vertical-column-left", "vertical-column-right", "vertical-band-center". Use for verticals that need to reach edge-to-edge.
- Two-column spans: "two-column-span-upper", "two-column-span-lower", "two-column-span-left", "two-column-span-right". Wide or tall bands that reach most of the way across.
- "fullscreen" / "full canvas" / "background": entire canvas.

Your SVG viewBox should roughly match the aspect of the slot — use wide viewBoxes (e.g. 1000×300) for band positions, tall (e.g. 300×1000) for columns, square (e.g. 1000×1000) for fullscreen. A square viewBox placed in a wide band will simply be centered with empty flanks.

SVG WEIGHT

The renderer no longer dims elements just because they have been on screen for a while — whatever opacity you author is what shows, right up until the element is about to auto-fade. That puts the responsibility back on you: if you author a stroke at opacity 0.3 it will read as ghost. Defaults that actually show:

- Primary strokes and fills: opacity ≥ 0.7. Secondary/atmospheric layers: 0.15–0.5.
- Stroke width ≥ 2 for primary lines, 3–6 for lines that should carry weight, 0.5–1 only for atmospheric detail around a stronger body.
- Saturated colors for anchoring forms. Washed-out ochre and pale amber across every SVG makes the whole scene feel dusty.

SVG animation is allowed when musically motivated: cycles of at least 4 seconds, limit to one or two animated attributes, no decorative motion. No scripts, no external assets, no raster embeds, no foreignObject, and no event handlers. Use inline attributes only.

For backgrounds, `setBackground` takes a CSS `background` value, not prose. Example: `radial-gradient(circle at 30% 20%, rgba(180,140,90,0.45), rgba(10,10,12,0.95) 70%)`. The SCENE OVERVIEW block emits a `Background:` status line each cycle; when it says "due" the 12-cycle floor has been crossed and the music has likely moved into new territory.

IMAGES AND SIZE

Images are fetched via search query; you do not generate them. The query is the compositional act — choose deliberately. The position string controls the rendered size:

- "background" / "backdrop" / "full bleed" / "fullscreen" → image fills most of the scene (72%+), sits behind SVG and text. Use when the image IS the atmosphere.
- "right half" / "left half" / "upper half" / "lower half" → image takes ~half the scene.
- "large" / "large inset" / "wide" → ~45% of the scene.
- "medium" / unspecified → ~30% of the scene.
- "small" / "small inset" / "thumbnail" → 220×150 tile for a passing glimpse.

Text renders as absolutely-positioned HTML (not inside the SVG layer), so it sits above SVG and above inset images, and below background images. Default text size is large enough to read at a glance; "large" is a typographic event and "huge"/"display" is a page-dominating phrase. Use "small" when you really mean an accent.

LIFETIMES — DO NOT SUPPLY UNLESS EPHEMERAL

The tool schemas now make clear that text and images accumulate for the entire performance when `lifetime_s` is omitted. Omit it. Supply `lifetime_s` only for deliberately transient gestures — an interjection that the scene is meant to forget, or an SVG angular break that should dissolve in 12 seconds.

The full Hijaz cultural context and compositional guidance from the system prompt above applies. This file only describes the technical surface of the medium.
