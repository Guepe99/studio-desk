"""HTTP API and static site (docs/CONTRACT.md, API). Skeleton: health, one model call, the web page."""
import asyncio
import hashlib
import json
import logging
import mimetypes
import os
import re
import secrets
import threading
from contextlib import asynccontextmanager, closing, contextmanager
from datetime import datetime, timezone
from functools import lru_cache
from stat import S_ISREG
import time
import unicodedata
from pathlib import Path
from typing import Annotated, Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool, StringConstraints, model_validator

from . import __version__, config, db, telemetry

WEB = Path(__file__).resolve().parent.parent / "web"
ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT", "")  # https://<account>.openai.azure.com
DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-5-mini")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
SAFETY_ENDPOINT = os.environ.get("AZURE_CONTENT_SAFETY_ENDPOINT", "")  # unset: edits get the fact checks only

@asynccontextmanager
async def _startup(app):
    # the runtime schema runs once here: two first requests on a new runtime.sqlite would both run it and one would fail
    with closing(db.runtime()):
        pass
    # the agents' imports take seconds on half a CPU: done now, the page's 4 s Ask probe finds them ready
    async def ready():
        try:
            await asyncio.to_thread(telemetry.setup)  # Application Insights, only with its connection string
            await asyncio.to_thread(_ask_ready)
        except HTTPException:
            pass  # no model: the probe gets its 503 as before
    warm = asyncio.create_task(ready()) if ENDPOINT else None
    yield
    if warm:
        warm.cancel()


# No /docs or /openapi.json in public: they would advertise the admin route and its header.
# FastAPI's own OpenTelemetry spans (only once studiodesk/telemetry.py set an exporter) for /api/ only: the
# page's files would fill the Application Insights cap. They carry no client address.
app = FastAPI(title="Studio Desk", version=__version__, docs_url=None, redoc_url=None, openapi_url=None,
              lifespan=_startup, telemetry={"exclude": lambda scope: not scope.get("path", "").startswith("/api/")})
MAX_BODY_BYTES = 16384


