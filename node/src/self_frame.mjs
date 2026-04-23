import { chromium } from "playwright";

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

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
