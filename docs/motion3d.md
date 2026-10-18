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
- Not used, as the brief asked: Mixamo, BONES-SEED raw data, Hunyuan / HY-Motion, anything
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
- Frames per second, software WebGL on this machine, the same 20 s window measured in the order
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
