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
        choices=("analyze", "separate", "bpm", "midi", "chords"),
        default="analyze",
        help="analyze = separate + bpm (default); separate = stems only; bpm = tempo only; chords = harmonic analysis",
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


def run_midi(input_path: str, out_dir: str) -> dict[str, Any]:
    # Lazy-imported — basic-pitch pulls TensorFlow/ONNX which is ~200 MB
    # and adds ~3 s of import time. The other --mode options should not
    # pay that cost.
    emit_progress(0.05, "loading basic-pitch")
    from basic_pitch.inference import predict_and_save
    from basic_pitch import ICASSP_2022_MODEL_PATH

    Path(out_dir).mkdir(parents=True, exist_ok=True)
    emit_progress(0.15, "predicting notes")
    # `predict_and_save` writes a `<stem>_basic_pitch.mid` next to the
    # input by default; pin save_midi=True only and disable the heavier
    # outputs (sonification WAV, model output npz, note CSV) — we just
    # need the MIDI for Guitar Pro import.
    predict_and_save(
        audio_path_list=[input_path],
        output_directory=out_dir,
        save_midi=True,
        sonify_midi=False,
        save_model_outputs=False,
        save_notes=False,
        model_or_model_path=ICASSP_2022_MODEL_PATH,
    )
    emit_progress(0.95, "writing midi")
    stem_name = Path(input_path).stem
    midi_path = Path(out_dir) / f"{stem_name}_basic_pitch.mid"
    if not midi_path.is_file():
        # Fall back to a glob — older basic-pitch versions used
        # `<stem>.mid` directly. Pick whatever lives in out_dir matching.
        candidates = sorted(Path(out_dir).glob(f"{stem_name}*.mid"))
        if not candidates:
            raise RuntimeError(f"basic-pitch produced no .mid in {out_dir}")
        midi_path = candidates[-1]
    return {"midi_path": str(midi_path), "stem": stem_name}


# Chroma pitch labels — index 0 = C, 1 = C#, …, 11 = B. Matches
# librosa.feature.chroma_*'s output ordering. Sharps preferred over
# flats to match how popular-music tabs are usually written.
CHROMA_LABELS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def run_chords(input_path: str) -> dict[str, Any]:
    """Beat-synchronous chord recognition via chroma template matching.

    No external chord lib — we build a 24-chord template bank (12
    major + 12 minor triads) and pick the best match for each beat's
    mean chroma vector. Quality is roughly on par with sonic
    visualiser's chordino at default settings, which is what most
    musicians need for practice. Adjacent identical labels are merged
    into single segments so the UI gets a tidy chord chart, not a
    one-label-per-beat noise track.
    """
    import librosa
    import numpy as np

    emit_progress(0.05, "loading audio")
    y, sr = librosa.load(input_path, sr=22050, mono=True)
    if y.size == 0:
        return {"chords": []}

    emit_progress(0.30, "beat tracking")
    hop = 512
    _, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop, units="frames")
    if beat_frames.size < 2:
        # Fall back to fixed 0.5 s chunks when beat tracking gives us
        # nothing usable (very short or very noisy clips).
        frame_step = max(1, int(0.5 * sr / hop))
        total = int(np.ceil(y.size / hop))
        beat_frames = np.arange(0, total, frame_step)

    emit_progress(0.55, "chroma")
    # chroma_cens is more robust to timbre/instrumentation than
    # chroma_cqt — important when the input is a full mix with drums
    # and vocals colouring the harmonic content.
    chroma = librosa.feature.chroma_cens(y=y, sr=sr, hop_length=hop)
    # Aggregate to one chroma vector per beat-interval. `pad=False`
    # is critical: with the default pad=True librosa adds a column
    # before the first beat and after the last one, leaving the
    # output one longer than `len(beat_frames) - 1`. Downstream we
    # index `beat_times` (length = len(beat_frames)) by the column
    # index, which then crashes with IndexError on the trailing pad
    # column. pad=False makes column `i` correspond exactly to the
    # interval [beat_frames[i], beat_frames[i+1]).
    beat_chroma = librosa.util.sync(
        chroma, beat_frames, aggregate=np.mean, pad=False
    )

    emit_progress(0.80, "matching templates")
    # Build templates: major = root + major-third + perfect-fifth;
    # minor = root + minor-third + perfect-fifth. Normalised to unit
    # length so the dot product is cosine similarity.
    maj = np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0], dtype=float)
    min_ = np.array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0], dtype=float)
    templates = []
    labels: list[str] = []
    for r in range(12):
        templates.append(np.roll(maj, r))
        labels.append(CHROMA_LABELS[r])
        templates.append(np.roll(min_, r))
        labels.append(f"{CHROMA_LABELS[r]}m")
    T = np.stack(templates)
    T /= np.linalg.norm(T, axis=1, keepdims=True)
    # Per-beat best template. Skip beats whose chroma magnitude is
    # tiny (silence / drum-only) — mark them as None so the merger
    # below extends the previous chord through the gap instead of
    # littering the timeline with bogus C labels.
    norms = np.linalg.norm(beat_chroma, axis=0, keepdims=True)
    valid = (norms > 1e-3).flatten()
    chroma_norm = beat_chroma / np.maximum(norms, 1e-9)
    scores = T @ chroma_norm  # 24 x n_beats
    best = np.argmax(scores, axis=0)
    per_beat_labels: list[str | None] = [
        labels[int(b)] if v else None for b, v in zip(best, valid)
    ]
    # Defensive clamp against librosa version drift: `per_beat_labels`
    # must never exceed the number of usable boundary pairs in
    # `beat_frames` (we index `beat_times[cursor]` below).
    per_beat_labels = per_beat_labels[: max(0, len(beat_frames) - 1)]

    emit_progress(0.92, "merging segments")
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)
    # Tack the audio end on so the last segment closes cleanly.
    end_time = float(y.size / sr)
    segments: list[dict[str, Any]] = []
    cursor = 0
    while cursor < len(per_beat_labels):
        lbl = per_beat_labels[cursor]
        if lbl is None:
            cursor += 1
            continue
        run_end = cursor
        while (
            run_end + 1 < len(per_beat_labels)
            and per_beat_labels[run_end + 1] == lbl
        ):
            run_end += 1
        start = float(beat_times[cursor])
        # Stop at the next beat's onset (or audio end on the last run).
        next_idx = run_end + 1
        stop = (
            float(beat_times[next_idx])
            if next_idx < len(beat_times)
            else end_time
        )
        # Filter out vanishingly short blips that are almost certainly
        # template-matching jitter, not real chord changes.
        if stop - start >= 0.18:
            segments.append({"start": round(start, 3), "end": round(stop, 3), "label": lbl})
        cursor = run_end + 1
    return {"chords": segments}


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
        elif args.mode == "midi":
            payload.update(run_midi(args.input, args.out_dir))
        elif args.mode == "chords":
            payload.update(run_chords(args.input))
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
