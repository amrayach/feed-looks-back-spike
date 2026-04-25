// node/src/bake_render_plan.mjs
// Renders composition_plan.json into a single static HTML page for
// submission. No external assets, no JS — just CSS-styled markup.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bakeDirLayout, readJson, validateOrThrow, compositionPlanSchema } from "./bake_io.mjs";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderArc(arc) {
  return `<ol class="arc">${arc.map((a) =>
    `<li><strong>${escapeHtml(a.name)}</strong>` +
    ` <span class="range">[cycles ${a.cycle_range[0]}–${a.cycle_range[1]}]</span>` +
    `<p>${escapeHtml(a.intent)}</p></li>`,
  ).join("")}</ol>`;
}

function renderPerCycle(perCycle) {
  return `<table class="cycles"><thead><tr>` +
    `<th>cycle</th><th>act</th><th>energy</th><th>intent</th>` +
    `</tr></thead><tbody>${
      perCycle.map((p) =>
        `<tr><td>${p.cycle}</td><td>${p.active_act}</td>` +
        `<td>${escapeHtml(p.energy_hint)}</td>` +
        `<td>${escapeHtml(p.intent)}</td></tr>`,
      ).join("")
    }</tbody></table>`;
}

function renderForeshadow(pairs) {
  if (!pairs.length) return "<p><em>(none)</em></p>";
  return `<ul class="foreshadow">${pairs.map((p) =>
    `<li>cycle ${p.plant_at} → cycle ${p.pay_off_at}: ${escapeHtml(p.note)}</li>`,
  ).join("")}</ul>`;
}

function renderVocabulary(v) {
  return `<div class="vocab">` +
    `<p><strong>Anchors:</strong> ${v.anchors.map(escapeHtml).join(", ")}</p>` +
    `<p><strong>Palette progression:</strong></p><ol>` +
    v.palette_progression.map((p) =>
      `<li>cycles ${p.cycle_range[0]}–${p.cycle_range[1]}: ${escapeHtml(p.palette)}</li>`,
    ).join("") +
    `</ol></div>`;
}

const STYLE = `
  body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif;
         max-width: 920px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { border-bottom: 2px solid #333; padding-bottom: .25rem; }
  .arc li { margin-bottom: .5rem; }
  .arc .range { color: #666; font-weight: normal; font-size: .85em; }
  .cycles { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  .cycles th, .cycles td { padding: .25rem .5rem; border-bottom: 1px solid #eee;
                            text-align: left; vertical-align: top; }
  .vocab { background: #f7f4ee; padding: .75rem 1rem; border-radius: 4px; }
  .foreshadow li { margin: .25rem 0; }
`;

