# Testing Studio Desk

These steps take about five minutes on a computer with a current browser. You need no account and nothing to install. The site scales to zero when nobody uses it, so the first page load after a quiet spell can take about 30 seconds; after that it answers at once.

Every visitor gets their own session. Your decisions never reach another judge, and reloading a match starts it clean.

## 1. Watch the agents work (1 minute)

Open M001 just before its first key moments, playing at 4x:

https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/?match=M001&t=440&speed=4&play=1

- The picture is 3D. The small see-through pitch at the bottom is the 2D minimap: click it to swap the two views.
- The strip under the picture, **Agents at work**, shows which agent is busy and what it passed on.
- In the 8th minute a big chance reaches the **Desk** beside the picture, under **Needs you**. Its risk is medium, so it waits for a person.
- In the 10th minute Redwick Wanderers score. A goal is low risk, so the graphic goes on air by itself and is marked auto-approved.
- Graphics are timed in match seconds, so at 4x the goal's cards stay on screen for 1.5 to 3 seconds. To watch them at real speed, press **Next key moment** (or N): it jumps to just before the next moment and drops to 1x.

## 2. Make a decision (1 minute)

On the big chance in **Needs you**:

1. Open **Details**. You see the facts the story cites, the verifier's verdict and the Content Safety result.
2. Press **Put on air**, **Edit** or **Reject**. The line that confirms your choice has an **Undo** button.
3. Open the **Audit log** tab. Your decision is there, next to the auto-approved goal.

## 3. See what the agents did (1 minute)

Open the **Traces** tab. Each step lists the agent, the model, the tokens, the time and the cost. Steps marked "rules, no model" or "code, no model" made no model call. Press **Show story** on a step to jump to the story it produced.

## 4. Switch the AI off (30 seconds)

Turn the **AI graphics** switch on the desk off. Only the template graphics stay on air, and the **Next key moment** button becomes **Next goal**. Turn it back on.

## 5. Change the language and the audience (1 minute)

Open the settings (the gear). Set **Language** to IT or ES: the desk, the controls and the graphics change language, and the numbers stay the same, because code computes them. Set **Audience** to Kids or to one team.

This link opens M001 at the first goal, in Italian, for fans of Ostwick FC:

https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/?match=M001&t=590&audience=team:T02&lang=it&speed=1&play=1

## 6. Ask the studio (30 seconds)

Press **Ask the studio** and type a question about the match so far, for example "How many shots has each team had?". The answer uses only facts up to the replay time and lists them under it. Each session can ask 10 questions a day, and the whole site answers 40 a day.

## If you have more time

- Turn on **Voice** in the settings to hear approved stories read aloud.
- Try the other matches: [M002](https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/?match=M002), [M003](https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/?match=M003) and [M004](https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/?match=M004). **Next key moment** jumps to the next story the agents found.
- On a phone the page starts on the 2D pitch, and **Desk** opens the control desk.

The replay makes no model calls, so watching has no quota. A session allows 300 desk actions. The full list of features is in [What to try](../README.md#what-to-try).
