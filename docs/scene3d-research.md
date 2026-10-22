# Studio Desk 3D: broadcast look, Babylon techniques, assets, plan

Current state, read from `web/js/scene3d.js` (560 lines): StandardMaterial everywhere, FreeCamera, one rendering pipeline, tone mapping on, thin instances for something, no shadows, no environment texture.

## A. Reference look

- Hawk-Eye HawkVISION built virtual replays from SkeleTRACK skeletal and ball data, first played into a live football broadcast at the Coppa Italia final on 11 May 2022, with metrics drawn over the replay: https://hawkeyeinnovations.com/news/4155244/hawkeyes-new-virtual-recreation-solution-hawkvision-brings-nextgeneration-replay-action-to-fans-in-major-coppa-italia-final
- SkeleTRACK tracks 29 skeletal points per player. Beyond Sports (Sony) renders the recreations, mostly as stylised animated alt-casts (Simpsons NFL, Disney NBA): https://www.hawkeyeinnovations.com/news/4216051/defining-the-sports-experiences-of-tomorrow-datadriven-virtual-recreations
- The Simpsons Funday Football alt-cast used Hawk-Eye plus NFL Next Gen Stats data in real time, with under one second of delay: https://www.beyondsports.nl/news/2024/11/12/sonys-beyond-sports-technology-powers-upcomingespn-monday-night-football-alternate-presentationthesimpsons-funday-football-lhwn6-6lsr7-mxykc-krnxs-lnyn2-5t74k-fnpg3
- Second Spectrum tracks players and ball 25 times a second and drives augmented broadcasts such as Marvel characters and shot trails: https://www.hashtagsports.com/awards/shortlist-2022/powering-immersive-broadcast-second-spectrum
- Track160 does skeletal tracking from 2 or 3 cameras mounted at one point and uses the poses to render a 3D version of the match: https://pulse2.com/track160-5-million/
- At the 2026 World Cup, Lenovo scanned all 1,248 players into individual avatars, used only for semi-automated offside visuals: https://inside.fifa.com/innovation/news/lenovo-world-cup-2026-technology-ref-cam-player-avatars-ai
- Main TV camera: exactly on the halfway line, facing away from the setting sun, looking down at the centre spot at about 12 to 15 degrees: https://documents.uefa.com/r/Regulations-of-the-UEFA-Champions-League-2025/26/E.2.1-Main-cameras-Online
- Free TV Australia: 30 to 40 m back from the touchline, 20 to 30 degrees down to the near touchline and 12 to 16 degrees to the centre: https://www.freetv.com.au/wp-content/uploads/2019/08/OP-32-Outside-broadcast-requirements-for-rugby-league-rugby-union-and-soccer-Issue-4-January-2015..pdf . My arithmetic from those figures: about 15 to 20 m high, 64 to 74 m from the centre spot.
- Focal length or field of view of the wide shot: I found no published figure.
- Following play: research systems frame on the ball or the players' centroid, then smooth the path. Smoothing alone can still look robotic: https://arxiv.org/pdf/1912.05636 . A patent frames on ball position plus the players' centre of mass, and smooths the ball path so the frame does not jerk: https://patents.justia.com/patent/10262692
- Mowing: UEFA asks for 18 stripes along the length (5.50 to 6.10 m) or 12 across (5.50 to 6.00 m), with grass cut to 24 to 28 mm: https://www.ligue1.com/Articles/NEWS/2021/09/07/user-s-manual-the-pitch . Decorative patterns have been banned since 2017/18 because straight cuts help assistant referees judge offside: https://www.premierleague.com/news/444377
- Lines are no wider than 12 cm: https://www.theifab.com/laws/latest/the-field-of-play/
- Floodlights: UEFA Elite Level A means over 2,000 lux horizontal, 5,000 to 6,200 K and colour rendering of 80 or more (secondary summary of UEFA's guide): https://www.stadiaworld.com/ebooks/sv_2023-24_en/76/ . Across all levels the range is 4,200 to 6,200 K: https://documents.uefa.com/r/UEFA-Stadium-Lighting-Guide-2023-2023/Colour-temperature-Online
- Games: FIFA 23 deliberately exaggerated the shadows on the ball and on players to "ground" them, and pitch wear builds up over the match: https://wccftech.com/fifa-23-graphics-enhancements-include-pitch-wear-exaggerated-shadows-and-more/amp/ . EA FC's "Tele Broadcast" camera is a side-on, mid-distance TV view: https://www.90min.com/best-camera-settings-ea-fc-25 . I found no developer source on how EA renders grass.

**Screenshot checklist**
1. The camera sits on the halfway line, about 15 to 20 m up, looking 12 to 15 degrees down at the centre spot. Nearer than about 64 to 74 m to the centre spot looks like a drone shot.
2. Stripes run straight, 5.5 to 6 m wide, with alternating brightness and no curves or checks.
3. Every player and the ball has a dark contact shadow, so nobody floats.
4. The two kits and the goalkeepers can be told apart at wide-shot size, even as thumbnails.
5. Light is neutral white (night) or warm low sun (sunset), with no green or blue cast on the kits.
6. Lines stay crisp, no wider than 12 cm, and do not shimmer when the camera pans (anti-aliasing).
7. Stands or crowd fill the top of the frame. Empty sky above the touchline reads as a test scene.
8. Camera motion has no jitter, and the ball never touches the frame edge.

## B. Babylon.js techniques (9.x)

- **What 9.0 added:** clustered lighting (WebGPU and WebGL2), volumetric lighting (compute on WebGPU, falls back on WebGL2), Frame Graph v1, animation retargeting, wider Gaussian splatting: http://blogs.windows.com/windowsdeveloper/2026/03/26/announcing-babylon-js-9-0/ . Also OpenPBR (alpha), dynamic IBL shadows and an outline renderer: https://blogs.windows.com/windowsdeveloper/2026/04/02/part-3-babylon-js-9-0-openpbr-and-additional-engine-updates/
- **What 8.0 added:** IBL shadows, area lights, Node Render Graph (alpha), WGSL shaders: https://blogs.windows.com/windowsdeveloper/2025/03/27/announcing-babylon-js-8-0/
- **IBL:** load with `CubeTexture.CreateFromPrefilteredData(url, scene)` into `scene.environmentTexture`. Convert .hdr to .env with https://www.babylonjs.com/tools/textures/ . A 512 px cube is about 3 MB as .env against about 32 MB unpacked. Loading an .hdr directly prefilters at load time and needs WebGL2: https://doc.babylonjs.com/features/featuresDeepDive/materials/using/HDREnvironment
- **Tone mapping:** `imageProcessingConfiguration.toneMappingType` takes Standard, ACES or KHR_PBR_NEUTRAL. Khronos Neutral keeps base colour and hue, which matters for kit colours: https://app.unpkg.com/@babylonjs/core@9.18.0/files/Materials/imageProcessingConfiguration.pure.d.ts and https://gamedev.net/news/khronos-pbr-neutral-tone-mapper-released-for-true-to-life-color-rendering-of-3d-objects-r2733
- **DefaultRenderingPipeline(name, hdr=true, scene, cams):** `samples` (MSAA, WebGL2 only), `fxaaEnabled` (works on WebGL1), `bloomEnabled`/`bloomThreshold`/`bloomWeight`, `sharpenEnabled`, `chromaticAberrationEnabled`, `depthOfFieldEnabled` (the costliest), `grainEnabled`, `imageProcessing.vignetteEnabled`: https://doc.babylonjs.com/features/featuresDeepDive/postProcesses/defaultRenderingPipeline
- **SSAO2RenderingPipeline:** uses WebGL2 and the pre-pass renderer. Forcing the geometry buffer costs more: https://forum.babylonjs.com/t/ssaorenderingpipeline-vs-ssao2renderingpipeline/30197 . Render targets have no MSAA, so edges get jagged: https://forum.babylonjs.com/t/why-does-ssao-2-wreck-aa-for-me/28665
- **SSRRenderingPipeline:** WebGL2 or WebGPU only. About 4.15 ms at quality settings on an RTX 3080 Ti. MSAA causes artefacts with pre-pass: https://doc.babylonjs.com/features/featuresDeepDive/postProcesses/SSRRenderingPipeline
- **TAARenderingPipeline:** `samples`, `factor`, `disableOnCameraMove` (true by default), `reprojectHistory` plus `clampHistory` against ghosting on moving objects: https://doc.babylonjs.com/features/featuresDeepDive/postProcesses/TAARenderingPipeline . It must be first in the post-process chain: https://app.unpkg.com/@babylonjs/core@9.18.0/files/PostProcesses/RenderPipeline/Pipelines/taaRenderingPipeline.pure.d.ts
- **Frame Graph:** builds passes as a graph, saves GPU memory, has a visual editor. The page gives no production-readiness or WebGL2 statement: https://doc.babylonjs.com/features/featuresDeepDive/frameGraph/
- **CascadedShadowGenerator:** directional light only, requires WebGL2. Settings: `numCascades` 2 to 4, `lambda`, `stabilizeCascades`, `shadowMaxZ`, `autoCalcDepthBounds`, `cascadeBlendPercentage`, PCF or PCSS only. Keep `camera.maxZ` tight (10000 gives poor shadows): https://doc.babylonjs.com/features/featuresDeepDive/lights/shadows_csm
- **Shadow filters:** PCF (`usePercentageCloserFiltering`) and PCSS (`useContactHardeningShadow`) need WebGL2 and fall back to Poisson. `filteringQuality`, `frustumEdgeFalloff`: https://doc.babylonjs.com/features/featuresDeepDive/lights/shadows . There is no built-in "contact shadow" class.
- **IblShadowsRenderPipeline:** voxel-based. Moving casters need re-voxelising, so animated players are out: https://doc.babylonjs.com/features/featuresDeepDive/postProcesses/IBLShadowsRenderingPipeline/
- **Grass:** shell texturing via the Fur material is the cheap option for short grass: https://forum.babylonjs.com/t/creating-grass-field/56860 and https://doc.babylonjs.com/toolsAndResources/assetLibraries/materialsLibrary/furMat . Thin-instance blades cost much more: 100k blades struggled to hold 60 fps: https://forum.babylonjs.com/t/field-of-grass/29023/ . Node Material docs: https://doc.babylonjs.com/features/featuresDeepDive/materials/node_material . I found no Babylon example of mowing stripes, so this would be our own shader.
- **Decals:** `MeshBuilder.CreateDecal` (adds a mesh) or decal maps (`MeshUVSpaceRenderer`, one extra texture, Standard or PBR materials): https://doc.babylonjs.com/features/featuresDeepDive/mesh/decals
- **Thin instances:** `thinInstanceSetBuffer`, `thinInstanceRegisterAttribute("color",4)`. Culling is all or nothing. Best for static sets such as seats: https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/thinInstances
- **VAT:** `VertexAnimationBaker` plus `BakedVertexAnimationManager`, with a per-instance `bakedVertexAnimationSettingsInstanced` buffer. No blending and no interpolation between frames: https://doc.babylonjs.com/features/featuresDeepDive/animation/baked_texture_animations
- **Retargeting:** `new AnimatorAvatar(name, root).retargetAnimationGroup(group, {mapNodeNames, fixRootPosition, fixGroundReference…})`. Rest poses must match, and only TransformNode-animated groups work (glTF is fine): https://doc.babylonjs.com/features/featuresDeepDive/animation/animationRetargeting/ . A rest-pose bug was fixed in 9.7.0. Retarget once at load time: https://forum.babylonjs.com/t/after-anim-retarget-stopping-current-animation-jumps-to-rest-pose/63379
- **Blending:** `AnimationPropertiesOverride.enableBlending` and `blendingSpeed`, `scene.beginWeightedAnimation`, `animatable.weight`, `syncWith`, `AnimationGroup.MakeAnimationAdditive`: https://doc.babylonjs.com/features/featuresDeepDive/animation/advanced_animations
- **IK:** `BoneIKController(mesh, bone, {targetMesh, poleTargetMesh, poleAngle})` (2 bones only) and `BoneLookController`. Call `update()` every frame: https://doc.babylonjs.com/features/featuresDeepDive/mesh/bonesSkeletons
- **Gaussian splatting:** .ply/.splat/.spz/.sog, shadow casting, several assets in one scene: https://doc.babylonjs.com/features/featuresDeepDive/mesh/gaussianSplatting . I found no mobile WebGL2 benchmark.
- **Performance:** `material.freeze()`, `mesh.freezeWorldMatrix()`, `scene.freezeActiveMeshes()`, `scene.performancePriority`, `SceneInstrumentation`: https://doc.babylonjs.com/features/featuresDeepDive/scene/optimize_your_scene . `SceneOptimizer` with `HardwareScalingOptimization`, `ShadowsOptimization`, `PostProcessesOptimization`, defaulting to a 60 fps target: https://doc.babylonjs.com/features/featuresDeepDive/scene/sceneOptimizer . `setHardwareScalingLevel` does nothing when the engine is built with `adaptToDeviceRatio`: https://forum.babylonjs.com/t/engine-sethardwarescalinglevel-doesnt-work-if-adapttodeviceratio-true/29905 . Inspector v2 loads with `ShowInspector`: https://doc.babylonjs.com/toolsAndResources/inspectorv2
- **Camera:** there is a `FollowCamera` class: https://doc.babylonjs.com/typedoc/classes/BABYLON.FollowCamera . A broadcast camera is really a fixed position with pan and zoom, so I would keep the FreeCamera and smooth `setTarget` and `fov` (my opinion).

## C. Assets (redistributable)

- **Licence risk:** Quaternius published the Quaternius Asset License v1.0 on 28/08/2026. It forbids redistributing the assets "as a standalone asset", and section 7 says it does not apply retroactively: https://quaternius.com/license.html . The UAL 1 and 2 Standard zips I downloaded today from OpenGameArt still ship License.txt = CC0 1.0, and the itch pages say CC0. Keep the zip's License.txt as proof (already done in `web/vendor/quaternius/LICENSE.txt`).
- **UAL1 Standard:** CC0, 14.5 MB zip, 46 clips (I checked the GLB): https://opengameart.org/node/174563 . Useful clips: Idle_Loop, Walk_Loop, Jog_Fwd_Loop, Sprint_Loop, Jump_Start/Jump_Loop/Jump_Land (header), Roll and Roll_RM (keeper dive stand-in), Dance_Loop (celebration), Hit_Chest, Crouch_Idle_Loop (keeper set). No kick, pass, header or dive.
- **UAL2 Standard:** CC0, 10.3 MB zip (itch says 17 MB), 43 clips on the same rig, plus a female mannequin: https://opengameart.org/content/universal-animation-library-2 and https://quaternius.itch.io/universal-animation-library-2 . Useful clips: Slide_Start/Slide_Loop/Slide_Exit (slide tackle), Hit_Knockback (foul), LayToIdle (getting up), OverhandThrow (keeper throw), Yes, Idle_FoldArms_Loop. Same rig, so no retargeting needed.
- **CMU mocap:** subject 10 has five "soccer - kick ball" trials at 120 fps (`search.php?subjectnumber=10`). "May be copied, modified, or redistributed without permission": http://mocap.cs.cmu.edu/faqs.php . "May not resell this data directly": https://mocap.cs.cmu.edu/ . It needs BVH-to-glTF conversion and bone mapping, and its BVH files are hard to use without remapping: https://blenderartists.org/t/cmu-bvh-visualizer/1491385.md
- **Bandai Namco motion dataset:** CC BY-NC 4.0, non-commercial only, so excluded: https://github.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset/blob/master/README.md
- **HDRIs, Poly Haven, CC0** (https://docs.polyhaven.com/en/faq):
  - `stadium_01`, a stadium at sunrise: 1k .hdr 1.5 MB, 2k 6.2 MB. https://polyhaven.com/a/stadium_01
  - `orlando_stadium`, midday: 1k 1.6 MB, 2k 6.1 MB. https://polyhaven.com/a/orlando_stadium
  - `suburban_football_field`, overcast: 1k 1.7 MB. https://polyhaven.com/a/suburban_football_field
  - I found no night stadium with floodlights on Poly Haven or ambientCG (both API listings checked).
- **Turf:** ambientCG Grass005 ("clean, lawn, short"), CC0, 1K-JPG zip 10.4 MB: https://ambientcg.com/view?id=Grass005 . Poly Haven has no lawn texture (checked by API).
- **Stadium:** Poly Pizza "Football stadium" (Poly by Google) and "Low Poly Sports Stands" (Cole Brenner), both CC BY 3.0, file size not shown: https://poly.pizza/m/6TZCkGh76m5 and https://poly.pizza/m/26j2bQ3zuUL . Sketchfab low-poly stadium, CC BY: https://sketchfab.com/3d-models/low-poly-football-stadium-soccer-field-3d-model-7af9fea33016437da7c24edee6e47cef
- **Kenney:** the sports pack is 2D only. No 3D football assets found: https://opengameart.org/content/football-pack
- **Footballer models with kits:** none found under CC0 or CC BY. Tint the mannequin per team instead.

## D. Recommendation (about 4 builder days, ranked by impact over effort)

1. **PBR plus HDRI lighting** (0.5 day). Move the players and pitch from StandardMaterial to `PBRMaterial`. Light them with `stadium_01` as a 1k .env through `CreateFromPrefilteredData`. Use `KHR_PBR_NEUTRAL` tone mapping so kits keep their colour. Sources: HDREnvironment doc, imageProcessing typings.
2. **Shadows** (0.5 to 1 day). One `DirectionalLight` and a `CascadedShadowGenerator` with 2 cascades, PCF, `stabilizeCascades`, tight `shadowMaxZ`, players and ball as casters. Add a dark blob decal under each player and the ball (the FIFA 23 "exaggerated shadow"). On WebGL1 or phones, blobs only. Sources: CSM doc, wccftech.
3. **Pitch shader** (1 day). Material plugin or Node Material: 18 lengthwise stripes 5.5 to 6.1 m wide, brightness alternating by stripe index and view angle, world-space noise, Grass005 detail at two scales against tiling, lines 12 cm wide drawn into a high-resolution `DynamicTexture` with mipmaps, darker wear in the goalmouths. Sources: Ligue 1/UEFA, IFAB, Node Material doc.
4. **Broadcast camera** (0.5 day). Fixed on the halfway line, about 18 m up, about 70 m from the centre spot. Target = ball blended with the players' centroid, through a critically damped spring with a dead zone. `fov` narrows when play bunches. Replays: two or three preset angles (behind goal, low touchline, high tactical). Sources: UEFA, Free TV, CineFilter, patent 10262692.
5. **Animation states from UAL1 plus UAL2** (1 day). Add slide tackle, header jump, keeper dive (Roll) and celebration clips. Blend locomotion by speed with `beginWeightedAnimation` and `syncWith`, and transitions with `enableBlending`. Coordinate kick timing with the ball agent: no kick clip exists, so either a short `BoneIKController` swing on the leg or CMU subject 10 retargeted with `AnimatorAvatar` (adds about a day). Sources: zip clip lists, advanced_animations, retargeting doc.
6. **Post-processing** (0.25 day). `DefaultRenderingPipeline` with hdr, `samples=4` on WebGL2 and FXAA otherwise, light sharpen, faint bloom and vignette. No DoF in the live view, possibly in replays. Source: DefaultRenderingPipeline doc.
7. **Stands** (0.5 day). Poly Pizza stands (CC BY 3.0, credit in THIRD_PARTY.md) around the pitch, or procedural tiers with thin-instanced seats and a crowd texture, frozen with `freezeWorldMatrix` and `material.freeze()`. Sources: Poly Pizza, thinInstances doc.
8. **Degradation** (0.25 day). Read `engine.webGLVersion`. Phone profile: hardware scaling 1.5 to 2, no cascades, FXAA. `SceneOptimizer` aiming at 30 fps. Run the lavapipe tests on the low profile. Sources: SceneOptimizer doc, forum thread.

**Not worth doing in the time**
- SSR: grass does not reflect, and it costs about 4 ms.
- IBL shadows: casters must be static.
- SSAO2: little gain at 70 m, fights MSAA.
- TAA: ghosting on moving players.
- Frame Graph and OpenPBR alpha: no visible gain.
- Volumetric lighting, clustered lighting: few lights in the scene.
- Real grass blades or fur at broadcast distance: invisible at that range, high cost.
- VAT: unnecessary for 22 players, and it loses blending.
- Gaussian-splat stadium: no CC0 source, mobile risk.

---
Not checked: whether lavapipe headless Chromium exposes WebGL2 with MSAA and float render targets (CSM and HDR need them). Test that first. File sizes for the Poly Pizza models, and any published broadcast field of view, were not found.

## E. What Studio Desk built from this (feat/scene3d, 18 Oct 2026)

Sections A to D above are the research as handed to the builder. This section records what the
test renderers support, the decisions taken from that, and where the build departs from D.

### Test renderers

Logged from `engine` and `getCaps()` inside each container (`tests/web/run-smoke.sh`):

| | `sd-chromium-webgl:1` (default) | Playwright image, `WEBGL=2` |
|---|---|---|
| Driver | Mesa lavapipe through ANGLE/Vulkan | SwiftShader through ANGLE |
| `webGLVersion` | 1 | 2 |
| MSAA samples | 1 | 4 |
| Float / half-float render targets | yes / yes | yes / yes |
| Max texture size | 16384 | 8192 |
| Anisotropic filtering | not logged | 16 |

Two lavapipe bugs shaped the code: a small `DynamicTexture` with paths drawn on its canvas reads
back empty, and an alpha-tested PBR material samples as fully transparent. The crowd therefore
uses raw RGBA masks (`RawTexture`) on a Standard material. Neither bug shows on SwiftShader.

### Profiles (`web/js/scene3d/quality.js`)

- **high**: WebGL 2 with MSAA 4 and a fine pointer. Cascaded sun shadows (2 cascades, 1024 px,
  PCF at low quality), `DefaultRenderingPipeline` with HDR, MSAA 4, sharpen, faint bloom,
  vignette; grass detail at two scales; full crowd.
- **low**: WebGL 1, phones (coarse pointer and short side under 820 CSS px) and the lavapipe
  tests. Blob shadows, no pipeline (materials tone-map themselves, one FXAA pass), one detail
  scale, 30% of the crowd, render width capped at 1100 px.
- `?quality=low|high` forces one. No `SceneOptimizer` (removed 21/10/2026): it lowered the
  picture while playing, and a softer picture was what a viewer noticed. A machine under 10 fps
  is offered the 2D pitch, never switched to it (view3d.js, 22/10/2026).

### Where the build departs from section D, and why

1. **HDRI**: `orlando_stadium` (midday, neutral sky) instead of `stadium_01` (sunrise, orange
   cast that fights checklist point 5). Converted at 256 px per face (777 KB) instead of 1k:
   the sky is never seen behind the stands and the lighting looked the same. The sun direction
   copies the HDRI's sun (about 52 degrees up), turned to shine from behind the main camera.
2. **Pitch lines**: a distance field in the pitch shader, anti-aliased with screen derivatives,
   instead of a `DynamicTexture`. A texture would need about 16k px to keep 12 cm lines crisp;
   the distance field is exact at any distance and does not shimmer when the camera pans.
3. **Post on low**: no pipeline at all. In software the pipeline cost four fifths of the frame.
4. **Stands**: procedural tiers with thin-instanced seats and crowd, no Poly Pizza model (CC BY
   with unknown file sizes). The near stand under the camera gantry has no roof, side walls or
   crowd: they blocked the main camera at 18 m.
5. **Animation**: clips are sampled from match time with `goToFrame` and weights, never played,
   so seeks, replays and video frames always show the same pose. Upper-body emotion clips are
   applied after the animation step, because Babylon clamps an animatable's weight to 1.
   Slide tackle (UAL2 `Slide_*`), header (UAL1 `Jump_*`) and keeper dive (UAL1 `Roll`) are
   stand-ins: no football-specific clip is CC0. Kicks and traps are the ball module's work
   (`docs/ball3d.md`), gestures and celebrations the awareness module's
   (`docs/awareness3d.md`).
6. **Goal celebration camera**: added after D was written. One second after each goal the
   director cuts to a close shot of the scorer for five seconds, then back to the wide shot;
   the ball-in-frame rule is off during that window only.

### Frames per second

1280x720, DEMO match, each frame finished with a one-pixel `readPixels` (otherwise frames only
queue and the number is inflated), median of three 3-second runs (`tests/web/scene3d-perf.mjs`).
Both renderers are software on a shared 2-core machine: the numbers compare before and after on
this machine, they say nothing about a real GPU.

| Renderer, profile | Before (origin/main, 18 Oct) | After (this branch, footballers and awareness on) |
|---|---|---|
| lavapipe WebGL 1, low | 5.11 | 5.52 |
| SwiftShader WebGL 2, high | 2.05 | 0.86 |

The low profile holds its frame rate because it has no pipeline and blob shadows only. The high
profile pays for everything at once in software. One earlier run that switched parts off in turn
(`scene3d-perf.mjs high all`, from 0.59 fps with everything on) gave 0.80 without sun shadows,
1.08 without the crowd, 1.59 with post effects at their minimum and 1.65 with no pipeline. On a
real GPU they should cost far less (shadow maps and MSAA are what GPUs are built for), but this was
not measured: no GPU on this machine. The 2D suggestion under 10 fps and the frame-rate beacon (api/perf) are the safety net.

On 21/10/2026 `tests/web/frame-cost.mjs` (M001 high profile, SwiftShader, from the goal at 10:00)
counted 1,179 draw calls a frame. Four changes took out work that did not reach the picture:

- each player casts its shadow from a twin of the far body (`players3d.js` `shadowTwin`), one draw per
  cascade instead of nine; Babylon's render targets skip LOD levels, so the twin sits on a layer
  no camera has;
- the cascades fit the part of the pitch the active camera sees, on the CPU (`lighting.js`
  `fitCascades`). `autoCalcDepthBounds` had never run: it needs a camera when set and there was none
  yet. The shadows of near players are sharper since;
- the depth pass of depth of field stops when depth of field is off (the pipeline left it running);
- no MSAA on the canvas or on the pipeline when SSAO2 is on: the scene is drawn into the SSAO2
  prepass target, so those samples only multisampled full-screen passes. The scene itself has no
  MSAA (prepass samples 1), before and after.

Draw calls fell to 651 in the celebration shot (depth of field on) and to 375 in the wide shot
(about 660 before); the shadow maps went from 64.5 to 2.7 ms of CPU a frame. Screenshots at four
moments match the old ones (SSIM 0.992 to 0.997, the spread of two runs of the same code).
SwiftShader stays at 0.05 to 0.08 fps: its time is pixel work, which these changes do not touch.

## F. Pitch and crowd (feat/pitchcrowd3d, 18 Oct 2026)

The owner said the 3D match looked like a 1990s game; the ground and the crowd were two of the
biggest tells. This section gives the rules the build follows, with numbers and sources.

### Mowing stripes (`web/js/scene3d/pitch.js`)

- Rule: a mown stripe is light when its blades lean away from the viewer and dark when they lean
  towards him, so the pattern swaps when seen from the other end and fades when looking along the
  stripes ([Grit](https://www.grit.com/farm-and-garden/how-to-master-lawn-striping-zklz13zgou/),
  [Scag](https://www.scag.com/pro-tip/lawn-striping-and-lawn-patterns/)).
- Model: 18 stripes of 5.83 m across the length, mown in alternate directions (+Z, -Z).
  Brightness = 1 + mow direction x (horizontal view direction . Z) x (0.05 + 0.13 x grazing),
  where grazing = 1 - |view direction . up|. Straight down the stripes barely show (5%); at the
  main camera's angle they reach about 15%. Section E's shader already swapped the stripes with
  the view's Z, at 3.5 to 12%; they are now stronger at broadcast angles and follow the
  horizontal view direction, so they fade smoothly as the camera turns along their length.
- The stripes fade by 80% where the grass is worn.

### Grass and wear

- Detail: the CC0 photo (ambientCG Grass005) stays; noise at 9 m and 2 m for patches, and a new
  40 m drift between a cooler and a warmer yellow-green (plus or minus 6%), so no two halves of
  the pitch are the same tone.
- Wear, from the goal line out: an ellipse 4.6 m deep and 6.5 m wide in each goalmouth, 1.3 m
  round each penalty mark, and the centre circle fading out over 9 m. Worn grass turns to a
  lighter, drier green and shows soil in the photo's dark texels (thin grass), up to 85%.
- Paint: off-white (0.80, 0.81, 0.77 linear, never pure white), 94% cover so the grass shows
  through, the photo's texture modulates it by 10%, and the edge is soft over 2 cm. Lines keep
  the screen-space anti-aliasing of section E.
- Shell grass (the fur approach from the
  [Babylon forum](https://forum.babylonjs.com/t/how-to-achieve-grass-3d-effect-similar-to-this-one/51166))
  was not built: optional in the brief, and the high profile already runs about 1 fps in
  software, so it could not be measured against the 10% rule here.

### Crowd (`web/js/scene3d/stands.js`, `crowd.js`, `toon.js`)

- Industry practice: instanced 3D spectators near the pitch, cheaper cards further out
  ([polycount, FIFA 10 crowd](https://polycount.com/discussion/71901/in-game-crowd-techniques-such-as-fifa-10)).
  Here the front 2 rows are 3D on high (4 until 18/10/2026, see quality.js); low keeps cards only (below).
- 3D spectator: the CC0 mannequin body (about 360 triangles, `scripts/build_spectator.py`) with
  hair, a face and a scarf added at load time; 579 triangles in all. One thin-instanced mesh, one
  draw call.
- Style: anime, to match the players. Head and hair at 1.3 times life size, two tall eyes and a
  mouth, flat colours, toon shading (below), and on high a thin dark outline (1.2 cm, Babylon's
  outline renderer). Low has no outline: in lavapipe it costs a second pass.
- Hair: a weighted palette of natural colours, any of them on any skin: black 26%, dark brown
  20%, brown 20%, dark blonde 12%, blonde 10%, platinum, grey and light brown 4% each.
  A first version drew all 12 colours evenly and read as confetti; the next one kept 10% vivid
  heads (pink, sky blue, teal, violet, silver), which the owner found too loud; one with only
  dark tones read as too uniform; copper and auburn read as unrealistic (18/10/2026).
- Face: a round face plate (12 segments, curved back at the sides) over the body's narrow head,
  with two tall eyes and a mouth; the crown of the hair is spiky, the lower part a tighter mass.
- Low profile: cards only. In lavapipe one row of 3D spectators and the hair cards together cost
  about a quarter of the frame rate (4.4 against 6.0 frames/s in a probe that switched them off),
  so on low the head card paints dark hair on itself (a cap to the brow and the sides) and there
  is no 3D row and no outline.
- Animation: seven loops baked at load time into a vertex animation texture at 20 frames/s
  ([Babylon baked texture animations](https://doc.babylonjs.com/features/featuresDeepDive/animation/baked_texture_animations),
  instanced buffer `bakedVertexAnimationSettingsInstanced`): sit, seated clap, stand, rise,
  arms up, jump, clap. Each spectator has its own loop and phase, set from match time, so seeks,
  replays and video frames agree.
- Colours: shirts by end. Home end 78% home kit and 4% away, away end 70% away and 14% home,
  sides 60% and 12%; the rest wear muted neutrals (white, navy, black, greys, beige), so the
  stands read in the two kit colours. 55% of fans hold a scarf in their team's colours.
- Cards: torso (0.62 x 0.62 m), head and a spiky hair card with the same weighted hair colours,
  sized so that neighbouring cards touch and the far rows read as flat blocks of colour rather
  than dots. Seat rows run to within 0.3 m of each stand's end, where the corner stand takes
  over. They jump with the 3D rows (a vertex shader offset of 0.3 to 0.42 m).
- Reaction to goals, from the score facts in the match data (never invented): the scoring team's
  end, and that team's fans anywhere, rise 0.2 to 1.6 s after the goal (a ripple), celebrate
  with arms up, a jump or a clap, and sit back down between 7.2 and 10 s after it.
- Banners: eight banners of 7 x 1.3 m hung over the front walls of the stands, tied along the
  top edge, in plain team colours with no text or crests, waving with a vertex-shader sine wave
  (0.12 m at the free bottom edge, 4.2 rad/s, travelling along the banner). A first version had
  flags held up in the stands; with no fan holding them they read as rectangles floating in
  front of people.

### One bowl (`web/js/scene3d/stands.js`)

The owner saw the stadium as separate blocks: open corners with dark gaps, sky between the roofs,
an empty near stand. The stands now form one bowl.

- The two side stands run between the two end lines (123 m), the end stands between the two side
  lines (86 m), and their front walls meet at the four points 9 m behind the pitch corners.
- A curved corner stand fills each quarter round that point: 12 segments, the depth going from
  the side stand's 26 m to the end stand's 22 m, so the tier, the 27 m back wall, the roof (from
  0.2 to 1 of the depth, now flat at 25.5 m) and the fascia meet both neighbours edge to edge.
  Seats follow arcs round the point; the half nearer an end belongs to that end's fans.
- The near stand, under the broadcast camera, now has its roof (above the camera's frame) and
  crowd, except 40 m either side of the camera (nearer, the heads filled the bottom corners of the
  wide shot).
- The floodlight masts moved back to stand behind the corner stands.
- Cost: four more ribbons in each of the three merged meshes (no new draw calls) and about 27%
  more seats with people (14,800 to 18,900 at full density: the near stand and the corners).

### Toon shading (`web/js/scene3d/toon.js`)

`ToonPlugin` adds itself to any `StandardMaterial`; `toonMaterial(scene, name, colour)` makes one.
It replaces the lighting with three flat tones of the base colour (100%, 80%, 58%), split at
n . l = 0.42 and -0.08 with edges only 0.02 wide (a crisp shadow line), and tints the shadow
tones slightly cool (0.86, 0.84, 1.08). No specular, no PBR. The crowd and the banners use it; the
players can share it. Banners move both edges towards the shade (-0.2 and -0.45, cloth lets light
through) and tilt their normals with the wave, so folds read as bands even with the sun behind.

### Frames per second

Measured as in section E (`tests/web/scene3d-perf.mjs`, 1280x720, DEMO match, median of three
3-second runs). The machine was shared with two other builder agents, so single runs swing by
up to a third; treat these as rough.

| Renderer, profile | Before (origin/main 7ffce82) | After (this branch) |
|---|---|---|
| lavapipe WebGL 1, low | 6.24 (runs 5.8 to 6.3) | 4.14 with a 3D row and hair cards; about 6.0 estimated for the final low profile (see below) |
| SwiftShader WebGL 2, high | 0.92 | not measured for the final version |

The 4.14 led to the low profile without a 3D row or hair cards. A probe that switched parts off
in one page (`all on` 4.41, 3D row off 4.93, hair cards off 5.97, cards off 6.58) puts the final
low profile near 6.0, inside the 10% budget (5.62), but the interleaved before and after run for
the final code was not made: the lead measures fps once at merge.

### Checks (`tests/web/sample3d-shots.mjs`)

- Stripes: the relative contrast of two neighbouring stripes, seen from the TV side and from
  the far side, must change sign and be at least 0.02; looking along the stripes it must be
  under 12% of that. Grass patches add the same contrast to every view, so the stripe part is
  half the difference of the two opposite views. origin/main passes this check too (it already
  swapped its stripes with the view's Z), with less contrast: 0.054 against 0.068 now.
- Bowl: from the centre spot, a patch just above the back wall at each corner must be less than
  20% sky. On origin/main the two near corners were 100% sky and the check fails.
- Crowd: one goal record per score fact; the home end is all seated 2 s before the home goal,
  over 90% celebrating 4 s after it and all seated again 10.5 s after it; under 30% of the away
  end celebrates; and the frame of the end behind the goal changes on average by more than 8
  levels.
  On low (cards only) the same numbers come from the cheer state the cards follow. On origin/main
  there is neither and the check fails.
