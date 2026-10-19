import json
import xml.etree.ElementTree as ET

import pytest

from studiodesk import voice


def story(sid, text, kind="goal", verifier="pass", status="auto_approved", safety="not_checked"):
    return {"story_id": sid, "kind": kind, "ts": 1.0, "default_status": status, "safety": safety,
            "verifier": {"status": verifier, "attempts": 1, "flagged": []}, "texts": {"en": text, "it": "x"}}


class Fake:
    """Fake transport and clock: records requests, never touches the network."""

    def __init__(self, replies=None):
        self.now, self.calls, self.sleeps, self.replies = 0.0, [], [], list(replies or [])

    def clock(self):
        return self.now

    def sleep(self, s):
        self.sleeps.append(s)
        self.now += s

    def post(self, url, headers, body):
        assert url == voice.ENDPOINT and headers["Ocp-Apim-Subscription-Key"] == "k"
        self.calls.append((self.now, body.decode()))
        self.now += 0.5  # synthesis time
        return self.replies.pop(0) if self.replies else (200, {}, b"\xff" * 6000)  # 1 s at 48 kbps


def run(tmp_path, stories, fake, **kw):
    src = tmp_path / "src"
    src.mkdir(exist_ok=True)
    (src / "stories.json").write_text(json.dumps(stories))
    synth = voice.Synth("k", post=fake.post, clock=fake.clock, sleep=fake.sleep)
    return voice.build("M001", src=src, out=tmp_path / "out", synth=synth, log=lambda *_: None, **kw)


def test_manifest_and_only_eligible(tmp_path):
    stories = [story("S-000001", "Goal at 10."), story("S-000002", "Held but verified.", status="needs_review", verifier="template"),
               story("S-000003", "Failed check.", verifier="failed"), story("S-000004", "Flagged.", safety="flagged"),
               story("S-000005", "Recap.", kind="recap", verifier="rewritten"), story("S-000006", "Rejected.", status="rejected")]
    fake = Fake()
    rows = run(tmp_path, stories, fake)
    assert [r["story_id"] for r in rows] == ["S-000001", "S-000002", "S-000005"]
    manifest = json.loads((tmp_path / "out" / "voice.json").read_text())
    assert manifest == rows
    r = manifest[0]
    assert set(r) == {"story_id", "lang", "file", "duration_s", "text_sha1", "voice"}
    assert r["file"] == "voice/S-000001.en.mp3" and (tmp_path / "out" / r["file"]).stat().st_size == 6000
    assert r["duration_s"] == 1.0 and r["text_sha1"] == voice.sha1("Goal at 10.") and r["voice"] == voice.VOICES["en"]["voice"]
    assert manifest[2]["voice"] == voice.VOICES["en"]["voice"]


def test_unchanged_text_is_skipped(tmp_path):
    stories = [story("S-000001", "Goal at 10."), story("S-000002", "Another line.")]
    run(tmp_path, stories, Fake())
    fake = Fake()
    run(tmp_path, stories, fake)
    assert fake.calls == []
    stories[1]["texts"]["en"] = "Another line, edited by a rerun of the agents."
    stories.pop(0)  # a story that left the replay loses its clip
    fake = Fake()
    rows = run(tmp_path, stories, fake)
    assert len(fake.calls) == 1 and [r["story_id"] for r in rows] == ["S-000002"]
    assert not (tmp_path / "out" / "voice" / "S-000001.en.mp3").exists()


def test_rate_limit_pauses(tmp_path):
    stories = [story(f"S-00000{i}", f"Line {i}.") for i in range(1, 5)]
    fake = Fake(replies=[(200, {}, b"\xff" * 6000), (429, {"Retry-After": "7"}, b"")])
    run(tmp_path, stories, fake)
    starts = [t for t, _ in fake.calls]
    assert len(starts) == 5  # one retry after the 429
    assert all(b - a >= voice.MIN_INTERVAL_S - 1e-9 for a, b in zip(starts, starts[1:]))
    assert 7.0 in fake.sleeps and voice.MIN_INTERVAL_S * 20 >= 60  # spacing alone keeps under 20 a minute


def test_ssml_escaped():
    s = story("S-000001", "Kim & Lee <score> 2-0 at 47', press 6.1/10, ran 6022.8 m")
    name, doc = voice.ssml(s, "en")
    root = ET.fromstring(doc)  # well-formed despite & and <
    text = "".join(root.itertext())
    assert "Kim & Lee <score> two-nil at minute 47, press 6.1 out of 10, ran 6022.8 metres" == text
    assert name == "en-US-Ava:DragonHDLatestNeural" and "express-as" not in doc  # HD voices take no styles


def test_dry_run_and_unknown_lang(tmp_path):
    fake = Fake()
    assert run(tmp_path, [story("S-000001", "Goal.")], fake, dry_run=True) == []
    assert fake.calls == [] and not (tmp_path / "out" / "voice.json").exists()
    with pytest.raises(SystemExit):
        run(tmp_path, [story("S-000001", "Goal.")], fake, lang="it")


def test_http_error_stops(tmp_path):
    with pytest.raises(RuntimeError, match="401"):
        run(tmp_path, [story("S-000001", "Goal.")], Fake(replies=[(401, {}, b"denied")]))
