"""scripts/measures.py: the counting rules, on hand-made stories, audit rows and traces."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import measures  # noqa: E402


def story(sid, ts, kind="goal", flagged=(), on_air="phrasebook", proposals=True, team="T01"):
    v = {"status": "rewritten", "flagged": list(flagged), "on_air": on_air}
    if proposals:
        v["proposals"] = {"en": "x", "it": "x", "es": "x"}
    return {"story_id": sid, "ts": ts, "kind": kind, "team_id": team, "player_id": None, "verifier": v}


def test_blocked_counts_drafts_with_a_number_or_a_name():
    stories = [
        story("S-000001", 10, flagged=["Earlier Italian draft: a number the facts do not give; a word repeated.",
                                       "Earlier Spanish draft: a word repeated."]),
        story("S-000002", 20, flagged=["English draft not used: a real person's or club's name.",
                                       "Earlier Italian draft: a number written in words, which the desk does not allow; "
                                       "a real person's or club's name."]),
        story("S-000003", 30, flagged=["Earlier English draft: numbers listed at the end of the line."]),  # style, not a number
    ]
    assert measures.blocked(stories) == {"numbers": 2, "names": 2}


def test_on_air_and_proposals():
    stories = [story("S-000001", 1), story("S-000002", 2, on_air="template", proposals=False), story("S-000003", 3, on_air=None)]
    assert measures.on_air(stories) == {"stories": 3, "phrasebook": 1, "template": 1, "ai": 1, "proposals": 2}


def test_storylines_found_uses_the_eval_rule():
    lines = [{"story_id": "H1", "kind": "comeback", "ts_start": 100, "ts_end": 900, "team_id": "T01", "player_id": None},
             {"story_id": "H2", "kind": "high_press", "ts_start": 100, "ts_end": 200, "team_id": "T02", "player_id": None}]
    stories = [story("S-000001", 950, kind="comeback"), story("S-000002", 150, kind="pressing_spell", team="T01")]
    assert measures.storylines_found(lines, stories) == (1, 2)  # wrong team for the press


def test_usage_reads_the_audit_and_the_traces_apart():
    audit = [{"action": "model_call", "tokens_in": 100, "tokens_out": 10, "cost_usd": 0.5, "detail": json.dumps({"latency_ms": 1500})},
             {"action": "model_call", "tokens_in": 200, "tokens_out": 20, "cost_usd": 0.25, "detail": "{}"},
             {"action": "approved", "tokens_in": 0, "tokens_out": 0, "cost_usd": 0, "detail": "{}"}]
    traces = [{"tokens_in": 100, "tokens_out": 10, "cost_usd": 0.5}, {"tokens_in": 300, "tokens_out": 30, "cost_usd": 0.75}]
    u = measures.usage(audit, traces)
    assert (u["calls"], u["tokens_in"], u["tokens_out"], u["cost_usd"], u["model_s"]) == (2, 300, 30, 0.75, 1.5)
    assert (u["trace_tokens"], u["trace_cost_usd"]) == (440, 1.25)


def test_timing_round_wall_time_and_match_wait():
    def tr(seq, ts, agent, at, latency_ms=0, sids=()):
        return {"seq": seq, "ts": ts, "agent": agent, "at": f"2026-10-19T20:00:{at:06.3f}+00:00",
                "latency_ms": latency_ms, "story_ids": json.dumps(list(sids))}
    traces = [tr(1, 600.0, "story_finder", 4.0, 2000, ["S-000001", "S-000002"]), tr(2, 600.0, "verifier", 9.0),
              tr(3, 600.0, "director", 12.5), tr(4, 900.0, "story_finder", 20.0, 1000, ["S-000003"]),
              tr(5, 900.0, "director", 23.0)]
    stories = [story("S-000001", 599.5), story("S-000002", 400.0, kind="big_chance"), story("S-000003", 899.0)]
    t = measures.timing(traces, stories)
    assert t["rounds"] == 2 and t["walls"] == [10.5, 4.0] and t["wall_max_s"] == 10.5 and t["wall_total_s"] == 14.5
    assert t["waits"] == [("goal", 0.5), ("big_chance", 200.0), ("goal", 1.0)]


def test_live_delay_counts_from_the_event_as_the_clock_released_it():
    def tr(seq, ts, agent, at, sids=()):
        return {"seq": seq, "ts": ts, "agent": agent, "at": f"2026-10-19T20:{at}+00:00", "story_ids": json.dumps(list(sids))}
    start = measures.at("2026-10-19T20:00:00.000+00:00")
    traces = [tr(1, 310.0, "story_finder", "00:12.000", ["S-000001"]), tr(2, 310.0, "director", "00:14.500", ["S-000001"]),
              tr(3, 900.0, "story_finder", "10:05.000", ["S-000002"]), tr(4, 900.0, "verifier", "10:06.000")]  # no cues
    stories = [story("S-000001", 309.5), story("S-000002", 899.0, kind="big_chance")]
    assert measures.live_delay(traces, stories, start, 300.0, 1.0) == [("goal", 5.0)]  # 14.5 s wall, event at 9.5 s
    assert measures.live_delay(traces, stories, start, 300.0, 2.0) == [("goal", 9.75)]


def test_measure_reads_only_its_match_and_the_page_adds_up(tmp_path):
    import sqlite3
    from studiodesk import db
    rt = tmp_path / "rt.sqlite"
    with db.connect(rt) as c:
        for m, n in (("M001", 100), ("M002", 900)):  # M002's rows must not reach M001
            c.execute("INSERT INTO audit (at, actor, action, match_id, tokens_in, tokens_out, cost_usd, detail) "
                      "VALUES ('x', 'analyst', 'model_call', ?, ?, 10, 0.5, '{\"latency_ms\": 6000}')", (m, n))
            for seq, agent, at in ((1, "story_finder", "00:01.000"), (2, "director", "00:05.000")):
                c.execute("INSERT INTO traces (match_id, run_id, seq, ts, at, agent, step, input_summary, output_summary, "
                          "tokens_in, tokens_out, latency_ms, cost_usd, story_ids) VALUES (?, 'R', ?, 600, ?, ?, 's', '', '', "
                          "?, 10, 1000, 0.5, '[\"S-000001\"]')", (m, seq, f"2026-10-19T20:{at}+00:00", agent, n if seq == 1 else 0))
    mc = sqlite3.connect(":memory:")
    mc.row_factory = sqlite3.Row
    mc.execute("CREATE TABLE storylines (match_id, story_id, kind, ts_start, ts_end, team_id, player_id)")
    mc.execute("CREATE TABLE matches (match_id, period1_s, period2_s)")
    mc.execute("INSERT INTO matches VALUES ('M001', 1500, 1500)")
    pack = tmp_path / "M001"
    pack.mkdir()
    (pack / "stories.json").write_text(json.dumps([story("S-000001", 599.0)]))
    r = measures.measure("M001", pack, rt, mc)
    assert (r["calls"], r["tokens_in"], r["minutes"], r["model_s"]) == (1, 100, 50.0, 6.0)
    assert r["walls"] == [5.0] and r["waits"] == [("goal", 1.0)]
    other = {**r, "match_id": "M002", "calls": 3, "tokens_in": 300, "found": 1, "planted": 2, "wall_total_s": 15.0}
    t = measures.total([r, other])
    assert (t["calls"], t["tokens_in"], t["found"], t["planted"], t["minutes"]) == (4, 400, 1, 2, 100.0)
    page = measures.markdown([r, other])
    assert "| all | 1 of 2 |" in page and "4 model calls used 400 input" in page
    assert "the 2 rounds took 0.2 seconds of wall time per minute" in page  # (5 + 15) s over 100 minutes
    assert "Not measured: no real-speed run" in page and "do not match the audit" in " ".join(page.split())
    live = " ".join(measures.markdown([r], {"delays": [("goal", 4.0), ("big_chance", 9.0), ("goal", 6.0)], "setup_s": 3.0}).split())
    assert "The 2 goals reached the director's cue 4.0 and 6.0 seconds after the shot" in live
    assert "the big chance after 9.0 seconds, judged once the play had settled" in live and "at least 3.0 seconds" in live and "—" not in page + live
