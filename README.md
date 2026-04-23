# Feed Looks Back — Spike Pipeline

Offline DSP spike for a live performance piece where Claude Opus 4.7 authors
visuals in response to guitar playing in Arabic maqam. This Python pipeline
turns an audio file into a corpus of small JSON "cycle" snapshots that can be
fed to Opus in a separate session. Deliberately scrappy and self-contained;
code that survives the spike is merged into the main scaffold later, not now.

## Run

```
# Full corpus run
python python/generate_corpus.py audio/your_file.wav corpus/

# Inspect a single middle cycle without writing files
python python/generate_corpus.py audio/your_file.wav --print-example
```

Run against any conda env with `librosa>=0.11` and `numpy>=2.0`. The local
`ambi_audio` env satisfies both.

## Note on first-cycle alignment

The first cycle summarizes audio from 1.0s to 5.0s; the initial 0.0–1.0s of
the file is intentionally excluded to keep all cycles aligned to whole
5-second boundaries.
