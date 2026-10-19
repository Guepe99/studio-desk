"""English voice-over for the replay, generated beforehand with Azure Speech (docs/voice.md).

`python -m studiodesk.voice M001 [--lang en] [--src DIR] [--out DIR] [--dry-run]` reads the
stories of a replay (a `replays/<match>/` pack when it has stories.json, else the static export in
`web/data/<match>/`), synthesises one mp3 per eligible story and writes
`<out>/voice/<story_id>.<lang>.mp3` plus the manifest `<out>/voice.json`:
`[{story_id, lang, file, duration_s, text_sha1, voice}]`, `file` relative to `<out>`.

Eligible: verifier status pass, rewritten or template (template lines are built from the fact
ledger by code, so they are verified too), default status auto_approved or needs_review (the page
decides per visitor whether the story is on air), safety not flagged. A story whose text and voice
are unchanged since the last run is skipped, so a rerun costs nothing. The F0 tier allows 20
requests per minute: requests are spaced MIN_INTERVAL_S apart and a 429 waits for Retry-After.
The key is read at run time from the Azure CLI and never written anywhere.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from xml.sax.saxutils import escape

from . import config

RESOURCE, GROUP, REGION = "studiodesk-speech", "rg-studiodesk", "swedencentral"
ENDPOINT = f"https://{REGION}.tts.speech.microsoft.com/cognitiveservices/v1"
OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3"
BITRATE = 48_000  # constant bit rate of OUTPUT_FORMAT: duration = bytes * 8 / BITRATE
MIN_INTERVAL_S = 3.1  # 60 s / 20 requests, plus a margin
ELIGIBLE_VERIFIER = {"pass", "rewritten", "template"}
ELIGIBLE_STATUS = {"auto_approved", "needs_review"}

# Per language: one voice for every story. Ava HD picks its tone from the text itself; it does not
# take mstts:express-as styles, so goals and recaps differ only in what they say (docs/voice.md).
VOICES = {
    "en": {"lang": "en-US", "voice": "en-US-Ava:DragonHDLatestNeural"},
}


def spoken(text):
    """What the voice reads: the verified text with broadcast pronunciations, no new content."""
    t = re.sub(r"\b(\d)-(\d)\b", lambda m: "-".join(SCORE_WORDS[int(g)] for g in m.groups()), text)  # 2-1: two-one
    t = re.sub(r"(\d)\s?/10\b", r"\1 out of 10", t)
    t = re.sub(r"(\d) m\b", r"\1 metres", t)
    t = re.sub(r"(\d) ?km/h\b", r"\1 kilometres per hour", t)
    t = re.sub(r"\b(\d{1,3})'(?=\s+[A-Z])", r"minute \1,", t)  # "73' Kimura": "minute 73, Kimura"
    t = re.sub(r"\b(\d{1,3})'", r"minute \1", t)
    return t[:1].upper() + t[1:]


SCORE_WORDS = ["nil", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]


def ssml(story, lang):
    """SSML for one story: the verified text, read by the language's voice."""
    v = VOICES[lang]
    doc = (f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="{v["lang"]}">'
           f'<voice name="{v["voice"]}">{escape(spoken(story["texts"][lang]))}</voice></speak>')
    return v["voice"], doc


def sha1(text):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def eligible(stories, lang):
    return [s for s in stories
            if (s.get("verifier") or {}).get("status") in ELIGIBLE_VERIFIER
            and s.get("default_status") in ELIGIBLE_STATUS
            and s.get("safety") != "flagged"
            and (s.get("texts") or {}).get(lang, "").strip()]


def azure_key():
    """key1 of the Speech resource, from the logged-in Azure CLI (the F0 resource has no custom
    subdomain, so Entra ID tokens are not accepted for synthesis)."""
    if os.environ.get("SPEECH_KEY"):
        return os.environ["SPEECH_KEY"]
    az = os.environ.get("AZ", str(Path.home() / ".local" / "bin" / "az"))
    return subprocess.run([az, "cognitiveservices", "account", "keys", "list", "-n", RESOURCE, "-g", GROUP,
                           "--query", "key1", "-o", "tsv"], capture_output=True, text=True, check=True).stdout.strip()


def http_post(url, headers, body):
    """(status, headers, bytes). The default transport; tests pass their own."""
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


