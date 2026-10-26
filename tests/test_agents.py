"""Agents workflow, offline: a fake chat client stands in for gpt-5-mini (no Azure from tests)."""
import asyncio
import json
from collections import Counter
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_export import PAYLOAD_KEYS

from studiodesk import config, db
from studiodesk import mcp_server as srv
from studiodesk.agents import phrasebook, rules, workflow
from studiodesk.agents.llm import FakeChatClient, cost_usd
from studiodesk.export import export

ROOT = Path(__file__).resolve().parent.parent
AGENTS = ["story_finder", "director", "analyst", "commentator_en", "commentator_it", "commentator_es", "verifier"]


@pytest.fixture
def desk_db(match_db, monkeypatch, tmp_path):
    info, conn = match_db
    monkeypatch.setattr(srv, "DB_PATH", info["path"])
    rt = db.connect(tmp_path / "runtime.sqlite")
    yield info, conn, rt
    rt.close()
    srv.set_clock(None)


def run(rt, client, **kw):
    return asyncio.run(workflow.run_match("M001", client, rt, log=lambda *_: None, **kw))


def rows(rt, table):
    return [dict(r) for r in rt.execute(f"SELECT * FROM {table} ORDER BY rowid")]


def stories(rt):
    out = rows(rt, "stories")
    for s in out:
        for c in ("texts", "verifier", "fact_ids"):
            s[c] = json.loads(s[c])
    return out


# --- verifier rules ------------------------------------------------------------------------------

FACTS = [{"fact_id": "F-SHOT_SPEED-000001", "kind": "shot_speed", "value": 92.3, "unit": "km/h",
          "label_en": "Shot at 92.3 km/h", "period": 2},
         {"fact_id": "F-LINE_HEIGHT-000001", "kind": "line_height", "value": 31.2, "unit": "m",
          "label_en": "Defensive line 31.2 m from goal, min 51-55", "period": 2}]
ALLOWED = rules.allowed_numbers(FACTS, minutes=[(52, 2)])


def test_verifier_passes_ledger_numbers_with_rounding_and_units():
    assert rules.check_text("In minute 52 a shot at 92 km/h [F-SHOT_SPEED-000001].", ALLOWED, "en", {"F-SHOT_SPEED-000001"}) == []
    assert rules.check_text("Linea difensiva a 31,2 metri dalla porta al 52'.", ALLOWED) == []
    assert rules.check_text("Disparo a 92.3 km/h, línea a 31 m.", ALLOWED) == []


def test_verifier_catches_wrong_number_unit_mismatch_and_real_name():
    assert rules.check_text("A shot at 97 km/h.", ALLOWED) == ["number not in the facts: '97 km/h'"]
    assert rules.check_text("The line moved to 92.3 m.", ALLOWED)[0].startswith("unit mismatch")
    assert rules.check_text("Harry Kane hits it at 92.3 km/h.", ALLOWED) == ["forbidden name (real person or club)"]  # never the name


def test_on_screen_text_has_no_dashes():
    assert rules.tidy("Minute 50 \u2014 a strike at 96 km/h \u2013 2\u20131.") == "Minute 50, a strike at 96 km/h, 2-1."


def test_risk_maps_to_default_status():
    assert rules.default_status(config.AUTO_APPROVE_RISK - 0.01) == "auto_approved"
    assert rules.default_status(config.AUTO_APPROVE_RISK) == "needs_review"
    clean = {"verifier": {"status": "pass"}, "confidence": 0.9, "fact_ids": ["F-1"], "player_id": None}
    assert rules.default_status(rules.risk(clean)) == "auto_approved"
    assert rules.default_status(rules.risk({**clean, "verifier": {"status": "template"}})) == "needs_review"
    # a half-time or full-time card the code wrote from the facts still airs
    assert rules.default_status(rules.risk({**clean, "kind": "recap", "verifier": {"status": "template"}})) == "auto_approved"
    assert rules.default_status(rules.risk({**clean, "fact_ids": []})) == "needs_review"
    assert 0 <= rules.risk({**clean, "verifier": {"status": "template"}, "fact_ids": [], "confidence": 0}) <= 1
    # phrasebook text on air: a fact airs by itself, a reading of the game waits for a person
    phrase = {**clean, "verifier": {"status": "pass", "on_air": "phrasebook"}, "player_id": "T01-9"}
    assert rules.default_status(rules.risk({**phrase, "kind": "goal"})) == "auto_approved"
    assert rules.default_status(rules.risk({**phrase, "kind": "big_chance"})) == "needs_review"
    assert rules.default_status(rules.risk({**phrase, "kind": "tactical_shift", "player_id": None})) == "needs_review"
    assert rules.default_status(rules.risk({**phrase, "kind": "goal", "fact_ids": []})) == "needs_review"
    # the code's template on air: a reading of the game still waits, even with a clean verdict
    assert rules.default_status(rules.risk({**clean, "kind": "tactical_shift"})) == "needs_review"
    assert rules.default_status(rules.risk({**clean, "kind": "goal"})) == "auto_approved"


def test_cost_from_tokens():
    usage = {"input_token_count": 1_000_000, "cache_read_input_token_count": 200_000, "output_token_count": 100_000}
    assert cost_usd(usage) == pytest.approx(0.8 * 0.25 + 0.2 * 0.025 + 0.1 * 2.00)


# --- the workflow on the fixture match -----------------------------------------------------------

def test_run_writes_stories_cues_traces_and_audit(desk_db):
    _, _, rt = desk_db
    fake = FakeChatClient()
    summary = run(rt, fake)
    st = stories(rt)
    assert summary["stories"] == len(st) and {"goal", "recap"} <= {s["kind"] for s in st}
    for s in st:
        assert set(s["texts"]) == {"en", "it", "es"} and all(s["texts"].values())
        v = s["verifier"]
        assert v["status"] == "pass" and v["on_air"] == "phrasebook" and set(v["proposals"]) == set(s["texts"]), (s["texts"], v)
        assert set(v) == {"status", "attempts", "flagged", "on_air", "opener", "proposals", "analysis_judged"}
        assert s["default_status"] == "needs_review" and s["safety"] == "not_checked" and s["fact_ids"]  # no Content Safety yet
    # one trace per hand-off, in workflow order, for every batch
    tr = rows(rt, "traces")
    assert [t["seq"] for t in tr] == list(range(1, len(tr) + 1))
    batches = [tr[i:i + len(AGENTS)] for i in range(0, len(tr), len(AGENTS))]
    assert batches and all([t["agent"] for t in b] == AGENTS for b in batches)
    # one audit row per model call, actor = agent name, cost from tokens
    au = rows(rt, "audit")
    assert len(au) == len(fake.calls) == summary["model_calls"]
    assert {a["actor"] for a in au} == set(AGENTS) - {"director"}
    assert sum(a["cost_usd"] for a in au) == pytest.approx(summary["cost_usd"], abs=1e-4)


@pytest.mark.parametrize("off_schema", [None, "Analyses", "Lines", "Verdicts"])
def test_traces_carry_only_their_own_calls(desk_db, off_schema):
    _, _, rt = desk_db
    # the delay lets the three commentators' calls overlap; an answer off the schema fails its step after the call was paid
    run(rt, FakeChatClient(lambda schema, _: {"nope": 1} if schema == off_schema else None, delay_s=0.002))
    assert off_schema is None or any(w in t["output_summary"] for w in ("fallback", "failed", "not judged")
                                     for t in rows(rt, "traces"))
    tr, au = rows(rt, "traces"), rows(rt, "audit")
    for k in ("tokens_in", "tokens_out"):
        assert sum(t[k] for t in tr) == sum(a[k] for a in au)


def test_storylines_are_never_read(desk_db, monkeypatch):
    _, _, rt = desk_db
    seen = []
    real = db.connect

    def watched(*a, **kw):
        conn = real(*a, **kw)
        conn.set_authorizer(lambda op, t, *_: seen.append(t) or 0)
        return conn

    monkeypatch.setattr(db, "connect", watched)
    run(rt, FakeChatClient())
    assert "facts" in seen and "storylines" not in seen
    for path in [ROOT / "studiodesk" / "mcp_server.py", *(ROOT / "studiodesk" / "agents").glob("*.py")]:
        assert "storylines" not in path.read_text(), path


