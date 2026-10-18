"""HTTP API and static site (docs/CONTRACT.md, API). Skeleton: health, one model call, the web page."""
import mimetypes
import os
import re
import secrets
from stat import S_ISREG
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__

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

if WEB.is_dir():
    app.mount("/", PrecompressedStatic(directory=WEB, html=True), name="web")