export function renderPlan(bakeDir) {
  const layout = bakeDirLayout(bakeDir);
  const plan = validateOrThrow(compositionPlanSchema,
                               readJson(layout.compositionPlanJson),
                               "composition_plan");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Composition plan — ${escapeHtml(plan.track_id)}</title>
<style>${STYLE}</style></head><body>
<h1>Composition plan: ${escapeHtml(plan.track_id)}
  <small style="font-weight:normal;color:#666">
    (${plan.duration_s.toFixed(1)} s, ${plan.cycle_count} cycles)
  </small></h1>
<h2>Overall arc</h2>${renderArc(plan.overall_arc)}
<h2>Element vocabulary</h2>${renderVocabulary(plan.element_vocabulary)}
<h2>Per-cycle intent</h2>${renderPerCycle(plan.per_cycle_intent)}
<h2>Foreshadow pairs</h2>${renderForeshadow(plan.foreshadow_pairs)}
<hr>
<p style="color:#888;font-size:.8em">model: ${escapeHtml(plan.model)}
 · thinking budget: ${plan.thinking_budget}
 · baked at: ${escapeHtml(plan.baked_at)}</p>
</body></html>`;
  mkdirSync(layout.submissionDir, { recursive: true });
  const out = join(layout.submissionDir, "composition_plan_rendered.html");
  writeFileSync(out, html);
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

    // Build a synthetic composition plan with N cycles
    function makePlan(cycleCount) {
      return {
        track_id: "test_track",
        duration_s: cycleCount * 5,
        cycle_count: cycleCount,
        overall_arc: [{ act_index: 0, name: "Opening", cycle_range: [0, cycleCount - 1], intent: "establish" }],
        per_cycle_intent: Array.from({ length: cycleCount }, (_, i) => ({
          cycle: i, active_act: 0, intent: `intent for cycle ${i}`, energy_hint: "low",
        })),
        element_vocabulary: {
          anchors: ["solitary figure", "candlelight"],
          palette_progression: [{ cycle_range: [0, cycleCount - 1], palette: "warm amber" }],
          introduce_at: {},
          retire_at: {},
        },
        foreshadow_pairs: [{ plant_at: 0, pay_off_at: cycleCount - 1, note: "opening echoes close" }],
        anticipation_offsets_ms: { "0": 0 },
        model: "claude-opus-4-7",
        thinking_budget: 1,
        baked_at: "2026-04-25T00:00:00Z",
      };
    }

    await t("output HTML contains track_id heading", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "brp-test-"));
      const bakeDir = join(tmp, "bake_x");
      mkd(bakeDir);
      wf(join(bakeDir, "composition_plan.json"), JSON.stringify(makePlan(1)));
      const outPath = renderPlan(bakeDir);
      const html = rf(outPath, "utf8");
      assert.match(html, /Composition plan: test_track/);
    });

    await t("HTML contains Per-cycle intent heading", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "brp-test2-"));
      const bakeDir = join(tmp, "bake_y");
      mkd(bakeDir);
      wf(join(bakeDir, "composition_plan.json"), JSON.stringify(makePlan(2)));
      const outPath = renderPlan(bakeDir);
      const html = rf(outPath, "utf8");
      assert.match(html, /Per-cycle intent/);
    });

    await t("number of <tr> intent rows matches cycle_count", async () => {
      const cycleCount = 4;
      const tmp = mkdtempSync(join(tmpdir(), "brp-test3-"));
      const bakeDir = join(tmp, "bake_z");
      mkd(bakeDir);
      wf(join(bakeDir, "composition_plan.json"), JSON.stringify(makePlan(cycleCount)));
      const outPath = renderPlan(bakeDir);
      const html = rf(outPath, "utf8");
      // Count data rows in the cycles table (tbody <tr>s contain cycle index td)
      const trMatches = html.match(/<tr><td>\d/g) || [];
      assert.equal(trMatches.length, cycleCount, `expected ${cycleCount} cycle rows, got ${trMatches.length}`);
    });

    await t("HTML is self-contained (no external src= or href= links)", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "brp-test4-"));
      const bakeDir = join(tmp, "bake_w");
      mkd(bakeDir);
      wf(join(bakeDir, "composition_plan.json"), JSON.stringify(makePlan(3)));
      const outPath = renderPlan(bakeDir);
      const html = rf(outPath, "utf8");
      assert.ok(!/src="http/.test(html), "should not contain external src");
      assert.ok(!/href="http/.test(html), "should not contain external href");
    });

    await t("foreshadow pair appears in output", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "brp-test5-"));
      const bakeDir = join(tmp, "bake_v");
      mkd(bakeDir);
      wf(join(bakeDir, "composition_plan.json"), JSON.stringify(makePlan(2)));
      const outPath = renderPlan(bakeDir);
      const html = rf(outPath, "utf8");
      assert.match(html, /opening echoes close/);
    });

    process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
    if (fail > 0) process.exit(1);
  } else {
    const bakeDir = process.argv[2];
    if (!bakeDir) {
      process.stderr.write("usage: node src/bake_render_plan.mjs [--self-test | <bake_dir>]\n");
      process.exit(1);
    }
    process.stdout.write(`${renderPlan(bakeDir)}\n`);
  }
}
