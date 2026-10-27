"""Ask the studio by voice, offline: POST /api/ask/voice with Azure Speech replaced by stubs."""
import io
import wave

import httpx
import pytest

from studiodesk import api, speech
from test_ask import studio  # noqa: F401 - the fixture: a model stand-in, no Azure

RID = "/subscriptions/0/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/speech"


def wav(seconds=2.0, rate=16000, channels=1, width=2) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(b"\x01\x00" * int(seconds * rate) * channels * (width // 2 or 1))
    return out.getvalue()


@pytest.fixture
def voice(studio, monkeypatch):  # noqa: F811
    monkeypatch.setattr(speech, "ENDPOINT", "https://speech.invalid")
    monkeypatch.setattr(speech, "RESOURCE_ID", RID)
    monkeypatch.setattr(api, "_voice_sent", {"day": "", "all": 0, "by_client": {}})
    monkeypatch.setattr(api, "_token", lambda: "entra-token")
    # never a paid service: anything that reaches the network fails the test
    monkeypatch.setattr(speech.httpx, "post", lambda *a, **kw: pytest.fail("Azure Speech called"))
    calls = []
    studio.heard = "  Who scored   first? "
    monkeypatch.setattr(speech, "transcribe", lambda audio, lang, token: calls.append((len(audio), lang, token)) or studio.heard)
    studio.calls = calls
    studio.post = lambda body=None, lang="en", ctype="audio/wav", c=None: (c or studio.visitor()).post(
        f"/api/ask/voice?lang={lang}", content=wav() if body is None else body, headers={"content-type": ctype})
    return studio


def test_the_probe_says_whether_voice_is_there(voice, monkeypatch):
    assert voice.visitor().get("/api/ask").json() == {"available": True, "voice": True}
    monkeypatch.setattr(speech, "ENDPOINT", "")
    assert voice.visitor().get("/api/ask").json() == {"available": True, "voice": False}
    assert voice.post().status_code == 503 and not voice.calls


def test_the_microphone_is_allowed_on_this_site_only(voice):
    assert "microphone=(self)" in voice.visitor().get("/api/health").headers["permissions-policy"]


def test_a_clip_becomes_text_and_the_page_language_picks_the_model(voice):
    r = voice.post(lang="it")
    assert (r.status_code, r.json()) == (200, {"text": "Who scored first?"})
    assert voice.calls == [(len(wav()), "it", "entra-token")]
    voice.heard = ""  # nothing heard: an empty text, not an error
    assert voice.post().json() == {"text": ""}
    voice.heard = "x" * 400
    assert len(voice.post().json()["text"]) == 280  # the question box's limit
    assert voice.post(lang="fr").status_code == 422
    assert len(voice.calls) == 3


@pytest.mark.parametrize("body, ctype, status", [
    (b"\x00" * (speech.MAX_BYTES + 1), "audio/wav", 413),  # the body cap of this route
    (wav(seconds=11), "audio/wav", 413),                   # longer than the page records
    (wav(seconds=0.1), "audio/wav", 422),
    (wav(rate=44100), "audio/wav", 422),
    (wav(channels=2), "audio/wav", 422),
    (b"RIFF not a wave", "audio/wav", 422),
    (wav(), "audio/webm", 415),
])
def test_only_the_wav_the_page_records_is_sent_on(voice, body, ctype, status):
    assert voice.post(body, ctype=ctype).status_code == status
    assert not voice.calls and api._voice_sent["all"] == 0  # refused before anything is counted


def test_other_posts_keep_their_small_cap(voice):
    r = voice.visitor().post("/api/ask", content=b"{" + b" " * api.MAX_BODY_BYTES + b"}", headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_caps_per_address_and_per_day(voice, monkeypatch):
    monkeypatch.setattr(speech, "PER_CLIENT_PER_DAY", 2)
    assert [voice.post().status_code for _ in range(3)] == [200, 200, 429]
    assert voice.post().json()["status"] == "limit"
    monkeypatch.setattr(api, "_voice_sent", {"day": "", "all": 0, "by_client": {}})
    monkeypatch.setattr(speech, "PER_DAY", 1)
    assert [voice.post().status_code for _ in range(2)] == [200, 429]
    assert "today" in voice.post().json()["reason"]
    assert len(voice.calls) == 3


def test_a_failed_call_is_a_502_and_still_counted(voice, monkeypatch):
    def boom(*a):
        raise httpx.ConnectError("down")
    monkeypatch.setattr(speech, "transcribe", boom)
    r = voice.post()
    assert r.status_code == 502 and "could not run" in r.json()["detail"]
    assert api._voice_sent["all"] == 1
    monkeypatch.setattr(api, "_token", lambda: (_ for _ in ()).throw(RuntimeError("no identity")))
    assert voice.post().status_code == 502


def test_a_busy_speech_slot_answers_503(voice, monkeypatch):
    monkeypatch.setattr(speech, "WAIT_S", 0.01)
    assert api._speech_slot.acquire(timeout=1)
    try:
        assert voice.post().status_code == 503
    finally:
        api._speech_slot.release()
    assert api._voice_sent["all"] == 0  # a clip that never reached Speech is not counted


# --- speech.transcribe against a stand-in for the REST API for short audio ---

def reply(monkeypatch, status=200, body=None):
    sent = {}

    def post(url, **kw):
        sent.update(url=url, **kw)
        return httpx.Response(status, json=body or {}, request=httpx.Request("POST", url))
    monkeypatch.setattr(speech, "ENDPOINT", "https://swedencentral.stt.speech.microsoft.com")
    monkeypatch.setattr(speech, "RESOURCE_ID", RID)
    monkeypatch.setattr(speech.httpx, "post", post)
    return sent


@pytest.mark.parametrize("lang, locale", [("en", "en-US"), ("it", "it-IT"), ("es", "es-ES")])
def test_transcribe_sends_the_language_the_entra_token_and_the_format(monkeypatch, lang, locale):
    sent = reply(monkeypatch, body={"RecognitionStatus": "Success", "DisplayText": "Chi ha segnato?"})
    assert speech.transcribe(b"audio", lang, "tok") == "Chi ha segnato?"
    assert sent["url"] == "https://swedencentral.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1"
    assert sent["params"]["language"] == locale
    assert sent["headers"]["Authorization"] == f"Bearer aad#{RID}#tok"
    assert sent["headers"]["Content-Type"] == "audio/wav; codecs=audio/pcm; samplerate=16000"
    assert sent["content"] == b"audio"


@pytest.mark.parametrize("status", ["NoMatch", "InitialSilenceTimeout", "BabbleTimeout"])
def test_transcribe_nothing_heard_is_empty(monkeypatch, status):
    reply(monkeypatch, body={"RecognitionStatus": status})
    assert speech.transcribe(b"a", "en", "t") == ""


def test_transcribe_raises_on_errors(monkeypatch):
    reply(monkeypatch, body={"RecognitionStatus": "Error"})
    with pytest.raises(RuntimeError):
        speech.transcribe(b"a", "en", "t")
    reply(monkeypatch, status=401)
    with pytest.raises(httpx.HTTPStatusError):
        speech.transcribe(b"a", "en", "t")


def test_wav_problem():
    assert speech.wav_problem(wav()) is None
    assert speech.wav_problem(wav(seconds=10.5)) is None
    assert "long" in speech.wav_problem(wav(seconds=10.6))
    assert "16-bit" in speech.wav_problem(wav(width=1))


def test_transcribe_tries_again_when_speech_is_busy(monkeypatch):
    statuses, slept = [429, 429, 200], []
    reply(monkeypatch)

    def post(url, **kw):
        status = statuses.pop(0)
        return httpx.Response(status, json={"RecognitionStatus": "Success", "DisplayText": "Who scored?"},
                              request=httpx.Request("POST", url))
    monkeypatch.setattr(speech.httpx, "post", post)
    monkeypatch.setattr(speech.time, "sleep", slept.append)
    assert speech.transcribe(b"audio", "en", "tok") == "Who scored?"
    assert slept == [1.0, 2.0]
    statuses[:] = [429, 429, 429]
    with pytest.raises(httpx.HTTPStatusError):  # busy three times: the route answers 502 as before
        speech.transcribe(b"audio", "en", "tok")
