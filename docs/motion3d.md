# Real motion for gestures and defending gaits in the 3D view

The awareness layer (`docs/awareness3d.md`) gave the players emotions and defending gaits, but the
bodies came from nine procedural `SD_` poses (arm directions keyed on the mannequin) and the
backpedal, strafe and jockey gaits were the forward run reversed or shortened. Both looked stiff.
This piece replaces them with generated motion capture quality clips, retargeted onto the same
skeleton. `sample3d.html?motion=procedural` keeps the old poses for comparison.

## Source and licence

NVIDIA Kimodo, model **Kimodo-SOMA-RP-v1** (SOMA skeleton, 30 fps), driven through NVIDIA's public
demo Space https://huggingface.co/spaces/nvidia/Kimodo on 18 Oct 2026. No SMPL-X model was used,
nothing was paid for, and no Hugging Face token was needed (the Space is public).

- Model card, https://huggingface.co/nvidia/Kimodo-SOMA-RP-v1: "This model is ready for commercial
  use." Licence: NVIDIA Open Model License.
- NVIDIA Open Model License (last modified 24 Oct 2025),
  https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/:
  "Models are commercially usable." "NVIDIA does not claim ownership to any outputs generated using
  the Models or Derivative Models." "An output is not a Derivative Model." Its notice,
  "Licensed by NVIDIA Corporation under the NVIDIA Open Model License", is in
  `web/vendor/motion/LICENSE.txt`.
- We ship outputs only (joint rotations), never the model or its training data. Kimodo-SOMA-RP is
  trained on the proprietary Bones Rigplay set; no BONES-SEED raw data was downloaded.
- Not used: Mixamo, BONES-SEED raw data, Hunyuan / HY-Motion, anything
  non-commercial. 100STYLE (CC BY 4.0) was the fallback for the locomotion loops: see the verdict.

The Space has no API. `scripts/retarget_motion.py` does not talk to it: the clips were generated
by a throwaway websocket client (the Space's Viser UI protocol: set the prompt and its length on
the timeline, press Generate, download the NPZ), and only the reduced joint data is committed.

## Pipeline

1. `scripts/motion/<name>.npz`: from each Kimodo NPZ export, the global rotations and positions of
   the 22 SOMA joints we map, plus four foot contact flags (heels and toes). float32, about 50 KB a
   clip. `scripts/motion/clips.json` lists every clip with its prompt, length, seed and flags
   (`loop`, `repeat`, `full`).
2. `.venv/bin/python scripts/retarget_motion.py build` writes `web/vendor/motion/clips.glb` (one
   glTF animation per clip on the 65 UAL joint names, rotations as normalised int16) and
   `web/vendor/motion/clips.json` (length, loop, ground speed, direction, stride, full body flag
   and the measured foot slide of every clip).

Retarget, numpy only. Kimodo's global rotations are the identity in its T-pose and the UAL
mannequin's rest pose is a T-pose in the same frame (Y up, +Z forward, left at +X), so each mapped
bone gets `G = H(t) · D_joint(t) · R_rest`, where `H` removes the clip's heading smoothed over
0.5 s (the tracking owns the facing). Locals come from the parents. The hips keep their height
and their sway around the smoothed path, scaled by the leg length ratio (0.97); the path itself
is removed, since the tracking owns the root. Fingers are not keyed, so they keep whatever the
other clips give them. Loops are cut where the legs come back closest to the start (0.6 to 2.4 s)
and cross-faded over 6 frames.

## In the scene

- `players.js loadMotion(scene)` loads the two files once; `sample3d.js` calls it before the
  awareness rig unless `?motion=procedural`.
- Emotions (`awareness.js`, option `motion`): the facts and events that start an emotion are the
  same as before; only the clip changes. Each stand-in maps to its real clips, picked per player
  and event by hash (a scorer gets one of four celebrations, teammates a hug, a high five or a
  jump). A one-shot clip lasts its own length; a longer window chains the next variant.
