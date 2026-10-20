"""Render booth clips with Kokoro-82M on the CPU (docs/commentary.md). Runs inside the Kokoro venv, not the project
one: `.tts/kokoro/bin/python -I scripts/booth_kokoro.py JOBS.json en`, called by studiodesk/booth.py.

JOBS.json: [{say, voice, gain_db, path}]. Each clip is synthesised whole, then trimmed and written in the replay mp3 format
like the Azure clips (24 kHz mono, 48 kbit/s). Prints the real-time factor at the end.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")  # the model and voices are fetched once by scripts/booth-kokoro-setup.sh

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from huggingface_hub import hf_hub_download  # noqa: E402
from kokoro import KModel, KPipeline  # noqa: E402

LANG_CODE = {"en": "a", "it": "i", "es": "e"}
REPO, REV = "hexgrad/Kokoro-82M", "f3ff3571791e39611d31c381e3a41a3af07b4987"  # booth-kokoro-setup.sh reads REV here
SR = 24000
AF = ("silenceremove=start_periods=1:start_threshold=-50dB,areverse,"
      "silenceremove=start_periods=1:start_threshold=-50dB,areverse,"
      "afade=t=in:d=0.008,areverse,afade=t=in:d=0.008,areverse")


def main(jobs_path, lang):
    jobs = json.load(open(jobs_path))
    torch.set_num_threads(int(os.environ.get("KOKORO_THREADS", os.cpu_count() or 1)))  # 1 is faster on a busy CPU
    # the pinned revision's files: KPipeline alone would ask for "main"
    pinned = lambda name: hf_hub_download(REPO, name, revision=REV)  # noqa: E731
    model = KModel(repo_id=REPO, config=pinned("config.json"), model=pinned("kokoro-v1_0.pth")).eval()
    pipe = KPipeline(lang_code=LANG_CODE[lang], repo_id=REPO, model=model)
    synth_s = audio_s = 0.0
    with tempfile.TemporaryDirectory() as tmp:
        for i, job in enumerate(jobs, 1):
            t0 = time.perf_counter()
            torch.manual_seed(0)  # the vocoder adds random noise: a fixed seed makes a clip the same on every run
            audio = np.concatenate([np.asarray(a) for _, _, a in pipe(job["say"], voice=pinned(f"voices/{job['voice']}.pt"))])
            synth_s += time.perf_counter() - t0
            audio_s += len(audio) / SR
            wav = os.path.join(tmp, "clip.wav")
            sf.write(wav, audio, SR)
            part = job["path"] + ".part.mp3"
            # gain_db (web/booth/lines.json) levels each voice near the studio clips; the limiter keeps peaks under -1 dBFS
            af = f"{AF},volume={job['gain_db']}dB,alimiter=limit=0.89:level=false"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav, "-af", af, "-ar", "24000", "-ac", "1",
                            "-b:a", "48k",
                            "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", part], check=True)
            os.replace(part, job["path"])
            if i % 50 == 0:
                print(f"kokoro {lang}: {i}/{len(jobs)} clips, RTF {synth_s / audio_s:.2f}", flush=True)
    print(f"kokoro {lang}: {len(jobs)} clips, {audio_s:.1f} s of speech in {synth_s:.1f} s, "
          f"RTF {synth_s / max(audio_s, 1e-9):.2f}", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:3])
