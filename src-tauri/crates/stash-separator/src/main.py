#!/usr/bin/env python3
# stash-separator — out-of-process audio analysis sidecar.
#
# Reads a path to a music file (any ffmpeg-decodable format) and runs:
#   1) Demucs source separation (htdemucs_6s by default — gives a guitar stem)
#   2) BeatNet tempo + beat tracking on the drum stem (more reliable than
#      a full mix with vocals/melody/sfx fighting for the beat network's
#      attention)
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


# Demucs `Separator` invokes this on every internal segment. We map its
# 0..audio_length progress to our 0.10..0.85 band so the UI bar moves
# smoothly across the dominant phase of the run (separation itself —
# decode is fast, file write is fast, only inference is multi-second).
def _demucs_progress_cb(data: dict[str, Any]) -> None:
    state = data.get("state", "")
    if state != "iter":
        return
    seg = float(data.get("segment_offset", 0))
    audio = float(data.get("audio_length", 1))
    fraction = 0.10 + 0.75 * min(1.0, max(0.0, seg / max(audio, 1.0)))
    emit_progress(fraction, "separating")


def run_separate(args: argparse.Namespace, device: str) -> dict[str, str]:
    # Imported lazily so `--mode bpm` doesn't pay the demucs import cost
    # (~2s on cold start).
    from demucs.api import Separator, save_audio

    emit_progress(0.05, "loading demucs")
    sep = Separator(model=args.model, device=device, callback=_demucs_progress_cb)
    emit_progress(0.10, "decoding audio")
    _origin, separated = sep.separate_audio_file(Path(args.input))
    emit_progress(0.85, "writing stems")
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    keep: set[str] | None = (
        {s.strip() for s in args.stems.split(",") if s.strip()}
        if args.stems
        else None
    )
    paths: dict[str, str] = {}
    for stem_name, tensor in separated.items():
        if keep is not None and stem_name not in keep:
            continue
        target = out / f"{stem_name}.wav"
        save_audio(tensor, target, samplerate=sep.samplerate)
        paths[stem_name] = str(target)
    emit_progress(0.92, "stems written")
    return paths


def run_bpm(stems_paths: dict[str, str] | None, input_path: str) -> dict[str, Any]:
    # Prefer the drums stem when separation already ran — beat tracking is
    # noticeably more confident on a clean percussion signal than on a
    # full mix where vocals/melody/sfx blur the onset envelope.
    emit_progress(0.92, "loading beatnet")
    from BeatNet.BeatNet import BeatNet
    import numpy as np

    target = stems_paths.get("drums") if stems_paths else None
    if target is None:
        target = input_path

    estimator = BeatNet(
        1, mode="offline", inference_model="DBN", plot=[], thread=False
    )
    emit_progress(0.95, "detecting tempo")
    output = estimator.process(target)
    if output is None or len(output) < 2:
        return {"bpm": None, "beats": []}
    beats = [float(t) for t, _ in output]
    intervals = np.diff(beats)
    if len(intervals) == 0:
        return {"bpm": None, "beats": beats}
    bpm = float(60.0 / np.median(intervals))
    return {"bpm": round(bpm, 2), "beats": beats}


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
