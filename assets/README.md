# assets/

Generated visual assets for *The Feed Looks Back*. Each subdirectory holds a specific size and use of the project's figurative-still-life aesthetic. The prompts that produce these assets live at [`../docs/ASSET_PROMPTS.md`](../docs/ASSET_PROMPTS.md).

## Layout

| Directory | Canonical file | Spec | Used in |
|---|---|---|---|
| `logo/` | `logo.svg` (preferred) or `logo.png` | 512×512 | README hero, favicon, social previews |
| `cover/` | `cover.png` | 1500×500 | README hero block |
| `thumbnail/` | `youtube_thumbnail.png` | 1280×720 | YouTube demo upload |
| `social/` | `og_card.png` | 1200×630 | GitHub social preview, X / Twitter share |
| `backgrounds/` | `warm.png`, `cool.png`, `candlelit.png` | 1920×1080 | slide deck, presentation, future site |

## Naming

`README.md` and `docs/ASSET_PROMPTS.md` reference the canonical filenames above. Variants live alongside with suffixed names; the canonical file is the one that ships:

- `cover.png` ← shipped, referenced from README
- `cover_v2.png`, `cover_warm.png` ← variants kept for archive

## Aesthetic check before shipping

Every asset must pass the figurative-only test enforced by the runtime prompt at `node/prompts/bayati_base.md`:

> Every sketch is describable in one sentence as a scene or an object in the world.

If you cannot name the subject in one sentence ("a single feather on dark cloth," "a slow ripple in candlelight"), regenerate. AI image models drift toward generic-pretty defaults; this is the same drift the runtime is built to resist.

## Generating

1. Open [`../docs/ASSET_PROMPTS.md`](../docs/ASSET_PROMPTS.md).
2. Paste the **master prompt + the per-asset spec block + the negative-constraints block** into your image generator (ChatGPT image tool, DALL·E, Midjourney, etc.).
3. Generate 3–4 variants; pick the one that reads cleanest at small sizes.
4. Save into the correct subdirectory using the canonical filename above.
5. If the filename diverges from the canonical name, update the corresponding reference in `../README.md`.
