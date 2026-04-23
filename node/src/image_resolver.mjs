import { relative } from "node:path";

import { fetchImage } from "./image_fetch.mjs";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function textOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function imageQueryKey(query) {
  return textOr(query).trim().toLowerCase().replace(/\s+/g, " ");
}

export async function resolveImageAssets(state, runDir, fetchImageImpl = fetchImage) {
  const activeImages = safeArray(state?.elements).filter((element) => element?.type === "image" && !element?.faded);
  const byQuery = new Map();
  const inFlight = new Map();

  await Promise.all(
    activeImages.map(async (element) => {
      const content = safeObject(element?.content);
      const key = imageQueryKey(content.query);
      if (!key) return;
      if (!inFlight.has(key)) {
        inFlight.set(
          key,
          (async () => {
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
          })(),
        );
      }
      await inFlight.get(key);
    }),
  );

  const assets = {};
  for (const element of activeImages) {
    const key = imageQueryKey(safeObject(element?.content).query);
    if (key && byQuery.has(key)) {
      assets[element.element_id] = byQuery.get(key);
    }
  }
  return assets;
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

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

  function buildState() {
    return {
      elements: [
        {
          element_id: "elem_0001",
          type: "image",
          faded: false,
          content: { query: "Threshold Light", position: "background" },
        },
        {
          element_id: "elem_0002",
          type: "image",
          faded: false,
          content: { query: "threshold   light", position: "right half" },
        },
        {
          element_id: "elem_0003",
          type: "image",
          faded: true,
          content: { query: "old ash", position: "background" },
        },
      ],
    };
  }

  await t("imageQueryKey normalizes case and whitespace", async () => {
    assert.equal(imageQueryKey("  Threshold   Light "), "threshold light");
  });

  await t("resolveImageAssets deduplicates fetches by normalized query", async () => {
    const calls = [];
    const assets = await resolveImageAssets(buildState(), join(tmpdir(), "run_a"), async (query) => {
      calls.push(query);
      return {
        path: join(tmpdir(), "image_cache", "abc123.jpg"),
        attribution: { photographer_name: "Ada", photo_url: "p" },
        cached: true,
      };
    });
    assert.equal(calls.length, 1);
    assert.equal(assets.elem_0001.src, "../image_cache/abc123.jpg");
    assert.equal(assets.elem_0002.src, "../image_cache/abc123.jpg");
  });

  await t("resolveImageAssets excludes faded images", async () => {
    const assets = await resolveImageAssets(buildState(), join(tmpdir(), "run_b"), async (query) => ({
      path: join(tmpdir(), "image_cache", `${query}.jpg`),
      attribution: null,
      cached: false,
    }));
    assert.equal("elem_0003" in assets, false);
  });

  await t("resolveImageAssets records stable placeholder entries on fetch failure", async () => {
    const state = {
      elements: [
        {
          element_id: "elem_0004",
          type: "image",
          faded: false,
          content: { query: "after rain", position: "background" },
        },
      ],
    };
    const assets = await resolveImageAssets(state, join(tmpdir(), "run_c"), async () => ({
      error: "disabled in self-test",
    }));
    assert.deepEqual(assets.elem_0004, {
      src: null,
      attribution: null,
      error: "disabled in self-test",
    });
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