class Synth:
    """Azure TTS over REST, one request at least MIN_INTERVAL_S after the previous one."""

    def __init__(self, key, post=http_post, clock=time.monotonic, sleep=time.sleep, retries=3):
        self.key, self.post, self.clock, self.sleep, self.retries = key, post, clock, sleep, retries
        self.last = None
        self.requests = 0

    def __call__(self, doc):
        headers = {"Ocp-Apim-Subscription-Key": self.key, "Content-Type": "application/ssml+xml",
                   "X-Microsoft-OutputFormat": OUTPUT_FORMAT, "User-Agent": "studiodesk-voice"}
        for _ in range(self.retries + 1):
            if self.last is not None:
                wait = self.last + MIN_INTERVAL_S - self.clock()
                if wait > 0:
                    self.sleep(wait)
            self.last = self.clock()
            self.requests += 1
            status, rh, data = self.post(ENDPOINT, headers, doc.encode("utf-8"))
            if status == 200 and data:
                return data
            if status != 429:
                raise RuntimeError(f"Azure Speech HTTP {status}: {data[:200]!r}")
            self.sleep(float(rh.get("Retry-After") or 60))
        raise RuntimeError("Azure Speech: still rate limited after retries")


def source_dir(match_id, src=None):
    if src:
        return Path(src)
    pack = config.ROOT / "replays" / match_id
    return pack if (pack / "stories.json").exists() else config.ROOT / "web" / "data" / match_id


def build(match_id, lang="en", src=None, out=None, synth=None, dry_run=False, log=print):
    """Voices the eligible stories of match_id; returns the manifest rows for lang."""
    if lang not in VOICES:
        raise SystemExit(f"no voice configured for '{lang}' yet (configured: {', '.join(VOICES)})")
    src = source_dir(match_id, src)
    out = Path(out) if out else config.ROOT / "replays" / match_id
    stories = json.loads((src / "stories.json").read_text())
    manifest_path = out / "voice.json"
    old = json.loads(manifest_path.read_text()) if manifest_path.exists() else []
    previous = {r["story_id"]: r for r in old if r["lang"] == lang}
    rows, made = [], 0
    for s in eligible(stories, lang):
        voice, doc = ssml(s, lang)
        rel = f"voice/{s['story_id']}.{lang}.mp3"
        row = {"story_id": s["story_id"], "lang": lang, "file": rel, "duration_s": None,
               "text_sha1": sha1(s["texts"][lang]), "voice": voice}
        prev = previous.get(s["story_id"])
        if prev and prev["text_sha1"] == row["text_sha1"] and prev["voice"] == voice and (out / rel).exists():
            rows.append(prev)
            continue
        if dry_run:
            log(f"would voice {s['story_id']} ({s['kind']}, {voice}): {spoken(s['texts'][lang])}")
            continue
        if synth is None:
            synth = Synth(azure_key())
        audio = synth(doc)
        (out / "voice").mkdir(parents=True, exist_ok=True)
        (out / rel).write_bytes(audio)
        row["duration_s"] = round(len(audio) * 8 / BITRATE, 2)
        rows.append(row)
        made += 1
        log(f"voiced {s['story_id']} {row['duration_s']} s, {len(audio)} bytes, {voice}")
    if dry_run:
        return rows
    keep = {r["file"] for r in rows}
    for f in (out / "voice").glob(f"*.{lang}.mp3"):
        if f"voice/{f.name}" not in keep:
            f.unlink()  # a story that is gone or no longer eligible
    others = [r for r in old if r["lang"] != lang]
    out.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(sorted(others + rows, key=lambda r: (r["story_id"], r["lang"])), indent=1) + "\n")
    size = sum((out / r["file"]).stat().st_size for r in rows)
    log(f"{match_id} {lang}: {len(rows)} clips ({made} new), {size / 1e6:.2f} MB, "
        f"{sum(r['duration_s'] for r in rows):.1f} s of audio")
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m studiodesk.voice")
    ap.add_argument("match_id")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--src", type=Path, help="folder with stories.json (default: replays/<match> or web/data/<match>)")
    ap.add_argument("--out", type=Path, help="default: replays/<match>")
    ap.add_argument("--dry-run", action="store_true", help="list what would be voiced, no Azure call")
    a = ap.parse_args(argv)
    if not re.fullmatch(r"M\d{3}", a.match_id):
        sys.exit("match_id is M001..M999")
    build(a.match_id, a.lang, a.src, a.out, dry_run=a.dry_run)


if __name__ == "__main__":
    main()
