# Data contract

Every builder reads this file before writing code. If a piece needs something that is not here,
it stops and asks the lead session; nobody changes the contract inside a feature branch.

## Units and coordinates

- Pitch 105 x 68 metres. Origin bottom-left. `x` along the length (0..105), `y` across (0..68).
- Stored coordinates are **absolute**: the home team attacks towards `x = 105` in period 1 and
  towards `x = 0` in period 2. Only the SPADL JSON export flips to "acting team plays left to
  right", as socceraction does.
- Time:
  - `period`: 1 or 2.
  - `t`: seconds since the start of that period.
  - `ts`: seconds on one continuous timeline from kick-off. Period 2 starts at `ts = period1_s`;
    there is no half-time gap.
  - `frame = round(ts * fps)` with `fps = 10`.
- Display minute: `floor(t / 60) + (period == 2 ? 45 : 0) + 1`.
- Speeds in km/h, distances in metres, ball height `z` in metres.

## Identifiers

- `team_id`: `T01`..`T99`. `player_id`: `<team_id>-<shirt>`, for example `T03-10`.
- `match_id`: `M001`..`M999`.
- `fact_id`: `F-<KIND>-<6 digits>`, unique within a match, for example `F-SHOT_SPEED-000031`.
- `story_id`: `S-<6 digits>`. `cue_id`: `C-<6 digits>`.
- All names (clubs, players, stadiums) are invented. Every generated name is checked against
  `data/forbidden_names.txt` (real clubs, players, grounds, broadcasters; one per line,
  case-insensitive, matched as whole words) with `studiodesk.names.is_forbidden`.
- Goals are SPADL shots (`shot`, `shot_freekick`, `shot_penalty`) with `result_name = 'success'`;
  own goals have `result_name = 'owngoal'`.
- `M001` is the demo match shipped in the container image and opened by default.

## Storage

Two SQLite files, schema in `studiodesk/schema.sql`, opened only through `studiodesk/db.py`.

- `data/matches.sqlite`: built offline by the simulator (A) and the facts engine (B). Read-only
  at runtime.
- `data/runtime.sqlite`: written at runtime by agents, the control desk and the live caps.

No CSV anywhere: not as input, cache or hand-off between scripts.

### Tracking frames

One row per frame in `tracking_frames`. Positions go in `pos`, a little-endian float32 array of
length `3 * N`. The order comes from `tracking_entities` (`idx` 0..N-1):

- `idx 0` is always the ball, as `x, y, z`.
- Players follow as `x, y, 0`.
- A player who is not on the pitch has `NaN, NaN, NaN`.

Decode with `numpy.frombuffer(pos, '<f4').reshape(-1, 3)`. `ball_owner` is the `player_id` in
control of the ball, or NULL.

### Hidden storylines

`storylines` is the answer key: what the simulator planted for the agents to find. Kinds:

| kind | meaning |
|---|---|
| `tactical_shift` | formation or line height changes around 60' |
| `high_press` | a spell of high pressing by one team |
| `top_sprint` | a sprint above 34 km/h |
| `comeback` | a team goes from losing to drawing or winning |

The table is only read by the evaluation script and the dataset export. The MCP server and the
agents never read it.

### Calibration files (committed, produced once by `scripts/calibrate.py`)

- `studiodesk/sim/calibration.json`: the averages the simulator reads (actions per match,
  pass length and success, shots, sprint counts and speeds, ...). Each value has
  `{"value", "source"}`; until the calibration script has run, `source` names the published
  paper the default comes from.
- `studiodesk/facts/xt_grid.json`: `{"cols": 16, "rows": 12, "grid": [[..16..] x 12], "source"}`.
  `grid[row][col]`, `row` along `y` (0 at `y = 0`), `col` along `x`, for a team attacking towards
  `x = 105`. If the file is missing, B produces no `xt_added` facts (never a made-up grid).
- No raw third-party data in the repo: it lives in `data/raw/` (git-ignored).

### Fact ledger

Every number that can reach the screen is a row in `facts`, with:

- `source_event_ids`, a JSON array of `event_id`;
- `source_frames`, a JSON `[from, to]`, or NULL.

Kinds produced by B: `pass_distance`, `pass_difficulty`, `pass_accuracy`, `ball_speed`,
`shot_speed`, `sprint_speed`, `sprint_count`, `distance_covered`, `momentum`, `xt_added`,
`press_intensity`, `line_height`, `score`.

`momentum` is one fact per team per 5-minute window. The value runs 0..10 and `ts` is the end of
the window.

## Runtime records (`runtime.sqlite`)

