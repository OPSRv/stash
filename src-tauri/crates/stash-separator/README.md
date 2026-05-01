# stash-separator

Source for the audio analysis pipeline of Stash's `separator` module — Meta's [Demucs](https://github.com/facebookresearch/demucs) for music source separation and [BeatNet](https://github.com/mjhydri/BeatNet) for tempo detection.

The two files here — `src/main.py` and `requirements.txt` — are the **source of truth** the running app uses. They are baked into the main `stash-app` binary at compile time via Rust `include_str!`, then staged on disk under `$APPLOCALDATA/separator/` the first time the user opts in. There is **no separate tarball** to host: the runtime is provisioned at install time by `installer.rs` using [uv](https://github.com/astral-sh/uv) (download `uv` → `uv python install 3.11` → `uv venv` → `uv pip install -r requirements.txt`).

This is intentional. PyInstaller bundles couple the sidecar to a release tag and force the project to host a 280 MB tarball for every version; the uv route ships zero per-release artefacts and the tarball-host question goes away.

## Layout

- `src/main.py` — CLI entry (`--mode analyze | separate | bpm`). Read by the Rust app via `include_str!`.
- `requirements.txt` — Python pins (demucs, BeatNet, torch, soundfile, numpy<2). Same — staged via `include_str!`.

## Running locally without Stash

For quick iteration on `main.py` outside the app:

```sh
cd src-tauri/crates/stash-separator
uv venv .venv --python 3.11
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python src/main.py --mode analyze \
    --input ~/Music/song.mp3 \
    --out-dir /tmp/stems \
    --model htdemucs_6s \
    --device auto
```

The script writes a single JSON line to stdout and `progress\t<0..1>\t<phase>` lines to stderr. On failure it still exits 0 with `{"error":"..."}` — the in-app parser never has to interpret an exit code.

## Output filenames

| Model         | Stems |
|---------------|-------|
| `htdemucs_6s` (default) | `vocals`, `drums`, `bass`, **`guitar`**, `piano`, `other` |
| `htdemucs` / `htdemucs_ft` | `vocals`, `drums`, `bass`, `other` |

Use `--stems vocals,drums` to keep only a subset.

## BPM

`--mode analyze` runs BeatNet on the **drums** stem after separation finishes — beat tracking is noticeably more confident on a clean percussion signal than on a full mix.

`--mode bpm` runs BeatNet directly on the input file (no separation). Faster, slightly less reliable on busy mixes.

## Models

Demucs caches models under `$TORCH_HOME/hub/`. The Stash app sets `TORCH_HOME=$APPLOCALDATA/separator/models/` via `--models-dir` so weights live under the app data dir, not `~/.cache/torch/hub`.
