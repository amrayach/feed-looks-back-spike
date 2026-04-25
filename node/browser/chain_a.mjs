/**
 * Feed Looks Back — Chain A Effects Layer
 * node/browser/chain_a.mjs
 *
 * Per-element audio-reactive effects layer for Maqam Bayati.
 * Hooks at element-mount and element-fade. Sits on top of the existing
 * reactivity binding system; does not replace it.
 *
 * Wiring:
 *   import { initChainA, onElementMounted, onTextFade } from "./chain_a.mjs";
 *   initChainA(featureBus, stageRoot, { getBindingsFor });
 *   // scene_reducer calls onElementMounted(wrapper, type, layer, features) on mount
 *   // scene_reducer calls onTextFade(wrapper) before fading text elements
 *
 * Bus contract: this codebase uses pub/sub on individual feature names
 * (`bus.subscribe(name, cb)`, `bus.last(name)`). The adapter at the bottom
 * of initChainA assembles a per-frame snapshot in a rAF loop, detects
 * rising-edge of `hijaz_tahwil` for the muhayyar coordination, and tracks
 * `hijaz_state` transitions for photo state-filter updates.
 *
 * Feature names retained as `hijaz_*` for codebase compatibility (the
 * Python detector and patch protocol still emit those names). For Bayati
 * they are remapped via STATE_MAP below.
 */

// ─── Palette ──────────────────────────────────────────────────────────────────

export const PALETTE = {
  WARM: ["#e8d4a0", "#c4894a", "#8b4a2a", "#f5e6c8", "#d4a574"],
  COOL: ["#4a6670", "#8a9ba0"],
  SHADOW: "#2a1f14",
};

// ─── Bayati state → photo filter ──────────────────────────────────────────────

const BAYATI_PHOTO_FILTERS = {
  ground:   "hue-rotate(0deg)   saturate(0.90) brightness(0.97)",
  ascent:   "hue-rotate(5deg)   saturate(1.00) brightness(1.00)",
  pivot:    "hue-rotate(12deg)  saturate(1.10) brightness(1.05)",
  muhayyar: "hue-rotate(18deg)  saturate(0.95) brightness(1.12)",
  descent:  "hue-rotate(3deg)   saturate(0.92) brightness(0.98)",
};

// ─── Lerp helpers ─────────────────────────────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function scheduleFrame(fn) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(fn);
    return;
  }
  setTimeout(fn, 0);
}

// ─── Photo: Ken Burns ─────────────────────────────────────────────────────────

function applyKenBurns(wrapper, lifetime_s = 25) {
  const dir = Math.random() > 0.5 ? 1 : -1;
  const phase = Math.random() * 8;
  wrapper.style.transformOrigin = "center center";
  wrapper.style.transform = "scale(1.0) translateX(0px) translateY(0px)";

  setTimeout(() => {
    wrapper.style.transition = `transform ${lifetime_s * 1000}ms linear`;
    wrapper.style.transform =
      `scale(1.06) translateX(${dir * 8}px) translateY(-4px)`;
  }, phase * 100);

  wrapper.dataset.kenBurnsDir = dir;
}

// ─── Photo: state-driven filter (Channel 1) ──────────────────────────────────

function applyStateFilter(wrapper, state) {
  const filter = BAYATI_PHOTO_FILTERS[state] ?? BAYATI_PHOTO_FILTERS.ground;
  wrapper.dataset.chainAStateFilter = filter;
  wrapper.style.transition = "filter 1800ms ease-in-out";
  _applyComposedFilter(wrapper);
}

// ─── Photo: compose Channel 1 + Channel 2 ────────────────────────────────────

function _applyComposedFilter(wrapper) {
  const stateF = wrapper.dataset.chainAStateFilter ?? "";
  const liveB  = parseFloat(wrapper.dataset.chainALiveBrightness ?? "1.0");
  const liveS  = parseFloat(wrapper.dataset.chainALiveSat ?? "1.0");
  wrapper.style.filter = `${stateF} brightness(${liveB}) saturate(${liveS})`;
}

// ─── Photo: continuous breathing (Channel 2, every frame) ────────────────────

const _photoBrightSmooth = new WeakMap();
const _photoSatSmooth    = new WeakMap();

