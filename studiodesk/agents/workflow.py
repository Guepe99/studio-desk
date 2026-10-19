"""The agents workflow (docs/CONTRACT.md, Runtime records), on Microsoft Agent Framework.

    MatchClock --event--> Desk.ingest (facts through MCP) --Batch--> workflow:

        story_finder -> analyst -> commentator_en ┐
                                -> commentator_it ├-> verifier -> director -> stories + cues
                                -> commentator_es ┘

A batch starts when the clock releases a goal, a sprint above 34 km/h or the end of a 5-minute
window. Agents read the match only through the MCP server (studiodesk/mcp_server.py), served in
process over the MCP protocol on memory streams so its clock moves with ours. Any agent that fails
or times out is replaced by rules and template sentences: the broadcast never waits.
"""
import asyncio
import json
import time
import uuid
from collections import Counter, defaultdict
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone

from agent_framework import Agent, WorkflowBuilder, WorkflowContext, chat_middleware, executor
from agent_framework._mcp import MCPTool
from mcp.shared.memory import create_connected_server_and_client_session

from .. import config, db, mcp_server
from ..clock import MatchClock
from . import rules
from .llm import Analyses, Lines, Picks, Verdicts, cost_usd

MAX_PICKS = 4          # stories per batch besides the must-tell ones
TOOL_RESULT_CHARS = 6000

INSTRUCTIONS = {
    "story_finder": (
        "You are the story finder of a football broadcast desk. The user message is JSON with the match "
        "minute, candidate moments found by rules, and the stories already told. Pick the moments worth a "
        "graphic. `score_after` is the score after the moment, home team first. Rules per kind:\n" + "\n".join(f"- {k}: {v}" for k, v in rules.RULES.items()) +
        f"\nPick at most {MAX_PICKS} besides goals, comebacks and recaps. You may call the studiodesk tools "
        "(always with match_id and a narrow kind or time range) to check context, but usually the candidates "
        "are enough. The angle is one short plain sentence, under 15 words, on what makes the moment "
        "interesting: the football reason (a run behind the line, a keeper beaten at the near post, a change "
        "of shape), not the score and not a list of numbers. Do not start it the way the angles in "
        "`recent_stories` start. Reply with JSON: picks = [{candidate_id, confidence 0..1, angle}]."),
    "analyst": (
        "You are the analyst of a football broadcast desk. For each story in the JSON, explain in one or two "
        "sentences of plain English why it matters, citing the fact ids you rely on in square brackets, e.g. "
        "[F-SHOT_SPEED-000031]. Use only numbers that appear in the facts, written as they appear there. You "
        "may call the studiodesk tools (with match_id and a kind, player or time range) to find one more "
        "supporting fact; cite it if you use it. `score_after` is the score after the moment, home team first; "
        "mention it only for a goal, comeback or recap. Say each thing once. "
        "No em or en dashes (a hyphen in a score like 2-1 is fine). Reply with JSON: stories = [{story_id, analysis_en, fact_ids}]."),
    "commentator": (
        "You are a television football commentator writing the on-screen line in {language_name}. {style} "
        "For each story in the JSON write one or two short sentences, the way you would say them over the "
        "replay (a recap may take three). Rules:\n"
        "- Numbers: only the strings in the story's `numbers`, written with digits as listed (a decimal "
        "may be rounded to a whole number). No other numbers, no invented names, players or events.\n"
        "- Score: only when the story has `score`, and then once at most; `score.after` is the score right "
        "after the moment and `score.who_leads` says who leads. A story without `score` never mentions it.\n"
        "- Say each thing once: no word or idea twice in a line, no restating the story kind, no 'according "
        "to the data'.\n"
        "- Vary the openings: do not start the way the lines in `recent_openings` start, and do not start "
        "with the minute or the team name every time.\n"
        "- Use the team and player names given. No em or en dashes (a hyphen in a score like 2-1 is fine).\n"
        "If `feedback` is present, rewrite that story to fix exactly that problem. Reply with JSON: "
        "lines = [{story_id, text}]."),
    "verifier": (
        "You check on-screen football text against the facts. Numbers are already checked by code; judge "
        "only the claims without numbers: who scored, who leads, what happened, comparisons. Each story "
        "gives `facts`, `score_before` and `score_after` (the score just before and just after the moment) "
        "and `who_leads` (who leads after it, in words). A text that agrees with them is ok, even when it "
        "phrases the score differently or names only the leader. Colour and interpretation (a fine strike, "
        "a big moment, a nervy spell) are fine. Flag only a contradiction of these facts, an invented event, "
        "a wrong player or team, or a wrong leader. Never flag style or wording. Texts with lang `analysis` "
        "are the analyst's notes: judge them the same way. Reply with JSON: verdicts = [{story_id, lang, ok, "
        "issue}], one verdict per text; ok is true when you found no problem, and then issue is empty; "
        "otherwise issue is one short sentence naming the wrong claim."),
}
STYLE = {
    "en": "Write in British English (pitch, keeper, nil, the box, colour), like a Saturday-afternoon TV "
          "commentator: crisp, understated, active verbs.",
    "it": "Scrivi in italiano da telecronista (rete, conclusione, palla, in vantaggio, area), con frasi native "
          "e non tradotte dall'inglese; i decimali con la virgola (96,4).",
    "es": "Escribe en español de España como un narrador de televisión (gol, disparo, el área, por delante), "
          "con frases nativas, no traducidas del inglés; decimales con coma (96,4).",
}
LANGUAGE_NAMES = {"en": "English", "it": "Italian", "es": "Spanish"}
AGENT_TOOLS = {"story_finder": ["get_events", "get_facts", "get_player"], "analyst": ["get_facts", "get_fact"]}


