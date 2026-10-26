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
  case-insensitive, matched as whole words after NFKC, accent stripping and mapping Cyrillic and
  Greek lookalikes; a line may be a bare surname) with `studiodesk.names.is_forbidden`.
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
| `comeback` | a team that trailed draws level: once per deficit, at the equaliser |

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
`press_intensity`, `line_height`, `score`; since feat/audiences also `checkin_touches`,
`checkin_passes`, `checkin_distance`, `checkin_sprints`, `checkin_top_speed` (see Audiences additions);
since feat/no-empty-minutes also `start_formation` (see Audiences additions).

`momentum` is one fact per team per 5-minute window. The value runs 0..10 and `ts` is the end of
the window. Window labels name display minutes that never overlap (`min 66-70`, `min 71-75`);
the window after 45' or 90' reads `first-half stoppage time` or `second-half stoppage time`.

## Runtime records (`runtime.sqlite`)

- `stories`: the candidate moments with their evidence.
  - `risk` runs 0..1. Below `AUTO_APPROVE_RISK` (0.35, in `studiodesk/config.py`) the default
    status is `auto_approved`; otherwise it is `needs_review`.
    The risk rule applies only when Content Safety returned `passed`: a `flagged` or
    `not_checked` story is `needs_review` whatever its risk (feat/verifier3).
  - `texts` is `{"en": .., "it": .., "es": ..}`.
  - `verifier` is `{"status": "pass"|"rewritten"|"template", "attempts": n, "flagged": [..]}`.
    In a live run a story is saved as it goes on air with `"status": "pending"`, and its row is
    updated when the verifier is done; a finished run holds no `pending`.
    `flagged` is empty on `pass`; on `rewritten` it says what the earlier drafts got wrong, on
    `template` why the drafts were not used (packs before feat/texts4 may hold other strings).
    Since feat/phrasebook it also holds `on_air` (`"phrasebook"` or `"template"`: who wrote
    `texts`, always code), `opener` (the phrasebook exclamation id, or null) and, when the AI's
    lines passed every check in all three languages, `proposals` (`{"en", "it", "es"}`), shown on
    the desk and put on air only by a person's `edited` decision. `status` then describes the AI's
    drafts, not the text on air. A story with `on_air: "phrasebook"` has risk 0.05 (0.3 more without
    fact ids, and 0.35 more for a reading of the game: `big_chance`, `tactical_shift`,
    `momentum_swing`, `pressing_spell`, so those wait for a person). Packs without `on_air` put the AI's lines in `texts`.
  - `safety` is `passed`, `flagged` or `not_checked`.
  - `fact_ids` holds the story's own facts plus the ones the analyst cited (`cited`). Templates,
    graphics and the `why_card` `fact_ids` use only the story's own facts.
  - No text that reaches the desk (`texts`, `analysis_en`) carries fact-id citations.
- `cues`: what a graphic shows, when and for whom.
- `traces`: one row per hand-off between agents, kept with the replay so judges can see it.
- `audit`: who did what, when, with which model, tokens and cost.
- `session_decisions`: per-visitor approvals. The base replay never changes, and each visitor
  sees their own overlay.
- `sessions` and `usage_daily`: the caps for the "live" button.

## Audiences, languages, graphics

- Audiences: `analyst`, `casual`, `kids` (feat/audiences), `player:<player_id>`, `team:<team_id>`.
- Languages: `en`, `it`, `es`.
- At most 2 graphics on screen at once (the director enforces it).

Graphics are EBU OGraf v1, one folder each under `web/graphics/<name>/`. The `payload` of a cue
is the OGraf `data` for that graphic:

| graphic | payload |
|---|---|
| `nameplate` | `{player_id, name, shirt, team_short, speed_kmh, fact_id}` |
| `pass_shot` | `{mode: "pass"\|"shot", player_id, value, unit, quality, fact_ids}` |
| `momentum` | `{home: [..], away: [..], window: n, fact_ids}` |
| `why_card` | `{kind: "why"\|"recap"\|"checkin", title, body, fact_ids}` |
| `team_stats` | `{when, rows: [{stat, home, away, home_v, away_v}], fact_ids}` (feat/analyst-stats) |
| `lineup` | `{teams: [{side, formation, lines: [[{player_id, shirt, name}]]}], fact_ids}` (feat/no-empty-minutes) |