def test_rewrites_at_most_twice_then_template(desk_db):
    _, _, rt = desk_db
    fake = FakeChatClient(lambda schema, p: {"lines": [{"story_id": s["story_id"], "text": "Minuto 1: 999 km/h."}
                                                       for s in p["stories"]]}
                          if schema == "Lines" and p["language"] == "it" else None)
    run(rt, fake)
    it_calls = sum(1 for schema, p in fake.calls if schema == "Lines" and p["language"] == "it")
    finder_calls = sum(1 for schema, _ in fake.calls if schema == "Picks")
    assert it_calls == (1 + config.MAX_REWRITES) * finder_calls
    for s in stories(rt):
        assert s["verifier"]["status"] == "template" and s["verifier"]["attempts"] == 1 + config.MAX_REWRITES
        assert "999" not in s["texts"]["it"]  # and English, though fine, is the template too: one story in all three
        assert s["verifier"]["flagged"] == ["Italian draft not used: a number the facts do not give."]
        assert "proposals" not in s["verifier"]  # a draft that failed is no proposal, in any language
        assert s["verifier"]["on_air"] == "phrasebook" and rules.default_status(s["risk"]) == "auto_approved"


def test_one_rewrite_fixes_it_and_passed_texts_are_judged_once(desk_db):
    _, _, rt = desk_db
    fake = FakeChatClient(lambda schema, p: {"lines": [{"story_id": s["story_id"], "text": "Gol a 999 km/h."}
                                                       for s in p["stories"]]}
                          if schema == "Lines" and p["language"] == "es" and "feedback" not in p else None)
    run(rt, fake)
    for s in stories(rt):
        assert s["verifier"]["status"] == "rewritten" and s["verifier"]["attempts"] == 2
        assert "999" not in s["texts"]["es"]
    judged = Counter((t["story_id"], t["lang"]) for schema, p in fake.calls if schema == "Verdicts" for t in p["texts"])
    assert judged and set(judged.values()) == {1}  # en and it are not judged again in the rewrite round


def test_judge_flags_claims_without_numbers(desk_db):
    _, _, rt = desk_db
    calls = []

    def judge(schema, p):
        if schema == "Verdicts":
            calls.append(p)
            return {"verdicts": [{"story_id": t["story_id"], "lang": t["lang"], "ok": t["lang"] != "en",
                                  "issue": "invented claim"} for t in p["texts"]]}
        return None

    run(rt, FakeChatClient(judge))
    assert calls and all(s["verifier"]["status"] == "template" for s in stories(rt))


@pytest.mark.parametrize("failing", ["Picks", "Analyses", "Lines", "Verdicts", "all", "timeout"])
def test_agent_failure_falls_back_and_never_blocks(desk_db, monkeypatch, failing):
    _, _, rt = desk_db

    def responder(schema, p):
        if failing in (schema, "all"):
            raise RuntimeError("model down")
        return None

    monkeypatch.setattr(workflow, "RETRY_PAUSES_S", (0.0, 0.0))
    if failing == "timeout":
        monkeypatch.setattr(config, "AGENT_TIMEOUT_S", 0.05)
        fake = FakeChatClient(delay_s=1.0)
    else:
        fake = FakeChatClient(responder)
    summary = run(rt, fake)
    st = stories(rt)
    assert {"goal", "recap"} <= {s["kind"] for s in st} and summary["cues"] > 0
    for s in st:
        assert set(s["texts"]) == {"en", "it", "es"} and all(s["texts"].values()) and s["analysis_en"]
        # the phrasebook line airs whatever the model did
        assert s["verifier"]["on_air"] == "phrasebook" and rules.default_status(s["risk"]) == "auto_approved"
        if failing in ("Lines", "all", "timeout"):
            assert s["verifier"]["status"] == "template" and "proposals" not in s["verifier"]
        if failing == "Verdicts":  # numbers checked, claims not judged: a proposal, never on air by itself
            assert s["verifier"]["status"] == "pass" and s["verifier"]["proposals"]
    tr = rows(rt, "traces")
    if failing != "Verdicts":
        assert any("fallback" in t["output_summary"] for t in tr)
    assert not any("Error" in t["output_summary"] or "model down" in t["output_summary"] for t in tr)
    if failing == "timeout":  # a call cut by the timeout is billed: it is in the audit, once per try
        cut = [a for a in rows(rt, "audit") if a["action"] == "model_call_timeout"]
        assert cut and all(a["tokens_in"] > 0 for a in cut) and len(cut) == summary["model_calls"]


def test_judge_with_missing_verdicts_leaves_a_proposal(desk_db):
    _, _, rt = desk_db
    run(rt, FakeChatClient(lambda schema, p: {"verdicts": []} if schema == "Verdicts" else None))
    st = stories(rt)
    # the judge no longer gates the air: the phrasebook line goes, the unjudged lines wait as a proposal
    assert st and all(s["verifier"]["on_air"] == "phrasebook" and s["verifier"]["proposals"] for s in st)


def test_a_judge_that_takes_its_issue_back_keeps_the_proposal(desk_db):
    _, _, rt = desk_db

    def judge(schema, p):
        if schema == "Verdicts":
            return {"verdicts": [{"story_id": t["story_id"], "lang": t["lang"], "ok": False,
                                  "issue": "Says header; header is true, wait, so it is fine."} for t in p["texts"]]}

    run(rt, FakeChatClient(judge))
    st = stories(rt)
    assert any(s["verifier"]["status"] == "pass" for s in st)  # not sent to the template for a non-issue


def test_the_finder_chooses_tone_and_focus_and_a_wrong_choice_is_dropped(desk_db):
    _, _, rt = desk_db
    seen = []

    def finder(schema, p):
        if schema == "Picks":
            seen.extend(p["candidates"])
            return {"picks": [{"candidate_id": c["candidate_id"], "confidence": 0.9, "angle": c["note"],
                               "tone": "calm" if c["kind"] == "recap" else "shouting",
                               "focus": (c.get("focus_options") or [""])[0] if c["kind"] == "goal" else "nowhere"}
                              for c in p["candidates"]]}

    run(rt, FakeChatClient(finder))
    assert any(c.get("focus_options") for c in seen)  # the finder sees what it can choose from
    st = stories(rt)
    assert st and all(s["verifier"]["on_air"] == "phrasebook" for s in st)
    m = rules.Match(srv.get_match_info("M001"))
    m.facts = {f["fact_id"]: f for f in srv.get_facts("M001")}
    goal = rules.goal_candidates(m, m.kind("score")[0])[0]
    focus = phrasebook.focus_options(goal)[0]
    desk = SimpleNamespace(story_n=0)
    ok = workflow.Desk.new_story(desk, goal, 0.9, "angle", "calm", focus)
    bad = workflow.Desk.new_story(desk, goal, 0.9, "angle", "shouting", "nowhere")
    assert (ok["tone"], ok["focus"]) == ("calm", focus) and (bad["tone"], bad["focus"]) == (None, None)


def test_run_stops_calling_the_model_at_its_ceiling(desk_db, monkeypatch):
    _, _, rt = desk_db
    monkeypatch.setattr(config, "RUN_MAX_CALLS", 3)
    summary = run(rt, FakeChatClient())
    assert summary["model_calls"] == 3 and summary["stories"] > 0
    assert any("run budget reached" in t["output_summary"] for t in rows(rt, "traces"))
    assert all(s["verifier"]["on_air"] == "phrasebook" and "proposals" not in s["verifier"] for s in stories(rt))


def test_director_never_shows_more_than_two_graphics(desk_db):
    _, _, rt = desk_db
    m = rules.Match(srv.get_match_info("M001"))
    for f in srv.get_facts("M001"):
        m.facts[f["fact_id"]] = f
    goal = rules.goal_candidates(m, m.kind("score")[0])[0]
    crowd = [{**goal, "story_id": f"S-{i:06d}", "fact_ids": [f["fact_id"] for f in goal["facts"]],
              "texts": {lang: "text" for lang in rules.LANGS}} for i in range(6)]
    cues = rules.Director(m).plan(crowd, goal["ts"])
    run(rt, FakeChatClient())
    cues += [{**c, "audience": "run:" + c["audience"]} for c in rows(rt, "cues")]
    assert cues
    for key in {(c["audience"], c["lang"]) for c in cues}:
        mine = [c for c in cues if (c["audience"], c["lang"]) == key]
        for c in mine:
            assert sum(d["ts"] <= c["ts"] < d["ts"] + d["duration_s"] for d in mine) <= config.MAX_GRAPHICS_ON_SCREEN


