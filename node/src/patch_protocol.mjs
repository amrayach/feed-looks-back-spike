import { z } from "zod";

export const ReactivitySchema = z.object({
  property: z.enum(["opacity", "scale", "rotation", "translateX", "translateY", "color_hue"]),
  feature: z.enum(["amplitude", "onset_strength", "spectral_centroid", "hijaz_intensity", "hijaz_tahwil"]),
  map: z.object({
    in: z.tuple([z.number(), z.number()]),
    out: z.tuple([z.number(), z.number()]),
    curve: z.enum(["linear", "ease-in", "ease-out", "impulse"]),
  }),
  smoothing_ms: z.number().optional(),
});

export const ElementSpecSchema = z.object({
  element_id: z.string(),
  type: z.enum(["text", "svg", "image"]),
  content: z.record(z.string(), z.unknown()),
  lifetime_s: z.number().nullable(),
  composition_group_id: z.string().nullable(),
  reactivity: z.array(ReactivitySchema).optional(),
});

export const CompositionGroupSchema = z.object({
  group_id: z.string(),
  group_label: z.string(),
  member_element_ids: z.array(z.string()),
  lifetime_s: z.number().nullable(),
});

export const PatchSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("background.set"),
    css_background: z.string(),
    fallback_reason: z.string().nullable().optional(),
    original_css_background: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal("element.add"), element: ElementSpecSchema }),
  z.object({
    type: z.literal("element.update"),
    element_id: z.string(),
    changes: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal("element.fade"), element_id: z.string(), duration_ms: z.number() }),
  z.object({ type: z.literal("element.remove"), element_id: z.string() }),
  z.object({ type: z.literal("composition_group.add"), group: CompositionGroupSchema }),
  z.object({
    type: z.literal("composition_group.fade"),
    group_id: z.string(),
    member_ids: z.array(z.string()),
    duration_ms: z.number(),
  }),
  z.object({ type: z.literal("sketch.background.set"), code: z.string(), audio_reactive: z.boolean() }),
  z.object({
    type: z.literal("sketch.add"),
    sketch_id: z.string(),
    position: z.string(),
    size: z.enum(["small", "medium", "large"]),
    code: z.string(),
    audio_reactive: z.boolean(),
    lifetime_s: z.number().nullable(),
  }),
  z.object({ type: z.literal("sketch.retire"), sketch_id: z.string() }),
  z.object({ type: z.literal("cycle.begin"), cycle_n: z.number(), hijaz_state: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("cycle.end") }),
  z.object({ type: z.literal("prompt.replace"), version: z.string() }),
  z.object({ type: z.literal("replay.begin"), run_id: z.string() }),
  z.object({ type: z.literal("replay.end"), run_id: z.string() }),
]);

export const WsMessageSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("patch"), patch: PatchSchema }),
  z.object({ channel: z.literal("feature"), feature: z.string(), value: z.unknown() }),
]);

export function assertPatch(value) {
  return PatchSchema.parse(value);
}

export function assertWsMessage(value) {
  return WsMessageSchema.parse(value);
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

  t("PatchSchema accepts background.set", () => {
    const parsed = PatchSchema.parse({
      type: "background.set",
      css_background: "linear-gradient(180deg, #000, #111)",
      fallback_reason: null,
      original_css_background: null,
    });
    assert.equal(parsed.type, "background.set");
  });

  t("PatchSchema accepts element.add with top-level composition_group_id", () => {
    const parsed = PatchSchema.parse({
      type: "element.add",
      element: {
        element_id: "elem_0001",
        type: "text",
        content: { content: "after", position: "lower-left", style: "serif, large" },
        lifetime_s: null,
        composition_group_id: "group_0001",
      },
    });
    assert.equal(parsed.element.composition_group_id, "group_0001");
  });

  t("PatchSchema accepts composition_group.fade", () => {
    const parsed = PatchSchema.parse({
      type: "composition_group.fade",
      group_id: "group_0001",
      member_ids: ["elem_0001", "elem_0002"],
      duration_ms: 400,
    });
    assert.equal(parsed.member_ids.length, 2);
  });

  t("PatchSchema accepts replay.begin and replay.end", () => {
    assert.equal(PatchSchema.parse({ type: "replay.begin", run_id: "run_123" }).run_id, "run_123");
    assert.equal(PatchSchema.parse({ type: "replay.end", run_id: "run_123" }).run_id, "run_123");
  });

  t("PatchSchema rejects unknown patch types", () => {
    assert.throws(() => PatchSchema.parse({ type: "unknown.patch" }), /Invalid discriminator value/);
  });

  t("WsMessageSchema accepts patch channel payloads", () => {
    const parsed = WsMessageSchema.parse({
      channel: "patch",
      patch: { type: "cycle.end" },
    });
    assert.equal(parsed.channel, "patch");
  });

  t("WsMessageSchema accepts feature channel payloads", () => {
    const parsed = WsMessageSchema.parse({
      channel: "feature",
      feature: "amplitude",
      value: 0.5,
    });
    assert.equal(parsed.feature, "amplitude");
  });

  t("WsMessageSchema rejects malformed payloads", () => {
    assert.throws(() =>
      WsMessageSchema.parse({
        channel: "patch",
        patch: { type: "element.add", element: { element_id: "x" } },
      }),
    );
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
