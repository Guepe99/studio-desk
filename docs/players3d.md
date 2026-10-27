# Footballers in the 3D view

`web/vendor/players/footballer.glb` replaces the grey mannequin with a dressed footballer. It is
built offline by `scripts/build_footballer.py` and dressed per player at load time by
`web/js/players3d.js`. The 3D view opens on the anime look ([docs/anime3d.md](anime3d.md));
`?players=footballer` shows this one and `?players=mannequin` the old mannequin.

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

The near body hands over to the far body when the player covers less than 0.08 % of the screen
(`LOD_COVERAGE` 0.0008, about 45 px of height in a 720 px frame). All near primitives share the bounds of the skin part,
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
  skeleton and needs Blender to export and rebind, which the build machine does not have. The rebind in
  `build_footballer.py` would take a MakeHuman body the same way; it is the first upgrade to try.
- **Paid store models**: their licences forbid redistributing the
  model in an extractable form, and this repository is public.
- **Mixamo and AI-generated meshes**: excluded.
- **Cloth photo textures** ([ambientCG](https://ambientcg.com/license), CC0): a knit normal map
  would add fabric at close range, but in software WebGL every extra texture fetch costs frame
  rate and at broadcast distance it is under a pixel. Not added.

## Readability at broadcast distance

- Law 4 of the Laws of the Game asks that each goalkeeper wears colours that distinguish them
  from the other players and the officials
  ([FA copy of Law 4, 2026-27](https://www.thefa.com/-/media/files/thefaportal/governance-docs/laws-of-the-game/2026-27/law-4-the-players-equipment.ashx)).
  The export carries no keeper colours, so each keeper keeps the old green (home) or purple
  (away) unless that shirt is within 25 (CIE76 delta E) of either team's two colours, the other
  keeper's or the grass (3D and 2D); then he takes the colour of a fixed palette farthest from
  those (`keeperKits` in web/js/pitch.js, which the 2D pitch and minimap use too). The green is
  always too close to the grass: home keepers wear yellow on M001 to M004 and cyan on DEMO, and
  M004's away keeper wears orange. The palette has no near black, which on the small
  see-through minimap reads as a dark team's disc.
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
