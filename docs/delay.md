# Broadcast delay

Live TV often reaches viewers a few seconds after the action. Studio Desk can do the same on purpose:
with a delay of D seconds the control desk runs at the live time and the broadcast picture (the 2D
pitch, the 3D view and the OGraf graphics on them) runs D seconds behind. Two things follow:

- a story whose graphic was ready within D seconds of its moment goes on the delayed picture at that
  moment, so the goal graphic lands on the goal instead of a second or more after it;
- the producer sees each story on the desk up to D seconds before viewers see its moment, which is
  time to approve, edit or reject it.

Open it from the settings (the gear, **Broadcast delay**: 0, 5, 10 or 15 s) or with `&delay=10` in the
link. With a delay on, a tag under the score bug says so ("Delay 10 s"). The default is 0: the page
then plays exactly as without the feature.

## What broadcasters do

- A short delay on live programmes keeps profanity, bloopers and other material that must not air
  off the screen: the "seven-second delay" or "profanity delay", with an operator who watches the live
  feed and drops what must not go out. https://en.wikipedia.org/wiki/Broadcast_delay
- After the 2004 half-time incident, a US network ran its Monday night football broadcast "on a
  five-second delay for the rest of the season" (16 September 2004).
  https://www.espn.com/espn/wire/_/section/nfl/id/1882921
- A current profanity delay unit "can delay a live stream for up to 20 seconds in HD, 10 seconds in
  3Gb/s and 110 seconds in SD", and the operator uses it "to react to and prevent unwanted obscenities
  or offensive materials".
  https://tvtechnology.com/equipment/crystal-vision-launches-cleanit-profanity-delay-system
- The chain itself adds delay: digital TV, satellite and streaming reach viewers seconds after the
  action, and nearly 15 million UK viewers have had a goal spoiled by a lagging broadcast (a 2021
  survey). https://www.advanced-television.com/2021/06/10/research-millions-have-missed-a-goal-due-to-broadcast-lag/

So the menu offers 5 s (the classic sports delay), 10 s and 15 s (inside what HD delay units hold),
and 0 for none. 10 s is the one to try: it covers every story latency measured on a live-speed run
(below).

## How it works

Code: `web/js/delay.js`, with a few hook lines in `web/js/app.js`, `web/js/desk.js` and
`web/index.html`.

- The replay time on the seek bar, the score bug, the picture, the graphics and the voice are the
  picture's time. The desk runs D seconds ahead: a story is listed once the live time (picture time
  plus D) has reached it, and its countdown to air counts to its slot on the delayed picture.
- A story's moment is the one event it cites (the shot of a goal or a chance, a sprint) when that is at
  most 10 s before the story; otherwise the story's own time (a recap, a pressing spell, a change of
  shape: a window that ends then).
- A story's lead is the time from its moment to its first cue (when the graphic reached air in the
  replay). On the delayed picture all the story's cues move earlier by min(D, lead): never before its
  moment, never more than D before they reached air, and in the same order and spacing. The code's own
  cues (line-ups, panels, fillers) stay where they are.
- A change of delay rebuilds the cue sheet and the desk, so the page reloads at the same moment
  (keeping match, language, view, audience and speed).
- The agents see no more than before. The shift uses only the cue times the replay already holds; Ask
  the studio still answers at the picture's time, so it never tells a viewer about a goal still on its
  way; nothing reads the hidden storylines table.

## What the delay changes, measured

From the exported replays (`web/data/<match>/stories.json`, `cues.json`, `events.json`), with
`node scripts/delay_measures.mjs` (offline, under a second). "On the moment" counts the stories whose
first graphic lands on the picture at their moment: lead at most D.

| match | stories | lead, median / max (s) | on the moment at 0 s | on the moment at 5 s | on the moment at 10 s | on the moment at 15 s | late at 5 s: how late, max (s) |
|---|---|---|---|---|---|---|---|
| M001 | 15 | 2.0 / 6.9 | 4 | 12 | 15 | 15 | 1.9 |
| M002 | 24 | 2.0 / 6.5 | 2 | 21 | 24 | 24 | 1.5 |
| M003 | 16 | 1.5 / 6.0 | 2 | 12 | 16 | 16 | 1.0 |
| M004 | 28 | 5.0 / 12.6 | 3 | 21 | 27 | 28 | 7.6 |
| all | 83 | 2.0 / 12.6 | 11 | 66 | 82 | 83 | 7.6 |

At 5 s the 17 stories still late are 14 big chances (lead 5.0 to 6.0 s), the 2 comebacks (6.9 and
6.5 s) and a pressing spell in M004 (12.6 s); each lands its lead minus 5 s after its moment, at most
7.6 s. At 10 s every story but that pressing spell lands on its moment (it lands 2.6 s after); at
15 s all 83 do.

The replays place each graphic a fixed time after its moment (the regenerations ran with the match
clock not waiting for real time, see MEASURES.md), so these leads are the replay's own. On the
live-speed run in MEASURES.md the two goals reached the director's cue 3.2 and 3.2 s after the shot
and a big chance 8.0 s after it: a 5 s delay would put 2 of those 3 on its moment, 10 s all 3.

The numbers above are also checked by `tests/web/delay.test.mjs`.

## Tests

- `node --test tests/web/delay.test.mjs`: the parameter, a story's moment, the shift on a made-up
  sheet and on all four replays at every delay (sorted, never before the moment, never more than D),
  M001's goals at 10 s, the table above, the reload link and the strings.
- `WEBGL=0 MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh delay.mjs`: M001 in the
  browser at `delay=10` from t=586, the 10' goal's graphic on the picture within 1 s of the shot
  (0.03 s when written), the goal on the desk before the picture reaches it, the tag in English and
  Italian, the menu reloading at the same moment; at `delay=0` the graphic airs at its cue, as before.
