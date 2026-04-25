import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_ROOT = join(__dirname, "..");
const DEFAULT_CACHE_DIR = join(NODE_ROOT, "image_cache");
const DEFAULT_INDEX_PATH = join(DEFAULT_CACHE_DIR, "index.json");
const UTM_SUFFIX = "utm_source=feed_looks_back_spike&utm_medium=referral";

let envLoaded = false;

function ensureEnvLoaded() {
  if (envLoaded) return;
  loadDotenv({ path: join(NODE_ROOT, ".env") });
  envLoaded = true;
}

function normalizeQuery(query) {
  if (typeof query !== "string") return "";
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

// Bayati search-query refinement.
//
// This function appends search hints to Opus's image queries before they
// hit the image API. The previous (Hijaz) version amplified the
// architectural register: "lamp" → "oil lamp still life low light stone",
// "arch/door/threshold" → "stone interior architecture natural light".
// Even with a perfect Bayati prompt, those amplifiers would pull search
// results back toward the Hijaz visual world.
//
// The Bayati refinements below emphasise the interior-figurative register:
// solitary figures, hands, water, soft fabric, night, quiet detail. The
// fallback retains "documentary photograph" — that substring is asserted
// by the self-tests below — but drops "interior" and "texture" so generic
// queries don't auto-default to architectural results.
export function curateImageSearchQuery(query) {
  const normalized = normalizeQuery(query);
  if (!normalized) return "";
  const additions = [];
  if (/\b(water|moon|moonlight|moonlit|ripple|pool|stream|drop|dew)\b/.test(normalized)) {
    additions.push("still water moonlight low light natural reflection photograph");
  }
  if (/\b(hand|palm|fingers|cupped|wrist|knuckle)\b/.test(normalized)) {
    additions.push("close-up hand soft natural light documentary photograph");
  }
  if (/\b(figure|person|silhouette|seated|walking|bowed|back|profile|head|shoulder|sleeping)\b/.test(normalized)) {
    additions.push("solitary figure low light documentary photograph quiet");
  }
  if (/\b(linen|paper|cloth|fabric|feather|blanket|silk|sheet)\b/.test(normalized)) {
    additions.push("soft fabric low light natural texture documentary photograph");
  }
  if (/\b(candle|flame|glow|lantern|lamp)\b/.test(normalized)) {
    additions.push("warm low light soft glow documentary photograph");
  }
  if (/\b(breath|window|glass|rain|mist|vapour|vapor)\b/.test(normalized)) {
    additions.push("low light quiet detail natural documentary photograph");
  }
  if (/\b(night|dusk|dark|shadow|moonlit|starlight|evening)\b/.test(normalized)) {
    additions.push("night low light quiet documentary photograph");
  }
  if (additions.length === 0) {
    additions.push("low light natural soft documentary photograph");
  }
  return normalizeQuery(`${normalized} ${additions.join(" ")}`);
}

function cacheHashForQuery(normalizedQuery) {
  return createHash("sha256").update(normalizedQuery).digest("hex").slice(0, 16);
}

function ensureCacheFiles(cacheDir, indexPath) {
  mkdirSync(cacheDir, { recursive: true });
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, "{}\n");
  }
}

