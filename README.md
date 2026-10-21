# Studio Desk

An AI production desk for a football broadcast. Agents follow a match as it is played and write the on-screen graphics in English, Italian and Spanish. Before anything goes on air, a producer approves it at the control desk.

Built for the Inside the Game hackathon, in the Best Enterprise Solution category. All match data is synthetic: every club, player and stadium is invented.

**Try it:** https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/

## What to try

1. Open a match and press Play. The page opens on M001; the others are [M002](https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/?match=M002), [M003](https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/?match=M003) and [M004](https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/?match=M004). The seek bar has a button for each goal, and **Next key moment** jumps to the next story the agents found.
2. On a computer the picture is 3D, with the 2D pitch as a small, see-through live minimap at the bottom, as in a football game. Click the minimap to swap the two, and click it again to swap them back. **Minimap** in the settings (the gear) turns it off. The 3D view runs in your browser and uses the same tracking data; a phone starts on the 2D pitch.
3. Look at the **Desk** beside the picture (on a phone, press **Desk**). Each story lists the facts behind it, the verifier's verdict and a risk level (low, medium or high). Use **Put on air**, **Edit** or **Reject** on a story; **Undo** in the line that confirms it reverses the last decision. Stories below the risk threshold go on air automatically and are marked auto-approved in the **Audit log** tab.
4. Look at the strip under the picture. It shows which agent is working and what it passed on. While a graphic is on air, it shows how that graphic was made.
5. Switch the language to EN, IT or ES in the settings. The desk, the controls and the graphics change language. The numbers do not change, because code computes them from the fact ledger; the model never writes them.
6. Turn on **Voice** to hear approved stories read aloud in the language on screen.
7. Open **Ask the studio** and type a question about the match so far. The answer may use only facts up to the current replay time. If an answer fails the checks, the studio shows a fixed sentence instead of it.
8. Open the **Traces** tab on the desk. It lists each step with the agent, model, tokens, time and cost.
9. Turn the **AI graphics** switch on the desk off. Only the template graphics stay on air, and **Next key moment** becomes **Next goal**.
10. Change the audience in the settings: analyst, casual fan, fans of one team or fans of one player. The speed and the audience show beside the gear when they are not the default.
11. Open a match at a given moment with a link: `?match=M001&t=2400&audience=casual&speed=4&play=1` starts M001 at 40:00 of match time (`t` is in match seconds) for the casual fan, at 4x, playing. Audiences are `analyst`, `casual`, `team:<id>` and `player:<id>`, as in the settings; speeds are 1, 4, 16 and 64.

The replay makes no model calls, so it has no daily quota. Each session allows 300 desk actions and 10 questions per day, and the whole site answers 40 questions per day, to stay inside the Azure AI Content Safety free tier. Every visitor gets their own session, so your choices never reach another judge, and each match starts clean.

## How it works

```
match clock --event--> facts (MCP server) --batch--> story_finder -> director -> on air
                                                                            └-> analyst -> commentator_en ┐
                                                                                        -> commentator_it ├-> verifier -> desk
                                                                                        -> commentator_es ┘
```

The director puts a story on air as soon as the story finder has chosen it, with the phrasebook's lines. The analyst, the commentators and the verifier then add the analysis and their proposals to the desk.

- **Agents.** A Microsoft Agent Framework workflow running gpt-5-mini in Azure AI Foundry (Sweden Central). Agents read the match only through a Model Context Protocol (MCP) server whose clock follows the match, so they cannot see later events.
- **Fact ledger.** Every number on screen is computed by code and stored as a fact with an id; models never write numbers. The desk shows which facts a story uses.
- **Phrasebook.** Lines that go on air automatically are assembled by code from phrases written for each language. Each phrase is tied to the fact that justifies it: "What a hit!" is used only for a shot of 100 km/h or more, and "strikes again" only for a player's second goal. The story finder chooses the tone and what the line leads with (for example where the shot came from, its distance or its speed). The verifier checks the commentators' own lines against the facts, and they wait on the desk as proposals that a person can put on air with one click.
- **Safety.** Approved texts pass through Azure AI Content Safety. The result is stored with the story, and a story that fails the check is held back.
- **Fallbacks.** If an agent fails or times out, rules and template sentences take its place and the broadcast carries on. The trace records the fallback.
- **Voice.** Azure AI Speech records the verified stories ahead of time in English, Italian and Spanish. A clip plays only if its checksum matches the text on screen.
- **Ask the studio.** A `studio_host` agent answers a visitor's question through the same MCP server, on a clock held at the replay time. Code checks the answer before it is shown: every number must be a cited fact with its unit, a score must be the score at that moment, the answer must contain no link and no real name and be in the visitor's language, and Content Safety must pass both the question and the answer.
- **Graphics.** Broadcast graphics are HTML in the open EBU OGraf format (`web/graphics/`). On a small screen they switch to a compact layout, and the text is never smaller than 11 px.
- **3D view.** Babylon.js draws the players from the tracking data and adds a broadcast camera, goal replays and celebrations. The view falls back to 2D on devices that are too slow. For visitors who ask for reduced motion, it keeps the wide broadcast camera and makes no cuts.

