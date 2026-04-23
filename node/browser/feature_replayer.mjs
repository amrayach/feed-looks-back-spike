// node/browser/feature_replayer.mjs
// Pre-recorded mode: fetch features_track.json at start, dispatch frames
// through the feature_bus in time with <audio>.currentTime via rAF.

const { FeaturesTrackSchema } = await import(
  import.meta.url.startsWith("file:")
    ? "../src/patch_protocol.mjs"
    : "/shared/patch_protocol.mjs"
);

export const FEATURE_NAMES = [
  "amplitude",
  "onset_strength",
  "spectral_centroid",
  "hijaz_state",
  "hijaz_intensity",
  "hijaz_tahwil",
];

export function createFeatureReplayer({
  bus,
  audioEl,
  runId,
  fetchImpl = globalThis.fetch,
  rafImpl = globalThis.requestAnimationFrame,
  cancelRafImpl = globalThis.cancelAnimationFrame,
  onError = () => {},
} = {}) {
  let track = null;
  let lastFrameIndex = -1;
  let rafHandle = null;
  let started = false;
  let seekingHandler = null;

  function dispatchFrame(frame) {
    for (const name of FEATURE_NAMES) bus.dispatch(name, frame[name]);
  }

  function findFrameIndex(time) {
    if (!track || track.frames.length === 0) return -1;
    let lo = 0;
    let hi = track.frames.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (track.frames[mid].t <= time) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  function tick() {
    if (!started || !track) return;
    const now = audioEl?.currentTime ?? 0;
    const target = findFrameIndex(now);
    if (target > lastFrameIndex) {
      for (let i = lastFrameIndex + 1; i <= target; i++) dispatchFrame(track.frames[i]);
      lastFrameIndex = target;
    }
    scheduleNextTick();
  }

  function scheduleNextTick() {
    if (!started) return;
    rafHandle = rafImpl ? rafImpl(tick) : null;
  }

  function onSeeking() {
    if (!track) return;
    // Dispatch the sought-to frame immediately so bus.last() matches the
    // new playback position. Setting lastFrameIndex = idx without this
    // dispatch would leave the bus stale — tick() only emits when
    // target > lastFrameIndex, so the sought-to frame would be skipped.
    const idx = findFrameIndex(audioEl?.currentTime ?? 0);
    if (idx >= 0 && idx < track.frames.length) {
      dispatchFrame(track.frames[idx]);
    }
    lastFrameIndex = idx;
  }

  async function start() {
    if (started) return;
    started = true;
    try {
      const res = await fetchImpl(`/run/${encodeURIComponent(runId)}/features_track.json`);
      if (!res || !res.ok) {
        const status = res?.status ?? "unknown";
        throw new Error(`features_track fetch failed: ${status}`);
      }
      const parsed = FeaturesTrackSchema.parse(await res.json());
      track = parsed;
    } catch (err) {
      started = false;
      onError(err);
      return;
    }
    if (track.frames.length > 0) {
      lastFrameIndex = 0;
      dispatchFrame(track.frames[0]);
    }
    if (audioEl?.addEventListener) {
      seekingHandler = onSeeking;
      audioEl.addEventListener("seeking", seekingHandler);
    }
    scheduleNextTick();
  }

  function stop() {
    started = false;
    if (rafHandle != null && cancelRafImpl) cancelRafImpl(rafHandle);
    rafHandle = null;
    if (audioEl?.removeEventListener && seekingHandler) {
      audioEl.removeEventListener("seeking", seekingHandler);
      seekingHandler = null;
    }
  }

  return { start, stop, getLastFrameIndex: () => lastFrameIndex };
}


const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const { createFeatureBus } = await import("./feature_bus.mjs");

  function synthTrack(duration_s) {
    const frames = [];
    for (let i = 0; i <= Math.floor(duration_s * 60); i++) {
      const t = i / 60;
      frames.push({
        t,
        amplitude: Math.min(1, t / duration_s),
        onset_strength: i % 30 === 0 ? 0.9 : 0.0,
        spectral_centroid: 1000 + 500 * (t / duration_s),
        hijaz_state: t < duration_s / 2 ? "quiet" : "approach",
        hijaz_intensity: Math.min(1, t / duration_s),
        hijaz_tahwil: i === 90,
      });
    }
    return {
      schema_version: "1",
      duration_s,
      frame_rate_hz: 60,
      frames,
    };
  }

  class FakeAudio {
    constructor() {
      this.currentTime = 0;
      this.paused = true;
      this._listeners = new Map();
    }
    addEventListener(type, fn) {
      const l = this._listeners.get(type) ?? [];
      l.push(fn);
      this._listeners.set(type, l);
    }
    removeEventListener(type, fn) {
      const l = this._listeners.get(type) ?? [];
      this._listeners.set(type, l.filter((x) => x !== fn));
    }
    dispatchEvent(type) {
      for (const fn of this._listeners.get(type) ?? []) fn({ type });
    }
  }

  function rafRunner() {
    const tasks = [];
    let id = 0;
    return {
      schedule: (fn) => {
        id += 1;
        tasks.push({ id, fn });
        return id;
      },
      cancel: (handle) => {
        const idx = tasks.findIndex((task) => task.id === handle);
        if (idx !== -1) tasks.splice(idx, 1);
      },
      tick() {
        const queued = tasks.splice(0);
        for (const task of queued) {
          task.fn(typeof performance !== "undefined" ? performance.now() : Date.now());
        }
      },
    };
  }

  let pass = 0;
  let fail = 0;
  async function t(desc, fn) {
    try {
      await fn();
      pass += 1;
      process.stdout.write(`  ok  ${desc}\n`);
    } catch (err) {
      fail += 1;
      process.stdout.write(`  FAIL ${desc}\n    ${err.message}\n`);
    }
  }

  await t("start fetches track, seeds last() from frame 0, and dispatches as currentTime advances", async () => {
    const bus = createFeatureBus();
    const audio = new FakeAudio();
    const raf = rafRunner();
    const track = synthTrack(2.0);
    const fetchImpl = async () => ({ ok: true, json: async () => track });

    const replayer = createFeatureReplayer({
      bus,
      audioEl: audio,
      runId: "SELFTEST",
      fetchImpl,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
    });
    await replayer.start();

    assert.equal(bus.last("amplitude"), track.frames[0].amplitude);
    audio.currentTime = 1.0;
    raf.tick();
    const cutoff = Math.floor(1.0 * 60);
    assert.equal(bus.last("amplitude"), track.frames[cutoff].amplitude);
  });

  await t("seeking backwards resets the pointer AND dispatches the sought-to frame to bus.last", async () => {
    const bus = createFeatureBus();
    const audio = new FakeAudio();
    const raf = rafRunner();
    const track = synthTrack(2.0);
    const fetchImpl = async () => ({ ok: true, json: async () => track });
    const replayer = createFeatureReplayer({
      bus,
      audioEl: audio,
      runId: "SELFTEST",
      fetchImpl,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
    });
    await replayer.start();

    audio.currentTime = 1.5;
    raf.tick();
    assert.equal(replayer.getLastFrameIndex(), Math.floor(1.5 * 60));
    const ampAt1_5 = track.frames[Math.floor(1.5 * 60)].amplitude;
    assert.equal(bus.last("amplitude"), ampAt1_5);

    audio.currentTime = 0.3;
    audio.dispatchEvent("seeking");
    const seekIdx = Math.floor(0.3 * 60);
    assert.equal(replayer.getLastFrameIndex(), seekIdx);
    // Key assertion: bus.last() must reflect the sought-to frame NOW,
    // not stay at the pre-seek values until playback advances.
    assert.equal(bus.last("amplitude"), track.frames[seekIdx].amplitude);
    assert.equal(bus.last("hijaz_state"), track.frames[seekIdx].hijaz_state);

    raf.tick();
    // Forward tick from the post-seek position should NOT re-dispatch
    // anything (we only advance when target > lastFrameIndex).
    assert.equal(replayer.getLastFrameIndex(), seekIdx);
  });

  await t("fetch failure routes to onError and does not throw from start()", async () => {
    const bus = createFeatureBus();
    const audio = new FakeAudio();
    const raf = rafRunner();
    const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const errors = [];
    const replayer = createFeatureReplayer({
      bus,
      audioEl: audio,
      runId: "missing",
      fetchImpl,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
      onError: (e) => errors.push(e),
    });
    await replayer.start();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /404|track/i);
  });

  await t("stop cancels the raf handle and detaches the seeking listener", async () => {
    const bus = createFeatureBus();
    const audio = new FakeAudio();
    const raf = rafRunner();
    const track = synthTrack(1.0);
    const fetchImpl = async () => ({ ok: true, json: async () => track });
    const replayer = createFeatureReplayer({
      bus,
      audioEl: audio,
      runId: "SELFTEST",
      fetchImpl,
      rafImpl: raf.schedule,
      cancelRafImpl: raf.cancel,
    });
    await replayer.start();
    assert.equal(audio._listeners.get("seeking")?.length, 1);
    replayer.stop();
    assert.equal(audio._listeners.get("seeking")?.length, 0);
    const beforeTick = replayer.getLastFrameIndex();
    audio.currentTime = 0.5;
    raf.tick();
    assert.equal(replayer.getLastFrameIndex(), beforeTick);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