function breathePhoto(wrapper, amplitude, bayati_intensity) {
  const prevB = _photoBrightSmooth.get(wrapper) ?? 1.0;
  const prevS = _photoSatSmooth.get(wrapper)    ?? 1.0;
  const targetB = 1.0 + clamp(amplitude, 0, 1) * 0.11;
  const targetS = 1.0 + clamp(bayati_intensity, 0, 1) * 0.10;
  const t = 0.15;  // ~80ms smoothing at 60fps
  const newB = lerp(prevB, targetB, t);
  const newS = lerp(prevS, targetS, t);
  _photoBrightSmooth.set(wrapper, newB);
  _photoSatSmooth.set(wrapper, newS);
  wrapper.dataset.chainALiveBrightness = newB;
  wrapper.dataset.chainALiveSat = newS;
  _applyComposedFilter(wrapper);
}

// ─── Photo: Muhayyar impulse bloom (Channel 3) ───────────────────────────────

function onMuhayyarBloom(photoWrappers) {
  photoWrappers.forEach((wrapper) => {
    wrapper.style.transition = "filter 80ms ease-out";
    const base = wrapper.dataset.chainAStateFilter ?? "";
    wrapper.style.filter =
      `${base} brightness(1.28) drop-shadow(0 0 12px rgba(210,175,110,0.5))`;
    setTimeout(() => {
      wrapper.style.transition = "filter 500ms ease-in";
      _applyComposedFilter(wrapper);
    }, 220);
    wrapper.dataset.muhayyarCount =
      String(parseInt(wrapper.dataset.muhayyarCount ?? "0", 10) + 1);
  });
}

// ─── Photo: blend mode on mount ──────────────────────────────────────────────

function applyPhotoBlend(wrapper, layer) {
  if (layer === "background" || layer === "midground") {
    wrapper.style.mixBlendMode = "multiply";
  }
}

// ─── SVG: multiply blend ─────────────────────────────────────────────────────

function applySVGBlend(svgWrapper, layer) {
  if (layer !== "foreground") {
    svgWrapper.style.mixBlendMode = "multiply";
  }
}

// ─── SVG: stroke draw/undraw ─────────────────────────────────────────────────

function updateSVGStrokes(svgWrapper, onset_density) {
  const onset_normalized = clamp(onset_density / 20, 0, 1);
  const paths = svgWrapper.querySelectorAll("path, line, polyline, ellipse, circle");
  paths.forEach((path) => {
    try {
      const len = path.getTotalLength?.() ?? 300;
      path.style.strokeDasharray = len;
      path.style.strokeDashoffset = len * (1 - onset_normalized);
      path.style.transition = "stroke-dashoffset 400ms ease-out";
    } catch {
      // some elements don't support getTotalLength
    }
  });
}

// ─── SVG: opacity tremor on attack ───────────────────────────────────────────

function svgAttackTremor(svgWrapper) {
  svgWrapper.style.transition = "opacity 80ms ease-out";
  svgWrapper.style.opacity = "0.55";
  setTimeout(() => {
    svgWrapper.style.transition = "opacity 300ms ease-in";
    svgWrapper.style.opacity = "1";
  }, 80);
}

// ─── Text: stamp birth metadata on mount ─────────────────────────────────────

export function stampTextBirth(wrapper, features) {
  wrapper.dataset.rmsAtBirth         = features.rms_mean       ?? 0.03;
  wrapper.dataset.bayatiStateAtBirth = features.bayati_state   ?? "ground";
  wrapper.dataset.centroidAtBirth    = features.centroid_trend ?? "sustained";
  wrapper.dataset.silenceAtBirth     = features.silence_ratio  ?? 0.3;
}

// ─── Text: typewriter entrance ───────────────────────────────────────────────

