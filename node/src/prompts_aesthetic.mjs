// node/src/prompts_aesthetic.mjs
// Regression tests for spec §1 ("figurative, not abstract"). The prompt
// is a load-bearing artifact. Any appearance of an abstract aesthetic
// category in prompt text — even as an example of what to avoid —
// pattern-matches as a seed for Opus, which historically regressed
// toward whatever shape was named regardless of surrounding negation.
// So this test is strict: the forbidden vocabulary must not appear
// at all. Tell Opus what to DO (figurative motifs); never mention
// what to avoid by name.
//
// Scope: node/prompts/hijaz_base.md + node/prompts/configs/*/tools.json.
// Running: node node/src/prompts_aesthetic.mjs

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_ROOT = join(__dirname, "..", "prompts");

// Canonical forbidden aesthetic vocabulary. Any case-insensitive
// word-boundary match in a prompt source fails the test. Adding a
// term here is a scope expansion; removing one requires a plan
// amendment — this list is a contract, not a suggestion.
export const FORBIDDEN_AESTHETIC_TERMS = [
  "halo ring",
  "pulsing line",
  "flow field",
  "flow-field",
  "particle",
  "particles",
  "particle system",
  "noise field",
  "noise-field",
  "noise loop",
  "perlin noise",
  "perlin-noise",
];

// At-least-one must appear in hijaz_base.md. Guards against an
// over-zealous scrub that strips every example and leaves nothing
// concrete for Opus to pattern-match on.
const REQUIRED_FIGURATIVE_MOTIFS = [
  /\bcandle\b/i,
  /\bleaf\b|\bleaves\b/i,
  /\bbreath\b/i,
  /\btextile\b/i,
  /\bcalligraphic\b/i,
  /\blantern\b/i,
];

function promptSources() {
  const files = [join(PROMPTS_ROOT, "hijaz_base.md")];
  const configsRoot = join(PROMPTS_ROOT, "configs");
  try {
    for (const cfg of readdirSync(configsRoot)) {
      files.push(join(configsRoot, cfg, "tools.json"));
    }
  } catch { /* configs dir may be absent in some repos */ }
  return files;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  t("no forbidden aesthetic term appears in any prompt source (strict, zero-hit)", () => {
    for (const file of promptSources()) {
      const body = readFileSync(file, "utf8");
      for (const term of FORBIDDEN_AESTHETIC_TERMS) {
        const re = new RegExp("\\b" + escapeRegex(term) + "\\b", "i");
        assert.ok(!re.test(body), `"${term}" still appears in ${file}`);
      }
    }
  });

  t("at least one figurative motif appears in hijaz_base.md", () => {
    const body = readFileSync(join(PROMPTS_ROOT, "hijaz_base.md"), "utf8");
    const hit = REQUIRED_FIGURATIVE_MOTIFS.find((re) => re.test(body));
    assert.ok(
      hit,
      "hijaz_base.md has no figurative motif from the required list — prompt may have been over-scrubbed",
    );
  });

  t("FORBIDDEN_AESTHETIC_TERMS contains every term the rework plan enumerates", () => {
    // Deletion guard. If you're removing one of these, amend the plan
    // first; the test is here to catch accidental scope shrinkage.
    const required = [
      "halo ring", "pulsing line",
      "flow field", "flow-field",
      "particle", "particles", "particle system",
      "noise field", "noise-field", "noise loop",
      "perlin noise", "perlin-noise",
    ];
    const missing = required.filter((term) => !FORBIDDEN_AESTHETIC_TERMS.includes(term));
    assert.deepEqual(missing, [], `missing forbidden terms: ${missing.join(", ")}`);
  });

  t("hijaz_state doc reflects exact-match gating (Fix 4), not threshold semantics", () => {
    const body = readFileSync(join(PROMPTS_ROOT, "hijaz_base.md"), "utf8");
    assert.ok(!/value\s*≥\s*3\s*maps to/i.test(body), "old threshold-semantics doc still present");
    assert.ok(/exact-match/i.test(body), "doc should describe collapsed map.in as exact-match");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
