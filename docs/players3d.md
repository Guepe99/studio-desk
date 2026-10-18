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

- **MakeHuman / MPFB2.** The project states that "all core assets (the base mesh, targets,
  skins...) are shared under CC0" ([licence](https://static.makehumancommunity.org/about/license.html),
  [FAQ on closed-source use](https://static.makehumancommunity.org/mpfb/faq/use_in_closed_source.html)).
  Its bodies and skins are closer to a real person than the UBC one, but it has its own
  skeleton and needs Blender to export and rebind, which this machine does not have. The rebind in
  `build_footballer.py` would take a MakeHuman body the same way; it is the first upgrade to try.
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

## Trial: an image-to-3D body (`?players=trellis`)

`web/vendor/players/footballer-trellis.glb` is a trial body from an image-to-3D model. The page
loads it only with `?players=trellis`; the footballer above stays the default.

1. Input image: Z-Image Turbo (Apache 2.0) through its Hugging Face Space, 1024x1024, seed 3303
   (seeds 1101 and 2202 were the other candidates). Prompt:
   "Full-body photo of a fictional adult male football player standing in a strict T-pose, arms
   stretched straight out horizontally to the sides at shoulder height, palms facing down, fingers
   together, legs straight and slightly apart, feet pointing forward, front view, looking at the
   camera, neutral expression, short dark hair, realistic athletic proportions. He wears a plain
   light grey short-sleeved football shirt with a round collar, plain light grey shorts, plain
   light grey knee-high socks and plain black football boots. No numbers, no stripes, no logos, no
   text. Neutral light grey seamless studio background, soft even studio lighting, whole body
   visible from head to boots, centered, photorealistic, 3D character reference sheet."
2. Background removed with BiRefNet (MIT) on its demo Space, so the TRELLIS Space's own remover (BRIA RMBG-2.0,
   non-commercial) never runs: the Space receives an image that already has alpha.
3. TRELLIS.2-4B (MIT) on the `microsoft/TRELLIS.2` Space: seed 0, resolution 1024, decimation
   target 100,000, texture 2048. Output: one textured mesh of about 99k triangles.
4. `scripts/build_footballer.py --trellis <space output>.glb`, Python and gltf-transform only:
   - simplify to 8% (about 23k triangles), then drop the inner wall: the Space's mesh is a shell
     about 1 cm thick, and its inward-facing side would poke through the outer one once
     decimated. About 12k triangles are left;
   - align to the mannequin's rest pose: scale, soles, arm line stretched to the wrist joints,
     legs straightened onto the hip joints;
   - skin weights from the nearest vertex of the default footballer, smoothed, on the same 65
     joints; finger bones fold into the hand bone, because the scanned hand is one closed shape;
   - kit lines fitted to the scan's own sleeve, shorts, sock and boot edges (from its texture),
     then the same plane cuts and region rules as the default footballer;
   - skin, hair and boots keep the scan's texture, normalised so `dressFootballer` tints them;
     shirt, shorts and socks take the team colour with the scan's folds as an occlusion map on
     the second UV set;
   - the far body (`footballer_lod1`) is the default footballer's.

Limits: one face and one hairstyle (both are part of the scan), hands without fingers, and a
faceted silhouette at 12k triangles (1.9 MB).

Verdict of the trial (18 Oct 2026): not usable as it stands. The face and hair read better than
the default's, but the kit regions do not land on the scan's cloth (bands of skin and stray kit
on the thighs), dropping the inner wall leaves holes in the shorts and the back of the shirt, the
arms and hands are thin and flat, and at 12k triangles the body looks faceted. The default
footballer stays.
