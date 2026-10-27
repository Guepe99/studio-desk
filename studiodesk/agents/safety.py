"""Azure AI Content Safety over the stories of a run: `stories.safety` (docs/CONTRACT.md).

One text:analyze call per story, with its three texts joined, and at most MAX_CALLS calls per match
(the F0 tier allows 5 calls a second and 5000 a month). A story is `flagged` when any category has
severity FLAG_SEVERITY or more, and then also `needs_review` (a flagged story never airs on its own);
`passed` otherwise. It stays `not_checked` when the text is empty, the analysis comes back empty, the
call fails, the cap of HTTP requests or the deadline is reached, or MAX_FAILURES calls in a row failed.
Auth is Entra ID first (DefaultAzureCredential); if the resource refuses the
token, the key is read with the az CLI at run time and kept in memory only.
"""
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import Counter

from . import rules

API_VERSION = "2024-09-01"
# account and resource group of infra/main.bicep, used only when no endpoint is set; another deployment sets its own
RESOURCE = (os.environ.get("CONTENT_SAFETY_RESOURCE", "studiodesk-safety"), os.environ.get("CONTENT_SAFETY_GROUP", "rg-studiodesk"))
MAX_CALLS = 100
FLAG_SEVERITY = 2
# A producer's edit, and a visitor's question or answer in Ask, is flagged only from severity 4 (medium): at 2, the
# lowest, football words ("close range", "strike") read as violence. The agents' drafts keep FLAG_SEVERITY.
EDIT_FLAG_SEVERITY = 4
MIN_INTERVAL_S = 0.25   # under the F0 limit of 5 calls a second
MAX_FAILURES = 3        # consecutive failed calls before the step gives up
DEADLINE_S = 300.0      # the whole step, so a dead endpoint cannot hold a run for 50 minutes
SCOPE = "https://cognitiveservices.azure.com/.default"
AZ = os.environ.get("AZ_CLI", "az")


class Throttled(Exception):
    """The resource refused a call for its rate limit (429) or its monthly quota (403 naming the quota)."""


def _az(*args):
    return subprocess.run([AZ, *args, "-o", "tsv"], check=True, capture_output=True, text=True, timeout=60).stdout.strip()


class AzureSafety:
    """text:analyze on the Content Safety resource; call it with a text, get {category: severity}.
    `shield(text)` runs Prompt Shields (text:shieldPrompt) on a user prompt: True when it detects an attack."""

    def __init__(self, endpoint=None, timeout=30):
        self.endpoint = (endpoint or os.environ.get("AZURE_CONTENT_SAFETY_ENDPOINT") or _az(
            "cognitiveservices", "account", "show", "-n", RESOURCE[0], "-g", RESOURCE[1],
            "--query", "properties.endpoint")).rstrip("/")
        self.key, self.token, self.credential, self.last, self.requests = None, None, None, 0.0, 0
        self.timeout = timeout
        self.lock = threading.Lock()  # the spacing holds across threads (two visitors' questions at once)

    def _headers(self):
        if self.key:
            return {"Ocp-Apim-Subscription-Key": self.key}
        if self.token is None or self.token.expires_on - 60 < time.time():
            if self.credential is None:
                from azure.identity import DefaultAzureCredential
                self.credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
            self.token = self.credential.get_token(SCOPE)
        return {"Authorization": f"Bearer {self.token.token}"}

    def _use_key(self):
        self.key = _az("cognitiveservices", "account", "keys", "list", "-n", RESOURCE[0], "-g", RESOURCE[1],
                       "--query", "key1")

    def __call__(self, text):
        out = self._post("analyze", {"text": text[:10000], "outputType": "FourSeverityLevels"})
        return {c["category"]: c.get("severity") or 0 for c in out["categoriesAnalysis"]}

    def shield(self, text):
        out = self._post("shieldPrompt", {"userPrompt": text[:10000], "documents": []})
        return out["userPromptAnalysis"]["attackDetected"]

    def _post(self, op, payload):
        with self.lock:
            time.sleep(max(0.0, self.last + MIN_INTERVAL_S - time.monotonic()))
            self.last = time.monotonic()
        body = json.dumps(payload).encode()
        url = f"{self.endpoint}/contentsafety/text:{op}?api-version={API_VERSION}"
        for attempt in (1, 2):
            try:
                headers = self._headers()
            except Exception:  # noqa: BLE001 - no Entra token here: fall back to the key
                if self.key or attempt == 2:
                    raise
                self._use_key()
                headers = self._headers()
            req = urllib.request.Request(url, body, {**headers, "Content-Type": "application/json"}, method="POST")
            self.requests += 1
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return json.load(resp)
            except urllib.error.HTTPError as e:
                if e.code == 429 or (e.code == 403 and "quota" in _body(e).lower()):
                    raise Throttled(f"content safety {e.code}") from None
                if e.code in (401, 403) and not self.key and attempt == 1:
                    self._use_key()
                    continue
                raise


def _body(e):
    try:
        return e.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 - no body to read
        return ""


def verdict(analysis, threshold=FLAG_SEVERITY):
    return "flagged" if any(v >= threshold for v in analysis.values()) else "passed"


def check_match(rt, match_id, analyze, max_calls=MAX_CALLS, log=print, deadline_s=DEADLINE_S):
    """Set stories.safety for every story of the match; returns the count per status.

    Only a story that passed gets the default_status its risk gives (rules.default_status); every
    other status (flagged, not_checked) means needs_review. The analyst's note is checked with the
    lines, and so is the AI proposal. The cap counts HTTP requests when the analyzer counts them (`analyze.requests`), calls otherwise.
    """
    stories = rt.execute("SELECT story_id, texts, analysis_en, risk, verifier FROM stories WHERE match_id = ? ORDER BY ts",
                         (match_id,)).fetchall()
    counts, calls, failures, end = Counter(), 0, 0, time.monotonic() + deadline_s
    for story_id, texts, analysis, risk, verifier in stories:
        texts, proposals = json.loads(texts), json.loads(verifier or "{}").get("proposals") or {}
        # the AI proposal sits on the desk one click from air: it is checked with the lines
        text = "\n".join(t for t in [texts.get(lang, "") for lang in rules.LANGS] + [analysis or ""]
                         + [proposals.get(lang, "") for lang in rules.LANGS] if t.strip())
        status = "not_checked"
        if (text and getattr(analyze, "requests", calls) < max_calls and failures < MAX_FAILURES
                and time.monotonic() < end):
            calls += 1
            try:
                analysis = analyze(text)
                failures = 0
                status = verdict(analysis) if analysis else "not_checked"
                if status == "flagged":
                    log(f"{story_id} flagged: {analysis}")
            except Exception as e:  # noqa: BLE001 - quota, network or auth: the story stays not_checked
                failures += 1
                log(f"{story_id} not checked: {type(e).__name__}")
        rt.execute("UPDATE stories SET safety = ?, default_status = ? WHERE match_id = ? AND story_id = ?",
                   (status, rules.default_status(risk) if status == "passed" else "needs_review", match_id, story_id))
        counts[status] += 1
    rt.commit()
    return dict(counts) | {"calls": calls}
