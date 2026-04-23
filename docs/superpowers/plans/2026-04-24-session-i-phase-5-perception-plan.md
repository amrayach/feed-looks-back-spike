# Session I Phase 5 — Perception (Mood Board + Self-Frame) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Opus 4.7 a cached figurative mood-board reference and event-triggered self-frames so it can make aesthetic decisions with its own eyes on what the stage is rendering.

**Architecture:** Mood board is a JSON-configured canon of five figurative SVGs (artist-swappable) that sharp rasterises to PNG and packs into the cached system prefix via `cache_control: ephemeral` — read once per session, served at ~0.1× thereafter. Self-frame is a Playwright headless screenshot of the live stage, taken after `cycle.end` whenever OR-combined triggers (every-5th cycle, high element count, image drought, hijaz tahwil fired) fire. The capture is held in run-state and injected into the next cycle's uncached user turn.

**Tech Stack:** Node 22+, `@anthropic-ai/sdk ^0.90` (Opus 4.7 — adaptive thinking, `output_config.effort: medium`), `playwright` (Chromium headless), `sharp` (SVG→PNG), existing `zod` for content-block validation. No build step.

**Scope boundary (single-branch discipline — Phase 5 owns only these files):**
- **Own (new or modified in this plan):** `node/src/image_content.mjs`, `node/src/self_frame.mjs`, `node/src/opus_client.mjs`, `node/src/packet_builder.mjs`, `node/canon/mood_board.json`, `node/canon/placeholders/*.svg`, `node/package.json`, `node/pnpm-lock.yaml`
- **Minimal hook only:** `node/src/run_spike.mjs` — single narrow self-frame capture hook at end-of-cycle; everything else untouched
- **Must NOT touch (parallel session owns):** `node/src/feature_bus.mjs`, `node/src/feature_replayer.mjs`, `python/stream_features.py`, `node/src/binding_easing.mjs`, `node/src/binding_engine.mjs`, `node/src/tool_handlers.mjs`, `node/src/scene_state.mjs`, `node/browser/scene_reducer.mjs`, `node/src/p5_sandbox.mjs`, `node/vendor/p5/*`, `node/src/stage_server.mjs`

**Phase 5 exit criterion (per spec §14):** real-API 3-cycle smoke with mood board loaded; cache-read metrics visible in `run_summary.json` on cycle 2+.

---

## File Structure (decisions locked here)

| File | New/Changed | Responsibility |
|---|---|---|
| `node/canon/mood_board.json` | New | Artist-swappable canon — 5 entries: `{path, role, label}`; paths relative to this file |
| `node/canon/placeholders/positive_01.svg` | New | Figurative miniature-painting-style human figure silhouette with ornamental border |
| `node/canon/placeholders/positive_02.svg` | New | Architectural interior — arched doorway with light wash |
| `node/canon/placeholders/positive_03.svg` | New | Calligraphic specimen — stylised letterform |
| `node/canon/placeholders/anchor_01.svg` | New | Mihrab niche silhouette — tradition anchor |
| `node/canon/placeholders/negative_01.svg` | New | Abstract flow-field / particle cloud — explicit "NOT this" reference |
| `node/src/image_content.mjs` | New | Pure content-block assembly: `loadMoodBoard`, `buildMoodBoardSystemBlocks`, `buildSelfFrameUserBlocks`, `shouldCaptureSelfFrame`, `summarizeSelfFrameMetadata` |
| `node/src/self_frame.mjs` | New | Playwright capturer — lazy-launch browser, navigate stage URL, wait for `body[data-stage-ready="1"]`, screenshot to PNG buffer; reuses warm page across captures; `.close()` for teardown |
| `node/src/opus_client.mjs` | Changed | Adds `thinking: {type: "adaptive"}` + `output_config: {effort: "medium"}` defaults; passes full packet through (including content-block arrays) to `messages.create` |
| `node/src/packet_builder.mjs` | Changed | `buildPacket` accepts `{moodBoardBlocks?, selfFrameUserBlocks?}`; when mood board present, system = `[hijaz_base, medium_rules, ...moodBoardBlocks, {text: "", cache_control: {type: "ephemeral"}}]`; messages[0].content = `[{type: "text", text: dynamic_user_text}, ...selfFrameUserBlocks]` |
| `node/src/run_spike.mjs` | Changed (narrow) | At startup: load mood board once, build system blocks, instantiate self-frame capturer. Per cycle: pass mood board + `pendingSelfFrameBlocks` into `buildPacket`. After `cycle.end` broadcast: evaluate `shouldCaptureSelfFrame`; on true, call `capturer.capture()` and stash for next cycle; increment `cyclesSinceLastImage`, reset it when cycle patches include image `element.add`. Graceful degradation: if any perception step throws, log a warning and proceed without the mood board or self-frame |
| `node/package.json` | Changed | Add `playwright` and `sharp` runtime deps |
| `node/pnpm-lock.yaml` | Changed | Regenerated |

---

## Task 1: Add playwright and sharp dependencies

**Files:**
- Modify: `node/package.json`, `node/pnpm-lock.yaml`

- [ ] **Step 1: Add runtime deps via pnpm**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node
pnpm add playwright sharp
```

Expected: `package.json` gains `"playwright"` and `"sharp"` under `dependencies`. pnpm-lock.yaml regenerated.

- [ ] **Step 2: Install Chromium binary (Playwright needs it at runtime)**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node
pnpm exec playwright install chromium
```

Expected: prints install location (typically `~/.cache/ms-playwright/chromium-<version>/`). No error.

- [ ] **Step 3: Smoke-check the modules resolve**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node
node -e "import('sharp').then(m => console.log('sharp OK', typeof m.default)).catch(e => { console.error(e); process.exit(1); })"
node -e "import('playwright').then(m => console.log('playwright OK', typeof m.chromium)).catch(e => { console.error(e); process.exit(1); })"
```

Expected: `sharp OK function` and `playwright OK object` on stdout. No stderr.

- [ ] **Step 4: Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike-phase-5 add node/package.json node/pnpm-lock.yaml
git -C /home/amay/Work/feed-looks-back-spike-phase-5 commit -m "chore(phase-5): add playwright and sharp for perception pipeline"
```

---

## Task 2: Author the 5 figurative SVG placeholders

**Files:**
- Create: `node/canon/placeholders/positive_01.svg`
- Create: `node/canon/placeholders/positive_02.svg`
- Create: `node/canon/placeholders/positive_03.svg`
- Create: `node/canon/placeholders/anchor_01.svg`
- Create: `node/canon/placeholders/negative_01.svg`

All SVGs are 500×500 viewBox, ochre-on-dark palette consistent with the stage's cream/amber house style, and depict **recognisable things** per the project aesthetic constraint (figurative, not abstract) — with `negative_01.svg` deliberately abstract as the "NOT this" reference.

- [ ] **Step 1: Create `positive_01.svg` — miniature painting, human figure with ornamental border**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" width="500" height="500">
  <rect width="500" height="500" fill="#1a1410"/>
  <rect x="20" y="20" width="460" height="460" fill="none" stroke="#e8c28e" stroke-width="2"/>
  <rect x="40" y="40" width="420" height="420" fill="none" stroke="#c49565" stroke-width="1"/>
  <g transform="translate(250 210)">
    <ellipse cx="0" cy="-60" rx="38" ry="46" fill="#e8c28e"/>
    <path d="M-70 60 C -70 20, -40 -10, 0 -10 C 40 -10, 70 20, 70 60 L 80 220 L -80 220 Z" fill="#c06b45"/>
    <path d="M-50 80 C -40 60, -20 55, 0 55 C 20 55, 40 60, 50 80 L 50 140 L -50 140 Z" fill="#8a4a2f"/>
    <circle cx="0" cy="-60" r="48" fill="none" stroke="#f2d7b2" stroke-width="1.5" opacity="0.7"/>
  </g>
  <g transform="translate(250 350)" stroke="#e8c28e" stroke-width="1.2" fill="none" opacity="0.8">
    <path d="M-120 0 C -80 -10, -40 -10, 0 0 C 40 10, 80 10, 120 0"/>
    <path d="M-120 18 C -80 8, -40 8, 0 18 C 40 28, 80 28, 120 18"/>
  </g>
