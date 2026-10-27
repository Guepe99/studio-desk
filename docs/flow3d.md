# Flow in the 3D view: ball size, keeper reactions, smooth motion

Three faults of the first 3D sample: the ball looked giant, the keeper never dived, and the
players moved stiffly. This note has the rules, the sources behind them and the
numbers before and after each fix, measured on M001.

Code: `web/js/scene3d/track.js` (smooth paths), `web/js/keeper3d.js` (keeper plan, pure),
`web/js/keeper3d-rig.js` (keeper in the scene), small changes in `web/js/scene3d.js`,
`web/js/scene3d/players.js`, `web/js/scene3d/camera.js` and `web/js/sample3d.js`.
Tests: `node --test tests/web/flow3d.test.mjs`, the new checks in `tests/web/sample3d-shots.mjs`,
and the measurement script `tests/web/flow3d-measure.mjs`.

## 1. Ball size

A size 5 ball is 68 to 70 cm round (IFAB Laws of the Game, Law 2), so its radius is
0.69 / 2π = 0.11 m. The scene drew it at 0.17 m, 1.5 times too big, so that it read on a phone.
`BALL_R` is now 0.11 and exported as `scene.ballR`.

What depends on it, checked:

- `ball3d.js` already planned with `ballR = 0.11` by default; the scene passes the same value, so
  the planned height `h` is the underside and the drawn centre is `h + BALL_R`. The ball now rests
  on the grass instead of floating 6 cm under it.
- `ball3d-rig.js` puts the contact point of each kick at the measured toe plus `ballR` forward, so
  the boot meets the ball's surface with the smaller ball too.
- The blob shadow is `3 × BALL_R` wide and shrinks with it.

## 2. The keeper

### Research

| Fact | Number | Source |
|---|---|---|
| Time from first movement to ball contact, dive | 0.97 s low balls, 1.05 s high balls | Frontiers in Sports and Active Living 2019, doi 10.3389/fspor.2019.00015 |
| Centre of mass travel in a dive | 1.36 to 1.54 m sideways, up 0.40 to 0.43 m, forward 0.25 to 0.50 m | PMC9630263 |
| Dive speed | mean 2.84 to 3.18 m/s, peak 3.64 to 3.95 m/s | PMC9630263 |
| Skilled against less skilled keepers | about 4 m/s against 3 m/s lateral speed | PMC4974865 |
| A late start | costs about 0.15 m of reach | lida.sport-iat.de/ta/Record/4084406 |
| Collapse dive for low balls close to the body | technique description | keeperstop.com |
| Warping the root so the hands meet the ball on the contact frame | Unreal Engine Motion Warping | docs.unrealengine.com, Motion Warping |

No primary source gave a keeper's reaction time to a shot; 0.12 s is the visual reaction floor
used in sprint starts and is used here only so the keeper never moves before the ball does.

### Rules (keeper3d.js)

Only events and facts that happened decide a reaction:

- A **goal**: a shot with result `success` whose event id is in a score fact's `source_event_ids`.
- A **save**: a shot whose next event in the same period, within 3 s, belongs to the other side's
  keeper and is not a goal kick. With a keeper event (`keeper_save`, `keeper_claim`,
  `keeper_punch`, `keeper_pick_up`) the contact time is that event; otherwise the shot must end
  within 3 m of the keeper and the contact is the moment the drawn ball comes closest to that end.
- For a goal the contact time is when the drawn ball passes the keeper (its distance ahead of him
  turns negative), a ball beside him too.

At the contact time the ball's offset from the keeper, in his frame (facing the shot), picks the
reaction:

| Reaction | When |
|---|---|
| tip over the bar | ball centre above 2.0 m |
| catch at the chest | within 0.7 m sideways and at least 0.45 m up |
| gather a low ball | within 0.6 m sideways and lower than that (a ball straight at him is not dived on) |
| low dive | under 0.6 m and within 1.6 m sideways |
| full-stretch dive | everything else |
| beaten keeper | a goal: always the full-stretch dive to the ball's side, starting 0.15 s after the shot. He never reaches the ball: with the clips the dive plays at 1.5 times its own speed from the push and covers 60 to 100% of the clip's sideways travel, never past the ball, then he lands and stays down; the procedural pose goes 25 to 60% of the way (the share of a 1 s dive he has time for) |

Timing: the keeper moves 0.12 s after the shot at the earliest (0.15 s when beaten), never before.
When the clip's natural run-up does not fit between that and the contact, it is played faster, up
to 2.5 times; a reflex save still shows at least 0.15 s of movement, so a ball on him sooner than
0.27 s after the shot is met a moment late (the hands still go to where it was).

Body: the feet leave the tracked spot by 2 m at most, the body lifts, lands, stays down for a
moment and blends back onto the tracking in 0.8 s. Each reaction is cut short by the keeper's next
one, and by the end of the period (fading out over 0.3 s): the match clock runs on across half
time, so a shot just before the whistle no longer dives on into the second half.

### In the data

M001 has 8 shots that get a reaction: 4 saves, all catches, and 4 goals, all full-stretch dives.
DEMO has 3: a low catch at 240.9 s and two beaten dives (100.6 s and 310.6 s). Neither match has a
low dive, a full-stretch save or a saved shot above 2 m, so `GK_Dive_L` and `GK_Dive_R` are only
seen beaten, and `GK_Low_L`, `GK_Low_R` and `GK_Tip` are never picked.

### Real clips and the procedural stand-ins

When `web/vendor/motion/clips.glb` and `clips.json` are loaded (`docs/motion3d.md`), the reactions play
`GK_Dive_L`, `GK_Dive_R`, `GK_Low_L`, `GK_Low_R`, `GK_Catch` and `GK_Tip` on their root curve:

- On load the rig plays each clip on a probe scaled like the players and measures the hands frame
  by frame. Contact frame: for the catch the first frame at 90% of the hands' furthest forward in
  the first 1.2 s, for the tip the highest. For dives it depends on the shot: on the way down from
  the hands' highest point (after the first 0.3 s, the set position) to their widest, the first
  frame where the hands are no higher than the ball. A ball at knee height is met mid-flight, a
  ball on the grass when the keeper is down.
- The run-up is time-warped so the contact frame lands on the contact time, at most 2.5 times
  faster. When even that does not fit (a shot from close range), the clip starts part way in and
  its first frames blend in from the stance: the keeper still never moves before the shot. After
  contact the clip plays at 1x for 0.9 s (the landing), holds, and blends back.
- The root curve's sideways travel is scaled (0.4 to 1.5 times) so the hands reach the ball
  sideways; height and depth get a shift of at most 0.4 m and 0.6 m around contact.