class BodyCap:
    """Caps POST bodies at MAX_BODY_BYTES with 413, chunked ones included (they have no Content-Length)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
        length = dict(scope["headers"]).get(b"content-length")
        if length is not None and not length.isdigit():
            return await JSONResponse({"detail": "bad Content-Length"}, status_code=400)(scope, receive, send)
        if length is not None and int(length) > MAX_BODY_BYTES:
            return await JSONResponse({"detail": "request body too large"}, status_code=413)(scope, receive, send)
        seen = 0

        async def capped():
            nonlocal seen
            message = await receive()
            seen += len(message.get("body", b""))
            if seen > MAX_BODY_BYTES:  # FastAPI re-raises an HTTPException met while reading the body
                raise HTTPException(413, "request body too large")
            return message

        await self.app(scope, capped, send)


# Innermost first: the cap sits inside the security headers, so its 413 carries them too.
app.add_middleware(BodyCap)
app.add_middleware(GZipMiddleware, minimum_size=1000)
# The pages load only their own files. Inline styles stay (graphics and seek marks set them); inline scripts do not.
# blob: only for workers (Babylon builds its decoder workers from blobs), never for scripts.
CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; "
       "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; "
       "connect-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
SECURITY_HEADERS = {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
                    "Strict-Transport-Security": "max-age=31536000", "Content-Security-Policy": CSP,
                    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()"}


@app.middleware("http")
async def security_headers(request, call_next):
    try:
        response = await call_next(request)
    except Exception:  # Starlette's own 500 sits outside this middleware and would go out without the headers
        logging.getLogger("uvicorn.error").exception("unhandled error on %s %s", request.method, request.url.path)
        response = JSONResponse({"detail": "internal error"}, status_code=500)
    response.headers.update(SECURITY_HEADERS)
    return response


@app.exception_handler(RequestValidationError)
async def invalid_request(request, exc):
    # FastAPI's own 422 echoes the input, and a NaN in it ({"ts": NaN}) cannot be written as JSON: a 500
    return JSONResponse({"detail": [{k: e.get(k) for k in ("type", "loc", "msg")} for e in exc.errors()]}, status_code=422)
_credential = None


def _token() -> str:
    global _credential
    if _credential is None:
        from azure.identity import DefaultAzureCredential  # managed identity in Azure, az login locally
        _credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
    return _credential.get_token("https://cognitiveservices.azure.com/.default").token


@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__}


@app.post("/api/admin/model-ping")
def model_ping(x_admin_token: str = Header(default="")):
    # Paid call: only the operator may trigger it, never a visitor.
    if not ADMIN_TOKEN or not secrets.compare_digest(x_admin_token.encode(), ADMIN_TOKEN.encode()):
        raise HTTPException(403, "forbidden")
    if not ENDPOINT:
        raise HTTPException(503, "model endpoint not configured")
    t0 = time.perf_counter()
    token = _token()
    t1 = time.perf_counter()
    r = httpx.post(
        f"{ENDPOINT.rstrip('/')}/openai/v1/responses",
        headers={"Authorization": f"Bearer {token}"},
        json={"model": DEPLOYMENT, "input": "Reply with the single word: ready",
              "reasoning": {"effort": "minimal"}, "max_output_tokens": 50},
        timeout=60,
    )
    t2 = time.perf_counter()
    if r.status_code != 200:
        raise HTTPException(502, f"model returned {r.status_code}: {r.text[:300]}")
    body = r.json()
    text = "".join(c.get("text", "") for o in body.get("output", []) if o.get("type") == "message"
                   for c in o.get("content", []))
    return {"text": text, "model": body.get("model"), "usage": body.get("usage"),
            "token_ms": round((t1 - t0) * 1000), "model_ms": round((t2 - t1) * 1000)}


def accepts_gzip(header: str) -> bool:
    for part in header.split(","):
        name, _, params = part.partition(";")
        if name.strip().lower() == "gzip":
            return not re.fullmatch(r"\s*q\s*=\s*0(\.0*)?\s*", params)
    return False


VERSIONED = re.compile(r"vendor/[^/]+/\d+\.\d+\.\d+/")  # a pinned library's folder never changes


class PrecompressedStatic(StaticFiles):
    """Serves <file>.gz when the build left one: gzipping 25 MB of tracking per visit is too slow."""

    async def get_response(self, path, scope):
        # everything else is asked again each visit (a 304 when unchanged): without a header browsers kept
        # yesterday's page and scripts for hours after a deploy
        headers = {"Vary": "Accept-Encoding", "Cache-Control": "no-cache"}
        if VERSIONED.match(path.replace("\\", "/")):  # a returning visitor gets the 3D engine from its cache
            headers["Cache-Control"] = "public, max-age=31536000, immutable"
        if scope["method"] in ("GET", "HEAD") and accepts_gzip(dict(scope["headers"]).get(b"accept-encoding", b"").decode("latin-1")):
            gz, stat = self.lookup_path(f"{path}.gz")  # Starlette's lookup refuses paths outside the directory
            if stat is not None and S_ISREG(stat.st_mode):
                r = self.file_response(gz, stat, scope)  # ETag and 304 like any static file
                r.headers.update(headers | {"Content-Encoding": "gzip",
                                            "Content-Type": mimetypes.guess_type(path)[0] or "application/octet-stream"})
                return r
        r = await super().get_response(path, scope)
        r.headers.update(headers)
        return r

# --- Control desk: per-visitor sessions, decisions and the AI kill switch ------------------------
# The base replay (web/data/<match>/) never changes; each visitor's choices live in runtime.sqlite
# under their own session and come back as an overlay. Every human action also writes an audit row.

COOKIE = "sd_session"
MATCH_PATTERN = r"^(M\d{3}|DEMO)$"
EDIT_MAX_CHARS = 600            # a why_card body: five lines that shrink to fit
TITLE_MAX_CHARS = 80            # a why_card headline: one line
MAX_ACTIONS_PER_SESSION = 300   # decisions and kill-switch flips: plenty for a judge, a wall for a script
MAX_NEW_SESSIONS_PER_DAY = 5000  # with the cap above, bounds what the public link can write in a day
MAX_NEW_SESSIONS_PER_CLIENT = 50  # per address and UTC day: one script cannot use up the day's sessions for everyone
SESSION_RE = re.compile(r"[A-Za-z0-9_-]{32}")
# shortcut: counted in this process's memory, right for the single replica; move it to a table if the app scales out
_new_sessions = {"day": "", "by_client": {}}


def _printable(text: str) -> str:
    """Newlines allowed. Refused: every other control (C0, DEL, C1), every format character (zero-width,
    direction marks, bidi embeddings and isolates, BOM, word joiner, soft hyphen) and the line and paragraph separators."""
    if any(c != "\n" and unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") for c in text):
        raise ValueError("control or invisible format character")
    return text


Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=EDIT_MAX_CHARS),
                 AfterValidator(_printable)]


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    match_id: str = Field(pattern=MATCH_PATTERN)
    story_id: str = Field(pattern=r"^S-\d{6}$")
    decision: Literal["approved", "edited", "rejected"]
    # a language's body, or its headline under title_<lang>
    edited_text: dict[Literal["en", "it", "es", "title_en", "title_it", "title_es"], Text] | None = None

    @model_validator(mode="after")
    def _text_only_with_edit(self):
        if (self.decision == "edited") != bool(self.edited_text):
            raise ValueError("edited_text is required for 'edited' and not allowed otherwise")
        for k, v in (self.edited_text or {}).items():
            if k.startswith("title_") and (len(v) > TITLE_MAX_CHARS or "\n" in v):
                raise ValueError(f"a headline is one line of at most {TITLE_MAX_CHARS} characters")
        return self


class Kill(BaseModel):
    model_config = ConfigDict(extra="forbid")
    on: StrictBool


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def _runtime(write: bool = False, busy_ms: int | None = None):
    conn = db.runtime()
    if busy_ms is not None:  # a shorter wait for the write lock than the driver's 5 s
        conn.execute(f"PRAGMA busy_timeout = {int(busy_ms)}")
    try:
        with conn:  # one transaction: an error rolls back the session row and the audit row too
            if write:  # take the write lock before the cap checks, so concurrent requests cannot pass a cap together
                conn.execute("BEGIN IMMEDIATE")
            yield conn
    finally:
        conn.close()


def _client(request: Request) -> str:
    # The Container Apps ingress appends the address it saw to X-Forwarded-For: the last entry is the one a client cannot forge.
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[-1].strip()
    return forwarded or (request.client.host if request.client else "")


def _session(conn, request: Request, response: Response | None = None, create: bool = True) -> str | None:
    sid = request.cookies.get(COOKIE, "")
    if SESSION_RE.fullmatch(sid) and conn.execute("SELECT 1 FROM sessions WHERE session_id = ?", (sid,)).fetchone():
        return sid
    if not create:
        return None
    day, client = _now()[:10], _client(request)
    if _new_sessions["day"] != day:
        _new_sessions.update(day=day, by_client={})
    by_client = _new_sessions["by_client"]
    if (by_client.get(client, 0) >= MAX_NEW_SESSIONS_PER_CLIENT
            or conn.execute("SELECT count(*) FROM sessions WHERE created_at >= ?", (day,)).fetchone()[0] >= MAX_NEW_SESSIONS_PER_DAY):
        raise HTTPException(429, "too many new sessions today; the replay still works without saving decisions")
    by_client[client] = by_client.get(client, 0) + 1  # counts attempts: a request that fails later still used its slot
    sid = secrets.token_urlsafe(24)
    conn.execute("INSERT INTO sessions (session_id, created_at) VALUES (?, ?)", (sid, _now()))
    # TLS ends at the ingress; behind a proxy chain the first value is what the visitor used
    https = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip().lower() == "https"
    response.set_cookie(COOKIE, sid, max_age=30 * 86400, httponly=True, samesite="lax", secure=https, path="/")
    return sid


def _actions(conn, sid: str) -> int:
    return conn.execute("SELECT count(*) FROM audit WHERE session_id = ? AND actor = 'human'", (sid,)).fetchone()[0]


def _spend(conn, sid: str) -> None:
    if _actions(conn, sid) >= MAX_ACTIONS_PER_SESSION:
        raise HTTPException(429, f"this session has used its {MAX_ACTIONS_PER_SESSION} desk actions")


@lru_cache(maxsize=32)
def _replay_file(path: Path, mtime_ns: int) -> tuple:
    rows = json.loads(path.read_text(encoding="utf-8"))
    return tuple(r for r in rows if isinstance(r, dict)) if isinstance(rows, list) else ()


def _replay(match_id: str, name: str) -> tuple:
    """The rows of a replay file (stories.json, traces.json); () when it is missing or malformed. Read only."""
    path = WEB / "data" / match_id / name
    try:
        return _replay_file(path, path.stat().st_mtime_ns)
    except (OSError, ValueError):
        return ()


@lru_cache(maxsize=8)
def _meta_file(path: Path, mtime_ns: int) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _story_row(conn, match_id: str, story_id: str) -> dict | None:
    """The story's ts, fact ids and verifier, from a live run's `stories` row or else the replay's stories.json."""
    row = conn.execute("SELECT ts, fact_ids, verifier FROM stories WHERE match_id = ? AND story_id = ?",
                       (match_id, story_id)).fetchone()
    if row:
        return {"ts": row["ts"], "fact_ids": json.loads(row["fact_ids"]), "verifier": json.loads(row["verifier"] or "{}")}
    return next((s for s in _replay(match_id, "stories.json") if s.get("story_id") == story_id), None)