def test_the_full_time_recap_airs_at_the_whistle(desk_db):
    m = rules.Match(srv.get_match_info("M001"))
    for f in srv.get_facts("M001"):
        m.facts[f["fact_id"]] = f
    end = max(f["ts"] for f in m.kind("momentum"))
    base = {"ts": end, "team_id": m.home["team_id"], "player_id": None, "facts": [], "fact_ids": [],
            "texts": {lang: "text" for lang in rules.LANGS}}
    for before in (0.0, 0.5, 2.0, 5.0, 30.0):
        stories = [{**base, "story_id": "S-000001", "kind": "momentum_swing", "ts": end - before},
                   {**base, "story_id": "S-000002", "kind": "recap", "phase": "ft", "team_id": None},
                   {**base, "story_id": "S-000003", "kind": "goal"}]  # a goal at the whistle is still told
        cues = rules.Director(m).plan(stories, end - before)
        by = {sid: [c for c in cues if c["story_id"] == sid] for sid in ("S-000001", "S-000002", "S-000003")}
        assert by["S-000002"] and all(c["ts"] == end for c in by["S-000002"]), before
        assert by["S-000003"], before
        assert all(c["ts"] + c["duration_s"] <= end for c in by["S-000001"]), before
        assert bool(by["S-000001"]) == (before == 30.0), before


def test_a_story_never_airs_before_the_desk_decided_on_it(desk_db):
    _, _, rt = desk_db
    m = rules.Match(srv.get_match_info("M001"))
    for f in srv.get_facts("M001"):
        m.facts[f["fact_id"]] = f
    goal = rules.goal_candidates(m, m.kind("score")[0])[0]
    story = {**goal, "story_id": "S-000001", "fact_ids": [f["fact_id"] for f in goal["facts"]],
             "texts": {lang: "text" for lang in rules.LANGS}}
    cues = rules.Director(m).plan([story], goal["ts"] + 6.0)
    assert cues and min(c["ts"] for c in cues) == goal["ts"] + 6.0
    # a story from before a whistle already planned is not told after it
    director, end = rules.Director(m), max(f["ts"] for f in m.kind("momentum"))
    recap = {**story, "story_id": "S-000002", "kind": "recap", "phase": "ft", "team_id": None, "player_id": None,
             "facts": [], "ts": end}
    assert director.plan([recap], end)
    assert director.plan([{**story, "kind": "top_sprint", "ts": end - 3.0}], end + 2.0) == []
    # the whole workflow: every story cue starts at or after the desk's first trace of that story
    run(rt, FakeChatClient())
    first = {}
    for t in rows(rt, "traces"):
        for sid in json.loads(t["story_ids"] or "[]"):
            first.setdefault(sid, t["ts"])
    told = [c for c in rows(rt, "cues") if c["story_id"]]
    assert told and all(c["ts"] >= first[c["story_id"]] for c in told)


def test_big_chances_are_judged_per_shot_at_most_two_a_window():
    m = rules.Match(INFO)
    shots = []
    for n, (ts, kmh) in enumerate(((100.0, 101.0), (110.0, 105.0), (120.0, 102.0), (130.0, 80.0), (310.0, 103.0)), 1):
        m.facts[f"s{n}"] = fact("shot_speed", n, ts, kmh, "km/h", f"Shot at {kmh:.0f} km/h", period=1)
        shots.append({"event_id": n, "ts": ts, "period": 1, "player_id": "T01-9", "type_name": "shot",
                      "result_name": "fail", "bodypart_name": "foot", "start_x": 90.0, "start_y": 34.0,
                      "end_x": 100.0, "end_y": 30.0})
    offered = {}
    first = rules.chance_candidates(m, shots[:1], (), offered)  # judged alone, as the poll after it sees it
    rest = rules.chance_candidates(m, shots[1:], [{"ts": 120.5, "related_player_id": "T01-9"}], offered)
    assert [c["ts"] for c in first + rest] == [100.0, 110.0, 310.0]  # the third one of minutes 1-5 waits out
    assert [c["outcome"] for c in first + rest] == ["blocked", "blocked", "blocked"]
    assert rules.chance_candidates(m, shots[2:3], [{"ts": 120.5, "related_player_id": "T01-9"}])[0]["outcome"] == "saved"
    assert rules.SETTLE_S >= 5.0  # a save counts within 5 s of the shot (facts.engine.shot_outcome)


def test_the_story_finder_skips_what_the_whistle_would_cut():
    cands = [{"kind": "momentum_swing", "ts": 2990.0}, {"kind": "goal", "ts": 2995.0}, {"kind": "big_chance", "ts": 2900.0},
             {"kind": "recap", "ts": 3000.0}]
    assert [c["kind"] for c in rules.before_the_whistle(cands)] == ["goal", "big_chance", "recap"]
    assert rules.before_the_whistle(cands[:3]) == cands[:3]  # no recap in the batch: nothing to protect


def test_export_uses_runtime_records_with_contract_shapes(desk_db, tmp_path):
    _, conn, rt = desk_db
    run(rt, FakeChatClient())
    out = export("M001", conn, tmp_path / "web", rt)
    st, cues, tr = (json.loads((out / f"{n}.json").read_text()) for n in ("stories", "cues", "traces"))
    fact_ids = {f["fact_id"] for f in json.loads((out / "facts.json").read_text())}
    assert st and cues and tr
    for rows_ in (st, cues, tr):
        assert [r["ts"] for r in rows_] == sorted(r["ts"] for r in rows_)
    for s in st:
        assert set(s["texts"]) == {"en", "it", "es"} and set(s["fact_ids"]) <= fact_ids
    assert {c["lang"] for c in cues} == {"en", "it", "es"} and {"analyst", "casual"} <= {c["audience"] for c in cues}
    for c in cues:
        assert set(c["payload"]) - {"filler"} == PAYLOAD_KEYS[c["graphic"]]  # a filler adds its marker
        assert set(c["payload"].get("fact_ids") or [c["payload"]["fact_id"]]) <= fact_ids
        assert c["audience"] in ("analyst", "casual", "kids") or c["audience"].split(":")[0] in ("team", "player")
    assert all(isinstance(t["fact_ids"], list) for t in tr)


def test_agents_reach_the_match_through_mcp_tools(desk_db):
    _, _, rt = desk_db
    fact = srv.get_facts("M001", kind="score")[0]

    def responder(schema, p):
        if schema == "Analyses":
            return {"tool_call": {"name": "get_fact", "arguments": {"match_id": "M001", "fact_id": fact["fact_id"]}}}
        return None

    fake = FakeChatClient(responder)
    run(rt, fake)
    got = [str(r) for r in fake.tool_results if fact["fact_id"] in str(r)]
    assert any('"label_en": "Goal 1-0"' in r for r in got)
    assert any("no fact" in r for r in got)  # asked before the goal: the MCP clock hides the future

    async def tool_names():
        async with workflow.mcp_session() as session:
            tool = workflow.InProcessMCPTool(name="studiodesk", session=session, load_prompts=False,
                                             allowed_tools=workflow.AGENT_TOOLS["analyst"])
            await tool.connect()
            return sorted(f.name for f in tool.functions)

    assert asyncio.run(tool_names()) == sorted(workflow.AGENT_TOOLS["analyst"])


def test_window_run_only_sees_its_window(desk_db):
    _, _, rt = desk_db
    run(rt, FakeChatClient(), from_ts=0, to_ts=185)  # past half-time (180 s), before the goal at about 195 s
    kinds = {s["kind"] for s in stories(rt)}
    assert "recap" in kinds and "goal" not in kinds
    assert all(t["ts"] <= 185 for t in rows(rt, "traces"))


# --- text quality, verifier notes, the judge -------------------------------------------------------

BEFORE = [  # lines from the first real run on M001, each with something a TV commentator would not do
    ("en", "big_chance", "Very close-range chance from very close range but a relatively soft effort at 67 km/h in "
                         "minute 26. Redwick Wanderers lead 2-0."),
    ("en", "goal", "Hugo Okowande puts Redwick Wanderers 2-0 up at 13 with a 96 km/h strike. Redwick Wanderers lead 2-0."),
]
GOOD = [
    ("en", "goal", "Okowande rifles it in at 96 km/h and Redwick Wanderers lead 2-0."),
    ("it", "goal", "Kimura accorcia con un destro a 96 km/h: 2-1."),
    ("es", "tactical_shift", "Redwick Wanderers pasa del 4-3-3 al 4-4-2 para cerrar el centro."),
    ("en", "momentum_swing", "Ostwick FC have taken over in the last ten minutes, momentum 6.8/10."),
    ("en", "recap", "Half-time at the Old Mill: Redwick Wanderers lead 2-1. Ostwick FC were tidier on the ball, "
                    "81% of passes completed."),
]
FIRST_RUN_ISSUES = [  # what the judge said about true lines in the first run
    "Says \"Redwick Wanderers lead 2-1.\" After the goal by Ostwick FC the score is Redwick Wanderers 2, Ostwick FC 1 "
    "\u2014 saying Redwick lead is correct, but phrasing could imply they still lead unchanged; however the claim is "
    "factually correct. The actual issue: none.",
    "Claim 'Redwick Wanderers lead 2-1 after the goal.' is redundant/misleading: score after is Redwick Wanderers 2, "
    "Ostwick FC 1, so phrasing is correct but repetitive. No factual error. (Remove this issue if strict.)",
    "claim: Says 'grande occasione' (big chance), claims an event size; but facts label is big_chance so that's okay.",
    "claim: Text implies 'golazo' is stylistic but acceptable; however it doesn't name minute, that's fine.",
]


