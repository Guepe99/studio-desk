"""Agents workflow, offline: a fake chat client stands in for gpt-5-mini (no Azure from tests)."""
import asyncio
import json
from collections import Counter
from pathlib import Path

import pytest
from test_export import PAYLOAD_KEYS

from studiodesk import config, db
from studiodesk import mcp_server as srv
from studiodesk.agents import rules, workflow
from studiodesk.agents.llm import FakeChatClient, cost_usd
from studiodesk.export import export

ROOT = Path(__file__).resolve().parent.parent
AGENTS = ["story_finder", "analyst", "commentator_en", "commentator_it", "commentator_es", "verifier", "director"]


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
    assert rules.check_text("In minute 52 a shot at 92 km/h [F-SHOT_SPEED-000001].", ALLOWED) == []
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
    assert rules.default_status(rules.risk({**clean, "fact_ids": []})) == "needs_review"
    assert 0 <= rules.risk({**clean, "verifier": {"status": "template"}, "fact_ids": [], "confidence": 0}) <= 1


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
        assert s["verifier"]["status"] == "pass" and set(s["verifier"]) == {"status", "attempts", "flagged"}, (s["texts"], s["verifier"])
        assert s["default_status"] == rules.default_status(s["risk"]) and s["fact_ids"]
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
        assert "en: template, as another language failed" in s["verifier"]["flagged"]
        assert any("number not in the facts: '999 km/h'" in f for f in s["verifier"]["flagged"])
        assert s["default_status"] == "needs_review"


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
        if failing in ("Lines", "all", "timeout"):
            assert s["verifier"]["status"] == "template" and s["default_status"] == "needs_review"
        if failing == "Verdicts":  # numbers checked, claims not judged: nothing airs without a person
            assert s["verifier"]["status"] == "pass" and s["default_status"] == "needs_review"
    tr = rows(rt, "traces")
    if failing != "Verdicts":
        assert any("fallback" in t["output_summary"] for t in tr)
    assert not any("Error" in t["output_summary"] or "model down" in t["output_summary"] for t in tr)
    if failing == "timeout":  # a call cut by the timeout is billed: it is in the audit, once per try
        cut = [a for a in rows(rt, "audit") if a["action"] == "model_call_timeout"]
        assert cut and all(a["tokens_in"] > 0 for a in cut) and len(cut) == summary["model_calls"]


def test_judge_with_missing_verdicts_approves_nothing(desk_db):
    _, _, rt = desk_db
    run(rt, FakeChatClient(lambda schema, p: {"verdicts": []} if schema == "Verdicts" else None))
    st = stories(rt)
    assert st and all(s["default_status"] == "needs_review" for s in st)


def test_a_judge_that_takes_its_issue_back_keeps_the_text_but_approves_nothing(desk_db):
    _, _, rt = desk_db

    def judge(schema, p):
        if schema == "Verdicts":
            return {"verdicts": [{"story_id": t["story_id"], "lang": t["lang"], "ok": False,
                                  "issue": "Says header; header is true, wait, so it is fine."} for t in p["texts"]]}

    run(rt, FakeChatClient(judge))
    st = stories(rt)
    assert st and all(s["default_status"] == "needs_review" for s in st)
    assert any(s["verifier"]["status"] == "pass" for s in st)  # not sent to the template for a non-issue


def test_run_stops_calling_the_model_at_its_ceiling(desk_db, monkeypatch):
    _, _, rt = desk_db
    monkeypatch.setattr(config, "RUN_MAX_CALLS", 3)
    summary = run(rt, FakeChatClient())
    assert summary["model_calls"] == 3 and summary["stories"] > 0
    assert any("run budget reached" in t["output_summary"] for t in rows(rt, "traces"))
    assert all(s["default_status"] == "needs_review" for s in stories(rt))


def test_director_never_shows_more_than_two_graphics(desk_db):
    _, _, rt = desk_db
    m = rules.Match(srv.get_match_info("M001"))
    for f in srv.get_facts("M001"):
        m.facts[f["fact_id"]] = f
    goal = rules.goal_candidates(m, m.kind("score")[0])[0]
    crowd = [{**goal, "story_id": f"S-{i:06d}", "fact_ids": [f["fact_id"] for f in goal["facts"]],
              "texts": {lang: "text" for lang in rules.LANGS}} for i in range(6)]
    cues = rules.Director(m).plan(crowd)
    run(rt, FakeChatClient())
    cues += [{**c, "audience": "run:" + c["audience"]} for c in rows(rt, "cues")]
    assert cues
    for key in {(c["audience"], c["lang"]) for c in cues}:
        mine = [c for c in cues if (c["audience"], c["lang"]) == key]
        for c in mine:
            assert sum(d["ts"] <= c["ts"] < d["ts"] + d["duration_s"] for d in mine) <= config.MAX_GRAPHICS_ON_SCREEN


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
        assert set(c["payload"]) == PAYLOAD_KEYS[c["graphic"]]
        assert set(c["payload"].get("fact_ids") or [c["payload"]["fact_id"]]) <= fact_ids
        assert c["audience"] in ("analyst", "casual") or c["audience"].split(":")[0] in ("team", "player")
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
    ("en", "goal", "Hugo Adeyemi puts Redwick Wanderers 2-0 up at 13 with a 96 km/h strike. Redwick Wanderers lead 2-0."),
]
GOOD = [
    ("en", "goal", "Adeyemi rifles it in at 96 km/h and Redwick Wanderers lead 2-0."),
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
                                                     "after": "Redwick Wanderers lead 2-1", "write": "2-1"}
    assert "score" not in desk.card({**story, "kind": "big_chance"}, writer="en")