export function typewriterEntrance(wrapper) {
  const rms   = parseFloat(wrapper.dataset.rmsAtBirth ?? "0.03");
  const state = wrapper.dataset.bayatiStateAtBirth     ?? "ground";
  const text  = wrapper.textContent.trim();

  if (typeof document === "undefined" ||
      typeof document.createElement !== "function" ||
      typeof wrapper.appendChild !== "function") {
    return;
  }

  wrapper.textContent = "";
  const chars = [...text].map((ch) => {
    const s = document.createElement("span");
    s.className = "chain-a-char";
    s.textContent = ch;
    s.style.opacity = "0";
    wrapper.appendChild(s);
    return { span: s, ch };
  });

  const delay = rms < 0.02 ? 120 : rms < 0.06 ? 70 : 30;

  // Bayati glitch chances: ground almost none (settled), muhayyar low
  // (luminous arrival, not unstable), pivot moderate (suspension).
  const glitchChance = {
    ground:   0.04,
    ascent:   0.10,
    pivot:    0.16,
    muhayyar: 0.07,
    descent:  0.05,
  }[state] ?? 0.10;

  chars.forEach(({ span, ch }, i) => {
    setTimeout(() => {
      if (ch !== " " && Math.random() < glitchChance) {
        span.textContent = String.fromCharCode(33 + Math.floor(Math.random() * 90));
        setTimeout(() => {
          span.textContent = ch;
          span.style.opacity = "1";
        }, 80);
      } else {
        span.style.opacity = "1";
      }
    }, i * delay);
  });
}

// ─── Text: erosion exit ──────────────────────────────────────────────────────

export function erosionExit(wrapper) {
  const silence  = parseFloat(wrapper.dataset.silenceAtBirth ?? "0.3");
  const duration = silence > 0.5 ? 2000 : silence < 0.2 ? 600 : 1200;

  const spans = typeof wrapper.querySelectorAll === "function"
    ? [...wrapper.querySelectorAll(".chain-a-char")]
    : [];
  if (!spans.length) {
    // Fallback: no spans (plain text) — fade the wrapper.
    wrapper.style.transition = `opacity ${duration}ms ease-out`;
    wrapper.style.opacity = "0";
    return;
  }

  const left  = spans.slice(0, Math.ceil(spans.length / 2));
  const right = spans.slice(Math.ceil(spans.length / 2)).reverse();
  const step  = duration / Math.max(left.length, 1);

  ;[left, right].forEach((side) => {
    side.forEach((span, i) => {
      setTimeout(() => {
        span.style.transition = "opacity 300ms ease-out";
        span.style.opacity = "0";
      }, i * step);
    });
  });
}

// ─── Text: live behavior (every frame) ───────────────────────────────────────

const _textLetterSmooth = new WeakMap();

export function updateTextLive(wrapper, amplitude, elapsed_s) {
  const centroid = wrapper.dataset.centroidAtBirth ?? "sustained";

  // Letter-spacing breathe — Bayati is legato so the range stays narrow.
  const prevLS = _textLetterSmooth.get(wrapper) ?? 0.12;
  const targetLS = 0.12 + clamp(amplitude, 0, 1) * 0.28;  // max 0.40em
  const newLS = lerp(prevLS, targetLS, 0.08);             // ~200ms smoothing
  _textLetterSmooth.set(wrapper, newLS);
  wrapper.style.letterSpacing = `${newLS}em`;

  // Vertical drift — Bayati is slower than Hijaz (3px/s vs 4px/s).
  const dir = centroid === "falling" ? 1 : -1;
  const drift = dir * elapsed_s * 3;
  wrapper.style.transform = `translateY(${drift}px)`;
}

// ─── Muhayyar moment: full coordination ──────────────────────────────────────

function onMuhayyarArrival(stage) {
  const photos = [...stage.querySelectorAll('[data-element-type="image"][data-chain-a="active"]')];
  const svgs   = [...stage.querySelectorAll('[data-element-type="svg"][data-chain-a="active"]')];
  const texts  = [...stage.querySelectorAll('[data-element-type="text"][data-chain-a="active"]')];

  // Photos: soft bloom (elevation, not rupture).
  onMuhayyarBloom(photos);

  // SVGs: gentle lift then settle.
  svgs.forEach((svg) => {
    svg.style.transition = "opacity 150ms ease-out";
    svg.style.opacity = "0.82";
    setTimeout(() => {
      svg.style.transition = "opacity 600ms ease-in";
      svg.style.opacity = "1";
    }, 150);
  });

  // Text: letter-spacing opens — a held breath releasing.
  texts.forEach((t) => {
    t.style.transition = "letter-spacing 200ms ease-out";
    t.style.letterSpacing = "0.42em";
    setTimeout(() => {
      t.style.transition = "letter-spacing 700ms ease-in";
      t.style.letterSpacing = "";
    }, 200);
  });

  // Track muhayyar count on all participating elements.
  ;[...photos, ...svgs, ...texts].forEach((el) => {
    el.dataset.muhayyarCount =
      String(parseInt(el.dataset.muhayyarCount ?? "0", 10) + 1);
  });
}

