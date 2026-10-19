"""Content Safety step, offline: a fake analyzer and a fake HTTP endpoint (no Azure from tests)."""
import io
import json
import time
import urllib.error

from studiodesk import db
from studiodesk.agents import safety


def runtime_with(tmp_path, n):
    rt = db.connect(tmp_path / "rt.sqlite")
    for i in range(1, n + 1):
        db.insert(rt, "stories", {"match_id": "M001", "story_id": f"S-{i:06d}", "ts": float(i), "kind": "goal",
                                  "risk": 0.1, "default_status": "auto_approved", "fact_ids": [], "evidence_event_ids": [],
                                  "analysis_en": "", "texts": {"en": f"en {i}", "it": f"it {i}", "es": f"es {i}"},
                                  "verifier": {"status": "pass", "attempts": 1, "flagged": []}, "run_id": "R"})
    rt.commit()
    return rt


def test_one_call_per_story_flags_severity_two_and_caps_the_calls(tmp_path):
    rt = runtime_with(tmp_path, 5)
    sent = []

    def analyze(text):
        sent.append(text)
        if "en 2" in text:
            return {"Hate": 0, "Violence": 2}
        if "en 3" in text:
            raise RuntimeError("quota")
        return {"Hate": 1, "Violence": 0}

    counts = safety.check_match(rt, "M001", analyze, max_calls=4, log=lambda *_: None)
    got = dict(rt.execute("SELECT story_id, safety FROM stories ORDER BY ts").fetchall())
    assert got == {"S-000001": "passed", "S-000002": "flagged", "S-000003": "not_checked", "S-000004": "passed",
                   "S-000005": "not_checked"}
    assert counts == {"passed": 2, "flagged": 1, "not_checked": 2, "calls": 4}
    assert sent[0] == "en 1\nit 1\nes 1"  # the three languages in one call
    rt.close()


class Token:
    token, expires_on = "tok", time.time() + 3600


def test_azure_request_shape_and_key_fallback(monkeypatch):
    reqs = []

    def urlopen(req, timeout):
        reqs.append(req)
        if req.get_header("Authorization"):
            raise urllib.error.HTTPError(req.full_url, 403, "no role", {}, None)
        return io.BytesIO(json.dumps({"categoriesAnalysis": [{"category": "Hate", "severity": 0},
                                                             {"category": "Violence", "severity": 4}]}).encode())

    monkeypatch.setattr(safety.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(safety, "_az", lambda *a: "k3y" if "keys" in a else "https://x.example/")
    monkeypatch.setattr(safety, "MIN_INTERVAL_S", 0.0)
    monkeypatch.delenv("AZURE_CONTENT_SAFETY_ENDPOINT", raising=False)  # the endpoint must come from az here
    s = safety.AzureSafety()
    s.credential = type("Cred", (), {"get_token": lambda self, scope: Token()})()
    assert s("a line") == {"Hate": 0, "Violence": 4} and safety.verdict(s("a line")) == "flagged"
    assert reqs[0].full_url == "https://x.example/contentsafety/text:analyze?api-version=2024-09-01"
    assert reqs[0].get_header("Authorization") == "Bearer tok"  # Entra ID first
    assert reqs[1].get_header("Ocp-apim-subscription-key") == "k3y"  # then the key, from az, in memory
    assert json.loads(reqs[1].data)["text"] == "a line"


def test_flagged_story_goes_to_review_and_empty_or_failing_checks_stay_unchecked(tmp_path):
    rt = runtime_with(tmp_path, 7)
    rt.execute("UPDATE stories SET texts = ? WHERE story_id = 'S-000002'", (json.dumps({"en": " ", "it": "", "es": ""}),))
    rt.commit()
    sent = []

    def analyze(text):
        sent.append(text)
        if "en 1" in text:
            return {"Violence": 4}
        if "en 3" in text:
            return {}  # no categoriesAnalysis
        raise RuntimeError("down")

    counts = safety.check_match(rt, "M001", analyze, log=lambda *_: None)
    got = [tuple(r) for r in rt.execute("SELECT story_id, safety, default_status FROM stories ORDER BY ts")]
    assert got[0] == ("S-000001", "flagged", "needs_review")
    # not checked is not passed: nothing goes on air by itself
    assert [r[1] for r in got[1:]] == ["not_checked"] * 6 and all(r[2] == "needs_review" for r in got[1:])
    assert len(sent) == 1 + 1 + safety.MAX_FAILURES  # nothing for the empty story, then it stops after 3 failures
    assert counts == {"flagged": 1, "not_checked": 6, "calls": 5}
    rt.close()


def test_only_a_passed_story_keeps_the_status_its_risk_gives_and_the_analysis_is_checked(tmp_path):
    rt = runtime_with(tmp_path, 2)
    rt.execute("UPDATE stories SET risk = 0.6, default_status = 'needs_review' WHERE story_id = 'S-000002'")
    rt.execute("UPDATE stories SET analysis_en = 'why it matters' WHERE story_id = 'S-000001'")
    rt.commit()
    sent = []
    safety.check_match(rt, "M001", lambda text: sent.append(text) or {"Hate": 0}, log=lambda *_: None)
    got = dict(rt.execute("SELECT story_id, default_status FROM stories").fetchall())
    assert got == {"S-000001": "auto_approved", "S-000002": "needs_review"}
    assert sent[0] == "en 1\nit 1\nes 1\nwhy it matters"
    rt.close()


def test_the_cap_counts_http_requests_and_the_deadline_stops_the_step(tmp_path):
    rt = runtime_with(tmp_path, 3)

    class Analyzer:
        requests = 0

        def __call__(self, text):
            self.requests += 2  # token refused, then the key
            return {"Hate": 0}

    assert safety.check_match(rt, "M001", Analyzer(), max_calls=4, log=lambda *_: None) == \
        {"passed": 2, "not_checked": 1, "calls": 2}
    assert safety.check_match(rt, "M001", Analyzer(), deadline_s=0, log=lambda *_: None) == {"not_checked": 3, "calls": 0}
    rt.close()