- After the animation step the arms are aimed at the contact point (two-bone aim, weighted in
  before contact and out 0.6 s after it).

Without the files (`?motion=procedural`, or the fetch fails) the same plan drives procedural poses
built on the skeleton like the awareness layer's `SD_` clips: body rolled towards the ball, arms
along the body, legs trailing, keyed on `CLIP_KEYS` with the root curve from `keeperRoot()`.

## 3. Flow

### Research

- **Path interpolation.** Catmull-Rom with centripetal knots avoids cusps and self-intersections
  (Yuksel, Schaefer and Keyser, "Parameterization and applications of Catmull-Rom curves", 2011,
  cemyuksel.com/research/catmullrom_param). For tracking samples evenly spaced in time, though,
  the knots must stay uniform in time: centripetal knots rescale each segment differently and the
  speed jumps again at the samples. So the path is a cubic Hermite curve with Catmull-Rom
  tangents on uniform time knots.
- **Foot sliding.** Motion matching picks the clip frame whose foot positions and velocity match
  the requested trajectory (Clavet, "Motion Matching and The Road to Next-Gen Animation", GDC 2016,
  gdcvault.com/play/1022985; Holden et al., "Learned Motion Matching", 2020). Unreal's distance
  matching and stride warping keep the feet planted by playing the clip at
  ground speed / clip speed and stretching the stride (Unreal Engine docs, Distance Matching and
  Stride Warping: StrideScale = LocomotionSpeed / RootMotionSpeed). The scene already advanced the
  cycle by distance; what was wrong was the metres per cycle.
- **Facing.** A critically damped spring follows a moving target without overshoot (Holden,
  "Spring-It-On: The Game Developer's Spring-Roll-Call", theorangeduck.com, 2021; his motion
  matching controller uses half-lives around 0.27 s).
- **Human strides, for the record:** walking 1.51 m/s with 0.79 m steps (PMC3756042), jogging
  2.9 m/s at 172.6 steps per minute (PMC3022995), sprinting 8.3 to 9.3 m/s with 1.86 to 1.98 m
  steps (PMC12047830).

### What changed

- **Paths** (`track.js`): every player's path is a cubic Hermite curve through the exact tracking
  samples, with continuous velocity. The ball stays on its straight lines (kicks are real jumps in
  velocity, and `ball3d.js` bends its clock anyway). The 2D page keeps `match.at()` unchanged.
- **Speed estimate**: the speed that drives the gait is taken over ±0.05 s of the smooth path
  instead of ±0.2 s of the straight lines, so it follows real changes of pace.
