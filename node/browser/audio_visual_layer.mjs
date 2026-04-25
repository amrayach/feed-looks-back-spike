// Always-on audio-reactive visual bed for the live stage.
//
// This layer is deliberately independent from Opus tool calls: it reads the
// feature bus (and, when available, a browser AudioContext analyser for the
// stage audio element) so the stage keeps breathing while API cycles are in
// flight. It stays behind authored elements and sketches.

const FEATURE_NAMES = [
  "amplitude",
  "onset_strength",
  "spectral_centroid",
  "hijaz_state",
  "hijaz_intensity",
  "hijaz_tahwil",
];

const VALID_STATES = new Set(["quiet", "approach", "arrived", "tahwil", "aug2"]);
const NON_COMMAND_PATCH_TYPES = new Set(["cycle.begin", "cycle.end", "replay.begin", "replay.end"]);

const VISUAL_GRAMMAR = Object.freeze({
  quiet: Object.freeze({
    name: "manuscript hush",
    archAlpha: 0.16,
    columnAlpha: 0.12,
    manuscriptRows: 8,
    ruptureAlpha: 0.08,
    glowAlpha: 0.2,
    opening: 0.18,
  }),
  approach: Object.freeze({
    name: "threshold approach",
    archAlpha: 0.28,
    columnAlpha: 0.22,
    manuscriptRows: 11,
    ruptureAlpha: 0.18,
    glowAlpha: 0.32,
    opening: 0.34,
  }),
  arrived: Object.freeze({
    name: "settled room",
    archAlpha: 0.34,
    columnAlpha: 0.25,
    manuscriptRows: 12,
    ruptureAlpha: 0.14,
    glowAlpha: 0.38,
    opening: 0.42,
  }),
  tahwil: Object.freeze({
    name: "upper threshold",
    archAlpha: 0.42,
    columnAlpha: 0.32,
    manuscriptRows: 15,
    ruptureAlpha: 0.34,
    glowAlpha: 0.48,
    opening: 0.62,
  }),
  aug2: Object.freeze({
    name: "widened gap",
    archAlpha: 0.36,
    columnAlpha: 0.28,
    manuscriptRows: 13,
    ruptureAlpha: 0.72,
    glowAlpha: 0.4,
    opening: 0.52,
  }),
});

const PALETTES = Object.freeze({
  quiet: Object.freeze({
    base: [42, 26, 39],
    warm: [156, 111, 132],
    cool: [74, 43, 68],
    accent: [224, 179, 194],
  }),
  approach: Object.freeze({
    base: [48, 30, 43],
    warm: [178, 118, 126],
    cool: [93, 60, 92],
    accent: [232, 190, 170],
  }),
  arrived: Object.freeze({
    base: [59, 42, 26],
    warm: [198, 151, 89],
    cool: [102, 76, 67],
    accent: [246, 220, 160],
  }),
  tahwil: Object.freeze({
    base: [20, 22, 31],
    warm: [217, 122, 58],
    cool: [74, 85, 112],
    accent: [238, 172, 106],
  }),
  aug2: Object.freeze({
    base: [48, 24, 42],
    warm: [208, 109, 100],
    cool: [83, 70, 120],
    accent: [232, 185, 147],
  }),
});

const OPUS_SHADER_PALETTES = Object.freeze({
  quiet: Object.freeze({
    a: [42, 26, 39],
    b: [156, 111, 132],
    accent: [224, 179, 194],
  }),
  approach: Object.freeze({
    a: [48, 30, 43],
    b: [178, 118, 126],
    accent: [232, 190, 170],
  }),
  arrived: Object.freeze({
    a: [59, 42, 26],
    b: [198, 151, 89],
    accent: [246, 208, 139],
  }),
  tahwil: Object.freeze({
    a: [20, 22, 31],
    b: [74, 85, 112],
    accent: [217, 122, 58],
  }),
  aug2: Object.freeze({
    a: [48, 24, 42],
    b: [208, 109, 100],
    accent: [232, 185, 147],
  }),
});

const SHADER_VERTEX_SOURCE = `
attribute vec2 a_position;
varying vec2 vUv;

void main() {
  vUv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Ported from the Build_With_OPUS_4.7_hack full-screen shader. The text/HUD
// from that project is deliberately not included; this is only the reactive
// visual bed, with audio feature uniforms mapped locally.
const SHADER_FRAGMENT_SOURCE = `
precision highp float;
precision highp int;

varying vec2 vUv;

