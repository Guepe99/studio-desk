"""Booth commentary clips: a play-by-play voice and a co-commentator under the studio voice (docs/commentary.md).

The lines live in web/booth/lines.json as templates. Each template is cut into clips at its placeholders, and the
browser plays the clips of a line back to back (web/js/booth.js picks the lines, web/js/booth-audio.js plays them),
so nothing is synthesised during play.

`python -m studiodesk.booth shared --lang en [--dry-run]` renders the clips every match shares (template text,
fact numbers and units) into web/booth/<lang>/ with the manifest web/booth/booth.json.
`python -m studiodesk.booth M001 --lang en [--src DIR] [--out DIR] [--dry-run]` renders one match's clips (player
and team names, lines that name only the teams) from its line-up alone, into <out>/booth/<lang>/ with the manifest
<out>/booth.json (default out: replays/<match>; DEMO, a test fixture, goes to tests/web/booth-demo). A live match runs the same command before kick-off.

Manifest rows: {key, lang, role, text, file, duration_s, voice}, key "<role>|<text>", file relative to the
manifest. A clip already in the manifest with the same voice and file on disk is skipped, so a rerun costs nothing.
Every text is checked against data/forbidden_names.txt before it is synthesised. Kokoro-82M renders every clip,
locally, in its own venv (scripts/booth_kokoro.py); no booth clip calls Azure.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from . import config, names, voice
from .agents import rules
from .agents.phrasebook import short
from .facts.engine import half_up

LINES = config.ROOT / "web" / "booth" / "lines.json"
SHARED = config.ROOT / "web" / "booth"
PH = re.compile(r"\{(player|receiver|keeper|team2?|fact:[a-z_]+)(?:\|(of))?\}")
PUNCT = re.compile(r"\.\.\.|[!?.,:;]")
PEOPLE = {"player", "receiver", "keeper"}
PREP = {"it": "di", "es": "de"}
# Fact kinds a co line can cite, the unit it is said in, and the values a clip exists for.
UNIT = {"shot_speed": "km/h", "sprint_speed": "km/h", "shot_distance": "m", "line_height": "m", "momentum": "/10",
        "press_intensity": "/10", "pass_accuracy": "%", "distance_covered": "km", "formation": None}
RANGE = {"km/h": range(0, 131), "m": range(0, 71), "/10": [i / 10 for i in range(0, 101)],
         "%": range(0, 101), "km": [i / 10 for i in range(0, 141)]}
FORMATIONS = ["4-4-2", "4-3-3", "4-2-3-1", "3-5-2", "3-4-3", "5-3-2", "4-5-1", "4-1-4-1", "5-4-1", "4-4-1-1",
              "3-4-2-1"]
KOKORO_PY = os.environ.get("STUDIODESK_KOKORO_PY", str(config.ROOT / ".tts" / "kokoro" / "bin" / "python"))


def load_lines(path=LINES):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def variants(lines, role, lang):
    """Every template of one voice, each a list of sentences."""
    for kind, vs in lines[role][lang].items():
        for v in vs:
            yield kind, v if isinstance(v, list) else [v]


def number(v, unit, lang):
    """A fact value as the co-commentator says it: whole km/h, metres and per cent, tenths out of ten and in km."""
    if unit is None:
        return "-".join(str(int(v)))
    if unit == "km":
        v = v / 1000 if v > 200 else v
    # half up, as web/js/booth.js (Math.round) and the fact engine round: 10.45 km is "10.5"
    x = half_up(v * 10) / 10 if unit in ("/10", "km") else half_up(v)
    s = f"{x:.1f}".removesuffix(".0") if isinstance(x, float) else str(x)
    return s.replace(".", ",") if lang != "en" else s


def fact_texts(kind, value_spoken, lang, lines, end):
    """The clips a fact is said with: the number, then its unit (one clip per number, not per number and unit,
    keeps the shared set small enough for Kokoro on the CPU); a formation is one clip."""
    unit = UNIT[kind]
    return [value_spoken, lines["units"][lang][unit] + end] if unit else [value_spoken + end]


def pieces(sentence, role, lang, lines):
    """A sentence cut at its placeholders: [("text", s) | ("name", slot, form, mark) | ("fact", kind, end) |
    ("line", sentence)]. A sentence that names only the teams is one clip per match ("line")."""
    s = sentence.replace("{co}", lines["personas"][lang]["call"])
    found = list(PH.finditer(s))
    if not found:
        return [("text", s.strip())]
    if all(m[1].startswith("team") for m in found):
        return [("line", s)]
    out, pos = [], 0
    for m in found:
        text = s[pos:m.start()].strip()
        if re.search(r"\w", text):
            out.append(("text", text))
        p = PUNCT.match(s, m.end())
        mark = p[0] if p else ""
        pos = m.end() + len(mark)
        if m[1].startswith("fact:"):
            out.append(("fact", m[1][5:], "." if mark in ".!?" and mark else ""))
        else:
            # what follows a name sets how it is said: "Name!", "Name..." (pbp, mid-sentence), else "Name."
            tone = {"!": "!", "...": "..."}.get(mark, "..." if not mark and role == "pbp" else ".")
            out.append(("name", m[1], m[2], tone))
    tail = s[pos:].strip()
    if re.search(r"\w", tail):
        out.append(("text", tail))
    return out


def key(role, text):
    return f"{role}|{text}"


def shared_texts(lines, lang):
    """{key: (role, text)} for the clips every match shares."""
    out = {}
    for role in ("pbp", "co"):
        for _, sents in variants(lines, role, lang):
            for s in sents:
                for p in pieces(s, role, lang, lines):
                    if p[0] == "text":
                        out[key(role, p[1])] = (role, p[1])
                    elif p[0] == "fact":
                        unit = UNIT[p[1]]
                        values = FORMATIONS if unit is None else [number(v, unit, lang) for v in RANGE[unit]]
                        for v in values:
                            for t in fact_texts(p[1], v, lang, lines, p[2]):
                                out[key(role, t)] = (role, t)
    return out


def surnames(players):
    """How the booth calls each player: the surname, or the full name when two share it."""
    last = [p["name"].split()[-1] for p in players]
    return {p["player_id"]: (p["name"] if last.count(s) > 1 else s) for p, s in zip(players, last)}


def team_form(team_name, lang, form):
    return rules.club(short(team_name), lang, PREP.get(lang) if form == "of" else None)


def fill_teams(sentence, lang, team, team2):
    def sub(m):
        return team_form(team if m[1] == "team" else team2, lang, m[2])
    s = PH.sub(sub, sentence)
    return s[:1].upper() + s[1:]


def match_names(lang, meta):
    """What the browser needs to fill a template for this match: each player's called name, each team's forms."""
    return {"players": surnames(meta["players"]),
            "teams": {t["team_id"]: {"": team_form(t["name"], lang, None), "of": team_form(t["name"], lang, "of")}
                      for t in meta["teams"]}}


def match_texts(lines, lang, meta):
    """{key: (role, text)} for one match: names in each tone a template needs, and team-only lines."""
    called = sorted(set(surnames(meta["players"]).values()))
    teams = [t["name"] for t in meta["teams"]]
    out = {}
    for role in ("pbp", "co"):
        for _, sents in variants(lines, role, lang):
            for s in sents:
                for p in pieces(s, role, lang, lines):
                    if p[0] == "line":
                        for a, b in (teams, teams[::-1]):
                            t = fill_teams(p[1].replace("{co}", lines["personas"][lang]["call"]), lang, a, b)
                            out[key(role, t)] = (role, t)
                    elif p[0] == "name":
                        pool = called if p[1] in PEOPLE else [team_form(n, lang, p[2]) for n in teams]
                        for n in pool:
                            out[key(role, n + p[3])] = (role, n + p[3])
    return out


# A play-by-play line that ends in "!" (a goal, a save, a miss) is said higher, louder and drawn out, as commentators do
# at a goal (Trouvain 2011: the goal roar at 400 Hz and above, with lengthening); Kokoro has no emotion control
HYPE_AF = "rubberband=pitch=1.19:tempo=0.94:formant=preserved,volume=3dB"


def hype(role, text):
    return HYPE_AF if role == "pbp" and "!" in text else ""


def clip_file(lang, k, voice_name, gain_db, sub, hype_af=""):
    """The name holds what makes the clip: a new voice, gain or hype is a new file, so a resumed build never keeps a stale one."""
    made = f"{k}|{voice_name}|{gain_db}" + (f"|{hype_af}" if hype_af else "")
    return f"{sub}{lang}/{hashlib.sha1(made.encode('utf-8')).hexdigest()[:12]}.mp3"


def row(job, lang):
    return {"key": job["key"], "lang": lang, "role": job["role"], "text": job["text"], "file": job["file"],
            "duration_s": round(job["path"].stat().st_size * 8 / voice.BITRATE, 3), "voice": job["voice"]}


def kokoro_render(jobs, lang, cfg):
    """Kokoro clips in one run of scripts/booth_kokoro.py inside the Kokoro venv (model load once)."""
    with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
        json.dump([{**j, "path": str(j["path"])} for j in jobs], f)
        f.flush()
        env = {**os.environ, "HF_HOME": os.environ.get("HF_HOME", str(config.ROOT / ".tts" / "hf"))}
        subprocess.run([KOKORO_PY, "-I", str(config.ROOT / "scripts" / "booth_kokoro.py"), f.name, lang], check=True,
                       env=env)


RENDER = {"kokoro": kokoro_render}


def build(texts, lang, out, lines, render=None, dry_run=False, log=print, names_=None, sub="booth/"):
    """Render the missing clips of `texts` into `out` and merge them into out/booth.json:
    {"clips": [row], "names": {lang: match_names}} (names only for a match)."""
    out = Path(out)
    cfg = lines["voices"][lang]
    manifest = out / "booth.json"
    doc = json.loads(manifest.read_text()) if manifest.exists() else {"clips": []}
    keep = {(r["lang"], r["key"]): r for r in doc["clips"] if r["lang"] != lang}  # this language: rebuilt below
    jobs = []
    for k, (role, text) in sorted(texts.items()):
        hit = names.find_forbidden(text)
        if hit:
            raise ValueError(f"forbidden name {hit!r} in booth line {text!r}")
        gain, af = cfg["gain_db"][role], hype(role, text)
        file = clip_file(lang, k, cfg[role], gain, sub, af)
        job = {"key": k, "role": role, "text": text, "say": voice.spoken(text, lang), "voice": cfg[role],
               "gain_db": gain, "hype": af, "file": file, "path": out / file}
        if (out / file).exists():  # the file name holds key and voice: on disk means done, even after a crash
            keep[(lang, k)] = row(job, lang)
        else:
            jobs.append(job)
    chars = sum(len(j["say"]) for j in jobs)
    log(f"booth {out.name} {lang}: {len(texts)} clips, {len(jobs)} to render, {chars} characters ({cfg['engine']})")
    if names_ is not None:
        doc.setdefault("names", {})[lang] = names_
    if dry_run:
        return jobs
    (out / sub / lang).mkdir(parents=True, exist_ok=True)
    if jobs:
        (render or RENDER[cfg["engine"]])(jobs, lang, cfg)
    for j in jobs:
        keep[(lang, j["key"])] = row(j, lang)
    doc["clips"] = sorted(keep.values(), key=lambda r: (r["lang"], r["key"]))
    manifest.write_text(json.dumps(doc, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
    return jobs


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m studiodesk.booth")
    ap.add_argument("what", help="shared, or a match id (M001, DEMO)")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--src", type=Path, help="folder with meta.json (default: web/data/<match>)")
    ap.add_argument("--out", type=Path, help="default: web/booth for shared, replays/<match> for a match")
    ap.add_argument("--dry-run", action="store_true", help="count clips and characters, no synthesis")
    a = ap.parse_args(argv)
    lines = load_lines()
    if a.what == "shared":
        build(shared_texts(lines, a.lang), a.lang, a.out or SHARED, lines, dry_run=a.dry_run, sub="")
        return
    if not re.fullmatch(r"M\d{3}|DEMO", a.what):
        sys.exit("what is shared, M001..M999 or DEMO")
    meta = json.loads(((a.src or config.ROOT / "web" / "data" / a.what) / "meta.json").read_text())
    out = a.out or config.ROOT / ("tests/web/booth-demo" if a.what == "DEMO" else f"replays/{a.what}")
    build(match_texts(lines, a.lang, meta), a.lang, out, lines,
          dry_run=a.dry_run, names_=match_names(a.lang, meta))


if __name__ == "__main__":
    main()