- Full-body clips (knee slide, jump, crouch) play on the whole body only while the player is
  nearly still (under 1.5 m/s) and no ball action or leg pose holds him; otherwise they are masked
  to the upper body over the locomotion. The awareness driver also forces upper body only when the
  ball rig or an action owns the legs.
- Gaits: backpedal and strafe pick the loop whose travel direction in the clip matches the run
  direction in the character's frame best (jog backward, side-step left or right); jockey plays
  the shuffle. The loop's phase follows the ground speed over its stride, so the feet do not slide
  at the clip's own speed. Without the clips the old stand-in gaits play.

## Goalkeeper clips

Six full-body clips for the keeper, generated and retargeted the same way but not yet played by the
scene (a separate driver will): `GK_Dive_L`, `GK_Dive_R` (full-stretch dive, 2.5 s), `GK_Low_L`,
`GK_Low_R` (low dive, 2 s), `GK_Catch` (catch at chest height, 2 s) and `GK_Tip` (jump to tip the
ball over, 2.5 s). The prompts are in `scripts/motion/clips.json`; the first prompts, worded as
"a goalkeeper dives to his left", gave a keeper lying down in place or diving forwards, so the
kept ones describe the movement ("jumps sideways far to their left, ... falls onto the ground on
their left side") and the seed was picked out of three by the measured travel.

A dive has to take the body away from the tracked spot, so these clips are flagged `root` in the
manifest: the heading stays the one at the start (the roll of the body is the motion), the pelvis
stays at its rest position in the glb, and all the hips' travel goes to `clips.json`:

    "GK_Dive_L": {"len": 2.5, "loop": false, "full": true, "slide": 0.038,
                  "root": [[left, up, forward], ...]}    one row per frame at clips.json "fps" (30)

in metres, in the character's own frame at the start of the clip: `left` towards the keeper's left
(glTF +X; in Babylon the character's left is local -X, so the holder moves by `-left` along its
local X), `up` the hips' height over standing height (negative when crouched or lying), `forward`
towards where he faces. Frame 0 is about zero. A driver plays the clip at full weight and adds
`root[frame]`, turned by the holder's facing, to the holder position. Measured ends: Dive_L 1.55 m
to the left, Dive_R 2.15 m to the right, Low_L 1.03 m, Low_R 1.15 m, Catch and Tip under 0.05 m;
the hips drop to 0.8 m under standing for the dives (lying on the side), and the tip jump lifts
them 0.44 m. Foot slide with the root curve applied: 0.01 to 0.09 m/s.

## Results

- The sheet (`out/shots/motion3d-sheet.png`, 25 rows, the old pose on the left of each row) is the
  main evidence: every gesture is readable at broadcast distance, the celebrations and the
  dejected or crouched poses have weight shifts and timing the procedural poses never had, and the
  backpedal, side-steps and jockey move the legs the way their names say instead of a reversed run.
- 100STYLE was not needed: the Kimodo loops close with no visible pop after the cross-fade.
- Foot slide (feet in contact moving over the ground, from the clip's own contact flags): 0.17 to
  0.28 m/s on the loops before the phase is tied to the ground speed, which is why the scene
  drives the phase from the tracking; one-shots mostly under 0.1 m/s, `join_hug` 0.355 m/s but it
  only ever plays on the upper body.
- Limits seen: the jockey is a single sideways shuffle, so it looks the same whichever way the
  defender actually drifts. A celebration often plays on the upper body only, because the tracked
  scorer is still running (above 1.5 m/s): in the celebration still the scorer runs with his hands
  to his face, while the procedural still shows both arms up. The goalkeeper clips are in the glb
  but nothing in the scene plays them yet.
- A bug found on the way, present in the procedural mode too: when the first two animations
  Babylon blends on a skeleton both have weight 0, its weighted slerp divides 0 by 0 and the bones
  become NaN, so the player disappears. Clips are now advanced only while their weight is above 0.
  The 20 s sweep found 40 NaN frames on the motion page and 1 on the procedural page before the
  fix, 0 after it.
- Frames per second, software WebGL, the same 20 s window measured in the order
  procedural, motion, procedural, motion: 5.1, 15.6, 12.4, 15.4 (an earlier run: 24.0, 11.5,
  29.5). The noise between runs is larger than any difference between the modes, so the clips
  cost no measurable frame rate here; a real GPU was not measured.

## Tests

- `.venv/bin/pytest -q tests/test_retarget_motion.py`: the UAL skeleton has 65 joints; a T-pose
  source gives back the rest pose exactly; every committed clip retargets with 22 unit quaternions
  and no NaN; every limb segment of the retargeted body points where the source limb points
  (95th percentile under 12 degrees; swapping the arms or flipping an axis fails it on every
  clip); the glb has the armature plus the 65 joints and 23 channels per clip. For the goalkeeper
  clips: the pelvis stays at rest and the root curve equals the source hips' travel from the start;
  the left dives end more than 1 m (low: 0.5 m) to the left, the right ones to the right, the catch
  and the tip stay within 0.5 m and the tip lifts the hips more than 0.15 m.
- `node --test tests/web/awareness.test.mjs`: with `clips.json`, the emotions keep exactly the
  same sources, more than half play on real clips, one-shots never outlast their clip, and every
  scorer still celebrates.
- `scripts/with-lock.sh chromium tests/web/run-smoke.sh motion3d-shots.mjs`: the sheet, the two
  stills with and without the clips, frames/s twice per mode, and a sweep of the 20 s every 0.08 s
  that fails on any NaN bone.

## Kicks with the whole body

At first only the kicking leg moved (`LEG_KEYS` in `web/js/ball3d.js`), so a shot and a pass
looked the same from the broadcast camera: the trunk and the arms kept the run. Now every leg
action also has keys for the standing leg, the pelvis, the trunk and both arms (`SUPPORT_KEYS`,
`BODY_KEYS`, `bodyPose`), driven by the same ball events and the same weight, which fades in over
0.16 s at the start of the action window and out over the last 0.16 s. `ball3d-rig.js` applies
them after the clips and the leg pose, before grounding.

### What the research says

| Phase | What happens | Source |
| --- | --- | --- |
| Approach | best at about 45 degrees to the kick line (30 to 60); accurate kicks are slower | Kellis and Katis 2007, https://pmc.ncbi.nlm.nih.gov/articles/PMC3786235 |
| Last stride | longer than the others, and longer for a 45 m kick than a 25 m one; the run-up brakes into it | Shan and Westerhoff 2005 in https://pmc.ncbi.nlm.nih.gov/articles/PMC3224572/ ; https://hrcak.srce.hr/en/94562 ; https://lida.sport-iat.de/dfb/Record/4020407 |
| Plant | standing foot 5 to 28 cm beside the ball and a little behind it, pointing along the kick | PMC3786235 (Hay 1993); https://arxiv.org/html/2407.14612v1 |
| Backswing | kicking hip extended up to about 29 degrees, knee flexed past 100 | PMC3786235 (Levanon and Dapena 1998) |
| Tension arc | at the top: kicking hip back, trunk turned the other way, the free arm out to the side and back | Shan and Westerhoff 2005, in PMC3224572 |
| Release | the leg whips through; the upper trunk flexes and turns towards the kicking side, the free arm comes in and across | PMC3224572 |
| Contact | hip flexed about 20 degrees, ankle plantarflexed for the instep | PMC3786235 |
| Follow-through | the leg keeps rising and crosses, the kicker lands forward on it, often with a hop | PMC3224572 |
| Side-foot pass | thigh turned out from the hip, pelvis more side-on at contact, slower foot (18.3 against 21.6 m/s), smaller knee share of the swing | Levanon and Dapena 1998, https://www.bisp-surf.de/Record/PU199807303122 ; https://ojs.ub.uni-konstanz.de/cpa/article/view/2248/2104 ; https://commons.nmu.edu/isbs/vol38/iss1/29 |
| Lofted kick | little measured; the kicker leans back and gets under the ball | Browder 1991, Prassas 1990, cited in https://journal.kannuruniversity.ac.in/ijssp/common/viewarticle/7 |

From animation practice: anticipation (the wind-up) and follow-through are what make an action read
(https://education.siggraph.org/static/HyperGraph/animation/character_animation/principles/anticipation.htm).

### What we adopted

Times are seconds from foot-ball contact, angles degrees, for a right-foot kick (a left-foot kick
is mirrored). The windows are the ones of `docs/ball3d.md`: 0.5 s either side for the shot and
the long ball, 0.42 and 0.4 for the pass.

| | Shot | Long ball, cross | Short pass |
| --- | --- | --- | --- |
| Kicking leg | instep; backswing to hip -46, knee 110 at -0.11; leg up to hip 64 at +0.1, coming down at once (50 at +0.2, 24 at +0.32) | instep; hip -40, knee 100; up to 60 | side foot, thigh turned out 50; hip -26, knee 72; up to 40 at +0.13, still 28 at +0.25 (follow-through) |
| Plant leg | swings through high (-0.3), reaches out at -0.14, lands, knee gives to 34 at contact, the body rolls over it | the same | pushes off behind (-0.42), a short step, landing at -0.09 |
| Pelvis | 16 back at the top, 18 through after contact | 14 back, 14 through | 10 back, side-on at contact, 6 through |
| Shoulders | 12 the other way at the top, 12 through after | 10, 8 | 8, 5 |
| Trunk | 8 over the ball at contact, 10 after; 10 to the plant side | 10 back at contact; 14 to the plant side | about 5 forward, upright |
| Free arm | out to 85 and 35 back at the top, 75 at contact, sweeps 30 forward after | out to 90, 85 at contact | a smaller tension arc: out to 52 and 22 back at -0.1, 48 at contact, 22 forward after |
| Kicking-side arm | 25 forward at the top, 25 back after | 15 forward, 20 back | 14 to 16 out, 14 forward at the top, 14 back after |

Touches and traps keep small values: 2 to 8 degrees of trunk and pelvis, and the arms stay the
clips' (a dribble keeps the running arm swing; a trap takes a third of the arm pose). The pass
arms replace the clip's arms fully (they were once at 0.7 and 28 degrees, and
the pass read as a leg moving on its own).
The plant timing (landing about 0.1 s before contact) and every angle above that is not in the
research table are our choices, set by looking at `tests/web/kick3d-shots.mjs`.

How the layers combine: the pelvis, trunk turns and lean are added to whatever the clips did
(the standing thigh turns back by the pelvis angle, so the planted foot does not twist); the arms
and the plant leg are poses of their own, blended over the clips with the action weight. The
awareness look-at and the keeper's arms still run after this layer. The pelvis angle at contact
is part of the reach measured on the probe, so the foot still meets the ball.

### Tests

- `node --test tests/web/ball3d.test.mjs`: every layer is 0 at the window edges and full at
  contact; no channel jumps more than 45 degrees (legs) or 20 (trunk, arms) between two 30 fps
  frames; the shot has the biggest backswing and the pass the smallest; the pass turns the thigh
  out by 45 or more; the free arm goes past 80 on the shot and the long ball and to 40 to 65 on
  the pass; trunk forward on the shot, back on the long ball, upright on the pass; hips and
  shoulders turn opposite ways at the top of the shot backswing; the plant hip goes from ahead to
  behind across contact.
- `scripts/with-lock.sh chromium tests/web/run-smoke.sh kick3d-shots.mjs [match]` (LOOK=anime,
  BEFORE=1 for the legs-only rows): `out/shots/motion3d-<kind>-close.png` and
  `motion3d-<kind>-broadcast.png` for the first shot, pass and long ball of the clip.
- `scripts/with-lock.sh chromium tests/web/run-smoke.sh feet3d.mjs`: the planted soles stay on the
  grass with the layer on.

## The goal

In the first goal clip the goal did not read as a goal: the ball stopped on
the line (the tracking ball ends at about 104.77 m), the net stayed flat, the keeper crouched,
nobody reacted for a second and the camera cut to a frozen close-up. This section is the research
behind the fix and what was built. The data and the simulator are unchanged: everything here is
how the 3D view draws them.

### What the research says

| Topic | Finding | Source |
| --- | --- | --- |
| Keeper set position | feet about shoulder width, knees bent, weight forward on the balls of the feet, hands relaxed in front with elbows bent | https://sportsessionplanner.com/s/tzDYh/Positioning.html ; https://sportsessionplanner.com/s/cM5fb/2-Yard-Goal-2.0.html |
| Keeper set timing | the keeper is still and set as the shot is struck; a keeper whose feet are moving or in the air cannot push off in time | https://learn.rushsoccer.com/?p=17715 |
| Lateral dive | 15 keepers, 213 dives: the keeper moves after choosing a side; the leg opposite the dive drives the centre of mass across; the trunk leans towards the dive for low balls | https://lida.sport-iat.de/ta/Record/4056953 |
| Lateral dive | the preparatory foot position changes the dive; the contralateral leg produces most of the lateral velocity | Monteiro et al. 2022, Scientific Reports, doi:10.1038/s41598-022-21508-6 (https://scilabiocom.eeferp.usp.br/pdf/Monterio_SciReports.pdf) |
| Net simulation | the ball enters the cloth, carries it back, then the cloth throws it off and it drops | https://people.engr.tamu.edu/sueda/courses/CSC474/2015W/demos/baujla/index.html ; https://discussions.unity.com/t/soccer-game-more-realistic-net/147596 |
| Net in Babylon | the cloth impostor (physics soft body) is too slow on phones | https://forum.babylonjs.com/t/whats-the-best-way-to-create-cloth-soft-body-animations-and-how-to-import-from-blender-cinema-4d/16451 |
| Celebration | 366 goals: outstretched arms in 33.6%, a fist in 29.8%, team-mates join in 90.4%; 61.6% combine a solo act and a team act; on average 24.9 s | Lev et al. 2020, PLOS One, https://pmc.ncbi.nlm.nih.gov/articles/PMC7494092/ |
| Joy | winners across cultures raise their arms, push the chest out and tip the head back | https://www.scientificamerican.com/podcast/episode/winning-athletes-raise-arms-x-cultures/ |
| Conceding | players who are losing show it at once: head down, shoulders in, hands on the head or the hips | Furley and Schweizer 2014, J Nonverbal Behav, doi:10.1007/s10919-013-0168-7, via https://bps.org.uk/research-digest/no-need-look-score-athletes-body-language-gives-away-whos-winning-and-losing |
| TV after a goal | the director goes to close-ups of the celebration (steadicams are allowed on the pitch for it) and the replays follow | https://insidersport.com/2025/05/08/premier-league-goal-celebration/ ; https://www.champions-journal.com/1000/directors-cut |

No written rule on how long after a goal the cut comes was found; we keep the wide shot for 1 s
so the reactions start in it.

### What we built

- **The ball into the net** (`BallPlan._nets` in `web/js/ball3d.js`). For every goal the plan
  takes the ball over 2.5 m before the line, with the velocity the tracking had there, and
  integrates it at 240 Hz: gravity, and four net planes (back, roof, two sides) as damped springs
  (natural frequency 14 rad/s, damping ratio 0.7) with tangential grip, so the net catches the
  ball, carries it back about 0.7 m and lets it drop; then a bounce at 0.5, rolling friction and,
  after the release, a small ripple in the net. The pocket outlasts the ball's push: it billows
  to its deepest and relaxes over 0.4 s while the ball drops. The ball ends on the grass about 1.6 m inside the
  goal on M001. `plan.net(ts)` says which panel is pressed, where and how deep; `check()` leaves
  the net window out because the tracking ball is no longer the reference there.
- **The bulging net** (`web/js/scene3d/net.js`). Each goal's netting is one grid mesh (a vertex
  every 0.2 m); the pressed panel's vertices move along its normal in a Gaussian pocket (sigma
  0.8 m, wide enough to read from camera 1) that is pinned at the frame and looser at the pegged bottom edge. No physics engine.
- **The keeper** (`web/js/keeper3d.js`). Every reaction now starts with a set position 0.6 s
  before the shot (blended in over 0.3 s): with the real clips it is the frame just before the
  dive pushes off, otherwise the stance. A beaten keeper always takes the lateral dive towards
  the ball side (not the crouch), 1.5 times the clip's own speed from 0.15 s after the shot (in the air as the ball passes), and stays down until
  0.5 s after the clip has landed.
- **The first second** (`web/js/awareness.js`). The scorer starts celebrating 0.15 s after the
  goal, with arms wide first (they read on a running body), then arms up; the nearest team-mate
  sprints over from 0.3 s before the goal (an offset on his track); the others join from
  0.3 s, the conceding side slumps from 0.35 s, and the beaten keeper stays down after his dive. For 14 s after a
  goal bodies are pushed apart: team-mates' centres at least 0.9 m, opponents 1.5 m (out of reach
  of a celebrating arm); the team-mate sprinting over steps round whoever is in his way, so a
  player kneeling in his path is not shoved off his knees.
