# Broadcast look for the 3D view

The first 3D sample did not look like television: a near camera on a wide lens, flat daylight,
players floating on the grass and no picture processing. This note has the rules a football
outside broadcast follows, the numbers we took from them, what the scene does now, and the
measurements before and after, so every claim can be checked.

Code: `web/js/scene3d/camera.js` (cameras and cutting), `web/js/scene3d/post.js` (post chain and
grade), `web/js/scene3d/lighting.js` (night and day light, floodlights), `web/js/scene3d/grounding.js`
(contact and blob shadows), `web/js/scene3d/quality.js` (profiles), small changes in
`web/js/scene3d.js`. Tests: the new checks in `tests/web/sample3d-shots.mjs`; stills from
`tests/web/broadcast3d-stills.mjs`.

## 1. Cameras and cutting

### Rules and sources

| Rule | Number | Source |
|---|---|---|
| Main camera on the halfway line, back from the near touchline | 30 to 40 m back, 60 m at most | Free TV Australia OP-32 (Issue 4, 2015), 2.2.2 |
| Line of sight from the main camera | 20 to 30 degrees down to the near touchline, 12 to 16 degrees to the centre of the pitch | OP-32, 2.2.2 |
| Main camera tilt to the centre spot | about 12 to 15 degrees, on the halfway line, away from the setting sun | UEFA Champions League regulations 2025/26, annex E.2.1 |
| Goal cameras | on the long axis behind each goal, line of sight 12 to 15 degrees | OP-32, 2.2.7 |
| Offside cameras | in line with each penalty box, at the height and angle of the main camera | OP-32, 2.2.7 |
| Low cameras | on swivelling low mounts in line with each 18-yard line | OP-32, 2.2.8 |
| Handheld | one roving handheld camera along a sideline, among 5 to 6 field cameras for football | OP-32, 2.2.8 |
| Cutting | the director stays on the wide camera in play and cuts to close-ups and replays at stoppages | SVG Europe on match direction; FIFA Stadium Guidelines 6.2 (camera plan) |
| Shutter | TV sport runs about 1/100 to 1/120 s, so no visible motion blur on a still | broadcast practice, no single primary source found |

OP-32: https://www.freetv.com.au/wp-content/uploads/2019/08/OP-32-Outside-broadcast-requirements-for-rugby-league-rugby-union-and-soccer-Issue-4-January-2015..pdf .
UEFA: https://documents.uefa.com/r/Regulations-of-the-UEFA-Champions-League-2025/26/E.2.1-Main-cameras-Online .
No source gave a published focal length for the wide shot. The lens below is our own choice: from
70 m away, a frame of 24 to 42 m of pitch keeps about a third of the pitch in view, as the wide
shot of a match broadcast does.

### What the scene does

- **Camera 1, live:** at (0, 18, -68) in scene metres: on the halfway line, 34 m back from
  the near touchline and 18 m up. That puts the line of sight 27.9 degrees down to the near
  touchline and 14.8 degrees to the centre spot, inside both OP-32 ranges, 70.3 m from the spot.
  It stands on a short rail along the touchline: around a kick that a player's head would hide
  from the lens, it slides up to 10 m along the rail, the smallest slide that shows the kicker's
  foot (`web/js/scene3d/sightline.js`).
- **Long lens:** 24 to 42 m of pitch across the frame at the aim point, which is 19 to 33 degrees
  across. The old camera stood near and wide; from 70 m on a long lens depth flattens the way TV
  pictures do. A phone-sized frame zooms in further (to 0.65 of the width) so players stay readable.
- **Operator:** the aim is 65% ball and 35% the centroid of the nearby players, plus 0.7 s of the
  ball's velocity as lead (so the frame opens in the direction of play). Pan and zoom follow a
  critically damped spring with a dead zone, so nothing snaps or overshoots; a hard limit keeps
  the ball in the middle 80% of the frame.