// ─── Conflict protocol ───────────────────────────────────────────────────────

let _getBindingsFor = null;

function canWrite(elementId, property) {  // eslint-disable-line no-unused-vars
  if (!_getBindingsFor) return true;
  const bound = _getBindingsFor(elementId).map((b) => b.property);
  return !bound.includes(property);
}

// ─── Mount hook: scene_reducer calls this when an element is mounted ─────────

export function onElementMounted(wrapper, elementType, layer, features) {
  wrapper.dataset.chainA = "active";

  if (elementType === "image") {
    applyPhotoBlend(wrapper, layer);
    applyKenBurns(wrapper, parseFloat(wrapper.dataset.lifetimeS ?? "25"));
    applyStateFilter(wrapper, features?.bayati_state ?? "ground");
  }

  if (elementType === "svg") {
    applySVGBlend(wrapper, layer);
  }

  if (elementType === "text") {
    stampTextBirth(wrapper, features ?? {});
    scheduleFrame(() => typewriterEntrance(wrapper));
  }
}

// ─── Fade hook: scene_reducer calls this before fading a text element ────────

export function onTextFade(wrapper) {
  erosionExit(wrapper);
}

// ─── Main init ───────────────────────────────────────────────────────────────

/**
 * initChainA(featureBus, stage, options)
 *
 * Compatible with two bus shapes:
 *   1. EventEmitter-style:  featureBus.on(event, handler)
 *      Events: 'frame' (features), 'muhayyar' / 'tahwil', 'state_change' (state)
 *   2. Pub/sub-style:       featureBus.subscribe(featureName, handler)
 *                           featureBus.last(featureName)
 *      This is the shape used by Feed Looks Back's feature_bus.mjs. The
 *      adapter below subscribes to the canonical feature names, snapshots
 *      them, and runs a rAF loop to drive per-frame effects. Rising edge
 *      of `hijaz_tahwil` fires the muhayyar coordination; `hijaz_state`
 *      transitions update photo state filters via STATE_MAP.
 *
 * stage: the #stage-root DOM element
 *
 * options.getBindingsFor: function from binding_engine for conflict checks.
 */
