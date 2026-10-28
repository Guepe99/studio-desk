"""The video's voice-over with Kokoro am_michael, one WAV per line of voice-jobs.json (as scripts/booth_kokoro.py, but WAV:
the replay clips' 48 kbit/s mp3 is too thin for the video). Run: HF_HOME=../.tts/hf ../.tts/kokoro/bin/python -I voice.py"""
import json
import os

os.environ.setdefault("HF_HUB_OFFLINE", "1")
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from huggingface_hub import hf_hub_download  # noqa: E402
from kokoro import KModel, KPipeline  # noqa: E402

REPO, REV = "hexgrad/Kokoro-82M", "f3ff3571791e39611d31c381e3a41a3af07b4987"
pinned = lambda name: hf_hub_download(REPO, name, revision=REV)  # noqa: E731
model = KModel(repo_id=REPO, config=pinned("config.json"), model=pinned("kokoro-v1_0.pth")).eval()
pipe = KPipeline(lang_code="a", repo_id=REPO, model=model)
here = os.path.dirname(os.path.abspath(__file__))
for job in json.load(open(os.path.join(here, "voice-jobs.json"))):
    torch.manual_seed(0)
    audio = np.concatenate([np.asarray(a) for _, _, a in pipe(job["say"], voice=pinned(f"voices/{job['voice']}.pt"))])
    path = os.path.join(here, job["path"].replace(".mp3", ".wav"))
    sf.write(path, audio, 24000)
    print(f"{os.path.basename(path)} {len(audio) / 24000:.2f}", flush=True)