# --- MCP ---------------------------------------------------------------------------------------

class InProcessMCPTool(MCPTool):
    """Agent Framework MCP tool source over an existing MCP client session (memory transport)."""

    def get_mcp_client(self):  # the session is always passed in
        raise NotImplementedError


def _tool_text(result):
    if result.structuredContent is not None:
        data = result.structuredContent.get("result", result.structuredContent)
        text = json.dumps(data, ensure_ascii=False)
    else:
        text = "".join(getattr(c, "text", "") for c in result.content)
    return text if len(text) <= TOOL_RESULT_CHARS else text[:TOOL_RESULT_CHARS] + " ... [truncated: narrow the query]"


@asynccontextmanager
async def mcp_session():
    """An MCP client session to studiodesk/mcp_server.py running in this process."""
    async with create_connected_server_and_client_session(mcp_server.server) as session:
        yield session


async def mcp_call(session, tool, **args):
    res = await session.call_tool(tool, {k: v for k, v in args.items() if v is not None})
    if res.isError:
        raise RuntimeError(f"MCP {tool}: {''.join(getattr(c, 'text', '') for c in res.content)}")
    if res.structuredContent is not None:
        return res.structuredContent.get("result", res.structuredContent)
    if not res.content:
        return []
    items = [json.loads(c.text) for c in res.content]
    return items[0] if len(items) == 1 and isinstance(items[0], dict) and tool in ("get_match_info", "get_fact",
                                                                                  "get_player") else items


# --- messages ------------------------------------------------------------------------------------

@dataclass
class Batch:
    ts: float
    candidates: list
    window_end: float | None = None


@dataclass
class Round:
    batch: Batch
    stories: list
    cues: list = field(default_factory=list)


