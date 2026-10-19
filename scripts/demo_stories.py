"""Stories, story cues and agent traces for the DEMO fixture, in the shapes of docs/CONTRACT.md.

What the agents (studiodesk/agents) will write, made by hand from the fixture's own facts so the
control desk can be built and tested before they exist. Every number in a story text or a cue is
the value of a fact the story cites. Token counts, latencies and costs are illustrative.

    stories, cues, traces = build(meta, events, facts, cues)   # called by make_demo_fixture.py
"""
from datetime import datetime, timedelta, timezone

AUTO_APPROVE_RISK = 0.35  # studiodesk/config.py; repeated so the script runs without the package
MODEL = "gpt-5-mini"
PRICE_IN, PRICE_OUT = 0.25e-6, 2.0e-6  # USD per token, illustrative
RUN_ID = "R-000001"
WALL0 = datetime(2026, 10, 19, 9, 0, tzinfo=timezone.utc)  # wall clock of the replay generation


def num(v: float, lang: str, decimals: int = 1) -> str:
    s = f"{v:.{decimals}f}"
    return s if lang == "en" else s.replace(".", ",")


def build(meta, events, facts, cues):
    players = {p["player_id"]: p for p in meta["players"]}
    short = {t["team_id"]: t["short_name"] for t in meta["teams"]}
    home, away = (next(t["team_id"] for t in meta["teams"] if t["side"] == s) for s in ("home", "away"))
    by_kind = lambda k: [f for f in facts if f["kind"] == k]  # noqa: E731
    goals = by_kind("score")
    assert len(goals) == 2 and goals[0]["team_id"] == home and goals[1]["team_id"] == away, "fixture changed: two goals, home first"

    def goal_parts(g):
        shot = next(f for f in by_kind("shot_speed") if f["source_event_ids"] == g["source_event_ids"])
        sprint = max((f for f in by_kind("sprint_speed") if f["player_id"] == shot["player_id"] and f["ts"] <= shot["ts"]),
                     key=lambda f: f["ts"])
        return shot, sprint

    def window(team, t0, t1, n):
        return [e["event_id"] for e in events if t0 <= e["ts"] <= t1 and e["team_id"] == team][-n:]

    stories, story_cues = [], []

    def story(kind, ts, team, player, risk, fact_list, evidence, analysis, texts, verifier, safety):
        s = {"match_id": meta["match_id"], "story_id": f"S-{len(stories) + 1:06d}", "ts": round(ts, 2), "kind": kind,
             "team_id": team, "player_id": player, "risk": risk,
             "default_status": "auto_approved" if risk < AUTO_APPROVE_RISK else "needs_review",
             "fact_ids": [f["fact_id"] for f in fact_list], "evidence_event_ids": evidence, "analysis_en": analysis,
             "texts": texts, "verifier": verifier, "safety": safety, "run_id": RUN_ID}
        stories.append(s)
        return s

    def why(s, ts, dur, audiences, titles, bodies=None, fact_ids=None):
        for aud in audiences:
            for lang in ("en", "it", "es"):
                t = titles[aud] if isinstance(titles, dict) and aud in titles else titles
                b = (bodies or {}).get(aud, s["texts"])
                story_cues.append({"match_id": meta["match_id"], "cue_id": "", "story_id": s["story_id"], "ts": ts,
                                   "duration_s": dur, "graphic": "why_card", "audience": aud, "lang": lang,
                                   "payload": {"kind": "why", "title": t[lang], "body": b[lang],
                                               "fact_ids": fact_ids or s["fact_ids"]}})

    def line(name, sprint, shot, lang):
        return {"en": f"{name} hit {num(sprint, lang)} km/h on the way in and finished at {num(shot, lang, 0)} km/h.",
                "it": f"{name} è arrivato a {num(sprint, lang)} km/h in corsa e ha calciato a {num(shot, lang, 0)} km/h.",
                "es": f"{name} llegó a {num(sprint, lang)} km/h en carrera y remató a {num(shot, lang, 0)} km/h."}[lang]

    def score_line(upto):
        h = max([g["value"] for g in goals[:upto] if g["team_id"] == home] or [0])
        a = max([g["value"] for g in goals[:upto] if g["team_id"] == away] or [0])
        return f"{short[home]} {h:.0f}-{a:.0f} {short[away]}"

    casual_body = {"en": "{first} sprinted clear and smashed it in.",
                   "it": "{first} è scappato via e l'ha messa dentro con forza.",
                   "es": "{first} se escapó y la reventó."}
    casual_title = {"en": "Goal! {s}", "it": "Gol! {s}", "es": "¡Gol! {s}"}

    # 1. the home goal: low risk, goes on air by itself
    shot1, sprint1 = goal_parts(goals[0])
    p1 = players[shot1["player_id"]]
    s1 = story("goal", shot1["ts"], home, p1["player_id"], 0.18, [sprint1, shot1, goals[0]],
               window(home, shot1["ts"] - 7, shot1["ts"], 4),
               f"{p1['name']} reached {sprint1['value']:.1f} km/h ({sprint1['fact_id']}) before a {shot1['value']:.0f} km/h "
               f"shot ({shot1['fact_id']}) that opened the score ({goals[0]['fact_id']}).",
               {lang: line(p1["name"], sprint1["value"], shot1["value"], lang) for lang in ("en", "it", "es")},
               {"status": "pass", "attempts": 1, "flagged": []}, "passed")
    sl1 = score_line(1)
    first1 = p1["name"].split()[0]
    why(s1, round(shot1["ts"] + 8, 1), 9.0, ("analyst", "casual"),
        {"analyst": {"en": f"{sl1}: the run made it", "it": f"{sl1}: lo scatto decisivo", "es": f"{sl1}: la carrera lo cambió todo"},
         "casual": {k: v.format(s=sl1) for k, v in casual_title.items()}},
        {"casual": {k: v.format(first=first1) for k, v in casual_body.items()}})

    # 2. the hardest pass of the match (the assist): the first draft got the distance wrong
    diff = max(by_kind("pass_difficulty"), key=lambda f: f["value"])
    dist = next(f for f in by_kind("pass_distance") if f["source_event_ids"] == diff["source_event_ids"])
    p2 = players[diff["player_id"]]
    s2 = story("key_pass", diff["ts"], diff["team_id"], p2["player_id"], 0.41, [dist, diff], diff["source_event_ids"],
               f"{p2['name']} played the hardest pass of the match, {dist['value']:.1f} m ({dist['fact_id']}) with "
               f"difficulty {diff['value']:.1f}/10 ({diff['fact_id']}), into the run that led to the goal.",
               {"en": f"{p2['name']} found the run with a {num(dist['value'], 'en')} m ball, difficulty {num(diff['value'], 'en')}/10.",
                "it": f"{p2['name']} ha pescato lo scatto con un pallone di {num(dist['value'], 'it')} m, difficoltà {num(diff['value'], 'it')}/10.",
                "es": f"{p2['name']} encontró la carrera con un balón de {num(dist['value'], 'es')} m, dificultad {num(diff['value'], 'es')}/10."},
               {"status": "rewritten", "attempts": 2,
                "flagged": [{"claim": "a 52 m ball", "fact_id": dist["fact_id"], "reason": "the ledger value differs; rewritten from the fact"}]},
               "passed")
    why(s2, round(shot1["ts"] + 17.5, 1), 7.0, ("analyst",),
        {"en": "The pass behind the goal", "it": "Il passaggio dietro al gol", "es": "El pase detrás del gol"})

    # 3. the biggest momentum gap: both drafts made a claim with no fact, so the template line is used
    mom = {t: {f["ts"]: f for f in by_kind("momentum") if f["team_id"] == t} for t in (home, away)}
    w = max(mom[away], key=lambda ts: mom[away][ts]["value"] - mom[home][ts]["value"])
    ma, mh = mom[away][w], mom[home][w]
    s3 = story("momentum_swing", w, away, None, 0.55, [ma, mh],
               list(dict.fromkeys(window(away, w - 60, w, 3) + [
                   e["event_id"] for e in events if w - 60 <= e["ts"] <= w and e["team_id"] == away and e["type_name"].startswith("shot")])),
               f"{short[away]} momentum {ma['value']:.1f} ({ma['fact_id']}) against {mh['value']:.1f} for {short[home]} "
               f"({mh['fact_id']}) in the window ending at this minute: the largest gap of the match.",
               {"en": f"Momentum: {short[away]} {num(ma['value'], 'en')}, {short[home]} {num(mh['value'], 'en')} over the last window.",
                "it": f"Inerzia: {short[away]} {num(ma['value'], 'it')}, {short[home]} {num(mh['value'], 'it')} nell'ultima finestra.",
                "es": f"Impulso: {short[away]} {num(ma['value'], 'es')}, {short[home]} {num(mh['value'], 'es')} en la última ventana."},
               {"status": "template", "attempts": 2,
                "flagged": [{"claim": "their best spell of the match", "fact_id": None, "reason": "no fact supports it"},
                            {"claim": "they have taken over", "fact_id": None, "reason": "judged unsupported on the second attempt"}]},
               "not_checked")
    why(s3, round(w + 8, 1), 8.0, ("analyst", "casual"),
        {"en": "Momentum swing", "it": "Cambio di inerzia", "es": "Cambio de inercia"})

    # 4. the away equaliser: a comeback is a strong claim, so a person signs it off
    shot2, sprint2 = goal_parts(goals[1])
    p4 = players[shot2["player_id"]]
    sl2 = score_line(2)
    first4 = p4["name"].split()[0]
    down = {"en": f"{short[away]} were {sl1.split()[1]} down at half-time.",
            "it": f"L'{short[away]} era sotto {sl1.split()[1]} all'intervallo.",
            "es": f"El {short[away]} perdía {sl1.split()[1]} al descanso."}
    s4 = story("comeback", shot2["ts"], away, p4["player_id"], 0.62, [goals[0], goals[1], sprint2, shot2],
               window(away, shot2["ts"] - 7, shot2["ts"], 4),
               f"{short[away]} trailed after {goals[0]['fact_id']} and drew level with {goals[1]['fact_id']}: "
               f"{p4['name']} at {sprint2['value']:.1f} km/h ({sprint2['fact_id']}), shot at {shot2['value']:.0f} km/h ({shot2['fact_id']}).",
               {lang: f"{line(p4['name'], sprint2['value'], shot2['value'], lang)} {down[lang]}" for lang in ("en", "it", "es")},
               {"status": "pass", "attempts": 1, "flagged": []}, "passed")
    why(s4, round(shot2["ts"] + 8, 1), 9.0, ("analyst", "casual"),
        {"analyst": {"en": f"{sl2}: back from behind", "it": f"{sl2}: la riprendono", "es": f"{sl2}: remontada"},
         "casual": {k: v.format(s=sl2) for k, v in casual_title.items()}},
        {"casual": {k: v.format(first=first4) for k, v in casual_body.items()}})

    # story ids in match-time order, as the agents number them
    stories.sort(key=lambda s: s["ts"])
    rename = {s["story_id"]: f"S-{i:06d}" for i, s in enumerate(stories, 1)}
    for row in stories + story_cues:
        row["story_id"] = rename[row["story_id"]]

    # the template "why" cards at the goals are replaced by the story cards above
    story_ts = {c["ts"] for c in story_cues}
    base = [c for c in cues if not (c["graphic"] == "why_card" and c["payload"]["kind"] == "why" and c["ts"] in story_ts)]
    all_cues = sorted(base + story_cues, key=lambda c: (c["ts"], c["audience"], c["lang"]))
    for i, c in enumerate(all_cues, 1):
        c["cue_id"] = f"C-{i:06d}"
    return stories, all_cues, traces_for(stories, all_cues, players, short, meta["period1_s"])