- **No fact chips on TV** (`web/js/sample3d.js`): the 3D page asks the graphics for
  `v_showFactIds: false`; the 2D analyst page keeps them.
- **Cameras** (`web/js/scene3d/camera.js`, `web/js/scene3d/sightline.js`). Camera 1 tightens to
  30 m and leans towards the goal mouth inside 30 m of a goal line; on a goal it punches in from
  1.6 s before (the strike) to 16 m across, aimed 4 m out from where the ball enters the net, so the
  strike, the keeper's dive and the bulge read large until the cut. Around a kick it slides up to
  10 m along a rail when another player's head would hide the kicker's foot (kicks less than 3 s
  apart share one slide, so the pass and the shot do not swing it from side to side). Camera 2,
  the close-up, stands 18 m away at 2.2 m, frames 4.5 m (the whole body), averages the aim over
  2 s, and steps round up to 45 degrees until nobody walks between it and the scorer.

### Tests

- `node --test tests/web/net3d.test.mjs`: on M001 the scored ball crosses the line above
  10 m/s, pushes the net more than 0.3 m and rests inside the goal; the four panels lie behind
  the line; the pocket is full at the ball and zero at the frame.
- `node --test tests/web/flow3d.test.mjs`: a beaten keeper is set 0.5 s into the set phase, dives
  at no more than 1.5 times the clip speed and is still down 1 s after the ball went past.
