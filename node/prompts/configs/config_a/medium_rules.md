CONFIG A — MEDIUM NOTES

You are working in a medium that combines text, inline SVG markup, and images selected via search query. The renderer is a full-bleed installation canvas, not a page in a book — compose for a wall-sized surface. Text can accumulate across the performance; images and timed forms arrive for passages and dissolve unless deliberately extended with numeric lifetimes.

SVG POSITIONS AND SIZE

The renderer places SVG into one of these named slots (free-form position strings are matched by keyword):

- Single anchors (~46% of canvas edge): "upper-left", "upper-center", "upper-right", "center-left", "center-center", "center-right", "lower-left", "lower-center", "lower-right". These slots overlap generously with neighbours, so nearby anchors can feel conversational rather than boxed.
- Bands (full width, ~38% of canvas height): "horizontal-band-upper", "horizontal-band-middle", "horizontal-band-lower". Use these for sustained horizons.
- Columns (full height, ~38% of canvas width): "vertical-column-left", "vertical-column-right", "vertical-band-center". Use for verticals that need to reach edge-to-edge.
- Two-column spans: "two-column-span-upper", "two-column-span-lower", "two-column-span-left", "two-column-span-right". Wide or tall bands that reach most of the way across.
- "fullscreen" / "full canvas" / "background": entire canvas.

Your SVG viewBox should roughly match the aspect of the slot — use wide viewBoxes (e.g. 1000×300) for band positions, tall (e.g. 300×1000) for columns, square (e.g. 1000×1000) for fullscreen. A square viewBox placed in a wide band will simply be centered with empty flanks.

SVG AND P5 COLOR PALETTE — mandatory

Warm anchors (primary forms):
  #e8d4a0  warm parchment
  #c4894a  burnt ochre
  #8b4a2a  deep terracotta
  #f5e6c8  pale candlelight
  #d4a574  sand gold
  #2a1f14  deep shadow

Cool accents (use sparingly):
  #4a6670  slate blue-grey
  #8a9ba0  muted steel

NEVER use: saturated primaries, #ffffff or #000000 at full opacity,
or any color not in this list without a reason in semantic_label.
All gradients must transition between palette values only.

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

LIFETIMES — IMAGE TURNOVER, TEXT ACCUMULATION

Text accumulates for the entire performance when `lifetime_s` is omitted. Omit it for most text. Images are different: when image `lifetime_s` is omitted, the runner gives the photograph a default ~25-second presence and an ~8-second dissolve. This turnover is required; it keeps the room changing instead of pinning the whole run to one fetched photo.

For images, do not request permanence. Do not pass `lifetime_s: null`; the live runner treats null the same as omission and keeps the default image turnover. Supply a numeric `lifetime_s` only for a deliberately shorter or longer photographic passage. For SVGs, omit `lifetime_s` for the default 35-second presence, or supply longer values for true anchor forms.

IMAGE SOURCE QUALITY

Image search can return weak matches if the query is too poetic. Build queries from concrete photographed subjects, material, and light. Bayati examples (interior-figurative, NOT Hijaz architectural): "open palm resting in low candlelight", "head bowed in shadow with soft side light", "moonlight on still water at night", "loose linen falling across a dark surface", "single hand cupped around a small flame", "the back of a person looking out a window at night", "rain on a dark glass pane", "single feather on dark cloth", "solitary figure walking across a dark plain at dusk". Avoid the Hijaz architectural register (arched doorways, plaster walls, stone interiors, lamps on stone ledges). Avoid broad place labels and mood-only phrases such as "longing" or "what remained".

When IMAGE CADENCE is DUE or OVERDUE, choose a concrete photograph even if an older image is still fading. Related images may overlap during the dissolve; the turnover is part of the medium.

The full Bayati cultural context and compositional guidance from the system prompt above applies. This file only describes the technical surface of the medium.
