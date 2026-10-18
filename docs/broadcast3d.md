# Broadcast look for the 3D view

The 3D sample looked like a video game from the 1990s: a near camera on a wide lens, flat daylight,
players floating on the grass and no picture processing. This note has the rules a football
outside broadcast follows, the numbers we took from them, what the scene does now, and the
measurements before and after, so a reviewer can check every claim.

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

- **Camera 1, live:** fixed at (0, 18, -68) in scene metres: on the halfway line, 34 m back from
  the near touchline and 18 m up. That puts the line of sight 27.9 degrees down to the near
  touchline and 14.8 degrees to the centre spot, inside both OP-32 ranges, 70.3 m from the spot.
- **Long lens:** 24 to 42 m of pitch across the frame at the aim point, which is 19 to 33 degrees
  across. The old camera stood near and wide; from 70 m on a long lens depth flattens the way TV
  pictures do. A phone-sized frame zooms in further (to 0.65 of the width) so players stay readable.
- **Operator:** the aim is 65% ball and 35% the centroid of the nearby players, plus 0.7 s of the
  ball's velocity as lead (so the frame opens in the direction of play). Pan and zoom follow a
  critically damped spring with a dead zone, so nothing snaps or overshoots; a hard limit keeps
  the ball in the middle 80% of the frame.
- **Tight shots only at a stoppage:** camera 2 is a pitchside handheld on a long lens. It takes a
  tight shot of the scorer from 1 to 6 s after a goal, of the fouler after a foul and of the keeper
  after a save. For fouls and saves the shot runs from 1 s after the event to 0.5 s
  before the next event, and only if that leaves at least 2 s, so the cut back to camera 1 always
  comes before play restarts. On M001 that gives 17 fouls and 4 saves, every one followed by a free
  kick or a corner 25 to 33 s later (checked in the browser on the real match). The camera stands
  where the player was when the stoppage began, 18 m from him on the near touchline side and a
  little towards the halfway line (never more than 4 m outside the lines), 2.2 m up, and stays put
  for the shot. The frame is 3.2 m across at the player, aimed 1.2 m up: knees to head, nearly level,
  with the boards and the far stand behind him, on a lens of about 10 degrees, with depth of field
  on the high profile. Two earlier versions failed the lead's review: a 7 m frame from the main
  platform, then a 4.5 m one, both 14 degrees down from 18 m up, read as a view from above with
  nothing but grass behind the players.
- **Replays:** one free camera at four angles: the goal camera (14 m behind the goal line on the
  long axis, 13.5 degrees to the penalty mark), a pitch-level camera in line with the 18-yard line,
  the reverse angle from the far stand and a high tactical view. The replay timing logic is the
  one from `docs/flow3d.md`, unchanged.

## 2. Post-processing

`DefaultRenderingPipeline` with an HDR buffer on both profiles:

| Piece | High (WebGL 2, desktop) | Low (phone, WebGL 1, software) |
|---|---|---|
| Anti-aliasing | MSAA 4 | FXAA |
| Sharpen | edge 0.25 | edge 0.25 |
| Bloom | threshold 1.0 in HDR, weight 0.3, kernel 64, half scale | the same at quarter scale |
| Tone mapping | Khronos PBR Neutral | Khronos PBR Neutral |
| Grade | broadcast lookup table, below | the same |
| Vignette | weight 0.6, very light | the same |
| Depth of field | the pitchside tight shot and the replays (not the high tactical view), f/2.8 on a 24 mm tall sensor | off |
| SSAO2 | half resolution, 8 samples, radius 1.2 m | off |
| Motion blur, grain, chromatic aberration | off | off |

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
  only a dim spill (0.3) and a darker crowd, so the bright pitch stands out from darker
  surroundings. The lead's review said the first night look barely read; this was the fix.
- Emissive lamp banks: a 6 x 3 lamp panel on each mast head and a row of lamps under the leading
  edge of each roof, bright enough (emissive 5 to 7) that only they cross the bloom threshold.
- A faint lens flare (a halo and two small ghosts) on each mast.

## 4. Grounding

- **Contact darkening under every player, on every profile and in both lights:** a soft dark blob
  0.95 m across under the feet (1.5 m in daylight on the low profile, where there is no sun
  shadow). One thin-instanced mesh, one draw call.
- **Blob shadows for the lights without a shadow map:** at night one long faint blob per corner
  mast, pointing away from it and as long as a 1.82 m player's shadow at that mast's elevation
  (1.2 to 6 m). FIFA 23 exaggerated contact shadows for the same reason: so players do not float.
- **Cascaded shadow map** (`CascadedShadowGenerator`): high profile 3 cascades of 1024 px fitted
  to the view (`autoCalcDepthBounds`), PCF at medium quality; a WebGL 2 phone gets 2 cascades at
  low quality; WebGL 1 gets blobs only. `shadowMaxZ` 160 m, stabilised cascades, depth clamp.
  Babylon docs: https://doc.babylonjs.com/features/featuresDeepDive/lights/shadows_csm .
- **SSAO2** at half resolution on the high profile only.

## 5. Tests

New checks in `tests/web/sample3d-shots.mjs`, each written so that it fails without the change:

| Check | Pass on this branch (low profile) |
|---|---|
| Camera 1 on the halfway line, 12 to 16 degrees down to the centre spot and along its median line of sight | 14.8 and 13.5 degrees |
| Long lens: 18 to 34 degrees across, 23 to 43 m of pitch at the aim | 26.3 to 30.2 degrees, 38.1 m |
| Tight shot from a pitchside camera: 8 to 30 m away, 2 to 4 m up, a lens under 16 degrees, standing still | 17.3 m, 2.2 m up, 10.7 degrees |
| Tight shot nearly level (3 degrees up to 6 down) with knees and head in frame in 80% of its frames | 3.2 to 3.3 degrees down, 100% |
| Every cut at a stoppage (within 8 s of a goal, or inside a foul or save stoppage) | cuts at 101.2 s to camera 2 and 102.5 s to the replay, goal at 100.2 s |
| Grass 0.3 m in front of each player's feet darker with grounding than without (under 0.9), grass 8 m away unchanged (over 0.95) | 0.818 and 1.0 over 11 players |
| An identity grade table leaves the frame unchanged (under 2/255), the broadcast table changes it (over 2/255) | 0.61 and 11.57 |

The same checks pass under WebGL 2 on SwiftShader (high profile, 177 shadow casters): the same
camera numbers, grass in front of the feet at 0.786, identity table 0.59/255, grade 11.34/255.

Commands: `scripts/with-lock.sh chromium tests/web/run-smoke.sh sample3d-shots.mjs` (low) and the
same with `WEBGL=2` in front (high); `.venv/bin/pytest -q` (98 passed);
`scripts/with-lock.sh chromium tests/web/run-smoke.sh` (2D smoke, passed on the run before the
pitchside tight shot, which changed only 3D files).

**The checks against main (7ffce82).** An earlier version of these checks, run on a copy of main,
failed 6 times: no contact shadows; camera 1 not on a long lens (39.8 to 44.4 degrees, 58 m of
pitch); the tight shot too close (9.8 m) and at the wrong angle (7.2 degrees); no darkening under
the feet (1.0, 17 players); no grade table to test. Two checks pass on main too: main already had
the camera on the halfway line at 12 to 16 degrees and already cut only at the goal, so those two
guard against regressions and do not prove this branch. The pitchside tight-shot checks were
rewritten after that run and were not run again on main; main's tight shot comes from the 18 m
high platform, so the 2 to 4 m height check cannot pass there.

## 6. Frame rate

Measured with `tests/web/scene3d-perf.mjs` on this machine (2 cores, software rendering only), so
the numbers compare before and after; they say nothing about a real GPU.

| Profile | Before (main 7ffce82) | After | How |
|---|---|---|---|
| Low (lavapipe, WebGL 1) | 1.67 and 1.62 fps | 1.21 and 1.39 fps | alternated back to back, twice, with two other agents loading the machine |
| High (SwiftShader, WebGL 2) | 0.86 to 0.94 fps | 0.92 fps | separate runs earlier in the day |

On low the post chain (HDR buffer, FXAA, bloom, grade) costs about 15 to 25% on a software
renderer. On high the cost is lost in the noise of under 1 fps. An idle-machine low run earlier
gave 6.03 fps before; the after run in the test itself gave 5.21 fps.

## 7. Stills and video

In `out/shots/` of the main checkout (not in git): `broadcast3d-before-*.png` and
`broadcast3d-after-*.png` for `wide`, `tight`, `replay`, `wide-day`, `phone-portrait` and
`phone-landscape`, plus `broadcast3d-after-establishing.png` (camera 1 on a wide lens tilted up to
the roofs and masts, made only for this note). `broadcast3d-before.mp4` and `broadcast3d.mp4` are 20 s of
M001; `broadcast3d-before-after.mp4` puts them side by side, before on the left and after on the right
(the ffmpeg on this machine has no text filter, so the halves carry no label). The video was
rendered before the tight shot moved to the pitchside camera, so its tight shot is still the
earlier one from the platform; the stills are current.

## 8. What still looks fake

Compared still by still against the before set, these are the parts that still give it away:

- **The lamps are mostly off screen.** Camera 1 on a long lens sees the pitch and the lower stand,
  so the glowing mast heads and roof strips show only in the establishing still. In the wide shot
  the night reads from the dark stands and the even pitch, not from the lamps.
- **No pools of light.** Four directional lights light the pitch evenly with no falloff towards
  the corners; real floodlights leave a faint pattern of brighter and darker patches.
- **The stands are flat.** At night they get a single dim spill light; the crowd sprites are flat
  cards, readable on the high profile and close to invisible on the low profile and on a phone.
- **The tight shot crosses traffic.** Camera 2 stands still and other players run through the
  frame, sometimes in front of the scorer; a real operator would reframe or wait. The lower-third
  nameplate covers the scorer's waist in the tight still.
- **Replays run at normal speed.** A real goal replay is usually slowed down; the replay timing
  logic from `docs/flow3d.md` is unchanged.
- **The lens flare is faint**, on purpose, and nearly lost at phone size.
- **Low profile shadows are blobs only**: no shadow shape, just a soft dark patch and a faint
  streak per mast.
- **The goalmouth wear** reads as a brown smudge under the night light. The pitch shader belongs
  to the pitch and crowd branch, so this branch does not touch it.
- **Possible banding** in dark gradients from the 16-point grade table; not seen in the stills,
  not checked on an 8-bit phone screen.
- **Not tested on a real GPU or phone.** Every number and still here comes from software
  renderers (lavapipe and SwiftShader), which run at a fraction of real speed.
