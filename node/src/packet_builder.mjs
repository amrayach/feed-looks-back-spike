export function formatEmptySceneStateSummary(elapsedTotalS) {
  return (
    `Current scene (0 elements visible, ${elapsedTotalS}s since performance start):\n\n` +
    `(empty — nothing has been placed yet)\n\nBACKGROUND: (not set)`
  );
}

function stripDebug(cycle) {
  const { _debug, ...rest } = cycle;
  return rest;
}

function formatUserMessage(cycle, sceneStateSummary) {
  const block1 = JSON.stringify(cycle.block_1_scalars, null, 2);
  const block2 = cycle.block_2_summary;
  const sparks = cycle.block_3_sparklines;
  const { rms, onset, centroid } = sparks;

  return [
    `You are receiving cycle ${cycle.cycle_index} of the performance.`,
    ``,
    `BLOCK 1 — SCALAR SUMMARY (last 4 seconds):`,
    block1,
    ``,
    `BLOCK 2 — DETERMINISTIC PROSE CAPTION:`,
    block2,
    ``,
    `BLOCK 3 — SPARKLINES:`,
    `RMS:      ${rms}`,
    `Onsets:   ${onset}`,
    `Centroid: ${centroid}`,
    ``,
    `CURRENT SCENE STATE:`,
    sceneStateSummary,
    ``,
    `Decide what to do, and act with the tools. You may call zero, one, or several tools. If silence is the right answer, call no tools.`,
  ].join("\n");
}

export function buildPacket({
  cycle,
  sceneStateSummary,
  hijazBase,
  mediumRules,
  tools,
  model,
  // Raised from 2000. Output ran 500-1000 in prior runs — not strictly tight,
  // but a composite scene (3-5 elements each with its own markup/metadata)
  // can easily use 1500-2500 tokens for a single call. 4000 gives headroom
  // for a dense cycle without meaningfully changing cost.
  maxTokens = 4000,
  moodBoardBlocks = [],
  selfFrameUserBlocks = [],
}) {
  const cleanCycle = stripDebug(cycle);
  const userText = formatUserMessage(cleanCycle, sceneStateSummary);

  // When mood-board blocks are present, the cache breakpoint moves from the
  // medium_rules text block to a trailing empty block *after* the mood-board
  // images (that block ships inside moodBoardBlocks), so tools + all text
  // blocks + mood-board images are cached together. When absent, preserve
  // the prior placement so the existing 131 tests stay green.
  const hasMoodBoard = Array.isArray(moodBoardBlocks) && moodBoardBlocks.length > 0;
  const system = hasMoodBoard
    ? [
        { type: "text", text: hijazBase },
        { type: "text", text: mediumRules },
        ...moodBoardBlocks,
      ]
    : [
        { type: "text", text: hijazBase },
        {
          type: "text",
          text: mediumRules,
          cache_control: { type: "ephemeral" },
        },
      ];

  const userContent =
    Array.isArray(selfFrameUserBlocks) && selfFrameUserBlocks.length > 0
      ? [{ type: "text", text: userText }, ...selfFrameUserBlocks]
      : userText;

  return {
    model,
    max_tokens: maxTokens,
    system,
    tools,
    messages: [
      {
        role: "user",
        content: userContent,
      },
    ],
  };
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

  const fakeCycle = {
    cycle_index: 3,
    block_1_scalars: { rms: 0.1, onset: 0.2, centroid: 2000 },
    block_2_summary: "soft murmur",
    block_3_sparklines: { rms: "▁▂▃", onset: "▁▁▂", centroid: "▃▄▅" },
  };

  t("formatEmptySceneStateSummary interpolates elapsed seconds", () => {
    const summary = formatEmptySceneStateSummary(42);
    assert.match(summary, /0 elements visible, 42s/);
    assert.match(summary, /empty/);
  });

  t("without mood board, buildPacket preserves 2-block system with cache_control on medium_rules (backwards compatible)", () => {
    const packet = buildPacket({
      cycle: fakeCycle,
      sceneStateSummary: "empty",
      hijazBase: "BASE",
      mediumRules: "RULES",
      tools: [],
      model: "m",
    });
    assert.equal(packet.system.length, 2);
    assert.equal(packet.system[0].text, "BASE");
    assert.equal(packet.system[1].text, "RULES");
    assert.deepEqual(packet.system[1].cache_control, { type: "ephemeral" });
    assert.equal(typeof packet.messages[0].content, "string");
  });

  t("with mood board, buildPacket appends mood-board blocks and the breakpoint travels with them", () => {
    const moodBoardBlocks = [
      { type: "text", text: "MOOD BOARD — ..." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
      { type: "text", text: "", cache_control: { type: "ephemeral" } },
    ];
    const packet = buildPacket({
      cycle: fakeCycle,
      sceneStateSummary: "empty",
      hijazBase: "BASE",
      mediumRules: "RULES",
      tools: [],
      model: "m",
      moodBoardBlocks,
    });
    assert.equal(packet.system.length, 2 + moodBoardBlocks.length);
    assert.equal(packet.system[0].text, "BASE");
    assert.equal(packet.system[1].text, "RULES");
    assert.equal(packet.system[1].cache_control, undefined);
    assert.deepEqual(packet.system.at(-1).cache_control, { type: "ephemeral" });
  });

  t("with self-frame user blocks, messages[0].content becomes an array with user text first", () => {
    const selfFrameUserBlocks = [
      { type: "text", text: "Previous frame ..." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "CCCC" } },
    ];
    const packet = buildPacket({
      cycle: fakeCycle,
      sceneStateSummary: "empty",
      hijazBase: "BASE",
      mediumRules: "RULES",
      tools: [],
      model: "m",
      selfFrameUserBlocks,
    });
    assert.equal(Array.isArray(packet.messages[0].content), true);
    assert.equal(packet.messages[0].content[0].type, "text");
    assert.match(packet.messages[0].content[0].text, /cycle 3/);
    assert.equal(packet.messages[0].content[1].type, "text");
    assert.equal(packet.messages[0].content[2].type, "image");
  });

  t("full composition: mood board + self-frame renders both correctly", () => {
    const packet = buildPacket({
      cycle: fakeCycle,
      sceneStateSummary: "empty",
      hijazBase: "BASE",
      mediumRules: "RULES",
      tools: [],
      model: "m",
      moodBoardBlocks: [
        { type: "text", text: "MB" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "XX" } },
        { type: "text", text: "", cache_control: { type: "ephemeral" } },
      ],
      selfFrameUserBlocks: [
        { type: "text", text: "Previous frame (cycle 2)" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "YY" } },
      ],
    });
    assert.deepEqual(packet.system.at(-1).cache_control, { type: "ephemeral" });
    assert.equal(packet.messages[0].content.length, 3);
  });

  t("empty self-frame array keeps string content (no wrapping)", () => {
    const packet = buildPacket({
      cycle: fakeCycle,
      sceneStateSummary: "empty",
      hijazBase: "BASE",
      mediumRules: "RULES",
      tools: [],
      model: "m",
      selfFrameUserBlocks: [],
    });
    assert.equal(typeof packet.messages[0].content, "string");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