_edit_safety = None  # the Content Safety client for edits, built on the first edit
# An edit check costs 1 to 4 of the F0 tier's 5,000 text records a month (config.py, next to Ask's 40 questions a
# day), so it is counted before the call: an edit the cap stops is refused, never put on air unchecked
EDIT_CHECKS_PER_DAY = 20
EDIT_CHECKS_PER_CLIENT_PER_DAY = 10
# shortcut: counted in this process's memory, right for the single replica; move it to a table if the app scales out
_edit_checks = {"day": "", "all": 0, "by_client": {}}
_edit_checks_lock = threading.Lock()


def _edit_check_allowed(client: str) -> bool:
    """Counts one Content Safety check of an edit for `client`, or False when today's caps are reached."""
    with _edit_checks_lock:
        day = _now()[:10]
        if _edit_checks["day"] != day:
            _edit_checks.update(day=day, all=0, by_client={})
        by_client = _edit_checks["by_client"]
        if _edit_checks["all"] >= EDIT_CHECKS_PER_DAY or by_client.get(client, 0) >= EDIT_CHECKS_PER_CLIENT_PER_DAY:
            return False
        _edit_checks["all"] += 1
        by_client[client] = by_client.get(client, 0) + 1
        return True


SAFETY_CATEGORIES = {"Hate": "hate", "SelfHarm": "self-harm", "Sexual": "sexual content", "Violence": "violence"}


