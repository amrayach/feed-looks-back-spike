// node/src/bake_highlight_rationales.mjs
// Picks N most articulate rationales (model-emitted text blocks)
// for the submission writeup. Hidden thinking is NOT used or surfaced.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bakeDirLayout, readJson } from "./bake_io.mjs";

const STRUCTURAL_TERMS = [
  "muhayyar", "tahwil", "phrase break", "augmented second",
  "lower jins", "returning to tonic", "stillness", "ground",
  "moonlight", "open palm", "solitary figure", "loose linen",
  "single feather", "breath", "candlelight", "still water",
];

function score(rationale) {
  if (!rationale) return 0;
  const len = rationale.length;
  const lower = rationale.toLowerCase();
  let hits = 0;
  for (const term of STRUCTURAL_TERMS) if (lower.includes(term)) hits += 1;
  return Math.min(len, 600) + hits * 80;
}

export function pickHighlights(bakeDir, max = 5) {
  const layout = bakeDirLayout(bakeDir);
  const dir = layout.cyclesDir;
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) =>
    /^cycle_\d+(_v2)?\.json$/.test(f) && !f.includes("_input"),
  );
  const seen = new Map();
  for (const f of files) {
    const c = readJson(join(dir, f));
    const key = c.cycle_index;
    const isV2 = f.includes("_v2");
    const existing = seen.get(key);
    if (!existing || (isV2 && !existing.isV2)) {
      seen.set(key, { cycle: c, isV2 });
    }
  }
  const ranked = [...seen.values()]
    .map(({ cycle, isV2 }) => ({
      cycle_index: cycle.cycle_index,
      isV2,
      rationale: cycle.rationale,
      tool_calls: cycle.tool_calls.map((t) => t.name),
      score: score(cycle.rationale),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  return ranked;
}

export function writeHighlightsMarkdown(bakeDir, highlights) {
  const layout = bakeDirLayout(bakeDir);
  mkdirSync(layout.submissionDir, { recursive: true });
  const out = join(layout.submissionDir, "highlight_rationales.md");
  const body = [
    "# Highlight rationales",
    "",
    "These rationales are model-emitted text blocks (visible content),",
    "not private chain-of-thought.",
    "",
    ...highlights.map((h) => [
      `## Cycle ${h.cycle_index}${h.isV2 ? " (refined v2)" : ""}`,
      "",
      `> ${h.rationale.replace(/\n/g, "\n> ")}`,
      "",
      `Tool calls: ${h.tool_calls.join(", ") || "(none)"}`,
      "",
    ].join("\n")),
  ].join("\n");
  writeFileSync(out, body);
  return out;
}

// ─── CLI / Self-tests ──────────────────────────────────────────────

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  if (process.argv.includes("--self-test")) {
    const assert = (await import("node:assert/strict")).default;
    const { mkdtempSync, mkdirSync: mkd, writeFileSync: wf, readFileSync: rf } = await import("node:fs");
    const { tmpdir } = await import("node:os");

    let pass = 0, fail = 0;
    async function t(desc, fn) {
      try { await fn(); pass += 1; process.stdout.write(`  ok  ${desc}\n`); }
      catch (e) { fail += 1; process.stdout.write(`  FAIL ${desc}\n    ${e.message}\n`); }
    }

    // Helper: write a synthetic cycle JSON
    function writeCycle(dir, idx, overrides = {}) {
      const name = `cycle_${String(idx).padStart(3, "0")}${overrides._v2 ? "_v2" : ""}.json`;
      delete overrides._v2;
      const obj = {
        cycle_index: idx,
        cycle_id: `cycle-${idx}`,
        model: "claude-opus-4-7",
        thinking_budget: 1,
        rationale: `rationale for cycle ${idx}`,
        tool_calls: [],
        input_signature: "abcdefgh",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
        baked_at: "2026-04-25T00:00:00Z",
        ...overrides,
      };
      wf(join(dir, name), JSON.stringify(obj));
    }

    await t("returns empty array when cycles dir does not exist", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "bhr-test-"));
      const bakeDir = join(tmp, "bake_empty");
      mkd(join(bakeDir, "track_meta"), { recursive: true });
      const result = pickHighlights(bakeDir, 5);
      assert.deepEqual(result, []);
    });

    await t("selects top N by score, limited to max", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "bhr-test2-"));
      const bakeDir = join(tmp, "bake_n");
      const cyclesDir = join(bakeDir, "cycles");
      mkd(cyclesDir, { recursive: true });
      // Write 5 cycles with varying rationale lengths
      for (let i = 0; i < 5; i++) {
        writeCycle(cyclesDir, i, { rationale: "x".repeat((i + 1) * 50) });
      }
      const result = pickHighlights(bakeDir, 3);
      assert.equal(result.length, 3, "should return exactly 3");
      // cycle 4 (longest) should be first
      assert.equal(result[0].cycle_index, 4, "highest score should be first");
    });

    await t("v2 versions supersede v1 for same cycle_index", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "bhr-test3-"));
      const bakeDir = join(tmp, "bake_v2");
      const cyclesDir = join(bakeDir, "cycles");
      mkd(cyclesDir, { recursive: true });
      writeCycle(cyclesDir, 0, { rationale: "short v1 rationale" });
      writeCycle(cyclesDir, 0, { rationale: "longer refined v2 rationale here", _v2: true });
      const result = pickHighlights(bakeDir, 5);
      assert.equal(result.length, 1, "deduplicated to 1 entry");
      assert.equal(result[0].isV2, true, "should prefer v2");
      assert.ok(result[0].rationale.includes("v2"), "should use v2 rationale");
    });

    await t("structural vocabulary terms boost score", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "bhr-test4-"));
      const bakeDir = join(tmp, "bake_vocab");
      const cyclesDir = join(bakeDir, "cycles");
      mkd(cyclesDir, { recursive: true });
      // Cycle 0: no vocab terms, cycle 1: two vocab terms
      writeCycle(cyclesDir, 0, { rationale: "generic description without special words" });
      writeCycle(cyclesDir, 1, { rationale: "the candlelight flickers near the solitary figure" });
      const result = pickHighlights(bakeDir, 5);
      // cycle 1 should rank higher despite similar length due to vocab hits
      const cycle1 = result.find((r) => r.cycle_index === 1);
      const cycle0 = result.find((r) => r.cycle_index === 0);
      assert.ok(cycle1.score > cycle0.score, `cycle1 score ${cycle1.score} should exceed cycle0 score ${cycle0.score}`);
    });

    await t("written markdown contains headings and rationale text", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "bhr-test5-"));
      const bakeDir = join(tmp, "bake_md");
      const cyclesDir = join(bakeDir, "cycles");
      mkd(cyclesDir, { recursive: true });
      writeCycle(cyclesDir, 2, { rationale: "a thoughtful rationale about breath and stillness" });
      const highlights = pickHighlights(bakeDir, 5);
      const outPath = writeHighlightsMarkdown(bakeDir, highlights);
      const md = rf(outPath, "utf8");
      assert.match(md, /# Highlight rationales/);
      assert.match(md, /## Cycle 2/);
      assert.match(md, /breath and stillness/);
    });

    await t("tool_calls names appear in written markdown", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "bhr-test6-"));
      const bakeDir = join(tmp, "bake_tools");
      const cyclesDir = join(bakeDir, "cycles");
      mkd(cyclesDir, { recursive: true });
      writeCycle(cyclesDir, 0, {
        rationale: "rationale with tool usage",
        tool_calls: [
          { id: "t1", name: "addScene", input: {} },
          { id: "t2", name: "setCameraAngle", input: {} },
        ],
      });
      const highlights = pickHighlights(bakeDir, 5);
      const outPath = writeHighlightsMarkdown(bakeDir, highlights);
      const md = rf(outPath, "utf8");
      assert.match(md, /addScene/);
      assert.match(md, /setCameraAngle/);
    });

    process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
    if (fail > 0) process.exit(1);
  } else {
    // CLI mode
    const args = process.argv.slice(2);
    const bakeDirIdx = args.indexOf("--bake-dir");
    const topIdx = args.indexOf("--top");
    const bakeDir = bakeDirIdx >= 0 ? args[bakeDirIdx + 1] : args[0];
    const max = topIdx >= 0 ? parseInt(args[topIdx + 1], 10) : 5;
    if (!bakeDir) {
      process.stderr.write("usage: node src/bake_highlight_rationales.mjs --bake-dir <dir> [--top N]\n");
      process.exit(1);
    }
    const out = writeHighlightsMarkdown(bakeDir, pickHighlights(bakeDir, max));
    process.stdout.write(`${out}\n`);
  }
}
