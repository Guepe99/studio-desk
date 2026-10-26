# Testing Studio Desk

These steps take about five minutes on a computer with an up-to-date browser. You need no account and nothing to install. The site scales to zero when nobody uses it, so the first page load after a quiet spell can take about 30 seconds; after that it answers at once.

Every visitor gets their own session, kept in a cookie. Your decisions never reach another judge, and each match starts with no decisions. A reload keeps the decisions you made.

**3D or 2D.** On a computer with a graphics card the picture is 3D, with the 2D pitch as a small see-through minimap at the bottom; click the minimap to swap the two views. On a machine without a graphics card (a virtual machine or a remote desktop, where the browser draws in software) the page opens on the 2D pitch. Add `&view=split` to any link below to bring the 3D view back; it may run slowly there.

The links below open each moment at 1x speed a few seconds before it happens, so you do not have to wait for it. Graphics stay on screen for 6 to 15 seconds, so at 4x or faster they pass quickly. While a graphic is on air, **Show proof** under the picture lists the fact behind each number on it.

## 1. Watch the agents work (1 minute)

Open M001 five seconds before the big chance of the 8th minute:

https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/?match=M001&t=465&speed=1&play=1

- The strip under the picture, **Agents at work**, shows which agent is busy and what it passed on.
- The big chance reaches the **Desk** beside the picture, under **Needs you**. Its risk is medium, so it waits for the producer, which is you.
- **Next key moment** (or N) jumps to just before the next moment and plays it at 1x.

## 2. Make a decision (1 minute)

On the big chance in **Needs you**:

1. Open **Details**. It shows the facts the story cites from the fact ledger, each with what it measures and its value, the event they come from on a small pitch, the verifier's verdict and the Content Safety result.
2. Press **Put on air**, **Edit** or **Reject** on the story, or **Use proposal** in Details (the agents' own line). Pause first if you need time: the story is due on air at 7:56 (the shot card first, then the big chance card at 8:01), and your choice decides what airs then. The confirmation that appears has an **Undo** button.
3. Now open the first goal, in the 10th minute. Redwick Wanderers score; a goal is low risk, so its graphics go on air by themselves: a shot card, then the goal card, for about 18 seconds:

   https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/?match=M001&t=590&speed=1&play=1

4. Open the **Audit log** tab. Your decision on the big chance is at the top, under **Your actions**; the table below it lists the auto-approved goal and the agent steps.

## 3. See what the agents did (1 minute)

Open the **Traces** tab. Each step lists the agent, the model, the tokens, the time and the cost. Director steps are marked "rules, no model": the director makes no model call. Press **Show story** beside a story's steps to jump to the story they produced.

## 4. Switch the AI off (30 seconds)

Turn off the **AI graphics** switch on the desk. Every story goes off air, approved ones included, and only the template graphics that code builds from the facts stay (line-ups, name plates, pass and shot cards, and the Momentum panel); the Team shape panels, also built by code, still wait for you under **Needs you**. The **Next key moment** button becomes **Next goal**. Turn it back on. The switch belongs to your session, so it also applies to the other matches until you turn it back on.

## 5. Change the language and the audience (1 minute)

Open the settings (the gear). Set **Language** to IT or ES: the desk, the controls and the graphics change language, and the numbers stay the same, because code computes them. Set **Audience** to Kids or to one team.

This link opens M001 at the first goal, in Italian, for fans of Ostwick FC:

https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/?match=M001&t=590&audience=team:T02&lang=it&speed=1&play=1

## 6. Ask the studio (30 seconds)

Press **Ask the studio** and type a question about the match so far, for example "How many shots has each team had?". The answer uses only facts up to the replay time and lists them under it. You can ask 10 questions a day in each session, and the whole site answers 40 a day.

## If you have more time

- Press **Voice** under the picture to hear the stories on air read aloud. It speaks at 1x speed only.
- Try the other matches: [M002](https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/?match=M002), [M003](https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/?match=M003) and [M004](https://studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io/?match=M004). **Next key moment** jumps to the next story the agents found.
- On a phone the page starts on the 2D pitch, and **Desk** opens the control desk.

The replay makes no model calls, so watching has no quota. Each session allows 300 desk actions in all: decisions, undos and AI switch flips. The full list of features is in [What to try](../README.md#what-to-try).