- **Facing**: the final facing (after every driver's turn) goes through a critically damped spring
  (ω = 12 rad/s, so half a step in about 0.14 s) that also follows the target's own turn rate,
  capped at 8 rad/s. Before, the base facing was smoothed but the drivers' turns were applied on
  top raw, so the body snapped by up to 165° in one frame. Near the ball (within 1 m) a still
  player keeps his facing instead of chasing the ball's bearing, which swings at random there.
- **Stride**: the metres per cycle of the walk, jog and sprint loops were measured in the scene
  (planted toe's travel per cycle on the scaled player): 1.24, 5.5 and 6.0 m, against the 1.3,
  5.0 and 5.5 m the code had from the unscaled file. Speeds were rescaled to match.
  With the anime footballers the jog's median slide on the DEMO window had crept back to 0.102 m.
  A sweep of the jog stride (4.4, 4.7, 4.85, 5.0, 5.15, 5.5 and 6.0 m) gave medians of 0.115,
  0.107, 0.096, 0.080, 0.098, 0.105 and 0.160 m; the jog is now 5.0 m. The p95 moved without a
  trend (0.66 to 1.10 m): the starts and stops below.
- **Clip blending**: the locomotion weights ease towards their target with a 0.08 s time
  constant instead of jumping when the speed or the mode changes.
- **Camera**: the broadcast camera's safe-area limit counts a lofted ball at 3 m at most and
  never aims off the pitch (`web/js/scene3d/camera.js`, two lines).
- **Frame pacing**: the clock now advances by the real time between frames, capped at 0.5 s (a
  hidden tab). Before it was capped at 0.1 s, so below 10 frames per second the match ran slow.

### Numbers on M001

Measured by `tests/web/flow3d-measure.mjs` on the default clip of M001 (from 582.99 s, 12 s of
the live part, 22 players, stepped at 60 Hz without drawing), then the live page for 15 s for
the frame pacing. Software WebGL 1, low profile. Before is commit 881caa9 (with the motion clips
of `docs/motion3d.md`), after is this change on top of it; same window, same script.

| What | Before | After |
|---|---|---|
| Velocity jump between frames, p95 / p99 | 0.20 / 0.30 m/s | 0.084 / 0.148 m/s |
| Acceleration of the drawn players, p50 / p95 / p99 | 0 / 12.0 / 18.0 m/s² | 1.0 / 5.0 / 8.9 m/s² |
| Acceleration, max (driver offsets: kicks, tackles) | 68.9 m/s² | 63.4 m/s² |
| Facing turn rate, max | 9935 °/s | 811 °/s |
| Facing snaps over 15° in one frame | 15 | 0 |
| Clip weight changes over 0.2 in one frame | 54 | 10 |
| Planted foot slide per step, walk, median | 0.125 m | 0.119 m |
| Planted foot slide per step, jog, median | 0.078 m | 0.042 m |
| Planted foot slide per step, sprint, median | 0.065 m | 0.027 m |
| Clock seconds per real second (live page) | 0.53 | 0.99 |
| Camera acceleration, p99 | 12.7 m/s² | 12.7 m/s² |
| LOD switches per player per minute | 0 | 0 |

Read the table this way:

- A median acceleration of 0 before is the straight-line interpolation: speed constant for 0.1 s,
  then a jump. The p95 of 12 m/s² is those jumps. After, the speed changes a little every frame.
- The p95 facing turn rate went up (173 to 202 °/s) because the body now turns through the angle
  instead of jumping it; the maximum dropped from 9935 to 811 °/s.
- The clock ran at half speed before: at about 6 frames per second in software each frame is
  167 ms, and the old cap of 0.1 s per frame threw the rest away. This is the biggest visible change
  on a slow machine. The optimizer applied no steps in either run.
- Not fixed: the foot slide p95 at a walk and in sprints (0.6 to 0.9 m) comes from starts, stops
  and the stand-in modes (backpedal, side-step, jockey loops, `docs/motion3d.md`), where the clip's
  stride does not match the ground speed. The remaining weight pops are those motion loops cutting
  in when the mode changes. On this window the camera and the LOD were already smooth: the camera
  follows a spring, and every player stays on the far mesh at broadcast distance. The camera was
  not smooth on a lofted ball, below.

The video window (M001 from 3350 s, 20 s, the low save at 3362.9 s) has a clearance that the
tracking puts 16 m in the air at 3358 s. The broadcast camera's hard limit chased it into the
safe area by panning its aim to the far side and beyond, so for 3.3 s the view showed only the
stands. The limit now counts a lofted ball at 3 m at most and keeps the aim on the pitch:

| What, video window | Before | After |
|---|---|---|
| Frames with the camera aimed off the pitch | 196 (3.3 s) | 0 |
| Camera acceleration p95 / p99 | 664 / 3578 m/s² | 9.8 / 12.1 m/s² |
| Camera acceleration max | 4412 m/s² | 521 m/s² |
| Player acceleration p95 | 12.8 m/s² | 5.0 m/s² |
| Facing snaps over 15° in one frame | 28 | 0 |
| Clip weight changes over 0.2 in one frame | 52 | 12 |
| Foot slide median, walk / jog / sprint | 0.155 / 0.115 / 0.040 m | 0.144 / 0.083 / 0.019 m |
| Foot slide p95, jog / sprint | 0.37 / 0.14 m | 0.46 / 0.96 m |

The worse sprint p95 in this window is the same open problem as above: in a start or a stop the
sprint loop's stride and the ground speed disagree, and the faster distance-matched cycle makes
those few steps slide further.

The same checks run in `tests/web/sample3d-shots.mjs` on the DEMO window it opens (from 88 s).
Their limits sit between the code before and after this change there: acceleration p95 24.2 before, 12.9
after (limit 16); jog slide median 0.111 before, 0.086 after (limit 0.1); facing snaps 35
before, 0 after (limit 0); ball radius 0.17 before, 0.11 after; keeper reactions 0 of 1 before,
1 of 1 after; hands to ball at the DEMO save 0.85 m with the keeper layer off, 0.22 m with it on
(limit 0.5).

## 4. Toes in the grass at the jog's toe-off

`tests/web/feet3d.mjs` failed on all four pages (DEMO and M001, default and anime footballers):
the lowest boot outside keeper actions went 2.8 to 3.4 cm under the grass (limit 2 cm).

Cause, measured on DEMO with the default footballers (every boot vertex, every 0.06 s): all of the
40 deepest samples were a running player's boot with the lower ankle exactly 20 cm up and the
foot pointing 77 to 89 degrees down, the toe-off of the jog loop. That is `settleFeet`
(`players.js`): in a loop's flight phase it lowers the whole body (by 9 to 17 cm here) until the
lower ankle is 0.2 m up, and with the foot nearly vertical the toe tip sits 0.23 m below the
ankle bone, so the tip went 3.3 cm under. The ball bone was still 2.7 to 3.0 cm up, which is
why a cap on the ball bones changed nothing: the tip reaches 6.2 cm past the ball bone. The ball
rig's grounding, which runs before `settleFeet`, saw it too late and too short: its sole points
were the vertices within 1 cm of the flat sole, and the toe tip curves up 1.2 cm, so its lowest
point read -2.8 cm where the tip was at -3.3 cm. The clips, their blends and the per-player
scale were not the cause (same depth at scale 1.0017 and on the anime heights).

Fix: the rig's sole points add the toe tip and the heel's back (the lowest vertex with the foot
tilted 30, 60 and 85 degrees either way), the grounding keeps the lowest sole point's height
after its lift, and `settleFeet` never lowers the body further than that. No new per-frame
pass: 12 more points per foot in a loop that was already there.

| feet3d.mjs, lowest sole outside keeper actions | Before | After |
|---|---|---|
| DEMO default | -3.3 cm (T01-9, walk+jog, 2.8 m/s) | -0.9 cm |
| DEMO anime | -2.8 cm (T02-11, jog+run) | -0.7 cm |
| M001 default | -3.4 cm (T02-2, jog, 1.27 m/s) | -0.8 cm |
| M001 anime | -3.0 cm (T02-11, walk+jog, 3.75 m/s) | -0.7 cm |

The highest planted sole did not move (8.3, 1.3, 2.9 and 2.5 cm on the four pages); the planted
median rose from -0.8 to -0.6 cm on DEMO default and from -0.7 to -0.6 cm on M001 default. The after-animation pass (ball rig,
grounding, `settleFeet`, the other layers) costs 2.6 ms per frame for 22 players before and after,
inside the run-to-run spread. The flight dip of T01-9 at 7.86 s is 10.7 cm instead of 16.8 cm.
Stills, a boot seen from the grass:
`scripts/with-lock.sh chromium tests/web/run-smoke.sh feet3d-stills.mjs DEMO T01-9 7.62 7.98`.

## 5. Throw-ins and players keeping the ball

Two complaints from watching M001: at a throw-in the taker took far too long to pick the ball
up, and a player standing with the ball at his feet stood like a statue. Overall the motion read
as mechanical.

### Research

- **How long a throw-in takes.** In the 2025-26 Premier League a throw-in followed an average
  stoppage of 17.9 s, 15.4 s once stoppages of 55 s or more are left out (Opta Analyst,
  theanalyst.com/articles/premier-league-football-time-throw-ins-goal-kicks-substitutions-stats);
  15.6 s in 2024-25 (theanalyst.com/?p=212962). Taken: the 13 to 15 s wait in our tracking is
  realistic, so the fix is when the ball is in the taker's hands, not when he throws.
- **How a throw-in is taken.** Law 15 of the Laws of the Game (theifab.com/laws/latest/the-throw-in):
  both hands, from behind and over the head, facing the field. Taken: the raise and release
  already in `players.js`, and a carry at the chest in between.
- **Blending.** Holden, "Dead Blending" (theorangeduck.com/page/dead-blending): a blend of about
  0.2 s is normal and a pose should blend from where it is, not snap. Bollo, "Inertialization",
  GDC 2018 (gdcvault.com/play/1025165): transitions decay the old pose's offset instead of
  crossfading two live clips. Holden, "Spring-It-On" (theorangeduck.com/page/spring-roll-call):
  critically damped springs and half-lives. Taken: every new weight in this section eases in and
  out over 0.3 to 0.4 s with smoothstep (crouch, carry, raise, skills), and the carry stays under
  the raise as it fades in, so the arms never pass through the idle pose.
- **Stride and cadence.** Unreal's pose warping (dev.epicgames.com/documentation/unreal-engine/pose-warping-in-unreal-engine):
  stride warping scales the stride to the ground speed, distance matching plays the cycle by
  distance. Human cadence: 172.6 steps per minute at 2.9 m/s (PMC3022995); 2.88, 3.04 and 3.6
  steps/s at 4.15, 5.07 and 7.32 m/s (jssm.org/tablejssm-22-790.xml/table002.xml). Taken: the
  numbers below, to say how far our run cycle is from a real one. Changed in section 6.
- **Moves with a still ball.** Our choice: a holder with the ball at his feet moves it instead
  of standing in an idle loop. No public source gives the timings of such moves, so the five here (sole roll, drag-back, step-over, shoulder feint and a
  quick shimmy) were keyed by hand on the leg rig that the kicks already use.

### Measured causes (before)

`tests/web/motion-flow-measure.mjs` steps the 3D sample at 60 Hz on M001 and reports what makes
motion look mechanical. Windows of 20 s from 0, 120, 280, 512, 530 (minute 8) and 560 s.

- **Throw-ins.** The taker stood within 1 m of the ball 14.8 s before the throw at 529.03 s, and
  9.5 to 13.6 s after reaching it the ball was still on the grass: it rose to his hands 1.26 s
  before the release, from the grass to the hands with no bend of the body (`scheduleThrows`
  started the throw 1.6 s before the event, whatever the tracking did before).
- **Still holder.** In open play a player kept a still ball for up to 3.4 to 4.15 s at a time
  (T02-9 from 535.95 to 540.51 s). His feet were on the ball 12 to 69% of that time (35% in
  minute 8, 12% from 560 s), the rest was the idle loop: `BallPlan._dribble` returned with no
  action when the ball moved under 1 m/s.
- **Not the cause.** Root jerk p95 30 to 68 m/s³ comes from the simulator's bang-bang
  acceleration (p95 exactly 5.0 m/s²), not from the path: a quintic Hermite through the same
  samples, tried here, raised the jerk p95 on 600 s of M001 from 36.5 to 46.0 m/s³, so the cubic
  stays. Players stepping in lockstep: 4.4 to 9.6% of pairs. The walk, jog and sprint loops plant
  the left foot at 0 to 0.025 and the right at 0.5 of the cycle, so their blends match in phase.
- **Cadence, found and left.** Forward runs step 22 to 28% slower than people: 2.18 to 2.24
  steps/s at a 3.4 to 4.0 m/s jog (people about 2.85), 2.37 to 2.40 at 5.9 m/s (about 3.3).

### What changed

- **Throw-in** (`players.js` `THROW`, `scheduleThrows`, `throwDriver`; `scene3d.js`
  `throwBall`). `scheduleThrows(events, match)` finds the first moment of the unbroken stretch,
  up to 30 s back, in which the ball lies still within 1.5 m of the throw point and the taker
  stands within 1.2 m of it; the pick-up is 0.35 s later. Without positions, or when he never
  stands at the ball, it falls back to just before the raise. The driver then plays a crouch
  (`M_crouch_head_down`, full body while he stands) eased in over 0.3 s, draws the body to
  0.35 m from the ball and turns him to it, closes the hands on the ball (`throwBall` lerps the
  ball into the hands from 0.15 s before the pick-up), carries it at the chest (`GK_Catch` held at
  1.6 s, upper body), then raises it over the carry (`applyUpper` now applies an `under` pose
  first) and releases on the event time as before. No new clip: all three are in
  `web/vendor/motion/clips.glb` already.
- **Ball at the feet** (`ball3d.js` `SKILLS`, `_skills`, `_moved`; `ball3d-rig.js`). Where the
  holder keeps a still ball before his own kick, the plan fills the gap with moves drawn from a
  generator seeded by player and moment: a sole roll (0.12 m out and back under the sole), a
  drag-back and a touch that returns it (0.26 m), a step-over, a shoulder feint and a shimmy (the
  feint at 0.6 of its timing, 0.4 s, which fits a short hold), 0.15 to 0.5 s apart, from 0.32 s
  after the first touch. Never before a free kick, corner, penalty, goal kick or throw-in, never
  inside the kick's backswing (`LEG_WINDOW`: 0.5 s for a long ball or a shot; a pass gets 0.5 s
  too, since it becomes a long ball only once its flight is planned), and only while he is within
  1.5 m of the ball. The ball's offset eases with smoothstep and always ends at 0, so the tracking
  position is unchanged at the kick.
  On the whole of M001: 763 moves (279 shimmies, 181 feints, 120 rolls, 106 step-overs, 77 drags),
  the ball plan's worst miss of the tracking 1.20 m (limit 1.5). 449 of the 533 receptions kept
  1 s or more show a move: every one kept 1.22 s or more (0.32 + 0.4 + 0.5 s, the shortest move
  between the first touch and the backswing), except two before a set piece.

### Numbers on M001 (high profile, WebGL 2)

| What | Before | After |
|---|---|---|
| Throw at 529.03 s: ball in hands after the taker reaches it | 13.55 s | 0.72 s |
| Throw at 529.03 s: ball in hands before the release | 1.26 s | 14.33 s |
| Minute 8 (530 s): holder's feet on a still ball, share of the time | 0.35 | 0.73 |
| Minute 8: holder's foot speed in the body frame, p50 | 0.46 m/s | 1.34 m/s |
| Minute 8: ball to nearest foot, p50 | 0.22 m | 0.16 m |
| Minute 8: held ball jumps (over 0.25 m in a frame) | 0 | 0 |
| Throw-ins, M001 / M002 / M003 / M004 (44 / 43 / 43 / 43): ball in hands before the release, median | about 1.2 s, every one | 14.8 / 13.6 / 14.6 / 13.5 s |
| Frame cost from 530 s (`frame-cost.mjs`, WebGL 2 high): draw calls | 376 | 376 |
| Frame cost: render CPU per frame, three pairs of 12 frames (the third run new first) | 46.4 / 49.3 / 53.5 ms | 55.4 / 61.6 / 53.5 ms |
| Frame cost: scene update per frame, same pairs | 13.6 / 15.6 / 15.0 ms | 13.5 / 16.5 / 11.8 ms |
| Update and animation per 60 Hz step, 1193 steps, p50 / p95 (530 s, two runs) | 22.0 / 41.8, 15.8 / 23.1 ms | 17.8 / 24.4, 17.9 / 25.7 ms |
| Same at 512 s (two runs) | 17.6 / 26.4, 17.9 / 29.0 ms | 16.6 / 23.5, 20.0 / 29.3 ms |

The renderer is software (SwiftShader) and the machine is shared, so single runs move by up to
12 ms; the third frame-cost pair, taken in the other order, ties. The changes add no mesh,
material or draw call, and the per-step CPU, which is where they run, is the same within noise.
The skills' ball offset is found by binary search (`_moved`), not by a scan from the kick-off.

Checks: `node --test tests/web/throw.test.mjs tests/web/skills.test.mjs` (both fail on the old
code: "pick-up at undefined", "only 0 moves in 1500 s"), and in the browser
`CHECK=1 WEBGL=2 scripts/with-lock.sh chromium tests/web/run-smoke.sh motion-flow-measure.mjs M001 512 20`
(and `530`), which fails on a pick-up slower than 2 s after reaching the ball, a holder with his
feet on a still ball less than half the time, or a held ball that jumps. Old code: FAIL on both
windows (13.55 s; 0.35). New code: PASS on both.

The cadence was left for a second round: section 6.

## 6. Cadence and the simulator's jerk

The remaining complaint after section 5 was general: movements mechanical, with no flow. Two
causes were measured: legs that step too slowly for the ground speed, so the runners seem to
glide, and the jerk of the simulator's acceleration steps.

### Research

- **Stride warping.** Unreal's pose warping (dev.epicgames.com/documentation/unreal-engine/pose-warping-in-unreal-engine):
  a locomotion loop is played at a rate set by the ground speed and its leg swing is scaled so the
  stance foot keeps to the ground, instead of speeding up the clip alone (which slides the feet).
  Taken: cycle rate = v / (stride * s) and the hip and knee rotations pulled towards their mean
  pose over the cycle by the same s. The swing amplitude times s and the rate divided by s cancel,
  so the planted foot still moves back at the ground speed.
- **Human cadence.** 1.91 steps/s at 1.51 m/s walking (PMC3756042); 2.88 steps/s at 2.9 m/s
  (PMC3022995); 2.88, 3.04 and 3.6 steps/s at 4.15, 5.07 and 7.32 m/s
  (jssm.org/tablejssm-22-790.xml/table002.xml); about 4.58 steps/s at 8.8 m/s sprinting
  (PMC12047830). Taken: the `CADENCE` table in `players.js`, interpolated linearly. Below
  0.93 m/s the walk loop keeps its own stride.
- **Critically damped smoothing.** Holden, "Spring-It-On" (theorangeduck.com/page/spring-roll-call):
  a critically damped spring follows a target without overshoot, its impulse response is
  omega^2 u e^(-omega u) and its mean delay 2 / omega. Taken: the shown root is that response
  applied to the known track, read ahead by 2 / omega, so a constant velocity passes with no lag.

### Measured causes (before)

- **Cadence.** On M001 from 530 s the forward loops stepped at 1.73 steps/s at a 1.43 m/s walk,
  2.20 at a 3.66 m/s jog and 2.39 at a 5.99 m/s run. People: 1.86, 2.88 and 3.27.
- **Jerk.** The simulator accelerates bang-bang (accel p95 exactly 5.0 m/s^2), so the cubic path
  still has jerk spikes when the acceleration switches: p95 52.7 and p99 147.9 m/s^3 from 530 s,
  17.5 and 87.6 from 512 s.
- **Heading.** Already smooth: the facing goes through a critically damped spring (omega 12,
  section 3), with no snaps on any window. Not changed.

### What changed

- **Stride warping** (`players.js` `humanStride`, `animatePlayer`, `warpStride`). In forward
  runs above 0.93 m/s the cycle advances by v / (stride * s), with s = human stride / clip stride,
  between 0.6 and 1. `warpStride`, added by `Scene3D` before the ball rig in the after-animation
  step, slerps the thigh and calf rotations towards the loops' mean pose (32 samples a cycle,
  blended by the loop weights) by 1 - s. Backpedal, strafe and jockey keep the clip's cadence.
  Knee factors were measured on M001 from 583.7 s (jog slide median, the hips at 1): knees at 0,
  0.5, 1 and 1.5 gave 0.139, 0.094, 0.059 and 0.109 m; hips at 1.2 gave 0.066 m. Taken: 1 for both.
