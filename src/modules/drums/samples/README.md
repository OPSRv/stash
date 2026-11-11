# Drum samples

Recorded one-shots for the Drums module's sampled kits. Every source is
**CC0 1.0 (public domain)** — see `LICENSE-CC0.txt`; no attribution is
required, credit is given here as a courtesy.

| Kit | Voices | Source |
|---|---|---|
| `acoustic/` | kick, snare, hats, tom, rim (cross-stick), crash | [Virtuosity Drums](https://github.com/sfzinstruments/virtuosity_drums) — Versilian Studios / Karoryfer Samples, `mid` mic position |
| `rock/` | kick, snare, hats, tom (18"), rim (side-stick), crash | [Big Rusty Drums](https://github.com/sfzinstruments/karoryfer.big-rusty-drums) — Karoryfer Samples, close mic + overheads mixed |
| both | clap | [body_percussion](https://github.com/sfzinstruments/body_percussion) — sfzinstruments |

`<voice>.wav` is the normal hit, `<voice>-accent.wav` (when present) the
hard-velocity layer. Files are 44.1 kHz mono 16-bit, leading silence
trimmed, cut with a fade-out and peak-normalised to -1 dBFS.

Regenerate with `python3 scripts/build-drum-samples.py` (needs ffmpeg) —
the script holds the exact source files used.