@dataclass
class Drafts:
    round: Round
    lang: str
    texts: dict
    error: str | None = None


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class Desk:
    """Shared state of one run: the fact ledger (read through MCP), the story queue and the recorder."""

    def __init__(self, match_id, session, rt, run_id, model_name):
        self.match_id, self.session, self.rt, self.run_id, self.model_name = match_id, session, rt, run_id, model_name
        self.m = None
        self.director = None
        self.queue = []                      # stories told so far
        self.agents = {}
        self.now = 0.0
        self.seq = self.story_n = self.cue_n = 0
        self.calls = self.tokens_in = self.tokens_out = 0
        self.cost = 0.0
        self.latency = defaultdict(list)     # agent -> [ms] per model call
        self.polled = 0.0
        self.last_window = 0.0
        self.shifted = set()
        self.openings = defaultdict(list)    # lang -> first words of the lines on air, so openings vary

    async def mcp(self, tool, **args):
        return await mcp_call(self.session, tool, match_id=self.match_id, **args)

    # recorder
    def trace(self, agent, step, input_summary, output_summary, fact_ids=(), usage=None, story_ids=()):
        u = usage or {}
        self.seq += 1
        db.insert(self.rt, "traces", {
            "match_id": self.match_id, "run_id": self.run_id, "seq": self.seq, "ts": self.now, "at": _now_iso(),
            "agent": agent, "step": step, "input_summary": rules.tidy(input_summary)[:500],
            "output_summary": rules.tidy(output_summary)[:500], "story_ids": list(dict.fromkeys(story_ids)),
            "fact_ids": list(dict.fromkeys(fact_ids)), "model": self.model_name if u.get("calls") else None,
            "tokens_in": u.get("tokens_in", 0), "tokens_out": u.get("tokens_out", 0),
            "latency_ms": u.get("latency_ms", 0), "cost_usd": round(u.get("cost_usd", 0.0), 6)})
        self.rt.commit()

    def record_call(self, agent, usage, latency_ms, model):
        c = cost_usd(usage)
        tin, tout = usage.get("input_token_count") or 0, usage.get("output_token_count") or 0
        self.calls += 1
        self.tokens_in += tin
        self.tokens_out += tout
        self.cost += c
        self.latency[agent].append(latency_ms)
        db.insert(self.rt, "audit", {"session_id": None, "at": _now_iso(), "actor": agent, "action": "model_call",
                                     "match_id": self.match_id, "story_id": None, "model": model or self.model_name,
                                     "tokens_in": tin, "tokens_out": tout, "cost_usd": round(c, 6),
                                     "detail": {"run_id": self.run_id, "latency_ms": latency_ms, "match_ts": self.now}})
        self.rt.commit()

    def audit_middleware(self, agent):
        @chat_middleware
        async def audit(ctx, call_next):
            t0 = time.perf_counter()
            await call_next()
            if ctx.result is not None:
                self.record_call(agent, ctx.result.usage_details or {}, round((time.perf_counter() - t0) * 1000),
                                 getattr(ctx.result, "model", None))
        return audit

    async def ask(self, agent, payload, schema):
        """One agent run with a timeout; returns (parsed output, usage summed over its model calls)."""
        t0, calls0, tin0, tout0, cost0 = time.perf_counter(), self.calls, self.tokens_in, self.tokens_out, self.cost
        resp = await asyncio.wait_for(
            self.agents[agent].run(json.dumps(payload, ensure_ascii=False), options={"response_format": schema}),
            config.AGENT_TIMEOUT_S)
        out = schema.model_validate_json(resp.text)
        return out, {"calls": self.calls - calls0, "tokens_in": self.tokens_in - tin0,
                     "tokens_out": self.tokens_out - tout0, "cost_usd": self.cost - cost0,
                     "latency_ms": round((time.perf_counter() - t0) * 1000)}

    # views for prompts
    def score_text(self, ts):
        score, _ = self.m.score_at(ts)
        return (f"{self.m.home['name']} {score[self.m.home['team_id']]}, "
                f"{self.m.away['name']} {score[self.m.away['team_id']]}")

    def brief(self, f):
        label = f["label_en"] + (f" (score now {self.score_text(f['ts'])})" if f["kind"] == "score" else "")
        return {"fact_id": f["fact_id"], "kind": f["kind"], "value": f["value"], "unit": f["unit"],
                "label": label, "minute": self.m.minute_of(f),
                "team": self.m.team_name(f["team_id"]), "player": self.m.player_name(f["player_id"])}

    def who_leads(self, ts):
        """The score in words, leader first: "Redwick Wanderers lead 2-1" or "Level at 1-1"."""
        score, _ = self.m.score_at(ts)
        (hi_team, hi), (_, lo) = sorted(((t, score[t["team_id"]]) for t in (self.m.home, self.m.away)),
                                        key=lambda x: -x[1])
        return f"Level at {hi}-{lo}" if hi == lo else f"{hi_team['name']} lead {hi}-{lo}"

    def card(self, s, analysis=False, writer=None):
        """A story for a prompt. For a commentator (writer=lang): the allowed numbers, the score only when
        it is the point of the story, and how the last lines began."""
        c = {"story_id": s["story_id"], "kind": s["kind"], "minute": s["minute"], "team": self.m.team_name(s["team_id"]),
             "player": self.m.player_name(s["player_id"]), "angle": s.get("angle", ""),
             "facts": [self.brief(f) for f in s["facts"]]}
        if writer is None:
            c["score_before"] = self.score_text(s["ts"] - 1e-3)
            c["score_after"] = self.score_text(s["ts"])
            c["who_leads"] = self.who_leads(s["ts"])
        else:
            c["numbers"] = rules.number_list(self.m, s, writer)
            if s["kind"] in rules.SCORE_KINDS:
                c["score"] = {"before": self.who_leads(s["ts"] - 1e-3), "after": self.score_text(s["ts"]),
                              "who_leads": self.who_leads(s["ts"])}
        if s["kind"] == "recap":
            c["phase"] = rules.TITLES[s["phase"]][0]
            c["teams"] = {"home": self.m.home["name"], "away": self.m.away["name"]}
        if analysis:
            c["analysis_en"] = s["analysis_en"]
        return c

    def writer_payload(self, lang, stories, feedback=None):
        p = {"language": lang, "stories": [self.card(s, analysis=True, writer=lang) for s in stories],
             "recent_openings": self.openings[lang][-6:]}
        if feedback:
            p["feedback"] = feedback
        return p

    # ingest
    async def start(self, from_ts):
        mcp_server.set_clock(from_ts)
        self.m = rules.Match(await self.mcp("get_match_info"))
        self.director = rules.Director(self.m)
        self.now = self.polled = from_ts
        for f in await self.mcp("get_facts", to_ts=from_ts):
            self.m.facts[f["fact_id"]] = f
        self.last_window = max((f["ts"] for f in self.m.kind("momentum")), default=0.0)

    async def ingest(self, now, final=False, full_time=False):
        """Read the facts released since the last call; return a Batch when something is worth a look."""
        self.now = now
        mcp_server.set_clock(now)
        new = [f for f in await self.mcp("get_facts", from_ts=self.polled) if f["fact_id"] not in self.m.facts]
        self.polled = now
        for f in new:
            self.m.facts[f["fact_id"]] = f
        cands = []
        for f in new:
            if f["kind"] == "score":
                cands += rules.goal_candidates(self.m, f)
            elif f["kind"] == "sprint_speed":
                cands += rules.sprint_candidates(f)
        window_end = max((f["ts"] for f in new if f["kind"] == "momentum"), default=None)
        if window_end is not None:
            if self.m.p1 is None:
                self.m.update(await self.mcp("get_match_info"))
            shots = await self.mcp("get_events", from_ts=self.last_window + 1e-6, to_ts=window_end, type_name="shot")
            cands += rules.window_candidates(self.m, self.last_window, window_end, shots, self.shifted)
            if self.m.p1 is not None and abs(window_end - self.m.p1) < 1e-6:
                cands.append(rules.recap_candidate(self.m, window_end, "ht"))
            self.last_window = window_end
        if full_time:
            cands.append(rules.recap_candidate(self.m, now, "ft"))
        if not cands and window_end is None:
            return None
        for i, c in enumerate(cands, 1):
            c["candidate_id"] = f"c{i}"
            c["minute"] = rules.minute(c["ts"], 2 if self.m.p1 is not None and c["ts"] > self.m.p1 + 1e-6 else 1,
                                       self.m.p1 or float("inf"))
        return Batch(now, cands, window_end)

    def new_story(self, c, confidence, angle):
        self.story_n += 1
        return {**c, "story_id": f"S-{self.story_n:06d}", "confidence": confidence, "angle": rules.tidy(angle),
                "fact_ids": [f["fact_id"] for f in c["facts"]], "analysis_en": "", "texts": {}, "flagged": []}

    def finish(self, s):
        s["risk"] = rules.risk(s)
        s["default_status"] = rules.default_status(s["risk"])
        return s

    def save(self, rnd):
        for s in rnd.stories:
            db.insert(self.rt, "stories", {
                "match_id": self.match_id, "story_id": s["story_id"], "ts": s["ts"], "kind": s["kind"],
                "team_id": s["team_id"], "player_id": s["player_id"], "risk": s["risk"],
                "default_status": s["default_status"], "fact_ids": s["fact_ids"],
                "evidence_event_ids": s["evidence_event_ids"], "analysis_en": s["analysis_en"], "texts": s["texts"],
                "verifier": s["verifier"], "safety": "not_checked", "run_id": self.run_id})
            self.queue.append(s)
        self.save_cues(rnd.cues)

    def save_cues(self, cues):
        for c in cues:
            self.cue_n += 1
            db.insert(self.rt, "cues", {"match_id": self.match_id, "cue_id": f"C-{self.cue_n:06d}", **c})
        self.rt.commit()


