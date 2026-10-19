"""Azure AI Content Safety over the stories of a run: `stories.safety` (docs/CONTRACT.md).

One text:analyze call per story, with its three texts joined, and at most MAX_CALLS calls per match
(the F0 tier allows 5 calls a second and 5000 a month). A story is `flagged` when any category has
severity FLAG_SEVERITY or more, `passed` otherwise, and stays `not_checked` when the call fails or
the cap is reached. Auth is Entra ID first (DefaultAzureCredential); if the resource refuses the
token, the key is read with the az CLI at run time and kept in memory only.
"""
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from collections import Counter

from . import rules

API_VERSION = "2024-09-01"
RESOURCE = ("studiodesk-safety", "rg-studiodesk")  # account, resource group
MAX_CALLS = 100
FLAG_SEVERITY = 2
MIN_INTERVAL_S = 0.25   # under the F0 limit of 5 calls a second
SCOPE = "https://cognitiveservices.azure.com/.default"
AZ = os.environ.get("AZ_CLI", "az")


def _az(*args):
    return subprocess.run([AZ, *args, "-o", "tsv"], check=True, capture_output=True, text=True, timeout=60).stdout.strip()


class AzureSafety:
    """text:analyze on the Content Safety resource; call it with a text, get {category: severity}."""

    def __init__(self, endpoint=None):
        self.endpoint = (endpoint or os.environ.get("AZURE_CONTENT_SAFETY_ENDPOINT") or _az(
            "cognitiveservices", "account", "show", "-n", RESOURCE[0], "-g", RESOURCE[1],
            "--query", "properties.endpoint")).rstrip("/")
        self.key, self.token, self.credential, self.last = None, None, None, 0.0

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
        time.sleep(max(0.0, self.last + MIN_INTERVAL_S - time.monotonic()))
        self.last = time.monotonic()
        body = json.dumps({"text": text[:10000], "outputType": "FourSeverityLevels"}).encode()
        url = f"{self.endpoint}/contentsafety/text:analyze?api-version={API_VERSION}"
        for attempt in (1, 2):
            try:
                headers = self._headers()
            except Exception:  # noqa: BLE001 - no Entra token here: fall back to the key
                if self.key or attempt == 2:
                    raise
                self._use_key()
                headers = self._headers()
            req = urllib.request.Request(url, body, {**headers, "Content-Type": "application/json"}, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    out = json.load(resp)
                return {c["category"]: c.get("severity") or 0 for c in out["categoriesAnalysis"]}
            except urllib.error.HTTPError as e:
                if e.code in (401, 403) and not self.key and attempt == 1:
                    self._use_key()
                    continue
                raise


def verdict(analysis):
    return "flagged" if any(v >= FLAG_SEVERITY for v in analysis.values()) else "passed"


def check_match(rt, match_id, analyze, max_calls=MAX_CALLS, log=print):
    """Set stories.safety for every story of the match; returns the count per status."""
    stories = rt.execute("SELECT story_id, texts FROM stories WHERE match_id = ? ORDER BY ts", (match_id,)).fetchall()
    counts, calls = Counter(), 0
    for story_id, texts in stories:
        texts = json.loads(texts)
        status = "not_checked"
        if calls < max_calls:
            calls += 1
            try:
                analysis = analyze("\n".join(texts.get(lang, "") for lang in rules.LANGS))
                status = verdict(analysis)
                if status == "flagged":
                    log(f"{story_id} flagged: {analysis}")
            except Exception as e:  # noqa: BLE001 - quota, network or auth: the story stays not_checked
                log(f"{story_id} not checked: {e!r}"[:200])
        rt.execute("UPDATE stories SET safety = ? WHERE match_id = ? AND story_id = ?", (status, match_id, story_id))
        counts[status] += 1
    rt.commit()
    return dict(counts) | {"calls": calls}