</svg>
```

- [ ] **Step 2: Create `positive_02.svg` — architectural interior with arched doorway, light wash**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" width="500" height="500">
  <rect width="500" height="500" fill="#0f0b08"/>
  <defs>
    <linearGradient id="lightWash" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#f4d9bf" stop-opacity="0.85"/>
      <stop offset="0.6" stop-color="#e8c28e" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#1a1410" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="80" y="60" width="340" height="420" fill="#1a1410"/>
  <path d="M150 480 L150 220 C 150 150, 200 100, 250 100 C 300 100, 350 150, 350 220 L 350 480 Z"
        fill="url(#lightWash)"/>
  <path d="M150 480 L150 220 C 150 150, 200 100, 250 100 C 300 100, 350 150, 350 220 L 350 480"
        fill="none" stroke="#e8c28e" stroke-width="2.5"/>
  <line x1="80" y1="480" x2="420" y2="480" stroke="#c49565" stroke-width="2"/>
  <g stroke="#8a6a45" stroke-width="1" opacity="0.6">
    <line x1="100" y1="440" x2="400" y2="440"/>
    <line x1="100" y1="400" x2="400" y2="400"/>
    <line x1="100" y1="360" x2="400" y2="360"/>
  </g>
</svg>
```

- [ ] **Step 3: Create `positive_03.svg` — calligraphic specimen, stylised letterform**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" width="500" height="500">
  <rect width="500" height="500" fill="#1a1410"/>
  <g transform="translate(250 260)" fill="none" stroke="#f4d9bf" stroke-linecap="round" stroke-linejoin="round">
    <path d="M-140 20 C -120 80, -40 100, 40 60 C 100 30, 140 -40, 100 -90 C 70 -120, 20 -110, -10 -70 C -30 -40, -20 0, 20 20"
          stroke-width="18"/>
    <circle cx="-10" cy="-40" r="6" fill="#f4d9bf"/>
  </g>
  <g transform="translate(250 380)" stroke="#8a6a45" stroke-width="1" fill="none">
    <line x1="-140" y1="0" x2="140" y2="0"/>
    <line x1="-140" y1="6" x2="140" y2="6"/>
  </g>
  <g stroke="#6a4a30" stroke-width="0.6" fill="none" opacity="0.5">
    <line x1="100" y1="100" x2="400" y2="100"/>
    <line x1="100" y1="420" x2="400" y2="420"/>
  </g>
</svg>
```

- [ ] **Step 4: Create `anchor_01.svg` — mihrab niche silhouette**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" width="500" height="500">
  <rect width="500" height="500" fill="#0c0906"/>
  <path d="M120 480 L120 240 C 120 160, 180 100, 250 100 C 320 100, 380 160, 380 240 L 380 480 Z"
        fill="#1a1410" stroke="#e8c28e" stroke-width="3"/>
  <path d="M160 480 L160 260 C 160 200, 200 160, 250 160 C 300 160, 340 200, 340 260 L 340 480"
        fill="none" stroke="#c49565" stroke-width="1.5"/>
  <g transform="translate(250 300)" stroke="#e8c28e" stroke-width="2" fill="none">
    <line x1="0" y1="-50" x2="0" y2="150"/>
    <line x1="-50" y1="40" x2="50" y2="40"/>
    <line x1="-40" y1="100" x2="40" y2="100"/>
  </g>
  <line x1="100" y1="480" x2="400" y2="480" stroke="#c49565" stroke-width="2"/>
  <g stroke="#6a4a30" stroke-width="0.8" opacity="0.5">
    <line x1="100" y1="460" x2="400" y2="460"/>
    <line x1="100" y1="440" x2="400" y2="440"/>
  </g>
</svg>
```

- [ ] **Step 5: Create `negative_01.svg` — abstract flow field (explicit "NOT this")**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" width="500" height="500">
  <rect width="500" height="500" fill="#0a0a10"/>
  <g stroke="#4a6a8a" stroke-width="1" fill="none" opacity="0.7">
    <path d="M0 100 C 80 120, 160 80, 240 100 C 320 120, 400 80, 500 100"/>
    <path d="M0 140 C 80 160, 160 120, 240 140 C 320 160, 400 120, 500 140"/>
    <path d="M0 180 C 80 200, 160 160, 240 180 C 320 200, 400 160, 500 180"/>
    <path d="M0 220 C 80 240, 160 200, 240 220 C 320 240, 400 200, 500 220"/>
    <path d="M0 260 C 80 280, 160 240, 240 260 C 320 280, 400 240, 500 260"/>
    <path d="M0 300 C 80 320, 160 280, 240 300 C 320 320, 400 280, 500 300"/>
    <path d="M0 340 C 80 360, 160 320, 240 340 C 320 360, 400 320, 500 340"/>
    <path d="M0 380 C 80 400, 160 360, 240 380 C 320 400, 400 360, 500 380"/>
    <path d="M0 420 C 80 440, 160 400, 240 420 C 320 440, 400 400, 500 420"/>
  </g>
  <g fill="#6a8aaa" opacity="0.5">
    <circle cx="100" cy="150" r="3"/>
    <circle cx="240" cy="120" r="2"/>
    <circle cx="380" cy="180" r="4"/>
    <circle cx="160" cy="240" r="2"/>
    <circle cx="320" cy="280" r="3"/>
    <circle cx="140" cy="340" r="2"/>
    <circle cx="280" cy="380" r="3"/>
    <circle cx="420" cy="400" r="2"/>
  </g>
  <text x="250" y="470" text-anchor="middle" font-family="serif" font-size="16" fill="#8aa0c0" opacity="0.5">NOT THIS — abstract, no recognisable subject</text>
</svg>
```

- [ ] **Step 6: Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike-phase-5 add node/canon/placeholders/
git -C /home/amay/Work/feed-looks-back-spike-phase-5 commit -m "feat(canon): add 5 figurative SVG placeholders (3 positive + anchor + negative)"
```

---

## Task 3: Author `node/canon/mood_board.json`

**Files:**
- Create: `node/canon/mood_board.json`

- [ ] **Step 1: Write the JSON manifest**

```json
[
  {
    "path": "./placeholders/positive_01.svg",
    "role": "positive",
    "label": "figurative miniature painting — human figure with ornamental border; line weight, palette, rootedness in human form"
  },
  {
    "path": "./placeholders/positive_02.svg",
    "role": "positive",
    "label": "architectural interior photography — arched doorway with light wash; threshold as dramatic subject"
  },
  {
    "path": "./placeholders/positive_03.svg",
    "role": "positive",
    "label": "calligraphic specimen — letterform as image; the stroke itself as the subject"
  },
  {
    "path": "./placeholders/anchor_01.svg",
    "role": "anchor",
    "label": "mihrab niche silhouette — tradition anchor; the shape that says 'this tradition, this place'"
  },
  {
    "path": "./placeholders/negative_01.svg",
    "role": "negative",
    "label": "NOT this — generic AI generative-art aesthetic (abstract flow fields, pure particle composition, no recognisable subject)"
  }
]
```

