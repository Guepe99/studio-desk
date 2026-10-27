# Watch for: storyline forecasts on the desk

**Tested on simulated matches only.** Every number below comes from matches made by `studiodesk/sim`, the
same generator as the demo matches. Nothing here says how the model would do on real football.

## What the producer sees

The control desk has a **Watch for** panel above the stories (under them on a phone). It starts closed at
every width, one line, and the visitor opens it. While the replay plays, it lists the storylines that could
still happen before full time, each with:

- a word, **Unlikely**, **Possible** or **Likely**, made by code from the facts up to the replay time (no
  model calls; see [On screen: words, not percentages](#on-screen-words-not-percentages));
- a one-line reason from the same facts ("Ostwick trail 2-0, with 1 shot so far.");
- a prepared line from the phrasebook that reads as a whole sentence: the parts code fills from the facts
  when the event happens are plain words, underlined, such as "in the minute it comes", "the new score" or
  "the final score" (the panel's note says so in the language on air);
- a **Pre-approve line** button.

The panel's facts never lag the clock: the export writes a forecast step at every fact the model reads (each
goal and each shot) as well as every match minute, so paused at 7:56 the panel counts the shot of 7:50 whose
graphic is on air.

A pre-approved line goes on air as a why_card at the event's own time (the fact that triggers it), for
6 seconds, so it ends before the agents' own card on the same goal (about 6.3 s after it). A line nobody
pre-approved never airs. Pre-approval is possible only before the event, can be withdrawn, and is logged
in the audit trail with the airing (`prepared_approved`, `prepared_withdrawn`, `prepared_aired`, each with
`detail.prepared = true`). As the generated graphics' decisions, they stay in the browser tab.

The four kinds, each resolved by one fact:

| kind | happens when | trigger fact |
|---|---|---|
| `second_goal` | a player who has scored once scores again, while on the pitch | his `player_goals` fact of 2 |
| `comeback` | a trailing team draws level (once per deficit, as the comeback story) | the `score` fact that levels it |
| `clean_sheet` | a team that has not conceded keeps it to full time | the whistle (off at the opponent's first `score` fact) |
| `late_goal` | a goal from display minute 81 | that `score` fact |

## How other people do it

- Opta's live win probability (The Analyst) simulates the rest of a match thousands of times from team
  quality, the quality of the chances so far, the score, red cards and the time left, expected added
  time included, and shows the result as a percentage that moves with the match.
  https://theanalyst.com/articles/live-win-probability
- Robberechts, Van Haaren and Davis, *A Bayesian Approach to In-Game Win Probability in Soccer* (KDD
  2021), model the goals still to come for each team from the game state and the time left, and judge
  the result by how well calibrated the probabilities are. https://arxiv.org/abs/1906.05029
- The WWRP Joint Working Group on Forecast Verification sets out the standard checks for probability
  forecasts: the Brier score (mean squared error of the probabilities), the Brier skill score against a
  reference forecast (1 minus the ratio of the two scores, 0 means no better than the reference) and the
  reliability diagram (observed frequency against forecast probability, per bin, with the counts).
  https://jwgfvr.github.io/forecastverification

We follow the same shape, scaled down: goals still to come as Poisson counts per team from the score and
the time left, and the forecasts checked with the Brier score against a naive forecast and a reliability
table.

## The model (`studiodesk/forecast.py`)

Each team scores as a Poisson process. Its rate per minute is
`r = (K * rate0 + per_shot * shots) / (K + minutes played)`, a base rate blended with the team's own
shots (the `team_shots` facts; the ledger has no xG fact). The rate is scaled by the stage of the match
(six 15-minute blocks, stoppage time in the last block of each half), and by `chase` while the team
trails. Expected goals left = rate times the weighted minutes to the expected end of the match. Period
lengths are not known live, so the model uses the mean lengths of the calibration set; the real first
half length is used once it is over.

- `second_goal`: 1 - exp(-scorer_share x the team's expected goals left).
- `comeback`: P(trailing team's goals - leader's goals >= deficit), two independent Poisson counts.
- `clean_sheet`: exp(-the opponent's expected goals left).
- `late_goal`: 1 - exp(-late x both teams' expected goals from minute 81).

At replay time `t` it reads only the facts with `ts <= t` (a test compares the forecasts of a match cut
at `t` with the full match). Each forecast lists the fact ids it was built from.

## Calibration

`scripts/forecast_calibrate.py` simulates two separate sets of 400 matches (seed 11 for the fit set,
seed 12 for the test set: another league and other matches, half of each with a planted comeback as in
the demo build). The rates and the stage weights are counted on the fit set; `K`, `chase`, the
scorer share's scale and `late` are picked on the fit set by the lowest Brier score over a small grid.
The test set is scored every 5 minutes of play: each open forecast against how it ended. The naive
forecast is each kind's event rate in the fit set.

Fitted parameters (in `studiodesk/forecast_params.json`): rate0 0.0146 goals a minute per team,
stage weights 0.46, 1.19, 0.96 (first half) and 1.37, 1.43, 0.65 (second half), scorer share 0.21,
chase 2.0, late 0.5, mean halves 46.1 and 47.0 minutes, and `K` at its largest value: the fit ignores
the shots.

### Test set: Brier score

| kind | forecasts | matches | event rate (fit set) | Brier, model | Brier, naive | skill |
|---|---|---|---|---|---|---|
| second_goal | 6344 | 382 | 0.093 | 0.0809 | 0.0854 | +0.052 |
| comeback | 3819 | 383 | 0.496 | 0.1928 | 0.2498 | +0.228 |
| clean_sheet | 7594 | 400 | 0.285 | 0.1756 | 0.2117 | +0.170 |
| late_goal | 7113 | 400 | 0.138 | 0.1170 | 0.1183 | +0.011 |

Lower Brier is better; skill is 1 - model / naive. A forecast is counted at every 5-minute step it is
open, so the forecasts of one match are not independent: the match counts are the honest sample size.

### Test set: reliability

| kind | forecast | n | mean forecast | observed |
|---|---|---|---|---|
| second_goal | 0.0-0.1 | 3522 | 0.045 | 0.046 |
| second_goal | 0.1-0.2 | 2329 | 0.148 | 0.136 |
| second_goal | 0.2-0.3 | 486 | 0.218 | 0.243 |
| second_goal | 0.3-0.4 | 7 | 0.327 | 0.286 |
| comeback | 0.0-0.1 | 593 | 0.034 | 0.024 |
| comeback | 0.1-0.2 | 414 | 0.157 | 0.138 |
| comeback | 0.2-0.3 | 380 | 0.249 | 0.332 |
| comeback | 0.3-0.4 | 428 | 0.343 | 0.526 |
| comeback | 0.4-0.5 | 420 | 0.444 | 0.590 |
| comeback | 0.5-0.6 | 1091 | 0.554 | 0.711 |
| comeback | 0.6-0.7 | 493 | 0.624 | 0.716 |
| clean_sheet | 0.0-0.1 | 211 | 0.088 | 0.246 |
| clean_sheet | 0.1-0.2 | 874 | 0.151 | 0.220 |
| clean_sheet | 0.2-0.3 | 2884 | 0.265 | 0.183 |
| clean_sheet | 0.3-0.4 | 2058 | 0.344 | 0.240 |
| clean_sheet | 0.4-0.5 | 563 | 0.448 | 0.435 |
| clean_sheet | 0.5-0.6 | 275 | 0.552 | 0.589 |
| clean_sheet | 0.6-0.7 | 195 | 0.659 | 0.744 |
| clean_sheet | 0.7-0.8 | 193 | 0.758 | 0.824 |
| clean_sheet | 0.8-0.9 | 179 | 0.856 | 0.933 |
| clean_sheet | 0.9-1.0 | 162 | 0.944 | 0.994 |
| late_goal | 0.0-0.1 | 494 | 0.049 | 0.024 |
| late_goal | 0.1-0.2 | 6619 | 0.132 | 0.145 |

### What the numbers say

- Second goal is well calibrated but rarely confident: the model never goes far from the base rate.
- Comeback has the most skill, and is too low from 0.3 to 0.6: one `chase` factor serves all four kinds,
  and comebacks would want a larger one than clean sheets.
- Clean sheet is too high in the middle and too low at the bottom: the same `chase` compromise.
- Late goal is barely better than the naive forecast. The simulator plants goals between 3% and 88% of
  the playing time, so goals after minute 81 are rare and do not depend on what happened before.
- The shots carry no signal in the simulator, which decides the goals before the match is played, so
  the fit ignores them. On real data they would matter, and the same script would refit them.
- Half the simulated matches have a planted comeback, so the comeback and clean sheet probabilities are
  far from real football (a 2-0 deficit at 13' gives a 44% comeback). They are calibrated to the
  simulator, which is what the replays are made from. That is why the panel shows words, not these numbers.

## On screen: words, not percentages

A producer reads "Comeback 65%" for a side 1-0 down at 10' as a claim about football, and in real football
it is wrong. So the panel shows no percentage, only a word, and the probability behind it stays in
`forecast.json` and in the MCP tool for anyone who wants to check it. `forecast.level()` makes the word:

1. **Shift to real football.** For the two kinds the simulator gets most wrong, the model's odds are moved
   from the simulator's event rate (the `base_rate` in `forecast_params.json`) to a real-football rate, the
   standard correction for a model trained on other base rates (Saerens, Latinne and Decaestecker, *Adjusting
   the outputs of a classifier to new a priori probabilities*, Neural Computation 14(1), 2002):
   - `comeback`, real rate 0.29: the team that scores first wins 71.1% of Premier League matches (CIES
     Football Observatory, 2015 to 2019, https://football-observatory.com/IMG/sites/b5wp/2019/wp293/en/),
     so the side that concedes first draws level at some point in at least 29% of them (a lower bound: a
     side that wins after being pegged back counts among the 71.1%);
   - `late_goal`, real rate 0.40: 18% of Premier League goals in 2024/25 came from the 80th minute on, one
     minute earlier than the kind counts (the Premier League, in an article on the 2025/26 season that gives
     the 2024/25 figures,
     https://www.premierleague.com/en/news/4430518/more-late-goals-and-stoppage-time-winners-being-scored-in-2025-26),
     and 95 added-time goals were 8.5% of the total, about 2.9 goals a match, so about 0.53 late goals a match
     and at least one in 1 - e^-0.53, about 41%.

   `second_goal` and `clean_sheet` are left as they are: their simulator rates are near real football, or
   the model is already low (a second goal is at most 0.33).
2. **Three words, the IPCC likelihood scale** (Mastrandrea et al., *Guidance Note for Lead Authors of the
   IPCC Fifth Assessment Report on Consistent Treatment of Uncertainties*, 2010,
   https://www.ipcc.ch/site/assets/uploads/2017/08/AR5_Uncertainty_Guidance_Note.pdf): **Unlikely** below
   1/3, **Possible** from 1/3 ("about as likely as not"), **Likely** from 2/3.

What it gives: a side 1-0 down at 10' reads Possible (the model's 0.65 becomes 0.44), 2-0 down at 41' reads
Unlikely (0.32 becomes 0.16), a late goal reads Possible for most of the match, and a team that has not
conceded by minute 90 reads Likely to keep a clean sheet. A comeback never reads Likely on the four replays.
`test_words_are_honest_for_real_football` holds these cases.

The shift is coarse: the simulator's rate is counted over every 5-minute step a forecast is open, the real
rates per match, and the real rates are league averages that ignore the teams. The words are honest about
how often such a thing happens in real football, no more.

## Where it lives

| piece | file |
|---|---|
| model, words, export | `studiodesk/forecast.py`, parameters in `studiodesk/forecast_params.json` |
| calibration | `scripts/forecast_calibrate.py`, results in `data/forecast.sqlite` (git-ignored) |
| replay export | `web/data/<match>/forecast.json`, written by `studiodesk/export.py` (and `python -m studiodesk.forecast M001 ...`) |
| MCP tool | `get_forecasts(match_id, ts=None)` in `studiodesk/mcp_server.py` |
| panel | `web/js/forecast.js`, `web/css/forecast.css`, strings in `web/js/desk.js` (`w_*`, `a_prepared_*`, `y_prepared_*`) |
| tests | `tests/test_forecast.py`, `tests/web/forecast.test.mjs`, `tests/web/forecast.mjs` (browser, M001) |

Season facts (feat/season): `forecast.EXTRA_KINDS` takes functions `(game, ts, params) -> items` for
milestone kinds (a player's 10th goal of the season from his season tally and the second_goal rate);
each new kind also needs its branch in `resolve()`, a title and a template.

## How to reproduce

    scripts/with-lock.sh build .venv/bin/python scripts/forecast_calibrate.py --fit 400 --test 400 --seed 11
    .venv/bin/python -m studiodesk.forecast M001 M002 M003 M004
    .venv/bin/pytest -q tests/test_forecast.py
    node --test tests/web/forecast.test.mjs
    WEBGL=0 scripts/with-lock.sh chromium tests/web/run-smoke.sh forecast.mjs

The calibration takes about 4 minutes on this machine (run it detached if the build lock is busy). It
writes `studiodesk/forecast_params.json` and adds a run to `data/forecast.sqlite` (tables
`forecast_runs`, `forecast_samples`, `forecast_scores`, `forecast_reliability`). The same seed gives the
same numbers (`test_calibration_is_reproducible`).
