"""Render booth clips with Kokoro-82M on the CPU (docs/commentary.md). Runs inside the Kokoro venv, not the project
one: `.tts/kokoro/bin/python -I scripts/booth_kokoro.py JOBS.json en`, called by studiodesk/booth.py.

JOBS.json: [{say, voice, path}]. Each clip is synthesised whole, then trimmed and written in the replay mp3 format
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
from kokoro import KPipeline  # noqa: E402

LANG_CODE = {"en": "a", "it": "i", "es": "e"}
SR = 24000
AF = ("silenceremove=start_periods=1:start_threshold=-50dB,areverse,"
      "silenceremove=start_periods=1:start_threshold=-50dB,areverse,"
      "afade=t=in:d=0.008,areverse,afade=t=in:d=0.008,areverse")


def main(jobs_path, lang):
    jobs = json.load(open(jobs_path))
    torch.set_num_threads(int(os.environ.get("KOKORO_THREADS", os.cpu_count() or 1)))  # 1 is faster on a busy CPU
    pipe = KPipeline(lang_code=LANG_CODE[lang], repo_id="hexgrad/Kokoro-82M")
    synth_s = audio_s = 0.0
    with tempfile.TemporaryDirectory() as tmp:
        for i, job in enumerate(jobs, 1):
            t0 = time.perf_counter()
            audio = np.concatenate([np.asarray(a) for _, _, a in pipe(job["say"], voice=job["voice"])])
            synth_s += time.perf_counter() - t0
            audio_s += len(audio) / SR
            wav = os.path.join(tmp, "clip.wav")
            sf.write(wav, audio, SR)
            part = job["path"] + ".part.mp3"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav, "-af", AF, "-ar", "24000", "-ac", "1",
                            "-b:a", "48k", part], check=True)
            os.replace(part, job["path"])
            if i % 50 == 0:
                print(f"kokoro {lang}: {i}/{len(jobs)} clips, RTF {synth_s / audio_s:.2f}", flush=True)
    print(f"kokoro {lang}: {len(jobs)} clips, {audio_s:.1f} s of speech in {synth_s:.1f} s, "
          f"RTF {synth_s / max(audio_s, 1e-9):.2f}", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:3])