- `node --test tests/web/awareness.test.mjs`: after a goal no two drawn bodies come within 0.7 m
  (the tracking alone does, on M001); the nearest team-mate runs to the scorer; a player standing
  on the keeper lying on the grass steps 1 m off him; the running team-mate steps round a player
  in his path and that player does not move.
- `node --test tests/web/sightline3d.test.mjs`: a head on the line of sight is found, the rail
  clears it, and eases on and off.
- `CLOCKS=... scripts/with-lock.sh chromium tests/web/run-smoke.sh goal3d-stills.mjs M001 <name>`:
  contact sheets of the clip camera and of a camera by the goal (`GOALCAM=...`).

### Results

Looked at frame by frame in `out/shots/goal3d-clip.mp4` (M001, clock 8 to 14, high profile).
At the strike camera 1 has punched in and the players stand about 90 px tall on a 1280 px frame;
the shooter's foot and the ball are clear of the nearest defender at contact. The keeper is in
the air sideways towards the ball before it passes him and stays down. The ball runs into the
goal and the net billows for about 0.4 s, visible but modest from camera 1. The lower third
arrives with its text. The cut to camera 2 at clock 13 has no repeated frame; the scorer
celebrates, the nearest team-mate is running in (he arrives after the clip ends), and the
defenders slump in different poses at different times.

Performance, `scene3d-perf.mjs high` with WebGL 2: 0.28 fps, 330 meshes, 431,806 vertices
before; 0.29 fps (runs 0.3, 0.3, 0.4), 332 meshes, 434,314 vertices after the first pass; 0.48 fps (runs 0.5, 0.5, 0.5), 332 meshes, 434,314 vertices after the third (the machine was less loaded).
