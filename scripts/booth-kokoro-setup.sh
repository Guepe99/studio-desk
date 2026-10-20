#!/bin/bash
# Kokoro-82M for the booth clips in all three languages (docs/commentary.md): a venv apart from the project's, the model
# and the six voices at a pinned revision, checked by SHA256. About 1.7 GB under .tts/ (git-ignored); delete it when done.
set -euo pipefail
cd "$(dirname "$0")/.."
REV=f3ff3571791e39611d31c381e3a41a3af07b4987
export HF_HOME="$PWD/.tts/hf"
python3 -m venv .tts/kokoro
.tts/kokoro/bin/pip install -q --index-url https://download.pytorch.org/whl/cpu torch==2.5.1+cpu
.tts/kokoro/bin/pip install -q -r scripts/booth-kokoro-requirements.txt
.tts/kokoro/bin/python -I - "$REV" <<'PY'
import hashlib, sys
from huggingface_hub import hf_hub_download
SHA = {"kokoro-v1_0.pth": "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4",
       "config.json": "5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f",
       "voices/am_michael.pt": "9a443b79a4b22489a5b0ab7c651a0bcd1a30bef675c28333f06971abbd47bd37",
       "voices/am_fenrir.pt": "98e507eca1db08230ae3b6232d59c10aec9630022d19accac4f5d12fcec3c37a",
       "voices/if_sara.pt": "6c0b253b955fe32f1a1a86006aebe83d050ea95afd0e7be15182f087deedbf55",
       "voices/im_nicola.pt": "234ed06648649f9bd874b37508ea17560b9c993ef85b4ddb3e3a71e062bd2c12",
       "voices/ef_dora.pt": "d9d69b0f8a2b87a345f269d89639f89dfbd1a6c9da0c498ae36dd34afcf35530",
       "voices/em_alex.pt": "5eac53f767c3f31a081918ba531969aea850bed18fe56419b804d642c6973431"}
for name, want in SHA.items():
    path = hf_hub_download("hexgrad/Kokoro-82M", name, revision=sys.argv[1])
    got = hashlib.sha256(open(path, "rb").read()).hexdigest()
    assert got == want, f"{name}: sha256 {got}, expected {want}"
print("Kokoro-82M ready")
PY