Any payload may also carry `filler: true` (feat/no-empty-minutes, additive): a code cue added so that a
sheet never goes a minute with nothing on air (see Audiences additions). A graphic ignores the key.

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
audiences `analyst` and `casual` (and `kids`, a copy of `casual`, since feat/audiences), language `en`, `story_id` null: a nameplate for each top
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
| DELETE | `/api/decisions?match_id=&story_id=` | undo: drops this visitor's decision on the story (audit action `undo`) |
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
  `en`/`it`/`es` (the body, 1..600 characters) and `title_en`/`title_it`/`title_es` (the headline,
  one line of 1..80 characters), no control characters; unknown fields 422; bodies over 16 KB
  413. A later decision replaces the earlier one; `approved` clears an edit.
- Caps: 300 actions (decisions and kill switch) per session, 5000 new sessions per day, 50 new
  sessions per client address per day (the last `X-Forwarded-For` entry, else the client host;
  kept in the process, so one replica), then 429.
- Every decision and kill-switch change writes an `audit` row: `actor` `human`, `action` the
  decision or `ai_off`/`ai_on`, `detail` `{"langs": [..]}` for an edit.
- `POST /api/live` and its stream answer 501 until the live run exists.
- `traces` rows (table and `traces.json`) may carry `story_id` (null for a run-level hand-off).
- What goes on air for a visitor: template cues (`story_id` null) always; a story's cues when its
  status is `auto_approved`, `approved` or `edited`, never when `needs_review` or `rejected`, and
  none with the kill switch on. A cue whose `story_id` is not in `stories.json` is held. An edit
  replaces the `payload.body` (and, with a `title_<lang>` key, the `payload.title`) of that story's
  `why_card` cues in the edited language.
- Languages: the sheet for language L is the cues with `lang` L, plus the English template cues
  when L has no template cue of its own.

### Control desk additions (feat/desk2, additive)

These refine the feat/desk rules above; where they differ, these win.

- On air is an allow-list: a story's cues go on air only when its status is `auto_approved`,
  `approved` or `edited`. Any other `default_status` (missing, `pending`, unknown) is held.
- A story with `safety: "flagged"` (Content Safety) starts as `needs_review` whatever its
  `default_status`: it never goes on air by itself. A visitor may approve or edit it onto their
  screen. The voice-over never speaks a flagged story, approved or not.
- Sessions: `GET /api/session` and `GET /api/decisions` never create a session. Without a cookie
  `GET /api/session` gives `{kill_switch: false, actions_left: 300}`. The first `POST`
  (`/api/decisions` or `/api/kill`) creates the session and sets the cookie; the new-session cap
  (429 "too many new sessions") applies there.
- Audit `detail` for a decision: `{"langs": []}` without an edit, `{"langs": [..], "sha1": {lang:
  sha1 of the edited text}}` with one. The edited text itself is never in the audit.
- Bodies: a non-numeric `Content-Length` is 400; a body over 16 KB is 413, also when it is sent
  chunked without a `Content-Length`. Error responses carry the same security headers as the rest.
- Edited text refuses every control, format and separator character (Unicode Cc, Cf, Zl, Zp:
  tab, U+2028, U+FEFF, U+2060, U+061C, bidi marks, soft hyphen and the rest). Newline is allowed.
- An edit sends the languages that changed; the desk editor shows all three, so saving an edit
  means all three were reviewed. Saving unchanged text is an `approved` decision.
- A 500 answers `{"detail": "internal error"}` with the security headers. The headers include
  `Permissions-Policy` (camera, microphone, geolocation, payment, usb off); `script-src` has no
  `blob:` (only `worker-src` does).
- `GET /api/audit` also returns `actor: "auto"`, `action: "auto_approved"` rows for the stories
  the risk rule put on air, worked out from the replay's `stories.json` when read, with
  `detail.risk` and the director trace's time.
- The schema in `studiodesk/schema.sql` runs once per version (SQLite `user_version`), with
  indexes on `audit(session_id, actor)` and `sessions(created_at)`.
- The page loads the replay without waiting for the API: API calls time out after 4 s and the desk
  then works offline, with the reason in its footer.

## MCP server (`studiodesk/mcp_server.py`)

Tools, all read-only over `matches.sqlite`, filtered to `ts <= clock` when the clock is running:

- `get_match_info(match_id)`
- `get_events(match_id, from_ts, to_ts, type_name?)`
- `get_facts(match_id, kind?, player_id?, team_id?, from_ts?, to_ts?, top?)`: with `top`, the top facts by value, highest first
- `get_fact(match_id, fact_id)`
- `get_player(match_id, player_id)`
- `get_momentum(match_id, team_id?)`