def test_style_check_catches_robotic_lines():
    issues = [rules.style_issues(t, lang, kind) for lang, kind, t in BEFORE]
    assert any("not the point of a big chance" in i for i in issues[0])
    assert any("repeated words (close, range, very)" in i for i in issues[0])
    assert any("score said 2 times" in i for i in issues[1]) and any("redwick" in i for i in issues[1])
    assert [rules.style_issues(t, lang, kind) for lang, kind, t in GOOD] == [[]] * len(GOOD)
    # minute ranges and formations are not scores
    assert rules.score_mentions("Line at 31 m, min 41-45, from 4-3-3 to 4-4-2, now 2-1.") == ["2-1"]


def test_agent_strings_are_tidy_and_notes_short():
    assert rules.tidy("Goal\x07 \u200bfor Redwick \u2014 2\u20131\n") == "Goal for Redwick, 2-1"
    for issue in FIRST_RUN_ISSUES:
        n = rules.note(f"en: claim: {issue}")
        assert n.startswith("en: claim: ") and len(n) <= rules.NOTE_CHARS
        assert "\u2014" not in n and "\u2013" not in n and n.count(". ") == 0


INFO = {"teams": [{"team_id": "T01", "side": "home", "name": "Redwick Wanderers", "short_name": "RED"},
                  {"team_id": "T02", "side": "away", "name": "Ostwick FC", "short_name": "OST"}],
        "players": [], "period1_s": 2700.0}


def fact(kind, n, ts, value, unit, label, team="T01", period=2):
    return {"fact_id": f"F-{kind.upper()}-{n:06d}", "kind": kind, "ts": ts, "value": value, "unit": unit,
            "label_en": label, "team_id": team, "player_id": None, "period": period, "source_event_ids": [n]}


def test_judge_gets_the_score_in_words():
    m = rules.Match(INFO)
    for n, (ts, team) in enumerate([(600, "T01"), (1500, "T01"), (3100, "T02")], 1):
        m.facts[f"g{n}"] = fact("score", n, ts, 1, "goal", "Goal", team, 1 if ts < 2700 else 2)
    desk = workflow.Desk("M001", None, None, "R-test", "fake")
    desk.m = m
    assert desk.who_leads(3100) == "Redwick Wanderers lead 2-1" and desk.who_leads(3099.9) == "Redwick Wanderers lead 2-0"
    assert desk.who_leads(0) == "Level at 0-0"
    story = {"story_id": "S-000008", "kind": "goal", "minute": 50, "ts": 3100, "team_id": "T02", "player_id": None,
             "facts": [m.facts["g3"]], "analysis_en": ""}
    card = desk.card(story)
    assert (card["score_before"], card["score_after"]) == ("Redwick Wanderers lead 2-0", "Redwick Wanderers lead 2-1")
    assert (card["home"], card["away"], card["team_side"]) == ("Redwick Wanderers", "Ostwick FC", "away")
    assert desk.card(story, writer="en")["score"] == {"before": "Redwick Wanderers lead 2-0",
                                                     "after": "Redwick Wanderers lead 2-1", "write": "2-1",
                                                     "leader": "Redwick Wanderers"}
    assert "score" not in desk.card({**story, "kind": "big_chance"}, writer="en")
    it = desk.card(story, writer="it")  # Italian and Spanish writers get the clubs with their article
    assert (it["team"], it["home"], it["score"]["leader"]) == ("l'Ostwick FC", "il Redwick Wanderers", "il Redwick Wanderers")
    assert "score_say" not in card and it["score"]["write"] == "2-1"  # home goals first, the home side leads
    mom = [fact("momentum", 20 + k, 2700 + 300 * k, v, "/10", f"Momentum {v}/10") for k, v in enumerate((2.0, 3.1, 9.2, 6.7))]
    swing = {**story, "kind": "momentum_swing", "facts": mom, "ts": 3600}
    assert desk.card(swing, writer="es")["trend"] == \
        "sube de 2/10 en el minuto 46 a 9,2/10 en el 55 y luego baja a 6,7/10 en el 60"


NOT_A_NO_ISSUE = FIRST_RUN_ISSUES + [  # each names a real problem somewhere in the sentence
    "Says Ostwick FC lead, but Redwick Wanderers lead 2-1; the rest is fine.",
    "No factual issue with the score, but the goal was scored by Kimura, not Okowande.",
    "Wrong scorer named. Issue: none of the facts mention Okowande.",
    "Claims a header, but the shot was with the foot. Tone is acceptable.",
    "The text says Ostwick FC lead, but Redwick Wanderers lead 2-1.",
    "Calling the drive unstoppable is not fine.",
]


def test_only_a_bare_none_counts_as_the_judge_contradicting_itself():
    assert not any(rules.no_issue(i) for i in NOT_A_NO_ISSUE)
    assert all(rules.no_issue(i) for i in ("None", "none.", "N/A", "No issues found.", "ok"))


def test_a_true_score_line_passes_when_the_judge_contradicts_itself(desk_db):
    _, _, rt = desk_db
    seen = []

    def judge(schema, p):
        if schema == "Verdicts":
            seen.append(p)
            return {"verdicts": [{"story_id": t["story_id"], "lang": t["lang"], "ok": False,
                                  "issue": "None."} for t in p["texts"]]}
        return None

    run(rt, FakeChatClient(judge))
    assert seen and all(s["verifier"]["status"] == "pass" and not s["verifier"]["flagged"] for s in stories(rt))
    cards = [c for p in seen for c in p["stories"]]
    assert all({"score_before", "score_after", "home", "away"} <= set(c) for c in cards)
    assert any(c["kind"] == "goal" and c["score_after"].endswith("lead 1-0") for c in cards)


def test_style_goes_back_to_the_writer(desk_db):
    _, _, rt = desk_db
    feedback = []

    def writer(schema, p):
        if schema == "Lines" and p["language"] == "en":
            if "feedback" in p:
                feedback.append(p["feedback"])
                return None
            return {"lines": [{"story_id": s["story_id"], "text": f"Minute {s['minute']}: what a moment, what a moment, what a moment."}
                              for s in p["stories"]]}
        return None

    fake = FakeChatClient(writer)
    run(rt, fake)
    assert feedback and all("repeated words (moment)" in f for fb in feedback for f in fb.values())
    for s in stories(rt):
        assert s["verifier"]["status"] == "rewritten" and "what a moment" not in s["texts"]["en"]
        assert any(n.startswith("Earlier English draft:") and n.endswith("a word repeated.")
                   for n in s["verifier"]["flagged"])  # style leaves a plain note too
    for schema, p in fake.calls:
        if schema == "Lines":
            assert "recent_openings" in p
            for c in p["stories"]:
                assert c["numbers"] and ("score" in c) == (c["kind"] in rules.SCORE_KINDS)


def test_jargon_left_after_the_last_rewrite_falls_back_to_the_template(desk_db):
    _, _, rt = desk_db

    def writer(schema, p):
        if schema == "Lines" and p["language"] == "en":
            return {"lines": [{"story_id": s["story_id"], "text": f"Minute {s['minute']}: pressure on the carrier."}
                              for s in p["stories"]]}
        return None

    run(rt, FakeChatClient(writer))
    assert all(s["verifier"]["status"] == "template" and "carrier" not in s["texts"]["en"] for s in stories(rt))


def test_traces_name_their_stories(desk_db, tmp_path):
    _, conn, rt = desk_db
    run(rt, FakeChatClient())
    tr = rows(rt, "traces")
    for s in stories(rt):
        agents = {t["agent"] for t in tr if s["story_id"] in json.loads(t["story_ids"])}
        assert agents == set(AGENTS), s["story_id"]
    out = export("M001", conn, tmp_path / "web", rt)
    assert all(isinstance(t["story_ids"], list) for t in json.loads((out / "traces.json").read_text()))