The four replays in `replays/` come from real runs on Azure, and their files hold the stories and every agent step. Model calls for one match cost between $0.060 and $0.102 (236,000 to 430,000 tokens), taken from each run's audit. Stories found, numbers blocked, tokens, cost and timing for each match are in [docs/MEASURES.md](docs/MEASURES.md).

The on-air texts were also scored by Microsoft Foundry's built-in evaluators, with gpt-5-mini as the judge, through the Agent Framework's `FoundryEvals`: 249 items, every story of the four replays in English, Italian and Spanish. The judge read each text against the facts and events it cites. Mean scores out of 5: groundedness 4.64 (243 of 249 passed), relevance 4.23, coherence 4.36 and fluency 3.47 (249 of 249 passed each). Five of the six groundedness failures are lines that say a player "strikes again" or "tries again" when the earlier goal or shot is not among that story's facts. In the sixth, the judge read a defensive line moving from 15.7 m to 48.5 m from goal as a deeper line. The run cost about $1.33 in judge tokens. To rerun it: `.venv/bin/python scripts/foundry_evals.py` (it calls Azure and needs the Foundry User role on the `studiodesk` project). The table and the details are in [docs/MEASURES.md](docs/MEASURES.md#foundry-evaluators).

The data contract, from the tables to the API, is in [docs/CONTRACT.md](docs/CONTRACT.md).

## Run it locally

Requires Python 3.12.

```
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m studiodesk.sim build --matches 4 --seed 7
.venv/bin/python -m studiodesk.facts build --all
for m in M001 M002 M003 M004; do .venv/bin/python -m studiodesk.export $m; done
cp -r replays/. web/data/
.venv/bin/uvicorn studiodesk.api:app --port 8000
```

The export builds the tracking data and the template graphics; the copy adds the recorded agent output. Then open http://127.0.0.1:8000/. The replay needs no Azure account. To run the agents yourself, install the extras with `.venv/bin/pip install -e '.[dev,agents]'`, then use `.venv/bin/python -m studiodesk.agents run M001 --fake` for an offline model, or set `AZURE_OPENAI_ENDPOINT` and sign in with the Azure CLI to use the real one.

Tests run offline and never call a paid service: `.venv/bin/pytest -q` and `node --test tests/web/*.test.mjs`. The browser checks in `tests/web/` (layout, desk, 3D, voice) run with `scripts/with-lock.sh chromium tests/web/run-smoke.sh <check>.mjs`. GitHub Actions runs them on every push and builds the container image.

## Deployment

One container on Azure Container Apps (consumption plan, one replica), with its image on GitHub Container Registry. The container reaches Foundry through a managed identity. Visitors cannot start live agent runs; the replays show agent output recorded on Azure. Desk decisions are stored per session inside the container (`runtime.sqlite`), so deploying a new revision resets them.

Besides the Traces tab, the agents send OpenTelemetry traces to Azure Application Insights (`studiodesk-insights`, on the Log Analytics workspace `log-studiodesk`, both capped at 0.1 GB a day) when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set, in the Container App or for a local `python -m studiodesk.agents run` (`studiodesk/telemetry.py`). Microsoft Agent Framework's own spans carry the GenAI attributes: `invoke_agent <agent>`, `chat <model>` with token usage, `execute_tool` and the MCP `tools/call`. Each Ask the studio question is an `ask_studio` span, and each verifier verdict a `studiodesk.verdict` event with its short reason. Message content, the visitor's question and client addresses stay out. The infrastructure is in `infra/` (Bicep): `monitoring.bicep` for the workspace and Application Insights, `main.bicep` for the Container App with the connection string as a secret.

## How it was built

Written with Claude Code (Anthropic). Third-party material is listed with its licence in [THIRD_PARTY.md](THIRD_PARTY.md).

## Licence

MIT, see [LICENSE](LICENSE).
