"""The agents workflow (docs/CONTRACT.md, Runtime records), on Microsoft Agent Framework.

    MatchClock --event--> Desk.ingest (facts through MCP) --Batch--> workflow:

        story_finder -> analyst -> commentator_en ┐
                                -> commentator_it ├-> verifier -> director -> stories + cues
                                -> commentator_es ┘

A batch starts when the clock releases a goal, a sprint above 34 km/h, a big chance (a shot judged
rules.SETTLE_S after it is hit) or the end of a 5-minute window. Agents read the match only through the MCP server (studiodesk/mcp_server.py), served in
process over the MCP protocol on memory streams so its clock moves with ours. Any agent that fails
or times out is replaced by rules and template sentences: the broadcast never waits.
"""
import asyncio
import contextvars
import copy
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
from opentelemetry import trace

from .. import config, db, mcp_server
from ..clock import MatchClock
from . import rules
from . import phrasebook
from .llm import Analyses, Lines, Picks, Verdicts, cost_usd

MAX_PICKS = 4          # stories per batch besides the must-tell ones
TOOL_RESULT_CHARS = 6000
RETRY_PAUSES_S = (3.0, 8.0)  # waits before the second and third try of a rate-limited call

INSTRUCTIONS = {
    "story_finder": (
        "You are the story finder of a football broadcast desk. The user message is JSON with the match "
        "minute, candidate moments found by rules, and the stories already told. Pick the moments worth a "
        "graphic. `score_after` is the score after the moment, leader first. Rules per kind:\n" + "\n".join(f"- {k}: {v}" for k, v in rules.RULES.items()) +
        f"\nPick at most {MAX_PICKS} besides goals, comebacks and recaps. You may call the studiodesk tools "
        "(always with match_id and a narrow kind or time range) to check context, but usually the candidates "
        "are enough. The angle is one short plain sentence, under 15 words, on what makes the moment "
        "interesting: the football reason (a run behind the line, a change of shape, a spell of pressure), "
        "not the score and not a list of numbers. Claim only what the candidate says: `outcome` is "
        "what happened to the shot. Do not start the angle the way the angles in `recent_stories` start. "
        "The line on air is composed by code; you choose how it sounds. `tone` is \"lively\" for a moment "
        "that lifts a crowd (a goal, a comeback, a loud shot, a chance from close in) and \"calm\" otherwise. "
        "`focus` is one of the candidate's `focus_options` (where the shot came from, how far out, how hard "
        "it was hit), the one that makes the moment; \"\" when the candidate has none. "
        "Reply with JSON: picks = [{candidate_id, confidence 0..1, angle, tone, focus}]."),
    "analyst": (
        "You are the analyst of a football broadcast desk. For each story in the JSON, explain in one or two "
        "sentences of plain English what the numbers show, citing the fact ids you rely on in square brackets, e.g. "
        "[F-SHOT_SPEED-000031]. Use only numbers that appear in the facts, written with digits as they appear "
        "there, never in words. You may call the studiodesk tools (with match_id and a kind, player or time "
        "range) to find one more supporting fact; cite it if you use it. The citations are for the desk's "
        "evidence and are removed before anyone reads the text. Claim no detail the facts do not give (no "
        "post, cross, volley, deflection, assist, foot side, 'behind the defence'). `score_after` is the score after the "
        "moment, leader first; mention it only for a goal, comeback or recap, once, in a plain sentence of "
        "its own ('Redwick Wanderers lead 2-1.', 'It is level at 1-1.'), never as 'the score described as', "
        "'making the score with' or 'the score remained X lead 2-1'. Follow `trend` when the story has one: "
        "never 'steadily' or 'gradually' for values that went up and down, never 'control of play'. Never "
        "write 'this matters because' or 'why it matters'; state what happened. Claim no effect on the "
        "opponent (forcing errors, leaving space, pinning them back): no fact measures one. Pass accuracy is the share of "
        "passes completed, never possession. `outcome` is what happened to the shot. `home` and `away` name "
        "the teams' roles. Say each thing once. No em or en dashes (a hyphen in a score like 2-1 is fine). "
        "Reply with JSON: stories = [{story_id, analysis_en, fact_ids}]."),
    "commentator": (
        "You are a television football commentator writing the on-screen line in {language_name}. {style} "
        "For each story in the JSON write one or two short sentences, the way you would say them over the "
        "replay (a recap may take three). Rules:\n"
        "- Numbers: only the strings in the story's `numbers`, written with digits as listed (a decimal "
        "may be rounded to a whole number). Never a number in words, never a count (no 'two goals', "
        "'hat-trick', 'doppietta', 'tres'), no other units. Minutes as listed, in a full phrase ('in the "
        "41st minute', 'al minuto 41', 'en el minuto 41'; 45+2' is stoppage time).\n"
        "- Score: only when the story has `score`, once at most, written exactly as `score.write` (in "
        "English the leader's goals first; in Italian and Spanish the home side's goals first, as on the "
        "scoreboard), with `score.leader` named right next to it ('Ostwick FC lead 2-1', 'il Tarnby "
        "Harriers passa in vantaggio, 0-1', 'el Ostwick FC se pone por delante, 0-1'); a level score needs "
        "no name. A club is singular in Italian and Spanish: 'il Brightwater rimonta', 'el Brightwater "
        "remonta', never 'rimontano', 'remontan'. A story without `score` never "
        "mentions it. A recap always gives it. A goal 'takes the lead' (passa in vantaggio, se pone por "
        "delante) only when `score.before` is level; when the scorer already led it 'extends the lead' "
        "(allunga, amplía la ventaja).\n"
        "- Name the player as in `name` (when the story has a player), otherwise the team. `home` and "
        "`away` say which team is which: 'the visitors' is only ever the away team. In Italian and Spanish "
        "`team`, `home` and `away` come with their article (il Redwick Wanderers, l'Harbour Vale FC, el "
        "Ostwick FC): keep it, and merge it with a preposition (del, al, dell'; del, al), never "
        "both ('del el', 'di il' and 'desde en el' are wrong).\n"
        "- Say only what the story says. `outcome` is what happened to the shot (goal, saved, wide, over the "
        "bar, blocked): say exactly that. A shot that did not go in never 'smashes in', 'slides under', "
        "'tucks in' or 'beats the keeper'; a wide shot is not over the bar. The keeper (portiere, portero) "
        "appears only when the shot was saved: a blocked, wide or over shot never 'tests the keeper' (mette "
        "alla prova il portiere). `header` true means a header "
        "(never 'fires' or 'strikes' it), false means a kick. Nothing else about the shot is known: no post "
        "or crossbar, corner of the net, near or far post, cross, pull-back, volley, rebound, deflection, "
        "assist, technique (side-foot, curler, bends, toe-poke, turns and shoots, di piatto, a giro, de rosca, "
        "colocado), how easy the save was (comfortably), which foot (destro, "
        "sinistro, diestra, zurda; unless the label says left or right foot), 'behind the defence' or "
        "'forcing errors'.\n"
        "- Where the shot came from: say `place` (or nothing about it). 'Edge of the box' (dal limite, la "
        "frontal) only when `place` says so; 'point-blank' (a bruciapelo, a bocajarro) only up to 6 m; "
        "'close range' up to 11 m; 'from distance' or 'from outside the box' only when the label says outside "
        "the box, and once ('from distance' with 'long-range' or the metres says it twice); 'middle of the "
        "box', 'central', 'straight on' only when `place` says so. A distance is exact: no 'about' or 'circa' "
        "before it. In Italian and Spanish use your own words, never English ones.\n"
        "- Pass accuracy is the share of passes completed, never possession; tie each value to its team.\n"
        "- Momentum is how much a team is on top (inerzia, empuje), never possession, domination or "
        "pressing; pressing is how hard a team presses, never where on the pitch (no 'press high', 'pressa "
        "alto', 'presión alta'), with no turnovers or 'carrier'. `trend` is the path of the values, ready "
        "in your language: follow it, you may reword it but never change its direction. When it rose and "
        "then fell, say both; never 'take control', 'sempre più' or 'toma el mando' for a run that ends "
        "lower. 'Sustained', 'constant', 'costante', 'sostenido' only when `trend` has two or more values "
        "that stay up; never for one value. At most two or three values, in time order.\n"
        "- A defensive line: `line` says if it went higher (further from its own goal) or deeper; `width` "
        "says if the team got wider or narrower (wider is never 'more compact').\n"
        "- Claim no effect on the opponent (forcing mistakes, leaving defenders behind, pinning them back, "
        "more shots, more space), and no sprint that beats or gets past the defence ('powers clear', "
        "'supera la difesa', 'más allá de la defensa'): no fact measures one.\n"
        "- If you are not sure a phrase is what a native commentator says, leave it out.\n"
        "- Say each thing once: no word or idea twice in a line, no restating the story kind, no 'according "
        "to the data'. Loud verbs (rips, lashes, thunderbolt, rocket, che botta, bomba, sassata, bordata, "
        "trallazo, zambombazo, misil) once a match at most, and only for a shot of 100 km/h or more.\n"
        "- Vary the openings: do not start the way the lines in `recent_openings` start, and do not start "
        "with the minute or the team name every time.\n"
        "- No em or en dashes (a hyphen in a score like 2-1 is fine).\n"
        "If `feedback` is present, rewrite that story to fix exactly that problem. Reply with JSON: "
        "lines = [{story_id, text}]."),
    "verifier": (
        "You check on-screen football text against the facts. Code has checked every number: that it exists in "
        "the facts, its rounding and how it is written; never flag a number for its format. You check that each number is attached to the right fact, player and team (a sprint speed "
        "told as a shot speed, or two teams' pass accuracy swapped, is wrong), and every claim without numbers: "
        "who scored, who leads (`score_before` and `score_after`, leader first), what happened to the shot "
        "(`outcome`: a saved shot told as a goal, or a wide one told as saved, is wrong), home and away roles "
        "(`home`, `away`: 'the visitors' are the away team), possession (there is no possession fact: pass "
        "accuracy is not possession), and invented events (a post, a cross or a header the story does not "
        "give; `outcome`, `header` and the shot label's box and body part come from the match events and count "
        "as facts; a post, top corner, cross, volley, deflection, assist, foot side, 'behind the defence' or "
        "'forcing errors' the facts do not give is invented). An effect on the opponent (forcing mistakes, "
        "leaving defenders behind, pinning them back, more space) is invented: no fact measures one. Momentum "
        "and press intensity are different facts: momentum values told as pressing, or the reverse, are "
        "wrong; press intensity says how hard a team presses, not where. A trend word must fit `trend`: a "
        "run that ends lower never 'takes control'. Score-state words (leading, in front, trailing, "
        "in vantaggio, por delante) must agree with `score_after`. After a goal the scorer's "
        "team may still trail: 'pulls one back, 2-1' is right when `score_after` says the other team leads 2-1. "
        "Colour and interpretation (a fine strike, a big moment, a "
        "nervy spell) are fine. Never flag style, wording or language (each text is in its own language). Texts with lang `analysis` are the analyst's "
        "notes: judge them the same way. Reply with JSON: verdicts = [{story_id, lang, ok, issue}], exactly "
        "one verdict per text. ok is true when you found no problem, and then issue is empty; ok is false "
        "only when you can name the wrong claim, and then issue is one short sentence naming it. Decide "
        "before you write: if a claim turns out to be supported, the text is ok; never reason aloud in issue."),
}
STYLE = {
    "en": "Write in British English (pitch, keeper, nil, the box, colour), like a Saturday-afternoon TV "
          "commentator: crisp, understated, active verbs. Examples: 'Vellacott heads it wide from the middle "
          "of the box.' 'Ostwick FC pull one back, but Redwick still lead 2-1.'",
    "it": "Scrivi in italiano da telecronista (rete, conclusione, palla, in vantaggio, area), con frasi native "
          "e non tradotte dall'inglese; i decimali con la virgola (96,4). Mai parole inglesi come win, blocked, "
          "pass accuracy, momentum: si dice vince, respinto, passaggi riusciti, inerzia della partita (pressing va "
          "bene). Le squadre hanno l'articolo: il Redwick, l'Harbour Vale, dello Sporting. Mai 'sul minuto', "
          "'vs', 'mezzo tempo', 'con il minuto'. Il risultato si scrive come sul tabellone, prima i gol della "
          "squadra di casa (0-1 se vince quella in trasferta). Davanti a un numero che inizia per vocale "
          "l'articolo si apostrofa: dall'1,8, all'8, all'11, dell'80. Esempi: 'Colpo di testa di Ferrandi "
          "dentro l'area, il portiere para.' 'Conclusione di Okowande da fuori area, centrale: para il "
          "portiere.' 'Gol di Duarte: il Redwick accorcia, ma l'Ostwick resta avanti, 1-2.' 'Rimonta del "
          "Brightwater: pareggia 2-2.' 'L'inerzia passa al Calderwick: dall'1,8/10 al minuto 20 a 7,3/10 "
          "all'80.' 'Il Tarnby alza la linea difensiva.'",
    "es": "Escribe en español de España como un narrador de televisión (gol, disparo, el área, por delante), "
          "con frases nativas, no traducidas del inglés; decimales con coma (96,4). Nunca palabras inglesas como "
          "win, blocked, pass accuracy, momentum o pressing: se dice gana, rechazado, precisión en el pase, empuje, "
          "presión. Los equipos llevan artículo: el Redwick, del Harbour Vale, al Ostwick. Nunca "
          "'dominio', 'vs', 'compactación', 'arco' (es la portería) ni 'sprinta' (es 'esprinta'). El resultado "
          "se escribe como en el marcador, primero los goles del local (0-1 si gana el visitante). Un club "
          "es singular: 'el Brightwater remonta', nunca 'remontan'. Ejemplos: 'Remate de cabeza de "
          "Ferrandi dentro del área y para el portero.' 'Disparo de Okowande desde fuera del área, centrado: "
          "lo para el portero.' 'Gol de Duarte: el Redwick recorta distancias, pero el Ostwick sigue por "
          "delante, 1-2.' 'Dunmarrow esprinta a 35,8 km/h.' 'Disparo a 25,4 m de la portería.' 'El empuje "
          "es del Calderwick: de 4,1/10 en el minuto 30 a 7,3/10 en el 40.' 'El Tarnby adelanta su línea "
          "defensiva.'",
}
LANGUAGE_NAMES = rules.LANGUAGES
AGENT_TOOLS = {"story_finder": ["get_events", "get_facts", "get_player"], "analyst": ["get_facts", "get_fact"]}


