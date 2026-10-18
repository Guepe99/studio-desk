# Flow in the 3D view: ball size, keeper reactions, smooth motion

Three complaints about the 3D sample: the ball looked giant, the keeper never dived, and the
players did not move like a video game. This note has the rules, the sources behind them and the
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
| Games warp the root so the hands hit the contact frame | Unreal Engine Motion Warping | docs.unrealengine.com, Motion Warping |
| EA FC 26 keepers | machine learning used for positioning, the saves are still authored animations | ea.com/news/fc-26-goalkeepers |

No primary source gave a keeper's reaction time to a shot; 0.12 s is the visual reaction floor
used in sprint starts and is used here only so the keeper never moves before the ball does.

### Rules (keeper3d.js)

Only events and facts that happened decide a reaction:

- A **goal**: a shot with result `success` and a score fact within 0.5 s.
- A **save**: a shot whose next event in the same period, within 3 s, belongs to the other side's
  keeper and is not a goal kick. With a keeper event (`keeper_save`, `keeper_claim`,
  `keeper_punch`, `keeper_pick_up`) the contact time is that event; otherwise the shot must end
  within 3 m of the keeper and the contact is the moment the drawn ball comes closest to that end.
- For a goal the contact time is when the drawn ball passes the keeper (its distance ahead of him
  turns negative).

At the contact time the ball's offset from the keeper, in his frame (facing the shot), picks the
reaction:

| Reaction | When |
|---|---|
| tip over the bar | ball centre above 2.0 m |
| catch at the chest | within 0.7 m sideways and at least 0.45 m up |
| low dive | under 0.6 m and within 1.6 m sideways |
| full-stretch dive | everything else |
| beaten keeper | a goal: a low or full dive that starts 0.25 s after the shot and reaches only 25 to 60% of the way (the share of a 1 s dive he has time for) |

Timing: the keeper moves 0.12 s after the shot at the earliest, never before. When the clip's
natural run-up does not fit between that and the contact, it is played faster, up to 2.5 times; a
reflex save still shows at least 0.15 s of movement.

Body: the feet leave the tracked spot by 2 m at most, the body lifts, lands, stays down for a
moment and blends back onto the tracking in 0.8 s. Each reaction is cut short by the keeper's next
one.

### In the data

M001 has 8 shots that get a reaction: 3 catches and 1 low dive that are saves, 3 low dives and
1 full dive that are goals. DEMO has 3: a low save at 240.9 s and two beaten dives (100.6 s and
310.6 s). Neither match has a full-stretch save, so `GK_Dive_L` and `GK_Dive_R` are only seen
beaten, and `GK_Tip` is never picked (no saved shot above 2 m).

### Real clips and the procedural stand-ins

When `web/vendor/motion/clips.glb` and `clips.json` are loaded (feat/motion3d), the reactions play
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
- **Clip blending**: the locomotion weights ease towards their target with a 0.08 s time
  constant instead of jumping when the speed or the mode changes.
- **Camera**: the broadcast camera's safe-area limit counts a lofted ball at 3 m at most and
  never aims off the pitch (`web/js/scene3d/camera.js`, two lines).
- **Frame pacing**: the clock now advances by the real time between frames, capped at 0.5 s (a
  hidden tab). Before it was capped at 0.1 s, so below 10 frames per second the match ran slow.

### Numbers on M001

Measured by `tests/web/flow3d-measure.mjs` on the default clip of M001 (from 582.99 s, 12 s of
the live part, 22 players, stepped at 60 Hz without drawing), then the live page for 15 s for
the frame pacing. Software WebGL 1 on this server, low profile. Before is origin/main at 881caa9
(feat/motion3d merged), after is this branch on top of it; same window, same script.

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
- The clock ran at half speed before: at about 6 frames per second on this server each frame is
  167 ms, and the old cap of 0.1 s per frame threw the rest away. This is the biggest visible change
  on a slow machine. The optimizer applied no steps in either run.
- Not fixed: the foot slide p95 at a walk and in sprints (0.6 to 0.9 m) comes from starts, stops
  and the stand-in modes (backpedal, side-step, jockey loops from feat/motion3d), where the clip's
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
Their limits sit between origin/main and this branch there: acceleration p95 24.2 before, 12.9
after (limit 16); jog slide median 0.111 before, 0.086 after (limit 0.1); facing snaps 35
before, 0 after (limit 0); ball radius 0.17 before, 0.11 after; keeper reactions 0 of 1 before,
1 of 1 after; hands to ball at the DEMO save 0.85 m with the keeper layer off, 0.22 m with it on
(limit 0.5).