def _edit_refused(match_id: str, story: dict, edited: dict, client: str = "") -> str | None:
    """Why an edited text may not go on air, or None. The checks the agents' drafts meet (rules.check_text:
    every number one of this story's facts, its minute or the score then; cited fact ids its own; no real
    name), then Content Safety when the site has it. Anything that cannot be checked is refused."""
    from .agents import rules
    try:
        path = WEB / "data" / match_id / "meta.json"
        m = rules.Match(_meta_file(path, path.stat().st_mtime_ns))
        ts, ids = float(story["ts"]), [i for i in story.get("fact_ids") or [] if isinstance(i, str)]
    except (OSError, ValueError, KeyError, TypeError, StopIteration):
        return "the match data could not be read, so the edit could not be checked"
    m.facts = {f["fact_id"]: f for f in _replay(match_id, "facts.json") if "fact_id" in f}
    s = {"facts": [m.facts[i] for i in ids if i in m.facts], "ts": ts,
         "minute": rules.minute(ts, m.period_of(ts), m.p1 or float("inf"))}
    if len(s["facts"]) < len(ids):
        return "the facts of this story could not be read, so the edit could not be checked"
    allowed, own = rules.story_allowed(m, s), rules.story_ids(s)
    for key, text in edited.items():
        if flags := rules.check_text(m.without_names(text), allowed, key.removeprefix("title_"), own):
            what = f"the {rules.LANGUAGES[key.removeprefix('title_')]} {'headline' if key.startswith('title_') else 'text'}"
            shown = re.search(r"'([^']+)'", flags[0])
            return f"{what} has {rules.reason(flags[0])}" + (f" ({shown.group(1)})" if shown else "")
    if not SAFETY_ENDPOINT:
        return None
    if not _edit_check_allowed(client):
        return "the content safety check has reached today's limit for edits, try again tomorrow"
    from .agents.safety import EDIT_FLAG_SEVERITY, AzureSafety
    global _edit_safety
    try:
        _edit_safety = _edit_safety or AzureSafety(SAFETY_ENDPOINT, timeout=config.ASK_SAFETY_TIMEOUT_S)
        analysis = _edit_safety("\n".join(edited.values()))
    except Exception:  # noqa: BLE001 - quota, network or auth: not checked is not passed
        return "the content safety check could not run, try again later"
    if not analysis:
        return "content safety did not pass the text"
    if flagged := sorted(k for k, v in analysis.items() if v >= EDIT_FLAG_SEVERITY):
        names = " and ".join(SAFETY_CATEGORIES.get(k, k.lower()) for k in flagged)
        return f"content safety flagged the text for {names} (severity {max(analysis[k] for k in flagged)})"
    return None


def _story_known(conn, match_id: str, story_id: str) -> bool:
    if conn.execute("SELECT 1 FROM stories WHERE match_id = ? AND story_id = ?", (match_id, story_id)).fetchone():
        return True
    return any(s.get("story_id") == story_id for s in _replay(match_id, "stories.json"))


def _auto_rows(match_id: str) -> list[dict]:
    """The risk rule's approvals for the replay: one `auto` row per story that goes on air without a human.
    Derived from stories.json on each read (the rule is deterministic), at the time of the director's hand-off."""
    director = {}
    for t in _replay(match_id, "traces.json"):
        ids = t.get("story_ids") if isinstance(t.get("story_ids"), list) and t.get("story_ids") else [t.get("story_id")]
        if t.get("agent") == "director":
            director.update({sid: t.get("at") for sid in ids if isinstance(sid, str)})
    return [{"at": str(director.get(s.get("story_id")) or ""), "actor": "auto", "action": "auto_approved", "match_id": match_id,
             "story_id": s.get("story_id"), "model": None, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0,
             "detail": {"risk": s.get("risk")}}
            for s in _replay(match_id, "stories.json") if s.get("default_status") == "auto_approved" and s.get("safety") != "flagged"]