def traces_for(stories, cues, players, short, p1_s):
    """The hand-off chain per story: finder, analyst, commentator, verifier (and rewrites), director."""
    rows = []

    def row(s, agent, step, inp, out, fact_ids=(), tin=0, tout=0, ms=0, model=MODEL):
        prev = rows[-1]["_wall"] if rows and rows[-1]["story_id"] == s["story_id"] else WALL0 + timedelta(seconds=s["ts"] * 4)
        wall = prev + timedelta(milliseconds=ms)
        rows.append({"match_id": s["match_id"], "run_id": RUN_ID, "seq": len(rows) + 1, "ts": s["ts"],
                     "at": wall.isoformat(timespec="milliseconds").replace("+00:00", "Z"), "agent": agent, "step": step,
                     "input_summary": inp, "output_summary": out, "fact_ids": list(fact_ids),
                     "model": model if tin else None, "tokens_in": tin, "tokens_out": tout, "latency_ms": ms,
                     "cost_usd": round(tin * PRICE_IN + tout * PRICE_OUT, 6), "story_id": s["story_id"], "_wall": wall})

    for k, s in enumerate(stories):
        mm = lambda ts: int(ts // 60) + 1 if ts < p1_s else int((ts - p1_s) // 60) + 46  # noqa: E731
        minute = mm(s["ts"])
        who = players[s["player_id"]]["name"] if s["player_id"] else short[s["team_id"]]
        mine = [c for c in cues if c["story_id"] == s["story_id"]]
        f = s["fact_ids"]
        row(s, "story_finder", "pick", f"Events and facts released by the clock up to {minute}'",
            f"Candidate {s['kind']} at {minute}': {who}; risk {s['risk']:.2f}", f, 1820 + 37 * k, 96, 2140 + 90 * k)
        row(s, "analyst", "explain", f"Candidate {s['kind']} and {len(f)} cited facts", s["analysis_en"], f, 1240 + 21 * k, 172, 2610)
        row(s, "commentator", "write", "Analysis and fact values", "Lines in en, it, es and a title per audience", f, 960, 248, 3080)
        v = s["verifier"]
        if v["status"] == "pass":
            row(s, "verifier", "check", "3 lines against the fact ledger and the forbidden names",
                "pass: every number matches its fact, no forbidden name", f, 610, 38, 940)
        else:
            for a, flag in enumerate(v["flagged"][: v["attempts"]], 1):
                row(s, "verifier", "check", f"Attempt {a}: 3 lines against the fact ledger",
                    f"fail: \"{flag['claim']}\", {flag['reason']}", [flag["fact_id"]] if flag["fact_id"] else f, 610, 52, 960)
                if v["status"] == "rewritten" or a < v["attempts"]:
                    row(s, "commentator", "rewrite", f"Flagged claim \"{flag['claim']}\"", "Lines rewritten from the fact values", f, 1010, 236, 2950)
            if v["status"] == "rewritten":
                row(s, "verifier", "check", f"Attempt {v['attempts']}: rewritten lines", "pass: every number matches its fact", f, 640, 36, 910)
            else:
                row(s, "verifier", "fallback", "Two failed attempts", "template line from the facts, no model text on air", f, 0, 0, 4)
        held = s["default_status"] == "needs_review"
        auds = sorted({c["audience"] for c in mine})
        row(s, "director", "schedule", f"{len(mine)} why_card cues for {', '.join(auds)}",
            f"why_card at {mm(mine[0]['ts'])}' for {' and '.join(auds)}; "
            + (f"held for review (risk {s['risk']:.2f} >= {AUTO_APPROVE_RISK})" if held else f"auto-approved (risk {s['risk']:.2f} < {AUTO_APPROVE_RISK})"),
            [], 0, 0, 3)
    for r in rows:
        del r["_wall"]
    return rows
