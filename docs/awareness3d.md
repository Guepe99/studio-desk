# Players who read the play in the 3D view

`web/js/awareness.js` decides, for every player and every moment of the stretch the 3D sample
shows, where he looks, which way his chest faces, how his legs move and which emotion he shows.
`web/js/awareness-rig.js` puts that on the Quaternius mannequins. Like the ball layer
(`docs/ball3d.md`) it is a visual layer only: positions stay the tracking's, and the simulator,
the facts, the 2D page and the export do not change.

Turn it off with `sample3d.html?aware=0` to compare.

## The problem, measured on M001

The owner's complaint: defenders seem to watch another ball and nobody shows any emotion.
`scripts/defence_reaction.py M001` measures whether the defending team in the export reacts to
the ball. Every number is computed twice: on the real tracking, and on a control where the ball
is taken from five minutes later. A team that reacts shows a clear gap between the two.

| Measure (M001, seed 7) | Real ball | Control |
|---|---|---|
| Nearest defender to the carrier, median | 4.28 m | 8.39 m |
| Share of carrier frames with a defender within 5 m | 57% | 27% |
| Block shift: slope of defending centroid y on ball y | 0.29 (corr 0.72) | 0.02 (corr 0.05) |
| Line height: slope of back-four depth on ball depth | 0.51 (corr 0.77) | -0.02 (corr -0.04) |
| Lag of the block shift behind the ball | 2.0 s | |
| Attack runs (carrier over 3 m/s at goal, inside 35 m): nearest defender, median | 1.86 m | 11.46 m |
| Same, nearest defender's speed towards the carrier (below 0: drops off) | -1.18 m/s | |
| Defenders within 15 m of the ball moving over 0.7 m/s: travelling within 30 deg of the ball direction | 27% | 17% |
| Same, travelling more than 90 deg away from the ball | 37% | 49% |

What this says:

- **The defending team does react to the ball.** Positions follow it clearly (correlations
  0.72 and 0.77 against about 0 for the control), and someone closes the carrier.
- **What looked wrong was the bodies, not the positions.** The 3D players faced their direction
  of travel, and 37% of the defenders near the ball travel more than 90 deg away from it (they
  drop off, cover, recover), so more than a third of them showed their back to the ball. On DEMO,
  before this layer, 43% of the player-frames near the play had their back to the ball and only
  21% had the head within 30 deg of it.
- **Simulator notes, not changed here** (`studiodesk/sim/`): the block shifts with a slope of 0.29
  where coaching material describes a back four shuffling across as one unit (F13), and with a
  2.0 s lag (`shape_lag_s` is 2.5); the closing defender targets 3.5 m goal-side and on attack
  runs drops off at 1.2 m/s instead of engaging; after a goal nobody converges on the scorer (0
  teammates within 10 m of him) and every player keeps running at match pace. These are the
  biggest remaining sources of "fake" and only the simulator can fix them.

## Research

Researched 18/10/2026; every URL was opened. Tags: [M] measured in a study, [C] coaching practice,
[D] developer or engine documentation, [J] my judgement.

Head, eyes and scanning

- F1 [M] Cervical rotation in 300 healthy young adults: 71.1 ± 10.5 deg right, 70.2 ± 9.7 deg
  left; flexion 57.7 deg, extension 59.1 deg.
  https://openaccess.iku.edu.tr/entities/publication/1d43fa73-7df0-4c7f-b388-43469591b92b/full
- F2 [M] Eye-in-head range about ±40 deg; the head joins a gaze shift from 20-25 deg; the saccade
  starts 25-40 ms before the head. https://pmc.ncbi.nlm.nih.gov/articles/PMC2605952
- F3 [M] Head share of a gaze shift, 80 people: 5-15 deg of head for a 20 deg shift, about 38 deg
  for 50 deg; head/target ratio about 0.5. https://arxiv.org/html/2602.06164v1
- F4 [M] Saccade latency to an unexpected stimulus about 200 ms. https://en.wikipedia.org/wiki/Saccade
- F5 Head turn speed: a peak of about 350 deg/s (Röijezon et al. 2010) was behind a login and is
  unverified; F8 uses 125 deg/s as the threshold that defines a head turn.
- F6 [M] Jordet et al. 2020, 27 Premier League players: 0.44 scans/s on average, over 0.6 around
  the own box, under 0.3 near the touchline in the attacking third; central midfielders scan
  most, forwards least. https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2020.553813/full
- F7 [M] PlayerCam: elite midfielders 0.61-0.83 scans/s.
  https://www.skysports.com/football/news/11096/11119387/what-gave-xavi-hernandez-and-andrea-pirlo-an-edge-on-the-rest-the-secret-to-his-vision