@app.get("/api/matches")
def list_matches():
    out = []
    for meta in sorted((WEB / "data").glob("*/meta.json")):
        if not re.fullmatch(MATCH_PATTERN, meta.parent.name):
            continue
        m = json.loads(meta.read_text(encoding="utf-8"))
        side = {t["side"]: t for t in m["teams"]}
        out.append({"match_id": m["match_id"], "home": side["home"]["name"], "away": side["away"]["name"],
                    "home_score": m["home_score"], "away_score": m["away_score"]})
    return out


@app.get("/api/session")
def get_session(request: Request):
    # Read-only: the first POST creates the session, so cookieless GETs cannot use up the day's cap.
    with _runtime() as conn:
        sid = _session(conn, request, create=False)
        if sid is None:
            return {"kill_switch": False, "actions_left": MAX_ACTIONS_PER_SESSION}
        kill = conn.execute("SELECT kill_switch FROM sessions WHERE session_id = ?", (sid,)).fetchone()[0]
        return {"kill_switch": bool(kill), "actions_left": MAX_ACTIONS_PER_SESSION - _actions(conn, sid)}


@app.get("/api/decisions")
def get_decisions(request: Request, match_id: str = Query(pattern=MATCH_PATTERN)):
    with _runtime() as conn:
        sid = _session(conn, request, create=False)
        if sid is None:
            return {"match_id": match_id, "kill_switch": False, "decisions": []}
        kill = conn.execute("SELECT kill_switch FROM sessions WHERE session_id = ?", (sid,)).fetchone()[0]
        rows = conn.execute("SELECT story_id, decision, edited_text, at FROM session_decisions "
                            "WHERE session_id = ? AND match_id = ? ORDER BY story_id", (sid, match_id)).fetchall()
    return {"match_id": match_id, "kill_switch": bool(kill),
            "decisions": [{**dict(r), "edited_text": json.loads(r["edited_text"]) if r["edited_text"] else None} for r in rows]}


def _cookie(response: Response) -> dict:
    """The session cookie set on `response`, for a JSONResponse returned in its place."""
    return {"set-cookie": v.decode("latin-1") for k, v in response.raw_headers if k == b"set-cookie"}


def _detail(edited: dict | None) -> dict:
    """Audit detail of a decision: for an edit, the languages and the SHA-1 of each text (body or title_<lang>) that went on air."""
    if not edited:
        return {"langs": []}
    return {"langs": sorted({k.removeprefix("title_") for k in edited}), "sha1": {k: hashlib.sha1(v.encode("utf-8")).hexdigest() for k, v in sorted(edited.items())}}


# runtime.sqlite starts empty on every deploy: each human audit row also goes to Application Insights (the
# "studiodesk" logger tree, telemetry.py) as a custom event, without any text, reason or client address
_decision_log = logging.getLogger("studiodesk.decision")
_decision_log.setLevel(logging.INFO)


def _decision_event(sid: str, action: str, match_id: str | None = None, story_id: str | None = None, langs=()) -> None:
    _decision_log.info("studiodesk.decision %s", action, extra={
        "microsoft.custom_event.name": "studiodesk.decision", "decision_action": action,
        "decision_match_id": match_id or "", "decision_story_id": story_id or "", "decision_langs": ",".join(langs),
        # the same visitor's decisions tie together; the cookie itself never leaves
        "decision_session": hashlib.sha256((ADDRESS_SALT + sid).encode()).hexdigest()[:16]})


@app.post("/api/decisions")
def post_decision(d: Decision, request: Request, response: Response):
    action = d.decision
    if d.edited_text:
        with _runtime() as conn:
            story = _story_row(conn, d.match_id, d.story_id)
        if story is None:
            raise HTTPException(404, "unknown story for this match")
        # checked outside the write lock: Content Safety is a network call
        if why := _edit_refused(d.match_id, story, d.edited_text, _client(request)):
            with _runtime(write=True) as conn:  # a refused edit is an action too
                sid = _session(conn, request, response)
                _spend(conn, sid)
                conn.execute("INSERT INTO audit (session_id, at, actor, action, match_id, story_id, detail) "
                             "VALUES (?, ?, 'human', 'edit_refused', ?, ?, ?)",
                             (sid, _now(), d.match_id, d.story_id, json.dumps({**_detail(d.edited_text), "reason": why})))
            _decision_event(sid, "edit_refused", d.match_id, d.story_id, _detail(d.edited_text)["langs"])
            return JSONResponse({"detail": f"{why}. It stays off air."}, status_code=422, headers=_cookie(response))
        # the AI's own line, put on air as it is: its own audit action, still an edit for what goes on air
        if d.decision == "edited" and d.edited_text == (story.get("verifier") or {}).get("proposals"):
            action = "used_proposal"
    with _runtime(write=True) as conn:
        sid = _session(conn, request, response)
        if not _story_known(conn, d.match_id, d.story_id):
            raise HTTPException(404, "unknown story for this match")
        _spend(conn, sid)
        at, text = _now(), json.dumps(d.edited_text, ensure_ascii=False) if d.edited_text else None
        conn.execute("INSERT INTO session_decisions (session_id, match_id, story_id, decision, edited_text, at) "
                     "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, match_id, story_id) DO UPDATE SET "
                     "decision = excluded.decision, edited_text = excluded.edited_text, at = excluded.at",
                     (sid, d.match_id, d.story_id, d.decision, text, at))
        conn.execute("INSERT INTO audit (session_id, at, actor, action, match_id, story_id, detail) "
                     "VALUES (?, ?, 'human', ?, ?, ?, ?)",
                     (sid, at, action, d.match_id, d.story_id, json.dumps(_detail(d.edited_text))))
    _decision_event(sid, action, d.match_id, d.story_id, _detail(d.edited_text)["langs"])
    return {"story_id": d.story_id, "decision": d.decision, "edited_text": d.edited_text, "at": at}


