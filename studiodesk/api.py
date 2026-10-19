"""HTTP API and static site (docs/CONTRACT.md, API). Skeleton: health, one model call, the web page."""
import json
import mimetypes
import os
import re
import secrets
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import lru_cache
from stat import S_ISREG
import time
from pathlib import Path
from typing import Annotated, Literal

import httpx
from fastapi import FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StringConstraints, model_validator

from . import __version__, db

WEB = Path(__file__).resolve().parent.parent / "web"
ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT", "")  # https://<account>.openai.azure.com
DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-5-mini")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

# No /docs or /openapi.json in public: they would advertise the admin route and its header.
app = FastAPI(title="Studio Desk", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(GZipMiddleware, minimum_size=1000)
SECURITY_HEADERS = {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
                    "Strict-Transport-Security": "max-age=31536000", "Content-Security-Policy": "frame-ancestors 'none'"}


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers.update(SECURITY_HEADERS)
    return response
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


class PrecompressedStatic(StaticFiles):
    """Serves <file>.gz when the build left one: gzipping 25 MB of tracking per visit is too slow."""

    async def get_response(self, path, scope):
        headers = {"Vary": "Accept-Encoding"}
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
MAX_ACTIONS_PER_SESSION = 300   # decisions and kill-switch flips: plenty for a judge, a wall for a script
MAX_NEW_SESSIONS_PER_DAY = 5000  # with the cap above, bounds what the public link can write in a day
MAX_BODY_BYTES = 16384
SESSION_RE = re.compile(r"[A-Za-z0-9_-]{32}")
NO_CONTROL_CHARS = r"^[^\x00-\x09\x0b-\x1f\x7f]*$"  # newlines allowed

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=EDIT_MAX_CHARS,
                                        pattern=NO_CONTROL_CHARS)]


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    match_id: str = Field(pattern=MATCH_PATTERN)
    story_id: str = Field(pattern=r"^S-\d{6}$")
    decision: Literal["approved", "edited", "rejected"]
    edited_text: dict[Literal["en", "it", "es"], Text] | None = None

    @model_validator(mode="after")
    def _text_only_with_edit(self):
        if (self.decision == "edited") != bool(self.edited_text):
            raise ValueError("edited_text is required for 'edited' and not allowed otherwise")
        return self


class Kill(BaseModel):
    model_config = ConfigDict(extra="forbid")
    on: StrictBool


@app.middleware("http")
async def body_cap(request: Request, call_next):
    # shortcut: trusts Content-Length; a chunked body is not counted. The ingress caps those.
    if request.method == "POST" and int(request.headers.get("content-length") or 0) > MAX_BODY_BYTES:
        return JSONResponse({"detail": "request body too large"}, status_code=413)
    return await call_next(request)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def _runtime():
    conn = db.runtime()
    try:
        with conn:  # one transaction: an error rolls back the session row and the audit row too
            yield conn
    finally:
        conn.close()


def _session(conn, request: Request, response: Response, create: bool = True) -> str | None:
    sid = request.cookies.get(COOKIE, "")
    if SESSION_RE.fullmatch(sid) and conn.execute("SELECT 1 FROM sessions WHERE session_id = ?", (sid,)).fetchone():
        return sid
    if not create:
        return None
    if conn.execute("SELECT count(*) FROM sessions WHERE created_at >= ?", (_now()[:10],)).fetchone()[0] >= MAX_NEW_SESSIONS_PER_DAY:
        raise HTTPException(429, "too many new sessions today; the replay still works without saving decisions")
    sid = secrets.token_urlsafe(24)
    conn.execute("INSERT INTO sessions (session_id, created_at) VALUES (?, ?)", (sid, _now()))
    https = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"  # TLS ends at the ingress
    response.set_cookie(COOKIE, sid, max_age=30 * 86400, httponly=True, samesite="lax", secure=https, path="/")
    return sid


def _actions(conn, sid: str) -> int:
    return conn.execute("SELECT count(*) FROM audit WHERE session_id = ? AND actor = 'human'", (sid,)).fetchone()[0]