def test_runtime_db_from_before_gets_story_ids(tmp_path):
    import sqlite3
    old = (ROOT / "studiodesk" / "schema.sql").read_text().split("CREATE TABLE IF NOT EXISTS traces")[1].split(";")[0]
    old = "CREATE TABLE traces" + "\n".join(x for x in old.splitlines() if "story_ids" not in x)
    with sqlite3.connect(tmp_path / "rt.sqlite") as c:
        c.execute(old)
        c.execute("INSERT INTO traces (match_id, run_id, seq, ts, at, agent, step, input_summary, output_summary) "
                  "VALUES ('M001', 'R', 1, 0, 'x', 'director', 'cue', '', '')")
    rt = db.connect(tmp_path / "rt.sqlite")
    assert rt.execute("SELECT story_ids FROM traces").fetchone()[0] == "[]"
    rt.close()


def test_tactical_shift_from_a_change_of_formation():
    m = rules.Match(INFO)
    shapes = {"T01": [433, 433, 433, 442, 442], "T02": [442] * 5}
    for tid, values in shapes.items():
        for k, v in enumerate(values, 1):
            ts = 2700 + 300 * (k + 1)
            name = rules.formation_name(v)
            m.facts[f"{tid}{k}"] = fact("formation", k + (10 if tid == "T02" else 0), ts, float(v), "formation",
                                        f"Formation {name}, min {45 + 5 * k + 1}-{50 + 5 * k}", tid)
    ends = sorted({f["ts"] for f in m.facts.values()})
    shifted, found = set(), []
    for w0, w in zip([2700] + ends, ends):
        found += [(w, c) for c in rules.window_candidates(m, w0, w, shifted)]
    assert [(w, c["team_id"], c["shape"]) for w, c in found] == [(ends[-1], "T01", ("4-3-3", "4-4-2"))]
    story = {**found[0][1], "minute": 75, "player_id": None}
    text = rules.template(m, story, "en")
    assert text == "Redwick Wanderers switch from 4-3-3 to 4-4-2." and not rules.check_text(text, rules.story_allowed(m, story))
    assert {"4-3-3", "4-4-2", "75th minute"} <= set(rules.number_list(m, story))
    assert "minuto 75" in rules.number_list(m, story, "it")
    assert rules.fmt(6.25, "es") == "6,2" and rules.fmt(96.0, "it") == "96"


def test_a_line_pushed_back_by_the_other_team_is_not_a_shift():
    m = rules.Match(INFO)
    lines = {"T01": [25, 25, 25, 36, 36], "T02": [30, 30, 30, 19, 19]}  # T01 push up, T02 only drops with it
    for tid, values in lines.items():
        for k, v in enumerate(values, 1):
            m.facts[f"{tid}{k}"] = fact("line_height", k + (10 if tid == "T02" else 0), 2700 + 300 * (k + 1),
                                        float(v), "m", f"Defensive line {v:.1f} m from goal", tid)
    w = 2700 + 300 * 6
    found = rules.window_candidates(m, w - 300, w, set())
    assert [(c["kind"], c["team_id"], c["note"]) for c in found] == [("tactical_shift", "T01", "line higher by 11 m")]


# --- review fixes: numbers the code could not see, claims the ledger contradicts -----------------

def test_numbers_in_words_glued_or_in_foreign_units_are_flagged():
    allowed = [(96.4, "speed"), (34.2, "speed"), (3.0, None)]
    for text, lang in [("Redwick lead by three goals after a hat-trick.", "en"), ("Tre gol in dieci minuti.", "it"),
                       ("ninety-six kilometres an hour", "en"), ("Novantasei all'ora", "it"), ("Veintiséis", "es"),
                       ("He hit it at 96kmh.", "en"), ("A sprint at 34 mph", "en"), ("3 goals now", "en")]:
        assert rules.check_text(text, allowed, lang), text
    assert rules.check_text("A 96 kilometres per hour drive, then a 34 km/h sprint in the 3rd minute.",
                            allowed + [(3.0, "minute")]) == []
    assert rules.check_text("Once more he tries.", allowed) == []  # "once" is eleven only in Spanish


def test_tidy_strips_invisible_format_characters_and_other_dashes():
    assert rules.tidy("a‮b⁦c­d⁠e ⸺ f tap‑in 1–2  x") == "abcde, f tap-in 1-2 x"
    assert rules.tidy("empate 2-2, minuto 81, .") == "empate 2-2, minuto 81."
    assert rules.tidy("Press up in the first-half stoppage time.") == "Press up in first-half stoppage time."
    assert rules.tidy("Saved in the 90+2'.") == "Saved at 90+2'."
    assert rules.jargon("Closing to 7.9 m to the carrier.") and not rules.jargon("Closing down fast.")


def test_football_words_are_not_numbers_and_english_in_other_languages_goes_back():
    assert rules.check_text("From the six-yard box into the final third.", [(3.0, None)]) == []
    assert rules.check_text("Six yards out.", [(3.0, None)])
    assert any("English" in i for i in rules.style_issues("Kimura da close-range, palla wide.", "it", "big_chance"))
    assert any("carrier" in i for i in rules.style_issues("Ostwick FC press high, errors around their carrier.",
                                                          "en", "pressing_spell"))
    assert not any("English" in i for i in rules.style_issues("Kimura da pochi passi, a lato.", "it", "big_chance"))


def test_glued_numbers_bare_ordinals_and_number_lists_are_caught():
    allowed = [(73.0, None), (2.0, None), (57.3, "speed"), (3.9, "m"), (17.0, None)]
    assert rules.check_text("He levels it at 73-2-2.", allowed)
    assert not any("garbled" in i for i in rules.check_text("They switch to a 4-2-3-1, then a 3-5-2.", allowed))
    issues = rules.style_issues("Haddad heads it and the keeper saves, 17th minute, 57.3 km/h, 3.9 m.", "en", "big_chance")
    assert any("without 'the'" in i for i in issues) and any("listed at the end" in i for i in issues)
    assert rules.style_issues("In the 17th minute Haddad heads it from 3.9 m and the keeper saves.", "en",
                              "big_chance") == []


def test_invented_details_and_a_lead_at_full_time_are_flagged():
    m = rules.Match(SIDES)
    m.facts["g"] = fact("score", 1, 2900, 1, "goal", "Goal 0-1", "T02")
    chance = _story(m, "big_chance", [], player="T01-9", outcome="saved")
    assert rules.story_issues(m, chance, "Okowande at the near post, saved.", "en") == ["detail not in the facts: 'near post'"]
    assert rules.story_issues(m, chance, "Okowande colpisce al volo, parata.", "it")
    assert rules.story_issues(m, chance, "Okowande hits the crossbar area, saved.", "en") == []
    ft = _story(m, "recap", [], team=None, phase="ft", ts=5600)
    assert rules.story_issues(m, ft, "Full time: Ostwick FC lead 1-0.", "en")
    assert rules.story_issues(m, ft, "Full time: Ostwick FC win 1-0 after Kimura gave them the lead.", "en") == []


def test_a_verdict_that_takes_itself_back_is_no_verdict():
    for issue in ("Text says header, but header is true, wait so OK.", "Calling them away is acceptable but...",
                  "No issue: the minute and goals match facts.", "it matches the facts"):
        assert rules.retracts(issue), issue
    for issue in ("The shot was saved, not a goal.", "Pass accuracy values are swapped between the teams."):
        assert not rules.retracts(issue), issue


def test_short_error_summaries():
    assert rules.brief_error(RuntimeError("ChatClientException: Error code: 429 - rate limit")) == "rate limited"
    assert rules.brief_error(asyncio.TimeoutError()) == "timed out"
    assert rules.brief_error(RuntimeError("run budget reached")) == "run budget reached"
    assert rules.brief_error(ValueError("boom")) == "model error"


SIDES = {**INFO, "players": [{"player_id": "T01-9", "name": "Hugo Okowande", "team_id": "T01"},
                             {"player_id": "T02-9", "name": "Tariq Kimura", "team_id": "T02"},
                             {"player_id": "T02-7", "name": "Ali Okowande", "team_id": "T02"}]}


def _story(m, kind, facts, team="T01", player=None, ts=3000.0, **extra):
    return {"kind": kind, "facts": facts, "team_id": team, "player_id": player, "ts": ts,
            "minute": rules.minute(ts, 2, m.p1), "fact_ids": [f["fact_id"] for f in facts], **extra}


