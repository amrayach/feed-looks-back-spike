// node/src/video_capture.mjs
// Optional Playwright + ffmpeg recording. Gracefully degrades if
// either dep is missing — the pipeline ships even without recording.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bakeDirLayout } from "./bake_io.mjs";

function commandExists(cmd) {
  try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; }
  catch { return false; }
}

async function loadPlaywrightOrNull() {
  try { return await import("playwright"); }
  catch { return null; }
}

export async function captureStageVideo({ stageUrl, audioPath, bakeDir,
                                          durationMs, headless = true }) {
  const layout = bakeDirLayout(bakeDir);
  mkdirSync(layout.submissionDir, { recursive: true });
  const webmPath = join(layout.submissionDir, "video.webm");
  const mp4Path = join(layout.submissionDir, "video.mp4");

  const playwright = await loadPlaywrightOrNull();
  const ffmpegOk = commandExists("ffmpeg");
  const playwrightOk = playwright !== null;

  if (!playwrightOk || !ffmpegOk) {
    process.stderr.write([
      "video_capture: missing dependency — skipping automated recording",
      `  playwright available: ${playwrightOk}`,
      `  ffmpeg available:     ${ffmpegOk}`,
      "",
      "Manual fallback:",
      `  1. Open the stage in a browser:  ${stageUrl}`,
      `  2. Use OS screen recorder (e.g. obs / screencapture / kazam) to`,
      `     record the canvas region for ~${Math.round(durationMs / 1000)}s`,
      `  3. Save to ${mp4Path}`,
      "",
    ].join("\n"));
    return { recorded: false, webmPath: null, mp4Path: null };
  }

  const browser = await playwright.chromium.launch({ headless });
  const context = await browser.newContext({
    recordVideo: { dir: layout.submissionDir, size: { width: 1280, height: 720 } },
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  await page.goto(stageUrl);
  // Stage page exposes window.__bakeStartPlayback() to start audio + dispatch.
  await page.evaluate(() => window.__bakeStartPlayback && window.__bakeStartPlayback());
  await page.waitForTimeout(durationMs);
  const video = await page.video();
  await context.close();
  await browser.close();

  // Playwright writes the webm to a generated filename; rename it.
  const recorded = await video.path();
  if (recorded !== webmPath) {
    const { renameSync } = await import("node:fs");
    renameSync(recorded, webmPath);
  }

  // ffmpeg mux: webm video + wav audio → mp4
  await new Promise((resolve, reject) => {
    const args = [
      "-y", "-i", webmPath, "-i", audioPath,
      "-c:v", "libx264", "-crf", "18", "-preset", "slow",
      "-c:a", "aac", "-b:a", "192k", "-shortest", mp4Path,
    ];
    const ff = spawn("ffmpeg", args, { stdio: "inherit" });
    ff.on("error", reject);
    ff.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
  });

  return { recorded: true, webmPath, mp4Path };
}

// ─── Self-tests ────────────────────────────────────────────────────

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  if (process.argv.includes("--self-test")) {
    const assert = (await import("node:assert/strict")).default;
    const { mkdtempSync, mkdirSync: mkd } = await import("node:fs");
    const { tmpdir } = await import("node:os");

    let pass = 0, fail = 0;
    async function t(desc, fn) {
      try { await fn(); pass += 1; process.stdout.write(`  ok  ${desc}\n`); }
      catch (e) { fail += 1; process.stdout.write(`  FAIL ${desc}\n    ${e.message}\n`); }
    }

    await t("returns recorded:false when both playwright and ffmpeg are unavailable", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "vid-cap-"));
      const bakeDir = join(tmp, "bake_x");
      mkd(join(bakeDir, "track_meta"), { recursive: true });
      const origPath = process.env.PATH;
      process.env.PATH = "/__nope__";
      try {
        const result = await captureStageVideo({
          stageUrl: "http://localhost:0",
          audioPath: "/dev/null",
          bakeDir,
          durationMs: 100,
        });
        assert.equal(result.recorded, false, "recorded should be false");
        assert.equal(result.mp4Path, null, "mp4Path should be null");
        assert.equal(result.webmPath, null, "webmPath should be null");
      } finally {
        process.env.PATH = origPath;
      }
    });

    await t("output paths are under bakeDir/submission/", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "vid-cap-path-"));
      const bakeDir = join(tmp, "bake_songX");
      mkd(join(bakeDir, "track_meta"), { recursive: true });
      // Don't actually launch — we just want to verify path computation by
      // inspecting what bakeDirLayout produces.
      const layout = bakeDirLayout(bakeDir);
      const expectedWebm = join(layout.submissionDir, "video.webm");
      const expectedMp4 = join(layout.submissionDir, "video.mp4");
      assert.ok(expectedWebm.endsWith("/submission/video.webm"), `webm path wrong: ${expectedWebm}`);
      assert.ok(expectedMp4.endsWith("/submission/video.mp4"), `mp4 path wrong: ${expectedMp4}`);
    });

    await t("durationMs is passed through to fallback warning text", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "vid-cap-dur-"));
      const bakeDir = join(tmp, "bake_dur");
      mkd(join(bakeDir, "track_meta"), { recursive: true });
      const origPath = process.env.PATH;
      const origStderr = process.stderr.write.bind(process.stderr);
      let captured = "";
      process.stderr.write = (s) => { captured += s; return true; };
      process.env.PATH = "/__nope__";
      try {
        await captureStageVideo({
          stageUrl: "http://localhost:0",
          audioPath: "/dev/null",
          bakeDir,
          durationMs: 42000,
        });
        assert.ok(captured.includes("42s"), `expected '42s' in warning, got: ${captured}`);
      } finally {
        process.env.PATH = origPath;
        process.stderr.write = origStderr;
      }
    });

    process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
    if (fail > 0) process.exit(1);
  } else {
    process.stderr.write("usage: node src/video_capture.mjs --self-test\n");
    process.exit(1);
  }
}
