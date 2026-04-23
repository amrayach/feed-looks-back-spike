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
}) {
  const cleanCycle = stripDebug(cycle);
  const userText = formatUserMessage(cleanCycle, sceneStateSummary);

  return {
    model,
    max_tokens: maxTokens,
    system: [
      {
        type: "text",
        text: hijazBase,
      },
      {
        type: "text",
        text: mediumRules,
        // Anthropic caches the prefix up to the last marked system block.
        // Put the breakpoint here so tools + both system blocks are reusable.
        cache_control: { type: "ephemeral" },
      },
    ],
    tools,
    messages: [
      {
        role: "user",
        content: userText,
      },
    ],
  };
}