NOT_A_NO_ISSUE = FIRST_RUN_ISSUES + [  # each names a real problem somewhere in the sentence
    "Says Ostwick FC lead, but Redwick Wanderers lead 2-1; the rest is fine.",
    "No factual issue with the score, but the goal was scored by Kimura, not Adeyemi.",
    "Wrong scorer named. Issue: none of the facts mention Adeyemi.",
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


def test_style_goes_back_to_the_writer_and_costs_little_risk(desk_db):
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
        assert not any("repeated" in f for f in s["verifier"]["flagged"])  # style is not a verifier note
        assert s["risk"] < rules.risk({**s, "style_only": False, "fact_ids": s["fact_ids"]})
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
        found += [(w, c) for c in rules.window_candidates(m, w0, w, [], shifted)]
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
    found = rules.window_candidates(m, w - 300, w, [], set())
    assert [(c["kind"], c["team_id"], c["note"]) for c in found] == [("tactical_shift", "T01", "line higher by 11 m")]


# --- review fixes: numbers the code could not see, claims the ledger contradicts -----------------

def test_numbers_in_words_glued_or_in_foreign_units_are_flagged():
    allowed = [(96.4, "speed"), (34.2, "speed"), (3.0, None)]
    for text, lang in [("Redwick lead by three goals after a hat-trick.", "en"), ("Tre gol in dieci minuti.", "it"),
                       ("ninety-six kilometres an hour", "en"), ("Novantasei all'ora", "it"), ("Veintiséis", "es"),
                       ("He hit it at 96kmh.", "en"), ("A sprint at 34 mph", "en"), ("3 goals now", "en")]:
        assert rules.check_text(text, allowed, lang), text
    assert rules.check_text("A 96 kilometres per hour drive, then a 34 km/h sprint in the 3rd minute.", allowed) == []
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
    assert rules.story_issues(m, chance, "Adeyemi at the near post, saved.", "en") == ["'near post' is not in the facts"]
    assert rules.story_issues(m, chance, "Adeyemi colpisce al volo, parata.", "it")
    assert rules.story_issues(m, chance, "Adeyemi hits the crossbar area, saved.", "en") == []
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


SIDES = {**INFO, "players": [{"player_id": "T01-9", "name": "Hugo Adeyemi", "team_id": "T01"},
                             {"player_id": "T02-9", "name": "Tariq Kimura", "team_id": "T02"},
                             {"player_id": "T02-7", "name": "Ali Adeyemi", "team_id": "T02"}]}


def _story(m, kind, facts, team="T01", player=None, ts=3000.0, **extra):
    return {"kind": kind, "facts": facts, "team_id": team, "player_id": player, "ts": ts,
            "minute": rules.minute(ts, 2, m.p1), "fact_ids": [f["fact_id"] for f in facts], **extra}


def test_story_issues_catch_distance_possession_score_order_and_trend():
    m = rules.Match(SIDES)
    m.facts["g"] = fact("score", 1, 2900, 1, "goal", "Goal 0-1", "T02")
    shot = [fact("shot_speed", 2, 3000, 101.0, "km/h", "Shot at 101 km/h"),
            fact("shot_distance", 2, 3000, 8.6, "m", "Shot from 9 m")]
    chance = _story(m, "big_chance", shot, player="T01-9", outcome="saved")
    assert rules.story_issues(m, chance, "Adeyemi dal limite dell'area, 8,6 m.", "it")
    assert rules.story_issues(m, chance, "Hugo Adeyemi from distance, saved.", "en")
    assert rules.story_issues(m, chance, "Hugo Adeyemi from close range, saved.", "en") == []
    acc = _story(m, "momentum_swing", [], team="T02")
    assert rules.story_issues(m, acc, "Ostwick have bossed possession.", "en")
    goal = _story(m, "goal", [m.facts["g"]], team="T02", player="T02-9", ts=2900)
    assert rules.story_issues(m, goal, "Kimura makes it 0-1.", "en") == ["write the score leader first: 1-0, not 0-1"]
    assert rules.story_issues(m, goal, "Kimura puts Ostwick 1-0 up.", "en") == []
    press = [fact("press_intensity", 3, 2700 + 300 * k, v, "/10", f"Press intensity {v}/10") for k, v in ((1, 5.6), (2, 4.6))]
    spell = _story(m, "pressing_spell", press, ts=3300)
    assert rules.story_issues(m, spell, "Redwick kept up the heat, from 5.6/10 to 4.6/10.", "en")
    assert rules.story_issues(m, spell, "Redwick's press eased, from 5.6/10 to 4.6/10.", "en") == []
    assert rules.story_issues(m, spell, "Redwick eased, 4.6/10 after 5.6/10.", "en") == ["the values are not in time order"]
    mom = [fact("momentum", 4 + k, 2700 + 300 * k, v, "/10", f"Momentum {v}/10") for k, v in enumerate((5.6, 2.7, 6.7, 9.3))]
    swing = _story(m, "momentum_swing", mom, ts=3900)
    assert any("values out of 10" in i for i in rules.story_issues(m, swing, "Redwick: 5.6/10, 2.7/10, 6.7/10.", "en"))
    assert [f["value"] for f in rules.text_facts(swing)] == [2.7, 9.3]


def test_lines_must_name_who_and_recaps_the_score():
    m = rules.Match(SIDES)
    goal = _story(m, "goal", [], team="T01", player="T01-9")
    assert rules.story_gaps(m, goal, "What a strike, 1-0.") == ["name the player: Hugo Adeyemi"]  # surname shared
    assert rules.story_gaps(m, goal, "Hugo Adeyemi, 1-0.") == []
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
        "Ocasión clara para Redwick Wanderers: disparo a 101 km/h, desviado."
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