- **Root smoothing** (`track.js` `rootAt`, `scene3d.js`). The shown root of each player is the
  spring's response (omega 20, 9 samples over 6 / omega) read 0.1 s ahead, so the offset under an
  acceleration a is about a / omega^2: 1.25 cm at 5 m/s^2, 1.3 cm at most on M001. A soft cap
  (5 cm, tanh) holds the root to the path where the DEMO fixture reverses 12 m/s in 0.1 s. Only
  the tracking base point is smoothed: the drivers' offsets (kicks, the ball rig's foot on the
  ball), the facing and the gait speed read the path as before, and the ball plan and the data
  are unchanged. `Scene3D.rootOmega = 0` shows the path as it is.

### Numbers on M001 (WebGL 2 high for the motion measures)

| What | Before | After |
|---|---|---|
| Cadence from 530 s, walk 1.43 m/s / jog 3.66 m/s / run 5.99 m/s (people 1.86 / 2.88 / 3.27) | 1.73 / 2.20 / 2.39 steps/s | 1.86 / 2.88 / 3.27 steps/s |
| Planted foot slide per step from 583.7 s, median walk / jog / sprint | 0.286 / 0.050 / 0.075 m | 0.294 / 0.059 / 0.076 m |
| Same, p95 | 0.631 / 0.604 / 0.829 m | 0.650 / 0.485 / 0.735 m |
| Jog steps counted in that window | 296 | 384 |
| Root jerk from 530 s, p95 / p99 (root smoothing off: same as before) | 52.7 / 147.9 m/s^3 | 23.1 / 58.0 m/s^3 |
| Root jerk from 512 s, p95 / p99 (smoothing off against on, both with the warp) | 17.5 / 87.6 m/s^3 | 7.0 / 33.1 m/s^3 |
| Root acceleration from 530 s, p99 | 6.38 m/s^2 | 5.18 m/s^2 |
| Root off the path, M001 480 to 540 s (node test) | 0 | 1.3 cm at most |
| Throw-in at 529.03 s, ball in hands after the taker reaches it | 0.72 s | 0.70 s |
| Frame cost from 530 s (`frame-cost.mjs`, WebGL 2 high): draw calls | 376 | 376 |
| `rootAt` for 22 players a frame, node on M001 (3600 frames, three runs) | 0.001 ms | 0.03 ms |
| Update and animation per 60 Hz step, p50 / p95, from 512 s (old, smoothing off, new) | 23.3 / 96.6 ms | 24.2 / 94.6, 19.3 / 93.4 ms |

