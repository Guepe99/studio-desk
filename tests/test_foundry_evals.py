"""scripts/foundry_evals.py, offline: the items it sends to Foundry (query, response, context) and the summary.
Nothing here calls Azure."""
import json
import sys
from pathlib import Path

import pytest

from studiodesk import mcp_server as srv
from studiodesk.agents import rules

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import foundry_evals as fe  # noqa: E402

REPLAYS = Path(__file__).resolve().parents[1] / "replays"


def check_items(items, root):
    """Every item has its text, every name the text uses is in the context, and every number in the
    context is one the ledger gives the story (the verifier's own number check)."""
    loaded = {}
    for it in items:
        if it["match_id"] not in loaded:
            loaded[it["match_id"]] = fe.load(it["match_id"], root / it["match_id"])
        m, events, stories = loaded[it["match_id"]]
        s = next(s for s in stories if s["story_id"] == it["story_id"])
        assert it["response"] == s["texts"][it["lang"]] and it["response"]
        assert it["kind"].replace("_", " ") in it["query"] and fe.LANG_NAME[it["lang"]] in it["query"]
        ctx = it["context"]
        for p in m.players.values():
            if p.get("name") and p["name"].split()[-1] in it["response"]:
                assert p["name"] in ctx, (it["story_id"], p["name"])
        for t in m.teams.values():
            if t["name"].split()[0] in it["response"]:
                assert t["name"] in ctx
        story = rules.pack_story(m, s, events)
        assert rules.check_text(m.without_names(ctx), rules.story_allowed(m, story), "en") == [], (it["story_id"], ctx)


def test_items_from_a_hand_made_pack(match_db, tmp_path, monkeypatch):
    info, conn = match_db
    monkeypatch.setattr(srv, "DB_PATH", info["path"])
    srv.set_clock(None)
    facts = srv.get_facts(info["match_id"])
    m = rules.Match(srv.get_match_info(info["match_id"]))
    shot = next(f for f in facts if f["kind"] == "shot_speed")
    dist = next(f for f in facts if f["kind"] == "shot_distance" and f["source_event_ids"] == shot["source_event_ids"])
    name = m.required_name(shot["player_id"])
    story = {"story_id": "S-000001", "kind": "big_chance", "ts": shot["ts"], "team_id": shot["team_id"],
             "player_id": shot["player_id"], "fact_ids": [shot["fact_id"], dist["fact_id"]],
             "evidence_event_ids": shot["source_event_ids"],
             "texts": {"en": f"{name} shoots at {rules.fmt(shot['value'])} km/h.", "it": f"Tiro di {name}.", "es": ""}}
    pack = tmp_path / info["match_id"]
    pack.mkdir()
    (pack / "stories.json").write_text(json.dumps([story]))
    items = fe.build_items(info["match_id"], pack)
    assert [it["lang"] for it in items] == ["en", "it"]  # an empty text is not an item
    assert f"{rules.fmt(shot['value'])} km/h" in items[0]["context"] and "Event: shot" in items[0]["context"]
    check_items(items, tmp_path)


def test_items_from_the_replay_packs():
    if not srv.DB_PATH.exists():
        pytest.skip("data/matches.sqlite not built")
    matches = sorted(p.name for p in REPLAYS.glob("M*") if (p / "stories.json").exists())
    items = [it for mid in matches for it in fe.build_items(mid, REPLAYS / mid)]
    n = sum(len([t for t in s["texts"].values() if t]) for mid in matches
            for s in json.loads((REPLAYS / mid / "stories.json").read_text()))
    assert len(items) == n and len({(it["match_id"], it["story_id"], it["lang"]) for it in items}) == n
    check_items(items, REPLAYS)


def test_two_stories_with_the_same_text_and_context_each_get_their_scores(monkeypatch):
    """Foundry stubbed: its output items carry only what the judge read (query, response, context), one per item
    sent, in any order; each item's score is its position in the batch."""
    import asyncio
    from types import SimpleNamespace

    import agent_framework.foundry
    import azure.ai.projects.aio
    import azure.identity.aio
    same = {"kind": "big_chance", "lang": "en", "query": "q", "response": "A shot.", "context": "Minute 8."}
    items = [{**same, "match_id": "M001", "story_id": "S-000001"}, {**same, "match_id": "M001", "story_id": "S-000002"},
             {**same, "query": "another q", "match_id": "M001", "story_id": "S-000003"}]

    class Ctx:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def get_openai_client(self):
            async def output_items():
                for n, it in reversed(list(enumerate(items))):
                    yield SimpleNamespace(datasource_item={"query": it["query"], "response": it["response"], "context": it["context"]},
                                          results=[SimpleNamespace(name="fluency", score=float(n), passed=True, sample={})])

            async def listed(**k):
                return output_items()
            return SimpleNamespace(evals=SimpleNamespace(runs=SimpleNamespace(output_items=SimpleNamespace(list=listed))))

    class Evals:
        def __init__(self, **k):
            pass

        async def evaluate(self, batch, eval_name):
            return SimpleNamespace(status="completed", result_counts={}, error=None, run_id="r", eval_id="e")
    monkeypatch.setattr(azure.identity.aio, "AzureCliCredential", Ctx)
    monkeypatch.setattr(azure.ai.projects.aio, "AIProjectClient", Ctx)
    monkeypatch.setattr(agent_framework.foundry, "FoundryEvals", Evals)
    rows, _ = asyncio.run(fe.run(items))
    assert sorted(r["story_id"] for r in rows) == ["S-000001", "S-000002", "S-000003"]
    assert {r["story_id"]: r["score"] for r in rows}["S-000003"] == 2.0  # the other query's score, not one of the first two


def test_sample_is_fixed_and_keeps_order():
    items = list(range(1000))
    a, b = fe.sample(items, 10), fe.sample(items, 10)
    assert a == b == sorted(a) and len(a) == 10
    assert fe.sample(items[:5], 10) == items[:5]


def test_summary_and_section(tmp_path):
    rows = [{"run_at": "2026-10-21T15:00:00+00:00", "match_id": "M001", "story_id": "S-000001", "kind": "big_chance",
             "evaluator": ev, "lang": lang, "score": score, "passed": passed, "tokens_in": 100, "tokens_out": 10}
            for ev in fe.EVALUATORS for lang, score, passed in (("en", 5.0, 1), ("en", 2.0, 0), ("it", None, None))]
    s = fe.summary(rows)
    assert s["fluency"]["en"] == (3.5, 1, 2, 2) and s["fluency"]["it"] == (None, 0, 0, 1)
    assert s["fluency"]["all"] == (3.5, 1, 2, 3) and s["fluency"]["es"] == (None, 0, 0, 0)
    page = tmp_path / "MEASURES.md"
    page.write_text("# Measures\n\nbody\n")
    for _ in range(2):  # a second write replaces the section
        fe.write_section(page, fe.section(rows, 3, 3, "the 1 replay packs (M001)"))
    text = page.read_text()
    assert text.startswith("# Measures\n\nbody\n\n## Foundry evaluators") and text.count(fe.HEAD) == 1
    assert "| fluency | 3.50, 1 of 2 | none, 0 of 1 | none, 0 of 0 | 3.50, 1 of 3 |" in text
    assert "M001 S-000001 (big chance, English, fluency 2)" in text
    assert "4 of 12 scores came back empty" in text and "—" not in text
