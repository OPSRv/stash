# stash-separator

Out-of-process Python sidecar for the Stash app. Runs Meta's [Demucs](https://github.com/facebookresearch/demucs) for music source separation and [BeatNet](https://github.com/mjhydri/BeatNet) for tempo detection.

This package is **not part of the macOS `.app` bundle**. It is built once per release on `macos-14` (Apple Silicon) by `.github/workflows/release.yml`, code-signed, notarized, packaged as a tarball, and uploaded as a release asset. The Stash app downloads it lazily on user opt-in into `$APPLOCALDATA/separator/`.

The same out-of-process layout that `crates/stash-diarize/` uses for diarization, but with a Python toolchain instead of Rust because Demucs and BeatNet are Python-only.

## Layout

- `src/main.py` — CLI entry (`--mode analyze | separate | bpm`)
- `requirements.txt` — Python pins (demucs, BeatNet, torch, soundfile)
- `stash-separator.spec` — PyInstaller `--onedir` spec
- `build.sh` — local build helper

## Local build

```sh
./build.sh
```

Produces `dist/stash-separator/` with the binary + bundled libs. Copy that directory to `~/Library/Application Support/com.stash.popup/separator/bin/` to test the running Stash app against your local build.

## CLI

```sh
stash-separator --mode analyze \
                --input song.mp3 \
                --out-dir ./stems \
                --model htdemucs_6s \
                --device auto
```

Writes a single JSON line to stdout on completion:

```json
{
  "stems_dir": "./stems",
  "stems": {
    "vocals":  "./stems/vocals.wav",
    "drums":   "./stems/drums.wav",
    "bass":    "./stems/bass.wav",
    "guitar":  "./stems/guitar.wav",
    "piano":   "./stems/piano.wav",
    "other":   "./stems/other.wav"
  },
  "bpm": 128.4,
  "beats": [0.21, 0.68, 1.15, 1.62, ...],
  "duration_sec": 240.5,
  "model": "htdemucs_6s",
  "device": "mps"
}
```

Progress is written to stderr as `progress\t<0..1>\t<phase>` lines. On failure the binary still exits 0 with `{"error":"..."}` — the parent never has to interpret an exit code (same contract as `stash-diarize`).

## Output filenames

| Model         | Stems |
|---------------|-------|
| `htdemucs_6s` (default) | `vocals`, `drums`, `bass`, **`guitar`**, `piano`, `other` |
| `htdemucs` / `htdemucs_ft` | `vocals`, `drums`, `bass`, `other` |

Use `--stems vocals,drums` to keep only a subset.

## BPM

`--mode analyze` runs BeatNet on the **drums** stem after separation finishes. Beat tracking is noticeably more confident on a clean percussion signal than on a full mix.

`--mode bpm` runs BeatNet directly on the input file (no separation). Faster, slightly less reliable on busy mixes.

## Models

Demucs caches models under `$TORCH_HOME/hub/`. The Stash app sets `TORCH_HOME=$APPLOCALDATA/separator/models/` via `--models-dir` so weights live under the app data dir, not `~/.cache/torch/hub`.