The frame-cost runs of this round got 3 or 4 frames each with 7 to 12 s of GPU wait a frame (the
machine was shared and loaded), so their CPU times (render 188 to 502 ms a frame, either code)
say nothing. The added work is a few quaternion slerps and nine path reads per player a frame:
0.03 ms a frame for the reads in node, and the per-step time in the browser is the same within
its noise. No mesh, material or draw call was added.

The jog's planted foot slides about 1 cm more per step at the median (and less at p95): the
warped swing is a rotation towards the mean pose, which follows the clip's foot path only
roughly. The per-step limit of `sample3d-shots.mjs` (0.1 m) still holds: 0.07 m there.

Checks: `node --test tests/web/cadence.test.mjs tests/web/root.test.mjs` (on the round-1 code
they fail: "3.66 m/s: 2.21 steps/s, want 2.8 to 2.96"; "T.rootAt is not a function").
`CHECK=1 ... motion-flow-measure.mjs` now also fails on a jog under 2.6 steps/s: on the round-1
code from 530 s "FAIL jogging at 3.663 m/s with 2.204 steps/s", on the new code PASS on M001 512
and 530 (both bodies), M002 518, M003 455 and M004 583.
Kick and touch checks after the change: `kick3d-shots.mjs` (default and anime), `feet3d.mjs`
(DEMO and M001, both bodies), `feet3d-stills.mjs`, `sample3d-shots.mjs` (WebGL 1 and 2) and
`view3d.mjs` on M001 to M004: all pass, positions within the view's tolerance on every match. The
one exception is the frame-rate fallback check of `view3d.mjs` on M001, at 0.1 to 0.2 fps on a
loaded machine: it failed on both runs of the new code and on the round-1 code too (which also
failed two more checks), so it is the load and not this change.