uniform float u_time;
uniform float u_breath;
uniform float u_escalation;
uniform vec3  u_color_a;
uniform vec3  u_color_b;
uniform vec3  u_accent;
uniform float u_noise_scale;
uniform float u_noise_amp;
uniform float u_distortion;
uniform float u_palette_shift;
uniform float u_grain;
uniform vec2  u_resolution;
uniform vec2  u_pulse;
uniform float u_pulse_strength;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise2(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                 + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float snoise3(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

void main() {
  vec2 p = vUv - 0.5;
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  p.x *= aspect;

  float breath = 0.5 + 0.5 * sin(u_breath * 6.2831853);
  float n = snoise3(vec3(p * u_noise_scale, u_time * 0.15));
  float field = n * u_noise_amp;

  vec2 warp = vec2(
    snoise2(p * u_noise_scale * 1.3 + u_time * 0.08),
    snoise2(p * u_noise_scale * 1.1 - u_time * 0.07)
  ) * u_distortion;

  float radial = length(p + warp) * (1.0 + 0.15 * u_escalation);
  float mask = smoothstep(0.92, 0.1, radial);
  float mix_t = clamp(0.5 + 0.5 * field + u_palette_shift, 0.0, 1.0);

  vec3 base = mix(u_color_a, u_color_b, mix_t);
  vec3 col = mix(base, u_accent, mask * (0.18 + 0.32 * breath));

  vec2 pulsePos = vec2((u_pulse.x - 0.5) * aspect, 0.5 - u_pulse.y);
  float pulseDist = length(p - pulsePos);
  float pulse = exp(-10.0 * pulseDist * pulseDist) * u_pulse_strength;
  col = mix(col, u_accent, clamp(pulse * 0.18, 0.0, 0.32));
  col += u_accent * pulse * 0.025;

  float grain = (snoise2(p * 420.0 + u_time * 10.0) * 0.5 + 0.5) * u_grain;
  col += vec3(grain) * 0.08;
  col = mix(col, col * col, u_escalation * 0.3);

  gl_FragColor = vec4(col, 1.0);
}
`;

const SHADER_UNIFORM_NAMES = [
  "u_time",
  "u_breath",
  "u_escalation",
  "u_color_a",
  "u_color_b",
  "u_accent",
  "u_noise_scale",
  "u_noise_amp",
  "u_distortion",
  "u_palette_shift",
  "u_grain",
  "u_resolution",
  "u_pulse",
  "u_pulse_strength",
];

function clamp01(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function smooth(current, target, factor) {
  return current + (target - current) * clamp01(factor);
}

function rgba(rgb, alpha) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`;
}

function mixRgb(a, b, t) {
  const k = clamp01(t);
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
}

function shaderPaletteForFrame(frame) {
  return OPUS_SHADER_PALETTES[frame?.state] ?? OPUS_SHADER_PALETTES.quiet;
}

function hashString(input) {
  const str = String(input ?? "");
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizedFromHash(seed, offset) {
  const byte = (seed >>> offset) & 0xff;
  return byte / 255;
}

export function isCommandPatch(patch) {
  return Boolean(patch?.type && !NON_COMMAND_PATCH_TYPES.has(patch.type));
}

export function getVisualGrammarForState(state) {
  return VISUAL_GRAMMAR[VALID_STATES.has(state) ? state : "quiet"];
}

export function createCommandPulse(patch, startedAtS = 0, { reducedMotion = false } = {}) {
  if (!isCommandPatch(patch)) return null;
  const key = patch.element_id ?? patch.element?.element_id ?? patch.group_id ?? patch.sketch_id ?? patch.type;
  const seed = hashString(`${patch.type}:${key}`);
  const strengthByType = {
    "background.set": 0.95,
    "sketch.background.set": 1,
    "scene.pulse": 1.15,
    "scene.palette_shift": 0.95,
    "element.add": 0.85,
    "composition_group.add": 0.9,
    "element.morph": 0.9,
    "element.transform": 0.72,
    "text.animate": 0.72,
    "element.fade": 0.62,
    "composition_group.fade": 0.64,
    "element.remove": 0.5,
    "sketch.retire": 0.5,
  };
  const sceneWide = patch.type?.startsWith("scene.") || patch.type === "background.set" || patch.type === "sketch.background.set";
  return {
    patchType: patch.type,
    startedAtS,
    durationS: reducedMotion ? 0.48 : 1.22,
    strength: reducedMotion ? 0.38 : strengthByType[patch.type] ?? 0.68,
    nx: sceneWide ? 0.5 : 0.18 + normalizedFromHash(seed, 0) * 0.64,
    ny: sceneWide ? 0.52 : 0.22 + normalizedFromHash(seed, 8) * 0.58,
    sceneWide,
  };
}

export function deriveAudioFeaturesFromFrequencyBins(bytes) {
  if (!bytes || bytes.length === 0) {
    return { amplitude: 0, onset_strength: 0, spectral_centroid: 0 };
  }
  let sum = 0;
  let weighted = 0;
  let high = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const v = bytes[i] / 255;
    sum += v;
    weighted += v * i;
    if (i > bytes.length * 0.62) high += v;
  }
  const amplitude = clamp01((sum / bytes.length) * 2.15);
  const centroidRatio = sum > 0 ? weighted / sum / Math.max(1, bytes.length - 1) : 0;
  const spectral_centroid = Math.round(180 + centroidRatio * 3600);
  const onset_strength = clamp01((high / Math.max(1, bytes.length * 0.38)) * 1.45);
  return { amplitude, onset_strength, spectral_centroid };
}

export function computeVisualFrame(rawFeatures = {}, previous = {}, options = {}) {
  const state = VALID_STATES.has(rawFeatures.hijaz_state) ? rawFeatures.hijaz_state : "quiet";
  const palette = PALETTES[state] ?? PALETTES.quiet;
  const reducedMotion = Boolean(options.reducedMotion);
  const targetAmplitude = clamp01(rawFeatures.amplitude);
  const targetOnset = clamp01(rawFeatures.onset_strength);
  const targetIntensity = clamp01(rawFeatures.hijaz_intensity);
  const targetCentroid = clamp01((Number(rawFeatures.spectral_centroid) || 0) / 4200);
  const impulse = rawFeatures.hijaz_tahwil === true ? 1 : 0;
  const smoothing = reducedMotion ? 0.04 : 0.16;

  const amplitude = smooth(previous.amplitude ?? 0, targetAmplitude, smoothing);
  const onset = smooth(previous.onset ?? 0, Math.max(targetOnset, impulse), reducedMotion ? 0.08 : 0.34);
  const intensity = smooth(previous.intensity ?? 0, targetIntensity, smoothing);
  const centroid = smooth(previous.centroid ?? 0.25, targetCentroid, smoothing);

  return {
    state,
    palette,
    grammar: getVisualGrammarForState(state),
    amplitude,
    onset,
    intensity,
    centroid,
    energy: clamp01(amplitude * 0.68 + intensity * 0.42 + onset * 0.28),
    drift: reducedMotion ? 0.08 : 0.45 + centroid * 0.9,
  };
}

function resizeCanvas(canvas, ctx, windowLike) {
  const rect = canvas.getBoundingClientRect?.() ?? { width: 0, height: 0 };
  const dpr = Math.max(1, Math.min(2, windowLike?.devicePixelRatio || 1));
  const width = Math.max(1, Math.floor((rect.width || canvas.clientWidth || 1) * dpr));
  const height = Math.max(1, Math.floor((rect.height || canvas.clientHeight || 1) * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  if (ctx?.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: width / dpr, height: height / dpr, dpr };
}

function hasWebGlApi(gl) {
  return Boolean(
    gl &&
      typeof gl.createShader === "function" &&
      typeof gl.shaderSource === "function" &&
      typeof gl.compileShader === "function" &&
      typeof gl.createProgram === "function" &&
      typeof gl.drawArrays === "function",
  );
}

function compileWebGlShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) || "unknown shader compile error";
    gl.deleteShader?.(shader);
    throw new Error(info);
  }
  return shader;
}