# --- the workflow --------------------------------------------------------------------------------

def _rule_picks(cands):
    """The finder's fallback: must-tell candidates plus the first other one."""
    must = [c for c in cands if c["kind"] in rules.MUST_TELL]
    return must + [c for c in cands if c["kind"] not in rules.MUST_TELL][:1]


def template_story(desk, s, reason):
    for lang in rules.LANGS:
        s["texts"][lang] = rules.template(desk.m, s, lang)
    s["analysis_en"] = s["analysis_en"] or rules.analysis_template(s)
    s["verifier"] = {"status": "template", "attempts": 0, "flagged": s["flagged"] + [rules.note(reason)]}
    return desk.finish(s)


def build_workflow(desk):
    m = lambda: desk.m  # noqa: E731
    ids = lambda rnd: [s["story_id"] for s in rnd.stories]  # noqa: E731

    @executor(id="story_finder")
    async def story_finder(batch: Batch, ctx: WorkflowContext[Round, Round]) -> None:
        cands = batch.candidates
        if not cands:
            await ctx.yield_output(Round(batch, []))
            return
        by_id = {c["candidate_id"]: c for c in cands}
        payload = {"minute": cands[-1]["minute"],
                   "candidates": [{"candidate_id": c["candidate_id"], "kind": c["kind"], "minute": c["minute"],
                                   "team": m().team_name(c["team_id"]), "player": m().player_name(c["player_id"]),
                                   "note": c["note"], "score_after": desk.score_text(c["ts"]),
                                   "facts": [desk.brief(f) for f in c["facts"][:6]]}
                                  for c in cands],
                   "recent_stories": [{"kind": s["kind"], "team": m().team_name(s["team_id"]),
                                       "player": m().player_name(s["player_id"]), "minute": s["minute"],
                                       "angle": s["angle"]}
                                      for s in desk.queue[-8:]]}
        try:
            out, usage = await desk.ask("story_finder", payload, Picks)
            picks = [(by_id[p.candidate_id], p.confidence, p.angle) for p in out.picks if p.candidate_id in by_id]
            note = ""
        except Exception as e:  # noqa: BLE001 - any failure falls back to the written rules
            picks, usage, note = [(c, 0.5, c["note"]) for c in _rule_picks(cands)], None, f" fallback: {e!r}"[:200]
        chosen = {id(c) for c, _, _ in picks}
        picks = list({id(c): (c, conf, a) for c, conf, a in picks}.values())
        must = [(c, 0.7, c["note"]) for c in cands if c["kind"] in rules.MUST_TELL and id(c) not in chosen]
        others = [p for p in picks if p[0]["kind"] not in rules.MUST_TELL][:MAX_PICKS]
        stories = [desk.new_story(c, conf, a) for c, conf, a in sorted(
            [p for p in picks if p[0]["kind"] in rules.MUST_TELL] + must + others, key=lambda p: p[0]["ts"])]
        desk.trace("story_finder", "pick", f"{len(cands)} candidates: " + ", ".join(c["kind"] for c in cands),
                   f"{len(stories)} stories: " + ", ".join(f"{s['story_id']} {s['kind']}" for s in stories) + note,
                   [i for s in stories for i in s["fact_ids"]], usage, [s["story_id"] for s in stories])
        if not stories:
            await ctx.yield_output(Round(batch, []))
            return
        await ctx.send_message(Round(batch, stories))

    @executor(id="analyst")
    async def analyst(rnd: Round, ctx: WorkflowContext[Round]) -> None:
        note, usage = "", None
        try:
            out, usage = await desk.ask("analyst", {"stories": [desk.card(s) for s in rnd.stories]}, Analyses)
            got = {a.story_id: a for a in out.stories}
        except Exception as e:  # noqa: BLE001
            got, note = {}, f" fallback: {e!r}"[:200]
        for s in rnd.stories:
            a = got.get(s["story_id"])
            if a:
                for fid in a.fact_ids:  # a fact the analyst looked up through MCP joins the evidence
                    if fid not in s["fact_ids"] and fid in m().facts and m().facts[fid]["ts"] <= desk.now:
                        s["facts"].append(m().facts[fid])
                        s["fact_ids"].append(fid)
                text = rules.tidy(a.analysis_en)
                bad = rules.check_text(text, rules.story_allowed(m(), s))
                s["analysis_en"] = text if not bad else rules.analysis_template(s)
                s["flagged"] += [rules.note(f"analysis: {b}") for b in bad]
            else:
                s["analysis_en"] = rules.analysis_template(s)
        desk.trace("analyst", "analyse", f"{len(rnd.stories)} stories",
                   f"{len(got)} analyses" + note, [i for s in rnd.stories for i in s["fact_ids"]], usage, ids(rnd))
        await ctx.send_message(rnd)

    def commentator(lang):
        @executor(id=f"commentator_{lang}")
        async def write(rnd: Round, ctx: WorkflowContext[Drafts]) -> None:
            payload = desk.writer_payload(lang, rnd.stories)
            try:
                out, usage = await desk.ask(f"commentator_{lang}", payload, Lines)
                drafts = Drafts(rnd, lang, {x.story_id: x.text for x in out.lines})
            except Exception as e:  # noqa: BLE001
                usage, drafts = None, Drafts(rnd, lang, {}, f"{e!r}"[:200])
            desk.trace(f"commentator_{lang}", "draft", f"{len(rnd.stories)} stories",
                       f"{len(drafts.texts)} lines" + (f" fallback: {drafts.error}" if drafts.error else ""),
                       [i for s in rnd.stories for i in s["fact_ids"]], usage, ids(rnd))
            await ctx.send_message(drafts)
        return write

    async def judge(rnd, texts):
        """AI check of the claims without numbers; returns ({(sid, lang): issue}, judged ok, usage)."""
        if not texts:
            return {}, True, None
        payload = {"stories": [desk.card(s) for s in rnd.stories],
                   "texts": [{"story_id": sid, "lang": lang, "text": t} for (sid, lang), t in texts.items()]}
        try:
            out, usage = await desk.ask("verifier", payload, Verdicts)
        except Exception:  # noqa: BLE001 - not judged: the numbers were checked, the risk goes up
            return {}, False, None
        # a "not ok" whose issue says there is no issue is the judge contradicting itself: it passes
        return {(v.story_id, v.lang): v.issue or "unsupported claim" for v in out.verdicts
                if not v.ok and (v.story_id, v.lang) in texts and not rules.no_issue(v.issue)}, True, usage

    async def rewrite(rnd, lang, todo):
        """Ask the commentator of lang to fix the texts in todo {sid: problem}."""
        payload = desk.writer_payload(lang, [s for s in rnd.stories if s["story_id"] in todo],
                                      {sid: "; ".join(p) for sid, p in todo.items()})
        try:
            out, usage = await desk.ask(f"commentator_{lang}", payload, Lines)
            got = {x.story_id: x.text for x in out.lines if x.story_id in todo}
        except Exception as e:  # noqa: BLE001
            got, usage = {}, None
            todo = {sid: p + [f"rewrite failed: {e!r}"[:120]] for sid, p in todo.items()}
        desk.trace(f"commentator_{lang}", "rewrite", f"verifier asks to fix {', '.join(todo)}",
                   f"{len(got)} lines", [], usage, list(todo))
        return got

    @executor(id="verifier")
    async def verifier(drafts: list[Drafts], ctx: WorkflowContext[Round]) -> None:
        rnd = drafts[0].round
        by_sid = {s["story_id"]: s for s in rnd.stories}
        allowed = {sid: rules.story_allowed(m(), s) for sid, s in by_sid.items()}
        texts, attempts, problems = {}, Counter(), defaultdict(list)
        factual = set()  # texts sent back for a fact, not only for style: these raise the risk
        for d in drafts:
            for sid in by_sid:
                if sid in d.texts:
                    texts[(sid, d.lang)] = rules.tidy(d.texts[sid])
                    attempts[(sid, d.lang)] = 1
                else:
                    problems[(sid, d.lang)].append(f"no text: {d.error or 'missing'}")
        unjudged, usage_all = set(), Counter()
        for round_no in range(config.MAX_REWRITES + 1):
            last = round_no == config.MAX_REWRITES
            pending = {k: t for k, t in texts.items() if k not in problems}
            for k, t in pending.items():
                if bad := rules.check_text(t, allowed[k[0]]):
                    problems[k] += bad
            # style goes back to the writer while there are rounds left; the last round only judges facts
            style = {} if last else {k: st for k, t in pending.items() if k not in problems
                                     and (st := rules.style_issues(t, k[1], by_sid[k[0]]["kind"]))}
            to_judge = {k: t for k, t in pending.items() if k not in problems and k not in style}
            notes = {(sid, "analysis"): st["analysis_en"] for sid, st in by_sid.items()} if round_no == 0 else {}
            issues, judged, usage = await judge(rnd, {**to_judge, **notes})
            usage_all.update(usage or {})
            if not judged:
                unjudged |= set(to_judge)
            for sid, lang in [k for k in issues if k[1] == "analysis"]:  # a wrong analysis falls back to the facts
                by_sid[sid]["analysis_en"] = rules.analysis_template(by_sid[sid])
                by_sid[sid]["flagged"].append(rules.note(f"analysis: claim: {issues.pop((sid, lang))}"))
            for k, issue in issues.items():
                problems[k].append(f"claim: {issue}")
            fix = {k for k in problems if k in texts} | set(style)
            if not fix or last:
                break
            for k in fix:
                if problems.get(k):
                    factual.add(k)
                for p in problems.get(k, []):
                    by_sid[k[0]]["flagged"].append(rules.note(f"{k[1]}: {p}"))
            jobs = {lang: {sid: problems.get((sid, l2), []) + style.get((sid, l2), []) for sid, l2 in fix if l2 == lang}
                    for lang in rules.LANGS}
            results = await asyncio.gather(*(rewrite(rnd, lang, todo) for lang, todo in jobs.items() if todo))
            for (lang, todo), got in zip([(lg, t) for lg, t in jobs.items() if t], results):
                for sid in todo:
                    texts.pop((sid, lang), None)
                    problems.pop((sid, lang), None)
                    if sid in got:
                        texts[(sid, lang)] = rules.tidy(got[sid])
                        attempts[(sid, lang)] += 1
                    else:
                        problems[(sid, lang)].append("no rewrite")
        statuses = Counter()
        for sid, s in by_sid.items():
            status = "pass"
            for lang in rules.LANGS:
                k = (sid, lang)
                if k in texts and k not in problems:
                    s["texts"][lang] = texts[k]
                    desk.openings[lang].append(" ".join(texts[k].split()[:3]))
                    if attempts[k] > 1:
                        status = "rewritten" if status == "pass" else status
                else:
                    s["texts"][lang] = rules.template(m(), s, lang)
                    s["flagged"] += [f"{lang}: {p}" for p in problems.get(k, [])]
                    status = "template"
            s["unjudged"] = any((sid, lang) in unjudged for lang in rules.LANGS)
            s["style_only"] = not any((sid, lang) in factual for lang in rules.LANGS)
            s["flagged"] = list(dict.fromkeys(rules.note(x) for x in s["flagged"]))
            s["verifier"] = {"status": status, "attempts": max(attempts[(sid, lang)] for lang in rules.LANGS),
                             "flagged": s["flagged"]}
            desk.finish(s)
            statuses[status] += 1
        usage_all["calls"] = usage_all.get("calls", 0)
        desk.trace("verifier", "check", f"{len(texts)} texts in {len(rules.LANGS)} languages",
                   ", ".join(f"{k} {v}" for k, v in statuses.items()) + (" (claims not judged)" if unjudged else ""),
                   [i for s in rnd.stories for i in s["fact_ids"]], dict(usage_all), ids(rnd))
        await ctx.send_message(rnd)

    @executor(id="director")
    async def director(rnd: Round, ctx: WorkflowContext[Round, Round]) -> None:
        rnd.cues = desk.director.plan(rnd.stories)
        desk.trace("director", "cue", f"{len(rnd.stories)} stories",
                   f"{len(rnd.cues)} cues for {len({c['audience'] for c in rnd.cues})} audiences",
                   [i for s in rnd.stories for i in s["fact_ids"]], story_ids=ids(rnd))
        await ctx.yield_output(rnd)

    writers = [commentator(lang) for lang in rules.LANGS]
    return (WorkflowBuilder(name="studiodesk-stories", start_executor=story_finder)
            .add_edge(story_finder, analyst)
            .add_fan_out_edges(analyst, writers)
            .add_fan_in_edges(writers, verifier)
            .add_edge(verifier, director)
            .build())


