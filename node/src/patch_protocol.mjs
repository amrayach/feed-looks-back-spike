import { z } from "zod";

// Layer tokens stamp each element or sketch with a coarse z-order band.
// The browser reducer translates these into z-index values so Opus can
// author depth without computing raw numbers. Non-exhaustive: unspecified
// layers fall back to per-type defaults (see LAYER_DEFAULTS_BY_TYPE).
export const LAYER_TOKENS = Object.freeze(["background", "midground", "foreground"]);
export const LAYER_DEFAULTS_BY_TYPE = Object.freeze({
  text: "foreground",
  svg: "foreground",
  image: "midground",
  p5_background: "background",
  p5_localized: "background",
});

// Motion preset tokens. Each expands locally (in the binding engine) into
// an audio-parameterized kernel that contributes transform/filter state
// alongside any explicit reactivity bindings. The kernel reads features
// from the bus but follows its own curve — it is NOT a pre-scripted
// keyframe animation. The preset is a live response curve.
//
// Semantics (guidance for authors, enforced by the engine):
//   breathe — slow scale oscillation (1.0 ↔ ~1.04) paced by hijaz_intensity
//   pulse   — scale pops on onset_strength impulses (decays to rest)
//   orbit   — small circular translateX/translateY drift, amplitude-modulated radius
//   drift   — slow low-frequency wander in translateX/translateY
//   tremble — tiny rotation jitter gated by onset_strength
export const MOTION_PRESETS = Object.freeze(["breathe", "pulse", "orbit", "drift", "tremble"]);

export const MotionSchema = z.object({
  preset: z.enum(MOTION_PRESETS),
  // Scalar multiplier on the kernel's output magnitude. Default 1.0.
  // Clamped finite + nonnegative to block an LLM-authored Infinity that
  // would blow up the DOM each frame. Zero is a legal "mute" value.
  intensity: z.number().finite().nonnegative().optional(),
  // Optional feature override. Each preset has a natural default feature
  // (breathe→hijaz_intensity, pulse→onset_strength, orbit→amplitude,
  // drift→hijaz_intensity, tremble→onset_strength); passing an explicit
  // `feature` lets an author rebind the kernel's input without rewriting
  // the primitive binding set.
  feature: z.enum([
    "amplitude",
    "onset_strength",
    "spectral_centroid",
    "hijaz_state",
    "hijaz_intensity",
    "hijaz_tahwil",
  ]).optional(),
}).strict();

export const ReactivitySchema = z.object({
  property: z.enum([
    "opacity",
    "scale",
    "rotation",
    "translateX",
    "translateY",
    "color_hue",
    // v6.2 additions — filter modulation
    "blur",
    "saturation",
  ]),
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

// Recompose-tool shared primitives. Named here so the patch union below
// and tool_handlers can import the same validation surface. Kept strict
// so LLM-authored calls that forget a unit (e.g. "duration_ms: Infinity")
// reject rather than silently animate forever.
export const TransformSpecSchema = z.object({
  rotate: z.number().finite().optional(),
  scale: z.number().finite().positive().optional(),
  translate: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  }).strict().optional(),
}).strict().refine(
  (t) => t.rotate !== undefined || t.scale !== undefined || t.translate !== undefined,
  { message: "transform must specify at least one of rotate, scale, translate" },
);

export const PaletteTargetSchema = z.object({
  hue: z.number().finite().optional(),
  saturation: z.number().finite().nonnegative().optional(),
  lightness: z.number().finite().nonnegative().optional(),
}).strict().refine(
  (p) => p.hue !== undefined || p.saturation !== undefined || p.lightness !== undefined,
  { message: "palette target must specify at least one of hue, saturation, lightness" },
);

export const MorphTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("svg"), content_or_src: z.string().min(1) }),
  z.object({ type: z.literal("image"), content_or_src: z.string().min(1) }),
]);