- **Tight shots only at a stoppage:** camera 2 is a pitchside handheld on a long lens. It takes a
  tight shot of the scorer from 1 to 6 s after a goal, of the fouler after a foul and of the keeper
  after a save. For fouls and saves the shot runs from 1 s after the event until 6 s after it or
  0.5 s before the next event, whichever comes first, and only if that leaves at least 2 s, so the
  cut back to camera 1 always comes before play restarts. On M001 that gives 17 fouls and 4 saves,
  every one followed by a free kick or a corner. The camera stands
  where the player was when the stoppage began, 18 m from him on the near touchline side and a
  little towards the halfway line (never more than 4 m outside the lines), 2.2 m up, and stays put
  for the shot. If another player would walk between him and the player during the shot, the
  operator steps round by 15 degrees at a time, up to 45, to a place where nobody does
  (`sightline.js`). The frame is 4.5 m across at the player, aimed 0.95 m up: head to feet with
  room for raised arms, nearly level, with the boards and the far stand behind him, on a lens of
  about 14 degrees (capped under 16), with depth of field on the high profile. The aim follows
  the player's position averaged over 2 s. Two earlier versions shot from the main platform, 18 m
  up and 14 degrees down; they read as a view from above with nothing but grass behind the
  players.
- **Replays:** one free camera at four angles: the goal camera (14 m behind the goal line on the
  long axis, 13.5 degrees to the penalty mark), a pitch-level camera in line with the 18-yard line,
  the reverse angle from the far stand and a high tactical view. A goal replay runs 5.5 s from
  when camera 2 leaves the scorer: 2.5 s from behind the goal at full speed, ending 1.6 s after
  the ball crosses the line, then 3 s from pitch level at half speed on the strike, as broadcasts
  slow the decisive touch (`view3d.js` REPLAY). Both angles are anchored on the shot event and on
  the first tracking sample with the ball on the goal line, not on the goal fact's time, which can
  come up to 1.5 s after the strike: each starts at least 0.3 s before the strike and shows the
  ball crossing the line (on M001 to M004 the old windows missed the strike in 8 of 12 goals on
  the first angle and 7 of 12 on the second; `tests/web/view3d.test.mjs`). The slow angle runs
  faster than half speed only when the flight is too long for its 3 s (0.66x on one goal of M002).
- **Shots and the player on the ball:** every shot that is not a goal gets a short punch-in on
  camera 1 towards where it ends (22 m wide, 1.2 s held, 1.2 s out, `camera.js` SHOT_PUNCH). In
  open play the shirt and surname of the player on the ball hang over his head, our choice to
  keep the play readable from 70 m (`view3d.js` CARRIER): the player of the next touch, while the ball is on the ground within
  2.5 m of him for 0.2 s.

### Cutaways at stoppages

At a throw-in or a goal kick a match broadcast shows the crowd and the stadium. The rules we
follow:

| Rule | Number | Source |
|---|---|---|
| The director stays on camera 1 in play and directs when the ball is dead | "when the ball's not in play, that's when a director directs"; camera 1 "as much as I can" | UEFA Champions Journal, "Director's cut" (a Champions League final director) |
| Cut only once the ball has gone out | "I prefer to cut when the ball has gone out of play" | SVG Europe, interview with a FIFA World Cup 2022 host-broadcast director (9 Dec 2022) |
| Crowd and bench shots are their own cameras, called live at stoppages | "Fans on five, manager on 13" | Champions Journal, as above |
| A "public" camera filming the crowd is one of 13 camera classes of a match broadcast; one camera change every 9 s on average (583 a game), replay shots 6.8 s on average | 200 fully annotated games | SoccerNet-v2 (Deliège et al., CVPR Workshops 2021), camera shot segmentation |
| Length of one cutaway | 4 to 5 s | our choice: no source gives one; it is shorter than the 9 s average shot and the 6.8 s replay shot above, so the restart is never missed |
| How often | every stoppage with room for a shot, unless the previous cutaway ended under 20 s before | our choice: no source gives a rate. The first rule (at least 60 s apart, about half of the stoppages) left most pauses on camera 1. Now about one a minute (median 51 s apart on M001) |
| Back on camera 1 before the restart | 4 s before a throw-in (the taker raises the ball over his head from 1.6 s before it, `players.js` THROW), 3 s before any other restart | our choice, over the 0.5 s floor the tight shots keep |