# --- MCP ---------------------------------------------------------------------------------------

class InProcessMCPTool(MCPTool):
    """Agent Framework MCP tool source over an existing MCP client session (memory transport)."""

    def get_mcp_client(self):  # the session is always passed in
        raise NotImplementedError



def _n(k, one, many=None):
    """"1 story", "2 stories": a count with its noun for the traces."""
    return f"{k} {one if k == 1 else many or one + 's'}"

def _tool_text(result):
    if result.structuredContent is not None:
        data = result.structuredContent.get("result", result.structuredContent)
        text = json.dumps(data, ensure_ascii=False)
    else:
        text = "".join(getattr(c, "text", "") for c in result.content)
    text = text if len(text) <= TOOL_RESULT_CHARS else text[:TOOL_RESULT_CHARS] + " ... [truncated: narrow the query]"
    if (u := _ASK_USAGE.get()) is not None:  # sent back to the model: a call cut after it is billed for it too
        u["pending_chars"] = u.get("pending_chars", 0) + len(text)
    return text


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
    used: dict | None = None  # desk.used before this round went on air, for the writers' style checks


@dataclass
class Drafts:
    round: Round
    lang: str
    texts: dict
    error: str | None = None


# usage of the ask() running in this task: the commentators run at once, so deltas of the
# shared counters would charge each one with the others' calls
_ASK_USAGE = contextvars.ContextVar("ask_usage", default=None)