- F8 [M] Head IMU, 32 players: 0.95 head turns/s over the last 10 s before receiving, 1.44/s in the
  last second. https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2018.02520/full
- F9 [M] Eye tracking, 869 scans: duration mean 0.40 s, median 0.34 s.
  https://pmc.ncbi.nlm.nih.gov/articles/PMC8378692
- F10 [D] Unreal Look At node: bone, target, per-axis clamp, interpolation time.
  https://dev.epicgames.com/documentation/en-us/unreal-engine/animation-blueprint-head-look-at-in-unreal-engine

Defender orientation, jockeying, backpedal

- F11 [C] 1v1: close fast, brake about 2 yards out, then jockey side-on at about 45 deg, never
  square, showing the touchline. https://www.icoachfootball.net/1v1-defending-drills-jockeying/
- F12 [C] Side-on, back foot in line with the ball, weight back, move when the ball moves.
  https://www.sportsessionplanner.com/s/YMzZ/Defending-Principles---1v1.html
- F13 [C] Back four 6-8 m apart, shuffling across as one unit, oriented to keep sight of the
  attackers. https://fifatrainingcentre.com/en/practice/elite-sessions/out-of-possession/defending-with-a-back-four.php
- F14 [M] Premier League time-motion: defenders move backwards and sideways more than any other
  position. https://www.jssm.org/jssm-06-63.xml-Fulltext
- F15 [M] Top backward running speed 5.1 m/s, 70% of forward.
  https://pages.uoregon.edu/btbates/backward/alan2.htm
- F16 [D] FIFA 23: jockeying players turn at many angles; decelerating into a jockey takes more
  steps. https://www.ea.com/ea-play/news/pitch-notes-fifa-23-gameplay-deep-dive

Open body shape

- F17 [C] The receiver's body orientation sets the first touch; check the shoulder before
  receiving. https://www.fifatrainingcentre.com/en/practice/elite-sessions/in-possession/directing-the-ball-with-the-first-touch.php
- F18 [C] "Body shape to receive", "angle and distance" of support, no numbers.
  https://sportsessionplanner.com/s/N4rlb/receiving-with-an-open-body-shape.html
- F19 [M, proprietary tracking] 11.0% of Premier League receptions open the body during the pass,
  9.9% close it. https://www.blog.fc.pff.com/blog/receiving-turn-xlp
- F20 [M] Body orientation from broadcast video has a median error of 27 deg; tracking gives
  positions only. https://arxiv.org/abs/2003.00943v1

Pointing, calling, appeals

- F21 [M] World Cup 2022, 143 players, 18,031 arm behaviours: tactical gestures 2.03 per player per
  minute (centre backs 3.05), emotional 0.73 (negative 0.45, positive 0.23). Tactical: asking for
  the ball, pointing where to stand, influencing the referee (arm up, palms up).
  https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2025.1699943/full

Celebrations, dejection, near misses, keeper

- F23 [M] 366 Champions League goals: celebration 24.9 ± 10.2 s; team movements in 90.4%,
  outstretched arms 33.6%, fist 29.8%, pointing at the passer 8.5%.
  https://pmc.ncbi.nlm.nih.gov/articles/PMC7494092/
- F24 [M, tracking blog] MLS: teammates run to the scorer at a median top speed of 6.6 m/s over
  41-46 m; the goalkeeper stays.
  https://www.americansocceranalysis.com/home/2021/8/12/were-gonna-celebrate-and-have-a-good-time
- F25 [M] Penalty shootouts: both-arms celebrations go with winning.
  https://www.sciencedaily.com/releases/2010/06/100624091745.htm
- F26 [M] Judo winners and losers, blind and sighted: winners raise arms and head, losers slump
  the shoulders and narrow the chest.
  https://www.nationalgeographic.com/science/article/blind-olympic-athletes-show-the-universal-nature-of-pride-and-shame
- F27 [expert opinion] Hands on head after a miss: a near-universal reaction, no frequency or
  duration published.
  https://graphic.com.gh/sports/sports-news/why-do-footballers-put-their-hands-on-their-heads-when-they-miss-shots-or-lose-matches.html
- F28 [M] Observers tell leading from trailing athletes from 3 s silent clips.
  https://bps.org.uk/research-digest/no-need-look-score-athletes-body-language-gives-away-whos-winning-and-losing
- F29 [C] Free kick: the keeper lines up the wall from the near post, then moves to the uncovered
  side. https://www.soccercoachweekly.net/drills-and-games/drills/soccer-coaching-tips-to-build-a-defensive-wall

How games layer it

