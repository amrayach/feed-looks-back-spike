import { z } from "zod";

export const ReactivitySchema = z.object({
  property: z.enum(["opacity", "scale", "rotation", "translateX", "translateY", "color_hue"]),
  feature: z.enum([
    "amplitude",
    "onset_strength",
    "spectral_centroid",
    "hijaz_state",
    "hijaz_intensity",
    "hijaz_tahwil",
  ]),
  // Inner map is strict: unknown keys reject. Tuple entries must be
  // finite — Infinity/NaN propagate into easing arithmetic and break
  // the binding engine downstream.
  map: z.object({
    in: z.tuple([z.number().finite(), z.number().finite()]),
    out: z.tuple([z.number().finite(), z.number().finite()]),
    curve: z.enum(["linear", "ease-in", "ease-out", "impulse"]),
  }).strict(),
  // Smoothing in ms must be nonnegative and finite. An LLM-authored
  // tool call that forgets the unit and passes Infinity (or a negative
  // value) must reject, not silently degrade to "forever" or run time
  // backwards.
  smoothing_ms: z.number().finite().nonnegative().optional(),
}).strict();

const HIJAZ_STATES = ["quiet", "approach", "arrived", "tahwil", "aug2"];

const FEATURE_VALUE_SCHEMAS = {
  amplitude: z.number().min(0).max(1),
  onset_strength: z.number().min(0).max(1),
  spectral_centroid: z.number().min(0),
  hijaz_state: z.enum(HIJAZ_STATES),
  hijaz_intensity: z.number().min(0).max(1),
  hijaz_tahwil: z.boolean(),
};

export function FeatureValueSchema(feature) {
  const schema = FEATURE_VALUE_SCHEMAS[feature];
  if (!schema) throw new Error(`unknown feature name: ${feature}`);
  return schema;
}

export const FEATURE_NAMES = Object.freeze(Object.keys(FEATURE_VALUE_SCHEMAS));

export const FeatureFrameSchema = z.object({
  t: z.number(),
  amplitude: FEATURE_VALUE_SCHEMAS.amplitude,
  onset_strength: FEATURE_VALUE_SCHEMAS.onset_strength,
  spectral_centroid: FEATURE_VALUE_SCHEMAS.spectral_centroid,
  hijaz_state: FEATURE_VALUE_SCHEMAS.hijaz_state,
  hijaz_intensity: FEATURE_VALUE_SCHEMAS.hijaz_intensity,
  hijaz_tahwil: FEATURE_VALUE_SCHEMAS.hijaz_tahwil,
});

export const FeaturesTrackSchema = z.object({
  schema_version: z.literal("1"),
  duration_s: z.number().nonnegative(),
  frame_rate_hz: z.number().positive(),
  frames: z.array(FeatureFrameSchema),
});

export function assertFeatureFrame(value) {
  return FeatureFrameSchema.parse(value);
}

export function assertFeaturesTrack(value) {
  return FeaturesTrackSchema.parse(value);
}

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
  z.object({
    type: z.literal("sketch.background.set"),
    sketch_id: z.string(),
    code: z.string(),
    audio_reactive: z.boolean(),
  }),
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

const WsMessageUnion = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("patch"), patch: PatchSchema }),
  z.object({
    channel: z.literal("feature"),
    feature: z.enum(FEATURE_NAMES),
    value: z.unknown(),
  }),
]);

export const WsMessageSchema = WsMessageUnion.superRefine((data, ctx) => {
  if (data.channel !== "feature") return;
  const result = FEATURE_VALUE_SCHEMAS[data.feature].safeParse(data.value);
  if (!result.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `invalid value for feature '${data.feature}': ${result.error.message}`,
      path: ["value"],
    });
  }
});

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

  t("ReactivitySchema accepts hijaz_state as a feature name", () => {
    const parsed = ReactivitySchema.parse({
      property: "opacity",
      feature: "hijaz_state",
      map: { in: [0, 1], out: [0, 1], curve: "linear" },
    });
    assert.equal(parsed.feature, "hijaz_state");
  });

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

  t("FeatureValueSchema validates amplitude in [0,1]", () => {
    assert.equal(FeatureValueSchema("amplitude").parse(0.5), 0.5);
    assert.throws(() => FeatureValueSchema("amplitude").parse(1.5));
    assert.throws(() => FeatureValueSchema("amplitude").parse(-0.1));
  });

  t("FeatureValueSchema validates hijaz_state enum", () => {
    assert.equal(FeatureValueSchema("hijaz_state").parse("arrived"), "arrived");
    assert.throws(() => FeatureValueSchema("hijaz_state").parse("unknown_state"));
  });

  t("FeatureValueSchema validates hijaz_tahwil boolean", () => {
    assert.equal(FeatureValueSchema("hijaz_tahwil").parse(true), true);
    assert.throws(() => FeatureValueSchema("hijaz_tahwil").parse("true"));
  });

  t("FeatureFrameSchema requires all six features plus timestamp", () => {
    const parsed = FeatureFrameSchema.parse({
      t: 1.234,
      amplitude: 0.4,
      onset_strength: 0.2,
      spectral_centroid: 1200,
      hijaz_state: "approach",
      hijaz_intensity: 0.6,
      hijaz_tahwil: false,
    });
    assert.equal(parsed.hijaz_state, "approach");
    assert.throws(() => FeatureFrameSchema.parse({ t: 0 }));
  });

  t("FeaturesTrackSchema requires schema_version '1' and a frames array", () => {
    const parsed = FeaturesTrackSchema.parse({
      schema_version: "1",
      duration_s: 0.1,
      frame_rate_hz: 60,
      frames: [
        {
          t: 0,
          amplitude: 0,
          onset_strength: 0,
          spectral_centroid: 0,
          hijaz_state: "quiet",
          hijaz_intensity: 0,
          hijaz_tahwil: false,
        },
      ],
    });
    assert.equal(parsed.frames.length, 1);
    assert.throws(() =>
      FeaturesTrackSchema.parse({
        schema_version: "2",
        duration_s: 1,
        frame_rate_hz: 60,
        frames: [],
      }),
    );
  });

  t("WsMessageSchema feature arm validates feature/value pair", () => {
    const parsed = WsMessageSchema.parse({
      channel: "feature",
      feature: "amplitude",
      value: 0.7,
    });
    assert.equal(parsed.value, 0.7);
    assert.throws(() =>
      WsMessageSchema.parse({ channel: "feature", feature: "amplitude", value: 1.7 }),
    );
    assert.throws(() =>
      WsMessageSchema.parse({ channel: "feature", feature: "unknown", value: 0 }),
    );
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
