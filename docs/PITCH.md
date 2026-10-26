# Studio Desk

Studio Desk is an AI production desk for a football broadcast. Agents follow a match as it is played, pick the moments worth a story and explain them, and code builds the on-screen graphics in English, Italian and Spanish from a ledger of computed facts. The producer approves the riskier stories, and every decision and every agent step, with its tokens and cost, is kept in an audit log.

Leagues already pay for automated match stories. The Bundesliga's Data Story Finder, built with AWS, checks the league's live Match Facts against predefined story templates and sends the stories to its commentators; in its Story Monitor, editors can review, change or remove them first ([AWS for M&E Blog, 18 July 2025](https://aws.amazon.com/blogs/media/bundesliga-data-story-finder-delivering-fans-the-stories-they-love/)). Before a broadcaster lets a model write on screen, though, it has to trust the numbers and stay in charge of what airs. Studio Desk works on the graphics the viewer sees, with that in mind. Each story carries the ids of the facts and events behind its numbers, a verifier's verdict and a risk level, and the risk level decides whether the producer must approve it. One switch takes every AI story off air at once.

Code computes every number from event and tracking data and stores it in a fact ledger with the events it comes from. Models never write a number. The lines that go on air automatically are assembled by code from phrases tied to the facts that justify them. The model's own lines wait on the desk as proposals, after a verifier has checked every number against the ledger. Stories above a risk threshold need the producer; the others air on their own and are marked as auto-approved in the audit log. If an agent fails, rules take over.

The matches are synthetic. Our simulator, calibrated against public event data and published physical studies, generates the events, the tracking at 10 frames a second and 14 hidden storylines. The agents found 11 of them without ever seeing the answer key. A match costs $0.06 to $0.10 in model calls, and in one real-speed run the two goals were cued on screen 3.7 and 5.6 seconds after their shots.

The Microsoft technologies:

- **Microsoft Agent Framework** runs the workflows: a story finder, a rule-based director, an analyst, three commentators and a verifier, with fan-out and fan-in edges, audit middleware and OpenTelemetry spans.
- **Microsoft Foundry** hosts the gpt-5-mini deployment the agents use, and its built-in evaluators gave the on-air texts a mean groundedness of 4.64 out of 5.
- **Azure Container Apps** hosts the site, and its managed identity reaches Microsoft Foundry without keys.
- **Azure AI Content Safety** checks every story, and every question a visitor asks along with its answer.
- **Azure Speech in Foundry Tools** voices the verified stories in three languages.
- **Azure Monitor Application Insights** receives the agents' traces.
- **Bicep and the Azure CLI** deploy the Container App and its monitoring.
- **GitHub Actions** runs the 550 Python and 179 browser-logic tests and builds the image; the **GitHub CLI** starts workflows and downloads their results.

Also built on:

- **Model Context Protocol**, the open protocol: our read-only MCP server, held at the match clock, is the agents' only view of the match, so they cannot see later events.
- **OGraf**, the EBU's open format for HTML broadcast graphics, for every graphic on screen.

Anyone can approve stories, switch the AI off and ask the studio a question on the live site, with no account: https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/