- F30, F31 [D] Motion matching (Ubisoft): pick the clip frame that matches the pose and future path.
  https://gdcvault.com/play/1022985/Motion-Matching-and-The-Road ,
  https://www.ubisoft.com/en-us/studio/laforge/news/6xXL85Q3bF2vEj76xmnmIu/introducing-learned-motion-matching
- F35 [D] Lyra: four strafe directions, orientation warping, upper/lower body split per bone.
  https://dev.epicgames.com/documentation/unreal-engine/animation-in-lyra-sample-game-in-unreal-engine
- F37 [D] Blend masks: per-bone 0-1 weights for an upper-body layer.
  https://dev.epicgames.com/documentation/en-us/unreal-engine/blend-masks-and-blend-profiles-in-unreal-engine

Not found as numbers: the distance at which a defender turns to face the carrier, the angle at
which FIFA or eFootball switch to a backpedal, and the duration of dejection, appeals and hands on
head.

## Rules in the code

The numbers in `web/js/awareness.js` carry these rule numbers.

| Rule | What | Value | From |
|---|---|---|---|
| R1 | Neck range around the chest | head yaw 70 deg each side, the upper spine adds 20 (90 in all); pitch 40 down, 30 up | F1 (J for the spine share) |
| R2 | Head smoothing and speed | critically damped, tau 0.1 s; top speed 400 deg/s | F5, F10 (J) |
| R3 | Reaction delay | the head follows the ball 180 ± 50 ms late, different per player | F2, F4 |
| R4 | Scans away from the ball | per second: DF 0.44, MF 0.6, FW 0.3, GK 0; 0.35 s each; none while a pass travels to the player, none for a defender within 10 m of the ball | F6, F8, F9 |
| R5 | Defenders face the ball | full weight within 15 m, fading to none at 25 m | F13 (distances J) |
| R6 | Body turn and gait | chest spring tau 0.25 s; gait from the chest/run angle, forward under 60 deg, strafe 60-120, backpedal over 120, 10 deg hysteresis, kept at least 0.5 s | F35 (J) |
| R7 | No fast backpedal | backwards faster than 4.5 m/s, or beaten by the carrier: turn and run | F15 |
| R8 | Closing defender jockeys | within 3.5 m of the carrier and under 3.5 m/s: side-on, 35 deg off the carrier towards the nearer touchline | F11, F12 |
| R9 | Open body | an attacker under 3 m/s within 30 m of the ball keeps it within 45 deg of the chest, chest turned towards the goal he attacks | F17-F19 |
| R10 | Scorer | arms up from goal + 0.3 s, 9 s | F23, F25, F26 |
| R11 | Teammates | nearest first, from goal + 0.5 s, 0.12 s apart, arms up, fist (Yes) or clap, facing the scorer; the keeper a fist; the nearest outfield team-mate (within 30 m) sprints over from 0.3 s before the goal, his track plus an offset to 1 m beside the scorer at about 7.5 m/s over the gap, stepping round whoever is in his way, joining in on arrival, held 8 s, eased back over 4 s | F23, F24 |
| R12 | Conceding side | from their own goal outwards, from goal + 0.35 s, 0.07 s apart plus up to 0.15 s at random, 3-6 s of hands on head, hands on hips, slumped or palms out, in turn so neighbours differ; nobody stands within 1 m of the beaten keeper lying on the grass; the keeper shakes his head, then hands on hips | F26, F27 (durations J) |
| R13 | Near miss | a shot off target that ends by the frame (within 2.5 m of a post or the bar line), or one saved within 2.5 s: shooter hands on head 2.5 s, two teammates within 20 m 2 s; the keeper points to organise | F27 |
| R14 | Foul | fouled player appeals 1.6 s, fouler palms up 1.5 s, two teammates within 12 m arm up | F21 |
| R15 | Calling | the receiver of a kick of 15 m or more raises an arm from 1.2 s before it is struck | F21 |
| R16 | Keeper organises | points for 3.5 s from 4 s before an opponent's set piece | F29 |

Emotions come only from the facts and events of the match: score facts (scorer from the fact or
its source event), shots, keeper saves, fouls, kicks and set pieces. Each emotion carries its
source (`fact_id` or `event:<id>`), and the Node test checks that every one points at a real fact
or event. Priority when two overlap: celebrate 6, join 5, dejected 5, near miss 4, appeal and
protest 3, call 2, organise 1. Weights ease in over 0.25 s and out over 0.4 s.

## How it is put on the mannequins

- `awareness.js` plans every player once on a 0.05 s grid, from 10 s before the shown stretch, with
  causal smoothing. `pose(i, ts)` and `look(i, ts)` are pure functions of player and time, so a
  seek, the replay and every video frame show the same thing.
