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

## Results

RESULTS

## Tests

- `.venv/bin/pytest -q tests/test_retarget_motion.py`: the UAL skeleton has 65 joints; a T-pose
  source gives back the rest pose exactly; every committed clip retargets with 22 unit quaternions
  and no NaN; every limb segment of the retargeted body points where the source limb points
  (95th percentile under 12 degrees; swapping the arms or flipping an axis fails it on every
  clip); the glb has the armature plus the 65 joints and 23 channels per clip.
- `node --test tests/web/awareness.test.mjs`: with `clips.json`, the emotions keep exactly the
  same sources, more than half play on real clips, one-shots never outlast their clip, and every
  scorer still celebrates.
- `scripts/with-lock.sh chromium tests/web/run-smoke.sh motion3d-shots.mjs`: the sheet, the two
  stills with and without the clips, and frames/s.
