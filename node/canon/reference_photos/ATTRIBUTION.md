# Reference photo attribution

The published submission ships **five** reference photos in this directory.
They are loaded into the Opus system prefix during bake passes as visual
examples of the Bayati visual register. All five are CC0 (public domain) or
license-equivalent and require no attribution beyond the row below.

| File | Source URL | Author | License | Notes |
|---|---|---|---|---|
| 01_moonlight_on_water.jpg | https://commons.wikimedia.org/wiki/File:Moonlight_on_water_(Pixabay_2297212).jpg | jameswheeler (Pixabay, via Wikimedia Commons) | CC0 | Moonlight reflection on still water; matches the canonical Bayati anchor. Accessed 2026-04-25. |
| 03_open_palm_candlelight.jpg | https://www.pexels.com/photo/lighted-tealight-on-person-palm-331140/ | George Becker (@eye4dtail) | Pexels Free License (CC0-equivalent, no attribution required) | Cupped open palms cradling a glowing tealight, warm amber light on dark ground. Accessed 2026-04-25. Resized to 1024px long edge. |
| 04_open_palm_candlelight_b.jpg | https://unsplash.com/photos/wX1GSlEHzuc | Prateek Gautam (@pgauti) | Unsplash License (CC0-equivalent, no attribution required) | Two hands cupping a clay diya/oil lamp with warm flame, dark background. No face visible. Accessed 2026-04-25. Resized to 1024px long edge. |
| 06_back_at_window_night.jpg | https://unsplash.com/photos/od-2xks9Alc | Sean Kong (@seankkkkkkkkkkkkkk) | Unsplash License (CC0-equivalent, no attribution required) | Silhouette of figure facing window, fully unidentifiable, contemplative mood. Accessed 2026-04-25. Resized to 1024px long edge. |
| 08_loose_linen.jpg | https://www.pexels.com/photo/detailed-view-of-beige-fabric-with-soft-folds-creating-texture-7232405/ | Artem Podrez (@artempodrez) | Pexels Free License (CC0-equivalent, no attribution required) | Close-up of beige linen with soft diagonal folds, warm neutral tones. No people. Accessed 2026-04-25. Resized to 1024px long edge. |

## Selection policy

- CC0 (Wikimedia Commons / Unsplash CC0) preferred.
- CC-BY accepted with author + source URL recorded.
- Resolution >= 1024 px on the long edge.
- No photos depicting identifiable people without model release.
- Reject any photo with ambiguous license.

## Note on local-only photos

During development a wider set of locally-curated photos was used to iterate
on the Bayati visual register. Seven of those (slots 02, 05, 07, 09, 10, 11,
12) had source provenance that could not be reconstructed reliably and have
therefore been excluded from the public submission via `.gitignore` for
rights diligence.

The shipped bake outputs in `bake_song1/` and `bake_song5/` are frozen
artifacts. Those bakes were generated when the wider local set was present
on disk, and their stored composition plans and per-cycle rationales may
still reference excluded filenames as text. That is metadata, not a
load-time dependency: replay only needs the bake JSONs and the audio file.
Re-baking from a clean clone of the public repo will produce a different
plan because the reference set is smaller; the published bakes remain the
reproducible artifact for the submission demo.