export function initChainA(featureBus, stage, options = {}) {
  if (options.getBindingsFor) _getBindingsFor = options.getBindingsFor;

  const isPubSub = typeof featureBus.subscribe === "function";

  if (!isPubSub) {
    // EventEmitter fallback (kept for portability; unused in Feed Looks Back).
    featureBus.on("frame", (features) => {
      const amplitude = clamp(features.amplitude ?? features.rms_mean ?? 0, 0, 1);
      const bayati_intensity = clamp(
        features.bayati_intensity ?? features.hijaz_intensity ?? 0, 0, 1,
      );
      const onset_density = features.onset_density ?? 0;
      stage.querySelectorAll('[data-element-type="image"][data-chain-a="active"]')
        .forEach((w) => breathePhoto(w, amplitude, bayati_intensity));
      stage.querySelectorAll('[data-element-type="svg"][data-chain-a="active"]')
        .forEach((w) => updateSVGStrokes(w, onset_density));
      stage.querySelectorAll('[data-element-type="text"][data-chain-a="active"]')
        .forEach((w) => {
          const born = parseInt(w.dataset.bornAt ?? Date.now(), 10);
          const elapsed = (Date.now() - born) / 1000;
          updateTextLive(w, amplitude, elapsed);
        });
      if ((features.onset_strength ?? 0) > 0.65) {
        stage.querySelectorAll('[data-element-type="svg"][data-chain-a="active"]')
          .forEach((w) => svgAttackTremor(w));
      }
    });
    featureBus.on("muhayyar", () => onMuhayyarArrival(stage));
    featureBus.on("tahwil",   () => onMuhayyarArrival(stage));
    featureBus.on("state_change", (newState) => {
      stage.querySelectorAll('[data-element-type="image"][data-chain-a="active"]')
        .forEach((w) => applyStateFilter(w, newState));
    });
    console.log("[Chain A] Initialised (EventEmitter mode) — Maqam Bayati — Feed Looks Back");
    return;
  }

  // ─── Pub/sub adapter (Feed Looks Back path) ────────────────────────────────
  // Maps the codebase's hijaz_* feature names to chain_a's bayati_*
  // vocabulary at the per-frame boundary. Detector and bus stay untouched.

  const STATE_MAP = {
    quiet:    "ground",
    approach: "ascent",
    arrived:  "pivot",
    tahwil:   "muhayyar",
    aug2:     "descent",  // aug2 is rare in Bayati; surface as descent for visual continuity
  };

  const features = {
    amplitude: 0,
    onset_strength: 0,
    spectral_centroid: 900,
    hijaz_state: "quiet",
    hijaz_intensity: 0,
    hijaz_tahwil: false,
  };

  const FEATURE_NAMES = [
    "amplitude", "onset_strength", "spectral_centroid",
    "hijaz_state", "hijaz_intensity", "hijaz_tahwil",
  ];

  // Seed from bus.last() so a late init doesn't sit at rest until the next dispatch.
  for (const name of FEATURE_NAMES) {
    const v = featureBus.last?.(name);
    if (v !== undefined) features[name] = v;
  }

  const unsubs = FEATURE_NAMES.map((name) =>
    featureBus.subscribe(name, (v) => { features[name] = v; }),
  );

  let prevState = STATE_MAP[features.hijaz_state] ?? "ground";
  let prevTahwil = !!features.hijaz_tahwil;
  let centroidPrev = features.spectral_centroid;
  let centroidTrend = "sustained";

  let rafId = null;
  function tick() {
    const amplitude = clamp(features.amplitude ?? 0, 0, 1);
    const bayati_intensity = clamp(features.hijaz_intensity ?? 0, 0, 1);
    const onset_strength = features.onset_strength ?? 0;
    const onset_density = onset_strength * 20;  // proxy: no onset-density detector in this codebase

    stage.querySelectorAll('[data-element-type="image"][data-chain-a="active"]')
      .forEach((w) => breathePhoto(w, amplitude, bayati_intensity));
    stage.querySelectorAll('[data-element-type="svg"][data-chain-a="active"]')
      .forEach((w) => updateSVGStrokes(w, onset_density));
    stage.querySelectorAll('[data-element-type="text"][data-chain-a="active"]')
      .forEach((w) => {
        const born = parseInt(w.dataset.bornAt ?? Date.now(), 10);
        const elapsed = (Date.now() - born) / 1000;
        updateTextLive(w, amplitude, elapsed);
      });
    if (onset_strength > 0.65) {
      stage.querySelectorAll('[data-element-type="svg"][data-chain-a="active"]')
        .forEach((w) => svgAttackTremor(w));
    }

    // Rising edge of hijaz_tahwil → muhayyar coordination.
    if (features.hijaz_tahwil && !prevTahwil) onMuhayyarArrival(stage);
    prevTahwil = !!features.hijaz_tahwil;

    // State transition → photo state filter.
    const newState = STATE_MAP[features.hijaz_state] ?? "ground";
    if (newState !== prevState) {
      stage.querySelectorAll('[data-element-type="image"][data-chain-a="active"]')
        .forEach((w) => applyStateFilter(w, newState));
      prevState = newState;
    }

    // Centroid trend (delta sign with hysteresis).
    if (features.spectral_centroid > centroidPrev + 50) centroidTrend = "rising";
    else if (features.spectral_centroid < centroidPrev - 50) centroidTrend = "falling";
    centroidPrev = features.spectral_centroid;

    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  console.log("[Chain A] Initialised — Maqam Bayati — Feed Looks Back");

  return {
    dispose() {
      if (rafId != null) cancelAnimationFrame(rafId);
      for (const off of unsubs) try { off(); } catch { /* best effort */ }
    },
    // Exposed for ad-hoc inspection / tests.
    _readFeatures() { return { ...features, centroidTrend }; },
  };
}