function createWebGlProgram(gl, vertexSource, fragmentSource) {
  const vertex = compileWebGlShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileWebGlShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader?.(vertex);
  gl.deleteShader?.(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) || "unknown shader link error";
    gl.deleteProgram?.(program);
    throw new Error(info);
  }
  return program;
}

function strongestCommandPulse(commandPulses, timeS) {
  let best = { x: 0.5, y: 0.5, strength: 0 };
  for (const pulse of commandPulses ?? []) {
    const age = Math.max(0, timeS - pulse.startedAtS);
    const t = clamp01(age / Math.max(0.001, pulse.durationS));
    if (t >= 1) continue;
    const strength = (1 - t) * (1 - t) * (pulse.strength ?? 0);
    if (strength > best.strength) {
      best = { x: pulse.nx ?? 0.5, y: pulse.ny ?? 0.5, strength };
    }
  }
  return best;
}

function shaderParamsForFrame(frame, pulse) {
  const stateBoost =
    frame.state === "aug2" ? 0.1 :
    frame.state === "tahwil" ? 0.08 :
    frame.state === "arrived" ? 0.04 :
    frame.state === "approach" ? 0.025 : 0;
  const pulseBoost = clamp01((pulse?.strength ?? 0) * 0.1);
  return {
    escalation: clamp01(frame.energy * 0.22 + frame.intensity * 0.08 + stateBoost + pulseBoost),
    noiseAmp: 0.34 + frame.energy * 0.16 + frame.onset * 0.04,
    noiseScale: 1.85 + frame.centroid * 0.85 + frame.intensity * 0.15,
    distortion: 0.012 + frame.onset * 0.04 + pulseBoost * 0.055 + (frame.state === "aug2" ? 0.03 : 0),
    paletteShift: (frame.centroid - 0.35) * 0.035 + frame.intensity * 0.025 + pulseBoost * 0.02,
    grain: 0.12 + frame.energy * 0.08 + frame.onset * 0.025,
  };
}