@app.delete("/api/decisions")
def delete_decision(request: Request, response: Response, match_id: str = Query(pattern=MATCH_PATTERN),
                    story_id: str = Query(pattern=r"^S-\d{6}$")):
    """Undo: the visitor's decision on a story goes, so the story is back to its default status."""
    with _runtime(write=True) as conn:
        sid = _session(conn, request, response)
        if not _story_known(conn, match_id, story_id):
            raise HTTPException(404, "unknown story for this match")
        _spend(conn, sid)
        at = _now()
        conn.execute("DELETE FROM session_decisions WHERE session_id = ? AND match_id = ? AND story_id = ?",
                     (sid, match_id, story_id))
        conn.execute("INSERT INTO audit (session_id, at, actor, action, match_id, story_id, detail) "
                     "VALUES (?, ?, 'human', 'undo', ?, ?, ?)", (sid, at, match_id, story_id, json.dumps(_detail(None))))
    _decision_event(sid, "undo", match_id, story_id)
    return {"story_id": story_id, "decision": None, "at": at}


@app.post("/api/kill")
def post_kill(k: Kill, request: Request, response: Response):
    with _runtime(write=True) as conn:
        sid = _session(conn, request, response)
        _spend(conn, sid)
        conn.execute("UPDATE sessions SET kill_switch = ? WHERE session_id = ?", (int(k.on), sid))
        conn.execute("INSERT INTO audit (session_id, at, actor, action) VALUES (?, ?, 'human', ?)",
                     (sid, _now(), "ai_off" if k.on else "ai_on"))
    _decision_event(sid, "ai_off" if k.on else "ai_on")
    return {"kill_switch": k.on}


@app.get("/api/audit")
def get_audit(request: Request, match_id: str = Query(pattern=MATCH_PATTERN)):
    """This visitor's actions, the agents' rows for the match (session_id NULL) and the risk rule's approvals, newest first."""
    with _runtime() as conn:
        sid = _session(conn, request, create=False)
        rows = [{**dict(r), "detail": json.loads(r["detail"])} for r in conn.execute(
            "SELECT at, actor, action, match_id, story_id, model, tokens_in, tokens_out, cost_usd, detail FROM audit "
            "WHERE (session_id = ? AND (match_id = ? OR match_id IS NULL)) OR (session_id IS NULL AND match_id = ?) "
            "ORDER BY id DESC LIMIT 500", (sid, match_id, match_id))]
    auto = [] if any(r["actor"] == "auto" for r in rows) else _auto_rows(match_id)
    if auto:
        rows = sorted(rows + auto, key=lambda r: r["at"], reverse=True)[:500]  # stable: ties keep id order
    return {"match_id": match_id, "rows": rows}


# --- Ask the studio (docs/CONTRACT.md): a visitor's question at replay time, answered by studio_host -

def _question(text: str) -> str:
    """Control and separator characters become spaces, invisible format characters go; 1..280 characters left.
    A lone surrogate, a private-use or an unassigned character is refused: it cannot be stored or checked."""
    if any(unicodedata.category(c) in ("Cs", "Co", "Cn") for c in text):
        raise ValueError("a question has no surrogate, private-use or unassigned characters")
    kept = "".join(" " if unicodedata.category(c) in ("Cc", "Zl", "Zp") else c for c in text
                   if unicodedata.category(c) != "Cf")
    text = " ".join(kept.split())
    if not 1 <= len(text) <= 280:
        raise ValueError("a question has 1 to 280 characters")
    return text


class Question(BaseModel):
    model_config = ConfigDict(extra="forbid")
    match_id: str = Field(pattern=MATCH_PATTERN)
    ts: float = Field(ge=0, allow_inf_nan=False)
    question: Annotated[str, AfterValidator(_question)]
    lang: Literal["en", "it", "es"]