## Match clock (`studiodesk/clock.py`)

`MatchClock(match_id, speed)` yields events one at a time at match time; `speed=1` is real time.
Agents only learn about an event when the clock releases it, in replay generation too.

## Agents additions (feat/agents2, additive)

- New fact kinds from B, same columns as the others:
  - `shot_distance`: metres from the shot location to the centre of the goal attacked, one per
    shot, `source_event_ids` = the shot event. Label `Shot from 6 m, inside the box, header,
    saved`: inside or outside the box, body part (`header`, `foot`, or the foot side when stored),
    outcome (`goal`, `saved`, `wide`, `over`, `blocked`).
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
  `python -m studiodesk.agents safety <match_id>`: one call per story with its three texts and
  `analysis_en` joined,
  at most 100 calls per match; `flagged` when any category has severity 2 or more, `not_checked`
  when the call fails or the cap is reached.
- Verifier notes (`stories.verifier.flagged`) are plain sentences built from fixed reasons, such as
  "Earlier Italian draft: a trend the values do not show." or "Earlier Spanish draft: a word
  repeated.", never the judge's own words, a rejected number or a fact id; at most 160 characters
  each. No
  agent string reaching the page (texts, analysis, angles, notes, trace summaries) carries em or
  en dashes or control characters.
- AI replay packs: `replays/<match_id>/{stories,cues,traces}.json`, the export shapes of a real
  agents run, written by `python -m studiodesk.export <match_id> --runtime <runtime.sqlite> --pack
  replays/<match_id>`. The image build copies them over the template files in `web/data/<match_id>/`
  for every match that has a pack. Every `fact_id` and `event_id` in a pack exists in the data
  rebuilt from the seed (`sim build --matches 4 --seed 7`, then `facts build --all`).

## Voice additions (feat/voice, additive)

- Optional per match: `replays/<match_id>/voice.json` and `replays/<match_id>/voice/<story_id>.<lang>.mp3`,
  written by `python -m studiodesk.voice <match_id>` (details in `docs/voice.md`) and copied with the
  pack into `web/data/<match_id>/`.
- `voice.json` is an array of `{story_id, lang, file, duration_s, text_sha1, voice}`; `file` is
  relative to the match folder, `text_sha1` is the SHA-1 of the story's `texts[lang]`.
  An optional `spoken_sha1` (additive) is the SHA-1 of what the voice was sent; the page ignores it.
- The page plays a clip only when its `text_sha1` matches the story text it shows. A match with no
  `voice.json` (404) plays silent.

## Ask the studio additions (feat/ask, additive)

- `POST /api/ask` with `{match_id, ts, question, lang}`: a visitor's question about the match at
  replay time `ts`. `question` is plain text, 1 to 280 characters; `lang` is `en`, `it` or `es`.
- Answer: `{status, answer, fact_ids, questions_left}`. `status` is `answered`, or `declined` when
  the data up to `ts` cannot answer it or the answer fails a check (then `answer` is a fixed
  sentence per language written in code, nothing from the model, and `fact_ids` is empty), or
  `paused` when Content Safety answers with a quota or rate error (`answer` empty, the page says the
  questions are paused). Over a cap: 429 with `{status: "limit", reason}`. No model configured
  (tests, a site without Foundry), or the Content Safety client failed to build in the last 60 s:
  503, and the page hides the box.
- The agent `studio_host` (gpt-5-mini, reasoning minimal) reads the match only through the MCP tools
  with the clock set to `ts`: nothing after `ts`, never the hidden storylines. It answers in `lang`,
  at most two sentences, and cites the fact ids it used.
- Checks before an answer is shown: every number in it is the value of a cited fact with
  `fact.ts <= ts`, written with the unit or noun that fact gives it, and a score equals the score at
  `ts` (the rules in `studiodesk/agents/rules.py`, `check_answer`), no forbidden name, and
  Azure AI Content Safety on the question (with Prompt Shields) and on the answer. The question is data,
  never instructions.
- Caps (`studiodesk/config.py`): `ASK_PER_SESSION_PER_DAY = 10`, `ASK_PER_CLIENT_PER_DAY = 30` per
  client address (the last `X-Forwarded-For` entry, else the client host), `ASK_PER_DAY = 40` for the
  site (env `ASK_PER_DAY`; 40 a day fits the Content Safety free tier), and the existing stop once the day's cost passes $25. Counted in `questions_daily`
  (`day, session_id` with `'*'` for the site and `'ip:'` plus the salted SHA-256 of the address for a
  client, never the address itself; `questions`). Every question writes one `audit` row,
  `action: "ask"`, with its tokens, cost and status; the question text is kept in `detail`.

