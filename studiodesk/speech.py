"""Ask the studio by voice: a short recorded question turned into text with the Azure Speech REST API for
short audio (https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short).
The page records 16 kHz mono 16-bit PCM WAV, one of the two formats that API takes. The audio lives only in
the request's memory: it is never written to disk, logged or sent anywhere but Azure Speech."""
import io
import os
import time
import wave

import httpx

# the account's real-time speech to text host (https://<region>.stt.speech.microsoft.com, its "Speech to Text
# (Standard)" endpoint; the custom subdomain answers 429 on F0) and its resource id, which Entra ID tokens need
ENDPOINT = os.environ.get("AZURE_SPEECH_ENDPOINT", "").rstrip("/")
RESOURCE_ID = os.environ.get("AZURE_SPEECH_RESOURCE_ID", "")
LOCALES = {"en": "en-GB", "it": "it-IT", "es": "es-ES"}  # the page's languages
RATE = 16000
MAX_S = 10.5   # the page stops recording at 10 s
MIN_S = 0.2
MAX_BYTES = 44 + int(RATE * 2 * MAX_S)  # the WAV header and 10.5 s of samples
TIMEOUT_S = 15.0
CONTENT_TYPE = "audio/wav; codecs=audio/pcm; samplerate=16000"
NOTHING_HEARD = {"NoMatch", "InitialSilenceTimeout", "BabbleTimeout"}
# Speech F0 gives 5 audio hours a month of real-time speech to text, billed by the second
# (https://azure.microsoft.com/en-us/pricing/details/speech/). 40 clips a day of at most 10.5 s, over 31 days,
# is 3.6 hours. Each clip is counted before the call, so a failed one still counts. ASK_VOICE_PER_DAY overrides.
PER_DAY = int(os.environ.get("ASK_VOICE_PER_DAY", "40"))
PER_CLIENT_PER_DAY = 15  # per client address, as for edits: dropping the cookie does not reset it
# F0 takes 1 concurrent speech to text request (speech-services-quotas-and-limits): a second one waits this long
WAIT_S = 10.0
# F0 also answers 429 "resource constraints" now and then, about one clip in three on 27 Oct 2026, and the
# same clip goes through a moment later: two more tries after these pauses
BUSY_RETRY_S = (1.0, 2.0)


def available() -> bool:
    return bool(ENDPOINT and RESOURCE_ID)


def wav_problem(data: bytes) -> str | None:
    """Why `data` is not the WAV the page records (16 kHz, mono, 16-bit PCM, MIN_S to MAX_S long), or None."""
    try:
        with wave.open(io.BytesIO(data)) as w:
            shape, frames = (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getcomptype()), w.getnframes()
    except (wave.Error, EOFError):
        return "the audio is not a WAV file"
    if shape != (1, 2, RATE, "NONE"):
        return "the audio is not 16 kHz mono 16-bit PCM"
    if not MIN_S * RATE <= frames <= MAX_S * RATE:
        return f"the audio is not {MIN_S} to {MAX_S} seconds long"
    return None


def transcribe(audio: bytes, lang: str, token: str) -> str:
    """The text Azure Speech heard in `audio`, "" when it heard no words; raises on any other outcome.
    `token` is a Microsoft Entra token for https://cognitiveservices.azure.com, sent as the API asks:
    aad#<resource id>#<token>."""
    for wait in BUSY_RETRY_S + (None,):
        r = httpx.post(f"{ENDPOINT}/speech/recognition/conversation/cognitiveservices/v1",
                       params={"language": LOCALES[lang], "format": "simple", "profanity": "masked"},
                       headers={"Authorization": f"Bearer aad#{RESOURCE_ID}#{token}", "Content-Type": CONTENT_TYPE,
                                "Accept": "application/json"},
                       content=audio, timeout=TIMEOUT_S)
        if r.status_code != 429 or wait is None:
            break
        time.sleep(wait)
    r.raise_for_status()
    out = r.json()
    status = out.get("RecognitionStatus")
    if status == "Success":
        return str(out.get("DisplayText") or "")
    if status in NOTHING_HEARD:
        return ""
    raise RuntimeError(f"speech to text: {status}")
