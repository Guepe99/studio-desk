# Match commentary: the booth

Under the studio voice, the replay has a commentary booth: a play-by-play voice and a co-commentator, with a
stadium crowd underneath. It works for any match, recorded or live, with no script written per match. The
booth picks lines from templates as the events and the fact ledger arrive. Before kick-off it renders the clips: the shared ones once, the names from the line-up of each match.
During play nothing is synthesised and nothing is called. The browser plays the clips back to back with the
Web Audio API.

The voice button turns on the studio voice, the booth and the crowd together. They play only at 1x. A seek,
a speed change, the button and a language switch stop them, and a pause pauses them. The studio voice comes
first (rule A7 below).

## Commentators and voices

The commentators are fictional people with AI voices. The page labels them in the voice button
("AI voice-over on, with AI match commentary by fictional commentators and crowd sound"). Their names live in
`web/booth/lines.json` (`personas`). Only the co-commentator's first name is ever spoken, when the
play-by-play hands over to him.

| language | play-by-play | co-commentator |
|---|---|---|
| `en` | Neil Haverford, Kokoro `am_michael` | Dan Kettering, Kokoro `am_fenrir` |
| `it` | Paola Serrani, Kokoro `if_sara` | Marco Bellardi, Kokoro `im_nicola` |
| `es` | Lucía Olmedo, Kokoro `ef_dora` | Andrés Calvete, Kokoro `em_alex` |

All clips come from Kokoro-82M (Apache-2.0), which runs on our own CPU; the booth makes no Azure calls. It
was chosen by ear, comparing the same nine lines from Azure F0 (Andrew and Davis HD in
English, stitched from fragments; Alessio and Giuseppe in Italian; Tristan and Alvaro in Spanish) with
Kokoro reading whole sentences. Chatterbox was dropped untried: its smallest export (q4, about 1.55 GB)
does not fit the 2 GB disk cap next to Kokoro (1.7 GB), and the 2 shared vCPUs were already the bottleneck.
The studio voice is unchanged: Azure, `docs/voice.md`.

Kokoro is pinned: `kokoro` 0.9.4, `misaki` 0.9.4, `torch` 2.13.0+cpu, `transformers` 5.10.4
(`scripts/booth-kokoro-requirements.txt`), and model revision `f3ff3571791e39611d31c381e3a41a3af07b4987` of
`hexgrad/Kokoro-82M`. `scripts/booth-kokoro-setup.sh` checks the weights and the six voice files by SHA256.
It installs into `.tts/` (git-ignored, about 1.7 GB), apart from the project venv. Delete `.tts/` after a
render.

## How a line becomes clips