def _spend(conn, sid: str) -> None:
    if _actions(conn, sid) >= MAX_ACTIONS_PER_SESSION:
        raise HTTPException(429, f"this session has used its {MAX_ACTIONS_PER_SESSION} desk actions")


@lru_cache(maxsize=16)
def _replay_story_ids(path: Path, mtime_ns: int) -> frozenset:
    return frozenset(s["story_id"] for s in json.loads(path.read_text(encoding="utf-8")))


def _story_known(conn, match_id: str, story_id: str) -> bool:
    if conn.execute("SELECT 1 FROM stories WHERE match_id = ? AND story_id = ?", (match_id, story_id)).fetchone():
        return True
    path = WEB / "data" / match_id / "stories.json"
    try:
        return story_id in _replay_story_ids(path, path.stat().st_mtime_ns)
    except (OSError, ValueError, KeyError, TypeError):
        return False


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
def get_session(request: Request, response: Response):
    with _runtime() as conn:
        sid = _session(conn, request, response)
        kill = conn.execute("SELECT kill_switch FROM sessions WHERE session_id = ?", (sid,)).fetchone()[0]
        return {"kill_switch": bool(kill), "actions_left": MAX_ACTIONS_PER_SESSION - _actions(conn, sid)}


@app.get("/api/decisions")
def get_decisions(request: Request, response: Response, match_id: str = Query(pattern=MATCH_PATTERN)):
    with _runtime() as conn:
        sid = _session(conn, request, response, create=False)
        if sid is None:
            return {"match_id": match_id, "kill_switch": False, "decisions": []}
        kill = conn.execute("SELECT kill_switch FROM sessions WHERE session_id = ?", (sid,)).fetchone()[0]
        rows = conn.execute("SELECT story_id, decision, edited_text, at FROM session_decisions "
                            "WHERE session_id = ? AND match_id = ? ORDER BY story_id", (sid, match_id)).fetchall()
    return {"match_id": match_id, "kill_switch": bool(kill),
            "decisions": [{**dict(r), "edited_text": json.loads(r["edited_text"]) if r["edited_text"] else None} for r in rows]}


@app.post("/api/decisions")
def post_decision(d: Decision, request: Request, response: Response):
    with _runtime() as conn:
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
                     (sid, at, d.decision, d.match_id, d.story_id, json.dumps({"langs": sorted(d.edited_text or {})})))
    return {"story_id": d.story_id, "decision": d.decision, "edited_text": d.edited_text, "at": at}


@app.post("/api/kill")
def post_kill(k: Kill, request: Request, response: Response):
    with _runtime() as conn:
        sid = _session(conn, request, response)
        _spend(conn, sid)
        conn.execute("UPDATE sessions SET kill_switch = ? WHERE session_id = ?", (int(k.on), sid))
        conn.execute("INSERT INTO audit (session_id, at, actor, action) VALUES (?, ?, 'human', ?)",
                     (sid, _now(), "ai_off" if k.on else "ai_on"))
    return {"kill_switch": k.on}


@app.get("/api/audit")
def get_audit(request: Request, response: Response, match_id: str = Query(pattern=MATCH_PATTERN)):
    """This visitor's actions plus the agents' rows for the match (session_id NULL), newest first."""
    with _runtime() as conn:
        sid = _session(conn, request, response, create=False)
        rows = conn.execute(
            "SELECT at, actor, action, match_id, story_id, model, tokens_in, tokens_out, cost_usd, detail FROM audit "
            "WHERE (session_id = ? AND (match_id = ? OR match_id IS NULL)) OR (session_id IS NULL AND match_id = ?) "
            "ORDER BY id DESC LIMIT 500", (sid, match_id, match_id)).fetchall()
    return {"match_id": match_id, "rows": [{**dict(r), "detail": json.loads(r["detail"])} for r in rows]}


@app.post("/api/live")
def post_live():
    raise HTTPException(501, "live runs are not available yet; the replay is")


@app.get("/api/live/{run_id}/stream")
def live_stream(run_id: str):
    raise HTTPException(501, "live runs are not available yet; the replay is")


if WEB.is_dir():
    app.mount("/", PrecompressedStatic(directory=WEB, html=True), name="web")