- [ ] **Step 2: Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike-phase-5 add node/canon/mood_board.json
git -C /home/amay/Work/feed-looks-back-spike-phase-5 commit -m "feat(canon): add mood_board.json manifest referencing 5 placeholders"
```

---

## Task 4: `image_content.mjs` — mood-board loader + system-block builder

**Files:**
- Create: `node/src/image_content.mjs`
- Test: inline self-tests at the bottom of the same file (repo convention)

- [ ] **Step 1: Write the failing test**

Create `node/src/image_content.mjs` containing ONLY the self-test harness below (empty implementation for now — test must FAIL on first run). Use the repo's existing inline-test convention (see `packet_builder.mjs` sibling files for the style).

```javascript
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const NODE_ROOT = resolve(__dirname, "..");
const DEFAULT_MOOD_BOARD_PATH = join(NODE_ROOT, "canon", "mood_board.json");

export const MOOD_BOARD_MAX_EDGE_PX = 1568;      // Anthropic recommended max
export const MOOD_BOARD_MAX_BYTES = 5 * 1024 * 1024;
export const SUPPORTED_MEDIA_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// ... (implementation goes here; left empty to make tests fail first)

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
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

  await t("loadMoodBoard returns labelText + imageBlocks for the default canon", async () => {
    const result = await loadMoodBoard();
    assert.equal(typeof result.labelText, "string");
    assert.equal(Array.isArray(result.imageBlocks), true);
    assert.equal(result.imageBlocks.length, 5);
    for (const block of result.imageBlocks) {
      assert.equal(block.type, "image");
      assert.equal(block.source.type, "base64");
      assert.equal(block.source.media_type, "image/png");
      assert.equal(typeof block.source.data, "string");
      assert.equal(block.source.data.length > 0, true);
    }
  });

  await t("loadMoodBoard rasterises SVGs to PNG within the max-edge budget", async () => {
    const result = await loadMoodBoard();
    const firstBytes = Buffer.from(result.imageBlocks[0].source.data, "base64");
    const meta = await sharp(firstBytes).metadata();
    assert.equal(meta.format, "png");
    assert.ok(Math.max(meta.width, meta.height) <= MOOD_BOARD_MAX_EDGE_PX);
  });

  await t("loadMoodBoard labels each entry with role and caption", async () => {
    const result = await loadMoodBoard();
    assert.match(result.labelText, /positive/);
    assert.match(result.labelText, /anchor/);
    assert.match(result.labelText, /NOT this/);
  });

  await t("loadMoodBoard gracefully skips missing files and continues", async () => {
    const tmp = await import("node:fs/promises");
    const manifestPath = join(NODE_ROOT, "canon", "_test_broken_manifest.json");
    await tmp.writeFile(
      manifestPath,
      JSON.stringify([
        { path: "./placeholders/positive_01.svg", role: "positive", label: "real" },
        { path: "./placeholders/does_not_exist.svg", role: "negative", label: "missing" }
      ])
    );
    try {
      const warnings = [];
      const result = await loadMoodBoard({ manifestPath, logger: { warn: (m) => warnings.push(m) } });
      assert.equal(result.imageBlocks.length, 1);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /does_not_exist/);
    } finally {
      await tmp.unlink(manifestPath);
    }
  });

  await t("buildMoodBoardSystemBlocks appends cache breakpoint after images", async () => {
    const result = await loadMoodBoard();
    const blocks = buildMoodBoardSystemBlocks(result);
    assert.equal(blocks.length, 1 + 5 + 1);                       // label + 5 images + breakpoint
    assert.equal(blocks[0].type, "text");
    assert.equal(blocks[6].type, "text");
    assert.deepEqual(blocks[6].cache_control, { type: "ephemeral" });
    for (let i = 1; i <= 5; i += 1) assert.equal(blocks[i].type, "image");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node && node src/image_content.mjs
```

Expected: Multiple `FAIL` lines, `ReferenceError: loadMoodBoard is not defined` or similar. Exit code 1.

- [ ] **Step 3: Implement `loadMoodBoard` and `buildMoodBoardSystemBlocks`**

Replace the `// ... (implementation goes here; left empty)` placeholder with:

```javascript
function inferMediaType(path, buffer) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  // magic-byte sniff (best-effort)
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  return null;
}

async function rasteriseToPngBuffer(inputBuffer, maxEdgePx) {
  const image = sharp(inputBuffer);
  const meta = await image.metadata();
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (longEdge === 0) {
    throw new Error("image has zero dimensions");
  }
  const pipeline = longEdge > maxEdgePx
    ? image.resize({ width: meta.width >= meta.height ? maxEdgePx : null, height: meta.height > meta.width ? maxEdgePx : null, withoutEnlargement: true, fit: "inside" })
    : image;
  return await pipeline.png().toBuffer();
}

export async function loadMoodBoard({
  manifestPath = DEFAULT_MOOD_BOARD_PATH,
  logger = console,
  maxEdgePx = MOOD_BOARD_MAX_EDGE_PX,
  maxBytes = MOOD_BOARD_MAX_BYTES,
} = {}) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    logger.warn?.(`mood_board: failed to read manifest at ${manifestPath}: ${err.message}`);
    return { labelText: "", imageBlocks: [] };
  }
  if (!Array.isArray(manifest)) {
    logger.warn?.(`mood_board: manifest is not an array`);
    return { labelText: "", imageBlocks: [] };
  }

  const manifestDir = dirname(manifestPath);
  const imageBlocks = [];
  const labelLines = ["MOOD BOARD — reference images used to anchor the aesthetic for this performance. Each entry below carries a role and a caption; the image follows in order."];

  for (const entry of manifest) {
    if (!entry || typeof entry !== "object") continue;
    const { path: relPath, role, label } = entry;
    if (typeof relPath !== "string" || typeof role !== "string" || typeof label !== "string") {
      logger.warn?.(`mood_board: skipping malformed entry`);
      continue;
    }
    const absPath = resolve(manifestDir, relPath);
    let raw;
    try {
      raw = readFileSync(absPath);
    } catch (err) {
      logger.warn?.(`mood_board: skipping ${relPath} (${err.code ?? err.message})`);
      continue;
    }
    if (raw.length > maxBytes) {
      logger.warn?.(`mood_board: skipping ${relPath} — exceeds ${maxBytes} bytes`);
      continue;
    }
    const mediaType = inferMediaType(relPath, raw);
    if (!mediaType) {
      logger.warn?.(`mood_board: skipping ${relPath} — unrecognised media type`);
      continue;
    }
    const sharpInputAccepted = mediaType === "image/svg+xml" || SUPPORTED_MEDIA_TYPES.includes(mediaType);
    if (!sharpInputAccepted) {
      logger.warn?.(`mood_board: skipping ${relPath} — unsupported media type ${mediaType}`);
      continue;
    }

    let pngBuffer;
    try {
      pngBuffer = await rasteriseToPngBuffer(raw, maxEdgePx);
    } catch (err) {
      logger.warn?.(`mood_board: skipping ${relPath} — rasterise failed: ${err.message}`);
      continue;
    }
    imageBlocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: pngBuffer.toString("base64") }
    });
    labelLines.push(`- [${role}] ${label}`);
  }

  return {
    labelText: labelLines.join("\n"),
    imageBlocks,
  };
}

export function buildMoodBoardSystemBlocks({ labelText, imageBlocks }) {
  if (!imageBlocks || imageBlocks.length === 0) return [];
  return [
    { type: "text", text: labelText },
    ...imageBlocks,
    { type: "text", text: "", cache_control: { type: "ephemeral" } },
  ];
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node && node src/image_content.mjs
```

Expected: `5/5 passed`. No FAIL lines. Exit code 0.

- [ ] **Step 5: Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike-phase-5 add node/src/image_content.mjs
git -C /home/amay/Work/feed-looks-back-spike-phase-5 commit -m "feat(phase-5): mood-board loader with SVG→PNG rasterisation and cache breakpoint"
```

---

## Task 5: `image_content.mjs` — self-frame trigger evaluator

**Files:**
- Modify: `node/src/image_content.mjs`

- [ ] **Step 1: Add failing tests for `shouldCaptureSelfFrame`**

Append to the self-test block (before `process.stdout.write(\`\n${pass}/${pass + fail} passed\n\`)`):

```javascript
  t("shouldCaptureSelfFrame fires every 5th cycle as safety baseline", () => {
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 5, activeCount: 0, cyclesSinceLastImage: 0, hijazTahwilFired: false }), true);
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 10, activeCount: 0, cyclesSinceLastImage: 0, hijazTahwilFired: false }), true);
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 0, activeCount: 0, cyclesSinceLastImage: 0, hijazTahwilFired: false }), false);
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 1, activeCount: 0, cyclesSinceLastImage: 0, hijazTahwilFired: false }), false);
  });

  t("shouldCaptureSelfFrame fires when active_count > 8", () => {
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 2, activeCount: 9, cyclesSinceLastImage: 0, hijazTahwilFired: false }), true);
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 2, activeCount: 8, cyclesSinceLastImage: 0, hijazTahwilFired: false }), false);
  });

  t("shouldCaptureSelfFrame fires when cyclesSinceLastImage > 4", () => {
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 2, activeCount: 0, cyclesSinceLastImage: 5, hijazTahwilFired: false }), true);
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 2, activeCount: 0, cyclesSinceLastImage: 4, hijazTahwilFired: false }), false);
  });

  t("shouldCaptureSelfFrame fires when hijaz_tahwil_fired is true", () => {
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 2, activeCount: 0, cyclesSinceLastImage: 0, hijazTahwilFired: true }), true);
  });

  t("shouldCaptureSelfFrame combines triggers with OR, not AND", () => {
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 2, activeCount: 2, cyclesSinceLastImage: 0, hijazTahwilFired: false }), false);
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 5, activeCount: 2, cyclesSinceLastImage: 0, hijazTahwilFired: false }), true);
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node && node src/image_content.mjs
```

Expected: Five `FAIL` lines referencing `shouldCaptureSelfFrame is not defined`.

- [ ] **Step 3: Implement `shouldCaptureSelfFrame`**

Add to `image_content.mjs` (above the self-test block):

```javascript
export function shouldCaptureSelfFrame({
  cycleIndex,
  activeCount = 0,
  cyclesSinceLastImage = 0,
  hijazTahwilFired = false,
}) {
  if (hijazTahwilFired) return true;
  if (activeCount > 8) return true;
  if (cyclesSinceLastImage > 4) return true;
  // Every 5th cycle as safety baseline (spec §6.2): cycle 5, 10, 15, ...
  if (cycleIndex > 0 && cycleIndex % 5 === 0) return true;
  return false;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node && node src/image_content.mjs
```

Expected: `10/10 passed`.

- [ ] **Step 5: Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike-phase-5 add node/src/image_content.mjs
git -C /home/amay/Work/feed-looks-back-spike-phase-5 commit -m "feat(phase-5): self-frame trigger evaluator (every-5th + active-count + drought + tahwil)"
```

---

## Task 6: `image_content.mjs` — self-frame user-block builder

**Files:**
- Modify: `node/src/image_content.mjs`

- [ ] **Step 1: Add failing tests**

Append to the self-test block:

```javascript
  t("buildSelfFrameUserBlocks emits a caption then an image block", () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const blocks = buildSelfFrameUserBlocks({
      pngBuffer: fakePng,
      metadata: { previousCycleIndex: 5, activeCount: 6, dominantType: "text", backgroundAgeS: 18 },
    });
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, "text");
    assert.match(blocks[0].text, /Previous frame.*cycle 5/);
    assert.match(blocks[0].text, /Elements=6/);
    assert.match(blocks[0].text, /dominant=text/);
    assert.match(blocks[0].text, /background_age=18/);
    assert.equal(blocks[1].type, "image");
    assert.equal(blocks[1].source.type, "base64");
    assert.equal(blocks[1].source.media_type, "image/png");
    const roundTripped = Buffer.from(blocks[1].source.data, "base64");
    assert.deepEqual([...roundTripped.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  t("buildSelfFrameUserBlocks returns empty array when pngBuffer is null", () => {
    assert.deepEqual(buildSelfFrameUserBlocks({ pngBuffer: null, metadata: {} }), []);
  });

  t("buildSelfFrameUserBlocks does NOT attach cache_control to either block", () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const blocks = buildSelfFrameUserBlocks({
      pngBuffer: fakePng,
      metadata: { previousCycleIndex: 2, activeCount: 0, dominantType: "none", backgroundAgeS: 0 },
    });
    for (const b of blocks) assert.equal(b.cache_control, undefined);
  });
```

- [ ] **Step 2: Run tests → FAIL**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node && node src/image_content.mjs
```

- [ ] **Step 3: Implement `buildSelfFrameUserBlocks`**

Add to `image_content.mjs`:

```javascript
function formatSelfFrameCaption({ previousCycleIndex, activeCount, dominantType, backgroundAgeS }) {
  const parts = [
    `Previous frame (cycle ${previousCycleIndex}).`,
    `Elements=${activeCount}`,
    `dominant=${dominantType ?? "none"}`,
    `background_age=${backgroundAgeS ?? 0}s.`,
    `Adjust if composition needs attention.`,
  ];
  return parts.join(" ");
}

export function buildSelfFrameUserBlocks({ pngBuffer, metadata }) {
  if (!pngBuffer || pngBuffer.length === 0) return [];
  return [
    { type: "text", text: formatSelfFrameCaption(metadata ?? {}) },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: pngBuffer.toString("base64") }
    },
  ];
}
```

- [ ] **Step 4: Run tests → PASS**

Expected: `13/13 passed`.

- [ ] **Step 5: Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike-phase-5 add node/src/image_content.mjs
git -C /home/amay/Work/feed-looks-back-spike-phase-5 commit -m "feat(phase-5): self-frame user-block builder with caption metadata"
```

---

## Task 7: `self_frame.mjs` — Playwright capturer

**Files:**
- Create: `node/src/self_frame.mjs`
- Test: inline self-test using a loopback HTTP server serving a fixture HTML that sets `data-stage-ready="1"`

- [ ] **Step 1: Write the failing test (empty impl placeholder)**

Create `node/src/self_frame.mjs`:

```javascript
import { chromium } from "playwright";

// ... (implementation goes here; empty to make tests fail first)

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const http = await import("node:http");

  let pass = 0;
  let fail = 0;
  async function t(desc, fn) {
    try {
      await fn();
      pass += 1;
      process.stdout.write(`  ok  ${desc}\n`);
    } catch (err) {
      fail += 1;
      process.stdout.write(`  FAIL ${desc}\n    ${err.stack ?? err.message}\n`);
    }
  }

  const READY_HTML = `<!doctype html><html><body data-stage-ready="1" style="background:#123456">
    <div style="width:100px;height:100px;background:#abcdef"></div>
  </body></html>`;
  const DELAYED_HTML = `<!doctype html><html><body style="background:#000">
    <script>setTimeout(() => document.body.setAttribute("data-stage-ready","1"), 200);</script>
  </body></html>`;
  const STUCK_HTML = `<!doctype html><html><body style="background:#000"></body></html>`;

  function startServer(html) {
    return new Promise((resolvePromise) => {
      const server = http.createServer((req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(html);
      });
      server.listen(0, "127.0.0.1", () => resolvePromise(server));
    });
  }

  await t("captures a PNG when data-stage-ready is already set on load", async () => {
    const server = await startServer(READY_HTML);
    const port = server.address().port;
    const capturer = createSelfFrameCapturer({ stageUrl: `http://127.0.0.1:${port}/` });
    try {
      const png = await capturer.capture();
      assert.equal(Buffer.isBuffer(png), true);
      assert.equal(png.length > 500, true);
      assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    } finally {
      await capturer.close();
      server.close();
    }
  });

  await t("waits for data-stage-ready to flip then captures", async () => {
    const server = await startServer(DELAYED_HTML);
    const port = server.address().port;
    const capturer = createSelfFrameCapturer({ stageUrl: `http://127.0.0.1:${port}/` });
    try {
      const png = await capturer.capture();
      assert.equal(Buffer.isBuffer(png), true);
      assert.equal(png.length > 500, true);
    } finally {
      await capturer.close();
      server.close();
    }
  });

  await t("throws a specific error on ready-state timeout", async () => {
    const server = await startServer(STUCK_HTML);
    const port = server.address().port;
    const capturer = createSelfFrameCapturer({ stageUrl: `http://127.0.0.1:${port}/`, readyTimeoutMs: 800 });
    try {
      await assert.rejects(() => capturer.capture(), /data-stage-ready/);
    } finally {
      await capturer.close();
      server.close();
    }
  });

  await t("close() is idempotent and safe before any capture", async () => {
    const capturer = createSelfFrameCapturer({ stageUrl: "http://127.0.0.1:1/" });
    await capturer.close();
    await capturer.close();                                      // second close must not throw
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
```

- [ ] **Step 2: Run tests → FAIL**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node && node src/self_frame.mjs
```

Expected: multiple FAIL lines (`createSelfFrameCapturer is not defined`).

- [ ] **Step 3: Implement the capturer (warm-page reuse)**

Replace the `// ... (implementation goes here; empty)` placeholder with:

```javascript
const DEFAULT_READY_SELECTOR = "body[data-stage-ready=\"1\"]";
const DEFAULT_READY_TIMEOUT_MS = 6000;
const DEFAULT_NAV_TIMEOUT_MS = 10000;

export function createSelfFrameCapturer({
  stageUrl,
  readySelector = DEFAULT_READY_SELECTOR,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  navTimeoutMs = DEFAULT_NAV_TIMEOUT_MS,
  chromiumImpl = chromium,
  logger = console,
} = {}) {
  if (!stageUrl) throw new Error("stageUrl is required");

  let browser = null;
  let context = null;
  let page = null;
  let navigationPromise = null;
  let closed = false;

  async function ensureBrowser() {
    if (closed) throw new Error("capturer closed");
    if (browser) return;
    browser = await chromiumImpl.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
  }

  async function ensureNavigated() {
    if (!navigationPromise) {
      navigationPromise = (async () => {
        await page.goto(stageUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs });
      })();
    }
    await navigationPromise;
  }

  async function capture() {
    await ensureBrowser();
    await ensureNavigated();
    try {
      await page.waitForSelector(readySelector, { timeout: readyTimeoutMs, state: "attached" });
    } catch (err) {
      throw new Error(`data-stage-ready not set within ${readyTimeoutMs}ms: ${err.message}`);
    }
    return await page.screenshot({ type: "png", fullPage: false });
  }

  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (page) await page.close().catch((e) => logger.warn?.(`self_frame: page close: ${e.message}`));
      if (context) await context.close().catch((e) => logger.warn?.(`self_frame: context close: ${e.message}`));
      if (browser) await browser.close().catch((e) => logger.warn?.(`self_frame: browser close: ${e.message}`));
    } finally {
      page = null;
      context = null;
      browser = null;
      navigationPromise = null;
    }
  }

  return { capture, close };
}
```

- [ ] **Step 4: Run tests → PASS**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node && node src/self_frame.mjs
```

Expected: `4/4 passed`.

**Note:** This test requires Chromium at `~/.cache/ms-playwright/` — Task 1 step 2 handled that. If Playwright fails to launch (sandbox errors on restrictive systems), see `playwright` docs for the `--no-sandbox` arg — but not needed on typical Linux dev environments.

- [ ] **Step 5: Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike-phase-5 add node/src/self_frame.mjs
git -C /home/amay/Work/feed-looks-back-spike-phase-5 commit -m "feat(phase-5): Playwright self-frame capturer with warm-page reuse"
```

---

## Task 8: `opus_client.mjs` — adaptive thinking + effort defaults + content-block pass-through

**Files:**
- Modify: `node/src/opus_client.mjs`
- Add: inline self-tests (currently absent from this module)

- [ ] **Step 1: Write the failing tests**

Replace the entire current `node/src/opus_client.mjs` with the structure below (keep imports + current exports; *add* a self-test block that fails until implementation is updated):

```javascript
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_THINKING = Object.freeze({ type: "adaptive" });
export const DEFAULT_OUTPUT_CONFIG = Object.freeze({ effort: "medium" });

export function makeOpusClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "sk-ant-your-key-here") {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Create node/.env from .env.example and fill in your key.",
    );
  }
  return new Anthropic({
    apiKey,
    maxRetries: 5,
  });
}

export function resolveModel() {
  return process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
}

export async function callOpus(client, packet) {
  const {
    model,
    max_tokens,
    system,
    tools,
    messages,
    thinking = DEFAULT_THINKING,
    output_config = DEFAULT_OUTPUT_CONFIG,
  } = packet;
  const params = { model, max_tokens, system, tools, messages };
  if (thinking) params.thinking = thinking;
  if (output_config) params.output_config = output_config;
  try {
    return await client.messages.create(params);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error(`Auth error: ${err.message}. Check ANTHROPIC_API_KEY.`);
    }
    if (err instanceof Anthropic.BadRequestError) {
      throw new Error(`Bad request (400): ${err.message}. Packet shape is wrong; not retrying.`);
    }
    if (err instanceof Anthropic.NotFoundError) {
      throw new Error(`Not found (404): ${err.message}. Likely an invalid model id: ${model}.`);
    }
    throw err;
  }
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
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

  await t("resolveModel defaults to claude-opus-4-7 when env var is unset", () => {
    const saved = process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    try {
      assert.equal(resolveModel(), "claude-opus-4-7");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_MODEL = saved;
    }
  });

  await t("makeOpusClient rejects a missing key", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      assert.throws(() => makeOpusClient(), /ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  await t("callOpus passes thinking and output_config to messages.create by default", async () => {
    const calls = [];
    const fakeClient = { messages: { create: async (params) => { calls.push(params); return { id: "msg", content: [] }; } } };
    await callOpus(fakeClient, {
      model: "claude-opus-4-7",
      max_tokens: 1024,
      system: [{ type: "text", text: "sys" }],
      tools: [],
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].thinking, { type: "adaptive" });
    assert.deepEqual(calls[0].output_config, { effort: "medium" });
  });

  await t("callOpus honours explicit overrides", async () => {
    const calls = [];
    const fakeClient = { messages: { create: async (params) => { calls.push(params); return { id: "msg", content: [] }; } } };
    await callOpus(fakeClient, {
      model: "claude-opus-4-7",
      max_tokens: 1024,
      system: [{ type: "text", text: "sys" }],
      tools: [],
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
      output_config: { effort: "high" },
    });
    assert.deepEqual(calls[0].thinking, { type: "disabled" });
    assert.deepEqual(calls[0].output_config, { effort: "high" });
  });

  await t("callOpus passes content-block system arrays through unchanged", async () => {
    const calls = [];
    const fakeClient = { messages: { create: async (params) => { calls.push(params); return { id: "msg", content: [] }; } } };
    const systemBlocks = [
      { type: "text", text: "base" },
      { type: "text", text: "rules" },
      { type: "text", text: "mood label" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } },
      { type: "text", text: "", cache_control: { type: "ephemeral" } },
    ];
    await callOpus(fakeClient, {
      model: "claude-opus-4-7",
      max_tokens: 1024,
      system: systemBlocks,
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    });
    assert.deepStrictEqual(calls[0].system, systemBlocks);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
```

- [ ] **Step 2: Run tests to confirm they pass**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node && node src/opus_client.mjs
```

Expected: `5/5 passed`. (The above already contains the implementation; test-first shape is preserved within the same commit — failing state would have been the missing `thinking` / `output_config` fields in the old version.)

**Rationale:** keeping `medium` effort matches the spec §5.1 ("thinking: adaptive + output_config.effort: medium (lifted from scaffold adapter)"). Spec author locked this value — do not change without explicit go-ahead.

- [ ] **Step 3: Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike-phase-5 add node/src/opus_client.mjs
git -C /home/amay/Work/feed-looks-back-spike-phase-5 commit -m "feat(phase-5): opus_client gains adaptive thinking + effort defaults + block pass-through"
```

---

## Task 9: `packet_builder.mjs` — content-block assembly + cache breakpoint placement

**Files:**
- Modify: `node/src/packet_builder.mjs`

- [ ] **Step 1: Write the failing tests (add self-test block — currently absent)**

Replace `node/src/packet_builder.mjs` with:

```javascript
export function formatEmptySceneStateSummary(elapsedTotalS) {
  return (
    `Current scene (0 elements visible, ${elapsedTotalS}s since performance start):\n\n` +
    `(empty — nothing has been placed yet)\n\nBACKGROUND: (not set)`
  );
}

function stripDebug(cycle) {
  const { _debug, ...rest } = cycle;
  return rest;
}

function formatUserMessage(cycle, sceneStateSummary) {
  const block1 = JSON.stringify(cycle.block_1_scalars, null, 2);
  const block2 = cycle.block_2_summary;
  const sparks = cycle.block_3_sparklines;
  const { rms, onset, centroid } = sparks;

  return [
    `You are receiving cycle ${cycle.cycle_index} of the performance.`,
    ``,
    `BLOCK 1 — SCALAR SUMMARY (last 4 seconds):`,
    block1,
    ``,
    `BLOCK 2 — DETERMINISTIC PROSE CAPTION:`,
    block2,
    ``,
    `BLOCK 3 — SPARKLINES:`,
    `RMS:      ${rms}`,
    `Onsets:   ${onset}`,
    `Centroid: ${centroid}`,
    ``,
    `CURRENT SCENE STATE:`,
    sceneStateSummary,
    ``,
    `Decide what to do, and act with the tools. You may call zero, one, or several tools. If silence is the right answer, call no tools.`,
  ].join("\n");
}

export function buildPacket({
  cycle,
  sceneStateSummary,
  hijazBase,
  mediumRules,
  tools,
  model,
  maxTokens = 4000,
  moodBoardBlocks = [],
  selfFrameUserBlocks = [],
}) {
  const cleanCycle = stripDebug(cycle);
  const userText = formatUserMessage(cleanCycle, sceneStateSummary);

  // When mood-board blocks are present, the cache breakpoint moves from the
  // medium_rules text block to a trailing empty block *after* the mood-board
  // images, so tools + all three text blocks + images are cached together.
  // When absent, preserve the prior placement for backwards compatibility
  // with the 131 baseline tests.
  const hasMoodBoard = Array.isArray(moodBoardBlocks) && moodBoardBlocks.length > 0;
  const system = hasMoodBoard
    ? [
        { type: "text", text: hijazBase },
        { type: "text", text: mediumRules },
        ...moodBoardBlocks,                                       // already terminates with cache_control breakpoint
      ]
    : [
        { type: "text", text: hijazBase },
        { type: "text", text: mediumRules, cache_control: { type: "ephemeral" } },
      ];

  const userContent = selfFrameUserBlocks.length === 0
    ? userText
    : [{ type: "text", text: userText }, ...selfFrameUserBlocks];

  return {
    model,
    max_tokens: maxTokens,
    system,
    tools,
    messages: [
      { role: "user", content: userContent },
    ],
  };
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

  const fakeCycle = {
    cycle_index: 3,
    block_1_scalars: { rms: 0.1, onset: 0.2, centroid: 2000 },
    block_2_summary: "soft murmur",
    block_3_sparklines: { rms: "▁▂▃", onset: "▁▁▂", centroid: "▃▄▅" },
  };

  t("without mood board, buildPacket preserves 2-block system with cache_control on medium_rules (backwards compatible)", () => {
    const packet = buildPacket({
      cycle: fakeCycle,
      sceneStateSummary: "empty",
      hijazBase: "BASE",
      mediumRules: "RULES",
      tools: [],
      model: "m",
    });
    assert.equal(packet.system.length, 2);
    assert.equal(packet.system[0].text, "BASE");
    assert.equal(packet.system[1].text, "RULES");
    assert.deepEqual(packet.system[1].cache_control, { type: "ephemeral" });
    assert.equal(typeof packet.messages[0].content, "string");
  });

  t("with mood board, buildPacket appends mood-board blocks and ends on cache breakpoint", () => {
    const moodBoardBlocks = [
      { type: "text", text: "MOOD BOARD — ..." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
      { type: "text", text: "", cache_control: { type: "ephemeral" } },
    ];
    const packet = buildPacket({
      cycle: fakeCycle,
      sceneStateSummary: "empty",
      hijazBase: "BASE",
      mediumRules: "RULES",
      tools: [],
      model: "m",
      moodBoardBlocks,
    });
    assert.equal(packet.system.length, 2 + moodBoardBlocks.length);
    assert.equal(packet.system[0].text, "BASE");
    assert.equal(packet.system[1].text, "RULES");
    assert.equal(packet.system[1].cache_control, undefined);
    assert.deepEqual(packet.system.at(-1).cache_control, { type: "ephemeral" });
  });

  t("with self-frame user blocks, messages[0].content becomes a content-block array with text first", () => {
    const selfFrameUserBlocks = [
      { type: "text", text: "Previous frame ..." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "CCCC" } },
    ];
    const packet = buildPacket({
      cycle: fakeCycle,
      sceneStateSummary: "empty",
      hijazBase: "BASE",
      mediumRules: "RULES",
      tools: [],
      model: "m",
      selfFrameUserBlocks,
    });
    assert.equal(Array.isArray(packet.messages[0].content), true);
    assert.equal(packet.messages[0].content[0].type, "text");
    assert.equal(packet.messages[0].content[1].type, "text");                  // caption
    assert.equal(packet.messages[0].content[2].type, "image");
  });

  t("full composition: mood board + self-frame renders both correctly", () => {
    const packet = buildPacket({
      cycle: fakeCycle,
      sceneStateSummary: "empty",
      hijazBase: "BASE",
      mediumRules: "RULES",
      tools: [],
      model: "m",
      moodBoardBlocks: [
        { type: "text", text: "MB" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "XX" } },
        { type: "text", text: "", cache_control: { type: "ephemeral" } },
      ],
      selfFrameUserBlocks: [
        { type: "text", text: "Previous frame (cycle 2)" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "YY" } },
      ],
    });
    assert.deepEqual(packet.system.at(-1).cache_control, { type: "ephemeral" });
    assert.equal(packet.messages[0].content.length, 3);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
```

- [ ] **Step 2: Run tests → PASS**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node && node src/packet_builder.mjs
```

Expected: `4/4 passed`.

- [ ] **Step 3: Verify downstream modules still pass with the new default parameters**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node && node src/run_spike.mjs --self-test
```

Expected: same 4/4 pass as baseline (run_spike passes no `moodBoardBlocks` / `selfFrameUserBlocks`, so the backwards-compatible branch activates).

- [ ] **Step 4: Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike-phase-5 add node/src/packet_builder.mjs
git -C /home/amay/Work/feed-looks-back-spike-phase-5 commit -m "feat(phase-5): packet_builder assembles mood-board + self-frame content blocks"
```

---

## Task 10: `run_spike.mjs` — narrow end-of-cycle self-frame hook + mood-board bootstrap

**Files:**
- Modify: `node/src/run_spike.mjs`

The hook is **narrow**: it loads the mood board once at startup, tracks two counters per run, calls `shouldCaptureSelfFrame` after each `cycle.end` broadcast, stashes the PNG for the next packet. No changes to the existing cycle-processing path beyond threading two new packet params.

- [ ] **Step 1: Add imports + mood-board bootstrap near the top of the run function**

Locate the top of `run_spike.mjs` (imports block). Add these two imports alongside the existing `buildPacket`, `callOpus`, etc.:

```javascript
import { loadMoodBoard, buildMoodBoardSystemBlocks, shouldCaptureSelfFrame, buildSelfFrameUserBlocks } from "./image_content.mjs";
import { createSelfFrameCapturer } from "./self_frame.mjs";
```

Locate where `stageServer = await createStageServerImpl()` is called (around line 645). Immediately after that block, add:

```javascript
    // Phase 5 — Perception bootstrap. Any failure degrades gracefully to no-mood-board.
    let moodBoardBlocks = [];
    try {
      const mb = await loadMoodBoard();
      moodBoardBlocks = buildMoodBoardSystemBlocks(mb);
      if (moodBoardBlocks.length > 0) {
        process.stdout.write(`Mood board loaded: ${mb.imageBlocks.length} images.\n`);
      }
    } catch (err) {
      process.stdout.write(`WARN: mood board load failed: ${err.message}\n`);
    }
    const selfFrameCapturer = createSelfFrameCapturerImpl({ stageUrl: operatorUrl });
    let pendingSelfFrameBlocks = [];
    let cyclesSinceLastImage = 0;
    let lastSelfFrameErrorAt = -Infinity;
```

Add a `createSelfFrameCapturerImpl` parameter to the `run` function signature (default to the real one, override in tests):

```javascript
export async function run({
  /* ... existing params ... */,
  createStageServerImpl = createStageServer,
  createSelfFrameCapturerImpl = createSelfFrameCapturer,
} = {}) {
```

- [ ] **Step 2: Thread the two new packet params into `buildPacket`**

In the per-cycle loop (around line 727), update the `buildPacket` call:

```javascript
        packet = buildPacket({
          cycle,
          sceneStateSummary: formatSummary(state),
          hijazBase,
          mediumRules,
          tools,
          model,
          moodBoardBlocks,
          selfFrameUserBlocks: pendingSelfFrameBlocks,
        });
        pendingSelfFrameBlocks = [];                              // consumed — reset after use
```

- [ ] **Step 3: Add the self-frame evaluation + capture hook immediately after each `cycle.end` broadcast**

Two `cycle.end` broadcasts exist (lines 811 and 819 — happy path and catch block). Add this same block of code IMMEDIATELY AFTER each one:

```javascript
        // Phase 5 — evaluate self-frame triggers and capture for the next cycle's packet.
        try {
          const cyclePatches = cycleResult.patches ?? [];
          const anImageWasAdded = cyclePatches.some(
            (p) => p?.type === "element.add" && p?.element?.type === "image"
          );
          if (anImageWasAdded) {
            cyclesSinceLastImage = 0;
          } else {
            cyclesSinceLastImage += 1;
          }
          const hijazTahwilFired = Boolean(cycle?.hijaz_state?.tahwil_fired);
          const triggered = shouldCaptureSelfFrame({
            cycleIndex: cycle?.cycle_index ?? c.index,
            activeCount,
            cyclesSinceLastImage,
            hijazTahwilFired,
          });
          if (triggered) {
            const pngBuffer = await selfFrameCapturer.capture();
            pendingSelfFrameBlocks = buildSelfFrameUserBlocks({
              pngBuffer,
              metadata: {
                previousCycleIndex: cycle?.cycle_index ?? c.index,
                activeCount,
                dominantType: null,
                backgroundAgeS: 0,
              },
            });
          }
        } catch (err) {
          // Don't crash the run on a bad capture; warn and proceed.
          const now = Date.now();
          if (now - lastSelfFrameErrorAt > 5000) {
            process.stdout.write(`WARN: self-frame capture failed: ${err.message}\n`);
            lastSelfFrameErrorAt = now;
          }
          pendingSelfFrameBlocks = [];
        }
```

- [ ] **Step 4: Add teardown after `stageServer.close()` (around line 908)**

```javascript
    await stageServer.close();
    try { await selfFrameCapturer.close(); } catch (err) { process.stdout.write(`WARN: self-frame capturer close: ${err.message}\n`); }
```

- [ ] **Step 5: Extend the `run_spike.mjs` inline self-tests to cover the hook**

Locate the existing self-test block. Add a test that verifies the hook's behaviour without launching real Playwright (use an injected mock capturer):

```javascript
  await t("run invokes self-frame capturer on trigger cycles and resets image drought", async () => {
    const capturedCycles = [];
    const mockCapturer = {
      capture: async () => {
        capturedCycles.push("captured");
        return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      },
      close: async () => {},
    };
    const createMockCapturer = () => mockCapturer;

    /* existing fixtures: 5 cycles that produce no image elements. The 5th cycle
       should trigger shouldCaptureSelfFrame on every-5th-cycle safety baseline. */
    /* (use the same scaffold the existing tests already use — look at the nearest
       existing "run finalizes partial artifacts ..." test for cycle-JSON fixture setup.) */

    const result = await run({
      /* ... fill from nearest existing test setup ... */,
      createSelfFrameCapturerImpl: createMockCapturer,
    });
    assert.ok(capturedCycles.length >= 1, `expected at least 1 capture, got ${capturedCycles.length}`);
  });
```

**Implementation note:** mirror the existing self-test setup exactly — don't invent new fixtures. If the existing tests load cycles from a temp dir, do the same; if they inject `callOpusImpl`, `applyToolCallDetailedImpl`, `fetchImageImpl`, etc., inject all of them. The new test adds `createSelfFrameCapturerImpl` on top of whatever the existing "finalizes partial artifacts" test passes.

- [ ] **Step 6: Run tests**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node && node src/run_spike.mjs --self-test
```

Expected: the baseline 4 tests + 1 new test pass (5/5).

- [ ] **Step 7: Commit**

```bash
git -C /home/amay/Work/feed-looks-back-spike-phase-5 add node/src/run_spike.mjs
git -C /home/amay/Work/feed-looks-back-spike-phase-5 commit -m "feat(phase-5): run_spike hooks mood board + self-frame capture into cycle loop"
```

---

## Task 11: Full-suite regression check

**Files:** none modified

- [ ] **Step 1: Run every module's inline tests**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node
for f in \
  src/scene_state.mjs src/tool_handlers.mjs src/patch_protocol.mjs src/patch_emitter.mjs \
  src/patch_cache.mjs src/stage_server.mjs src/sanitize.mjs src/image_resolver.mjs \
  src/operator_views.mjs src/scene_layout.mjs src/packet_builder.mjs src/opus_client.mjs \
  src/image_fetch.mjs src/image_content.mjs src/self_frame.mjs \
  browser/bootstrap.mjs browser/scene_reducer.mjs browser/ws_client.mjs; do
  printf "=== %s ===\n" "$f"
  node "$f" 2>&1 | tail -2
done
node src/run_spike.mjs --self-test 2>&1 | tail -3
```

Expected: **all modules green, no FAIL lines.** Count should be ≥ 131 (baseline) + new perception tests (target ~13 new: loadMoodBoard×4, shouldCaptureSelfFrame×5, buildSelfFrameUserBlocks×3, buildMoodBoardSystemBlocks×1 in image_content; captureSelfFrame×4 in self_frame; opus_client×5; packet_builder×4; run_spike×1) → ~150 or more.

- [ ] **Step 2: Dry-run 3-cycle smoke**

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node && ANTHROPIC_API_KEY="dummy" node src/run_spike.mjs ../corpus --config config_a --dry-run --cycles 0:3 2>&1 | tail -40
```

Expected: stdout shows `Mood board loaded: 5 images.` near startup; three cycle status lines; `run_summary.json` written under `output/run_<timestamp>/`. No "WARN: self-frame capture failed" on cycles 0-2 (no triggers fire that early unless drought kicks in at 5-cycle step which it won't here).

- [ ] **Step 3: (Optional, user-authorised) real-API 3-cycle smoke to verify cache metrics**

This step costs ~$0.05 in Opus credit. Only run if authorised:

```bash
cd /home/amay/Work/feed-looks-back-spike-phase-5/node && node src/run_spike.mjs ../corpus --config config_a --cycles 0:3 2>&1 | tail -60
```

Expected: cycle 1 shows high input token usage (mood-board written to cache); cycle 2 shows `cache_read_input_tokens > 0` in `run_summary.json` (cache hit). No self-frame triggers on cycles 0-2 (drought + every-5th not yet met) — this is fine; the exit criterion is cache-read metrics, not self-frame.

- [ ] **Step 4: No commit unless step 2 or step 3 revealed a regression** (in which case, fix and commit one more time with a concrete message)

---

## Task 12: Prepare for Codex review

**Files:** none modified — this is a prep task

- [ ] **Step 1: Collect branch state**

```bash
git -C /home/amay/Work/feed-looks-back-spike-phase-5 fetch origin
git -C /home/amay/Work/feed-looks-back-spike-phase-5 log --oneline main..phase-5
git -C /home/amay/Work/feed-looks-back-spike-phase-5 diff --stat main...phase-5
```

- [ ] **Step 2: Re-run the full test matrix and capture output**

Run the Task 11 step 1 command. Save output for the phase-gate message.

- [ ] **Step 3: Write the phase-gate message to the user**

Include: (a) commit range, (b) file summary (9 new + 3 modified + `package.json`/lockfile), (c) test counts (baseline → new total), (d) what was verified (mood-board loaded, self-frame capture works against a fixture, cache breakpoint placement), (e) what was NOT verified (real-API cache metrics unless user ran step 3 of Task 11). Request Codex review.

---

## Self-Review Checklist (run before declaring plan complete)

**1. Spec coverage:** Every spec §6 bullet is covered by a task:
- ✅ Mood board JSON + 5 figurative placeholders → Tasks 2, 3
- ✅ `image_content.mjs` loader + content-block assembly → Tasks 4, 6
- ✅ Cache-breakpoint placement after mood-board images → Tasks 4, 9
- ✅ Self-frame triggers (hijaz_tahwil, element_count, cycles_since_last_image, every-5th) → Task 5
- ✅ Playwright capture + warm-page reuse + data-stage-ready wait → Task 7
- ✅ `opus_client.mjs` adaptive thinking + effort=medium → Task 8
- ✅ `run_spike.mjs` narrow end-of-cycle hook → Task 10
- ✅ Exit criterion: cache-read metrics on cycle 2+ → Task 11 step 3 (optional real-API smoke)

**2. Placeholder scan:** No `TBD`, `TODO`, `implement later`, or `similar to Task N` remain. The `/* fill from nearest existing test setup */` marker in Task 10 Step 5 is deliberate — the existing `run_spike.mjs` self-tests have non-trivial fixture setup that's faithfully reproducible only by looking at the existing code, and copying it here would double the plan size without adding value. Implementer must `grep -n '"run finalizes partial artifacts"' src/run_spike.mjs` and mirror.

**3. Type consistency:**
- `loadMoodBoard()` returns `{ labelText, imageBlocks }` everywhere (Tasks 4, 5, 9, 10)
- `buildMoodBoardSystemBlocks(moodBoard)` takes that shape, returns array — used in Tasks 4, 10
- `shouldCaptureSelfFrame({cycleIndex, activeCount, cyclesSinceLastImage, hijazTahwilFired})` signature consistent across Tasks 5, 10
- `createSelfFrameCapturer({stageUrl, readyTimeoutMs, navTimeoutMs, chromiumImpl, logger})` returns `{capture, close}` — consistent across Tasks 7, 10
- `buildSelfFrameUserBlocks({pngBuffer, metadata})` returns array of blocks — consistent across Tasks 6, 10
- `buildPacket` new params: `moodBoardBlocks` (array), `selfFrameUserBlocks` (array), both default `[]` — consistent across Tasks 9, 10
- `callOpus(client, packet)` accepts `thinking` + `output_config` in the packet — consistent across Tasks 8, 9

**4. Risk call-outs for implementer:**
- Playwright's Chromium download (Task 1 Step 2) is ~170MB one-time; if it's already cached, the command is a no-op.
- `sharp` has a native binding — if `pnpm install` fails on `sharp`, investigate root cause (likely missing `libvips-dev` on Linux — document in the phase-gate message; do not silently skip).
- On headless-Chromium sandbox failures, try `chromiumImpl.launch({ headless: true, args: ['--no-sandbox'] })` **only after** verifying the underlying sandbox permission is actually missing. Never default `--no-sandbox` on; it's a security downgrade.
- `run_spike.mjs` is a 1300-line file with intricate self-test scaffolding; the Task 10 Step 5 test is the trickiest. If the existing fixture pattern is opaque, prefer adding **one** integration test to Task 11 rather than expanding the self-test block, and keep the hook's unit behaviour tested in `image_content.mjs` where the logic lives.
- Parallel session may rebase or force-push `main`; if your tests start failing after a `git fetch origin`, run `git -C ... rebase origin/main` before blaming your own code.

---

## Execution Handoff

Plan complete and saved to `/home/amay/Work/feed-looks-back-spike-phase-5/docs/superpowers/plans/2026-04-24-session-i-phase-5-perception-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, catch regressions early. Good fit here because Tasks 2 (SVG authoring), 4-6 (image_content), 7 (Playwright), and 10 (run_spike hook) are genuinely independent.
2. **Inline Execution** — run tasks in this session using superpowers:executing-plans, batch with checkpoints at Task 6, 9, and 11.

This session will proceed with **Inline Execution** (superpowers:executing-plans) since the user authorised autonomous work and the tasks are tightly sequential (each file is small and depends on the prior).