def build_agents(desk, client, tools):
    """The four AI agents; the story finder and the analyst can call the MCP tools."""
    opts = {"reasoning": {"effort": "minimal"}, "store": False}
    names = ["story_finder", "analyst", "verifier"] + [f"commentator_{lang}" for lang in rules.LANGS]
    for name in names:
        role = "commentator" if name.startswith("commentator") else name
        text = INSTRUCTIONS[role].replace("{language_name}", LANGUAGE_NAMES[name[-2:]]).replace(
            "{style}", STYLE[name[-2:]]) if role == "commentator" else INSTRUCTIONS[role]
        desk.agents[name] = Agent(client, text, name=name, tools=tools.get(name), default_options=opts,
                                  middleware=[desk.audit_middleware(name)])


HEARTBEAT_S = 1.0


class WindowClock(MatchClock):
    """MatchClock limited to [from_ts, to_ts]; waiting starts at from_ts, not at kick-off.

    It also ticks every HEARTBEAT_S of match time between events, so a fact released in a pause
    (the score fact during a goal celebration, a window end) is picked up within a second.
    """

    def __init__(self, match_id, speed, conn, from_ts=0.0, to_ts=None):
        super().__init__(match_id, speed, conn)
        self.full_end = self.end
        self.offset = from_ts
        self.end = self.end if to_ts is None else min(self.end, to_ts)
        events = [e for e in self.events if from_ts <= e["ts"] <= self.end]
        ticks, t = [], from_ts
        for ts in [e["ts"] for e in events] + [self.end]:
            while t + HEARTBEAT_S < ts:
                t += HEARTBEAT_S
                ticks.append({"ts": t, "type_name": "tick"})
            t = max(t, ts)
        self.events = sorted(events + ticks, key=lambda e: e["ts"])

    def _wait(self, ts, start):
        return super()._wait(ts - self.offset, start)


