# Studio Desk

An AI production desk for a football broadcast. Agents watch a match as it happens, find the stories worth telling and write the on-screen graphics in English, Italian and Spanish. Before anything goes on air, a producer approves it at the control desk.

Built for the Inside the Game hackathon, category Best Enterprise Solution. All match data is synthetic: every club, player and stadium is invented.

**Try it:** https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/

## What to try

1. Pick a match and press play. The 2D pitch, the score and the graphics all run on one clock.
2. Open **Desk**. Each story shows its text, the facts behind it and the verifier's verdict. Approve, edit or reject it. Stories below the risk threshold go out on their own, and the audit log marks them auto-approved.
3. Switch the language between EN, IT and ES. The numbers stay the same, because they come from the fact ledger rather than from the model.
4. Turn on the voice to hear the approved stories read in English.
5. Open the **Traces** tab to see which agent did what, with the model, the tokens, the time and the cost of each step.
6. Switch the AI off: only the template graphics stay on air.
7. Open `sample3d.html` for the 3D view of the same match.

The replay needs no model calls, so it has no daily quota. Each visitor session allows 300 desk actions. Every visitor gets their own session, so your choices never reach another judge, and each match starts clean.

## How it works

```
match clock --event--> facts (MCP server) --batch--> story_finder -> analyst -> commentator_en ┐
                                                                            -> commentator_it ├-> verifier -> director -> desk
                                                                            -> commentator_es ┘
```

- **Agents.** A Microsoft Agent Framework workflow on gpt-5-mini in Azure AI Foundry (Sweden Central). Agents read the match only through an MCP server whose clock moves with the match, so they cannot see the future.
- **Fact ledger.** Every number on screen is computed by code and stored as a fact with an id. Models write the words, never the numbers. The verifier checks each sentence against its facts, and the desk shows which facts a story uses.
- **Safety.** Approved texts pass through Azure AI Content Safety. The result is stored with the story, and a story that fails the check is held back and stays silent.
- **Never waits.** If an agent fails or times out, rules and template sentences take its place and the broadcast carries on. The trace records the fallback.
- **Voice.** Azure AI Speech reads the verified English stories ahead of time. A clip plays only when its checksum matches the text on screen.
- **Graphics.** Broadcast graphics in HTML, following the EBU OGraf open format (`web/graphics/`).

The four replays in `replays/` were produced by real runs on Azure. Their files hold the stories, the cues and every agent step. One match costs between $0.10 and $0.17 in model calls (277,000 to 445,000 tokens), summed from `traces.json`.

The data contract (tables, ids, coordinates, file formats, API) is in [docs/CONTRACT.md](docs/CONTRACT.md).

## Run it locally

Python 3.12.

```
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m studiodesk.sim build --matches 4 --seed 7
.venv/bin/python -m studiodesk.facts build --all
for m in M001 M002 M003 M004; do .venv/bin/python -m studiodesk.export $m; done
cp -r replays/. web/data/
.venv/bin/uvicorn studiodesk.api:app --port 8000
```

Then open http://127.0.0.1:8000/. The replay needs no Azure account. To run the agents yourself, install the `agents` extra and use `python -m studiodesk.agents run M001 --fake` for an offline model, or set `AZURE_OPENAI_ENDPOINT` and sign in with the Azure CLI for the real one.

Tests run offline and never call a paid service: `.venv/bin/pytest -q` (196 tests). GitHub Actions runs them on every push and builds the container image.

## Deployment

One container on Azure Container Apps (consumption plan, one replica), with its image on GitHub Container Registry. Foundry uses a managed identity. Live agent runs are not open to visitors yet. When they open, they will have a cap per visitor and one for the whole site.

## How it was built

Written with Claude Code (Anthropic). Third-party models, libraries and assets are listed with their licences in [THIRD_PARTY.md](THIRD_PARTY.md).

## Licence

MIT, see [LICENSE](LICENSE).
