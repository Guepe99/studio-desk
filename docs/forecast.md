# Watch for: storyline forecasts on the desk

**Tested on simulated matches only.** Every number below comes from matches made by `studiodesk/sim`, the
same generator as the demo matches. Nothing here says how the model would do on real football.

## What the producer sees

The control desk has a **Watch for** panel above the stories. While the replay plays, it lists the
storylines that could still happen before full time, each with:

- its probability, made by code from the facts up to the replay time (no model calls);
- a one-line reason from the same facts ("Ostwick trail 2-0, with 1 shot so far.");
- a prepared line from the phrasebook, with open slots for the minute and the score, which code fills
  from the facts when the event happens;
- a **Pre-approve line** button.

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
  simulator, which is what the replays are made from.

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
