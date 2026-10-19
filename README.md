# Studio Desk

An AI production desk for a football broadcast. Agents watch a match as it happens and write the text for the on-screen graphics in English, Italian and Spanish. Before anything goes on air, a producer approves it at the control desk.

Built for the Inside the Game hackathon, in the Best Enterprise Solution category. All match data is synthetic: every club, player and stadium is invented.

**Try it:** https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/

## What to try

1. Pick a match and press play. The 2D pitch and the graphics run on one clock.
2. Open **Desk**. Each story shows the facts behind it and the verifier's verdict. Approve, edit or reject it. Stories below the risk threshold go to air automatically, and the audit log marks them auto-approved.
3. Switch the language between EN, IT and ES. The numbers stay the same, because they come from the fact ledger rather than from the model.
4. Turn on the voice to hear the approved stories read in English.
5. Open the **Traces** tab to see which agent did what, with the model, the tokens, the time and the cost of each step.
6. Switch the AI off and only the template graphics stay on air.
7. Open `/sample3d.html` on the same site for the 3D view of the same match.

The replay needs no model calls, so it has no daily quota. Each visitor session allows 300 desk actions. Every visitor gets their own session, so your choices never reach another judge, and each match starts clean.

## How it works

```
match clock --event--> facts (MCP server) --batch--> story_finder -> analyst -> commentator_en ┐
                                                                            -> commentator_it ├-> verifier -> director -> desk
                                                                            -> commentator_es ┘
```

- **Agents.** A Microsoft Agent Framework workflow on gpt-5-mini in Azure AI Foundry (Sweden Central). Agents read the match only through an MCP server whose clock moves with the match, so they cannot see the future.
- **Fact ledger.** Every number on screen is computed by code and stored as a fact with an id. Models write the words, never the numbers. The verifier checks each sentence against its facts, and the desk shows which facts a story uses.
- **Safety.** Approved texts pass through Azure AI Content Safety. The result is stored with the story, and a story that fails the check is held back.
- **Fallbacks.** If an agent fails or times out, rules and template sentences take its place and the broadcast carries on. The trace records the fallback.
- **Voice.** Azure AI Speech reads the verified English stories ahead of time. A clip plays only when its checksum matches the text on screen.
- **Graphics.** Broadcast graphics in HTML, in the EBU OGraf open format (`web/graphics/`).

The four replays in `replays/` were produced by real runs on Azure. Their files hold the stories and every agent step. One match costs between $0.10 and $0.17 in model calls (276,000 to 475,000 tokens), summed from the `traces.json` in each replay.

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

The export builds the tracking and the template graphics; the copy adds the recorded agent output on top. Then open http://127.0.0.1:8000/. The replay needs no Azure account. To run the agents yourself, run `.venv/bin/pip install -e '.[dev,agents]'`, then `.venv/bin/python -m studiodesk.agents run M001 --fake` for an offline model, or set `AZURE_OPENAI_ENDPOINT` and sign in with the Azure CLI for the real one.

Tests run offline and never call a paid service: `.venv/bin/pytest -q` (196 tests). GitHub Actions runs them on every push and builds the container image.

## Deployment

One container on Azure Container Apps (consumption plan, one replica), with its image on GitHub Container Registry. The container reaches Foundry through a managed identity. Live agent runs are disabled for visitors: the replays show agent output recorded on Azure. Visitors' desk decisions are kept per session inside the container (runtime.sqlite), so a new revision starts them afresh.

## How it was built

Written with Claude Code (Anthropic). Third-party material is listed with its licence in [THIRD_PARTY.md](THIRD_PARTY.md).

## Licence

MIT, see [LICENSE](LICENSE).
