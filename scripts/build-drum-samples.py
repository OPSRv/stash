#!/usr/bin/env python3
"""Fetch + render the Drums module's sampled kits (all sources CC0).

Downloads the chosen one-shots from the sfzinstruments GitHub repos, then
with ffmpeg: mixes close + overhead mics (Big Rusty), trims leading
silence, cuts each hit to a voice-specific length with a fade-out, and
writes 44.1 kHz mono 16-bit WAVs to src/modules/drums/samples/<kit>/.

Every file is peak-normalised to -1 dBFS; hit-vs-accent dynamics and the
kit balance are applied at runtime (see lib/samples.ts).

Usage: python3 scripts/build-drum-samples.py   (needs ffmpeg on PATH)
"""

import os
import subprocess
import sys
import tempfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src", "modules", "drums", "samples")

VIRT = "https://raw.githubusercontent.com/sfzinstruments/virtuosity_drums/master/Samples/mid/"
RUSTY = "https://raw.githubusercontent.com/sfzinstruments/karoryfer.big-rusty-drums/main/Samples/"
BODY = "https://raw.githubusercontent.com/sfzinstruments/body_percussion/main/Samples/body/"

# Seconds kept per voice (fade-out over the last 35%).
LENGTH = {
    "kick": 0.9, "snare": 0.8, "chh": 0.35, "ohh": 1.2,
    "clap": 0.6, "tom": 1.2, "rim": 0.35, "crash": 2.5,
}

CLAP = {"": [BODY + "handclap_vl1_rr1.wav"], "-accent": [BODY + "handclap_vl2_rr1.wav"]}

# kit -> voice -> layer suffix -> list of source URLs (mixed together; the
# first is the close mic at full level, the rest are overheads at 0.7).
KITS = {
    "acoustic": {
        "kick": {"": [VIRT + "kick/mid_kick_snon_vl3_rr1.flac"],
                 "-accent": [VIRT + "kick/mid_kick_snon_vl4_rr1.flac"]},
        "snare": {"": [VIRT + "snare/mid_snare_center_vl24.flac"],
                  "-accent": [VIRT + "snare/mid_snare_center_vl36.flac"]},
        "chh": {"": [VIRT + "hh/mid_hh_closed_vl3_rr1.flac"],
                "-accent": [VIRT + "hh/mid_hh_closed_vl4_rr1.flac"]},
        "ohh": {"": [VIRT + "hh/mid_hh_open_vl2_rr1.flac"],
                "-accent": [VIRT + "hh/mid_hh_open_vl4_rr1.flac"]},
        "clap": CLAP,
        "tom": {"": [VIRT + "ltom/mid_ltom_center_vl10.flac"]},
        "rim": {"": [VIRT + "snare/mid_snare_crossstick_vl8.flac"]},
        "crash": {"": [VIRT + "crash/mid_crash_crash_vl2_rr1.flac"]},
    },
    "rock": {
        "kick": {"": [RUSTY + "kick_24/kick/kick/k_vl9_rr1.flac", RUSTY + "kick_24/kick/oh/k_vl9_rr1.flac"],
                 "-accent": [RUSTY + "kick_24/kick/kick/k_vl13_rr1.flac", RUSTY + "kick_24/kick/oh/k_vl13_rr1.flac"]},
        "snare": {"": [RUSTY + "snare_14/center/top/sn_center_vl6_rr1.flac", RUSTY + "snare_14/center/oh/sn_center_vl6_rr1.flac"],
                  "-accent": [RUSTY + "snare_14/center/top/sn_center_vl9_rr1.flac", RUSTY + "snare_14/center/oh/sn_center_vl9_rr1.flac"]},
        "chh": {"": [RUSTY + "hihat_14/cl/cl/ht_cl_vl4_rr1.flac", RUSTY + "hihat_14/cl/oh/ht_cl_vl4_rr1.flac"],
                "-accent": [RUSTY + "hihat_14/cl/cl/ht_cl_vl6_rr1.flac", RUSTY + "hihat_14/cl/oh/ht_cl_vl6_rr1.flac"]},
        "ohh": {"": [RUSTY + "hihat_14/open/cl/ht_open_vl4_rr1.flac", RUSTY + "hihat_14/open/oh/ht_open_vl4_rr1.flac"]},
        "clap": CLAP,
        "tom": {"": [RUSTY + "tom_18/center/cl/t18_vl6_rr1.flac", RUSTY + "tom_18/center/oh/t18_vl6_rr1.flac"]},
        "rim": {"": [RUSTY + "snare_14/sidestick/top/sn_ss_vl3_rr1.flac", RUSTY + "snare_14/sidestick/oh/sn_ss_vl3_rr1.flac"]},
        "crash": {"": [RUSTY + "crash_17/cr/cl/cr_vl4_rr1.flac", RUSTY + "crash_17/cr/oh/cr_vl4_rr1.flac"]},
    },
}


def fetch(url: str, cache: str) -> str:
    path = os.path.join(cache, url.replace("https://", "").replace("/", "_"))
    if not os.path.exists(path):
        print("  ↓", url.rsplit("/", 1)[-1])
        urllib.request.urlretrieve(url, path)
    return path


def render(sources: list[str], length: float, out: str) -> None:
    fade = length * 0.35
    args = ["ffmpeg", "-v", "error", "-y"]
    for s in sources:
        args += ["-i", s]
    weights = " ".join(["1"] + ["0.7"] * (len(sources) - 1))
    mix = (
        f"amix=inputs={len(sources)}:weights={weights}:normalize=0,"
        if len(sources) > 1
        else ""
    )
    # Trim pre-attack silence (keeps samples tight to the grid), cut, fade.
    chain = (
        f"{mix}aformat=channel_layouts=mono,"
        "silenceremove=start_periods=1:start_threshold=-55dB:start_silence=0.002,"
        f"atrim=0:{length},afade=t=out:st={length - fade:.3f}:d={fade:.3f}"
    )
    labels = "".join(f"[{i}:a]" for i in range(len(sources)))
    tmp = out + ".f32.wav"
    args += ["-filter_complex", f"{labels}{chain}", "-ar", "44100", "-ac", "1", "-c:a", "pcm_f32le", tmp]
    subprocess.run(args, check=True)
    # Peak-normalise to -1 dBFS while still in float, then quantise — quiet
    # velocity layers keep their full 16-bit resolution.
    probe = subprocess.run(
        ["ffmpeg", "-i", tmp, "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    peak = float(probe.split("max_volume:")[1].split("dB")[0])
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", tmp, "-af", f"volume={-1.0 - peak:.2f}dB",
         "-c:a", "pcm_s16le", out],
        check=True,
    )
    os.remove(tmp)


def main() -> None:
    cache = os.path.join(tempfile.gettempdir(), "stash-drum-src")
    os.makedirs(cache, exist_ok=True)
    for kit, voices in KITS.items():
        os.makedirs(os.path.join(OUT, kit), exist_ok=True)
        print(f"[{kit}]")
        for voice, layers in voices.items():
            for suffix, urls in layers.items():
                srcs = [fetch(u, cache) for u in urls]
                render(srcs, LENGTH[voice], os.path.join(OUT, kit, f"{voice}{suffix}.wav"))
    print("done →", OUT)


if __name__ == "__main__":
    sys.exit(main())
