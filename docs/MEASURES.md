# Measures

What the system did on the 4 replay matches (M001, M002, M003, M004), computed by
`scripts/measures.py` from the committed AI packs (`replays/<match>/stories.json`) and the runtime
databases of the run that made them (`out/runtime15-<match>.sqlite`, traces and audit). Rerun the
script after a regeneration; every number below comes from it.

| match | storylines found | numbers blocked | names blocked | on air: phrasebook / template / AI | proposals on the desk | model calls | tokens in / out | cost (USD) | round, median / max (s) | model time per match minute (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| M001 | 3 of 4 | 1 | 0 | 15 / 0 / 0 | 14 | 132 | 237,248 / 17,030 | 0.063 | 16.6 / 32.1 | 3.3 |
| M002 | 4 of 4 | 2 | 0 | 24 / 0 / 0 | 21 | 210 | 375,275 / 25,467 | 0.095 | 15.7 / 34.1 | 5.2 |
| M003 | 2 of 3 | 1 | 0 | 16 / 0 / 0 | 13 | 121 | 219,293 / 16,643 | 0.060 | 15.3 / 27.9 | 3.0 |
| M004 | 2 of 3 | 1 | 0 | 28 / 0 / 0 | 19 | 229 | 402,181 / 28,181 | 0.102 | 17.5 / 33.0 | 5.8 |
| all | 11 of 14 | 5 | 0 | 83 / 0 / 0 | 67 | 692 | 1,233,997 / 87,321 | 0.319 | | 4.3 |

## Hidden storylines found

The simulator plants storylines the agents are never shown (a tactical shift, a spell of high
pressing, a top sprint, a comeback). The agents found 11 of the 14 planted, with the
rule of `scripts/eval_stories.py`: a story of the matching kind, for the same team (and the same
player, when the storyline names one), within 60 seconds of the storyline. Only this evaluation reads the hidden table.

## Numbers and names blocked by the verifier

Counted from the verifier's notes on each story: one count is one draft (a story in one language)
whose earlier versions the verifier sent back, or dropped, because of a number (not in the fact
ledger, written in words, with the wrong unit or letters stuck to it, a formation the facts do not
give). Spacing slips and fact ids from another moment are not counted. 5 drafts were
blocked for a number and 0 for a real person's or club's name. A draft rewritten twice for the
same reason counts once, so these are lower bounds.

## Phrasebook on air, proposals on the desk

Every one of the 83 stories went on air with code-written text: 83 from the
commentator phrasebook, 0 from the fact-only template, 0 with the AI's own line. In
67 stories the AI's line passed every check in all three languages and waits on the desk as
a proposal; it goes on air only when the producer presses **Use proposal** or edits the story.

## Tokens and cost

692 model calls used 1,233,997 input and 87,321 output tokens, $0.319 in all
($0.080 a match), counted from the audit table, one row per model call. The traces of the agent steps add up to the same tokens.
The desk's audit log reads the replay's traces, one row per agent step, so it shows 624 agent steps
that used the model: a step can call it more than once (the verifier checks the texts again after a
rewrite).
The Content Safety checks (one call per story,
83 in all) are recorded in neither table and are not counted.

## What the agents add over the rules alone

The committed AI run against the same workflow with the model off: every call fails, so each agent
falls back to its written rules (the story finder keeps the must-tell candidates, goals, comebacks and
recaps, and the first other one; the analyst falls back to the facts; the commentators to the phrasebook and the
fact-only template). The model-off run uses today's code and no Content Safety; it costs nothing and
reproduces with `.venv/bin/python scripts/measures.py` (offline, about a minute a match).

| match | storylines found, agents / rules | stories, agents / rules | AI proposals on the desk, agents / rules |
|---|---|---|---|
| M001 | 3 / 3 of 4 | 15 / 15 | 14 / 0 |
| M002 | 4 / 4 of 4 | 24 / 24 | 21 / 0 |
| M003 | 2 / 1 of 3 | 16 / 15 | 13 / 0 |
| M004 | 2 / 1 of 3 | 28 / 27 | 19 / 0 |
| all | 11 / 9 of 14 | 83 / 81 | 67 / 0 |

With the model the agents found 11 of the 14 hidden storylines and wrote 83 stories; with
the rules alone, 9 and 81. The
commentators' lines passed every check in 67 stories and wait on the desk as proposals; with the
model off there are 0. Either way, what goes on air is code-written text.

## Delay from event to graphic

Measured on a real-speed run (`python -m studiodesk.agents run M001 --speed 1 --from-ts
300 --to-ts 1200`): M001 from minute 5 to minute
20, on Azure, the way the desk runs live. The 2 goals reached the director's cue 3.7 and 5.6 seconds after the shot; the big chance after 9.7 seconds, judged once the play had settled for a few seconds. These are upper bounds: they
count from the second the workflow began, as its run id records it, before the match clock started; the
program's start-up before that, 13.5 seconds, is left out. A story that needs a producer then waits for one; a story the director lets
air by itself is on screen at that moment.

The regenerations behind the replays ran with `--speed 0`, so the match clock did not wait for
real time, and the replay places each graphic at its story's moment in the match, not where the
round ended. What their traces measure:
a round (story finder, director, analyst, three commentators, verifier, rewrites) took
16.7 seconds of wall time at the median, at most 34.1 seconds; the 77 rounds took 3.6 seconds of wall time per minute
of match. Model calls added up to 4.3 seconds per minute of match (calls in
parallel counted each). Before a round starts, the workflow waits for its trigger: the story's event
was a median of 0.9 seconds of match time before its round (goals at most
0.9 seconds, other stories at most 5.5 seconds).

## Foundry evaluators

Computed by `scripts/foundry_evals.py` on 2026-10-21, not by `scripts/measures.py` (which keeps this section
when it rewrites the page). The on-air text of each story was scored by four of Microsoft Foundry's built-in
evaluators, with gpt-5-mini as the judge, through the Agent Framework's `FoundryEvals` on the Foundry project
`studiodesk`: all 249 items, every story of the 4 replay packs (M001, M002, M003, M004) in English, Italian and Spanish, one eval run per language. Each item gives the judge a neutral request ("Write the
on-screen line, in Italian, for this moment of the match for a TV audience", with the kind of moment), the
text that went on air, and, for groundedness, the facts the story cites from the ledger written out as plain
sentences (value, unit, what it measures, who, minute), the score at that moment and the events it cites (for
a story that cites more than 5 events, only its shots). Scores run from 1 to 5; an item passes at
3 or more, the evaluators' default threshold.

| evaluator | English: mean, passed | Italian: mean, passed | Spanish: mean, passed | all languages: mean, passed |
|---|---|---|---|---|
| groundedness | 4.54, 80 of 83 | 4.77, 83 of 83 | 4.60, 80 of 83 | 4.64, 243 of 249 |
| relevance | 4.12, 83 of 83 | 4.28, 83 of 83 | 4.29, 83 of 83 | 4.23, 249 of 249 |
| coherence | 4.13, 83 of 83 | 4.51, 83 of 83 | 4.45, 83 of 83 | 4.36, 249 of 249 |
| fluency | 3.42, 83 of 83 | 3.41, 83 of 83 | 3.58, 83 of 83 | 3.47, 249 of 249 |

Not passed: M001 S-000003 (goal, English, groundedness 2); M001 S-000013 (goal, English, groundedness 2); M001 S-000013 (goal, Spanish, groundedness 2); M002 S-000017 (goal, English, groundedness 2); M004 S-000018 (big chance, Spanish, groundedness 2); M004 S-000022 (tactical shift, Spanish, groundedness 2). The judge's reason for each is in the table named at the end of this section. 0 of 996 scores came back empty (the judge failed on that item); they count as not
passed. The judge's calls used 1,396,853 input and 488,787 output tokens, about $1.327 at the gpt-5-mini price in
`studiodesk/config.py`, as the eval runs report them. Per-item scores, pass flags and the judge's reasons are
in `out/foundry-evals.sqlite`, table `foundry_evals` (git-ignored): one row per story, language and evaluator,
with the run time, the Foundry eval and run ids, the match, story, kind, language, evaluator, score, passed,
reason and tokens in and out.