def _charge(tokens_in, tokens_out, cost):
    if (u := _ASK_USAGE.get()) is not None:
        u["calls"] += 1
        u["tokens_in"] += tokens_in
        u["tokens_out"] += tokens_out
        u["cost_usd"] += cost


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
        self.shots_upto = 0.0                # shots up to here were looked at for big chances
        self.chances = {}                    # big chances offered per 5-minute window
        self.openings = defaultdict(list)    # lang -> first words of the lines on air, so openings vary
        self.used = defaultdict(lambda: {"loud": set(), "openings": set()})  # lang -> what style_issues rations
        self.spent = set()                   # phrasebook openers already on air: each one once a match
        self.slots = asyncio.Semaphore(config.MAX_PARALLEL_CALLS)
        self.first = asyncio.Semaphore(1)    # the story finder's own slot: on air does not queue behind a round's tail
        self.tails = []                      # live: the rounds' AI work still running after they went on air
        self.flying = 0                      # agent runs holding a slot: the call ceiling counts them before they end
        self.prompt_chars = {}               # agent -> length of its instructions, for a cut call's estimate

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
        _charge(tin, tout, c)
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

    def record_timeout(self, agent, tokens_in):
        """A call cut by the timeout is still billed: count its input tokens (an estimate) in the audit."""
        c = cost_usd({"input_token_count": tokens_in})
        self.calls += 1
        self.tokens_in += tokens_in
        self.cost += c
        _charge(tokens_in, 0, c)
        db.insert(self.rt, "audit", {"session_id": None, "at": _now_iso(), "actor": agent, "action": "model_call_timeout",
                                     "match_id": self.match_id, "story_id": None, "model": self.model_name,
                                     "tokens_in": tokens_in, "tokens_out": 0, "cost_usd": round(c, 6),
                                     "detail": {"run_id": self.run_id, "timeout_s": config.AGENT_TIMEOUT_S,
                                                "match_ts": self.now, "tokens_in_estimated": True}})
        self.rt.commit()

    def over_budget(self):
        """Past a ceiling, counting the runs in flight: each as one call at the mean cost of a call so far."""
        flying_cost = self.flying * self.cost / self.calls if self.calls else 0.0
        return (self.cost + flying_cost >= config.RUN_MAX_COST_USD
                or self.calls + self.flying >= config.RUN_MAX_CALLS)

    async def ask(self, agent, payload, schema):
        """One agent run with a timeout, at most MAX_PARALLEL_CALLS at once, retried after a rate limit
        (twice) or a timeout (once); returns (parsed output, usage summed over its model calls). Past the
        run's cost or call ceiling it raises at once, so the caller falls back to rules and templates."""
        t0, mine = time.perf_counter(), {"calls": 0, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0}
        token = _ASK_USAGE.set(mine)
        try:
            out = await self._ask(agent, payload, schema)
        except Exception as e:
            mine.pop("pending_chars", None)
            e.usage = {**mine, "latency_ms": round((time.perf_counter() - t0) * 1000)}  # its failed calls were paid too
            raise
        finally:
            _ASK_USAGE.reset(token)
        mine.pop("pending_chars", None)
        return out, {**mine, "latency_ms": round((time.perf_counter() - t0) * 1000)}

    async def _ask(self, agent, payload, schema):
        text = json.dumps(payload, ensure_ascii=False)
        timeouts = 0
        mine = _ASK_USAGE.get()
        for pause in (*RETRY_PAUSES_S, None):
            try:
                async with self.first if agent == "story_finder" else self.slots:
                    if self.over_budget():  # checked in the slot, with the runs still in flight counted
                        raise RuntimeError("run budget reached")
                    mine["pending_chars"] = self.prompt_chars.get(agent, 0) + len(text)  # what the call is sent
                    self.flying += 1
                    try:
                        resp = await asyncio.wait_for(self.agents[agent].run(text, options={"response_format": schema}),
                                                      config.AGENT_TIMEOUT_S)
                    finally:
                        self.flying -= 1
                break
            except Exception as e:  # noqa: BLE001 - retried or raised to the caller's fallback
                why = rules.brief_error(e)
                if why == "timed out" and isinstance(e, (asyncio.TimeoutError, TimeoutError)):
                    self.record_timeout(agent, mine.pop("pending_chars", 0) // 4)  # instructions, input, tool results
                    timeouts += 1
                if pause is None or why not in ("timed out", "rate limited") or timeouts > 1:
                    raise
                await asyncio.sleep(pause)
        return schema.model_validate_json(resp.text)

    # views for prompts
    def brief(self, f):
        label = self.goal_label(f) if f["kind"] == "score" else rules.display_label(f)
        return {"fact_id": f["fact_id"], "kind": f["kind"], "value": f["value"], "unit": f["unit"],
                "label": label, "minute": rules.stoppage(self.m.minute_of(f), f["period"]),
                "team": self.m.team_name(f["team_id"]), "player": self.m.player_name(f["player_id"])}

    def goal_label(self, f):
        """Who scored and the score after, leader first: a goal that pulls one back says the other side leads."""
        leader, s = self.m.lead(f["ts"])
        team = self.m.team_name(f["team_id"])
        if leader is None:
            return f"Goal for {team}, level at {s}"
        return f"Goal for {team}, who lead {s}" if leader == f["team_id"] else \
            f"Goal for {team}; {self.m.team_name(leader)} still lead {s}"

    def who_leads(self, ts):
        """The score in words, leader first: "Redwick Wanderers lead 2-1" or "Level at 1-1"."""
        leader, s = self.m.lead(ts)
        return f"Level at {s}" if leader is None else f"{self.m.team_name(leader)} lead {s}"

    def card(self, s, analysis=False, writer=None, judge=False):
        """A story for a prompt: who is home and away, what happened to the shot, which way the numbers
        went. For a commentator (writer=lang): the allowed numbers, the score only when it is the point of
        the story, and how the last lines began. The judge also sees the facts the analyst cited."""
        side = {self.m.home["team_id"]: "home", self.m.away["team_id"]: "away"}
        # writers get the values to read (a shot's label carries its box, body part and outcome)
        facts = rules.text_facts(s) if writer else rules.story_facts(s) if judge else s["facts"]
        lang = writer or "en"
        name = (lambda n: rules.club(n, writer)) if writer in ("it", "es") else (lambda n: n)  # noqa: E731
        team = self.m.team_name(s["team_id"])
        c = {"story_id": s["story_id"], "kind": s["kind"], "minute": self.m.minute_label(s["ts"]),
             "team": name(team) if team else team, "team_side": side.get(s["team_id"]),
             "player": self.m.player_name(s["player_id"]), "home": name(self.m.home["name"]),
             "away": name(self.m.away["name"]), "angle": s.get("angle", ""), "facts": [self.brief(f) for f in facts]}
        if (shot := rules.shot_info(s)) and shot["outcome"]:
            words = rules.OUTCOMES.get(shot["outcome"], (shot["outcome"],) * 3)
            c["outcome"] = words[rules.LANGS.index(lang)]
            c["header"] = shot["header"]
            if where := rules.place_text(shot["place"], lang):
                c["place"] = where
        # the path of the values as a ready phrase: the writers follow it, the judge checks against it
        if path := rules.trend(self.m, s, lang):
            c["trend"] = path["say"]
        if line := rules.line_path(s):
            c["line"] = line["direction"]
        if width := rules.width_change(s):
            c["width"] = width
        if writer is None:
            c["score_before"] = self.who_leads(s["ts"] - 1e-3)
            c["score_after"] = self.who_leads(s["ts"])
        else:
            c["numbers"] = rules.number_list(self.m, s, writer)
            if s["player_id"]:
                c["name"] = self.m.required_name(s["player_id"])  # the surname, or the full name when shared
            if s["kind"] in rules.SCORE_KINDS:
                after = self.who_leads(s["ts"])
                if s.get("phase") == "ft":  # the match is over: a win, not a lead
                    after = after.replace(" lead ", " win ").replace("Level at", "It ended")
                leader = self.m.lead(s["ts"])[0]
                c["score"] = {"before": self.who_leads(s["ts"] - 1e-3), "after": after,
                              "write": rules.score_text(self.m, s["ts"], writer),
                              "leader": name(self.m.team_name(leader)) if leader else None}
        if s["kind"] == "recap":
            c["phase"] = rules.TITLES[s["phase"]][rules.LANGS.index(lang)]
            c["pass_accuracy"] = {self.m.team_name(f["team_id"]): f"{rules.fmt(f['value'], lang)}%"
                                  for f in s["facts"] if f["kind"] == "pass_accuracy"}
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
        self.shots_upto = from_ts

    async def ingest(self, now, final=False, full_time=False):
        """Read the facts released since the last call; return a Batch when something is worth a look."""
        self.now = now
        mcp_server.set_clock(now)
        new = [f for f in await self.mcp("get_facts", from_ts=self.polled) if f["fact_id"] not in self.m.facts]
        self.polled = now
        for f in new:
            self.m.facts[f["fact_id"]] = f
        if any(f["player_id"] and f["player_id"] not in self.m.players for f in new):  # a substitute came on
            self.m.update(await self.mcp("get_match_info"))
        cands = []
        for f in new:
            if f["kind"] == "score":  # the shot that scored, for where it was taken from
                shots = await self.mcp("get_events", from_ts=f["ts"] - 60.0, to_ts=f["ts"], type_name="shot")
                cands += rules.goal_candidates(self.m, f, next(
                    (e for e in shots if e["event_id"] in f["source_event_ids"]), None))
            elif f["kind"] == "sprint_speed":
                cands += rules.sprint_candidates(f)
        if (settled := now - rules.SETTLE_S) > self.shots_upto:  # big chances, once their outcome is known
            shots = await self.mcp("get_events", from_ts=self.shots_upto + 1e-6, to_ts=settled, type_name="shot")
            # a shot before a whistle already blown would air after "Half-time": not told
            shots = [e for e in shots if not (self.m.p1 is not None and e["ts"] <= self.m.p1 < now)]
            if shots:
                saves = await self.mcp("get_events", from_ts=shots[0]["ts"], to_ts=now, type_name="keeper_save")
                cands += rules.chance_candidates(self.m, shots, saves, self.chances)
            self.shots_upto = settled
        window_end = max((f["ts"] for f in new if f["kind"] == "momentum"), default=None)
        if window_end is not None:
            if self.m.p1 is None:
                self.m.update(await self.mcp("get_match_info"))
            cands += rules.window_candidates(self.m, self.last_window, window_end, self.shifted, self.queue)
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

    def new_story(self, c, confidence, angle, tone=None, focus=None):
        self.story_n += 1
        tone = tone if tone in phrasebook.TONES else None  # anything else: the phrasebook's own choice
        focus = focus if focus in phrasebook.focus_options(c) else None
        # its own copy of the facts: graphics, templates and trends read only the candidate's facts,
        # the ones the analyst cites go to "cited"
        return {**c, "story_id": f"S-{self.story_n:06d}", "confidence": confidence, "angle": rules.tidy(angle),
                "facts": list(c["facts"]), "cited": [],
                "fact_ids": [f["fact_id"] for f in c["facts"]], "analysis_en": "", "texts": {}, "flagged": [],
                "tone": tone, "focus": focus}

    def on_air(self, s):
        """Put the phrasebook's lines in s["texts"], or the template's when no phrasebook line passes;
        returns what the verifier record says about them."""
        texts, opener = phrasebook.compose(self.m, s, s.get("tone"), s.get("focus"), self.spent, self.used)
        if not texts:
            s["texts"] = {lang: rules.template(self.m, s, lang) for lang in rules.LANGS}
            return {"on_air": "template", "opener": None}
        s["texts"] = texts
        phrasebook.cite_again(self.m, s, texts)
        for lang, t in texts.items():
            self.openings[lang].append(" ".join(t.split()[:3]))
            self.used[lang]["openings"].add(rules.opening(t))
            self.used[lang]["loud"] |= rules.loud_words(t, lang)
        if opener and opener not in phrasebook.REUSABLE:
            self.spent.add(opener)
        return {"on_air": "phrasebook", "opener": opener}

    def finish(self, s):
        s["risk"] = rules.risk(s)
        s["default_status"] = rules.default_status(s["risk"])
        return s

    def save(self, rnd):
        for s in rnd.stories:
            s["default_status"] = "needs_review"  # until Content Safety passes it (agents/safety.check_match)
            db.insert(self.rt, "stories", {
                "match_id": self.match_id, "story_id": s["story_id"], "ts": s["ts"], "kind": s["kind"],
                "team_id": s["team_id"], "player_id": s["player_id"], "risk": s["risk"],
                "default_status": s["default_status"], "fact_ids": s["fact_ids"],
                "evidence_event_ids": s["evidence_event_ids"], "analysis_en": s["analysis_en"], "texts": s["texts"],
                "verifier": s["verifier"], "safety": "not_checked", "run_id": self.run_id})
            self.queue.append(s)
        self.save_cues(rnd.cues)

    def update(self, rnd):
        """A round already on air gets what the AI tail added: the analysis, the cited facts, the verifier's record."""
        at = {s["story_id"]: i for i, s in enumerate(self.queue)}
        for s in rnd.stories:
            s["default_status"] = "needs_review"  # until Content Safety passes it, as in save
            self.queue[at[s["story_id"]]] = s
            self.rt.execute("UPDATE stories SET risk = ?, fact_ids = ?, analysis_en = ?, verifier = ? "
                            "WHERE match_id = ? AND story_id = ? AND run_id = ?",
                            (s["risk"], json.dumps(s["fact_ids"]), s["analysis_en"],
                             json.dumps(s["verifier"], ensure_ascii=False), self.match_id, s["story_id"], self.run_id))
        self.rt.commit()

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


def template_story(desk, s, reason, air=None):
    air = air or desk.on_air(s)
    s["analysis_en"] = s["analysis_en"] or rules.analysis_template(desk.m, s)
    what = "Phrasebook line used, no AI proposal" if air["on_air"] == "phrasebook" else "Fact-only sentence used"
    s["verifier"] = {"status": "template", "attempts": 0,
                     "flagged": [rules.note(f"{what}: {rules.reason(reason)}.")], **air, "analysis_judged": False}
    return desk.finish(s)


def build_workflow(desk):
    """Two workflows: on air (story finder, then the director with the phrasebook's lines) and the AI tail
    that follows it (analyst, commentators, verifier), which only adds to the desk."""
    m = lambda: desk.m  # noqa: E731
    ids = lambda rnd: [s["story_id"] for s in rnd.stories]  # noqa: E731

    @executor(id="story_finder")
    async def story_finder(batch: Batch, ctx: WorkflowContext[Round, Round]) -> None:
        cands = rules.before_the_whistle(batch.candidates)  # no tokens for a story that would not air
        if not cands:
            await ctx.yield_output(Round(batch, []))
            return
        by_id = {c["candidate_id"]: c for c in cands}
        payload = {"minute": m().minute_label(cands[-1]["ts"]),
                   "candidates": [{"candidate_id": c["candidate_id"], "kind": c["kind"],
                                   "minute": m().minute_label(c["ts"]), "team": m().team_name(c["team_id"]),
                                   "player": m().player_name(c["player_id"]), "note": c["note"],
                                   "score_after": desk.who_leads(c["ts"]),
                                   **({"outcome": c["outcome"]} if c.get("outcome") else {}),
                                   **({"focus_options": o} if (o := phrasebook.focus_options(c)) else {}),
                                   "facts": [desk.brief(f) for f in c["facts"][:6]]}
                                  for c in cands],
                   "recent_stories": [{"kind": s["kind"], "team": m().team_name(s["team_id"]),
                                       "player": m().player_name(s["player_id"]), "minute": m().minute_label(s["ts"]),
                                       "angle": s["angle"]}
                                      for s in desk.queue[-8:]]}
        try:
            out, usage = await desk.ask("story_finder", payload, Picks)
            picks = [(by_id[p.candidate_id], p.confidence, p.angle) for p in out.picks if p.candidate_id in by_id]
            choice = {id(by_id[p.candidate_id]): (p.tone, p.focus) for p in out.picks if p.candidate_id in by_id}
            note = ""
        except Exception as e:  # noqa: BLE001 - any failure falls back to the written rules
            picks, usage, note = [(c, 0.5, c["note"]) for c in _rule_picks(cands)], getattr(e, "usage", None), \
                f" fallback: {rules.brief_error(e)}"
            choice = {}
        chosen = {id(c) for c, _, _ in picks}
        picks = list({id(c): (c, conf, a) for c, conf, a in picks}.values())
        must = [(c, 0.7, c["note"]) for c in cands if c["kind"] in rules.MUST_TELL and id(c) not in chosen]
        others = [p for p in picks if p[0]["kind"] not in rules.MUST_TELL][:MAX_PICKS]
        stories = [desk.new_story(c, conf, a, *choice.get(id(c), ())) for c, conf, a in sorted(
            [p for p in picks if p[0]["kind"] in rules.MUST_TELL] + must + others, key=lambda p: rules.air_order(p[0]))]
        desk.trace("story_finder", "pick", _n(len(cands), "candidate") + ": " + ", ".join(c["kind"] for c in cands),
                   _n(len(stories), "story", "stories") + ": " + ", ".join(f"{s['story_id']} {s['kind']}" for s in stories) + note,
                   [i for s in stories for i in s["fact_ids"]], usage, [s["story_id"] for s in stories])
        if not stories:
            await ctx.yield_output(Round(batch, []))
            return
        await ctx.send_message(Round(batch, stories))

    @executor(id="director")
    async def director(rnd: Round, ctx: WorkflowContext[Round, Round]) -> None:
        rnd.used = copy.deepcopy(dict(desk.used))
        for s in rnd.stories:  # on air go the phrasebook's lines, so the cues need no AI text
            s["verifier"] = {"status": "pending", "attempts": 0, "flagged": [], **desk.on_air(s)}
            desk.finish(s)
        rnd.cues = desk.director.plan(rnd.stories, rnd.batch.ts)
        desk.trace("director", "cue", _n(len(rnd.stories), "story", "stories"),
                   _n(len(rnd.cues), "cue") + " for " + _n(len({c["audience"] for c in rnd.cues}), "audience"),
                   [i for s in rnd.stories for i in s["fact_ids"]], story_ids=ids(rnd))
        await ctx.yield_output(rnd)

    @executor(id="analyst")
    async def analyst(rnd: Round, ctx: WorkflowContext[Round]) -> None:
        note, usage = "", None
        try:
            out, usage = await desk.ask("analyst", {"stories": [desk.card(s) for s in rnd.stories]}, Analyses)
            got = {a.story_id: a for a in out.stories}
        except Exception as e:  # noqa: BLE001
            got, note, usage = {}, f" fallback: {rules.brief_error(e)}", getattr(e, "usage", None)
        fallback = 0  # analyses that fell back to the facts: counted in the trace, never a desk note
        for s in rnd.stories:
            a = got.get(s["story_id"])
            if a:
                # a fact the analyst looked up through MCP joins the evidence, if the analysis is kept; only
                # facts known when the batch was read (live, the MCP clock has moved on since)
                cited = [m().facts[fid] for fid in dict.fromkeys(a.fact_ids) if fid not in s["fact_ids"]
                         and fid in m().facts and m().facts[fid]["ts"] <= rnd.batch.ts]
                trial = {**s, "cited": s["cited"] + cited}
                text = rules.tidy(a.analysis_en)
                bad = rules.check_text(m().without_names(text), rules.story_allowed(m(), trial, cited=True), "en",
                                       rules.story_ids(trial)) + rules.story_issues(
                    m(), trial, text, "en", on_air=False) + rules.analysis_issues(rules.strip_citations(text))  # may quote "who lead 1-0"
                if not bad:
                    s["cited"] += cited
                    s["fact_ids"] += [f["fact_id"] for f in cited]
                s["analysis_en"] = rules.strip_citations(text) if not bad else rules.analysis_template(desk.m, s)
                fallback += bool(bad)
            else:
                s["analysis_en"] = rules.analysis_template(desk.m, s)
        desk.trace("analyst", "analyse", _n(len(rnd.stories), "story", "stories"),
                   _n(len(got), "analysis", "analyses") + (f", {fallback} replaced by the facts" if fallback else "") + note,
                   [i for s in rnd.stories for i in s["fact_ids"]], usage, ids(rnd))
        await ctx.send_message(rnd)

    def commentator(lang):
        @executor(id=f"commentator_{lang}")
        async def write(rnd: Round, ctx: WorkflowContext[Drafts]) -> None:
            payload = desk.writer_payload(lang, rnd.stories)
            try:
                out, usage = await desk.ask(f"commentator_{lang}", payload, Lines)
                drafts = Drafts(rnd, lang, {x.story_id: x.text for x in out.lines})
            except Exception as e:  # noqa: BLE001
                usage, drafts = getattr(e, "usage", None), Drafts(rnd, lang, {}, rules.brief_error(e))
            desk.trace(f"commentator_{lang}", "draft", _n(len(rnd.stories), "story", "stories"),
                       _n(len(drafts.texts), "line") + (f" fallback: {drafts.error}" if drafts.error else ""),
                       [i for s in rnd.stories for i in s["fact_ids"]], usage, ids(rnd))
            await ctx.send_message(drafts)
        return write

    async def judge(rnd, texts):
        """AI check of the claims; returns ({(sid, lang): issue}, the keys that got a verdict, usage, and a
        short reason when the judge failed). A text without a verdict (judge down, or a short reply) is not
        judged, never approved."""
        if not texts:
            return {}, set(), None, None
        payload = {"stories": [desk.card(s, judge=True) for s in rnd.stories],
                   "texts": [{"story_id": sid, "lang": lang, "text": t} for (sid, lang), t in texts.items()]}
        try:
            out, usage = await desk.ask("verifier", payload, Verdicts)
        except Exception as e:  # noqa: BLE001 - not judged: the numbers were checked, the story goes to review
            return {}, set(), getattr(e, "usage", None), rules.brief_error(e)
        # a verdict counts as ok only when its issue is empty or "none": "ok: true" with a named problem
        # is not ok; a "not ok" that argues itself out of its issue is no verdict (unjudged, review)
        ok = {}
        for v in out.verdicts:  # two verdicts on one text: it is ok only when both are
            if (key := (v.story_id, v.lang)) in texts:
                ok[key] = ok.get(key, True) and (rules.no_issue(v.issue) or (v.ok and not (v.issue or "").strip()))
        verdicts = [v for v in out.verdicts if (v.story_id, v.lang) in ok and (ok[(v.story_id, v.lang)]
                                                                               or not rules.retracts(v.issue))]
        return ({(v.story_id, v.lang): v.issue or "unsupported claim" for v in verdicts
                 if not ok[(v.story_id, v.lang)]}, {(v.story_id, v.lang) for v in verdicts}, usage, None)

    async def rewrite(rnd, lang, todo):
        """Ask the commentator of lang to fix the texts in todo {sid: problem}."""
        payload = desk.writer_payload(lang, [s for s in rnd.stories if s["story_id"] in todo],
                                      {sid: "; ".join(p) for sid, p in todo.items()})
        try:
            out, usage = await desk.ask(f"commentator_{lang}", payload, Lines)
            got = {x.story_id: x.text for x in out.lines if x.story_id in todo}
        except Exception as e:  # noqa: BLE001
            got, usage = {}, getattr(e, "usage", None)
            todo = {sid: p + [f"rewrite failed: {rules.brief_error(e)}"] for sid, p in todo.items()}
        desk.trace(f"commentator_{lang}", "rewrite", f"verifier asks to fix {', '.join(todo)}",
                   _n(len(got), "line"), [], usage, list(todo))
        return got

    @executor(id="verifier")
    async def verifier(drafts: list[Drafts], ctx: WorkflowContext[Round, Round]) -> None:
        rnd = drafts[0].round
        by_sid = {s["story_id"]: s for s in rnd.stories}
        allowed = {sid: rules.story_allowed(m(), s) for sid, s in by_sid.items()}
        texts, attempts, problems = {}, Counter(), defaultdict(list)
        earlier = defaultdict(list)  # (sid, lang) -> plain reasons a draft was sent back, for a fact or for style
        factual = set()  # texts sent back for a fact, not only for style: these raise the risk
        for d in drafts:
            for sid in by_sid:
                if sid in d.texts:
                    texts[(sid, d.lang)] = rules.tidy(d.texts[sid])
                    attempts[(sid, d.lang)] = 1
                else:
                    problems[(sid, d.lang)].append(f"no text: {d.error or 'missing'}")
        judged_ok, usage_all, judge_error = set(), Counter(), None  # texts the judge passed; a rewrite takes a text out
        analysis_judged, analysis_ok = set(), set()  # analyses the judge saw; those it passed (Ask serves only these)
        for round_no in range(config.MAX_REWRITES + 1):
            last = round_no == config.MAX_REWRITES
            pending = {k: t for k, t in texts.items() if k not in problems}
            for k, t in pending.items():
                if bad := (rules.check_text(m().without_names(t), allowed[k[0]], k[1], rules.story_ids(by_sid[k[0]]))
                           + rules.story_issues(m(), by_sid[k[0]], t, k[1])):
                    problems[k] += bad
            gaps = {k: g for k, t in pending.items() if k not in problems and (g := rules.story_gaps(m(), by_sid[k[0]], t))}
            # style goes back to the writer while there are rounds left; in the last round a line that
            # still leaves out who it is about, or a recap without the score, falls back to the template
            if last:
                style = {}
                for k, g in gaps.items():
                    problems[k] += g
                for k, t in pending.items():
                    # problems is a defaultdict: no empty entries
                    if k not in problems and (j := rules.jargon(t) + rules.english_words(t, k[1]) + rules.language_issues(
                            t, k[1], by_sid[k[0]]["kind"], m())):
                        problems[k] += j
            else:
                style = {k: st for k, t in pending.items() if k not in problems and (st := gaps.get(k, []) + rules.style_issues(
                    t, k[1], by_sid[k[0]]["kind"], rnd.used.get(k[1]), m()))}
            to_judge = {k: t for k, t in pending.items() if k not in problems and k not in style and k not in judged_ok}
            notes = {(sid, "analysis"): st["analysis_en"] for sid, st in by_sid.items()} if round_no == 0 else {}
            issues, judged, usage, failed = await judge(rnd, {**to_judge, **notes})
            usage_all.update(usage or {})
            judge_error = judge_error or failed
            analysis_judged |= {sid for sid, lang in judged if lang == "analysis"}
            analysis_ok |= {sid for sid, lang in judged if lang == "analysis" and (sid, lang) not in issues}
            judged_ok |= {k for k in judged if k in to_judge and k not in issues}
            for sid, lang in [k for k in issues if k[1] == "analysis"]:  # a wrong analysis falls back to the facts
                s = by_sid[sid]
                cut = {f["fact_id"] for f in s["cited"]}  # the template quotes none of the analyst's facts
                s["cited"], s["fact_ids"] = [], [i for i in s["fact_ids"] if i not in cut]
                s["analysis_en"] = rules.analysis_template(desk.m, s)
                issues.pop((sid, lang))
            for k, issue in issues.items():
                problems[k].append(f"claim: {issue}")
            fix = {k for k in problems if k in texts} | set(style)
            if not fix or last:
                break
            for k in fix:
                if problems.get(k):
                    factual.add(k)
                earlier[k] += [rules.reason(p) for p in problems.get(k, []) + style.get(k, [])]
            jobs = {lang: {sid: problems.get((sid, l2), []) + style.get((sid, l2), []) for sid, l2 in fix if l2 == lang}
                    for lang in rules.LANGS}
            results = await asyncio.gather(*(rewrite(rnd, lang, todo) for lang, todo in jobs.items() if todo))
            for (lang, todo), got in zip([(lg, t) for lg, t in jobs.items() if t], results):
                for sid in todo:
                    texts.pop((sid, lang), None)
                    problems.pop((sid, lang), None)
                    judged_ok.discard((sid, lang))
                    if sid in got:
                        texts[(sid, lang)] = rules.tidy(got[sid])
                        attempts[(sid, lang)] += 1
                    else:
                        problems[(sid, lang)].append("no rewrite")
        statuses, unjudged_any = Counter(), False
        for sid, s in by_sid.items():
            ok = {lang: (sid, lang) in texts and (sid, lang) not in problems for lang in rules.LANGS}
            # the AI's lines become a proposal on the desk when all three pass; on air go the phrasebook's
            proposals = None
            if all(ok.values()):
                status = "rewritten" if any(attempts[(sid, lang)] > 1 for lang in rules.LANGS) else "pass"
                proposals = {lang: rules.strip_citations(texts[(sid, lang)]) for lang in rules.LANGS}
            else:
                status = "template"
            for lang in rules.LANGS:  # one verdict per text on the OpenTelemetry span (no-op without an exporter)
                why = problems.get((sid, lang))
                trace.get_current_span().add_event("studiodesk.verdict", {
                    "studiodesk.match_id": desk.match_id, "studiodesk.run_id": desk.run_id, "studiodesk.story_id": sid,
                    "studiodesk.lang": lang, "studiodesk.accepted": ok[lang], "studiodesk.status": status,
                    "studiodesk.reason": "" if ok[lang] else rules.reason(why[0]) if why else "no text"})
            air = {k: s["verifier"][k] for k in ("on_air", "opener")}
            s["unjudged"] = status != "template" and (sid not in analysis_judged or any(
                (sid, lang) not in judged_ok for lang in rules.LANGS))
            unjudged_any |= s["unjudged"]
            s["style_only"] = not any((sid, lang) in factual for lang in rules.LANGS)
            s["flagged"] = rules.desk_notes(status, {lang: earlier[(sid, lang)] for lang in rules.LANGS},
                                            {lang: [rules.reason(p) for p in problems.get((sid, lang), [])]
                                             for lang in rules.LANGS})
            s["verifier"] = {"status": status, "attempts": max(attempts[(sid, lang)] for lang in rules.LANGS),
                             "flagged": s["flagged"], **air, "analysis_judged": sid in analysis_ok,
                             **({"proposals": proposals} if proposals else {})}
            desk.finish(s)
            statuses[status] += 1
        usage_all["calls"] = usage_all.get("calls", 0)
        desk.trace("verifier", "check", _n(len(texts), "text") + f" in {len(rules.LANGS)} languages",
                   ", ".join(f"{k} {v}" for k, v in statuses.items()) + (f" (claims not judged: {judge_error or 'no verdict'})" if unjudged_any else ""),
                   [i for s in rnd.stories for i in s["fact_ids"]], dict(usage_all), ids(rnd))
        await ctx.yield_output(rnd)

    writers = [commentator(lang) for lang in rules.LANGS]
    air = WorkflowBuilder(name="studiodesk-air", start_executor=story_finder).add_edge(story_finder, director).build()
    tail = (WorkflowBuilder(name="studiodesk-tail", start_executor=analyst)
            .add_fan_out_edges(analyst, writers)
            .add_fan_in_edges(writers, verifier)
            .build())
    return air, tail


def build_agents(desk, client, tools):
    """The four AI agents; the story finder and the analyst can call the MCP tools."""
    opts = {"reasoning": {"effort": "minimal"}, "store": False}
    names = ["story_finder", "analyst", "verifier"] + [f"commentator_{lang}" for lang in rules.LANGS]
    for name in names:
        role = "commentator" if name.startswith("commentator") else name
        text = INSTRUCTIONS[role].replace("{language_name}", LANGUAGE_NAMES[name[-2:]]).replace(
            "{style}", STYLE[name[-2:]]) if role == "commentator" else INSTRUCTIONS[role]
        # the judge reasons a little: at minimal effort it argued itself in circles in its issues
        o = {**opts, "reasoning": {"effort": "low"}} if name == "verifier" else opts
        desk.prompt_chars[name] = len(text)
        desk.agents[name] = Agent(client, text, name=name, tools=tools.get(name), default_options=o,
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


async def run_tail(desk, tail, rnd):
    try:
        rnd = (await tail.run(rnd)).get_outputs()[-1]
    except Exception as e:  # noqa: BLE001 - the round stays on air with the phrasebook's lines
        for s in rnd.stories:
            if s["verifier"]["status"] == "pending":
                template_story(desk, s, f"workflow error: {rules.brief_error(e)}",
                               {k: s["verifier"][k] for k in ("on_air", "opener")})
    desk.update(rnd)


async def run_batch(desk, batch, wait=True):
    """One batch on air; then its AI tail, awaited (replays stay the same run to run) or, live, left running."""
    if batch.candidates:
        air, tail = build_workflow(desk)  # a workflow runs one input at a time, and live tails overlap
        slots = copy.deepcopy({k: getattr(desk.director, k) for k in ("placed", "whistles")})
        try:
            rnd = (await air.run(batch)).get_outputs()[-1]
        except Exception as e:  # noqa: BLE001 - the broadcast goes on with rules and templates
            vars(desk.director).update(copy.deepcopy(slots))  # a plan the failed round discarded holds no slot
            try:
                stories = []
                for c in _rule_picks(rules.before_the_whistle(batch.candidates)):  # the candidates the finder had
                    s = desk.new_story(c, 0.5, c["note"])
                    try:
                        aired = desk.on_air(s)
                    except Exception:  # noqa: BLE001 - the phrasebook failed again: the template's lines
                        s["texts"] = {lang: rules.template(desk.m, s, lang) for lang in rules.LANGS}
                        aired = {"on_air": "template", "opener": None}
                    stories.append(template_story(desk, s, f"workflow error: {rules.brief_error(e)}", aired))
                try:
                    cues = desk.director.plan(stories, batch.ts)
                except Exception:  # noqa: BLE001 - the director failed again: the stories go on without cues
                    vars(desk.director).update(copy.deepcopy(slots))
                    cues = []
                rnd = Round(batch, stories, cues)
                desk.trace("director", "fallback", "workflow failed",
                           _n(len(stories), "template story", "template stories"),
                           [i for s in stories for i in s["fact_ids"]], story_ids=[s["story_id"] for s in stories])
            except Exception as e2:  # noqa: BLE001 - the fallback failed too: this batch airs nothing, the match goes on
                vars(desk.director).update(copy.deepcopy(slots))
                rnd = Round(batch, [], [])
                desk.trace("director", "fallback", "workflow failed", f"fallback failed: {rules.brief_error(e2)}", [])
        desk.save(rnd)
        if any(s["verifier"]["status"] == "pending" for s in rnd.stories):
            job = run_tail(desk, tail, rnd)
            if wait:
                await job
            else:
                desk.tails.append(asyncio.create_task(job))
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
            await desk.start(from_ts)
            async for _ in clock:
                if batch := await desk.ingest(clock.now):
                    await run_batch(desk, batch, wait=not speed)
                    log(f"{rules.minute(clock.now, 2 if desk.m.p1 and clock.now > desk.m.p1 else 1, desk.m.p1 or 1e9)}' "
                        f"stories {desk.story_n} calls {desk.calls} cost ${desk.cost:.4f}")
            if batch := await desk.ingest(clock.now, full_time=clock.end >= clock.full_end):
                await run_batch(desk, batch, wait=not speed)
            await asyncio.gather(*desk.tails)
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
