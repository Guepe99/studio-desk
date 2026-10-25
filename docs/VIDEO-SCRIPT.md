# Video script

A demo of 104 seconds, under the 2 minute limit, with an English voice-over read by the Kokoro voice `am_michael` (fetched by `scripts/booth-kokoro-setup.sh`). The timings assume about 2.6 words a second and a short pause between segments; they are an estimate, so time the rendered voice-over and adjust the cuts.

## Capture rules

- Record only the page, at 1920x1080, without the browser frame, tabs or address bar.
- Keep **Voice** off in the settings and add no music. The only sound is the voice-over.
- Start each recording after the 3D scene has loaded, so no loading screen appears.
- No third-party logos or brands on screen: show the site only, never the code host or the Azure portal.
- All links below are on `https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/`. `t` is match time in seconds.

## Shot list

| time | on screen | voice-over |
|---|---|---|
| 0 to 12 s | `?match=M002&t=1316&speed=1&play=1`. The 3D picture with the minimap; Mensah scores from 25 m in the 23rd minute and the goal graphic comes up. | This is Studio Desk, an AI production desk for football. The match is synthetic, made by our own simulator, and a team of agents follows it as it is played. |
| 12 to 26 s | The same recording. Close on the **Agents at work** strip under the picture while the goal graphic is on air. | The agents run on Microsoft Agent Framework, with a model in Microsoft Foundry. They read the match only through our MCP server, held at the match clock, so they never see what comes next. |
| 26 to 43 s | `?match=M001&t=455&speed=4&play=1`. The big chance of the 8th minute arrives under **Needs you**; pause, open **Details** (facts, verifier, safety), press **Put on air**, then open the **Audit log** tab. | Code computes every number, and a verifier checks each one against the fact ledger. This big chance has a medium risk, so it waits for the producer. One click puts it on air. The audit log records the decision. |
| 43 to 51 s | The **Traces** tab of the same match, scrolled through the steps of one story. | The traces show every step, with its agent, model, tokens and cost, and they also go to Application Insights. |
| 51 to 59 s | `?match=M001&t=590&audience=team:T02&lang=it&speed=1&play=1` for 4 s, then `?match=M001&t=590&audience=kids&lang=es&speed=1&play=1` for 4 s. | The same facts become graphics in three languages and for different audiences, from analysts to kids. The numbers never change. |
| 59 to 70 s | `?match=M001&t=2400&speed=1`. Open **Ask the studio**, type "How many shots has each team had?" and let the answer appear with its facts. | Viewers can ask the studio a question. The answer uses only facts up to that minute, and Azure AI Content Safety checks the question and the answer. |
| 70 to 77 s | The same page. Turn the **AI graphics** switch off: the desk says only template graphics are on air, and **Next key moment** becomes **Next goal**. | If the model fails, or the producer switches the AI off, template graphics keep the broadcast going. |
| 77 to 92 s | `?match=M001&t=5630&speed=1`. The **Audit log** tab, scrolled to **What the agents cost**. | Across four matches the agents found 11 of the 14 storylines the simulator hid. A match costs six to ten cents in model calls, and Foundry's evaluators gave the texts 4.64 out of 5 for groundedness. |
| 92 to 104 s | `?match=M002&t=4455&speed=1&play=1`. The 3D picture; Vellacott makes it 2-2 in the 73rd minute and the comeback graphic comes up. Hold on it to the end. | It runs on Azure Container Apps. Azure AI Speech can read the stories aloud, and GitHub Actions runs the tests and builds the image. The agents write; the producer decides. |

The voice-over is 252 words. Its numbers come from [docs/MEASURES.md](MEASURES.md): 11 of 14 storylines found, $0.060 to $0.102 a match in model calls, and a mean groundedness of 4.64 out of 5 from the Foundry evaluators.

## Italian translation of the voice-over, for approval

| time | voce |
|---|---|
| 0 to 12 s | Questo è Studio Desk, una regia con l'intelligenza artificiale per le partite di calcio. La partita è sintetica, l'ha creata il nostro simulatore, e una squadra di agenti la segue mentre si gioca. |
| 12 to 26 s | Gli agenti girano su Microsoft Agent Framework, con un modello su Microsoft Foundry. Leggono la partita solo dal nostro server MCP, fermo al minuto di gioco, quindi non vedono mai cosa succede dopo. |
| 26 to 43 s | Ogni numero lo calcola il codice, e un verificatore li confronta uno per uno con il registro dei fatti. Questa grande occasione ha un rischio medio, quindi aspetta il regista. Con un clic va in onda. Il registro delle azioni annota la decisione. |
| 43 to 51 s | Le tracce mostrano ogni passaggio, con agente, modello, token e costo, e arrivano anche ad Application Insights. |
| 51 to 59 s | Gli stessi fatti diventano grafiche in tre lingue e per pubblici diversi, dagli analisti ai bambini. I numeri restano sempre quelli. |
| 59 to 70 s | Chi guarda può fare una domanda allo studio. La risposta usa solo i fatti fino a quel minuto, e Azure AI Content Safety controlla la domanda e la risposta. |
| 70 to 77 s | Se il modello si guasta, o il regista spegne l'intelligenza artificiale, le grafiche di base mandano avanti la diretta. |
| 77 to 92 s | In quattro partite gli agenti hanno trovato 11 delle 14 trame che il simulatore aveva nascosto. Una partita costa fra sei e dieci centesimi di chiamate al modello, e i valutatori di Foundry hanno dato ai testi 4,64 su 5 di aderenza ai fatti. |
| 92 to 104 s | Gira su Azure Container Apps. Azure AI Speech può leggere le storie ad alta voce, e GitHub Actions esegue i test e costruisce l'immagine. Gli agenti scrivono, il regista decide. |