- `stories`: the candidate moments with their evidence.
  - `risk` runs 0..1. Below `AUTO_APPROVE_RISK` (0.35, in `studiodesk/config.py`) the default
    status is `auto_approved`; otherwise it is `needs_review`.
  - `texts` is `{"en": .., "it": .., "es": ..}`.
  - `verifier` is `{"status": "pass"|"rewritten"|"template", "attempts": n, "flagged": [..]}`.
  - `safety` is `passed`, `flagged` or `not_checked`.
- `cues`: what a graphic shows, when and for whom.
- `traces`: one row per hand-off between agents, kept with the replay so judges can see it.
- `audit`: who did what, when, with which model, tokens and cost.
- `session_decisions`: per-visitor approvals. The base replay never changes, and each visitor
  sees their own overlay.
- `sessions` and `usage_daily`: the caps for the "live" button.

## Audiences, languages, graphics

- Audiences: `analyst`, `casual`, `player:<player_id>`, `team:<team_id>`.
- Languages: `en`, `it`, `es`.
- At most 2 graphics on screen at once (the director enforces it).

Graphics are EBU OGraf v1, one folder each under `web/graphics/<name>/`. The `payload` of a cue
is the OGraf `data` for that graphic:

| graphic | payload |
|---|---|
| `nameplate` | `{player_id, name, shirt, team_short, speed_kmh, fact_id}` |
| `pass_shot` | `{mode: "pass"\|"shot", player_id, value, unit, quality, fact_ids}` |
| `momentum` | `{home: [..], away: [..], window: n, fact_ids}` |
| `why_card` | `{kind: "why"\|"recap", title, body, fact_ids}` |

## Replay export (static, no API needed)

`python -m studiodesk.export <match_id>` writes `web/data/<match_id>/`:

| file | content |
|---|---|
| `meta.json` | match, teams, players, lineups, `fps`, `period1_s`, `period2_s`, entity order |
| `tracking.f32` | all `pos` blobs concatenated in frame order (`frames x N x 3` float32 LE) |
| `events.json` | events, as in the table |
| `facts.json` | the fact ledger |
| `stories.json` | stories, with texts and verifier result |
| `cues.json` | the cue sheet for every audience and language |
| `traces.json` | agent hand-offs |

Shapes (JSON, UTF-8; ids and columns as in the tables, JSON-text columns already parsed):

- `meta.json`: `{match_id, venue_name, fps, period1_s, period2_s, frames, home_score, away_score,
  teams: [{team_id, name, short_name, color_primary, color_secondary, crest_svg, side}],
  players: [{player_id, team_id, name, shirt, position}],
  lineups: [{player_id, starter, on_ts, off_ts}], entities: ["ball", "<player_id>", ..]}`.
  `side` is `home` or `away`. Frame `k` is at `ts = k / fps`.
- `events.json`, `facts.json`, `stories.json`, `cues.json`, `traces.json`: arrays of row objects,
  sorted by `ts`.

Until the agents exist, `export` writes a **template cue sheet** from the facts alone (no AI),
audiences `analyst` and `casual`, language `en`, `story_id` null: a nameplate for each top
sprint, a `pass_shot` for each shot and for the hardest passes, `momentum` at the end of every
5-minute window, a `why_card` recap with template text at half-time and full time. `stories.json`
and `traces.json` are then `[]`. At most 2 cues overlap for the same audience.

The browser replay needs only these files.

## Web page (`web/`)

Static files, no build step: `web/index.html` plus ES modules in `web/js/`. It opens
`web/data/<match>/` from `?match=` (default `M001`). FastAPI serves `web/` as static files.
Pinned libraries are vendored in `web/vendor/` with their licence in `THIRD_PARTY.md`. The API adds the per-visitor decisions and the live
button.

## API (FastAPI, `studiodesk/api.py`)

| method | path | what |
|---|---|---|
| GET | `/api/health` | `{ok, version}` |
| GET | `/api/matches` | list of matches |
| GET | `/api/session` | creates or returns the visitor's session (cookie `sd_session`) |
| POST | `/api/decisions` | `{match_id, story_id, decision, edited_text?}` |
| GET | `/api/decisions?match_id=` | this visitor's overlay |
| POST | `/api/kill` | `{on: bool}`: per-session AI kill switch |
| POST | `/api/live` | starts a live run if the caps allow; otherwise 429 with the reason |
| GET | `/api/live/{run_id}/stream` | server-sent events: stories, cues, traces as they happen |

Live caps (`studiodesk/config.py`): 2 runs per session per day, 20 per day for the whole site,
and an automatic stop once the day's cost passes $25.

### Control desk additions (feat/desk, additive)

| method | path | what |
|---|---|---|
| GET | `/api/audit?match_id=` | `{rows: [{at, actor, action, match_id, story_id, model, tokens_in, tokens_out, cost_usd, detail}]}`: this visitor's rows plus the agents' rows (`session_id` NULL) for the match, newest first, at most 500; `session_id` is never returned |

