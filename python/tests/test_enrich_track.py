"""Smoke tests for enrich_track.py — synthetic 10 s wav input."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

REPO_ROOT = Path(__file__).resolve().parents[2]
ENRICH_SCRIPT = REPO_ROOT / "python" / "enrich_track.py"


class EnrichTrackTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="enrich-test-"))
        # 10 s of stereo white noise + a 440 Hz sine to give librosa
        # something with onset-density and centroid character.
        sr = 44100
        t = np.linspace(0, 10.0, sr * 10, endpoint=False)
        sine = 0.2 * np.sin(2 * np.pi * 440 * t)
        noise = 0.05 * np.random.RandomState(0).randn(sr * 10)
        mono = (sine + noise).astype(np.float32)
        stereo = np.stack([mono, mono], axis=1)
        self.wav = self.tmp / "synth.wav"
        sf.write(self.wav, stereo, sr)

        # Minimal fake corpus: 2 cycles to satisfy the corpus reader.
        self.corpus = self.tmp / "corpus"
        self.corpus.mkdir()
        for i in range(2):
            (self.corpus / f"cycle_{i:03d}.json").write_text(json.dumps({
                "cycle_id": f"cycle_{i:03d}",
                "cycle_index": i,
                "source_file": "synth.wav",
                "snapshot_time_s": 5.0 * (i + 1),
                "elapsed_total_s": 5.0 * (i + 1),
                "window_duration_s": 4.0,
                "window_start_s": 5.0 * i + 1,
                "window_end_s": 5.0 * (i + 1),
                "block_1_scalars": {
                    "rms_mean": 0.05, "rms_peak": 0.2, "rms_trend": "rising",
                    "centroid_mean_hz": 1500, "centroid_trend": "rising",
                    "onset_density": 4.0, "onset_peak_strength": 0.8,
                    "pitch_class_dominant": "D", "pitch_class_secondary": None,
                    "silence_ratio": 0.1, "window_duration_s": 4.0,
                    "elapsed_total_s": 5.0 * (i + 1),
                },
                "block_2_summary": "A quiet stretch.",
                "block_3_sparklines": {
                    "rms": "▁▂▃▄▅▆▇█", "onset": "▁▂▃▄▅▆▇█", "centroid": "▁▂▃▄▅▆▇█",
                },
            }))

        self.out = self.tmp / "track_meta"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_enrich_produces_three_outputs(self):
        result = subprocess.run(
            ["python", str(ENRICH_SCRIPT),
             "--audio", str(self.wav),
             "--corpus", str(self.corpus),
             "--out", str(self.out)],
            capture_output=True, text=True, env={**os.environ},
        )
        self.assertEqual(result.returncode, 0,
                         f"enrich_track.py failed: {result.stderr}")
        self.assertTrue((self.out / "spectrogram.png").exists())
        self.assertTrue((self.out / "dsp_panel.png").exists())
        self.assertTrue((self.out / "summary.json").exists())

    def test_summary_json_has_required_keys(self):
        subprocess.run(
            ["python", str(ENRICH_SCRIPT),
             "--audio", str(self.wav),
             "--corpus", str(self.corpus),
             "--out", str(self.out)],
            check=True, env={**os.environ},
        )
        summary = json.loads((self.out / "summary.json").read_text())
        for key in ("track_id", "duration_s", "sample_rate", "channels",
                    "cycle_count", "cycle_to_seconds", "peak_rms_window",
                    "silence_regions", "event_counts", "event_timeline"):
            self.assertIn(key, summary, f"summary missing {key}")
        self.assertEqual(summary["cycle_count"], 2)
        self.assertAlmostEqual(summary["duration_s"], 10.0, delta=0.1)
        self.assertEqual(summary["sample_rate"], 44100)
        self.assertEqual(summary["channels"], 2)


if __name__ == "__main__":
    unittest.main()