def test_story_issues_catch_distance_possession_score_order_and_trend():
    m = rules.Match(SIDES)
    m.facts["g"] = fact("score", 1, 2900, 1, "goal", "Goal 0-1", "T02")
    shot = [fact("shot_speed", 2, 3000, 101.0, "km/h", "Shot at 101 km/h"),
            fact("shot_distance", 2, 3000, 8.6, "m", "Shot from 9 m")]
    chance = _story(m, "big_chance", shot, player="T01-9", outcome="saved")
    assert rules.story_issues(m, chance, "Okowande dal limite dell'area, 8,6 m.", "it")
    assert rules.story_issues(m, chance, "Hugo Okowande from distance, saved.", "en")
    assert rules.story_issues(m, chance, "Hugo Okowande from close range, saved.", "en") == []
    acc = _story(m, "momentum_swing", [], team="T02")
    assert rules.story_issues(m, acc, "Ostwick have bossed possession.", "en")
    goal = _story(m, "goal", [m.facts["g"]], team="T02", player="T02-9", ts=2900)
    assert rules.story_issues(m, goal, "Kimura makes it 0-1.", "en") == [
        "score order: write 1-0, not 0-1 (the leader first)", "score without the leader: name Ostwick FC next to 1-0"]
    assert rules.story_issues(m, goal, "Kimura puts Ostwick 1-0 up.", "en") == []
    press = [fact("press_intensity", 3, 2700 + 300 * k, v, "/10", f"Press intensity {v}/10") for k, v in ((1, 5.6), (2, 4.6))]
    spell = _story(m, "pressing_spell", press, ts=3300)
    assert rules.story_issues(m, spell, "Redwick kept up the heat, from 5.6/10 to 4.6/10.", "en")
    assert rules.story_issues(m, spell, "Redwick's press eased, from 5.6/10 to 4.6/10.", "en") == []
    assert rules.story_issues(m, spell, "Redwick eased, 4.6/10 after 5.6/10.", "en") == ["time order: the values are not in time order"]
    mom = [fact("momentum", 4 + k, 2700 + 300 * k, v, "/10", f"Momentum {v}/10") for k, v in enumerate((5.6, 2.7, 6.7, 9.3))]
    swing = _story(m, "momentum_swing", mom, ts=3900)
    assert any("values out of 10" in i for i in rules.story_issues(m, swing, "Redwick: 5.6/10, 2.7/10, 6.7/10.", "en"))
    assert [f["value"] for f in rules.text_facts(swing)] == [2.7, 9.3]


def test_lines_must_name_who_and_recaps_the_score():
    m = rules.Match(SIDES)
    goal = _story(m, "goal", [], team="T01", player="T01-9")
    assert rules.story_gaps(m, goal, "What a strike, 1-0.") == ["name the player: Hugo Okowande"]  # surname shared
    assert rules.story_gaps(m, goal, "Hugo Okowande, 1-0.") == []
    assert rules.story_gaps(m, _story(m, "pressing_spell", []), "The press is on.") == ["name the team: Redwick Wanderers"]
    recap = _story(m, "recap", [], team=None, phase="ft")
    assert rules.story_gaps(m, recap, "Full time here.") == ["give the score: 0-0"]


def test_templates_never_leave_an_empty_name_and_pass_their_own_checks():
    m = rules.Match(SIDES)
    m.facts["g"] = fact("score", 1, 2900, 1, "goal", "Goal 0-1", "T02")
    shot = [fact("shot_speed", 2, 3000, 101.0, "km/h", "Shot at 101 km/h")]
    for story in (_story(m, "big_chance", shot, player="T01-99", outcome="wide"),  # a player not in the info yet
                  _story(m, "goal", [m.facts["g"]], team="T02", player="T02-9", ts=2900),
                  _story(m, "recap", [], team=None, phase="ft")):
        for lang in rules.LANGS:
            text = rules.template(m, story, lang)
            assert "  " not in text and ": " not in text[-3:] and not text.startswith(" "), text
            assert not rules.story_gaps(m, story, text) and not rules.story_issues(m, story, text, lang), text
            assert not rules.check_text(m.without_names(text), rules.story_allowed(m, story), lang), text
    assert rules.template(m, _story(m, "big_chance", shot, player="T01-99", outcome="wide"), "es") == \
        "Ocasión clara para el Redwick Wanderers: disparo a 101 km/h, desviado."
    assert rules.template(m, _story(m, "recap", [], team=None, phase="ft", ts=2950), "en") == "Full time: Ostwick FC win 1-0."


def test_stoppage_time_minutes():
    m = rules.Match(SIDES)
    assert (m.minute_label(2700 + 61), m.minute_label(2690), rules.stoppage(93, 2)) == ("47", "45", "90+3")
    m1 = rules.Match({**SIDES, "period1_s": 2793.4})
    assert m1.minute_label(2793.4) == "45+2"
    late = fact("press_intensity", 1, 2793.4, 6.1, "/10", "Press intensity 6.1/10, min 46-47", period=1)
    assert rules.display_label(late) == "Press intensity 6.1/10, first-half stoppage time"
    across = fact("press_intensity", 1, 2760, 6.1, "/10", "Press intensity 6.1/10, min 42-46", period=1)
    assert rules.display_label(across) == "Press intensity 6.1/10, min 42-45+1"
    story = _story(m1, "pressing_spell", [late], ts=2793.4)
    story["minute"] = rules.minute(2793.4, 1, 2793.4)
    assert "45+2'" in rules.number_list(m1, story)
    assert rules.check_text("Redwick press at 6.1/10 in the 45+2'.", rules.story_allowed(m1, story)) == []
    assert rules.check_text("Redwick press at 6.1/10 in the 47th minute.", rules.story_allowed(m1, story))


def test_style_rations_loud_words_and_openings_over_a_match():
    used = {"loud": {"rips"}, "openings": {"a concerted press"}}
    assert any("already used" in i for i in rules.style_issues("Kimura rips one wide.", "en", "big_chance", used))
    assert any("starts" in i for i in rules.style_issues("A concerted press from Ostwick.", "en", "pressing_spell", used))
    assert any("not broadcast copy" in i for i in rules.style_issues("Gran intervento del difensore/portiere.", "it",
                                                                       "big_chance"))


# --- verifier review 3 ---------------------------------------------------------------------------

SHAPE = [fact("formation", 1, 3000, 442.0, "formation", "Formation 4-4-2, min 46-50"),
         fact("shot_speed", 2, 3000, 96.4, "km/h", "Shot at 96.4 km/h")]


def test_bare_numbers_and_formations_must_match_a_fact_exactly():
    allowed = rules.allowed_numbers(SHAPE, minutes=[(52, 2)])
    assert rules.check_text("In the 52nd minute, a 4-4-2 and a shot at 96 km/h.", allowed) == []
    assert rules.check_text("They go 4-3-3.", allowed) == ["formation not in the facts: '4-3-3'"]
    for text in ("Level after 45.", "Into the last 90.", "It ends 96 to nothing."):  # no generic 0/45/90, no 96.4 as 96
        assert rules.check_text(text, allowed), text
    m = rules.Match(INFO)
    shift = _story(m, "tactical_shift", [], shape=("4-3-3", "4-4-2"))
    assert rules.story_issues(m, shift, "Redwick go from 4-4-2 to 4-3-3.", "en") == \
        ["formation order: the change is from 4-3-3 to 4-4-2"]
    assert rules.story_issues(m, shift, "Redwick go from 4-3-3 to 4-4-2.", "en") == []


def test_glued_letters_superscripts_and_unknown_citations_are_caught():
    allowed = [(7.0, None), (96.4, "speed")]
    assert any("letters glued" in i for i in rules.check_text("Shirt No.7 again.", allowed))
    assert any("letters glued" in i for i in rules.check_text("He has scored x3 now.", allowed))
    for text in ("A shot at ⁹⁹ km/h.", "A shot at ９９ km/h.", "A shot at ٩٩ km/h."):
        assert rules.check_text(text, allowed) == ["number not in the facts: '99 km/h'"], text
    assert rules.check_text("A shot at ⁹⁶ km/h.", allowed) == []  # superscript 96 is 96
    ids = {"F-SHOT_SPEED-000001"}
    assert rules.check_text("Big shot [F-SHOT_SPEED-000099].", allowed, "en", ids) == \
        ["cited fact not in the story: 'F-SHOT_SPEED-000099'"]
    assert rules.strip_citations("Big shot [F-SHOT_SPEED-000001], then more (F-MOMENTUM-000002).") == \
        "Big shot, then more."