Stills (camera following the player from the broadcast side): `out/motion-flow/r2-before-run.png`,
`r2-after-run.png` (T02-11 from 530 s + 11.0 to 14.4 s, a jog and a turn),
`r2-before-broadcast.png` and `r2-after-broadcast.png` (minute 8, the page's own camera).
The jog start shows the change: before, long strides that glide over the grass; after, shorter
and quicker steps with the feet under the body. The minute-8 stills put every player in the same
place, and the dribbler keeps the ball at his feet. A run of the same stills with the smoothing off
(`root=0`) looks the same as with it on: the offset is about a centimetre. The stills show no
lag, the measures show the jerk cut by more than half, so the smoothing stays.

## 7. The throw-in taker's jump and the warp at a mode switch

A second look at sections 5 and 6 found the throw-in taker jumping when the draw to the
ball began, the crouch snapping in, a fallback taker pulled 7.65 m, and the stride warp dropping
to nothing in one frame when a player left a forward run.

### Measured causes (before, the code of section 6)

Every taker on M001 to M004, stepped at 60 Hz in node (the shown root, `rootAt`, plus the
driver's offset; the animation weights from `animatePlayer`), from 1 s before the pick-up to the
release:

- The draw's ramp started 0.6 s before the pick-up, but the throw's window (and so the driver)
  only 0.45 s before: the draw began at 30 % of its length in one frame, 0.17 to 0.27 m.
- The draw's own speed (4.7 to 5.7 m/s shown, about 1.2 m/s in the tracking) counted as the
  player's speed, so the crouch stayed out of full body (under 1.5 m/s) and then snapped in: the
  locomotion's share dropped by 0.874 in one frame on every throw-in.
- Takers could still be running in the second before the pick-up (T01-6 on M001 at 4.7 m/s,
  0.078 m a frame), since it came 0.35 s after he first stood within 1.2 m of the ball whatever
  his speed.
- With no reach found the fallback still drew him to where the ball lay, from any distance.
- The cadence and the warp were computed in forward runs only, so leaving "forward" set s to 1 in
  one frame while the forward loops still had about 0.8 of the weight (pull 0.343 to 0 in a frame
  in the node test).

### What changed

- **Pick-up** (`players.js` `scheduleThrows`). It comes at the first moment, from 0.35 s after he
  reaches the ball, when he still stands at it and his tracking speed has stayed under 2.4 m/s
  (`THROW.walk`) for the second before and under 1.2 m/s (`THROW.still`) through the crouch.
  Without one, the fallback picks the ball up where he stands (`ball` null: no draw).
- **Draw** (`throwDriver`). It starts at the window's first frame and eases in over 0.75 s, holds
  0.3 s and eases out over 1.2 s (`THROW.drawIn`, `drawHold`, `drawOut`), capped at 1.2 m.
- **Crouch** (`animatePlayer`, `scene3d.js`). The full-body test reads the tracking's speed
  (`r.vTrack`, the path without the drivers' offsets), not the shown one.
- **Warp** (`animatePlayer`). A forward share eases like the loop weights (0.08 s), and s is
  1 - (1 - s_forward) times that share, with s_forward the last forward run's: leaving or entering
  "forward" fades the warp and the cadence speed-up over frames. Without leg bones to warp, s is 1.
- Small: `cycleMean` caches by animation alone; `SKILLS` is no longer exported.

### Numbers (node, 60 Hz, every throw-in)

| Match (throw-ins) | Worst move a frame, before | After | Median of the takers' worst, before | After | Crouch share, worst jump a frame, before | After |
|---|---|---|---|---|---|---|
| M001 (44) | 0.316 m | 0.041 m | 0.285 m | 0.039 m | 0.874 | 0.083 |
| M002 (43) | 0.342 m | 0.040 m | 0.289 m | 0.038 m | 0.874 | 0.083 |
| M003 (43) | 0.339 m | 0.041 m | 0.288 m | 0.038 m | 0.874 | 0.083 |
| M004 (43) | 0.339 m | 0.040 m | 0.287 m | 0.038 m | 0.874 | 0.083 |

Before, all 173 takers moved over 5 cm in a frame; after, none. The worst frames left are his
own walk 1 s before the pick-up (2.4 m/s is 0.04 m a frame). Every throw-in still has its draw,
the pick-up comes 0.35 s (median) to 0.8 s after he first stands within 1 m of the ball, and the
ball is in his hands 9.0 to 17.4 s before the release.

Checks, each shown failing on the code of section 6 first: `tests/web/throw.test.mjs` (the
0.05 m and 0.1 bounds on a synthetic taker, on one who runs in, and on every throw-in of the
exported matches: "M001 T01-5 throw at 69.21: moves 0.303 m in a frame"; the fallback without a
draw), `tests/web/cadence.test.mjs` (the pull across a forward, backpedal, forward switch: "the
warp's pull jumps 0.343 in a frame"; no leg bones, no warp; the stride against the cited cadence
table, which fails when the table's 3.04 steps/s at 5.07 m/s is changed to 3.3) and
`tests/web/skills.test.mjs` (a plan over a window inside the first gives the same moves, which
fails when the seed takes the window's start).

## 8. The ball in the keeper's hands, the net, the spin

A second look at `ball3d.js`, `keeper3d.js` and their rigs found the ball dropping out of the keeper's
hands, a 20 m jump when the net window ended, close-range goals that never reached the net, and a
ball that turned at every replan. Measured with node scripts on M001-M004, smoothed as the scene
draws them, planned on the scene's windows (15 s back, 105 s ahead).

### What changed

- **Held ball.** After a `keeper_save`, `keeper_claim` or `keeper_pick_up` that the same keeper
  plays next in the same period (25 cases), the drawn ball goes into his hands within 0.3 s, stays
  0.85 m up and 0.3 m in front of him, and is dropped for his kick (it falls under gravity from
  0.85 m, about 0.52 s before the kick). In the scene (`KeeperRig`) he carries it with the
  throw-in's chest pose (`THROW.carry`) under any reaction still playing, and after the arms are
  aimed the ball is put between his hands wherever the pose has them, as `scene3d.throwBall` does.
  A parry (the next ball is someone else's) falls under gravity instead of dropping in 0.1 s.
- **Net window.** It rests in the net for at least 3 s, then eases out onto the tracking ball over
  2.5 s (carried back for the kick-off), and ends before the next event or a jump of the tracking
  ball. Before, it ended 30 s after the goal by snapping to wherever the tracking ball was.
- **Close-range goals.** The crossing search starts 0.1 s after the shot (it needed 0.25 s), and
  the speed is measured over what time there is. The two goals with no net (M002 4013, M004 3429.8)
  now press the netting, and the keeper reacts to the first of them, which passes beside him.
- **First-time kicks.** A ball kicked within 0.15 s of arriving is a kick, not a trap.
- **Spin.** The rotation restarts at every kick from the same orientation on a 0.02 s grid of
  absolute match time, and each plan starts integrating at the last kick before its window (and
  plans the ball from there): every plan gives the same rotation at the same match time.
- **Keeper timing.** The run-up never starts before shot + 0.12 s (0.15 s beaten), and contact is
  at least 0.15 s after that, so no division by zero is possible; a reaction is cut at the end of
  its period; a low ball within 0.6 m sideways is gathered (catch), not dived on. The chest catch
  alone left the hands 0.76 m from a ball on the grass (DEMO 240.9), so for a low catch the rig
  stoops him first: bent forward from the hips with straight legs, the coaching technique for a
  ground ball straight at the keeper, until his shoulders are an arm's reach above the ball (80
  degrees at most), and then aims the arms.
- Null guards where the tracking ball can be missing; `KeeperRig.procedural` and the `TOL` export
  removed (unused).

### Numbers (node, M001-M004, the scene's planning windows)

| Measure | Before | After |
|---|---|---|
| Held balls: samples in the keeper's hands (h > 0.6 m, within 0.8 m), 25 holds, 537 samples | 0% | 100% |
| Parried ball from contact to the grass | 0.02 to 0.10 s | gravity (1.31 m in 0.52 s) |
| Goals with a jump over 1 m between 60 Hz frames, of 12 | 10 (18.6 to 26.1 m) | 0 (largest 0.55 m, the tracking ball's own) |
| Goals that never reach the net | 2 | 0 |
| Goals without a keeper reaction | 1 | 0 |
| Keeper reactions running past half time | 1 | 0 |
| Reactions starting before shot + reaction time | 5 | 0 |
| Low saves at the body (16) drawn as dives | 14 | 0 |
| Kicks drawn as traps, of 4039 | 5 | 0 |
| Ball rotation jump at a replan, M001 and M003, 12 each | 30 to 180 degrees | 0 |
| Same moment from two plans (a seek), 8 times | up to 128 degrees | 0 |
| `ball()` + 3 `pose()` per player per frame | 40 to 48 us | 41 to 51 us (busy machine, noise) |
| One ball plan, 120 s window | 23 to 47 ms | 23 to 68 ms (it now plans back to the last kick) |

Tests: `tests/web/keeperball3d.test.mjs` (nine checks, each failing on the code before this
section), `flow3d.test.mjs` on M001-M004, `net3d.test.mjs` rests at the end of the rest time. In
the browser `tests/web/hold3d.mjs` steps a hold at 30 fps and checks the ball stays between the
hands.

## 9. Half time, motion loops, head look, strides, facing

A second look at the players' code found the smoothing and speed estimates reading across half time,
motion loops that swap in one frame, a head look that switched off all at once, strides that
ignored the player's height, a facing that depended on what was shown before a seek, and chained
celebration variants that dipped to nothing between two clips.

### Measured causes (before, the code of section 7)

- **Half time.** The tracking jumps between the last frame of the first half and the first of
  the second (H = period1_s x fps): the players walk off and come back somewhere else. The
  Catmull-Rom smoothing (`hermiteAt`) took its neighbours across the jump, the shown root
  (`rootAt`) read the path across it, and the speeds (the scene at +-0.05 s, awareness at
  +-0.2 s) divided the jump by 0.1 to 0.4 s. On every match, about 459 of 1320 player-frames
  within 0.5 s of the whistle had a speed over 0.5 m/s outside the samples' own (worst 874 to
  952 m/s), all 22 players ran over 5 m/s at period1_s, and the root was up to 6.4 to 7.0 m off
  the sampled path.
- **Motion loops.** `motionLoop` picked the best matching loop afresh every frame and
  `animatePlayer` swapped its weight in one: on M001 600 to 900 s, 293 swaps in 12.6
  player-minutes of backpedal and strafe (23.2 a minute), 15 back again within 0.3 s, and a
  loop's share of the weight moved by 1.0 in a frame.
- **Head look.** The look-at was skipped whole during an event action, an M_ emotion or a head
  clip, at any weight: the head snapped to the look when the weight passed 0.
- **Strides.** Players are scaled by their height (0.95 to 1.05, `players3d.js`) but the cycle rate
  used the measured stride: a tall player's feet slid forward, a short one's back.
- **Facing.** The facing target kept the last one when the player was nearly still with the ball
  at his feet, so after a seek it was whatever the previous frame had shown. One threshold at
  0.7 m/s chose between his run and the ball: 820 target flips over 90 degrees in the window above.
- **Chained variants.** Each variant faded out over 0.4 s and the next faded in from 0 after it
  ended, and the keeper's two beats after a goal (head clip, then hands on hips) did the same.

### What changed

- **Half time** (`track.js`). `halfSpan` gives the half a match time is in; `hermiteAt` treats the
  half's last sample as the end of the data (its last 0.1 s goes on at the end velocity) and
  `rootAt` reads only its own half. `velocityAt` is the speed of a path inside its half; the scene
  (`scene3d.js`, both the shown and the tracking speed) and awareness (`awareness.js`) use it.
- **Motion loops** (`players.js`). `motionLoop` gives the loop playing a bonus of 0.35 on the
  match (`LOOP_HOLD`), about 14 degrees past the diagonal, and `animatePlayer` cross-fades the
  loops' shares over 0.15 s (`LOOP_FADE`); a seek starts from the one picked.
- **Head look** (`awareness-rig.js`). The look is turned by k = (1 - action weight) x (1 - M_
  emotion weight) x (1 - head clip weight), and a head clip fading out under the next gesture
  gives way by the gesture's weight.
- **Strides** (`players.js`). The cycle rate of the forward gait, the person's stride of the warp
  and the motion loops' strides and speeds are times `p.h`, the player's height over the
  measured one (`scene3d.js`).
- **Facing** (`players.js` `wantFacing`, called by `scene3d.js`). His run once faster than 0.9 m/s
  until he slows under 0.7 m/s; nearly still, the ball. A seek (dt 0) decides from that frame
  alone: the ball's bearing even at his feet, the centre spot without a ball. A NaN yaw or yaw
  speed resets the spring.
- **Chained variants** (`awareness.js`). An emotion that starts by the end of the last one of the
  same player, source and kind keeps that one at full weight under it while it fades in (the
  variants now overlap by 0.25 s, `FADE_IN`); `animatePlayer` keeps a full-body clip under it on
  the legs it covers.
- Small: a missing clip warns once per name; the fist clip is looked up only when an emotion
  asks for it; `MODES` is no longer exported by `players.js`.

### Numbers (node, 60 Hz)

| | Before | After |
|---|---|---|
| Player-frames within 0.5 s of half time with a speed artefact over 0.5 m/s, M001 / M002 / M003 / M004 (of 1320 each) | 459 / 460 / 458 / 459 | 0 / 0 / 0 / 0 |
| Worst speed artefact there | 874 to 952 m/s | 0 |
| Players over 5 m/s at period1_s, each match | 22 | 0 |
| Root off the sampled path there | 6.4 to 7.0 m | 0.011 m |
| Motion-loop swaps, M001 600 to 900 s (12.6 player-minutes of backpedal and strafe) | 293 (23.2 a minute) | 228 (18.0 a minute) |
| Swaps back within 0.3 s | 15 | 8 |
| Largest change of a loop's share in a frame | 1.000 | 0.105 |
| Facing target flips over 90 degrees in that window | 820 | 687 |
| Lowest emotion weight between two chained variants, DEMO (22 pairs) | 0.00 | 1.00 |
| `animatePlayer` for 22 players a frame (node, two runs each, best of three) | 19.3 to 19.4 us | 21.8 to 24.8 us |

A hold of 0.25 gave 19.4 swaps a minute and 10 back; 0.5 gave 16.2 and 4 but keeps the old loop
further off his travel. A facing drop-out under 0.7 m/s (0.9 and 0.5 m/s) cut its flips to 638
but added three facing snaps over 15 degrees in a frame on DEMO at 91.8 s, where two players turn
on the spot: in their slowest frames the run's direction is noise and the facing followed it
round. 1.1 and 0.7 m/s cut the flips to 600 but leave a player who sets off at 1 m/s facing the
ball. 0.9 and 0.7 m/s were kept. Most flips left come as a player stops or sets off (run to
still 302, still to run 245).

Checks, each shown failing with its fix undone first: `tests/web/players-review.test.mjs` (half
time on M001 to M004 with the old `track.js`: "459 of 1320 player-frames with a speed artefact
over 0.5 m/s (worst 943.2 m/s)"; no hold: "the loop changes at the same angle both ways (gap
0.5 degrees)"; no cross-fade: "a loop's share moves by 1.00 in a frame"; the height ignored: "a
player 12 % taller steps at 1.000 of the cadence, want 0.893"; the old facing: "a seek faces the
ball: 0, 2"; one threshold at 0.7: "0.75 m/s flips to the run"; the old head look: "the head
turns 0.000, want 0.600"; the old emotions: "the emotion's weight dips to 0.00").

In the browser, on the final code: `sample3d-shots.mjs` passes (0 facing snaps over 15 degrees in
a frame, jog slide 0.076 m per step), `kick3d-shots.mjs` passes in both looks, `view3d.mjs` on
M001 passes, and `frame-cost.mjs` (WebGL 2, from 530 s) counts 376 draw calls, as before.

## 10. The keeper on the grass after a dive

On the M001 goal at 595 s the keeper dived with `GK_Dive_R` and lay half buried: the clip's root
drops about 0.8 m while the lying pose is only 0.2 to 0.3 m thick, so the right upper arm ended
0.26 m under the pitch and the head and spine up to 0.10 m.

- **Grounding.** While a real clip has the keeper down (its root more than 0.15 m under the
  grass, the depth at which `body()` starts easing the others off him), after the arms are aimed,
  `KeeperRig._ground` reads the height of every joint and raises the holder by the deepest
  shortfall against `GROUND` in `keeper3d.js` (a rough body thickness per joint: 0.13 m at the
  head, 0.10 m at the spine and pelvis, 0.03 to 0.07 m at hands and legs, 0 at the toes). Standing,
  setting or getting up he is never moved. One pass updates the joints' world matrices, parents
  first, with no allocation in the frame.
- **Direction.** The dive already goes to the ball's side on every goal: the broadcast camera is
  at y = -34, the ball crosses 0.8 m inside the far post (y 36.85 of 37.66) and the keeper's hips
  go from y 35.3 to 36.76. He reads as diving wide because he stands 3.4 m off his line, which
  from this camera puts him beside the far post.

| M001 595 s dive, browser measurement every 0.1 s | Before | After |
|---|---|---|
| Lowest joint | -0.258 m (right upper arm) | +0.005 m (a toe, standing up) |
| Lowest joint while lying | -0.258 m | +0.05 m |
| Lowest head or spine joint | -0.095 m | +0.18 m |

Checks: `tests/web/keeperball3d.test.mjs`, "a beaten keeper dives towards the side the ball goes
in" (12 goals on M001 to M004) and "a keeper lying after his dive is raised until no joint is in
the pitch" (the joint heights measured before the fix at 595.97 s), and "the rig lifts a keeper
lying in the pitch onto it, and never one standing or getting up" (`_ground` on a Babylon node
tree: no lift standing, getting up with a toe on the grass, with the root up, or on a procedural
pose).