Sources: https://www.champions-journal.com/1000/directors-cut ,
https://www.sportsvideo.org/?p=232815 , https://arxiv.org/abs/2011.13367 .

What the scene does (`web/js/scene3d/cutaway.js`, used by `camera.js`):

- **Which stoppages:** the dead ball before a throw-in, a goal kick, a corner or a free kick. The
  cut comes 1.5 s after the ball is dead: the first tracking sample with the ball on the ground
  (under 0.5 m) and on or over a line, or at rest (the simulator parks a ball that goes out on the
  line itself, so a ball still in the air never counts). After a foul it comes right after camera
  2's tight shot of the fouler, cutting straight from it. No cutaway and no cut to camera 2 above
  4x, the fastest speed the goal replays play at: at 16x a 4 s shot would only flash by (camera 1
  stays on, and lets a goal's punch-in go as it does a shot's). After a goal the celebration and
  the goal replay come first, then one cutaway before the kick-off, cut straight from the replay
  (11.5 s after the goal: `CELEBRATION[1]` plus `REPLAY_LEN`). The match data has no substitutions
  and no half-time break (the second half starts 1.3 s after the first ends), so neither gets one.
- **Which shot**, by restart and never the same kind twice in a row (a hash of the match id and the
  event id picks the first or second preference):
  - *fans*: the two front rows of the far stand, the 3D spectators with their scarves, from the far
    touchline 9 m away and a little from the side, 7.5 m across the frame, depth of field on the
    rows so the bowl behind softens, sliding 1.6 m along the row over 4 s (a handheld walking the
    touchline). First choice at throw-ins and free kicks.
  - *end*: the fans behind the goal nearer the restart, from 9 m in front of the goal line and
    13 m to the side, 3.4 m up (over the players' heads), the goal in the foreground and the end
    stand in the home or away colours filling the frame, pushing in from 30 to 24 m across over
    4.5 s. First choice at corners.
  - *stadium*: a beauty shot from high in the near corner away from the restart, 21 m up under the
    roof, 66 degrees across the whole bowl to the far stand, the corner screen and the floodlights,
    panning slowly over 5 s. First choice at goal kicks. Never straight from camera 2's tight
    shot: depth of field switched off at that cut by rebuilding the post chain, whose first frames
    showed stale green where nothing is drawn, which in this shot is the sky (seen in the stills).
    Depth of field is now built once and only attached or detached (`post.js`); the rule stays.
- **Never during play:** every cutaway lies between two events, after the ball is out and ending
  at least 3 s (4 s at a throw-in) before the restart; never over a tight shot or a goal replay.
  The carrier tag is off during a cutaway.
- **Same frame every time:** the plan is a pure function of the match (no `Math.random`), so a
  seek, a replay and a video frame agree. With `prefers-reduced-motion` camera 1 holds the wide shot
  throughout: no cutaway, no cut to camera 2, no goal replay, no punch-in and no slide along its
  rail (`cutaway.js` REDUCE).
- **On M001:** 83 cutaways, 43 in the first half and 40 in the second, for 83 restarts and 4 goals
  (the stoppages left out had a cutaway end under 20 s before, or no room between the ball going
  out and the restart): 30 fans, 26 end, 27 stadium, back on camera 1 between 10.3 and 69 s before
  the restart (median 13.2 s). M002 to M004 get 84 to 90 (they were 39 to 42 with the first rule).
- **No new geometry:** the shots use the replay camera, free outside replays, and the existing
  stands and crowd. Frame cost on M001, match paused, median of four renders finished on the GPU
  (SwiftShader, high profile, 1280 x 720; compare only): the stadium shot 6.2 s and 177 draw
  calls against camera 1's 6.2 s and 373 at the same moment; the fans and end shots 11.9 s and
  10.4 s, about 640 draw calls, as camera 2's tight shot (10.7 s, 658), because both use depth of
  field (high profile only), against 8.0 s on camera 1.

Tests: `node --test tests/web/cutaway.test.mjs` (the plan on M001 is the same twice, no event
inside a cutaway, the next event is the restart, the cut back comes in time, no overlap with tight
shots or replays, spacing and variety; at least 85% of the stoppages get one and the median gap is
under 60 s; one kick-off cutaway per goal, after its replay; a throw-in too soon gets none),
`MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh layout-camera.mjs` (reduced motion
holds camera 1 through a cutaway, without it the cutaway cuts). Stills:
`WEBGL=2 MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh cutaway3d-stills.mjs <tag>`
into `out/crowd-cutaways/` (not in git).

## 2. Post-processing

`DefaultRenderingPipeline` with an HDR buffer on both profiles:

| Piece | High (WebGL 2, desktop) | Low (phone, WebGL 1, software) |
|---|---|---|
| Anti-aliasing | FXAA (MSAA 4 where SSAO2 is not supported) | FXAA |
| Sharpen | edge 0.25 | edge 0.25 |
| Bloom | threshold 1.0 in HDR, weight 0.3, kernel 64, half scale | the same at quarter scale |
| Tone mapping | Khronos PBR Neutral | Khronos PBR Neutral |
| Grade | broadcast lookup table, below | the same |
| Vignette | weight 0.6, very light | the same |
| Depth of field | the pitchside tight shot and the replays (not the high tactical view), f/2.8 on a 24 mm tall sensor | off |
| SSAO2 | half resolution, 8 samples, radius 1.2 m | off |
| Motion blur, grain, chromatic aberration | off | off |

Anti-aliasing on high: with SSAO2 the scene is drawn into SSAO2's prepass target, so the
pipeline's MSAA never reached it and the high profile had none at all. MSAA 4 in that target
(`ssao.textureSamples`) took the sample scene from 0.64 to 0.38 and 0.43 fps, FXAA to 0.53 fps
(`scene3d-perf.mjs high`, SwiftShader, 1280 x 720, back to back): FXAA it is, with the
sharpen pass after it as on low.

Babylon docs: https://doc.babylonjs.com/features/featuresDeepDive/postProcesses/defaultRenderingPipeline .

**The grade** is a 16 x 16 x 16 lookup table built in code (`grade()` in `post.js`), no
third-party LUT:

1. The picture as a TV chain shows it: undo the sRGB encoding, encode with the ITU-R BT.709 camera
   curve and show it on a BT.1886 display (gamma 2.4). End to end that is the system gamma of
   about 1.2 that gives TV pictures their contrast. The frame is already tone mapped, so the full
   curve crushed the darks (18% grey to 8%); half of it is applied (18% grey to 13%).
2. A soft knee from 90%, so floodlit whites roll off instead of clipping.
3. Up to 8% more saturation on dull colours and none on strong ones, so kits and cel-shaded
   flat colours keep their colour and nothing clips.

Grey 0.18 maps to 0.132, 0.5 to 0.461, 1.0 to 0.963.

**A bug found on the way:** the first after stills had orange-brown speckles over the grass and
the players. Switching each effect off in turn pointed at the grade. The table texture had
anisotropic filtering on (the engine default for the scene); where two neighbouring pixels fall in
different blue slices of the table, the texture coordinate jumps by a whole slice and an
anisotropic tap blends across it. The table now uses plain bilinear filtering
(`anisotropicFilteringLevel = 1`); an identity table now changes the frame by 0.61/255 on
average, against 4.06/255 before the fix.

Left out on purpose: screen-space reflections (grass does not reflect, about 4 ms), TAA (ghosting
on moving players), object motion blur, subsurface scattering, film grain and chromatic
aberration (they muddy flat toon shading).

## 3. Evening floodlit match

`?light=night` is the default, `?light=day` keeps the previous look (stadium HDRI and one sun).

| Fact | Number | Source |
|---|---|---|
| Illuminance for broadcast football | about 1,400 lux vertical to the main camera | OP-32, 9.1 |
| Colour temperature | 4,000 to 6,500 K, 5,600 K preferred | OP-32, 9.1 |
| Colour rendering | Ra 90 or more | OP-32, 9.1 |
| UEFA elite level | over 2,000 lux, 5,000 to 6,200 K | UEFA Stadium Lighting Guide 2023 (secondary summary) |

What the scene does at night:

- Dark sky (clear colour 0.012, 0.016, 0.032) and the HDRI cut to 0.32 as bounce light only.
- Four directional lights in 5,600 K white, one from each corner mast towards the centre spot.
  The one behind camera 1's left shoulder is the key (2.2) and casts the shadow map; the other three
  are fill (1.45). Even light over the pitch, four soft shadows per player.
- The stands sit outside the floodlights' beams: they are excluded from the four lights and get
  only a dim spill (0.6) and a darker crowd, so the bright pitch stands out from darker
  surroundings.
- Emissive lamp banks: a 6 x 3 lamp panel on each mast head and a row of lamps under the leading
  edge of each roof, bright enough (emissive 5 to 7) that only they cross the bloom threshold.
- A faint lens flare (a halo and two small ghosts) on each mast.

## 4. Grounding

- **Contact darkening under every player, on every profile and in both lights:** a soft dark blob
  0.95 m across under the feet (1.5 m in daylight on the low profile, where there is no sun
  shadow). One thin-instanced mesh, one draw call.
- **Blob shadows for the lights without a shadow map:** at night one long faint blob per corner
  mast, pointing away from it and as long as a 1.82 m player's shadow at that mast's elevation
  (1.2 to 6 m). Exaggerated on purpose, so players do not float.
- **Cascaded shadow map** (`CascadedShadowGenerator`): high profile 3 cascades of 1024 px fitted
  to the view (`autoCalcDepthBounds`), PCF at medium quality; a WebGL 2 phone gets 2 cascades at
  low quality; WebGL 1 gets blobs only. `shadowMaxZ` 160 m, stabilised cascades, depth clamp.
  Babylon docs: https://doc.babylonjs.com/features/featuresDeepDive/lights/shadows_csm .
- **SSAO2** at half resolution on the high profile only.

## 5. Tests

New checks in `tests/web/sample3d-shots.mjs`, each written so that it fails without the change:

| Check | Measured (low profile) |
|---|---|
| Camera 1 on the halfway line, 12 to 16 degrees down to the centre spot and along its median line of sight | 14.8 and 13.5 degrees |
| Long lens: 18 to 34 degrees across, 23 to 43 m of pitch at the aim | 26.3 to 30.2 degrees, 38.1 m |
| Tight shot from a pitchside camera: 8 to 30 m away, 2 to 4 m up, a lens under 16 degrees, standing still | not re-measured since the 4.5 m frame |
| Tight shot nearly level (3 degrees up to 6 down) with knees and head in frame in 80% of its frames | not re-measured since the 4.5 m frame |
| Every cut at a stoppage (within 8 s of a goal, or inside a foul or save stoppage) | cuts at 101.2 s to camera 2 and 102.5 s to the replay, goal at 100.2 s |
| Grass 0.3 m in front of each player's feet darker with grounding than without (under 0.9), grass 8 m away unchanged (over 0.95) | 0.818 and 1.0 over 11 players |
| An identity grade table leaves the frame unchanged (under 2/255), the broadcast table changes it (over 2/255) | 0.61 and 11.57 |

The same checks pass under WebGL 2 on SwiftShader (high profile, 177 shadow casters): the same
camera numbers, grass in front of the feet at 0.786, identity table 0.59/255, grade 11.34/255.

Commands: `scripts/with-lock.sh chromium tests/web/run-smoke.sh sample3d-shots.mjs` (low) and the
same with `WEBGL=2` in front (high); `.venv/bin/pytest -q`;
`scripts/with-lock.sh chromium tests/web/run-smoke.sh` (2D smoke).

**The checks against the earlier code (commit 7ffce82).** An earlier version of these checks, run
on that commit, failed 6 times: no contact shadows; camera 1 not on a long lens (39.8 to 44.4 degrees, 58 m of
pitch); the tight shot too close (9.8 m) and at the wrong angle (7.2 degrees); no darkening under
the feet (1.0, 17 players); no grade table to test. Two checks pass on the earlier code too: it already
had the camera on the halfway line at 12 to 16 degrees and already cut only at the goal, so those
two guard against regressions and do not prove the new code. The pitchside tight-shot checks were
rewritten after that run and were not run again on the earlier code, whose tight shot comes from
the 18 m high platform, so the 2 to 4 m height check cannot pass there.

## 6. Frame rate

Measured with `tests/web/scene3d-perf.mjs` on a 2-core machine, software rendering only, so
the numbers compare before and after; they say nothing about a real GPU.

| Profile | Before (commit 7ffce82) | After | How |
|---|---|---|---|
| Low (lavapipe, WebGL 1) | 1.67 and 1.62 fps | 1.21 and 1.39 fps | alternated back to back, twice, with other jobs loading the machine |
| High (SwiftShader, WebGL 2) | 0.86 to 0.94 fps | 0.92 fps | separate runs earlier in the day |

On low the post chain (HDR buffer, FXAA, bloom, grade) costs about 15 to 25% on a software
renderer. On high the cost is lost in the noise of under 1 fps. An idle-machine low run earlier
gave 6.03 fps before; the after run in the test itself gave 5.21 fps.

## 7. Stills and video

In `out/shots/` (not in git): `broadcast3d-before-*.png` and
`broadcast3d-after-*.png` for `wide`, `tight`, `replay`, `wide-day`, `phone-portrait` and
`phone-landscape`, plus `broadcast3d-after-establishing.png` (camera 1 on a wide lens tilted up to
the roofs and masts, made only for this note). `broadcast3d-before.mp4` and `broadcast3d.mp4` are 20 s of
M001; `broadcast3d-before-after.mp4` puts them side by side, before on the left and after on the right
(the ffmpeg build used has no text filter, so the halves carry no label). The video was
rendered before the tight shot moved to the pitchside camera, so its tight shot is still the
earlier one from the platform; the stills are current.

## 8. What still looks fake

Compared still by still against the before set, these are the parts that still give it away:

- **The lamps are mostly off screen.** Camera 1 on a long lens sees the pitch and the lower stand,
  so the glowing mast heads and roof strips show only in the establishing still. In the wide shot
  the night reads from the dark stands and the even pitch, not from the lamps.
- **No pools of light.** Four directional lights light the pitch evenly with no falloff towards
  the corners; real floodlights leave a faint pattern of brighter and darker patches.
- **The stands are flat.** At night they get a single dim spill light. On the high profile the
  two front rows are 3D spectators and the rest are flat cards; on the low profile every
  spectator is a card, close to invisible on a phone.
- **The tight shot crosses traffic.** Camera 2 stands still and other players run through the
  frame, sometimes in front of the scorer; a real operator would reframe or wait. The lower-third
  nameplate covers the scorer's waist in the tight still.
- **The lens flare is faint**, on purpose, and nearly lost at phone size.
- **Low profile shadows are blobs only**: no shadow shape, just a soft dark patch and a faint
  streak per mast.
- **The goalmouth wear** reads as a brown smudge under the night light (`docs/scene3d-research.md`,
  section F, has the pitch shader).
- **Possible banding** in dark gradients from the 16-point grade table; not seen in the stills,
  not checked on an 8-bit phone screen.
- **Not tested on a real GPU or phone.** Every number and still here comes from software
  renderers (lavapipe and SwiftShader), which run at a fraction of real speed.

## 9. Big screen, kick-off and full time

Code: `web/js/scene3d/screen.js` (the screens), `web/js/countdown.js` (the two moments), small
changes in `web/js/scene3d.js`, `web/js/app.js`, `web/index.html` and `web/css/broadcast.css`.
Tests: `tests/web/stadium.test.mjs` (node, the pure logic) and `tests/web/stadium.mjs` (browser).

### The big screen

Two screens, one in each far corner, on legs just behind the boards at world (±58.4, 40.6): the
corner of the pitch is at (±52.5, 34), so the screens stand beyond the corner flag and everything
on the pitch is in front of them; they never hide play. Each is 6.4 x 3.2 m, from 1 m (just over
the 0.9 m boards) to 4.2 m, turned to camera 1. They show a fixed wordmark (STUDIO DESK) over the
two club colours, drawn once. An earlier version showed the short names, the score and the minute
in the score bug's look; in the wide shot the left screen sits just behind and above the score bug,
and it read as a second, smaller score bug. The score now has one place on screen.

Why that height: camera 1 at (0, 18, -68) on its long lens sees only the bottom of the stands. A
first version was 7.5 x 3.75 m from 1.8 to 5.55 m; in a sweep of the wide shot over M001 (47
frames, one every 120 s) the top of the frame cut it in 23 of the 25 frames it was in, so most
of the time only its lower half was on air. From those cuts the top of the frame at the far
corners sits between about 3 and 4.8 m. The lower, smaller screen is whole in 6 or 7 of the 47 frames
(runs differ by one frame) and partly in about 18 more. A screen up under the roof, where real grounds hang theirs, would never be
on air.

Where each camera sees it, from the camera matrices (share of the frame, whole in frame only):

| Camera | Left screen | Right screen |
|---|---|---|
| Camera 1, wide shot (47 frames) | whole in 5 frames, up to 1.7% | whole in 1 or 2 frames, up to 1.5% |
| Replay, goal (behind the goal) | never | never |
| Replay, low (pitch level, on the 18-yard line) | never on this replay (right-end goal) | up to 8.2% |
| Replay, reverse | never | never |
| Replay, high | never | never whole (0.5% cut) |

Cost: the faces are one merged mesh with one 1024 x 512 `DynamicTexture` (a power of two for
WebGL 1), the housings and legs another merged mesh, world matrices and materials frozen: 2 draw
calls (377 against 375 on the high profile). The canvas is drawn once, and again when the web
font arrives; it is never redrawn per minute or per frame. The frame
time could not be told apart on a software renderer: the same frame drawn six times with the screens and
six without, alternated, took a median of 13.8 to 14.6 s against 15.4 to 16.7 s in three runs and
7.0 against 6.6 s, 11.8 against 11.5 s, 6.9 against 7.1 s and 6.6 against 6.6 s in four more (software WebGL 2, every frame waits on a CPU shared with other
jobs): the sign flips between runs, so the difference is under the noise; on a real
GPU two more draw calls of 4 and 1 triangles are negligible.

### Kick-off and full time

When the viewer presses Play at the very start (match time under 0.5 s), a strap at the top
centre counts 3, 2, 1 and then says "Kick off" for 1.5 s. The clock is held during the count and
starts on "Kick off", as a broadcast counts down to air. A second press stops the count; a seek
(or a deep link past kick-off, or a programmatic play from a test) never shows it. From 2 s before
the final whistle to 4 s after it the strap says "Full time". Words in en, it and es; the strap is
`role="status"` so screen readers hear each step; with `prefers-reduced-motion` it has no pop and
no fade. It hides (opacity 0, still read out) while a graphic on air or the replay badge covers
that spot.

Speed: the count and the full-time strap show at 1x and 4x only. At 16x and 64x the viewer is
skimming: a three second wait would cost a minute of match, and full time would flash for a third
of a second. 4x is also the fastest speed the 3D goal replays play at.

Sound: three short pips and a long one from a WebAudio oscillator (880 and 1320 Hz, 5 ms ramps,
no file), only with the Voice button on and at 1x, the speeds the voice and the booth play at. The
whistles are the booth's own: `booth.js` already blows `whistle.mp3` at kick-off and at each
period end, so nothing new is played at full time.

The count runs on real time: on a page that stalls for more than a second or two (the software
renderers used for testing) a label can be skipped; the clock is still held until the count is over.

Commands: `node --test tests/web/stadium.test.mjs` (5 tests) and
`WEBGL=2 MATCH=M001 scripts/with-lock.sh chromium tests/web/run-smoke.sh stadium.mjs`. Stills in
`out/shots/` (not in git): `stadium-broadcast.png`, `stadium-replay-low.png`, `countdown-3d.png`,
`countdown-1280.png`, `countdown-390.png` (in Spanish) and `countdown-fulltime.png`. The two screen stills
are taken on a fresh page: the sweep stubs out the draw to run quickly, and after minutes of undrawn
play the first drawn frames showed the players with stretched limbs (stale skinning), which a viewer
never gets because the page always draws.
