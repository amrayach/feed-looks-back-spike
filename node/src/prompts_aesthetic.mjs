// node/src/prompts_aesthetic.mjs
// Regression tests for spec §1 ("figurative, not abstract"). The
// prompt is a load-bearing artifact: replacing a figurative exemplar
// with a geometric primitive (halo ring, pulsing line, flow field)
// breaks the piece's aesthetic contract even if every other test is
// green. This module exists only to freeze those exemplars.
//
// Scope: node/prompts/hijaz_base.md + node/prompts/configs/*/tools.json.
// Running: node node/src/prompts_aesthetic.mjs

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_ROOT = join(__dirname, "..", "prompts");

function promptSources() {
  const files = [join(PROMPTS_ROOT, "hijaz_base.md")];
  const configsRoot = join(PROMPTS_ROOT, "configs");
  try {
    for (const cfg of readdirSync(configsRoot)) {
      const toolsPath = join(configsRoot, cfg, "tools.json");
      try { files.push(toolsPath); } catch { /* skip */ }
    }
  } catch { /* configs dir may be absent in some repos */ }
  return files;
}

// Patterns that must NOT appear as exemplars the LLM can pattern-match
// on. These are the shapes that steered prior runs into abstract
// screensaver territory.
const BANNED_EXEMPLARS = [
  { pattern: /halo ring/i,   name: "\"halo ring\"" },
  { pattern: /pulsing line/i, name: "\"pulsing line\"" },
];

// "flow field", "particle", "noise field" ARE allowed in the prompt
// — but ONLY in the context of explicit rejection ("no particle
// clouds", "flow fields are rejections"). A positive exemplar like
// "a flow-field background" would regress the aesthetic.
const CONTEXTUAL_BANS = [
  { pattern: /flow field/i,   name: "flow field" },
  { pattern: /particle cloud/i, name: "particle cloud" },
  { pattern: /noise field/i,   name: "noise field" },
];
// For contextual bans we look within ±80 chars for a rejection marker.
const REJECTION_CUES = /(no\b|avoid|reject|not\b|without|never)/i;

// At least one of these figurative motifs MUST appear as an exemplar
// somewhere in hijaz_base.md. Tracks spec §1's required motifs.
const REQUIRED_FIGURATIVE_MOTIFS = [
  /candle flame/i,
  /trembling leaves/i,
  /breath rising/i,
];

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

  t("no banned exemplars (halo ring, pulsing line) appear in any prompt source", () => {
    for (const file of promptSources()) {
      const body = readFileSync(file, "utf8");
      for (const { pattern, name } of BANNED_EXEMPLARS) {
        assert.ok(!pattern.test(body), `${name} still appears in ${file}`);
      }
    }
  });

  t("contextually banned phrases (flow field, particle cloud, noise field) only appear within a rejection cue", () => {
    for (const file of promptSources()) {
      const body = readFileSync(file, "utf8");
      for (const { pattern, name } of CONTEXTUAL_BANS) {
        let re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
        let match;
        while ((match = re.exec(body))) {
          const start = Math.max(0, match.index - 80);
          const end = Math.min(body.length, match.index + match[0].length + 80);
          const window = body.slice(start, end);
          assert.ok(
            REJECTION_CUES.test(window),
            `"${name}" appears in ${file} without a rejection cue nearby:\n  ...${window}...`,
          );
        }
      }
    }
  });

  t("required figurative motifs appear in hijaz_base.md", () => {
    const body = readFileSync(join(PROMPTS_ROOT, "hijaz_base.md"), "utf8");
    const missing = REQUIRED_FIGURATIVE_MOTIFS.filter((re) => !re.test(body));
    assert.equal(missing.length, 0, `missing motifs: ${missing.map((r) => r.source).join(", ")}`);
  });

  t("hijaz_state doc reflects exact-match gating (Fix 4), not threshold semantics", () => {
    const body = readFileSync(join(PROMPTS_ROOT, "hijaz_base.md"), "utf8");
    // Prior doc text said "any value ≥ 3 maps to out[1]" — the engine
    // no longer behaves that way.
    assert.ok(!/value\s*≥\s*3\s*maps to/i.test(body), "old threshold-semantics doc still present");
    assert.ok(/exact-match/i.test(body), "doc should describe collapsed map.in as exact-match");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