def test_cited_facts_never_reach_graphics_templates_or_texts(desk_db):
    _, _, rt = desk_db
    extra = min((f for f in srv.get_facts("M001") if f["kind"] == "pass_distance"), key=lambda f: f["ts"])["fact_id"]

    def analyst(schema, p):
        if schema == "Analyses":
            return {"stories": [{"story_id": s["story_id"], "fact_ids": [extra],
                                 "analysis_en": f"A move that mattered [{extra}]."} for s in p["stories"]]}

    run(rt, FakeChatClient(analyst))
    st = stories(rt)
    assert st and all(extra in s["fact_ids"] and "F-" not in s["analysis_en"] + json.dumps(s["texts"]) for s in st)
    assert all(s["analysis_en"] == "A move that mattered." for s in st)  # a cited note is kept, its citation stripped
    assert not any(extra in c["payload"] for c in rows(rt, "cues"))
    desk = workflow.Desk("M001", None, rt, "R", "fake")
    c = {"kind": "top_sprint", "facts": [SHAPE[1]], "ts": 3000.0, "team_id": "T01", "player_id": None}
    s = desk.new_story(c, 0.5, "x")
    s["cited"].append(SHAPE[0])
    assert c["facts"] == [SHAPE[1]] and rules.text_facts(s) == [SHAPE[1]] and SHAPE[0]["fact_id"] in rules.story_ids(s)


def test_desk_notes_carry_a_fixed_reason_never_the_judges_words(desk_db):
    _, _, rt = desk_db

    def judge(schema, p):
        if schema == "Verdicts":  # ok true with a real issue is not ok
            return {"verdicts": [{"story_id": t["story_id"], "lang": t["lang"], "ok": True,
                                  "issue": "Says 777 km/h, the shot was saved."} for t in p["texts"]]}

    run(rt, FakeChatClient(judge))
    st = stories(rt)
    assert st and all(s["verifier"]["status"] == "template" for s in st)
    notes = [n for s in st for n in s["verifier"]["flagged"]]
    assert "English draft not used: a claim the facts do not support." in notes
    assert not any("777" in n or "saved" in n or "F-" in n for n in notes)
    assert rules.reason("number not in the facts: '999 km/h'") == "a number the facts do not give"
    assert rules.reason("distance word does not fit the shot: 'from distance', a shot from 9 m") == \
        "a distance or place that does not fit the shot"
    assert rules.reason("anything a model wrote") == "a failed check"
    # the notes speak of the drafts, never of the text on screen; nothing when the first draft passed
    assert rules.desk_notes("pass", {"en": ["x"]}, {}) == []
    assert rules.desk_notes("rewritten", {"en": [], "it": ["a trend the values do not show"] * 2}, {}) == \
        ["Earlier Italian draft: a trend the values do not show."]
    assert rules.desk_notes("template", {"it": ["x"]}, {"en": [], "es": ["jargon"]}) == \
        ["Spanish draft not used: jargon."]


def test_a_text_judged_twice_passes_only_when_both_verdicts_pass(desk_db):
    _, _, rt = desk_db

    def judge(schema, p):
        if schema == "Verdicts":  # the model contradicts itself: the "not ok" holds
            return {"verdicts": [v for t in p["texts"] for v in (
                {"story_id": t["story_id"], "lang": t["lang"], "ok": False, "issue": "The shot was saved, not scored."},
                {"story_id": t["story_id"], "lang": t["lang"], "ok": True, "issue": ""})]}

    run(rt, FakeChatClient(judge))
    st = stories(rt)
    assert st and all(s["verifier"]["status"] == "template" for s in st)


def test_a_failed_judge_leaves_a_short_reason_in_the_trace(desk_db, monkeypatch):
    _, _, rt = desk_db
    monkeypatch.setattr(workflow, "RETRY_PAUSES_S", (0.0, 0.0))

    def down(schema, p):
        if schema == "Verdicts":
            raise RuntimeError("secret endpoint https://x.example failed")

    run(rt, FakeChatClient(down))
    out = [t["output_summary"] for t in rows(rt, "traces") if t["agent"] == "verifier"]
    assert out and all("(claims not judged: model error)" in o and "secret" not in o for o in out)


def test_the_comeback_fires_at_the_equaliser_and_says_level():
    m = rules.Match(INFO)
    seen = []
    for n, (team, ts) in enumerate([("T02", 600), ("T01", 900), ("T02", 1200), ("T01", 1500), ("T01", 1800)], 1):
        m.facts[f"g{n}"] = f = fact("score", n, ts, 1, "goal", "Goal", team, 1)
        seen += [(m.lead(ts)[1], rules.template(m, c, "en")) for c in rules.goal_candidates(m, f) if c["kind"] == "comeback"]
    assert seen == [("1-1", "Redwick Wanderers have come back to level at 1-1."),
                    ("2-2", "Redwick Wanderers have come back to level at 2-2.")]


def test_template_percentages_use_the_label_rounding():
    m = rules.Match(INFO)
    acc = [fact("pass_accuracy", 1, 5600, 82.5, "%", "Pass accuracy 83% (33/40), full time"),
           fact("pass_accuracy", 2, 5600, 70.0, "%", "Pass accuracy 70% (28/40), full time", "T02")]
    story = _story(m, "recap", acc, team=None, phase="ft", ts=5600)
    text = rules.template(m, story, "en")
    assert "83%" in text and "82" not in text and not rules.check_text(text, rules.story_allowed(m, story)), text


def test_shot_details_and_score_words_the_facts_do_not_give():
    m = rules.Match(SIDES)
    m.facts["g"] = fact("score", 1, 2900, 1, "goal", "Goal 0-1", "T02")
    shot = [fact("shot_distance", 2, 3000, 18.0, "m", "Shot from 18 m, inside the box, foot, saved")]
    chance = _story(m, "big_chance", shot, player="T01-9", outcome="saved")
    for text, lang in [("Okowande from distance, saved.", "en"), ("Okowande hits the post.", "en"),
                       ("Okowande with his left foot, saved.", "en"), ("Okowande in vantaggio, parata.", "it"),
                       ("Okowande runs in behind, saved.", "en"), ("Okowande forcing errors.", "en"),
                       ("Okowande colpisce il palo.", "it"), ("Zurdazo de Okowande, parado.", "es")]:
        assert rules.story_issues(m, chance, text, lang), text
    assert rules.story_issues(m, chance, "Okowande inside the box, saved.", "en") == []


def test_english_words_in_italian_and_spanish_lines_go_back():
    assert rules.english_words("Il Redwick win con il momentum.", "it")
    assert rules.english_words("Tiro blocked, pass accuracy alta.", "es")
    assert rules.english_words("Pressing alto del Redwick, inerzia della partita.", "it") == []
    assert rules.english_words("Pressing alto del Redwick.", "es")
    assert rules.english_words("Redwick win it.", "en") == []


@pytest.mark.parametrize("speed", [0.0, 2000.0])
def test_a_round_is_on_air_before_its_ai_tail_and_live_the_tail_runs_on_its_own(desk_db, monkeypatch, speed):
    _, _, rt = desk_db
    seen, main = [], set()
    tail = workflow.run_tail

    async def watched(desk, wf, rnd):
        ids = [s["story_id"] for s in rnd.stories]
        saved = [json.loads(r[0])["status"] for r in rt.execute(
            f"SELECT verifier FROM stories WHERE story_id IN ({', '.join('?' * len(ids))})", ids)]
        seen.append((saved, asyncio.current_task()))
        await tail(desk, wf, rnd)
    monkeypatch.setattr(workflow, "run_tail", watched)
    summary = asyncio.run(workflow.run_match("M001", FakeChatClient(delay_s=0.002), rt, speed=speed,
                                             log=lambda *_: main.add(asyncio.current_task())))
    assert seen and all(saved and set(saved) == {"pending"} for saved, _ in seen)  # saved and cued first
    assert all((t in main) == (not speed) for _, t in seen)  # live, the tail is its own task
    assert "pending" not in summary["verifier"] and {s["verifier"]["status"] for s in stories(rt)} == {"pass"}
    assert all(s["analysis_en"] for s in stories(rt))


