# Footballers in the 3D view

`web/vendor/players/footballer.glb` replaces the grey mannequin with a dressed footballer. It is
built offline by `scripts/build_footballer.py` and dressed per player at load time by
`web/js/players3d.js`. `?players=mannequin` on `sample3d.html` brings the old look back.

## What is in the file

| Mesh | Triangles | Use |
|---|---|---|
| `footballer` | about 14 300 | near body: skin, shirt, shorts, socks, boots, forearms, hands, eyes (one primitive each) |
| `hair_buzzed`, `hair_parted`, `beard` | 830 to 1 300 | picked per player; a third of the players are shaved |
| `footballer_lod1` | about 4 300 | far body: a single draw, its UVs point at an 8 x 1 colour palette |

One skin of 65 joints, the mannequin's own (same names, hierarchy and rest pose), and the 12 clips
of `web/vendor/quaternius/mannequin.glb` copied in byte for byte. `setupAnimations` in
`web/js/scene3d/players.js` and the ball rig (`web/js/ball3d-rig.js`) work on it unchanged. The
file is quantised and weighs about 1.2 MB.

## How it is built

1. Body and hair come from Quaternius' Universal Base Characters (CC0). Their skeleton has the
   same bone names as the mannequin but a different rest pose, so every vertex is moved into the
   mannequin's bind pose with its own skin weights:
   `v' = sum_k w_k * inv(IBM_mannequin[j_k]) * IBM_body[j_k] * v`.
2. The body is cut along planes at the kit lines (waist, collar, shorts hem, sock top, boot top,
   sleeve, wrist), so every border is a straight line, and each triangle is assigned a region
   from its centroid and dominant bone.
3. Cloth regions are smoothed (the shirt hides the abdominal muscles, the boots hide the toes),
   then pushed out along the normal: shirt 16 mm, shorts 12 mm plus a flare towards the hem,
   boots 7 mm, socks 4 mm. Seam vertices take the largest offset of the regions around them, so
   no crack opens.
4. Shirt and shorts get UVs at 0.8 units per metre in both directions, front and back meeting at
   the collar (or waistband) and at the sides; socks get a v from the sock top to the boot.
5. The far body is the near one decimated to 30 % with region borders locked, merged into one
   primitive.

## How a player is dressed

`dressFootballer(lib, pid, { team, gk, shirt, captain })`:

- shirt texture (512 px, one per player): primary colour, pinstripes and the number in the
  secondary colour, a collar trim, the number on the back (24 cm) and on the chest (13 cm), and
  the captain's armband on the left sleeve when `captain` is set;
- shorts texture (256 px, one per player): the number on the front of the left leg, in the shirt
  colour;
- socks in the shirt colour with a band in the second colour, shared per team;
- boots, skin tone, hair style and colour and beard picked from a hash of the player id, so a
  player looks the same in every render;
- keepers: their own shirt colour per side, long sleeves, dark shorts and light gloves.

Every number colour passes a contrast check (WCAG ratio at least 2.5, otherwise near black or
white). The data contract has no captain field, so the scene never sets the armband today; the
stills test paints it on one player with `paintShirt`.

The near body hands over to the far body when the player covers less than 0.6 % of the screen
(about 120 px of height in a 720 px frame). All near primitives share the bounds of the skin part,
so they switch together.

## Sources and licences

