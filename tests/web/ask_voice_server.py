"""The API for tests/web/ask-voice.mjs, with nothing reaching Azure: a stand-in model makes Ask the studio
available, and Speech is a stub that refuses any audio but the page's WAV and answers a fixed question.

    PYTHONPATH=. .venv/bin/python tests/web/ask_voice_server.py PORT
"""
import sys

import uvicorn

from studiodesk import api, speech
from studiodesk.agents import ask
from studiodesk.agents.llm import FakeChatClient

HEARD = {"en": "Who has scored so far?", "it": "Chi ha segnato finora?", "es": "¿Quién ha marcado hasta ahora?"}


def transcribe(audio: bytes, lang: str, token: str) -> str:
    assert speech.wav_problem(audio) is None and token == "test-token"
    return HEARD[lang]


if __name__ == "__main__":
    api.ENDPOINT = "https://model.invalid"
    fake = FakeChatClient()
    ask.client = lambda endpoint: fake
    speech.ENDPOINT, speech.RESOURCE_ID, speech.transcribe = "https://speech.invalid", "/test", transcribe
    api._token = lambda: "test-token"
    uvicorn.run(api.app, host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")
