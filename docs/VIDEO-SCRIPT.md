# Video script

A 108-second demo, under the two-minute limit. It follows one producer through one match, M001: the problem, one story with its explanation and the facts behind it, her decision, the controls, the cost and the honest limit.

## Voice

The voice-over is read by Azure Speech in Foundry Tools, already in the stack, with the British English neural voice `en-GB-RyanNeural`, from the same F0 resource that voices the stories. If Azure Speech is not available, the fallback is the Kokoro voice `am_michael` (fetched by `scripts/booth-kokoro-setup.sh`).

The timings use a measured speaking rate of 2.18 words a second: the 83 English story clips that Azure Speech made for the replays hold 1,361 words in 623.2 seconds (`replays/<match>/voice.json`). Each segment gets its speaking time plus a 0.5-second pause, rounded up to the half second. Ryan has not been rendered yet, so time the rendered track and move the cuts; there are 12 seconds of margin before the limit.

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
| 15 to 32 s | 35 | 16.1 | The same recording. Close on the **Agents at work** strip under the picture as the story finder and the director pass the play along. | The match is synthetic, from our own simulator. The agents run on Microsoft Agent Framework with a model in Microsoft Foundry, and see the match through an MCP server that stops at the current minute. |
| 32 to 41.5 s | 19 | 8.7 | The same recording. Duarte's header goes wide at 7:50 and the big chance arrives on the desk under **Needs you**, with its medium risk. Pause the replay. | In the eighth minute, a big chance. It is medium risk, so it waits for her under Needs you. |
| 41.5 to 57.5 s | 33 | 15.1 | Open **Details**: the two facts by label and value (`F-SHOT_SPEED-000001` and `F-SHOT_DISTANCE-000001` in the ledger), the source event on the mini pitch, the verifier's verdict (rewritten once) and the Content Safety result. | Details shows why: two facts, the shot's speed and distance, each with its value and source event. Code computed both. The verifier sent the first draft back, and Content Safety passed the text. |
| 57.5 to 66 s | 17 | 7.8 | Press **Use proposal**: the agents' line ("Duarte heads wide from the six-yard box in the 8th minute, a 9.3 m effort at 67.2 km/h.") goes on air. Open the **Audit log** tab and hold on the new row. | She puts the agents' line on air with one click, and the audit log records her decision. |
| 66 to 80 s | 29 | 13.3 | Turn off the **AI graphics** switch: the story leaves the air, the desk says only template graphics are on air. Turn it back on, then open the **Traces** tab and scroll through the steps of this story. | If anything looks wrong, one switch takes every AI story off air, and the template graphics carry on. The traces show each step, with its model, tokens and cost. |
| 80 to 92 s | 24 | 11.0 | `?match=M001&t=2400&speed=1&view=split`. Open **Ask the studio**, type "How many shots has each team had?" and let the answer appear with its facts. | Viewers can ask the studio too. The answer uses only facts up to that minute, and Content Safety checks the question and the answer. |
| 92 to 108 s | 33 | 15.1 | `?match=M001&t=5630&speed=1&view=split`, the **Audit log** tab scrolled to **What the agents cost**, for 6 s. Then `?match=M001&t=4906&speed=1&play=1&view=split`: Duarte makes it 2-2 in the 81st minute and the comeback graphic comes up. Hold on it to the end. | A match costs six to ten cents in model calls. The honest limit: the matches are synthetic, and the rules alone find the same moments. The agents add the analysis; the producer decides. |

The voice-over is 221 words, about 101 seconds of speech at the measured rate. Its numbers come from [docs/MEASURES.md](MEASURES.md) and the [README](../README.md#limits): $0.060 to $0.102 a match in model calls, and the rule fallback on M001 finding the same 15 moments as the run with the model.