## Page additions (feat/moments, additive)

- "Next key moment": a button that always moves forward: it seeks to 3 seconds before the first
  key moment of the current audience whose lead-in starts more than 0.5 s after the current time.
  A key moment is a story cue (template cues without a story are skipped); a story cue that starts
  while an earlier story cue, of any story, is still on air (or within 1 s of its end) belongs to
  the same moment. A jump faster than 1x sets the speed back to 1x. The label is "Next key moment"
  while the stories load, "No more key moments" past the last one and "No key moments" when the
  sheet has none (both aria-disabled, and a press says so in a polite live region). With the AI
  graphics off there are no story cues: a key moment is then a goal (a `score` fact, not AI), 3 seconds
  before it, and the labels are "Next goal", "No more goals" and "No goals". The N key does
  the same, and Space plays and pauses, only with the focus in the broadcast frame or its controls
  (WCAG 2.1.4) and without Ctrl, Alt, Meta or Shift; the frame takes the focus once the page loads.
- Agent activity: a strip under the pitch that follows the replay clock and shows each agent's latest
  step of `traces.json` with `ts <= now` (agent display name, step, its output summary, model;
  tokens and cost are only in the summary line).
  While a story graphic is on air (the latest cue if several, a tie to the later `cue_id`) it shows
  how that graphic was made instead: the latest step per agent of the traces whose `story_ids`
  include its story, with that story's totals as in the desk's Traces tab (a hand-off shared by n
  stories counts 1/n): "How the graphic on air was made: N hand-offs, X tokens, $Y". A summary is
  clamped to two lines; the full text is in the Traces tab of the desk. Its labels follow the page
  language (en, it, es); the agent output stays in English. It reads only the replay files; on a phone it folds to one line.

## Audiences additions (feat/audiences, additive)

- `kids` audience: short, warm lines with the same true numbers. Its cue sheet is the `casual` one
  (same stories, times and graphics) with the kids line in each `why_card`.
- `stories.json`: each story gains `texts_by_audience`, `{audience: {"en", "it", "es"}}`, written by
  code from the story's facts (`studiodesk/agents/audiences.py`, no model), every line through the
  same checks as `texts`. Keys: `analyst`, `casual`, `kids`, `team:<team_id>`, `player:<player_id>`;
  an audience may be missing. The line an audience sees is its own, else the `casual` one, else
  `texts`; the `analyst` always sees `texts`, the line its voice clip says (a clip plays only when the
  card shows `texts[lang]`). A `why_card` body of a story cue is that line.
- "Again" is said only with the earlier fact it means cited: a line in `texts` or
  `texts_by_audience` that says again ("strikes again", "tries again", "Ancora", "ci riprova",
  "Otra vez", "vuelve a", "Another goal") adds to the story's `fact_ids`, and to its `why_card`
  `fact_ids`, the scorer's earlier `score` facts (goal) or the shooter's last earlier `shot_speed`
  fact (big chance).
- Player check-ins: `checkin_*` facts at 15, 30 and 45 minutes of each period (900 s steps from
  kick-off, so 15' to 90') for each player on the pitch, counted from the period's kick-off:
  touches, passes completed, distance (km), sprints and top speed (km/h, only with a sprint peak).
  They become `why_card` cues with `kind: "checkin"`, `story_id` null, for each `player:<player_id>`
  audience of the sheet in its languages, one fact per line in the body. A card starts within 30 s of its facts' `ts`, in a
  slot where it overlaps no other cue of that audience, ends before half-time or full time, and is
  dropped when no slot is free.
- Team shape panels (feat/analyst-stats): a `team_stats` cue for the `analyst` audience, `story_id` null, 10 s,
  at the end of every 5-minute window that has `formation`, `line_height`, `team_length`, `team_width` and
  `press_intensity` for both teams, in each language of the analyst sheet. Payload: `when`, the window in
  the cue's language ("Min 6-10", "Minuti 6-10", "Minutos 6-10", or the half's stoppage time); `rows`, one
  per kind in that order, `stat` the kind, `home` and `away` the values as shown (`rules.fmt`, decimal comma
  in it and es, `" m"` or `"/10"` after it, a formation as `4-3-3`), `home_v` and `away_v` the fact values
  for the bars (null for the formation); `fact_ids` the ten facts, home then away per row. It starts in the
  first 0.5 s step of the 60 s after the window where it overlaps no other analyst cue (timed on the English
  sheet) and ends before half-time or full time, else it is dropped. On the page, a momentum or team shape
  card due during a goal replay waits for its end, one after the other.