- `awareness-rig.js` plugs into the scene's driver interface (`scene.addDriver`, players.js) at
  priority 10: the chest yaw and its weight, the gait and the emotion. The ball rig (20) and the
  event actions (30) win over it, and while either holds a player's legs the layer leaves his gait
  alone; during an event action it leaves the head alone too.
- After the animations, for every player not in an event action: the emotion's upper body (spine,
  neck, head, arms) at its full weight, then spine_03, neck_01 and Head turn to the look target
  (25/35/40% of the yaw, 40/60% of the pitch), clamped to R1 around the chest. The head chain uses
  its own world matrices (checked equal to Babylon's) because `computeWorldMatrix` on 22 chains
  cost 3-4 ms a frame.
- **A bug outside this layer, reported to the lead:** Babylon 9.29 clamps an animatable's weight to
  [0, 1], so the ×6 upper-body boost in `players.js` does nothing and every emotion clip ends up
  blended about half way with the run cycle: raised arms come out level. This layer applies its
  emotions again after the animations, so they read at full strength; other emotion sources
  through the same interface still get the half blend.

## Clips

The Quaternius Universal Animation Library (CC0) has no celebration, hands on head, appeal,
pointing, backpedal or jockey clips. What this layer uses:

- From the mannequin already in the repo: `Yes` (a fist pump, for teammates and the keeper) and
  `Idle_No_Loop` (a head shake, for the conceding keeper). No new file was added.
- Nine procedural upper-body clips, built at load time on the mannequin's skeleton by
  `awareness-rig.js` (arm directions per pose, mirrored for the left arm, optional spine bend):
  `SD_ArmsUp`, `SD_Clap`, `SD_HandsOnHead`, `SD_HandsOnHips`, `SD_Dejected`, `SD_Appeal`,
  `SD_Palms`, `SD_ArmUp`, `SD_Point`. They are joint keys, not third-party animation.
- Backpedal, strafe and jockey are the gaits the scene already has (the forward run turned by the
  chest/run angle), so the legs are stand-ins.
- Since `docs/motion3d.md`, the default page replaces the `SD_` clips and the stand-in gaits with
  retargeted Kimodo motion (`web/vendor/motion/`); the clips above remain for
  `?motion=procedural` and as the fallback when the clip file is missing.

## Tests and numbers

`node --test tests/web/awareness.test.mjs` (pure logic, DEMO and M001):

| Measure, defenders and players near the play | DEMO before | DEMO after | M001 before | M001 after |
|---|---|---|---|---|
| Head within 30 deg of the ball | 21.2% | 79.5% | 50.2% | 83.1% |
| Back to the ball | 42.9% | 10.3% | 25.5% | 4.2% |

- Head turn speed p99 about 400 deg/s (the cap); every look within the neck range; `pose` and
  `look` give the same answer in any call order.
- Gaits on M001: forward 72.5%, strafe 17.6%, backpedal 7.8%, jockey 2.1%; 6.05 gait changes per
  player-minute (DEMO 11.69).
- Emotions on M001: 812 (call 626, appeal 27, protest 17, organise 36, celebrate 4, join 40,
  dejected 48, near miss 14), every one from a fact or an event. At each of the four goals the
  scorer and at least 9 of his 10 teammates celebrate and all 11 of the conceding side are
  dejected at goal + 1.5 s.

`tests/web/run-smoke.sh sample3d-shots.mjs` (in the browser, on the rendered heads): defenders
within 15 m of the ball every 0.8 s of the live stretch, the head direction measured on the
mannequin's Head bone, and the emotion weights at goal + 1.5 s. The check runs with the layer on
and off and fails if "on" misses or "off" passes, so it proves each half fails without the layer:
on, 81% of 42 defender heads within 30 deg, scorer 1, teammates 9 of 10, conceding 9 of 11; off,
29%, 0, 0 of 10, 0 of 11.

## Cost

The layer's own JavaScript costs 1 to 2 ms a frame for 22 players (probe on DEMO: `pose` 0.3-0.5
ms, head and emotion pass 0.5-1.1 ms, driver hold check 0.2 ms; the head chain matches Babylon's
world matrices exactly). Whole-frame rates in the software-WebGL browser of the build machine
are dominated by load from other jobs: a render took between 17 ms and 1.4 s with the layer on or
off alike. For the record, the smoke test printed 2.8 to 5.7 frames/s with the layer and 10.6 to
46.8 without it over three runs, and 11.8 before this layer existed; the probe, interleaved, gave
30.4 and 5.8 with it and 8.9 and 0.7 without it. The emotion clips that `players.js` clones and
plays per player may add a real cost that these numbers cannot separate from the noise: measure on
a GPU before drawing a conclusion.