The templates sit in `web/booth/lines.json`: per voice, per language, per kind of moment. Each kind has
several variants, and a routine one (pass, interception, tackle, cross, take-on, foul, clearance) has 10 to
12. The fill-in kinds (A6: possession, build-up, back pass, restart, pause, celebration,
kick-off wait, and the co's opinions on shape and tempo and after a goal) have 10 to 16 each, with no
numbers. The same variant never plays twice in a row. The placeholders are `{player}`,
`{receiver}`, `{keeper}`, `{team}`, `{team2}` (with an `|of` form for Italian and Spanish articles),
`{fact:kind}` and `{co}`. Templates hold no digits.

A template is cut at its placeholders (`pieces()`, the same in `studiodesk/booth.py` and `web/js/booth.js`).
Every piece is rendered whole, as a short sentence of its own:

- the text around a name ("wins it back.");
- the name, in the tone of the punctuation after it: `Name!` excited, `Name...` rising, `Name.` level.
  The booth calls a player by surname, or by full name when two players share it;
- a fact, as two clips: its number ("102"), then its unit and end ("kilometres an hour."). A formation is
  one clip ("4-3-3.");
- a sentence that names only the teams, rendered whole for each match.

Every sentence has at most one player name, so a line is a name plus the rest. We considered rendering
whole sentences with each name filled in, but the count explodes. In English, M001 has 154 one-name
sentences and 30 called players, so whole sentences would need 4,733 renders per match, against 158 for
the names. Rendering each fact number with its unit would need 699 shared clips in English, against 250
for the number and unit pieces.

The six voices come out of Kokoro up to 10 dB apart (from -25.7 LUFS for `ef_dora` to -15.5 for `if_sara`), so
each gets a fixed gain (`gain_db` in `lines.json`) that brings it to about -21 LUFS, the level of the studio
clips, and a limiter keeps peaks under -1 dBFS. Kokoro has no control for emotion, so a play-by-play line with
a "!" (a goal, a save, a miss, a name called on them) is rendered 3 semitones higher with its formants kept,
6% slower and 3 dB louder (`HYPE_AF` in `studiodesk/booth.py`): at a goal, commentators' pitch rises to 400 Hz
and above, with lengthening (Trouvain 2011, https://www.coli.uni-saarland.de/~trouvain/trouvain_football_2011.pdf). Every clip is rendered with a fixed seed, so a run gives the
same clip again on the same machine.

Clip counts, Kokoro, 24 kHz mono mp3 at 48 kbit/s like the studio clips:

| | en | it | es |
|---|---|---|---|
| shared (`web/booth/<lang>/`) | 566 | 602 | 603 |
| per match (`replays/<match>/booth/<lang>/`), M001 | 248 | 238 | 236 |
| DEMO fixture (`tests/web/booth-demo/booth/<lang>/`) | 272 | 262 | 260 |

Build commands. They resume: a clip whose file exists is skipped, because the file name hashes key and
voice.

    scripts/booth-kokoro-setup.sh                         # once: .tts/kokoro venv, model and voices
    .venv/bin/python -m studiodesk.booth shared --lang en # web/booth/en/ + web/booth/booth.json
    .venv/bin/python -m studiodesk.booth M001 --lang en   # replays/M001/booth/en/ + replays/M001/booth.json
    .venv/bin/python -m studiodesk.booth M001 --lang it --dry-run   # count only

Build on CI. On a shared 2-vCPU server (about 65% of the CPU taken by the host) the full set would take about
11 hours, so it runs on GitHub-hosted runners: `.github/workflows/booth-render.yml`, one job per language
and clip set, each running the same command as above with the same setup script, its clips uploaded as an
artifact. To merge them:

    gh run download <run id> -p 'booth-*' -D /tmp/booth-ci
    for d in /tmp/booth-ci/booth-*; do cp -r "$d"/. .; done   # clips; the per-job manifests overwrite each other
    for l in en it es; do for w in shared M001 M002 M003 M004 DEMO; do
      .venv/bin/python -m studiodesk.booth $w --lang $l; done; done   # every clip is on disk: rewrites the manifests only

Each text is checked against `data/forbidden_names.txt` before it is rendered, and a hit stops the build.
The Dockerfile copies `replays/<match>/` into `web/data/<match>/`, booth files included. `web/booth/` ships
with `web/`.

## The planner (`web/js/booth.js`)

`Booth.step(input)` takes the next input in time order and returns the items it starts. An input is a fact,
an event, a studio clip, a period end, or a one-second tick. The booth never looks ahead: it knows only what
it was fed. A shot's outcome comes from the shot event itself. `planMatch()` drives a replay through the
same function, and a test feeds M001 one input at a time and checks that the result equals the replay plan.
Numbers come only from facts whose `ts` is at or before the line, at most one per co turn, and only from the
co-commentator. Names come only from the match data. A line whose clips are missing is skipped, so a live
match whose names are not rendered yet still gets the name-free lines.

The rules, from the research below:

- A2. After a line, the same voice waits at least 1 s, and usually 1 to 4 s [LF]. A priority line (A or B)
  waits only the 1 s.
- A3. Priorities. These are always called: goals, shots, saves and cards (an A line waits up to 3 s for the
  voice). Fouls, corners, free kicks and offsides are usually called (B, up to 1 s). Passes, take-ons,
  crosses, interceptions, tackles and clearances are called when the voice is free (C). Throw-ins, goal kicks
  and short free kicks are not called.
- A4. Every pass names the receiver, own half included (our rule; the research names it in the final
  third, on 30 m passes and into the other half). A pass 8 m or more backwards is called as a back pass. No
  name twice within 6 s. At most 3 names in a row, then a 2 s pause [KI, QR].
- A5. The goal call is short, then the booth holds 9 to 12 s while the crowd roars [GT, BK, TR]. A
  follow-up comes after the hold (long-range goal, sprint before the goal, or a plain one).
- A6. Our rule replaces the research here, which favours silence [GT]: the booth is never silent
  for more than 6 s, except in the goal hold, during a studio clip and its 1.5 s, at half-time and after full-time. After 3.5 s of silence it fills: in play with a
  possession or build-up line ("Redwick keeping it", "Name looking for an opening"), a fresh fact or a co
  opinion on shape and tempo; in a dead ball (a foul, an offside, a shot or save that ends play, a ball off
  the pitch, or 8 s without an event) with the restart for the team that did not touch it last, a pause line
  or the co; after a goal with the celebration, then the wait for the kick-off. The co comes in while it is
  under its share and never in the final third. A fill-in line gives way to any A or B line. No variant of a
  kind twice in a row, no fill-in kind twice in a row for one voice. The research's silence in quiet
  possession [GT] is dropped.
- A7. The studio voice first. When a studio clip starts, the booth's lines stop (30 ms fade), the queue is
  cleared, nothing starts until 1.5 s after the clip, and the crowd ducks. The booth resumes on a fresh
  shot, save, foul or set piece, on any event 8 s after that, or with a fill-in line (A6). Only the break exchange survives
  a studio clip; the goal follow-up gives way to it, since the clip already tells the scorer, the speed and the score. The planner leaves room for each on-air studio clip, and the player enforces it again
  from `voice.current` [VG, CT].
- B. Crowd. A bed loops all match. The anticipation sound rises when a team strings passes in the final
  third. An "ooh" follows a shot from 18 m or less that misses (after 0.3 s) or is saved (after 1 s), and the
  roar follows a goal. The whistle sounds at fouls (cards included), kick-offs and period ends.
- C1. The co says why, never what was just said [CT, MK]. Colour comes from trends in the facts (momentum
  8/10 or more, press 4.5/10 or more, a line held 40 m or more or 18 m or less from goal, a shot of 100 km/h
  or more, a sprint of 32 km/h or more, a formation change), never from a single pass.
- C2. The co speaks in stoppages, never in the final third: within 15 s of a shot that ends play (always
  after a shot of 100 km/h or more, otherwise with probability 0.7), after a card, after the goal hold, in
  lulls with a fresh fact, and at half-time and full-time [LF, KL]. A generic stoppage line comes with
  probability 0.35, raised to 1 while the co is under its share and to 0 while it is over.
- C3. The co keeps 20 to 30 % of the booth's speech. The planner steers to 23 to 27 % [KL].
- C4. Handover: a 0.3 to 0.8 s pause, sometimes the co's first name or a question. The co hands back
  unmarked [KL].
- C5. Co turns are one or two sentences.

On M001, with the estimated durations used while the clips render, the planner makes 335 lines in English
(332 in Italian, 346 in Spanish). The co's share is 23.7 to 24.1 %, the median gap between lines is 4.4
to 4.9 s, and there are 68 crowd sounds.

## Playback (`web/js/booth-audio.js`)

The AudioContext is created inside the voice button's click, so autoplay rules allow it. Lines are placed
on the audio clock 1 s ahead, and their clips are fetched and decoded 15 s ahead. A clip that is not
decoded in time is skipped, never played late. Every join has a 6 ms fade. The crowd bus ducks to 0.6
(-4.4 dB) under any voice, booth or studio. The studio clips sit at about -21 LUFS and the booth clips at
about -19.5 LUFS. The crowd files are levelled so the bed sits about -27 LUFS before ducking.

`scripts/booth-render.mjs` mixes a stretch of a replay to one mp3 the way the page plays it, with the voice
and crowd stems as wav, for listening and level checks:

    node scripts/booth-render.mjs M001 en 475 715 /tmp/commentary-en.mp3

## Live use

1. Before kick-off, as soon as the line-up is known: `python -m studiodesk.booth <match> --lang <l> --src
   <dir with meta.json>` for each language. It needs `teams` and `players` only. The shared clips are
   already built.
2. During play, feed each event and each fact to `Booth.step()` as it arrives, and a tick every second.
   Feed a studio clip when it goes on air. Play the returned items with `BoothAudio`.

Time before kick-off. One match's clips are 236 to 248 per language, about 5 minutes of speech (M001:
285 s in English, 328 s in Italian, 289 s in Spanish), the fill-in lines that name the teams included. The
table was measured on the 146 to 158 clips before those; the 90 clips per language that the fill-in lines
added took 3 to 6 min per runner job, setup included (run 39482620053). One thread each:

| where | real-time factor | one match, three languages |
|---|---|---|
| GitHub-hosted runner (4 vCPU), one job per language, 20 Oct 2026 | 0.4 to 1.0 | 2.5 to 3.5 min each, about 6 min with setup, in parallel |
| a shared 2-vCPU server (about 65% steal), 40 clips | 4.3 (12 with two threads) | about 50 min, one language after the other |

The production container's CPU was not measured. On a dedicated vCPU we expect the runner's figures, an
estimate from the RTF and not a measurement. So for a live match the per-match names can be rendered on
a CI runner (the workflow's command with `--src` pointing at the line-up's `meta.json`; the workflow
itself builds the seed matches only) or on the container as soon as the line-up
is out, and the clips copied next to the match's data before kick-off. Allow an hour on a contended
machine. A name that is not ready is skipped: its line does not play.

## Crowd sounds

Six CC0 1.0 sounds from Freesound (`THIRD_PARTY.md`). `scripts/booth-crowd.sh` reads them with ffmpeg only,
trims and levels them, and writes seven files into `web/vendor/crowd-audio/` (24 kHz mono, 48 kbit/s, 711 kB
in all).

| file | source | cut | loudness |
|---|---|---|---|
| `bed.mp3` | habbis92, 206003 | 2 to 80 s, crossfaded loop | -27.3 LUFS |
| `anticipation.mp3` | itmightgetloud, 829453 | 44 to 54 s | -24.3 LUFS |
| `ooh.mp3` | Sandermotions, 494362 | 2.5 to 8 s | -22.4 LUFS |
| `roar.mp3` | D.jones, 528799 | 2 to 24 s, 6 s fade | -24.4 LUFS |
| `whistle.mp3` | SpliceSound, 218318 | 0 to 1.6 s | -16.4 LUFS |
| `kick.mp3` | padpad, 515908 | 2.18 to 2.53 s | peak -20 dBFS (too short for LUFS) |
| `strike.mp3` | padpad, 515908 | 18.95 to 19.35 s, bass lift | peak -9 dBFS |

## Tests

- `node --test tests/web/booth.test.mjs`: live equals replay, every A event called, goal hold, gaps,
  handovers, studio priority, names within 6 s, facts at or before the line, co share, variants, forbidden
  names, no digit outside a fact, no missing clip.
- `.venv/bin/pytest -q tests/test_booth.py`: pieces, numbers, names, the build with a fake renderer
  (resume, other languages kept, forbidden name).
- `scripts/with-lock.sh chromium tests/web/run-smoke.sh voice.mjs`: the booth starts after the button, ducks
  and stops for a studio clip, and stops on seek.

## Sources

- [TR] Trouvain, "Between excitement and triumph: live football commentaries in radio vs TV", ICPhS 2011.
  https://www.coli.uni-saarland.de/~trouvain/trouvain_football_2011.pdf
- [LF] Mori et al., "Live Football Commentary System Providing Background Information", ACL 2025 demo.
  https://aclanthology.org/2025.acl-demo.38.pdf
- [KL] Kuiper and Leaper, "Turn-taking and the co-construction of radio rugby union commentary", Te Reo 64(2),
  2021. https://nzlingsoc.org/wp-content/uploads/2022/03/4-Kuiper-Leaper-pg-88-105.pdf
- [GT] Gary Taphouse interview, Sports Gazette.
  https://sportsgazette.co.uk/sky-sports-gary-taphouse-on-the-art-of-football-commentary/
- [BK] Bunkered on commentary silence. https://www.bunkered.co.uk/?p=74341
- [CT] Clive Tyldesley, "How many commentators does it take...?"
  https://ctyldesley.substack.com/p/how-many-commentators-does-it-take
- [MT] Martin Tyler interview. https://grantwahl.substack.com/p/the-interview-martin-tyler
- [MK] Martin Kelner, Sporting Intelligence.
  https://sportingintelligence832.substack.com/p/hit-the-post-pardon-the-profanity-but-no-shit-sherlock-270601
- [VG] Virgilio Sport on the RAI second voice (search summary only).
  https://sport.virgilio.it/mondiali-la-classifica-dei-telecronisti-rai-da-adani-e-nela-a-stramaccioni-789114
- [ES] Espinof, common faults in football broadcasts.
  https://www.espinof.com/cuatro/cinco-errores-comunes-en-las-retransmisiones-de-futbol
- [KI] Giacomo Klein, "La lingua delle telecronache dagli anni '80 a oggi".
  https://edizioni.unistrasi.it/public/articoli/731/files/20__klein.pdf
- [QR] Quintero-Ramírez, Revista de Investigación Lingüística 25 (2022).
  https://revistas.um.es/ril/article/download/486281/334881/2012001

The share and
turn-length targets are derived from radio rugby [KL] and the SoccerNet corpus [LF], not measured on TV
football.