async def run_batch(desk, workflow, batch):
    if batch.candidates:
        try:
            rnd = (await workflow.run(batch)).get_outputs()[-1]
        except Exception as e:  # noqa: BLE001 - the broadcast goes on with rules and templates
            stories = [desk.new_story(c, 0.5, c["note"]) for c in _rule_picks(batch.candidates)]
            stories = [template_story(desk, s, f"workflow error: {e!r}"[:200]) for s in stories]
            rnd = Round(batch, stories, desk.director.plan(stories))
            desk.trace("director", "fallback", "workflow failed", f"{len(stories)} template stories",
                       [i for s in stories for i in s["fact_ids"]], story_ids=[s["story_id"] for s in stories])
        desk.save(rnd)
    if batch.window_end is not None:
        desk.save_cues(desk.director.window_cue(batch.window_end))


async def run_match(match_id, client, rt, *, speed=0.0, from_ts=None, to_ts=None, model_name=None, log=print):
    """Run the agents over one match (or a window of it); writes stories, cues, traces and audit to rt."""
    run_id = f"R-{datetime.now(timezone.utc):%Y%m%d%H%M%S}-{uuid.uuid4().hex[:4]}"
    t0 = time.perf_counter()
    from_ts = from_ts or 0.0
    conn = db.connect(mcp_server.DB_PATH, readonly=True)
    clock = WindowClock(match_id, speed, conn, from_ts, to_ts)
    conn.close()
    try:
        async with mcp_session() as session:
            desk = Desk(match_id, session, rt, run_id, model_name or config.MODEL_DEPLOYMENT)
            tools = {}
            for name, allowed in AGENT_TOOLS.items():
                tools[name] = InProcessMCPTool(name="studiodesk", session=session, allowed_tools=allowed,
                                               load_prompts=False, parse_tool_results=_tool_text)
                await tools[name].connect()
            build_agents(desk, client, tools)
            workflow = build_workflow(desk)
            await desk.start(from_ts)
            async for _ in clock:
                if batch := await desk.ingest(clock.now):
                    await run_batch(desk, workflow, batch)
                    log(f"{rules.minute(clock.now, 2 if desk.m.p1 and clock.now > desk.m.p1 else 1, desk.m.p1 or 1e9)}' "
                        f"stories {desk.story_n} calls {desk.calls} cost ${desk.cost:.4f}")
            if batch := await desk.ingest(clock.now, full_time=clock.end >= clock.full_end):
                await run_batch(desk, workflow, batch)
    finally:
        mcp_server.set_clock(None)
    statuses = Counter(s["verifier"]["status"] for s in desk.queue)
    return {"run_id": run_id, "stories": len(desk.queue), "verifier": dict(statuses),
            "default_status": dict(Counter(s["default_status"] for s in desk.queue)),
            "kinds": dict(Counter(s["kind"] for s in desk.queue)), "cues": desk.cue_n, "model_calls": desk.calls,
            "tokens_in": desk.tokens_in, "tokens_out": desk.tokens_out, "cost_usd": round(desk.cost, 4),
            "wall_s": round(time.perf_counter() - t0, 1),
            "latency_ms": {a: {"calls": len(v), "mean": round(sum(v) / len(v)), "max": max(v)}
                           for a, v in sorted(desk.latency.items())}}
