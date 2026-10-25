# Pitch

Studio Desk is an AI production desk for a football broadcast. Agents follow a match as it is played, pick the moments worth a story and write the on-screen graphics in English, Italian and Spanish. A producer decides what goes on air, and every decision and every model call is kept in an audit log.

Leagues already pay for this kind of help: the Bundesliga's Data Story Finder turns live match data into stories for its commentators. Before a broadcaster lets a model write on screen, it needs to trust the numbers and to stay in charge of what airs.

Code computes every number from event and tracking data and stores it in a fact ledger with the events it comes from. Models never write a number. The lines that air on their own are assembled by code from phrases tied to the facts that justify them. The model's own lines wait on the desk as proposals, after a verifier has checked every number against the ledger. Stories above a risk threshold need a person; the others air on their own and stay marked as auto-approved. If an agent fails, rules take over.

The matches are synthetic. Our simulator, calibrated on public event data and published physical studies, generates the events, the tracking at 10 frames a second and 14 hidden storylines. The agents found 11 of them without ever seeing the answer key. A match costs $0.06 to $0.10 in model calls, and in a real-speed run the two goals were cued on screen 3.7 and 5.6 seconds after the shot.

The Microsoft technologies:

- **Microsoft Agent Framework** runs the workflow: a story finder, an analyst, three commentators and a verifier, with fan-out and fan-in edges, audit middleware and OpenTelemetry spans.
- **Microsoft Foundry** hosts the gpt-5-mini deployment the agents use, and its built-in evaluators gave the on-air texts a mean groundedness of 4.64 out of 5.
- **Model Context Protocol**: the agents read the match only through our read-only MCP server, held at the match clock, so they cannot see later events.
- **Azure Container Apps** hosts the site, and its managed identity reaches Foundry without keys.
- **Azure AI Content Safety** checks every story and each visitor question and answer.
- **Azure AI Speech** voices the verified stories in three languages.
- **Application Insights** receives the agents' traces.
- **Bicep and the Azure CLI** deploy the infrastructure; **GitHub Actions** runs 541 tests and builds the image; the **GitHub CLI** drives workflow runs.

The graphics follow the EBU's open OGraf format for HTML broadcast graphics. On the live site anyone can approve stories, switch the AI off and ask the studio a question. No account is needed.
