-- Studio Desk schema. The contract is docs/CONTRACT.md; change both together, never one.

-- matches.sqlite -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS teams (
  team_id         TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  short_name      TEXT NOT NULL,
  color_primary   TEXT NOT NULL,
  color_secondary TEXT NOT NULL,
  crest_svg       TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS players (
  player_id     TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES teams(team_id),
  name          TEXT NOT NULL,
  shirt         INTEGER NOT NULL,
  position      TEXT NOT NULL CHECK (position IN ('GK','DF','MF','FW')),
  top_speed_kmh REAL NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS matches (
  match_id          TEXT PRIMARY KEY,
  seed              INTEGER NOT NULL,
  home_team_id      TEXT NOT NULL REFERENCES teams(team_id),
  away_team_id      TEXT NOT NULL REFERENCES teams(team_id),
  venue_name        TEXT NOT NULL,
  period1_s         REAL NOT NULL,
  period2_s         REAL NOT NULL,
  fps               INTEGER NOT NULL DEFAULT 10,
  home_score        INTEGER NOT NULL,
  away_score        INTEGER NOT NULL,
  generator_version TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS lineups (
  match_id  TEXT NOT NULL REFERENCES matches(match_id),
  player_id TEXT NOT NULL REFERENCES players(player_id),
  starter   INTEGER NOT NULL,
  on_ts     REAL NOT NULL,
  off_ts    REAL,
  PRIMARY KEY (match_id, player_id)
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  match_id          TEXT NOT NULL REFERENCES matches(match_id),
  event_id          INTEGER NOT NULL,
  period            INTEGER NOT NULL CHECK (period IN (1,2)),
  t                 REAL NOT NULL,
  ts                REAL NOT NULL,
  team_id           TEXT NOT NULL,
  player_id         TEXT NOT NULL,
  type_name         TEXT NOT NULL,  -- SPADL action type
  result_name       TEXT NOT NULL,  -- SPADL result
  bodypart_name     TEXT NOT NULL,  -- SPADL body part
  start_x REAL NOT NULL, start_y REAL NOT NULL,
  end_x   REAL NOT NULL, end_y   REAL NOT NULL,
  related_player_id TEXT,           -- receiver of a pass, player tackled, ...
  PRIMARY KEY (match_id, event_id)
) STRICT;
CREATE INDEX IF NOT EXISTS events_ts ON events(match_id, ts);

CREATE TABLE IF NOT EXISTS tracking_entities (
  match_id TEXT NOT NULL REFERENCES matches(match_id),
  idx      INTEGER NOT NULL,
  entity   TEXT NOT NULL,           -- 'ball' at idx 0, then player_id
  PRIMARY KEY (match_id, idx)
) STRICT;

CREATE TABLE IF NOT EXISTS tracking_frames (
  match_id   TEXT NOT NULL,
  frame      INTEGER NOT NULL,
  ts         REAL NOT NULL,
  ball_owner TEXT,
  pos        BLOB NOT NULL,         -- float32 LE, 3 * N
  PRIMARY KEY (match_id, frame)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS storylines (  -- answer key: never exposed to agents
  match_id    TEXT NOT NULL REFERENCES matches(match_id),
  story_id    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('tactical_shift','high_press','top_sprint','comeback')),
  ts_start    REAL NOT NULL,
  ts_end      REAL NOT NULL,
  team_id     TEXT,
  player_id   TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (match_id, story_id)
) STRICT;

CREATE TABLE IF NOT EXISTS facts (
  match_id         TEXT NOT NULL REFERENCES matches(match_id),
  fact_id          TEXT NOT NULL,
  kind             TEXT NOT NULL,
  ts               REAL NOT NULL,
  period           INTEGER NOT NULL,
  team_id          TEXT,
  player_id        TEXT,
  value            REAL NOT NULL,
  unit             TEXT NOT NULL,
  label_en         TEXT NOT NULL,
  source_event_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array
  source_frames    TEXT,                        -- JSON [from, to]
  PRIMARY KEY (match_id, fact_id)
) STRICT;
CREATE INDEX IF NOT EXISTS facts_ts ON facts(match_id, ts);

-- runtime.sqlite -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stories (
  match_id           TEXT NOT NULL,
  story_id           TEXT NOT NULL,
  ts                 REAL NOT NULL,
  kind               TEXT NOT NULL,
  team_id            TEXT,
  player_id          TEXT,
  risk               REAL NOT NULL,
  default_status     TEXT NOT NULL CHECK (default_status IN ('auto_approved','needs_review')),
  fact_ids           TEXT NOT NULL,             -- JSON array
  evidence_event_ids TEXT NOT NULL,             -- JSON array
  analysis_en        TEXT NOT NULL,
  texts              TEXT NOT NULL,             -- JSON {en, it, es}
  verifier           TEXT NOT NULL,             -- JSON {status, attempts, flagged}
  safety             TEXT NOT NULL DEFAULT 'not_checked' CHECK (safety IN ('passed','flagged','not_checked')),
  run_id             TEXT NOT NULL,
  PRIMARY KEY (match_id, story_id)
) STRICT;

CREATE TABLE IF NOT EXISTS cues (
  match_id   TEXT NOT NULL,
  cue_id     TEXT NOT NULL,
  story_id   TEXT,
  ts         REAL NOT NULL,
  duration_s REAL NOT NULL,
  graphic    TEXT NOT NULL CHECK (graphic IN ('nameplate','pass_shot','momentum','why_card','team_stats','lineup')),
  audience   TEXT NOT NULL,
  lang       TEXT NOT NULL CHECK (lang IN ('en','it','es')),
  payload    TEXT NOT NULL,                     -- JSON, OGraf data
  PRIMARY KEY (match_id, cue_id)
) STRICT;

CREATE TABLE IF NOT EXISTS traces (
  match_id   TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  ts         REAL NOT NULL,                     -- match time
  at         TEXT NOT NULL,                     -- wall clock ISO
  agent      TEXT NOT NULL,
  step       TEXT NOT NULL,
  input_summary  TEXT NOT NULL,
  output_summary TEXT NOT NULL,
  fact_ids   TEXT NOT NULL DEFAULT '[]',
  model      TEXT,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  cost_usd   REAL NOT NULL DEFAULT 0,
  story_ids  TEXT DEFAULT '[]',                 -- JSON array: the stories this hand-off concerns
  PRIMARY KEY (match_id, run_id, seq)
) STRICT;

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY,
  session_id TEXT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,                     -- 'human', 'auto' or an agent name
  action     TEXT NOT NULL,
  match_id   TEXT,
  story_id   TEXT,
  model      TEXT,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd   REAL NOT NULL DEFAULT 0,
  detail     TEXT NOT NULL DEFAULT '{}'
) STRICT;

-- each desk POST counts the session's actions; the agents' rows are read per match
CREATE INDEX IF NOT EXISTS audit_session ON audit(session_id, actor);

CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  kill_switch INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_created ON sessions(created_at);

CREATE TABLE IF NOT EXISTS session_decisions (
  session_id  TEXT NOT NULL REFERENCES sessions(session_id),
  match_id    TEXT NOT NULL,
  story_id    TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('approved','edited','rejected')),
  edited_text TEXT,                             -- JSON {en?, it?, es?}
  at          TEXT NOT NULL,
  PRIMARY KEY (session_id, match_id, story_id)
) STRICT;

CREATE TABLE IF NOT EXISTS questions_daily (    -- Ask the studio caps (docs/CONTRACT.md)
  day        TEXT NOT NULL,                     -- YYYY-MM-DD UTC
  session_id TEXT NOT NULL,                     -- '*' for the site total
  questions  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, session_id)
) STRICT;

CREATE TABLE IF NOT EXISTS usage_daily (
  day        TEXT NOT NULL,                     -- YYYY-MM-DD UTC
  session_id TEXT NOT NULL,                     -- '*' for the site total
  live_runs  INTEGER NOT NULL DEFAULT 0,
  cost_usd   REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, session_id)
) STRICT;