def _ask_ready():
    # A dependency runs before the body is read: a question to a site without a model is a 503, never counted.
    if not ENDPOINT:
        raise HTTPException(503, "no model on this site")
    try:
        from .agents import ask  # needs the agents extra (Agent Framework, MCP)
        ask.client(ENDPOINT)  # built here, before anything is counted
    except Exception:  # noqa: BLE001 - no extra, no credential: no model on this site
        raise HTTPException(503, "no model on this site") from None
    if ask.safety_down():  # every answer would be declined: the page hides the box instead
        raise HTTPException(503, "content safety is not available")


# Only a salted hash of the client address is stored. shortcut: a random salt per process resets the
# per-address count on a restart; set ASK_ADDRESS_SALT to keep it across restarts.
ADDRESS_SALT = os.environ.get("ASK_ADDRESS_SALT") or secrets.token_hex(16)


def _address(request: Request) -> str:
    return "ip:" + hashlib.sha256((ADDRESS_SALT + _client(request)).encode()).hexdigest()


def _limit(reason: str) -> JSONResponse:
    return JSONResponse({"status": "limit", "reason": reason}, status_code=429)


def _count_question(request: Request, response: Response, day: str):
    """Checks the caps and counts the question in one transaction: (session_id, questions left) or a 429."""
    addr = _address(request)
    with _runtime(write=True) as conn:
        def asked(who):
            row = conn.execute("SELECT questions FROM questions_daily WHERE day = ? AND session_id = ?", (day, who)).fetchone()
            return row[0] if row else 0
        spent = conn.execute("SELECT cost_usd FROM usage_daily WHERE day = ? AND session_id = '*'", (day,)).fetchone()
        if spent and spent[0] >= config.DAILY_COST_STOP_USD:
            return _limit("the studio has reached today's spending limit")
        if asked("*") >= config.ASK_PER_DAY:
            return _limit("the studio has answered all the questions it can today")
        by_addr = asked(addr)
        if by_addr >= config.ASK_PER_CLIENT_PER_DAY:
            return _limit(f"this address has asked its {config.ASK_PER_CLIENT_PER_DAY} questions today")
        try:
            sid = _session(conn, request, response)
        except HTTPException as e:
            return _limit(e.detail)
        mine = asked(sid)
        if mine >= config.ASK_PER_SESSION_PER_DAY:
            return _limit(f"this session has asked its {config.ASK_PER_SESSION_PER_DAY} questions today")
        for who in (sid, addr, "*"):
            conn.execute("INSERT INTO questions_daily (day, session_id, questions) VALUES (?, ?, 1) "
                         "ON CONFLICT (day, session_id) DO UPDATE SET questions = questions + 1", (day, who))
    return sid, min(config.ASK_PER_SESSION_PER_DAY - mine, config.ASK_PER_CLIENT_PER_DAY - by_addr) - 1


# The audit write after an answer: 3 attempts of at most 1 s for the write lock and 2 pauses of 0.5 s.
ASK_RECORD_S = 4.0


def _record_answer(sid: str, q: Question, out: dict, day: str) -> None:
    u = out["usage"]
    with _runtime(write=True, busy_ms=1000) as conn:
        db.insert(conn, "audit", {
            "session_id": sid, "at": _now(), "actor": "studio_host", "action": "ask", "match_id": q.match_id,
            "model": DEPLOYMENT if u["calls"] or u["cost_usd"] > 0 else None, "tokens_in": u["tokens_in"],
            "tokens_out": u["tokens_out"], "cost_usd": round(u["cost_usd"], 6),
            "detail": {"question": q.question, "lang": q.lang, "ts": q.ts, "status": out["status"],
                       "reason": out["reason"], "fact_ids": out["fact_ids"]}})
        conn.execute("INSERT INTO usage_daily (day, session_id, cost_usd) VALUES (?, '*', ?) ON CONFLICT (day, session_id) "
                     "DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd", (day, u["cost_usd"]))


@app.get("/api/ask")
def get_ask():
    """The page's probe: {"available"} after the same checks as a question (_ask_ready), always a 200, since a
    4xx or 5xx shows as an error in the browser console of every visitor."""
    try:
        _ask_ready()
    except HTTPException:
        return {"available": False}
    return {"available": True}


