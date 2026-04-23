import { chromium } from "playwright";
import sharp from "sharp";

const DEFAULT_READY_SELECTOR = "body[data-stage-ready=\"1\"]";
const DEFAULT_READY_TIMEOUT_MS = 6000;
const DEFAULT_NAV_TIMEOUT_MS = 10000;
export const SELF_FRAME_MAX_EDGE_PX = 1280;                      // Anthropic recommends ≤1568; our viewport is 1280
export const SELF_FRAME_MAX_BYTES = 4 * 1024 * 1024;             // 4MB, below Anthropic's 5MB per-image limit

async function normalizeScreenshot(rawPng, maxEdgePx, maxBytes, logger) {
  const image = sharp(rawPng);
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const longEdge = Math.max(width, height);
  const normalized = longEdge > maxEdgePx
    ? await image
        .resize({
          width: width >= height ? maxEdgePx : null,
          height: height > width ? maxEdgePx : null,
          withoutEnlargement: true,
          fit: "inside",
        })
        .png()
        .toBuffer()
    : rawPng;
  if (normalized.length > maxBytes) {
    logger.warn?.(`self_frame: PNG exceeds ${maxBytes} bytes (${normalized.length}); dropping capture`);
    return null;
  }
  return normalized;
}

export function createSelfFrameCapturer({
  stageUrl,
  readySelector = DEFAULT_READY_SELECTOR,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  navTimeoutMs = DEFAULT_NAV_TIMEOUT_MS,
  maxEdgePx = SELF_FRAME_MAX_EDGE_PX,
  maxBytes = SELF_FRAME_MAX_BYTES,
  chromiumImpl = chromium,
  logger = console,
  normalizeImpl = normalizeScreenshot,
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
    if (navigationPromise) {
      await navigationPromise;
      return;
    }
    const attempt = (async () => {
      await page.goto(stageUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs });
    })();
    navigationPromise = attempt;
    try {
      await attempt;
    } catch (err) {
      // Clear the cached promise so the next .capture() retries navigation instead
      // of inheriting the failed one.
      navigationPromise = null;
      throw err;
    }
  }

  async function capture() {
    await ensureBrowser();
    await ensureNavigated();
    try {
      await page.waitForSelector(readySelector, { timeout: readyTimeoutMs, state: "attached" });
    } catch (err) {
      throw new Error(`data-stage-ready not set within ${readyTimeoutMs}ms: ${err.message}`);
    }
    const rawPng = await page.screenshot({ type: "png", fullPage: false });
    return await normalizeImpl(rawPng, maxEdgePx, maxBytes, logger);
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
      assert.ok(png.length > 500, `PNG is too small: ${png.length} bytes`);
      assert.deepEqual(
        [...png.subarray(0, 8)],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        "PNG signature mismatch",
      );
    } finally {
      await capturer.close();
      await new Promise((r) => server.close(r));
    }
  });

  await t("waits for data-stage-ready to flip then captures", async () => {
    const server = await startServer(DELAYED_HTML);
    const port = server.address().port;
    const capturer = createSelfFrameCapturer({ stageUrl: `http://127.0.0.1:${port}/` });
    try {
      const png = await capturer.capture();
      assert.equal(Buffer.isBuffer(png), true);
      assert.ok(png.length > 500);
    } finally {
      await capturer.close();
      await new Promise((r) => server.close(r));
    }
  });

  await t("throws a specific error on ready-state timeout", async () => {
    const server = await startServer(STUCK_HTML);
    const port = server.address().port;
    const capturer = createSelfFrameCapturer({
      stageUrl: `http://127.0.0.1:${port}/`,
      readyTimeoutMs: 800,
    });
    try {
      await assert.rejects(() => capturer.capture(), /data-stage-ready/);
    } finally {
      await capturer.close();
      await new Promise((r) => server.close(r));
    }
  });

  await t("close() is idempotent and safe before any capture", async () => {
    const capturer = createSelfFrameCapturer({ stageUrl: "http://127.0.0.1:1/" });
    await capturer.close();
    await capturer.close();
  });

  await t("navigation failure does not permanently disable the capturer", async () => {
    const server = await startServer(READY_HTML);
    const port = server.address().port;
    let gotoCount = 0;
    const fakeChromium = {
      launch: async () => ({
        newContext: async () => ({
          newPage: async () => ({
            goto: async (url) => {
              gotoCount += 1;
              if (gotoCount === 1) throw new Error("transient network glitch");
              // On retry, delegate to real Playwright by throwing a signal — easier to
              // verify by swapping chromium for real. Instead, just synthesize a success.
              return null;
            },
            waitForSelector: async () => null,
            screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
            close: async () => {},
          }),
          close: async () => {},
        }),
        close: async () => {},
      }),
    };
    const capturer = createSelfFrameCapturer({
      stageUrl: `http://127.0.0.1:${port}/`,
      chromiumImpl: fakeChromium,
      normalizeImpl: async (raw) => raw,                          // skip real sharp for the PNG stub
    });
    try {
      await assert.rejects(() => capturer.capture(), /transient/);
      // The second capture must succeed — navigation state was reset.
      const png = await capturer.capture();
      assert.equal(Buffer.isBuffer(png), true);
      assert.equal(gotoCount, 2, "second capture should retry goto");
    } finally {
      await capturer.close();
      await new Promise((r) => server.close(r));
    }
  });

  await t("normalizeScreenshot downsizes oversized screenshots and keeps PNG format", async () => {
    const big = await sharp({
      create: { width: 2400, height: 1400, channels: 3, background: { r: 20, g: 20, b: 40 } },
    })
      .png()
      .toBuffer();
    const normalized = await normalizeScreenshot(big, 1280, 4 * 1024 * 1024, { warn: () => {} });
    assert.equal(Buffer.isBuffer(normalized), true);
    const meta = await sharp(normalized).metadata();
    assert.equal(meta.format, "png");
    assert.ok(Math.max(meta.width, meta.height) <= 1280, `unexpectedly large: ${meta.width}x${meta.height}`);
  });

  await t("normalizeScreenshot drops captures that exceed the byte budget", async () => {
    const img = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .png()
      .toBuffer();
    const warnings = [];
    const result = await normalizeScreenshot(img, 1280, 100, { warn: (m) => warnings.push(m) });
    assert.equal(result, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /exceeds/);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