- No empty minutes (feat/no-empty-minutes, `docs/desk.md`):
  - `start_formation`: one fact per team at `ts` 0, period 1, `unit` `formation`, `value` the team
    sheet's lines as digits from the starters' positions (`433.0` is 4-3-3), label
    `Starting formation 4-3-3, team sheet`. Written only for 11 starters with one keeper and three lines.
  - Fillers (additive): every cue this step adds to keep a sheet from going a minute with nothing on air
    has `story_id` null and one payload key more, `filler: true`; the template keys of its graphic are
    unchanged. The marker tells a filler from a template cue of the same graphic, so a rerun of the step
    drops the earlier fillers and writes the same ones again (same cues, same ids). On the page a filler
    never waits for the producer, whatever the sheet (`GEN_WAITS` in `web/js/desk.js`): the risk rule
    approves it, as it does the Momentum panels.
  - `lineup` filler at `ts` 0, 15 s, on every sheet of the pack (`analyst`, `casual`, `kids`, `team:*`,
    `player:*`) in each of its languages, unless a cue of that sheet starts in the first 15 s. Payload:
    `teams`, home then away, `side`, `formation` as shown (`4-3-3`), `lines` the starters as GK, DF, MF,
    FW, each line by shirt, `name` the surname (the full name when two players of the match share it);
    `fact_ids` the two `start_formation` facts, home then away; `filler: true`.
  - Then, on every sheet, while a stretch of play with nothing on air for a visitor who never touches the
    desk (stories `auto_approved` and not `flagged`, and code cues that do not wait; timed on the English
    sheet, each half apart) is longer than `MAX_GAP_S` (55 s), or would leave the half's last clock minute
    empty, one filler of these, with the template payload of its graphic plus `filler: true`:
    `pass_shot` (`mode` `pass`, 6 s) of a completed pass, `value` and `unit` its `pass_distance`,
    `quality` its `pass_difficulty` as `Difficulty 8.1/10` (`Difficoltà 8,1/10`, `Dificultad 8,1/10`; the
    kids `How hard: 8.1/10`, `Quanto era difficile: 8,1/10`, `Qué difícil: 8,1/10`), `fact_ids` the
    distance, the difficulty and the `ball_speed` when there is one; `nameplate` (6 s) of a
    `sprint_speed` fact, `speed_kmh` its value; `momentum` (8 s) of a window end, payload as the template
    one; the `checkin` `why_card` (8 s) of the player with the most touches at a check-in `ts`, never on a
    `player:*` sheet, worded for the kids on theirs. A filler starts no earlier than its facts and at most
    60 s after them (a `nameplate` or `pass_shot` ends before its player's `off_ts`), overlaps no cue of the sheet (waiting stories included) and ends before half-time or
    full time; each fact fills a sheet once; it is written once per language of the sheet. Never the
    graphic of the cue just before it on the sheet when another fits.
    Also (additive): its `ts` is no earlier than every fact in its `fact_ids` (a pass's `ball_speed`
    included); it uses only facts of its own half (`period`); it overlaps no goal (`score` fact) to 11.5 s
    after it (the 3D replay, `web/js/view3d.js` `REPLAY`) nor where the page holds a `momentum` or
    `team_stats` cue due in that replay to its end; and it shows no fact the sheet's own cues show (of a `momentum` cue, its latest window). The
    desk lists no filler in Needs you or Done; in On air now it reads as a template graphic.
- `python -m studiodesk.agents.audiences <match_id> --db data/matches.sqlite --pack replays/<match_id>`
  rewrites a pack offline; `export` and `export --pack` apply the same step.
- Page: "Same moment, several audiences", a box under the controls (never on the 1920x1080 stage):
  the story on air, else the latest one cleared for air that the clock has reached, as each audience
  on the menu sees it, side by side in the page language. Each card's button switches the broadcast
  to that audience (`aria-pressed` on the current one). This visitor's edited text replaces every
  audience's line, as on the cue sheet.

## Viewing additions (feat/ui-viewing, additive)

- `POST /api/perf` with `{match_id, fps_median, renderer|null, screen_w, screen_h, dpr}`: one anonymous
  frame-rate beacon per visit, sent after 30 s of 3D play. Fields are validated and clamped; no IP, user
  agent or free text is kept. Answers 204, 422 on bad input, 429 over 20 per client or 5000 per day.
  One structured log line goes to the `studiodesk.perf` logger; of `renderer` only the GPU family from a fixed list (or `other`) is kept.
- Generated graphics (cues from `studiodesk/agents/audiences.py`) appear on the desk as `G-<cue_id>`
  pseudo-stories. They are decided in the browser tab only and never sent to `/api/decisions`, which
  takes `S-` ids.

## Judge fixes (fix/judge-desk, additive)

- Fact kinds: `team_shots`, `team_shots_on_target`, `team_corners` (a running count per team since
  kick-off: one fact at 0 at kick-off and one at every change, `source_event_ids` the events counted)
  and `team_possession` (a team's share of the ball, %, at each 5-minute window end, as `momentum`).
- MCP tool `get_team_totals(match_id)`: the latest fact of each of those four kinds per team, up to the
  clock. The `studio_host` may cite a count with its noun ("4 shots"); every number is still a fact id.
- `GET /api/ask` -> `{available}`, always 200: the page's probe, after the same checks as a question
  (it replaces probing with a POST that answered 422).
- `POST /api/decisions` with `edited_text`: each text and headline meets `rules.check_text` against
  the story's facts (its numbers, minute and score, its own fact ids, no real name), then Content Safety
  when `AZURE_CONTENT_SAFETY_ENDPOINT` is set. A refusal answers 422 `{detail: "<reason>. It stays off
  air."}`, keeps the story's last decision, spends one action and writes the audit action
  `edit_refused` (`detail.reason`). Anything that cannot be checked is refused.
- The `why_card` kicker of a story card reads `KEY MOMENT` / `MOMENTO CHIAVE` / `MOMENTO CLAVE`.
- Desk: an agents' story still `needs_review` 300 match seconds after its slot ends (its last cue's
  end, else its first cue or `ts`) is `expired` and listed under "Missed: n", as a generated graphic is
  once its slot ends.
- Next key moment also stops at a cue of a story that waits for review on this visitor's desk.
- The desk's audit total from a replay counts agent steps that used the model (the traces); the
  audit table, and so docs/MEASURES.md, counts model calls.

## Judge 2 fixes (fix/judge2-desk, additive)

- Fact kinds: `player_goals` (a player's goals since kick-off, own goals not counted: one fact at 0 at
  the player's kick-off or entry and one at every goal, `source_event_ids` the goals counted) and
  `team_pass_accuracy` (a team's passes completed of those tried since kick-off, %, at each 5-minute
  window end as `team_possession`; the label carries the count, e.g. "Pass accuracy 84% (312/371) since kick-off"). Existing fact ids do not change.
- MCP tool `get_scorers(match_id, player_id=None)`: the latest `player_goals` fact of each player who has
  scored (with `player_id`, that player's, 0 included), up to the clock. `get_team_totals` also returns
  `team_pass_accuracy`.
- Ask the studio: the `studio_host` has a `get_stories` tool, the verified stories already on air at the
  visitor's clock (from `web/data/<match>/stories.json`), so a "why" question is answered from them.
  The answer's numbers are still fact ids checked by `rules.check_answer`, which also accepts a goal
  count and "N passes of M".
- `POST /api/decisions` with `edited_text`: Content Safety refuses from severity 4 in any category, and
  the refusal names it ("content safety flagged the text for violence (severity 6)").
- An edit whose text is the verifier's proposal is written to the audit table as `used_proposal`
  (`session_decisions` keeps `edited`).
- Each audit write of a desk decision (`approved`/`edited`/`killed`, `used_proposal`, `edit_refused`, `undo`, `ai_off`/`ai_on`) also
  logs an Application Insights custom event `studiodesk.decision` on the `studiodesk.decision` logger,
  with `decision_action`, `decision_match_id`, `decision_story_id`, `decision_langs` and
  `decision_session` (a salted hash of the session id). No text and no client address. At most 5,000
  events a UTC day and 300 per client address (`DECISION_EVENTS_PER_DAY`, `..._PER_CLIENT_PER_DAY` in
  `studiodesk/api.py`), so the agents' traces keep their share of the 0.1 GB daily cap; past them the
  action is still audited, only the event is not sent.
- Next key moment on a paused replay jumps and plays at 1x.
- Desk: the audit table also lists the visitor's own decisions (class `a-human`), in time order.
- Ask the studio in Analyst mode lists the cited facts by their `label_en`, the ids in the tooltip.
