# Studio Desk: rules for every Claude session and builder agent

Hackathon entry for "Inside the Game" (Microsoft + Premier League), category Best Enterprise
Solution.

## Before writing code

1. Read `docs/CONTRACT.md`. It is the data contract: tables, ids, coordinates, file formats, API,
   MCP tools. Do not change it in a feature branch; if you need a change, stop and report it.
2. Read only the parts of the code you touch. Reuse `studiodesk/db.py` and `studiodesk/config.py`.

## Hard rules

- No real names anywhere: clubs, players, stadiums, sponsors, broadcasters, leagues, music.
  Every generated name is checked against `data/forbidden_names.txt`. Real brands may appear only
  in the written pitch, never in code output, the UI or the video.
- No CSV, ever: not as input, cache or hand-off. Data goes in SQLite through `studiodesk/db.py`;
  JSON only for config and the static replay export.
- Numbers on screen come from the fact ledger (`facts`), never from a model.
- The hidden `storylines` table is never read by agents, the MCP server or the API.
- Pinned versions only (`pyproject.toml`, `package.json`). No new dependency for a few lines.
- Public repo, MIT. Anything third-party you add goes in `THIRD_PARTY.md` with licence and link.
- Never call paid Azure services from tests. Tests run offline.
- Code, comments, docs and UI text in English. No em dashes in user-facing text.

## Working as a builder agent

- Work in your own git worktree and branch (`feat/<piece>`). At the end: tests pass, commit,
  push the branch, then `git worktree remove`. The lead session merges.
- Start with `scripts/agent-start.sh`. It refuses to run when the disk cap is exceeded.
- Disk cap: 2 GB per worktree (`du -sh .`). Delete caches, renders and venvs you created before
  finishing. Never copy datasets into the worktree; read them from `~/progetti/inside-the-game/data`.
- Chromium (Playwright, screenshots, captures) and heavy builds go through the lock:
  `scripts/with-lock.sh chromium <command>` or `scripts/with-lock.sh build <command>`.
  One Chromium and one build at a time on this machine (8 GB RAM).
- Jobs longer than 5 minutes (renders, voice, captures) run detached:
  `systemd-run --user --unit sd-<name> --same-dir <command>` or `nohup`, write the outcome to
  `out/<name>.log`, and end with `~/bin/avvisa.sh "<what finished>"`.
- Python: `.venv/bin/python`, `.venv/bin/pytest -q`. Every new module with logic gets a test.
  There is no `sqlite3` command-line tool: inspect databases from Python.
- Playwright: reuse `~/bin/pagine/node_modules` (Chromium 1140 in `~/.cache/ms-playwright`),
  always through `scripts/with-lock.sh chromium`. Do not download another browser.
- Report back: what you built, how you tested it (command and result), and what you did not test.

## Layout

    studiodesk/         Python package
      schema.sql db.py config.py   shared, owned by the lead session
      sim/              A: simulator and synthetic dataset
      facts/            B: facts engine
      clock.py mcp_server.py       B: match clock and MCP server
      agents/           C: Microsoft Agent Framework workflow
      api.py            D: FastAPI, sessions, decisions, live caps
      export.py         static replay export
    web/                broadcast page (2D, 3D, OGraf graphics in web/graphics/<name>/)
    data/               SQLite files (git-ignored) and forbidden_names.txt
    docs/               CONTRACT.md and design notes
    scripts/            helper scripts
    tests/              pytest
    infra/              Bicep / azd for Azure
