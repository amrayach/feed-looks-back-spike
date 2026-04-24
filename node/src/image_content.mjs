import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_ROOT = resolve(__dirname, "..");
const DEFAULT_MOOD_BOARD_PATH = join(NODE_ROOT, "canon", "mood_board.json");

export const MOOD_BOARD_MAX_EDGE_PX = 1568;
export const MOOD_BOARD_MAX_BYTES = 5 * 1024 * 1024;
export const SUPPORTED_MEDIA_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function inferMediaType(path, buffer) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  return null;
}

async function rasteriseToPngBuffer(inputBuffer, maxEdgePx) {
  const image = sharp(inputBuffer);
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) {
    throw new Error("image has zero dimensions");
  }
  const longEdge = Math.max(width, height);
  const pipeline = longEdge > maxEdgePx
    ? image.resize({
        width: width >= height ? maxEdgePx : null,
        height: height > width ? maxEdgePx : null,
        withoutEnlargement: true,
        fit: "inside",
      })
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
  const labelLines = [
    "MOOD BOARD — reference images used to anchor the aesthetic for this performance. Each entry below carries a role and a caption; the image follows in order.",
  ];

  for (const entry of manifest) {
    if (!entry || typeof entry !== "object") {
      logger.warn?.(`mood_board: skipping non-object entry`);
      continue;
    }
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
      source: { type: "base64", media_type: "image/png", data: pngBuffer.toString("base64") },
    });
    labelLines.push(`- [${role}] ${label}`);
  }

  return {
    labelText: labelLines.join("\n"),
    imageBlocks,
  };
}

export function buildMoodBoardUserBlocks({ labelText, imageBlocks }) {
  if (!imageBlocks || imageBlocks.length === 0) return [];
  return [
    { type: "text", text: labelText },
    ...imageBlocks,
    { type: "text", text: "END MOOD BOARD.", cache_control: { type: "ephemeral" } },
  ];
}

export function shouldCaptureSelfFrame({
  cycleIndex,
  activeCount = 0,
  cyclesSinceLastImage = 0,
  hijazTahwilFired = false,
}) {
  if (hijazTahwilFired) return true;
  if (activeCount > 8) return true;
  if (cyclesSinceLastImage > 4) return true;
  if (cycleIndex > 0 && cycleIndex % 5 === 0) return true;
  return false;
}

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
      source: { type: "base64", media_type: "image/png", data: pngBuffer.toString("base64") },
    },
  ];
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const fsp = await import("node:fs/promises");

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
    assert.ok(
      Math.max(meta.width, meta.height) <= MOOD_BOARD_MAX_EDGE_PX,
      `${meta.width}×${meta.height} exceeds ${MOOD_BOARD_MAX_EDGE_PX}`,
    );
  });

  await t("loadMoodBoard labels each entry with role and caption", async () => {
    const result = await loadMoodBoard();
    assert.match(result.labelText, /positive/);
    assert.match(result.labelText, /anchor/);
    assert.match(result.labelText, /NOT this/);
  });

  await t("loadMoodBoard gracefully skips missing files and continues", async () => {
    const manifestPath = join(NODE_ROOT, "canon", "_test_broken_manifest.json");
    await fsp.writeFile(
      manifestPath,
      JSON.stringify([
        { path: "./placeholders/positive_01.svg", role: "positive", label: "real" },
        { path: "./placeholders/does_not_exist.svg", role: "negative", label: "missing" },
      ]),
    );
    try {
      const warnings = [];
      const result = await loadMoodBoard({ manifestPath, logger: { warn: (m) => warnings.push(m) } });
      assert.equal(result.imageBlocks.length, 1);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /does_not_exist/);
    } finally {
      await fsp.unlink(manifestPath);
    }
  });

  await t("buildMoodBoardUserBlocks appends cache breakpoint after images", async () => {
    const result = await loadMoodBoard();
    const blocks = buildMoodBoardUserBlocks(result);
    assert.equal(blocks.length, 1 + 5 + 1);
    assert.equal(blocks[0].type, "text");
    assert.equal(blocks[6].type, "text");
    assert.equal(blocks[6].text.length > 0, true);
    assert.deepEqual(blocks[6].cache_control, { type: "ephemeral" });
    for (let i = 1; i <= 5; i += 1) assert.equal(blocks[i].type, "image");
  });

  await t("buildMoodBoardUserBlocks returns [] when no image blocks", () => {
    assert.deepEqual(buildMoodBoardUserBlocks({ labelText: "", imageBlocks: [] }), []);
    assert.deepEqual(buildMoodBoardUserBlocks({ labelText: "x", imageBlocks: null }), []);
  });

  await t("shouldCaptureSelfFrame fires every 5th cycle as safety baseline", () => {
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 5, activeCount: 0, cyclesSinceLastImage: 0, hijazTahwilFired: false }), true);
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 10, activeCount: 0, cyclesSinceLastImage: 0, hijazTahwilFired: false }), true);
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 0, activeCount: 0, cyclesSinceLastImage: 0, hijazTahwilFired: false }), false);
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 1, activeCount: 0, cyclesSinceLastImage: 0, hijazTahwilFired: false }), false);
  });

  await t("shouldCaptureSelfFrame fires when active_count > 8", () => {
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 2, activeCount: 9, cyclesSinceLastImage: 0, hijazTahwilFired: false }), true);
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 2, activeCount: 8, cyclesSinceLastImage: 0, hijazTahwilFired: false }), false);
  });

  await t("shouldCaptureSelfFrame fires when cyclesSinceLastImage > 4", () => {
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 2, activeCount: 0, cyclesSinceLastImage: 5, hijazTahwilFired: false }), true);
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 2, activeCount: 0, cyclesSinceLastImage: 4, hijazTahwilFired: false }), false);
  });

  await t("shouldCaptureSelfFrame fires when hijaz_tahwil_fired is true", () => {
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 2, activeCount: 0, cyclesSinceLastImage: 0, hijazTahwilFired: true }), true);
  });

  await t("shouldCaptureSelfFrame combines triggers with OR, not AND", () => {
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 2, activeCount: 2, cyclesSinceLastImage: 0, hijazTahwilFired: false }), false);
    assert.equal(shouldCaptureSelfFrame({ cycleIndex: 5, activeCount: 2, cyclesSinceLastImage: 0, hijazTahwilFired: false }), true);
  });

  await t("buildSelfFrameUserBlocks emits a caption then an image block", () => {
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
    assert.deepEqual(
      [...roundTripped.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
  });

  await t("buildSelfFrameUserBlocks returns empty array when pngBuffer is null or empty", () => {
    assert.deepEqual(buildSelfFrameUserBlocks({ pngBuffer: null, metadata: {} }), []);
    assert.deepEqual(buildSelfFrameUserBlocks({ pngBuffer: Buffer.alloc(0), metadata: {} }), []);
  });

  await t("buildSelfFrameUserBlocks does NOT attach cache_control to either block", () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const blocks = buildSelfFrameUserBlocks({
      pngBuffer: fakePng,
      metadata: { previousCycleIndex: 2, activeCount: 0, dominantType: "none", backgroundAgeS: 0 },
    });
    for (const b of blocks) assert.equal(b.cache_control, undefined);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
