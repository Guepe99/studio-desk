# Measures

What the system did on the 4 replay matches (M001, M002, M003, M004), computed by
`scripts/measures.py` from the committed AI packs (`replays/<match>/stories.json`) and the runtime
databases of the run that made them (`out/runtime11-<match>.sqlite`, traces and audit). Rerun the
script after a regeneration; every number below comes from it.

| match | storylines found | numbers blocked | names blocked | on air: phrasebook / template / AI | proposals on the desk | model calls | tokens in / out | cost (USD) | round, median / max (s) | model time per match minute (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| M001 | 3 of 4 | 6 | 0 | 16 / 0 / 0 | 15 | 108 | 210,275 / 17,659 | 0.063 | 18.7 / 31.5 | 2.5 |
| M002 | 4 of 4 | 2 | 0 | 24 / 0 / 0 | 21 | 151 | 295,840 / 22,083 | 0.080 | 16.6 / 24.0 | 3.4 |
| M003 | 2 of 3 | 1 | 0 | 17 / 0 / 0 | 17 | 99 | 188,808 / 15,755 | 0.055 | 13.5 / 24.3 | 2.3 |
| M004 | 2 of 3 | 2 | 0 | 27 / 0 / 0 | 20 | 167 | 317,361 / 23,583 | 0.085 | 14.6 / 26.8 | 3.6 |
| all | 11 of 14 | 11 | 0 | 84 / 0 / 0 | 73 | 525 | 1,012,284 / 79,080 | 0.283 | | 3.0 |

## Hidden storylines found

The simulator plants storylines the agents are never shown (a tactical shift, a spell of high
pressing, a top sprint, a comeback). The agents found 11 of the 14 planted, with the
rule of `scripts/eval_stories.py`: a story of the matching kind, for the same team and player,
within 60 seconds of the storyline. Only this evaluation reads the hidden table.

## Numbers and names blocked by the verifier

Counted from the verifier's notes on each story: one count is one draft (a story in one language)
whose earlier versions the verifier sent back, or dropped, because of a number (not in the fact
ledger, written in words, wrong unit, a formation the facts do not give). 11 drafts were
blocked for a number and 0 for a real person's or club's name. A draft rewritten twice for the
same reason counts once, so these are lower bounds.

## Phrasebook on air, proposals on the desk

Every one of the 84 stories went on air with code-written text: 84 from the
commentator phrasebook, 0 from the fact-only template, 0 with the AI's own line. In
73 stories the AI's line passed every check in all three languages and waits on the desk as
a proposal; it goes on air only when a person edits the story.

## Tokens and cost

525 model calls used 1,012,284 input and 79,080 output tokens, $0.283 in all
($0.071 a match), counted from the audit table, one row per model call. The traces
add up to 1.54 times as many tokens ($0.379): the three commentators run at the
same time and each trace takes the difference of a shared counter, so it also counts the calls of the
others. The audit is the figure to quote; the traces need fixing. The Content Safety checks (one call per story,
84 in all) are recorded in neither table and are not counted.

## Delay from event to graphic

Not measured. The regenerations ran with `--speed 0`, so the match clock did not wait for real
time, and the replay places each graphic at its story's moment in the match, not where the round
ended. What the traces do measure:
a round (story finder, analyst, three commentators, verifier, rewrites, director) took
15.2 seconds of wall time at the median, at most 31.5 seconds; the 57 rounds took 2.5 seconds of wall time per minute
of match. Model calls added up to 3.0 seconds per minute of match (calls in
parallel counted each). Before a round starts, the desk waits for its trigger: the story's event
was a median of 0.9 seconds of match time before its round (goals at most
0.9 seconds, other stories batched for up to 5.0 minutes). At 1x a graphic would come
roughly that wait plus the round after its event; no 1x run has measured it.