| Source | Licence | Used |
|---|---|---|
| Quaternius, [Universal Base Characters](https://quaternius.itch.io/universal-base-characters) [Standard] | CC0 1.0 (`License_Standard.txt` in the pack) | male body, eyes, three hair meshes, skin and hair textures as detail maps |
| Quaternius, [Universal Animation Library](https://quaternius.itch.io/universal-animation-library) | CC0 1.0 | skeleton and clips (already in the repo) |

Considered and not used:

- **MakeHuman / MPFB2** is now the `?players=human` option, below.
- **Paid store models** (the owner's reference is one): their licences forbid redistributing the
  model in an extractable form, and this repository is public.
- **Mixamo and AI-generated meshes**: excluded by the brief.
- **Cloth photo textures** ([ambientCG](https://ambientcg.com/license), CC0): a knit normal map
  would add fabric at close range, but in software WebGL every extra texture fetch costs frame
  rate and at broadcast distance it is under a pixel. Not added.

## Readability at broadcast distance

- Law 4 of the Laws of the Game asks that each goalkeeper wears colours that distinguish them
  from the other players and the officials
  ([FA copy of Law 4, 2026-27](https://www.thefa.com/-/media/files/thefaportal/governance-docs/laws-of-the-game/2026-27/law-4-the-players-equipment.ashx)).
  Our keepers wear a fixed green (home) or purple (away), since the export carries no keeper
  colours; a team whose primary colour is close to these would clash.
- In the wide frame a player is 30 to 60 px tall: what reads is the shirt and shorts colour
  blocks and the socks, so the far body keeps those as flat colours and drops everything else.
- Numbers are readable only in replays and close-ups; there the back number is the one that
  counts, so it is the biggest.

## Known limits

- The face is the stylised UBC one: it reads as a person at TV distance but not as a photo at
  close range.
- The shirt is the body pushed outwards: no folds, no sleeve opening, no separate collar mesh.
  The collar is a painted band.
- Boots are smoothed feet: no sole, no studs.
- The hands are closed fists in most clips (the mannequin's animation).
- Babylon 9 blends a bone to NaN when the first two clips evaluated in a frame both weigh 0;
  the stills test only evaluates weighted clips. The scene's own clip blending should do the same.

## MakeHuman bodies (`?players=human`)

`web/vendor/players/human.glb` (about 3.3 MB) holds six MakeHuman bodies on the same 65-joint
skeleton with the same 12 clips; `sample3d.html?players=human` loads it, the default stays
`footballer.glb`. `loadFootballer(scene, url)` counts the variant meshes and `dressFootballer`
keeps one per player.

| Mesh | Triangles | Use |
|---|---|---|
| `human0` .. `human5` | 11 800 to 15 600 | near body: skin, forearms, hands, shirt, shorts, socks, boots, eyes, brows, lashes and the variant's hair (one primitive each) |
| `human_lod1` | about 5 000 | far body (variant 0, nothing hidden), a single draw on the 8 x 1 palette; texel 8 paints the hair |

Variants (`build_humans.VARIANTS`, `HUMAN_VARIANTS` in `players3d.js`): MakeHuman macro sliders
for age, muscle, weight, proportions and ethnic mix, a few face targets, a hair style (afro01,
short01, short02, short04 or shaved) and an eyebrow style. The page picks the variant from the
player hash, then a skin tone that fits it, a hair colour, and a height factor (0.97 to 1.03).

Build, in two stages (Blender and the assets are not in the repository):

    blender -b --factory-startup --python scripts/humans_blender.py -- <work> <work>/variants.json
    .venv/bin/python scripts/build_humans.py --blender <blender> --work <work>

1. `humans_blender.py` (inside Blender 4.5 with MPFB 2.0.18 and the MakeHuman system assets)
   shapes each body, adds the `game_engine` rig with MakeHuman's own weights (its bone names are
   the mannequin's, except `Root` and `head`), fits eyes, brows, lashes, hair and the `shoes05`
   shoes, and exports a GLB plus the rig's bone heads.
2. `build_humans.py` moves every vertex from MakeHuman's A-pose to the mannequin's T-pose by
   linear blend skinning. The torso follows the hip and shoulder joints, not the spine joints
   (they sit at different heights in the two rigs): pelvis and lower spine put the midpoint of
   MakeHuman's thighs on the mannequin's, the chest is lifted halfway towards the mannequin's
   shoulders (fully would shorten the neck), the middle spine takes the average, and each keeps
   a sideways scale clamped to 0.75 to 1.1 so the hips do not widen. Each limb bone onto the mannequin joint of the same name with a
   stretch along the bone (clamped to 0.85 to 1.2), the hand by its full frame. Finger weights
   fold into the hand, so the hand keeps MakeHuman's relaxed half-open shape in every clip.
3. Garments are shells copied from the body triangles under them, smoothed and pushed out:
   the shirt 17 mm plus a flare towards the sleeve and a hang 5 cm below the waist, with open
   sleeves and a stand-up collar strip; its head weights move to the neck and its thigh weights
   to the pelvis, so it hangs from the trunk and does not twist with the head or the legs. The shorts 12 mm plus up to
   20 mm of flare at the hem; socks 4 mm. MakeHuman's `shoes05` trainers are cut at the boot
   line, 3.5 cm above the ankle joint, and the foot under them is kept (MPFB would delete it),
   painted as sock. Body triangles under a garment are deleted except a margin inside each
   opening.
4. Simplified with meshoptimizer (gltf-transform simplify, region borders locked) to 36 % for
   the near body and 15 % for the far one, then pruned and quantised.

Skin, hair and boot textures are MakeHuman's, turned into tintable detail maps as for the
footballer; hair, brows and lashes are alpha-tested (`alphaMode` MASK).

Limits of the MakeHuman bodies: the garments are offset shells with no cloth simulation, so the
shirt follows the skin weights and shows no folds; the boots are MakeHuman's trainers (a flat
sole, no studs); there are no beards; hair cards are not simplified and are the biggest single
cost in triangles.
