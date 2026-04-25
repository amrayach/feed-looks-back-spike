# Asset Prompts

Prompts for generating visual assets for *The Feed Looks Back*. Hand to ChatGPT (with the image-gen tool), DALL·E, Midjourney, or any text-to-image model. The prompts are grounded in the figurative-only aesthetic contract that the runtime prompt enforces — so the README, the cover, the thumbnail, and what the system actually puts on stage all read as the same world.

> **Source of truth for the aesthetic:** `node/prompts/bayati_base.md` — specifically the `### Figurative only — this is load-bearing` section (figurative anchors), the `### Mandatory palette — declare these constants in every sketch` section (palette constants), and the *Build one recognizable visual world* clause in the operating contract (which architectural register to avoid).

---

## 🧭 How to use

1. Pick the asset you need from the [per-asset specs](#-per-asset-specs) below.
2. Paste **the master prompt + the per-asset spec block + the negative-constraints block** into your image generator as a single prompt.
3. Generate 3–4 variants. Pick the one that names a single recognizable subject in one short sentence ("a single feather on dark cloth," "a slow ripple in candlelight").
4. Drop the chosen file into the matching subdirectory of [`assets/`](../assets/) using the canonical filename in the [placement table](../assets/README.md).
5. Update any `README.md` references if the filename changed.

The aesthetic check is not optional: if you cannot name what's depicted, regenerate. AI image models drift toward generic-pretty defaults, and that drift is exactly what the project is critiquing — keeping it out of the assets is the same discipline the runtime applies to itself.

---

## 🎨 The aesthetic — non-negotiable

| Lever | What it should be | What it must not be |
|---|---|---|
| **Subject** | One recognizable thing or scene in the world (a feather, a still water surface, an ink line, an open palm, loose linen, breath on glass, a bowed head, a ripple). | Geometric pattern, abstract flow, particle field, generative-art swirl, AI-art trope. |
| **Light** | Low candlelight or oil-lamp warmth, single source from one side, deep shadow occupying most of the frame. | Bright daylight, neon, glow, harsh top-light, key+fill studio cleanness. |
| **Palette** | Warm ochre `#c4894a`, burnt sienna `#8b4a2a`, pale candlelight cream `#f5e6c8` / `#e8d4a0`, deep shadow `#2a1f14`, sparing cool slate `#4a6670` only as quiet accent. | Saturated primary red / blue / green / yellow. Pure `#ffffff`. Pure `#000000` at full opacity. |
| **Texture** | Photographic with painterly grain — Caravaggio low-light register, ink-and-paper tactility, soft handheld imperfection. | Clean digital sheen, crisp 3D render, vector-flat, glossy PR photography. |
| **Composition** | Centred or rule-of-thirds; deep negative space; the single load-bearing element held like a held breath. | Busy composition, multiple foci, symmetric centred face, dataflow diagram. |
| **Cultural register** | Universal contemplative still-life. Music as a cultural carrier in general. | Any specific tradition's costume, instrument, or geographic signifier. No minarets, arched doorways, thresholds, doorframes, stone interiors, plaster walls. |

The architectural-avoidance clause is non-obvious and load-bearing: the runtime prompt explicitly excludes minarets, arches, doorways, and stone interiors because they belong to a different maqam's register and reading them as "Middle Eastern aesthetic" would collapse the project's framing. Asset prompts must inherit that same exclusion.

---

## 🖼️ Master prompt

Paste this verbatim, then append the per-asset spec block and the negative-constraints block.

```text
A contemplative figurative still life rendered as a soft photographic study. Subject: ONE recognizable thing or scene from this list — a thin line of moonlight catching a still water surface, a single feather settling on dark cloth, soft breath rising on a cold pane of glass, a bowed head in shadow, an ink line drying on paper, an open palm warming in low candlelight, loose linen falling across a dark surface, a slow ripple expanding across a dark pool, the back of a lone figure looking out a window at night.

Mood: sustained interior longing, attention, almost-rightness — earnest and precise, never theatrical. Reads as the held second after a phrase ends.

Light: low candlelight or oil-lamp warmth, a single warm source falling across the subject from one side. Deep shadow occupies most of the frame; the subject is the held thing.

Palette (use only these tones): warm ochre #c4894a, burnt sienna #8b4a2a, pale candlelight cream #f5e6c8 and #e8d4a0, deep shadow #2a1f14, sparing cool slate #4a6670 only as a quiet accent. All gradients transition between these tones.

Texture: photographic with painterly grain — Caravaggio low-light register, ink-and-paper tactility, soft handheld imperfection. Visible grain is welcome; clean digital sheen is wrong.

Composition: centred or rule-of-thirds; deep negative space; a single load-bearing element. Treat it as a held photograph, not a layout.

Output: photographic, soft-edged, painterly. The viewer should be able to name the subject in one short sentence.
```

---

## 🚫 Negative constraints (stamp on every prompt)

Append this to the master prompt for every asset:

```text
DO NOT include: minarets, arched doorways, thresholds, doorframes, stone interiors, plaster walls, lamps on stone ledges, decorative tiles, mosaics, columns, courtyards. These belong to a different aesthetic register and break the project's contract.

DO NOT include: particle fields, fractal swirls, geometric flow patterns, neon, glitch effects, generative-art hallmarks, neural-net visualisations, dataflow diagrams, code text, HUD overlays.

DO NOT include: any embedded text, typography, watermark, logo, or signature.

DO NOT include: any explicit cultural costume, traditional instrument, geographic landmark, or named-tradition signifier — the piece treats music as a cultural carrier in general, not as any one tradition.

DO NOT include: saturated primary reds, blues, greens, yellows; pure white #ffffff; pure black #000000; chrome highlights; rim-lit subjects; symmetrical centred portraits; AI-art compositional tropes.
```

---

## 🪞 Per-asset specs

### Logo — `assets/logo/logo.{svg,png}`

**Spec:** 512×512, square. Single-element mark. Transparent background or warm cream `#f5e6c8`.

```text
Render the master prompt as a single-element mark suitable for a 512x512 logo. Reduce to ONE figurative motif — choose ONE: a single feather seen from above, a thin moonline across still water, OR a single ink line drying. Treat it as a single ink-tone (deep ochre #8b4a2a or deep shadow #2a1f14) on a warm cream ground (#f5e6c8). Negative space is the design. The mark should read at 32x32 favicon size — silhouette-strong, painterly edge variance rather than flat vector. No text, no border, no enclosing shape.
```

### Cover / banner — `assets/cover/cover.png`

**Spec:** 1500×500 (social header / website hero), wide landscape. Calibrated for a title overlay in the negative-space half.

```text
Render the master prompt as a 1500x500 wide landscape interior. The subject occupies the right or left third; the other two-thirds are deep warm shadow with a slow gradient. The frame is calibrated for an overlay title in the negative-space half — leave that area visually quiet but not empty (a slow gradient of deep shadow into warm ochre is correct). The composition should breathe with the music's silence. Aspect ratio strictly 3:1.
```

### Thumbnail — `assets/thumbnail/youtube_thumbnail.png`

**Spec:** 1280×720, 16:9. Calibrated for a bottom-third title bar that the editor will add in post.

```text
Render the master prompt as a 1280x720 16:9 frame. The subject is offset to the upper or middle band so the lower third of the frame can hold a title bar in post-production (leave that band visually quiet — a slow gradient of deep shadow is correct). Slightly more contrast than the cover so the thumbnail reads at small sizes. A single warm light source from upper-left; subject in the middle or lower-right third.
```

### Social / OG card — `assets/social/og_card.png`

**Spec:** 1200×630 (Open Graph). For the GitHub repo social preview and X / Twitter share.

```text
Render the master prompt as a 1200x630 Open Graph card. Centred subject with high negative space top and bottom for typography that platforms or readers may add. Slightly tighter framing than the cover. Treat this like the album cover for a contemplative record — a held image, not a marketing layout.
```

### Backgrounds — `assets/backgrounds/{warm,cool,candlelit}.png`

**Spec:** 1920×1080 each, three variants. Subtle enough to layer text over.

```text
Render three 1920x1080 variants suitable for layering text and content over. All three should look like the same room photographed at different hours.

VARIANT A — warm.png — WARM TWILIGHT: late ochre and burnt sienna gradient, one soft figurative anchor (a feather, a folded linen edge, an open palm) at lower third. Deep shadow background.

VARIANT B — cool.png — COOL NOCTURNE: deep shadow throughout with cool slate (#4a6670) moonline reflection on a still water surface low in the frame. Sparing warm accent only at the moonline edge.

VARIANT C — candlelit.png — CANDLELIT WARM: a single oil-lamp pool of light low-centre with deep shadow surround. The light is the subject; nothing else competes. Ground level.
```

---

## 🎼 Variation prompts (optional — Bayati structural moments)

The runtime prompt frames Bayati's musical structure as ground → ascent → pivot → muhayyar arrival → descent. These translate into four asset variations within the same aesthetic. Useful if you want the cover, thumbnail, and OG card to read as different moments of the same arc.

| Variation | Subject | When to use |
|---|---|---|
| **A — quiet ground** | Open palm in low candlelight, the source out-of-frame at upper left. | OG card, README hero |
| **B — pivot** | A slow ripple expanding across a dark pool, single small light catching the leading edge. | Cover, mid-section asset |
| **C — arrival** | A thin line of moonlight settling across a still water surface, broader than usual, breath of air visible above it. | Final-frame thumbnail, presentation closer |
| **D — descent** | Folded linen on a dark surface, a single feather just landed at its edge. | Footer / outro / archive |

Append `Use the SUBJECT for variation [A/B/C/D] as the master subject` to lock a specific moment.

---

## 📍 Where each asset goes

| Asset | File | Used in |
|---|---|---|
| Logo | `assets/logo/logo.svg` (or `.png`) | README hero, repo favicon, social previews |
| Cover | `assets/cover/cover.png` (1500×500) | README hero block |
| Thumbnail | `assets/thumbnail/youtube_thumbnail.png` (1280×720) | YouTube demo upload |
| Social card | `assets/social/og_card.png` (1200×630) | GitHub repo social preview, X / Twitter share |
| Backgrounds | `assets/backgrounds/{warm,cool,candlelit}.png` (1920×1080) | Slide deck, presentation, future site |

After dropping a file in, update the relevant `README.md` reference if the filename diverges from the canonical name above.

---

## 🛠️ Generating with ChatGPT — short version

1. Open ChatGPT (a model with the image-gen tool enabled).
2. Paste the **master prompt + per-asset spec block + negative-constraints block** as a single message.
3. Ask for 4 variants.
4. Pick the one that passes the one-sentence subject test ("a single feather on dark cloth," not "an abstract composition").
5. Save into `assets/<subdir>/` with the canonical filename.
6. If you want a tonal variant within the same asset, append the appropriate **Variation prompts** clause and re-run.

---

## 🔗 See also

- [`../assets/README.md`](../assets/README.md) — placement and naming conventions for the `assets/` tree
- [`../README.md`](../README.md) — where the assets surface in the repo's front door
- `node/prompts/bayati_base.md` — the runtime aesthetic source of truth (same figurative anchors, same palette constants)