function readIndex(indexPath) {
  try {
    const raw = readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeIndex(indexPath, index) {
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

function appendUtm(url) {
  if (typeof url !== "string" || !url) return url ?? null;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("utm_source", "feed_looks_back_spike");
    parsed.searchParams.set("utm_medium", "referral");
    return parsed.toString();
  } catch {
    return url.includes("?") ? `${url}&${UTM_SUFFIX}` : `${url}?${UTM_SUFFIX}`;
  }
}

function makeAttribution(entry) {
  if (!entry) return null;
  return {
    photographer_name: entry.photographer_name ?? null,
    photographer_url: entry.photographer_url ?? null,
    photo_url: entry.photo_url ?? null,
  };
}

export async function fetchImage(query, options = {}) {
  ensureEnvLoaded();

  const originalQuery = normalizeQuery(query);
  const normalizedQuery = curateImageSearchQuery(query);
  if (!normalizedQuery) {
    return { path: null, attribution: null, error: "invalid query" };
  }

  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const indexPath = options.indexPath ?? DEFAULT_INDEX_PATH;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const accessKey = options.accessKey ?? process.env.UNSPLASH_ACCESS_KEY ?? "";

  if (typeof fetchImpl !== "function") {
    return { path: null, attribution: null, error: "fetch implementation unavailable" };
  }

  ensureCacheFiles(cacheDir, indexPath);

  const hash = cacheHashForQuery(normalizedQuery);
  const imagePath = join(cacheDir, `${hash}.jpg`);
  const index = readIndex(indexPath);

  if (existsSync(imagePath)) {
    return {
      path: imagePath,
      attribution: makeAttribution(index[hash] ?? null),
      cached: true,
    };
  }

  if (!accessKey) {
    return { path: null, attribution: null, error: "UNSPLASH_ACCESS_KEY is missing" };
  }

  try {
    const searchUrl = new URL("https://api.unsplash.com/search/photos");
    searchUrl.searchParams.set("query", normalizedQuery);
    searchUrl.searchParams.set("per_page", "1");
    searchUrl.searchParams.set("orientation", "landscape");

    const authHeaders = { Authorization: `Client-ID ${accessKey}` };
    const searchRes = await fetchImpl(searchUrl, { headers: authHeaders });
    if (!searchRes?.ok) {
      return {
        path: null,
        attribution: null,
        error: `unsplash search failed: ${searchRes?.status ?? "unknown"} ${searchRes?.statusText ?? ""}`.trim(),
      };
    }

    const payload = await searchRes.json();
    const result = Array.isArray(payload?.results) ? payload.results[0] : null;
    if (!result?.urls?.regular) {
      return { path: null, attribution: null, error: "unsplash returned no results" };
    }

    if (result?.links?.download_location) {
      try {
        await fetchImpl(result.links.download_location, { headers: authHeaders });
      } catch {
        // best-effort analytics ping only; do not fail the image fetch
      }
    }

    const imageRes = await fetchImpl(result.urls.regular);
    if (!imageRes?.ok) {
      return {
        path: null,
        attribution: null,
        error: `image download failed: ${imageRes?.status ?? "unknown"} ${imageRes?.statusText ?? ""}`.trim(),
      };
    }

    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
    writeFileSync(imagePath, imageBuffer);

    index[hash] = {
      query: originalQuery,
      search_query: normalizedQuery,
      photographer_name: result?.user?.name ?? null,
      photographer_url: appendUtm(result?.user?.links?.html ?? null),
      photo_url: appendUtm(result?.links?.html ?? null),
      fetched_at: new Date().toISOString(),
    };
    writeIndex(indexPath, index);

    return {
      path: imagePath,
      attribution: makeAttribution(index[hash]),
      cached: false,
    };
  } catch (err) {
    return {
      path: null,
      attribution: null,
      error: err?.message ?? String(err),
    };
  }
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const { mkdtempSync, readFileSync: readFileSyncTest, writeFileSync: writeFileSyncTest } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");

  let pass = 0;
  let fail = 0;
  const tests = [];
  function t(desc, fn) {
    tests.push({ desc, fn });
  }

  function freshCacheRoot(prefix) {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    const cacheDir = path.join(root, "image_cache");
    const indexPath = path.join(cacheDir, "index.json");
    mkdirSync(cacheDir, { recursive: true });
    return { cacheDir, indexPath };
  }

  t("fetchImage returns cached result without calling fetch", async () => {
    const { cacheDir, indexPath } = freshCacheRoot("flb-image-cache-hit-");
    const query = "  Afternoon LIGHT on a worn interior wall, nobody present  ";
    const normalized = normalizeQuery(query);
    const curated = curateImageSearchQuery(query);
    const hash = cacheHashForQuery(curated);
    const imagePath = path.join(cacheDir, `${hash}.jpg`);
    writeFileSyncTest(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    writeFileSyncTest(
      indexPath,
      `${JSON.stringify({
        [hash]: {
          query: normalized,
          search_query: curated,
          photographer_name: "Cache Photographer",
          photographer_url: "https://unsplash.com/@cache?utm_source=feed_looks_back_spike&utm_medium=referral",
          photo_url: "https://unsplash.com/photos/cache?utm_source=feed_looks_back_spike&utm_medium=referral",
          fetched_at: "2026-04-23T00:00:00.000Z",
        },
      })}\n`,
    );
    let called = 0;
    const result = await fetchImage(query, {
      cacheDir,
      indexPath,
      fetchImpl: async () => {
        called += 1;
        throw new Error("fetch should not run on cache hit");
      },
    });
    assert.equal(result.cached, true);
    assert.equal(result.path, imagePath);
    assert.equal(result.attribution.photographer_name, "Cache Photographer");
    assert.equal(called, 0);
  });

  t("fetchImage downloads on cache miss, writes index, and stores the image", async () => {
    const { cacheDir, indexPath } = freshCacheRoot("flb-image-cache-miss-");
    const searchCalls = [];
    const query = "afternoon light on a worn interior wall, nobody present";
    const result = await fetchImage(query, {
      cacheDir,
      indexPath,
      accessKey: "test-access-key",
      fetchImpl: async (url) => {
        const href = typeof url === "string" ? url : url.toString();
        searchCalls.push(href);
        if (href.startsWith("https://api.unsplash.com/search/photos")) {
          return {
            ok: true,
            async json() {
              return {
                results: [
                  {
                    urls: { regular: "https://images.unsplash.com/photo-test.jpg" },
                    links: {
                      html: "https://unsplash.com/photos/photo-test",
                      download_location: "https://api.unsplash.com/photos/photo-test/download",
                    },
                    user: {
                      name: "Ada Example",
                      links: { html: "https://unsplash.com/@ada" },
                    },
                  },
                ],
              };
            },
          };
        }
        if (href === "https://api.unsplash.com/photos/photo-test/download") {
          return { ok: true, status: 200, statusText: "OK", async json() { return {}; } };
        }
        if (href === "https://images.unsplash.com/photo-test.jpg") {
          return {
            ok: true,
            async arrayBuffer() {
              return Uint8Array.from([1, 2, 3, 4]).buffer;
            },
          };
        }
        throw new Error(`unexpected fetch url: ${href}`);
      },
    });

    assert.equal(result.cached, false);
    assert.ok(result.path.endsWith(".jpg"));
    assert.equal(result.attribution.photographer_name, "Ada Example");
    const saved = readFileSyncTest(result.path);
    assert.equal(saved.length, 4);
    const index = JSON.parse(readFileSyncTest(indexPath, "utf8"));
    const entries = Object.values(index);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].query, query);
    assert.match(entries[0].search_query, /documentary photograph/);
    assert.equal(entries[0].photographer_name, "Ada Example");
    assert.match(entries[0].photographer_url, /utm_source=feed_looks_back_spike/);
    assert.match(entries[0].photo_url, /utm_medium=referral/);
    assert.ok(
      searchCalls.includes("https://api.unsplash.com/photos/photo-test/download"),
      "should ping download_location on fresh fetch",
    );
    const searchUrl = new URL(searchCalls.find((href) => href.startsWith("https://api.unsplash.com/search/photos")));
    assert.match(searchUrl.searchParams.get("query"), /documentary photograph/);
  });

  t("fetchImage returns error objects on API failure", async () => {
    const { cacheDir, indexPath } = freshCacheRoot("flb-image-api-error-");
    const result = await fetchImage("stone room interior", {
      cacheDir,
      indexPath,
      accessKey: "test-access-key",
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      }),
    });
    assert.equal(result.path, null);
    assert.equal(result.attribution, null);
    assert.match(result.error, /429/);
  });

  t("fetchImage rejects invalid queries without throwing", async () => {
    const { cacheDir, indexPath } = freshCacheRoot("flb-image-invalid-query-");
    const result = await fetchImage("   ", {
      cacheDir,
      indexPath,
      fetchImpl: async () => {
        throw new Error("should not fetch for invalid query");
      },
    });
    assert.equal(result.path, null);
    assert.equal(result.attribution, null);
    assert.equal(result.error, "invalid query");
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