- Responses: `GET /api/session` gives `{kill_switch, actions_left}`; `GET /api/decisions` gives
  `{match_id, kill_switch, decisions: [{story_id, decision, edited_text, at}]}` and never creates
  a session; `POST /api/decisions` echoes `{story_id, decision, edited_text, at}`; `POST /api/kill`
  gives `{kill_switch}`. The session id lives only in the HttpOnly cookie (SameSite=Lax, Secure
  behind https, 30 days).
- Validation: `match_id` matches `M\d{3}` or `DEMO`, `story_id` matches `S-\d{6}` and must exist
  for the match (404 otherwise); `edited_text` is required with `edited` and only with it, keys
  `en`/`it`/`es`, 1..600 characters, no control characters; unknown fields 422; bodies over 16 KB
  413. A later decision replaces the earlier one; `approved` clears an edit.
- Caps: 300 actions (decisions and kill switch) per session, 5000 new sessions per day, then 429.
- Every decision and kill-switch change writes an `audit` row: `actor` `human`, `action` the
  decision or `ai_off`/`ai_on`, `detail` `{"langs": [..]}` for an edit.
- `POST /api/live` and its stream answer 501 until the live run exists.
- `traces` rows (table and `traces.json`) may carry `story_id` (null for a run-level hand-off).
- What goes on air for a visitor: template cues (`story_id` null) always; a story's cues when its
  status is `auto_approved`, `approved` or `edited`, never when `needs_review` or `rejected`, and
  none with the kill switch on. A cue whose `story_id` is not in `stories.json` is held. An edit
  replaces the `payload.body` of that story's `why_card` cues in the edited language.
- Languages: the sheet for language L is the cues with `lang` L, plus the English template cues
  when L has no template cue of its own.

## MCP server (`studiodesk/mcp_server.py`)

Tools, all read-only over `matches.sqlite`, filtered to `ts <= clock` when the clock is running:

- `get_match_info(match_id)`
- `get_events(match_id, from_ts, to_ts, type_name?)`
- `get_facts(match_id, kind?, player_id?, team_id?, from_ts?, to_ts?)`
- `get_fact(match_id, fact_id)`
- `get_player(match_id, player_id)`
- `get_momentum(match_id, team_id?)`

## Match clock (`studiodesk/clock.py`)

`MatchClock(match_id, speed)` yields events one at a time at match time; `speed=1` is real time.
Agents only learn about an event when the clock releases it, in replay generation too.

## Agents additions (feat/agents2, additive)

- New fact kinds from B, same columns as the others:
  - `shot_distance`: metres from the shot location to the centre of the goal attacked, one per
    shot, `source_event_ids` = the shot event. Label `Shot from 6 m`.
  - `team_width` and `team_length`: metres between the widest and between the deepest and highest
    outfield players, mean over a 5-minute window, one per team per window (`ts` = window end, like
    `momentum`). Label `Team width 37.2 m, min 56-60`.
  - `formation`: the outfield shape of a team in a 5-minute window, `unit` `formation`, `value`
    the lines as digits (`442.0` is 4-4-2). Written only when the window shows three clear lines
    of 10 outfield players. Label `Formation 4-4-2, min 56-60`.
- `traces.story_ids`: nullable JSON array of `story_id`, default `[]`: the stories a hand-off
  concerns (all the stories of the batch for the finder, analyst, commentators, verifier and
  director; the stories sent back for a rewrite). `traces.json` carries it parsed. Runtime
  databases from before get the column with `ALTER TABLE` on connect. Readers fall back to
  `story_id`, then to the summaries, when it is missing or empty.
- `stories.safety` is set by Azure AI Content Safety (text:analyze, api-version 2024-09-01) after
  `python -m studiodesk.agents run` (skip with `--no-safety`; `--fake` skips it) or with
  `python -m studiodesk.agents safety <match_id>`: one call per story with its three texts joined,
  at most 100 calls per match; `flagged` when any category has severity 2 or more, `not_checked`
  when the call fails or the cap is reached.
- Verifier notes (`stories.verifier.flagged`) are one sentence of at most 160 characters each. No
  agent string reaching the page (texts, analysis, angles, notes, trace summaries) carries em or
  en dashes or control characters.
- AI replay packs: `replays/<match_id>/{stories,cues,traces}.json`, the export shapes of a real
  agents run, written by `python -m studiodesk.export <match_id> --runtime <runtime.sqlite> --pack
  replays/<match_id>`. The image build copies them over the template files in `web/data/<match_id>/`
  for every match that has a pack. Every `fact_id` and `event_id` in a pack exists in the data
  rebuilt from the seed (`sim build --matches 4 --seed 7`, then `facts build --all`).