def test_ordinals_only_as_minutes_and_counts_only_from_a_fact():
    allowed = [(2.0, None), (1.0, None), (96.4, "speed"), (1.0, "minute"), (35.0, "minute"), (41.0, "minute")]
    for text in ("Duarte scores his 2nd goal of the game.", "It was his 41st touch.",
                 "Redwick have made 2 tackles in a row.", "He has 2 sprints.",
                 "Duarte scores in the 2nd minute, 2-1.", "In the 3rd half."):  # 2 is the score, not a minute
        assert rules.check_text(text, allowed), text
    for text in ("In the 41st minute Duarte scores, 2-1.", "Redwick lead 2-1 in the 41st minute.",
                 "A 41st-minute goal.", "From the 1st minute to the 41st.", "A shot at 96.4 km/h made it 2-1.",
                 "Up from 2-1 in the 1st to 2-1 by the 35th.", "Momentum climbs by the 35th as Redwick push.",
                 "In the 41st Duarte scores.", "Rising from the 1st, at the 35th, until the 41st.",
                 "In the 2nd half Redwick press.", "Nel 2° tempo cresce."):
        assert rules.check_text(text, allowed) == [], text
    assert rules.check_text("Al 41° Duarte segna, 2-1.", allowed, "it") == []
    assert rules.check_text("Al 41º Duarte marca, 2-1.", allowed, "es") == []
    for text, lang in (("Al minuto 41 tiro di Duarte.", "it"), ("Al minuto 41 gol di Duarte, 2-1.", "it"),
                       ("En el minuto 41 remate de Duarte.", "es")):  # a number after "minute" is a minute
        assert rules.check_text(text, allowed, lang) == [], text
    passes = rules.allowed_numbers([{"fact_id": "F-TEAM_PASS_ACCURACY-000001", "kind": "team_pass_accuracy",
                                     "value": 83.0, "unit": "%", "label_en": "Pass accuracy 83% (228/276)", "period": 1}])
    assert rules.check_text("All'83%, 228 passaggi su 276.", passes, "it") == []
    assert rules.check_text("Al 83%, 228 pases de 276.", passes, "es") == []
    assert rules.check_text("228 passaggi su 300.", passes, "it")
    sprints = rules.allowed_numbers([{"fact_id": "F-SPRINT_COUNT-000001", "kind": "sprint_count", "value": 7.0,
                                      "unit": "sprints", "label_en": "7 sprints", "period": 1}])
    assert rules.check_text("He made 7 sprints.", sprints) == []
    assert rules.check_text("He made 7 tackles.", sprints) == ["number not in the facts: '7 tackles' is a count no fact gives"]


def test_a_cited_fact_joins_the_evidence_only_when_the_analysis_is_kept(desk_db):
    _, _, rt = desk_db
    extra = min((f for f in srv.get_facts("M001") if f["kind"] == "pass_distance"), key=lambda f: f["ts"])["fact_id"]

    def analyst(schema, p):
        if schema == "Analyses":
            return {"stories": [{"story_id": s["story_id"], "fact_ids": [extra],
                                 "analysis_en": f"A shot at 999 km/h [{extra}]."} for s in p["stories"]]}

    run(rt, FakeChatClient(analyst))
    st = stories(rt)
    assert st and all(extra not in s["fact_ids"] and "999" not in s["analysis_en"] for s in st)


def test_the_analyst_cites_no_fact_read_after_its_round(desk_db, monkeypatch):
    _, _, rt = desk_db
    late = max((f for f in srv.get_facts("M001") if f["kind"] == "pass_distance"), key=lambda f: f["ts"])
    tail, early = workflow.run_tail, set()

    async def moved_on(desk, wf, rnd):  # live, the desk reads on while a round's tail is still running
        if rnd.batch.ts < late["ts"]:
            early.update(s["story_id"] for s in rnd.stories)
            desk.m.facts.setdefault(late["fact_id"], late)
            desk.now = max(desk.now, late["ts"])
        await tail(desk, wf, rnd)
    monkeypatch.setattr(workflow, "run_tail", moved_on)

    def analyst(schema, p):
        if schema == "Analyses":
            return {"stories": [{"story_id": s["story_id"], "fact_ids": [late["fact_id"]],
                                 "analysis_en": f"A move that mattered [{late['fact_id']}]."} for s in p["stories"]]}

    run(rt, FakeChatClient(analyst))
    st = stories(rt)
    assert early and all(late["fact_id"] not in s["fact_ids"] for s in st if s["story_id"] in early)
    assert any(late["fact_id"] in s["fact_ids"] for s in st if s["story_id"] not in early)  # a later round may cite it


def test_a_director_that_fails_twice_never_stops_the_run(desk_db, monkeypatch):
    _, _, rt = desk_db

    def down(self, stories, now):
        raise RuntimeError("director down")
    monkeypatch.setattr(rules.Director, "plan", down)
    summary = run(rt, FakeChatClient())
    st = stories(rt)
    assert st and summary["stories"] == len(st) and all(s["verifier"]["status"] == "template" for s in st)
    assert any(t["step"] == "fallback" for t in rows(rt, "traces"))


def test_calls_in_flight_count_toward_the_ceiling(desk_db, monkeypatch):
    _, _, rt = desk_db
    monkeypatch.setattr(config, "RUN_MAX_CALLS", 4)  # the finder, the analyst, then three writers at once
    summary = run(rt, FakeChatClient(delay_s=0.05))
    assert summary["model_calls"] == 4


def test_a_call_cut_by_the_timeout_is_billed_for_its_instructions_too(desk_db, monkeypatch):
    _, _, rt = desk_db
    monkeypatch.setattr(workflow, "RETRY_PAUSES_S", (0.0, 0.0))
    monkeypatch.setattr(config, "AGENT_TIMEOUT_S", 0.05)
    run(rt, FakeChatClient(delay_s=1.0))
    cut = [a for a in rows(rt, "audit") if a["action"] == "model_call_timeout"]
    role = lambda actor: "commentator" if actor.startswith("commentator") else actor  # noqa: E731
    assert cut and all(a["tokens_in"] > len(workflow.INSTRUCTIONS[role(a["actor"])]) // 4 for a in cut)


def test_the_verifier_record_says_whether_the_judge_passed_the_analysis(desk_db, tmp_path):
    _, _, rt = desk_db
    run(rt, FakeChatClient())
    assert all(s["verifier"]["analysis_judged"] is True for s in stories(rt))
    with closing(db.connect(tmp_path / "unjudged.sqlite")) as rt2:
        run(rt2, FakeChatClient(lambda schema, p: {"verdicts": []} if schema == "Verdicts" else None))
        assert stories(rt2) and all(s["verifier"]["analysis_judged"] is False for s in stories(rt2))


def test_an_analysis_the_judge_rejects_takes_its_cited_facts_with_it(desk_db):
    _, _, rt = desk_db
    extra = min((f for f in srv.get_facts("M001") if f["kind"] == "pass_distance"), key=lambda f: f["ts"])["fact_id"]

    def model(schema, p):
        if schema == "Analyses":
            return {"stories": [{"story_id": s["story_id"], "fact_ids": [extra],
                                 "analysis_en": f"A move that mattered [{extra}]."} for s in p["stories"]]}
        if schema == "Verdicts":
            return {"verdicts": [{"story_id": t["story_id"], "lang": t["lang"], "ok": t["lang"] != "analysis",
                                  "issue": "" if t["lang"] != "analysis" else "Says the move mattered; no fact shows it."}
                                 for t in p["texts"]]}

    run(rt, FakeChatClient(model))
    st = stories(rt)
    assert st and all(extra not in s["fact_ids"] and s["analysis_en"] != "A move that mattered." for s in st)


def test_a_fallback_that_fails_too_never_stops_the_run(desk_db, monkeypatch):
    _, _, rt = desk_db

    def down(*a, **k):
        raise RuntimeError("down")
    monkeypatch.setattr(rules.Director, "plan", down)
    monkeypatch.setattr(workflow, "template_story", down)
    run(rt, FakeChatClient())
    assert stories(rt) == [] and any("fallback failed" in t["output_summary"] for t in rows(rt, "traces"))


def test_a_discarded_plan_holds_no_graphics_slot(desk_db, monkeypatch, tmp_path):
    _, _, rt = desk_db
    plan, failed = rules.Director.plan, []

    def once(placing):
        def flaky(self, stories, now):
            if stories and not failed:
                failed.append(1)
                if placing:
                    plan(self, stories, now)  # the plan takes its slots, then the round fails
                raise RuntimeError("down")
            return plan(self, stories, now)
        return flaky

    def cues(conn):
        return [(c["ts"], c["graphic"], c["audience"], c["lang"]) for c in rows(conn, "cues")]
    monkeypatch.setattr(rules.Director, "plan", once(False))
    run(rt, FakeChatClient())
    failed.clear()
    monkeypatch.setattr(rules.Director, "plan", once(True))
    with closing(db.connect(tmp_path / "placed.sqlite")) as rt2:
        run(rt2, FakeChatClient())
        assert cues(rt) and cues(rt2) == cues(rt)


def test_a_tool_result_counts_toward_the_call_it_feeds():
    token = workflow._ASK_USAGE.set({"pending_chars": 10})
    try:
        text = workflow._tool_text(SimpleNamespace(structuredContent={"result": {"a": 1}}, content=[]))
        assert workflow._ASK_USAGE.get()["pending_chars"] == 10 + len(text)
    finally:
        workflow._ASK_USAGE.reset(token)
