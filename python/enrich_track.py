"""enrich_track.py — produce spectrogram, DSP panel, summary.json for a track.

Usage:
    python python/enrich_track.py --audio AUDIO.wav --corpus corpus_DIR --out out_DIR

Outputs three files into out_DIR:
    spectrogram.png   — mel-spectrogram, 1920x400 px
    dsp_panel.png     — 5-panel DSP timeline, 1920x1200 px
    summary.json      — totals, peak windows, silence regions, event timeline
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import librosa
import librosa.display
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import soundfile as sf


HIJAZ_EVENT_KEYS = ("tahwil", "aug2", "phrase-break",
                    "returning-to-tonic", "grounded-in-lower-jins")


def load_corpus(corpus_dir: Path):
    files = sorted(corpus_dir.glob("cycle_*.json"))
    cycles = [json.loads(f.read_text()) for f in files]
    return cycles


def render_spectrogram(audio_path: Path, out_png: Path):
    y, sr = librosa.load(audio_path, sr=None, mono=True)
    S = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=128, fmax=sr // 2)
    S_db = librosa.power_to_db(S, ref=np.max)
    fig, ax = plt.subplots(figsize=(19.2, 4.0), dpi=100)
    img = librosa.display.specshow(S_db, sr=sr, x_axis="time", y_axis="mel",
                                   ax=ax, cmap="viridis")
    fig.colorbar(img, ax=ax, format="%+2.0f dB")
    ax.set_title("Mel-spectrogram")
    fig.tight_layout()
    fig.savefig(out_png)
    plt.close(fig)
    return float(librosa.get_duration(y=y, sr=sr)), int(sr)


def render_dsp_panel(cycles, audio_path: Path, out_png: Path):
    cycle_times = [c["snapshot_time_s"] for c in cycles]
    rms_means = [c["block_1_scalars"]["rms_mean"] for c in cycles]
    centroids = [c["block_1_scalars"]["centroid_mean_hz"] for c in cycles]
    onsets = [c["block_1_scalars"]["onset_density"] for c in cycles]
    silence_ratios = [c["block_1_scalars"]["silence_ratio"] for c in cycles]

    # Hijaz event timeline parsed out of block_2_summary text labels.
    event_timeline = []
    for c in cycles:
        prose = c.get("block_2_summary", "") or ""
        for ev in HIJAZ_EVENT_KEYS:
            label = ev.replace("-", "-")
            if (ev == "tahwil" and "Tahwil" in prose) \
               or (ev == "aug2" and "Augmented-second" in prose) \
               or (ev == "phrase-break" and "Phrase break" in prose) \
               or (ev == "returning-to-tonic" and "Returning to tonic" in prose) \
               or (ev == "grounded-in-lower-jins" and "Grounded in lower jins" in prose):
                event_timeline.append({"cycle": c["cycle_index"],
                                       "event": ev,
                                       "time_s": c["snapshot_time_s"]})

    fig, axes = plt.subplots(5, 1, figsize=(19.2, 12.0), dpi=100, sharex=True)
    axes[0].plot(cycle_times, rms_means, "-o", color="tab:blue")
    axes[0].set_ylabel("RMS mean")
    axes[1].plot(cycle_times, centroids, "-o", color="tab:orange")
    axes[1].set_ylabel("Spectral centroid (Hz)")
    axes[2].plot(cycle_times, onsets, "-o", color="tab:green")
    axes[2].set_ylabel("Onset density")
    axes[3].set_ylabel("Hijaz events")
    color_map = {"tahwil": "red", "aug2": "purple", "phrase-break": "blue",
                 "returning-to-tonic": "green", "grounded-in-lower-jins": "gray"}
    for ev in event_timeline:
        axes[3].axvline(ev["time_s"], color=color_map.get(ev["event"], "black"),
                        alpha=0.6, linewidth=1.0)
        axes[3].text(ev["time_s"], 0.5, ev["event"], rotation=90, fontsize=7)
    axes[3].set_yticks([])
    axes[4].plot(cycle_times, silence_ratios, "-o", color="tab:gray")
    axes[4].set_ylabel("Silence ratio")
    axes[4].set_xlabel("Time (s)")
    fig.suptitle("DSP panel — RMS · centroid · onset · events · silence")
    fig.tight_layout()
    fig.savefig(out_png)
    plt.close(fig)
    return event_timeline


def detect_silence_regions(audio_path: Path, threshold_db: float = -40.0):
    y, sr = librosa.load(audio_path, sr=None, mono=True)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    rms_db = librosa.amplitude_to_db(rms, ref=np.max)
    silent = rms_db < threshold_db
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=512)
    regions = []
    in_region = False
    region_start = 0.0
    for i, s in enumerate(silent):
        if s and not in_region:
            in_region = True
            region_start = float(times[i])
        elif not s and in_region:
            in_region = False
            regions.append({"start_s": region_start, "end_s": float(times[i])})
    if in_region:
        regions.append({"start_s": region_start, "end_s": float(times[-1])})
    return regions


def compute_summary(audio_path: Path, cycles, duration_s: float, sr: int,
                    channels: int, event_timeline):
    cycle_to_seconds = [c["snapshot_time_s"] for c in cycles]
    rms_means = [c["block_1_scalars"]["rms_mean"] for c in cycles]
    if rms_means:
        peak_idx = int(np.argmax(rms_means))
        peak_window = {
            "start_s": cycles[peak_idx].get("window_start_s", cycle_to_seconds[peak_idx] - 4.0),
            "end_s": cycles[peak_idx].get("window_end_s", cycle_to_seconds[peak_idx]),
            "value": float(rms_means[peak_idx]),
        }
    else:
        peak_window = {"start_s": 0.0, "end_s": 0.0, "value": 0.0}

    event_counts = {ev: 0 for ev in HIJAZ_EVENT_KEYS}
    for ev in event_timeline:
        event_counts[ev["event"]] = event_counts.get(ev["event"], 0) + 1

    return {
        "track_id": audio_path.stem,
        "duration_s": float(duration_s),
        "sample_rate": int(sr),
        "channels": int(channels),
        "cycle_count": len(cycles),
        "cycle_to_seconds": cycle_to_seconds,
        "peak_rms_window": peak_window,
        "silence_regions": detect_silence_regions(audio_path),
        "event_counts": event_counts,
        "event_timeline": event_timeline,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--corpus", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)

    args.out.mkdir(parents=True, exist_ok=True)
    cycles = load_corpus(args.corpus)
    duration_s, sr = render_spectrogram(args.audio, args.out / "spectrogram.png")
    info = sf.info(str(args.audio))
    event_timeline = render_dsp_panel(cycles, args.audio, args.out / "dsp_panel.png")
    summary = compute_summary(args.audio, cycles, duration_s, sr,
                              info.channels, event_timeline)
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
