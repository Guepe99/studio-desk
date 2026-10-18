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
  case-insensitive, matched as whole words).

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

The browser replay needs only these files. The API adds the per-visitor decisions and the live
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
