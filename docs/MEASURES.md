# Measures

What the system did on the 4 replay matches (M001, M002, M003, M004), computed by
`scripts/measures.py` from the committed AI packs (`replays/<match>/stories.json`) and the runtime
databases of the run that made them (`out/runtime12-<match>.sqlite`, traces and audit). Rerun the
script after a regeneration; every number below comes from it.

| match | storylines found | numbers blocked | names blocked | on air: phrasebook / template / AI | proposals on the desk | model calls | tokens in / out | cost (USD) | round, median / max (s) | model time per match minute (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| M001 | 3 of 4 | 2 | 0 | 14 / 0 / 0 | 8 | 101 | 194,406 / 15,442 | 0.056 | 18.3 / 23.7 | 2.3 |
| M002 | 4 of 4 | 4 | 0 | 24 / 0 / 0 | 16 | 155 | 308,008 / 24,024 | 0.085 | 16.3 / 27.8 | 3.5 |
| M003 | 2 of 3 | 0 | 0 | 16 / 0 / 0 | 15 | 97 | 187,624 / 15,200 | 0.054 | 11.8 / 29.4 | 2.3 |
| M004 | 2 of 3 | 1 | 0 | 27 / 0 / 0 | 19 | 166 | 311,464 / 23,233 | 0.083 | 15.7 / 28.2 | 3.6 |
| all | 11 of 14 | 7 | 0 | 81 / 0 / 0 | 58 | 519 | 1,001,502 / 77,899 | 0.277 | | 2.9 |

## Hidden storylines found

The simulator plants storylines the agents are never shown (a tactical shift, a spell of high
pressing, a top sprint, a comeback). The agents found 11 of the 14 planted, with the
rule of `scripts/eval_stories.py`: a story of the matching kind, for the same team (and the same
player, when the storyline names one), within 60 seconds of the storyline. Only this evaluation reads the hidden table.

## Numbers and names blocked by the verifier

Counted from the verifier's notes on each story: one count is one draft (a story in one language)
whose earlier versions the verifier sent back, or dropped, because of a number (not in the fact
ledger, written in words, with the wrong unit or letters stuck to it, a formation the facts do not
give). Spacing slips and fact ids from another moment are not counted. 7 drafts were
blocked for a number and 0 for a real person's or club's name. A draft rewritten twice for the
same reason counts once, so these are lower bounds.

## Phrasebook on air, proposals on the desk

Every one of the 81 stories went on air with code-written text: 81 from the
commentator phrasebook, 0 from the fact-only template, 0 with the AI's own line. In
58 stories the AI's line passed every check in all three languages and waits on the desk as
a proposal; it goes on air only when a person edits the story.

## Tokens and cost

519 model calls used 1,001,502 input and 77,899 output tokens, $0.277 in all
($0.069 a match), counted from the audit table, one row per model call. The traces of the agent steps add up to the same tokens.
The Content Safety checks (one call per story,
81 in all) are recorded in neither table and are not counted.

## Delay from event to graphic

Measured on a real-speed run (`python -m studiodesk.agents run M001 --speed 1 --from-ts
300 --to-ts 1200`): M001 from minute 5 to minute
20, on Azure, the way the desk runs live. The 2 goals reached the director's cue 15.7 and 19.9 seconds after the shot; the other story after 149.6 seconds, because a story that is not urgent waits on purpose for the end of its window to be told with the others. These are upper bounds: they
count from when the program was launched, and its start-up before the match clock began took at least
1.2 seconds. A story that needs a producer then waits for one; a story the director lets
air by itself is on screen at that moment.

The regenerations behind the replays ran with `--speed 0`, so the match clock did not wait for
real time, and the replay places each graphic at its story's moment in the match, not where the
round ended. What their traces measure:
a round (story finder, analyst, three commentators, verifier, rewrites, director) took
15.8 seconds of wall time at the median, at most 29.4 seconds; the 57 rounds took 2.5 seconds of wall time per minute
of match. Model calls added up to 2.9 seconds per minute of match (calls in
parallel counted each). Before a round starts, the workflow waits for its trigger: the story's event
was a median of 0.9 seconds of match time before its round (goals at most
0.9 seconds, other stories batched for up to 5.0 minutes).