@app.post("/api/ask", dependencies=[Depends(_ask_ready)])
async def post_ask(q: Question, request: Request, response: Response):
    from .agents import ask
    start = time.monotonic()  # the whole request stays under config.ASK_TIMEOUT_S, the page gives up at 60 s
    # SQLite waits up to 5 s for the write lock: the database work runs off the event loop
    times = await asyncio.to_thread(ask.match_times, q.match_id)
    if times is None:
        raise HTTPException(404, "unknown match")
    if q.ts > times[1]:
        raise HTTPException(422, "ts is after the end of the match")
    day = _now()[:10]
    counted = await asyncio.to_thread(_count_question, request, response, day)
    if isinstance(counted, JSONResponse):
        return counted
    sid, left = counted
    budget = config.ASK_TIMEOUT_S - (time.monotonic() - start) - ASK_RECORD_S
    out = await ask.answer_within(ENDPOINT, q.match_id, q.ts, q.question, q.lang, times[0], budget)
    for attempt in range(3):  # the question is counted and maybe paid for: its audit row and cost must be written
        try:
            await asyncio.to_thread(_record_answer, sid, q, out, day)
            break
        except Exception:
            if attempt == 2:
                logging.getLogger("uvicorn.error").exception("ask audit lost: cost_usd %.6f", out["usage"]["cost_usd"])
                raise
            await asyncio.sleep(0.5)
    return {"status": out["status"], "answer": out["answer"], "fact_ids": out["fact_ids"], "questions_left": left}


# --- the 3D frame-rate beacon -------------------------------------------------------------------
# After 30 s of 3D play the page sends one anonymous line: how fast the 3D view ran on that machine, so we
# can tell which renderers need the 2D suggestion. No address, no user agent, no free text: the address
# only counts the cap below, in memory, and is never logged.
PERF_PER_CLIENT_PER_DAY = 20   # one per 3D page load: a visitor reloading all day, not a script
PERF_PER_DAY = 5000            # bounds the lines the public link can write to Application Insights in a day
# the renderer string is visitor-controlled text: only its GPU family from this list is kept, first match wins
PERF_GPU_FAMILIES = (("software", ("swiftshader", "llvmpipe", "software", "basic render")), ("nvidia", ("nvidia", "geforce", "quadro")),
                     ("amd", ("amd", "radeon")), ("intel", ("intel",)), ("apple", ("apple",)), ("mali", ("mali",)),
                     ("adreno", ("adreno",)), ("powervr", ("powervr",)))
# shortcut: counted in this process's memory, right for the single replica; move it to a table if the app scales out
_perf_sent = {"day": "", "all": 0, "by_client": {}}
# Application Insights takes the "studiodesk" logger tree (telemetry.py); INFO, as the root default is WARNING
_perf_log = logging.getLogger("studiodesk.perf")
_perf_log.setLevel(logging.INFO)


class Perf(BaseModel):
    """Types are strict (a string is no number); values out of range are clamped, never stored as sent."""
    model_config = ConfigDict(extra="forbid", strict=True)
    match_id: str = Field(pattern=MATCH_PATTERN)
    fps_median: float = Field(allow_inf_nan=False)
    renderer: str | None = Field(default=None, max_length=1000)  # longer is no renderer name: refused
    screen_w: int
    screen_h: int
    dpr: float = Field(allow_inf_nan=False)

    @model_validator(mode="after")
    def _clamp(self):
        self.fps_median = round(min(max(self.fps_median, 0.0), 1000.0), 1)
        self.screen_w = min(max(self.screen_w, 0), 20000)
        self.screen_h = min(max(self.screen_h, 0), 20000)
        self.dpr = round(min(max(self.dpr, 0.25), 8.0), 2)
        name = (self.renderer or "").lower()
        self.renderer = next((fam for fam, keys in PERF_GPU_FAMILIES if any(k in name for k in keys)),
                             "other" if name.strip() else None)
        return self


@app.post("/api/perf", status_code=204)
def post_perf(p: Perf, request: Request):
    day, client = _now()[:10], _client(request)
    if _perf_sent["day"] != day:
        _perf_sent.update(day=day, all=0, by_client={})
    by_client = _perf_sent["by_client"]
    if _perf_sent["all"] >= PERF_PER_DAY:
        return _limit("the studio has all the frame-rate reports it needs today")
    if by_client.get(client, 0) >= PERF_PER_CLIENT_PER_DAY:
        return _limit(f"this address has sent its {PERF_PER_CLIENT_PER_DAY} frame-rate reports today")
    by_client[client] = by_client.get(client, 0) + 1
    _perf_sent["all"] += 1
    fields = p.model_dump()
    _perf_log.info("perf_3d %s", json.dumps(fields, sort_keys=True), extra={f"perf_{k}": v for k, v in fields.items()})
    return Response(status_code=204)


@app.post("/api/live")
def post_live():
    raise HTTPException(501, "live runs are not available yet; the replay is")


@app.get("/api/live/{run_id}/stream")
def live_stream(run_id: str):
    raise HTTPException(501, "live runs are not available yet; the replay is")


if WEB.is_dir():
    app.mount("/", PrecompressedStatic(directory=WEB, html=True), name="web")
