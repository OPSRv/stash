#!/usr/bin/env python3
# stash-separator — out-of-process audio analysis sidecar.
#
# Reads a path to a music file (any ffmpeg-decodable format) and runs:
#   1) Demucs source separation (htdemucs_6s by default — gives a guitar stem)
#   2) librosa.beat.beat_track for tempo + beat tracking on the drum
#      stem (cleaner percussion signal than the full mix where
#      vocals/melody/sfx blur the onset envelope)
#
# Writes a single JSON line to stdout:
#   {"stems_dir": "...", "stems": {...}, "bpm": 128.4, "beats": [...],
#    "duration_sec": 240.5, "model": "htdemucs_6s", "device": "mps"}
#
# On failure we still exit 0 with `{"error": "..."}` — same contract as
# stash-diarize: the parent reads JSON, never has to interpret an exit
# code or parse panic-output.
#
# Progress lines go to stderr in the format
#   progress\t<float 0..1>\t<phase>
# so the Rust parent can drive the UI progress bar in real time.

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


def emit_progress(fraction: float, phase: str) -> None:
    sys.stderr.write(f"progress\t{fraction:.4f}\t{phase}\n")
    sys.stderr.flush()


def emit_result(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.exit(0)


def emit_error(message: str) -> None:
    emit_result({"error": message})


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="stash-separator")
    p.add_argument(
        "--mode",
        choices=("analyze", "separate", "bpm"),
        default="analyze",
        help="analyze = separate + bpm (default); separate = stems only; bpm = tempo only",
    )
    p.add_argument("--input", required=True, help="path to audio file")
    p.add_argument("--out-dir", required=True, help="destination directory for stems")
    p.add_argument(
        "--model",
        default="htdemucs_6s",
        choices=("htdemucs_6s", "htdemucs_ft", "htdemucs"),
        help="demucs model name",
    )
    p.add_argument(
        "--device",
        default="auto",
        choices=("auto", "cpu", "mps", "cuda"),
        help="torch device; auto = mps→cuda→cpu",
    )
    p.add_argument(
        "--stems",
        default=None,
        help="comma-separated subset of stems to keep (default: all)",
    )
    p.add_argument(
        "--models-dir",
        default=None,
        help="override torch hub model cache dir (default: $TORCH_HOME or ~/.cache/torch/hub)",
    )
    return p.parse_args()


def resolve_device(arg: str) -> str:
    if arg != "auto":
        return arg
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def run_separate(args: argparse.Namespace, device: str) -> dict[str, str]:
    # Lazy-imported so `--mode bpm` doesn't pay the demucs/torch import
    # cost (~30 s on cold start). We use the low-level
    # `demucs.pretrained` + `demucs.apply` + `demucs.audio` API rather
    # than the convenience `demucs.api.Separator` wrapper — that one
    # was added after the 4.0.1 PyPI release and isn't in the wheels
    # uv resolves for us. The low-level surface has been stable since
    # demucs 4.0.0.
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    from demucs.audio import AudioFile, save_audio
    import torch

    emit_progress(0.05, "loading demucs")
    model = get_model(args.model)
    samplerate = int(getattr(model, "samplerate", 44100))
    audio_channels = int(getattr(model, "audio_channels", 2))
    sources: list[str] = list(getattr(model, "sources", []))
    if not sources:
        # Bag-of-models bundles (`htdemucs_ft`) put `sources` on the
        # contained models instead of the bundle itself.
        inner = getattr(model, "models", None)
        if inner:
            sources = list(getattr(inner[0], "sources", []))

    emit_progress(0.10, "decoding audio")
    wav = AudioFile(args.input).read(
        streams=0,
        samplerate=samplerate,
        channels=audio_channels,
    )
    # Per-track standardisation — `apply_model` works in normalised
    # space and rescales on the way out. Matches what
    # `demucs.separate.main` does.
    ref = wav.mean(0)
    wav_norm = (wav - ref.mean()) / ref.std()

    emit_progress(0.15, "separating")
    with torch.no_grad():
        out = apply_model(
            model,
            wav_norm[None],
            device=device,
            shifts=1,
            split=True,
            overlap=0.25,
            progress=False,
            num_workers=0,
        )[0]
    out = out * ref.std() + ref.mean()

    emit_progress(0.85, "writing stems")
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    keep: set[str] | None = (
        {s.strip() for s in args.stems.split(",") if s.strip()}
        if args.stems
        else None
    )
    paths: dict[str, str] = {}
    for source_tensor, stem_name in zip(out, sources):
        if keep is not None and stem_name not in keep:
            continue
        target = out_dir / f"{stem_name}.wav"
        save_audio(source_tensor.cpu(), target, samplerate=samplerate)
        paths[stem_name] = str(target)
    emit_progress(0.92, "stems written")
    return paths


def run_bpm(stems_paths: dict[str, str] | None, input_path: str) -> dict[str, Any]:
    # Prefer the drums stem when separation already ran — beat
    # tracking is noticeably more confident on a clean percussion
    # signal than on a full mix.
    emit_progress(0.92, "loading librosa")
    import librosa
    import numpy as np

    target = stems_paths.get("drums") if stems_paths else None
    if target is None:
        target = input_path

    emit_progress(0.94, "decoding for bpm")
    y, sr = librosa.load(target, sr=None, mono=True)
    emit_progress(0.96, "detecting tempo")
    # `beat_track` returns either a scalar or a (1,) array depending
    # on the librosa version; coerce both to a plain float.
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    tempo_val = float(np.asarray(tempo).reshape(-1)[0])
    if not np.isfinite(tempo_val) or tempo_val <= 0:
        return {"bpm": None, "beats": []}
    beats = librosa.frames_to_time(beat_frames, sr=sr).astype(float).tolist()
    return {"bpm": round(tempo_val, 2), "beats": beats}


def audio_duration_sec(path: str) -> float | None:
    try:
        import soundfile as sf

        info = sf.info(path)
        return float(info.frames / info.samplerate)
    except Exception:
        return None


def main() -> None:
    args = parse_args()
    if args.models_dir:
        # Demucs and torch.hub both honour TORCH_HOME for the model cache.
        # Setting it before any torch import keeps weights under the app
        # data dir instead of `~/.cache/torch/hub`.
        os.environ["TORCH_HOME"] = args.models_dir
    if not Path(args.input).is_file():
        emit_error(f"input file not found: {args.input}")
        return

    device = resolve_device(args.device)
    duration = audio_duration_sec(args.input)
    payload: dict[str, Any] = {
        "input": args.input,
        "model": args.model,
        "device": device,
        "duration_sec": duration,
    }

    try:
        if args.mode == "bpm":
            payload.update(run_bpm(None, args.input))
        elif args.mode == "separate":
            paths = run_separate(args, device)
            payload["stems"] = paths
            payload["stems_dir"] = args.out_dir
        else:  # analyze
            paths = run_separate(args, device)
            payload["stems"] = paths
            payload["stems_dir"] = args.out_dir
            payload.update(run_bpm(paths, args.input))
        emit_progress(1.0, "done")
        emit_result(payload)
    except Exception as e:  # noqa: BLE001 — we want every failure as JSON
        emit_error(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