export const TEXT_ANIMATE_EFFECTS = Object.freeze([
  "typewriter",
  "wordByWord",
  "marquee",
  "shake",
]);

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
  // v6.2: coarse depth band. Missing → per-type default in the browser.
  layer: z.enum(LAYER_TOKENS).optional(),
  // v6.2: motion preset attached to this element. Expands to a live
  // kernel in binding_engine; one preset per element (compose via
  // explicit reactivity bindings instead of stacking presets).
  motion: MotionSchema.optional(),
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
    // v6.2: optional depth band for the iframe. Omitted → background.
    layer: z.enum(LAYER_TOKENS).optional(),
  }),
  z.object({ type: z.literal("sketch.retire"), sketch_id: z.string() }),
  z.object({ type: z.literal("cycle.begin"), cycle_n: z.number(), hijaz_state: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("cycle.end") }),
  z.object({ type: z.literal("prompt.replace"), version: z.string() }),
  z.object({ type: z.literal("replay.begin"), run_id: z.string() }),
  z.object({ type: z.literal("replay.end"), run_id: z.string() }),
  // Recompose patches (expanded-tools). Ephemeral DOM animations /
  // asset swaps on elements that already exist. They do not replay
  // (reconnecting mid-run lands on the post-animation steady state),
  // so patch_cache treats them as no-ops.
  z.object({
    type: z.literal("element.transform"),
    element_id: z.string(),
    transform: TransformSpecSchema,
    duration_ms: z.number().finite().nonnegative(),
  }),
  z.object({
    type: z.literal("element.morph"),
    element_id: z.string(),
    to: MorphTargetSchema,
    duration_ms: z.number().finite().nonnegative(),
  }),
  z.object({
    type: z.literal("scene.pulse"),
    intensity: z.number().finite().min(0).max(1),
    color: z.string().nullable().optional(),
    duration_ms: z.number().finite().nonnegative(),
  }),
  z.object({
    type: z.literal("scene.palette_shift"),
    target: PaletteTargetSchema,
    duration_ms: z.number().finite().nonnegative(),
  }),
  z.object({
    type: z.literal("text.animate"),
    element_id: z.string(),
    effect: z.enum(TEXT_ANIMATE_EFFECTS),
    duration_ms: z.number().finite().nonnegative(),
  }),
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

  t("ElementSpecSchema accepts optional layer token and rejects unknown layers", () => {
    const base = {
      element_id: "elem_0042",
      type: "image",
      content: { query: "x", position: "background" },
      lifetime_s: null,
      composition_group_id: null,
      layer: "midground",
    };
    assert.equal(ElementSpecSchema.parse(base).layer, "midground");
    assert.throws(() => ElementSpecSchema.parse({ ...base, layer: "overlay" }));
    // Absent layer stays absent (per-type default resolved in the browser).
    const { layer, ...withoutLayer } = base;
    assert.equal("layer" in ElementSpecSchema.parse(withoutLayer), false);
  });

  t("ElementSpecSchema accepts motion preset and rejects non-preset tokens", () => {
    const base = {
      element_id: "elem_0043",
      type: "svg",
      content: { svg_markup: "<svg></svg>", position: "center", semantic_label: "s" },
      lifetime_s: 35,
      composition_group_id: null,
      motion: { preset: "breathe" },
    };
    assert.equal(ElementSpecSchema.parse(base).motion.preset, "breathe");
    // Every advertised preset is accepted:
    for (const preset of MOTION_PRESETS) {
      assert.equal(ElementSpecSchema.parse({ ...base, motion: { preset } }).motion.preset, preset);
    }
    // Unknown preset rejected.
    assert.throws(() => ElementSpecSchema.parse({ ...base, motion: { preset: "shimmer" } }));
    // Infinity intensity rejected (LLM forgot the unit).
    assert.throws(() =>
      ElementSpecSchema.parse({ ...base, motion: { preset: "pulse", intensity: Infinity } }),
    );
    // Negative intensity rejected (nonsensical magnitude).
    assert.throws(() =>
      ElementSpecSchema.parse({ ...base, motion: { preset: "pulse", intensity: -1 } }),
    );
    // Extra keys rejected (strict schema — motion shape is a small contract).
    assert.throws(() =>
      ElementSpecSchema.parse({ ...base, motion: { preset: "drift", amplitude: 0.5 } }),
    );
  });

  t("ReactivitySchema.property enum now includes blur and saturation", () => {
    const base = { feature: "amplitude", map: { in: [0, 1], out: [0, 1], curve: "linear" } };
    for (const property of ["blur", "saturation"]) {
      assert.equal(ReactivitySchema.parse({ property, ...base }).property, property);
    }
    assert.throws(() => ReactivitySchema.parse({ property: "sharpen", ...base }));
  });

  t("sketch.add patch accepts an optional layer token", () => {
    const patch = {
      type: "sketch.add",
      sketch_id: "sketch_0009",
      position: "mid-right",
      size: "medium",
      code: "noop()",
      audio_reactive: false,
      lifetime_s: null,
      layer: "midground",
    };
    assert.equal(PatchSchema.parse(patch).layer, "midground");
    // Unknown layer rejected.
    assert.throws(() => PatchSchema.parse({ ...patch, layer: "hud" }));
    // Omitted layer parses (browser resolves default).
    const { layer, ...noLayer } = patch;
    assert.equal("layer" in PatchSchema.parse(noLayer), false);
  });

  t("LAYER_DEFAULTS_BY_TYPE covers every placement type Opus can author", () => {
    // If a new element or sketch type is added without updating the
    // default map, this test fails — future-proofing the z-order contract.
    const expected = ["text", "svg", "image", "p5_background", "p5_localized"].sort();
    assert.deepEqual([...Object.keys(LAYER_DEFAULTS_BY_TYPE)].sort(), expected);
    for (const layer of Object.values(LAYER_DEFAULTS_BY_TYPE)) {
      assert.ok(LAYER_TOKENS.includes(layer), `default ${layer} is not a legal layer token`);
    }
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

  // ─── Recompose patch types (expanded-tools) ───────────────────────
  t("PatchSchema accepts element.transform with rotate+scale+translate", () => {
    const parsed = PatchSchema.parse({
      type: "element.transform",
      element_id: "elem_0001",
      transform: { rotate: 15, scale: 1.2, translate: { x: 40, y: -10 } },
      duration_ms: 600,
    });
    assert.equal(parsed.transform.rotate, 15);
    assert.equal(parsed.transform.translate.x, 40);
  });

  t("PatchSchema rejects element.transform with empty transform object", () => {
    assert.throws(() =>
      PatchSchema.parse({
        type: "element.transform",
        element_id: "elem_0001",
        transform: {},
        duration_ms: 300,
      }),
    );
  });

  t("PatchSchema rejects element.transform with negative duration or non-finite scale", () => {
    assert.throws(() =>
      PatchSchema.parse({
        type: "element.transform",
        element_id: "elem_0001",
        transform: { rotate: 15 },
        duration_ms: -1,
      }),
    );
    assert.throws(() =>
      PatchSchema.parse({
        type: "element.transform",
        element_id: "elem_0001",
        transform: { scale: Number.POSITIVE_INFINITY },
        duration_ms: 300,
      }),
    );
  });

  t("PatchSchema accepts element.morph with svg target and image target", () => {
    const svgParsed = PatchSchema.parse({
      type: "element.morph",
      element_id: "elem_0002",
      to: { type: "svg", content_or_src: "<svg viewBox='0 0 10 10'><circle cx='5' cy='5' r='4'/></svg>" },
      duration_ms: 800,
    });
    assert.equal(svgParsed.to.type, "svg");
    const imgParsed = PatchSchema.parse({
      type: "element.morph",
      element_id: "elem_0002",
      to: { type: "image", content_or_src: "minaret at dusk" },
      duration_ms: 800,
    });
    assert.equal(imgParsed.to.type, "image");
  });

  t("PatchSchema rejects element.morph with unknown to.type", () => {
    assert.throws(() =>
      PatchSchema.parse({
        type: "element.morph",
        element_id: "elem_0002",
        to: { type: "video", content_or_src: "x" },
        duration_ms: 100,
      }),
    );
  });

  t("PatchSchema accepts scene.pulse with color and clamps intensity to [0,1]", () => {
    const parsed = PatchSchema.parse({
      type: "scene.pulse",
      intensity: 0.7,
      color: "#d59c6a",
      duration_ms: 400,
    });
    assert.equal(parsed.intensity, 0.7);
    assert.equal(parsed.color, "#d59c6a");
    assert.throws(() =>
      PatchSchema.parse({ type: "scene.pulse", intensity: 1.7, duration_ms: 400 }),
    );
  });

  t("PatchSchema accepts scene.palette_shift and rejects empty target", () => {
    const parsed = PatchSchema.parse({
      type: "scene.palette_shift",
      target: { hue: 20, saturation: 0.8 },
      duration_ms: 1200,
    });
    assert.equal(parsed.target.hue, 20);
    assert.throws(() =>
      PatchSchema.parse({
        type: "scene.palette_shift",
        target: {},
        duration_ms: 1200,
      }),
    );
  });

  t("PatchSchema accepts text.animate for each allowed effect and rejects unknown ones", () => {
    for (const effect of ["typewriter", "wordByWord", "marquee", "shake"]) {
      const parsed = PatchSchema.parse({
        type: "text.animate",
        element_id: "elem_0003",
        effect,
        duration_ms: 500,
      });
      assert.equal(parsed.effect, effect);
    }
    assert.throws(() =>
      PatchSchema.parse({
        type: "text.animate",
        element_id: "elem_0003",
        effect: "rotate",
        duration_ms: 500,
      }),
    );
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
