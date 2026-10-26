# Video script

A 115-second demo, under the two-minute limit. It follows one producer through one match, M001: the problem, one story with its explanation and the facts behind it, her decision, the controls and the cost, the same goal for another audience, a viewer's question and the honest limit.

## Voice

The voice-over is read by Azure Speech in Foundry Tools, already in the stack, with the British English neural voice `en-GB-RyanNeural`, from the same F0 resource that voices the stories. If Azure Speech is not available, the fallback is the Kokoro voice `am_michael` (fetched by `scripts/booth-kokoro-setup.sh`).

The timings use a measured speaking rate of 2.18 words a second: the 83 English story clips that Azure Speech made for the replays hold 1,361 words in 623.2 seconds (`replays/<match>/voice.json`). Each segment gets its speaking time plus a 0.5-second pause, rounded up to the half second. Ryan has not been rendered yet, so time the rendered track and move the cuts; there are 5 seconds of margin before the limit.

## Capture rules

- Record only the page, at 1920x1080, without the browser frame, tabs or address bar.
- Record on a machine with a graphics card, or keep `&view=split` in every link, so the picture is 3D.
- Keep **Voice** off on the page and add no music. The only sound is the voice-over.
- Start each recording after the 3D scene has loaded, so no loading screen appears.
- No third-party logos or brands on screen: show the site only, never the code host or the Azure portal.
- All links below are relative to `https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/`. `t` is match time in seconds.

## Shot list

| time | words | speech (s) | on screen | voice-over |
|---|---|---|---|---|
| 0 to 15 s | 31 | 14.2 | `?match=M001&t=439&speed=1&view=split`: wait for the 3D scene, press Play, start recording. The 3D picture with the minimap and the desk beside it. | A producer has seconds to decide what goes on screen, and one wrong number on air costs trust. Studio Desk gives her a team of agents and keeps her in charge. |
| 15 to 32 s | 35 | 16.1 | The same recording. Hold on the 3D picture and the minimap as the play builds; the **Agents at work** strip under the picture still says no agent has handed anything on yet. | The match is synthetic, from our own simulator. The agents run on Microsoft Agent Framework with a model in Microsoft Foundry, and see the match through an MCP server that stops at the current minute. |
| 32 to 41.5 s | 19 | 8.7 | The same recording. Duarte's header goes wide at 7:50 and the big chance arrives on the desk under **Needs you**, with its medium risk. At about 36 s (7:55) the shot speed card comes up and the **Agents at work** strip fills with the story finder, the analyst, the commentators, the verifier and the director. Pause the replay at about 38 s. | In the eighth minute, a big chance. It is medium risk, so it waits for her under Needs you. |
| 41.5 to 57.5 s | 33 | 15.1 | Open **Details**: the two facts by label and value (`F-SHOT_SPEED-000001` and `F-SHOT_DISTANCE-000001` in the ledger), the source event on the mini pitch, the verifier's verdict (rewritten once) and the Content Safety result. | Details shows why: two facts, the shot's speed and distance, each with its value and source event. Code computed both. The verifier sent the first draft back, and Content Safety passed the text. |
| 57.5 to 66 s | 17 | 7.8 | Press **Use proposal** in Details, then Play. At 8:01 the Big chance card comes up with the agents' line ("Duarte heads wide from the six-yard box in the 8th minute, a 9.3 m effort at 67.2 km/h."). Pause, open the **Audit log** tab and hold on the new row under **Your actions**. Cut the wait before 8:01 in the edit if it runs long. | She puts the agents' line on air with one click, and the audit log records her decision. |
| 66 to 82 s | 33 | 15.1 | Turn off the **AI graphics** switch: the Big chance card leaves the air, and the desk says only template graphics are on air. Turn it back on, then open the **Traces** tab and scroll through the steps of this story, with their tokens and cost. | If anything looks wrong, one switch takes every AI story off air, and the template graphics carry on. The traces show each step's cost: six to ten cents a match in model calls. |
| 82 to 91 s | 18 | 8.3 | `?match=M001&t=600&speed=1&play=1&view=split`: at 10:02 the Goal card reads "Okowande fires one in at 92 km/h in the 10th minute: Redwick lead 1-0.", for 3 s. Cut to `?match=M001&t=600&audience=team:T02&lang=it&speed=1&play=1&view=split`, the same goal in Italian for Ostwick fans, "Brutta notizia: Okowande segna al 10' e il Redwick passa in vantaggio, 1-0.", with the audience beside the gear, for 6 s. | Each viewer gets their own broadcast: the same goal, in Italian, for fans of the team that conceded. |
| 91 to 103 s | 24 | 11.0 | `?match=M001&t=2400&speed=1&view=split`. Open **Ask the studio**, type "How many shots has each team had?" and let the answer appear with its facts. | Viewers can ask the studio too. The answer uses only facts up to that minute, and Content Safety checks the question and the answer. |
| 103 to 115 s | 24 | 11.0 | `?match=M001&t=4906&speed=1&play=1&view=split`: Duarte's 107 km/h shot makes it 2-2 in the 81st minute, and about 9 s in (81:55) the Goal and Comeback cards come up. Hold on them to the end. | The honest limit: the rules alone find nine of the fourteen hidden storylines. The agents find eleven and write the analysis; the producer decides. |

The voice-over is 234 words, about 107 seconds of speech at the measured rate. Its numbers come from [docs/MEASURES.md](MEASURES.md) and the [README](../README.md#limits): $0.060 to $0.102 a match in model calls, and the hidden storylines found: 11 of 14 with the agents, 9 of 14 with the rules alone.
