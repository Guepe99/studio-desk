# Flow in the 3D view: ball size, keeper reactions, smooth motion

Three complaints about the 3D sample: the ball looked giant, the keeper never dived, and the
players did not move like a video game. This note has the rules, the sources behind them and the
numbers before and after each fix, measured on M001.

Code: `web/js/scene3d/track.js` (smooth paths), `web/js/keeper3d.js` (keeper plan, pure),
`web/js/keeper3d-rig.js` (keeper in the scene), small changes in `web/js/scene3d.js`,
`web/js/scene3d/players.js` and `web/js/sample3d.js`.
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

### Real clips and the procedural stand-ins

When `web/vendor/motion/clips.glb` and `clips.json` are loaded (feat/motion3d), the reactions play
`GK_Dive_L`, `GK_Dive_R`, `GK_Low_L`, `GK_Low_R`, `GK_Catch` and `GK_Tip` on their root curve:

- On load the rig plays each clip on a probe scaled like the players and measures the hands frame
  by frame. Contact frame: for dives the first frame the hands are at 85% of their widest, for the
  catch the first at 90% of their furthest forward in the first 1.2 s, for the tip the highest.
- The run-up is time-warped so the contact frame lands on the contact time; after it the clip
  plays at 1x for 0.9 s (the landing), holds, and blends back.
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
- **Frame pacing**: the clock now advances by the real time between frames, capped at 0.5 s (a
  hidden tab). Before it was capped at 0.1 s, so below 10 frames per second the match ran slow.

### Numbers on M001

Measured by `tests/web/flow3d-measure.mjs` on the default clip of M001 (from 582.99 s, 12 s of
the live part, 22 players, stepped at 60 Hz without drawing), then the live page for 15 s for
the frame pacing. Software WebGL 1 on this server, low profile.

NUMBERS
