# Anime footballers (`?players=anime`)

The owner asked for anime-style footballers: big eyes with highlights, a small nose, a line mouth,
big stylised hair in saturated colours, flat cel shading with a crisp shadow edge, clean outlines,
faces that change with the emotion. Inazuma Eleven is the style reference only: no character,
hairstyle-plus-colour pair, kit or face is copied from any anime, manga or game, and no real person.

What ships:

- `scripts/build_anime.py` builds `web/vendor/players/anime.glb` from two CC0 VRoid sample models,
  bound to the mannequin skeleton (65 joints, same names, hierarchy and rest pose).
- `web/js/toon3d.js`: the cel shading and the outline, as two material plugins on Babylon's PBR material.
- `web/js/players3d.js`: `dressAnime` (kit, hair, eyes, face) behind `dressFootballer`, and `animeLook(pid)`.
- `web/js/scene3d.js`: `?players=anime` loads the anime model; the default is unchanged.
- `tests/test_build_anime.py` and `tests/web/anime3d-shots.mjs`.

## Research

### How anime-look 3D characters are made

**Guilty Gear Xrd** (Junya C. Motomura, GDC 2015; [GDC Vault](https://gdcvault.com/play/1022031/GuiltyGearXrd-s-Art-Style-The),
[video](https://www.youtube.com/watch?v=yhGjCzxJV3E), [slides](https://www.ggxrd.com/Motomura_Junya_GuiltyGearXrd.pdf)).

- The data lives in vertices, not textures: normals, vertex colours and UVs. Textures pixelate in close-ups.
- Cel shading is binary: the surface is lit or not.
- Head normals are edited by hand. A vertex colour sets how easily a part falls into shadow
  ([forum recap](https://polycount.com/discussion/comment/2567482), secondary source).

**The outline technique** comes from Motomura's later deck,
[Guilty Gear Toon Line Control Techniques](https://docswell.com/s/ASW_Academy/5LVY67-GG-Toonline-Eng) (2025).

- An inverted hull.
- Line width comes from vertex-colour alpha and is scaled by camera distance times tan(FOV/2).
- A smooth second normal set drives the hull.
- Lines are removed in creases.

**Blue Protocol** ([CEDEC 2021 coverage](https://www.gamebusiness.jp/article/2021/09/13/19051.html)).

- The base or shade colour is picked by N·L, with tuned normals.
- Outlines come from a G-buffer edge pass, with thickness adjusted for camera distance.
- Shadow-map self-shadowing is avoided.

**Genshin Impact.**

- miHoYo's own talks describe a PBR-based stylised render
  ([GDC 2021](https://www.gdconf.com/news/learn-about-making-genshin-impacts-open-world-gdc-2021),
  [Unity talk](https://docswell.com/s/UnityJapan/KWRPQ5-210617-unity-dojo20211mihoyozhenzhongyi)).
- Ramp textures and SDF face shadows are documented only in community recreations.

**VRM MToon** (MIT, [Santarh/MToon](https://github.com/Santarh/MToon);
[spec](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md)).

- Shading uses a shade colour, a shading shift (where the terminator sits) and a toony factor (how wide the edge is).
- It has a parametric rim.
- The outline width is set in world units or in screen units.
- The Babylon ports, [babylon-mtoon-material](https://github.com/virtual-cast/babylon-mtoon-material)
  and babylon-vrm-loader, are MIT. Their last releases (2022 and 2023) target Babylon 5, so they are
  reference code only and not a dependency for our Babylon 9.

**Babylon.js options.**

- `renderOutline` offsets in object units and draws only the silhouette, with no per-vertex width.
- `CellMaterial` has 2 to 5 levels but no shade colour or rim.
- `SelectionOutlineLayer` doubles draw calls.
- [Material plugins](https://doc.babylonjs.com/features/featuresDeepDive/materials/using/materialPlugins)
  inject GLSL into the PBR material and keep skinning, morph targets, shadows and the kit code as
  they are. This is what `toon3d.js` uses.

**The anime football games.**

- Captain Tsubasa: Rise of New Champions is described as cel-shaded by the press
  ([GamePro](https://www.gamepro.de/artikel/captain-tsubasa-fussball-preview,3353580.html)). Its
  engine is not documented.
- No visual breakdown of Inazuma Eleven: Victory Road was found.

### Characters we can ship in a public MIT repo

| Source | Licence | Verdict |
|---|---|---|
| [VRoid Studio CC0 models on OpenGameArt](https://opengameart.org/content/vroid-studio-cc0-models) (Base_Male, HairSample_Male and others) | CC0. The [VRoid help centre](https://vroid.pixiv.help/hc/en-us/articles/4402614652569) says the VRoid Studio sample models are CC0 | **Used** |
| VRoid AvatarSample A/B/C and VRoidPreset | "not CC0", redistribution only under VRoid's terms ([help](https://vroid.pixiv.help/hc/en-us/articles/4402394424089)) | Not MIT-compatible |
| VRoid beta AvatarSample 1 to 4 | CC0 ([help](https://vroid.pixiv.help/hc/en-us/articles/360012381793)) | All female |
| VRM Consortium Seed-san | VRM Public License 1.0 ([vrm.dev](https://vrm.dev/en/licenses/1.0/)) | Avoided |
| 100Avatars (Polygonal Mind) | CC0 per [open-source-avatars](https://github.com/ToxSam/open-source-avatars) | Not anime style |
| [Base Rigged Stylized Humanoid (YW)](https://opengameart.org/content/base-rigged-stylized-humanoid-character-yw) | CC0 | No anime face |
| Sketchfab | No CC0 rigged anime male found | None |

### Image to 3D, and the double wall

- [TRELLIS.2](https://github.com/microsoft/TRELLIS.2) is MIT, and so are its
  [weights](https://huggingface.co/microsoft/TRELLIS.2-4B).
- Its hollow double wall is documented and still open:
  - [#25](https://github.com/microsoft/TRELLIS.2/issues/25): the maintainer puts it down to the post-process remesh;
  - [#140](https://github.com/microsoft/TRELLIS.2/issues/140): "most generations add an entire inner shell";
  - [#145](https://github.com/microsoft/TRELLIS.2/issues/145).
- The remesher works on an unsigned distance field, so it wraps a shell around any thin sheet.

**Does the anime case avoid it? No.** The cause is the post-processing, not the style of the input.
An anime image has the same thin parts: hair spikes, ears, fingers, the shirt hem. Our parallel
TRELLIS trial (branch feat/trellis3d) got the double wall again, together with flat hands and thin
arms. A voxel remesh to one shell would fix the wall, but it does not give:
- clean eye and mouth geometry, which a face needs to change expression;
- a separate hair mesh to recolour;
- blend shapes.

The open image models (FLUX.1 schnell, Z-Image-Turbo and Qwen-Image, all Apache 2.0) would be fine
for the source image. The mesh is the weak point.

## Route chosen: the VRoid CC0 rebind

The VRoid samples are the only freely licensed source with a real anime face:
- eyes with irises and highlights on separate layers;
- a line mouth and brows;
- 54 blend shapes, among them joy, sorrow, angry and blink;
- the hair as its own mesh, shaped in strands.

A face drawn procedurally in headless Blender could not reach that in the time box. TRELLIS gives
one fused shell with no face rig. Rebinding is also deterministic and needs no GUI and no download
at run time.

### What `build_anime.py` does

**1. Joint map.** Each VRoid joint maps onto the mannequin's matching joint.
- The model is flipped (VRM 0.x faces -Z) and its bone is turned onto the target bone.
- It is stretched along the bone to the target length, and scaled across it by a set factor (the
  mannequin is stockier).
- The head gets one uniform scale of 1.28, for anime proportions without chibi.
- Each vertex moves by the weighted sum of its joints' maps, as skinning would move it.
- Normals and blend-shape deltas follow the linear part.
- The weights are moved onto the mannequin's 65 joints, keeping the four largest.

**2. Body.** The body is dressed by `build_footballer.dress`, the same kit regions as `footballer.glb`:
- skin, kit_shirt, kit_shorts, kit_socks, boots, forearms, hands;
- the same kit UVs, so numbers, team colours, the captain armband and the keeper's long sleeves
  and gloves all work through `dressFootballer` unchanged.

**3. Face.**
- One mesh with two draws: the skin, and an atlas of eye white, iris, highlight, brows, lashes,
  eyeline and mouth.
- The iris and brow rectangles are greyscale, and the page tints them (eye colour, hair colour).
- Four morph targets: joy, sorrow, determined (angry brows plus narrowed eyes) and blink. There
  are four because WebGL 1 gives each target vertex attributes and runs out after about four.

**4. Hair.** Four styles:
- messy, from HairSample_Male;
- spiky and swept, bent from it strand by strand;
- a short crop, from Base_Male.

Each is greyscale, tinted by the page.

**5. Far body.** For each hair style, one draw with an 8-texel colour palette.

**Variety.** `animeLook(pid)` picks from the existing per-player hash:
- the hair style (4) and colour (8);
- the eye colour (6);
- the skin tone (the existing palette);
- a height from 0.95 to 1.05.

Spiky hair never gets the gold colour, a famous look. There is no white or silver hair.

**Shading** (`toon3d.js`).
- Two tones from the sun's angle with a crisp edge, smoothstep over 0.08 of N·L.
- A cool shade tint, and a thin rim on the lit side.
- Image processing as the scene has it.
- The outline is an inverted hull: a clone of each near part with a back-face-only dark material,
  pushed out along the normal by 9 mm. It is capped at 1.6 pixels, so lines stay thin at broadcast
  distance (Xrd's distance-scaled width).
- The face is not outlined: its lines are drawn in its texture.

**Faces in the match.** `scene3d.js` calls `p.face(r, v, ts)` after the clips:
- joy for celebrate and join;
- frustration for dejected and near_miss;
- frown for appeal and protest;
- determined while sprinting (over 5.5 m/s);
- a blink about every 3 s.

## Budget

| | Target | anime.glb |
|---|---|---|
| Near triangles (body + face + hair) | about 10k | 9,936 (messy, spiky, swept), 8,506 (crop) |
| Far triangles | under 4k | 3,329 at most |
| File size | under 5 MB | 1.98 MB |
| Draws per near player | 1 to 2 | RESULTS |
| Draws per far player | 1 to 2 | 1 |

## Results

RESULTS

## How to rebuild

Download `hairsample_male.zip` and `base_male.zip` from the OpenGameArt page and unzip them as
`<dl>/hairsample_male/HairSample_Male.vrm` and `<dl>/base_male/Base_Male.vrm`. Then:

    scripts/with-lock.sh build .venv/bin/python scripts/build_anime.py <dl>

This needs ffmpeg and npx (gltf-transform 4.5.1).