function createShaderBackgroundRenderer({ canvas, windowLike, onError }) {
  const gl =
    canvas.getContext?.("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    }) ??
    canvas.getContext?.("experimental-webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
  if (!hasWebGlApi(gl)) return null;

  try {
    const program = createWebGlProgram(gl, SHADER_VERTEX_SOURCE, SHADER_FRAGMENT_SOURCE);
    const positionLoc = gl.getAttribLocation(program, "a_position");
    const uniformLocs = Object.fromEntries(
      SHADER_UNIFORM_NAMES.map((name) => [name, gl.getUniformLocation(program, name)]),
    );
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.useProgram(program);
    if (positionLoc >= 0) {
      gl.enableVertexAttribArray(positionLoc);
      gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
    }
    gl.disable?.(gl.DEPTH_TEST);
    gl.disable?.(gl.CULL_FACE);
    gl.enable?.(gl.BLEND);
    gl.blendFunc?.(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    function set1f(name, value) {
      const loc = uniformLocs[name];
      if (loc != null) gl.uniform1f(loc, value);
    }
    function set2f(name, a, b) {
      const loc = uniformLocs[name];
      if (loc != null) gl.uniform2f(loc, a, b);
    }
    function set3rgb(name, rgb) {
      const loc = uniformLocs[name];
      if (loc != null) gl.uniform3f(loc, rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    }

    return {
      kind: "webgl",
      draw(frame, timeS, commandPulses) {
        const size = resizeCanvas(canvas, null, windowLike);
        gl.viewport(0, 0, canvas.width, canvas.height);
        const pulse = strongestCommandPulse(commandPulses, timeS);
        const params = shaderParamsForFrame(frame, pulse);
        const palette = shaderPaletteForFrame(frame);
        const colorB = mixRgb(palette.b, palette.accent, frame.energy * 0.045);

        gl.useProgram(program);
        set1f("u_time", timeS);
        set1f("u_breath", timeS * (0.045 + frame.energy * 0.035));
        set1f("u_escalation", params.escalation);
        set3rgb("u_color_a", palette.a);
        set3rgb("u_color_b", colorB);
        set3rgb("u_accent", palette.accent);
        set1f("u_noise_scale", params.noiseScale);
        set1f("u_noise_amp", params.noiseAmp);
        set1f("u_distortion", params.distortion);
        set1f("u_palette_shift", params.paletteShift);
        set1f("u_grain", params.grain);
        set2f("u_resolution", Math.max(1, size.width), Math.max(1, size.height));
        set2f("u_pulse", pulse.x, pulse.y);
        set1f("u_pulse_strength", pulse.strength);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
      dispose() {
        try { gl.deleteBuffer?.(buffer); } catch { /* ignore */ }
        try { gl.deleteProgram?.(program); } catch { /* ignore */ }
      },
    };
  } catch (err) {
    onError?.(err);
    return null;
  }
}

function archPath(ctx, cx, springY, span, rise, footY) {
  const left = cx - span / 2;
  const right = cx + span / 2;
  ctx.beginPath();
  ctx.moveTo(left, footY);
  ctx.lineTo(left, springY);
  if (ctx.bezierCurveTo) {
    ctx.bezierCurveTo(left + span * 0.04, springY - rise, right - span * 0.04, springY - rise, right, springY);
  } else {
    const steps = 20;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const x = left + span * t;
      const archY = springY - Math.sin(t * Math.PI) * rise;
      ctx.lineTo(x, archY);
    }
  }
  ctx.lineTo(right, footY);
}

function drawLampGlow(ctx, width, height, frame, timeS) {
  const { palette, grammar, amplitude, energy } = frame;
  const cx = width * (0.5 + Math.sin(timeS * 0.08) * 0.025);
  const cy = height * 0.76;
  const radius = Math.min(width, height) * (0.28 + energy * 0.14);
  ctx.globalCompositeOperation = "screen";
  if (ctx.createRadialGradient) {
    const glow = ctx.createRadialGradient(cx, cy, radius * 0.08, cx, cy, radius);
    glow.addColorStop(0, rgba(palette.accent, 0.08 + grammar.glowAlpha * 0.22 + amplitude * 0.12));
    glow.addColorStop(0.38, rgba(palette.warm, 0.05 + grammar.glowAlpha * 0.12));
    glow.addColorStop(1, rgba(palette.base, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawThresholdArchitecture(ctx, width, height, frame, timeS) {
  const { palette, grammar, energy, intensity, onset, centroid, state } = frame;
  const centerX = width * (0.5 + (state === "tahwil" ? Math.sin(timeS * 0.16) * 0.018 : 0));
  const baseY = height * (0.75 - centroid * 0.08 - grammar.opening * 0.04);
  const footY = height * 0.9;
  const archCount = 3;

  for (let i = 0; i < archCount; i += 1) {
    const k = i / Math.max(1, archCount - 1);
    const span = width * (0.34 + k * 0.28 + grammar.opening * 0.12 + energy * 0.04);
    const rise = height * (0.22 + k * 0.08 + intensity * 0.08 + onset * 0.03);
    const springY = baseY - k * height * 0.035 - onset * 16;
    const alpha = Math.min(0.58, grammar.archAlpha * (0.45 + k * 0.5) + energy * 0.12);
    const grad = ctx.createLinearGradient?.(centerX - span / 2, springY, centerX + span / 2, springY);
    if (grad?.addColorStop) {
      grad.addColorStop(0, rgba(palette.cool, alpha * 0.28));
      grad.addColorStop(0.5, rgba(palette.accent, alpha));
      grad.addColorStop(1, rgba(palette.warm, alpha * 0.35));
      ctx.strokeStyle = grad;
    } else {
      ctx.strokeStyle = rgba(palette.accent, alpha);
    }
    ctx.lineWidth = 1.2 + k * 1.6 + energy * 3.2;
    archPath(ctx, centerX, springY, span, rise, footY - k * height * 0.035);
    ctx.stroke();
  }

  const columnXs = [0.14, 0.24, 0.36, 0.64, 0.76, 0.86];
  for (let i = 0; i < columnXs.length; i += 1) {
    const x = width * columnXs[i];
    const side = columnXs[i] < 0.5 ? -1 : 1;
    const lean = side * (state === "approach" ? -1 : 1) * (4 + energy * 18) + Math.sin(timeS * 0.28 + i) * 3;
    const top = height * (0.2 + (i % 3) * 0.035 - centroid * 0.04);
    const bottom = height * (0.88 - (i % 2) * 0.025);
    const alpha = Math.min(0.34, grammar.columnAlpha + energy * 0.1 + onset * 0.08);
    ctx.strokeStyle = rgba(i % 2 ? palette.cool : palette.warm, alpha);
    ctx.lineWidth = 1 + energy * 2.4;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x + lean, bottom);
    ctx.stroke();
  }
}

function drawManuscriptLines(ctx, width, height, frame, timeS) {
  const { palette, grammar, energy, amplitude, centroid } = frame;
  const rows = grammar.manuscriptRows + Math.round(energy * 7);
  const startY = height * (0.64 + centroid * 0.06);
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < rows; i += 1) {
    const y = startY + i * Math.max(8, height * 0.017) + Math.sin(timeS * 0.35 + i * 0.8) * (1 + amplitude * 5);
    const x1 = width * (0.1 + ((i * 7) % 11) / 100);
    const x2 = width * (0.72 + ((i * 5) % 18) / 100);
    const mid = (x1 + x2) / 2;
    const bow = Math.sin(i * 1.7 + timeS * 0.16) * (4 + energy * 16);
    const alpha = Math.min(0.34, 0.05 + energy * 0.12 + (i % 3 === 0 ? 0.08 : 0));
    ctx.strokeStyle = rgba(i % 4 === 0 ? palette.accent : palette.warm, alpha);
    ctx.lineWidth = i % 3 === 0 ? 1.2 + energy * 1.7 : 0.75 + energy;
    ctx.beginPath();
    ctx.moveTo(x1, y);
    if (ctx.quadraticCurveTo) ctx.quadraticCurveTo(mid, y + bow, x2, y + Math.sin(i) * 3);
    else ctx.lineTo(x2, y + bow * 0.35);
    ctx.stroke();
  }
}

function drawRuptureStrokes(ctx, width, height, frame, timeS) {
  const { palette, grammar, onset, energy, state } = frame;
  const rupture = Math.max(onset, state === "aug2" ? 0.85 : 0, state === "tahwil" ? 0.32 : 0) * grammar.ruptureAlpha;
  if (rupture < 0.025) return;
  const cx = width * 0.5;
  const cy = height * (0.42 - energy * 0.08);
  const spread = Math.min(width, height) * (0.12 + rupture * 0.18);
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < 3; i += 1) {
    const offset = (i - 1) * spread * 0.28;
    const swing = Math.sin(timeS * 0.9 + i) * spread * 0.08;
    ctx.strokeStyle = rgba(i === 1 ? palette.accent : palette.warm, Math.min(0.62, 0.18 + rupture * 0.55));
    ctx.lineWidth = 1.4 + rupture * 6 - i * 0.35;
    ctx.beginPath();
    ctx.moveTo(cx - spread + offset, cy + spread * 0.55 + swing);
    ctx.lineTo(cx + spread * 0.34 + offset, cy - spread * 0.52 - swing);
    ctx.stroke();
  }
}

function drawCommandPulses(ctx, width, height, frame, timeS, commandPulses) {
  if (!commandPulses?.length) return;
  const { palette } = frame;
  ctx.globalCompositeOperation = "screen";
  for (const pulse of commandPulses) {
    const age = Math.max(0, timeS - pulse.startedAtS);
    const t = clamp01(age / Math.max(0.001, pulse.durationS));
    if (t >= 1) continue;
    const easeOut = 1 - (1 - t) * (1 - t);
    const alpha = (1 - t) * (1 - t) * pulse.strength;
    const x = width * pulse.nx;
    const y = height * pulse.ny;
    const maxRadius = pulse.sceneWide ? Math.max(width, height) * 0.78 : Math.min(width, height) * 0.54;
    const radius = 24 + easeOut * maxRadius;

    if (ctx.createRadialGradient) {
      const glow = ctx.createRadialGradient(x, y, radius * 0.04, x, y, radius);
      glow.addColorStop(0, rgba(palette.accent, Math.min(0.24, alpha * 0.2)));
      glow.addColorStop(0.34, rgba(palette.warm, Math.min(0.18, alpha * 0.16)));
      glow.addColorStop(1, rgba(palette.cool, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = rgba(palette.accent, Math.min(0.5, alpha * 0.46));
    ctx.lineWidth = 1 + pulse.strength * 5 * (1 - t);
    ctx.beginPath();
    if (ctx.arc) {
      ctx.arc(x, y, radius * 0.58, 0, Math.PI * 2);
    } else {
      ctx.moveTo(x - radius, y);
      ctx.lineTo(x, y - radius);
      ctx.lineTo(x + radius, y);
      ctx.lineTo(x, y + radius);
      ctx.closePath();
    }
    ctx.stroke();

    const sweepY = y + (t - 0.5) * height * 0.42;
    ctx.strokeStyle = rgba(palette.warm, Math.min(0.26, alpha * 0.22));
    ctx.lineWidth = 1 + pulse.strength * 3;
    ctx.beginPath();
    ctx.moveTo(width * 0.08, sweepY);
    ctx.lineTo(width * 0.92, sweepY + Math.sin(timeS + pulse.nx * 6) * 22);
    ctx.stroke();
  }
}

function drawLayer(ctx, canvas, frame, timeS, windowLike, commandPulses = []) {
  const { width, height } = resizeCanvas(canvas, ctx, windowLike);
  const { palette, energy, centroid } = frame;
  ctx.clearRect(0, 0, width, height);
  ctx.save?.();
  ctx.globalCompositeOperation = "source-over";

  const baseGradient = ctx.createLinearGradient?.(0, 0, width, height);
  if (baseGradient?.addColorStop) {
    baseGradient.addColorStop(0, rgba(palette.base, 0.98));
    baseGradient.addColorStop(0.46, rgba(palette.cool, 0.52 + centroid * 0.14));
    baseGradient.addColorStop(1, rgba(palette.warm, 0.44 + energy * 0.16));
    ctx.fillStyle = baseGradient;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.globalCompositeOperation = "screen";

  drawLampGlow(ctx, width, height, frame, timeS);
  drawThresholdArchitecture(ctx, width, height, frame, timeS);
  drawManuscriptLines(ctx, width, height, frame, timeS);
  drawRuptureStrokes(ctx, width, height, frame, timeS);

  drawCommandPulses(ctx, width, height, frame, timeS, commandPulses);

  ctx.restore?.();
}

function createAudioAnalyser({ audioEl, windowLike, onError }) {
  const AudioContextImpl = windowLike?.AudioContext ?? windowLike?.webkitAudioContext;
  if (!audioEl || !AudioContextImpl) return null;
  let audioContext = null;
  let analyser = null;
  let bins = null;
  let source = null;

  function ensure() {
    if (analyser) return true;
    try {
      audioContext = new AudioContextImpl();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.82;
      bins = new Uint8Array(analyser.frequencyBinCount);
      source = audioContext.createMediaElementSource(audioEl);
      source.connect(analyser);
      analyser.connect(audioContext.destination);
      return true;
    } catch (err) {
      analyser = null;
      onError?.(err);
      return false;
    }
  }

  async function resume() {
    if (!ensure()) return;
    try {
      if (audioContext?.state === "suspended") await audioContext.resume();
    } catch (err) {
      onError?.(err);
    }
  }

  function read() {
    if (!analyser || !bins) return null;
    analyser.getByteFrequencyData(bins);
    return deriveAudioFeaturesFromFrequencyBins(bins);
  }

  function close() {
    try {
      source?.disconnect?.();
      analyser?.disconnect?.();
      audioContext?.close?.();
    } catch {
      // ignore teardown failures
    }
  }

  return { resume, read, close };
}

export function createAudioVisualLayer({
  mount,
  bus,
  audioEl = null,
  documentLike = globalThis.document,
  windowLike = globalThis,
  rafImpl = globalThis.requestAnimationFrame,
  cancelRafImpl = globalThis.cancelAnimationFrame,
  onError = () => {},
} = {}) {
  if (!mount) throw new Error("mount is required");
  if (!bus?.subscribe) throw new Error("bus is required");
  const canvas = documentLike.createElement("canvas");
  canvas.dataset.audioVisualLayer = "1";
  canvas.setAttribute?.("aria-hidden", "true");
  canvas.style = canvas.style ?? {};
  canvas.style.cssText = [
    "position: absolute",
    "inset: 0",
    "width: 100%",
    "height: 100%",
    "z-index: 5",
    "pointer-events: none",
    "mix-blend-mode: normal",
    "opacity: 1",
  ].join("; ");
  if (mount.firstChild && mount.insertBefore) mount.insertBefore(canvas, mount.firstChild);
  else mount.appendChild(canvas);

  const shaderRenderer = createShaderBackgroundRenderer({ canvas, windowLike, onError });
  canvas.dataset.audioVisualRenderer = shaderRenderer?.kind ?? "2d";
  const ctx = shaderRenderer ? null : canvas.getContext?.("2d");
  const reducedMotion = Boolean(windowLike?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  const features = {
    amplitude: 0,
    onset_strength: 0,
    spectral_centroid: 900,
    hijaz_state: "quiet",
    hijaz_intensity: 0,
    hijaz_tahwil: false,
  };
  let frame = computeVisualFrame(features, {}, { reducedMotion });
  let rafHandle = null;
  let stopped = false;
  let lastTimeS = 0;
  let commandPulses = [];
  const unsubscribers = [];
  const analyser = createAudioAnalyser({ audioEl, windowLike, onError });

  for (const name of FEATURE_NAMES) {
    unsubscribers.push(
      bus.subscribe(name, (value) => {
        features[name] = value;
      }),
    );
  }

  const resumeAudioAnalysis = () => {
    void analyser?.resume();
  };
  audioEl?.addEventListener?.("play", resumeAudioAnalysis);
  documentLike?.addEventListener?.("pointerdown", resumeAudioAnalysis, { once: true });
  documentLike?.addEventListener?.("keydown", resumeAudioAnalysis, { once: true });

  function tick(ts = 0) {
    if (stopped) return;
    lastTimeS = ts / 1000;
    const derived = analyser?.read?.();
    if (derived) {
      features.amplitude = Math.max(clamp01(features.amplitude), derived.amplitude);
      features.onset_strength = Math.max(clamp01(features.onset_strength), derived.onset_strength);
      features.spectral_centroid = derived.spectral_centroid || features.spectral_centroid;
      features.hijaz_intensity = Math.max(clamp01(features.hijaz_intensity), derived.amplitude);
    }
    frame = computeVisualFrame(features, frame, { reducedMotion });
    commandPulses = commandPulses.filter((pulse) => lastTimeS - pulse.startedAtS < pulse.durationS);
    if (shaderRenderer) shaderRenderer.draw(frame, lastTimeS, commandPulses);
    else if (ctx) drawLayer(ctx, canvas, frame, lastTimeS, windowLike, commandPulses);
    if (rafImpl) rafHandle = rafImpl(tick);
  }

  if (rafImpl) rafHandle = rafImpl(tick);
  else tick(0);

  function stop() {
    stopped = true;
    if (rafHandle != null && cancelRafImpl) cancelRafImpl(rafHandle);
    for (const off of unsubscribers) off();
    audioEl?.removeEventListener?.("play", resumeAudioAnalysis);
    analyser?.close?.();
    shaderRenderer?.dispose?.();
    canvas.remove?.();
  }

  function triggerCommandPulse(patch) {
    const pulse = createCommandPulse(patch, lastTimeS, { reducedMotion });
    if (!pulse) return false;
    commandPulses.push(pulse);
    if (commandPulses.length > 8) commandPulses = commandPulses.slice(-8);
    return true;
  }

  return {
    canvas,
    stop,
    triggerCommandPulse,
    getRendererKind: () => shaderRenderer?.kind ?? "2d",
    getFrame: () => frame,
    getFeatures: () => ({ ...features }),
    getCommandPulses: () => [...commandPulses],
  };
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const { createFeatureBus } = await import("./feature_bus.mjs");

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

  class FakeNode {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.dataset = {};
      this.style = { cssText: "" };
      this.attributes = new Map();
      this.firstChild = null;
    }
    appendChild(child) {
      this.children.push(child);
      this.firstChild = this.children[0] ?? null;
      child.parentNode = this;
    }
    insertBefore(child, before) {
      const idx = this.children.indexOf(before);
      if (idx >= 0) this.children.splice(idx, 0, child);
      else this.children.push(child);
      this.firstChild = this.children[0] ?? null;
      child.parentNode = this;
    }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
      this.parentNode.firstChild = this.parentNode.children[0] ?? null;
    }
    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
  }

  class FakeCanvas extends FakeNode {
    constructor() {
      super("canvas");
      this.width = 0;
      this.height = 0;
      this.clientWidth = 800;
      this.clientHeight = 450;
      this.calls = [];
    }
    getBoundingClientRect() {
      return { width: 800, height: 450 };
    }
    getContext(type = "2d") {
      if (/webgl/i.test(type)) return this.webglContext ?? null;
      const calls = this.calls;
      return {
        setTransform: (...args) => calls.push(["setTransform", ...args]),
        clearRect: (...args) => calls.push(["clearRect", ...args]),
        fillRect: (...args) => calls.push(["fillRect", ...args]),
        save: () => calls.push(["save"]),
        restore: () => calls.push(["restore"]),
        beginPath: () => calls.push(["beginPath"]),
        moveTo: (...args) => calls.push(["moveTo", ...args]),
        lineTo: (...args) => calls.push(["lineTo", ...args]),
        bezierCurveTo: (...args) => calls.push(["bezierCurveTo", ...args]),
        quadraticCurveTo: (...args) => calls.push(["quadraticCurveTo", ...args]),
        closePath: () => calls.push(["closePath"]),
        arc: (...args) => calls.push(["arc", ...args]),
        fill: () => calls.push(["fill"]),
        stroke: () => calls.push(["stroke"]),
        createLinearGradient: () => ({ addColorStop: (...args) => calls.push(["addColorStop", ...args]) }),
        createRadialGradient: () => ({ addColorStop: (...args) => calls.push(["radialColorStop", ...args]) }),
        set globalCompositeOperation(value) { calls.push(["gco", value]); },
        set fillStyle(value) { calls.push(["fillStyle", value]); },
        set strokeStyle(value) { calls.push(["strokeStyle", value]); },
        set lineWidth(value) { calls.push(["lineWidth", value]); },
      };
    }
  }

  class FakeWebGlContext {
    constructor(calls) {
      this.calls = calls;
      this.ARRAY_BUFFER = 34962;
      this.STATIC_DRAW = 35044;
      this.TRIANGLE_STRIP = 5;
      this.FLOAT = 5126;
      this.VERTEX_SHADER = 35633;
      this.FRAGMENT_SHADER = 35632;
      this.COMPILE_STATUS = 35713;
      this.LINK_STATUS = 35714;
      this.DEPTH_TEST = 2929;
      this.CULL_FACE = 2884;
      this.BLEND = 3042;
      this.SRC_ALPHA = 770;
      this.ONE_MINUS_SRC_ALPHA = 771;
    }
    createShader(type) { return { type }; }
    shaderSource() {}
    compileShader() {}
    getShaderParameter() { return true; }
    getShaderInfoLog() { return ""; }
    deleteShader() {}
    createProgram() { return {}; }
    attachShader() {}
    linkProgram() {}
    getProgramParameter() { return true; }
    getProgramInfoLog() { return ""; }
    deleteProgram() {}
    getAttribLocation() { return 0; }
    getUniformLocation(_program, name) { return { name }; }
    createBuffer() { return {}; }
    bindBuffer() {}
    bufferData() {}
    useProgram() {}
    enableVertexAttribArray() {}
    vertexAttribPointer() {}
    disable() {}
    enable() {}
    blendFunc() {}
    viewport(...args) { this.calls.push(["viewport", ...args]); }
    uniform1f(loc, value) { this.calls.push(["uniform1f", loc.name, value]); }
    uniform2f(loc, a, b) { this.calls.push(["uniform2f", loc.name, a, b]); }
    uniform3f(loc, a, b, c) { this.calls.push(["uniform3f", loc.name, a, b, c]); }
    drawArrays(...args) { this.calls.push(["drawArrays", ...args]); }
    deleteBuffer() {}
  }

  const fakeDocument = {
    listeners: new Map(),
    createElement(tag) {
      return tag === "canvas" ? new FakeCanvas() : new FakeNode(tag);
    },
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    },
  };

  t("deriveAudioFeaturesFromFrequencyBins maps silent bins to zero energy", () => {
    const got = deriveAudioFeaturesFromFrequencyBins(new Uint8Array(16));
    assert.equal(got.amplitude, 0);
    assert.equal(got.onset_strength, 0);
  });

  t("deriveAudioFeaturesFromFrequencyBins reports higher centroid for bright bins", () => {
    const low = new Uint8Array(16);
    low[1] = 255;
    const high = new Uint8Array(16);
    high[14] = 255;
    assert.ok(
      deriveAudioFeaturesFromFrequencyBins(high).spectral_centroid >
        deriveAudioFeaturesFromFrequencyBins(low).spectral_centroid,
    );
  });

  t("computeVisualFrame clamps features and resolves Hijaz palette", () => {
    const frameOut = computeVisualFrame({
      amplitude: 5,
      onset_strength: 2,
      hijaz_intensity: 1.5,
      spectral_centroid: 8000,
      hijaz_state: "tahwil",
    });
    assert.equal(frameOut.state, "tahwil");
    assert.ok(frameOut.energy <= 1);
    assert.deepEqual(frameOut.palette, PALETTES.tahwil);
    assert.equal(frameOut.grammar.name, "upper threshold");
  });

  t("getVisualGrammarForState falls back to quiet and distinguishes structural states", () => {
    assert.equal(getVisualGrammarForState("unknown").name, "manuscript hush");
    assert.ok(getVisualGrammarForState("aug2").ruptureAlpha > getVisualGrammarForState("quiet").ruptureAlpha);
    assert.ok(getVisualGrammarForState("tahwil").opening > getVisualGrammarForState("approach").opening);
  });

  t("isCommandPatch ignores lifecycle/replay patches and accepts visual patches", () => {
    assert.equal(isCommandPatch({ type: "cycle.begin" }), false);
    assert.equal(isCommandPatch({ type: "replay.end" }), false);
    assert.equal(isCommandPatch({ type: "element.add", element: {} }), true);
  });

  t("createCommandPulse maps a patch to a bounded visual impulse", () => {
    const pulse = createCommandPulse({ type: "element.transform", element_id: "elem_001" }, 2);
    assert.equal(pulse.patchType, "element.transform");
    assert.equal(pulse.startedAtS, 2);
    assert.ok(pulse.nx >= 0 && pulse.nx <= 1);
    assert.ok(pulse.ny >= 0 && pulse.ny <= 1);
    assert.ok(pulse.strength > 0);
  });

  t("createAudioVisualLayer mounts a non-interactive canvas and consumes feature bus values", () => {
    const mount = new FakeNode("div");
    const bus = createFeatureBus();
    let rafCallback = null;
    const layer = createAudioVisualLayer({
      mount,
      bus,
      documentLike: fakeDocument,
      windowLike: { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) },
      rafImpl: (fn) => {
        rafCallback = fn;
        return 1;
      },
      cancelRafImpl: () => {},
    });
    assert.equal(mount.children[0], layer.canvas);
    assert.equal(layer.canvas.dataset.audioVisualLayer, "1");
    assert.equal(layer.getRendererKind(), "2d");
    assert.match(layer.canvas.style.cssText, /pointer-events: none/);
    assert.match(layer.canvas.style.cssText, /z-index: 5/);
    assert.match(layer.canvas.style.cssText, /opacity: 1/);
    assert.match(SHADER_FRAGMENT_SOURCE, /precision highp float/);
    bus.dispatch("hijaz_state", "aug2");
    bus.dispatch("amplitude", 0.9);
    rafCallback(1000);
    assert.equal(layer.getFeatures().hijaz_state, "aug2");
    assert.ok(layer.getFrame().energy > 0);
    assert.ok(layer.canvas.calls.some((call) => call[0] === "stroke"));
    assert.ok(layer.canvas.calls.some((call) => call[0] === "bezierCurveTo"));
    layer.stop();
  });

  t("createAudioVisualLayer uses the WebGL shader renderer when available", () => {
    const mount = new FakeNode("div");
    const bus = createFeatureBus();
    let rafCallback = null;
    const doc = {
      ...fakeDocument,
      createElement(tag) {
        const canvas = tag === "canvas" ? new FakeCanvas() : new FakeNode(tag);
        if (tag === "canvas") canvas.webglContext = new FakeWebGlContext(canvas.calls);
        return canvas;
      },
    };
    const layer = createAudioVisualLayer({
      mount,
      bus,
      documentLike: doc,
      windowLike: { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) },
      rafImpl: (fn) => {
        rafCallback = fn;
        return 1;
      },
      cancelRafImpl: () => {},
    });
    bus.dispatch("amplitude", 0.8);
    bus.dispatch("onset_strength", 0.5);
    rafCallback(1000);
    assert.equal(layer.getRendererKind(), "webgl");
    assert.ok(layer.canvas.calls.some((call) => call[0] === "drawArrays"));
    assert.ok(layer.canvas.calls.some((call) => call[0] === "uniform1f" && call[1] === "u_noise_amp"));
    layer.stop();
  });

  t("triggerCommandPulse queues a ripple and draws it on the next frame", () => {
    const mount = new FakeNode("div");
    const bus = createFeatureBus();
    let rafCallback = null;
    const layer = createAudioVisualLayer({
      mount,
      bus,
      documentLike: fakeDocument,
      windowLike: { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) },
      rafImpl: (fn) => {
        rafCallback = fn;
        return 1;
      },
      cancelRafImpl: () => {},
    });
    assert.equal(layer.triggerCommandPulse({ type: "cycle.begin" }), false);
    assert.equal(layer.triggerCommandPulse({ type: "element.add", element: { element_id: "elem_001" } }), true);
    assert.equal(layer.getCommandPulses().length, 1);
    rafCallback(1000);
    assert.ok(layer.canvas.calls.some((call) => call[0] === "arc"));
    assert.ok(layer.canvas.calls.some((call) => call[0] === "radialColorStop"));
    layer.stop();
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
