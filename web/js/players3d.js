// Footballers for the 3D scene: web/vendor/players/footballer.glb (scripts/build_footballer.py),
// a CC0 human body on the exact skeleton of the Quaternius mannequin, carrying the mannequin's
// clips unchanged. The scene instantiates it where it instantiated the mannequin; this module
// dresses each instance: kit colours, number, skin tone, hair, and the far body as a LOD level.
//
//   const lib = await loadFootballer(scene);
//   const inst = dressFootballer(lib, pid, { team, gk, shirt, captain });
//   // inst: what instantiateModelsToScene returns, plus casters (the meshes that cast shadows)
//
// Materials in the GLB: skin, kit_shirt, kit_shorts, kit_socks, boots, forearms, hands, eyes,
// hair1 for the near body; kit_far for the far body, a single draw whose UVs point at an
// 8 x 1 palette (texel k = region k of REGIONS). Skin and hair textures are detail maps
// normalised to a known level, so a tone is albedoColor = linear(tone) / level.

const B = window.BABYLON;
import { toon, outlineMaterial } from "./toon3d.js";
const SKIN_LEVEL = 0.6, HAIR_LEVEL = 0.5;
export const REGIONS = ["skin", "kit_shirt", "kit_shorts", "kit_socks", "boots", "forearms", "hands"];
export const SKIN_TONES = ["#f2cfb3", "#e3b08c", "#c98f68", "#a86d4b", "#7d4b31", "#57321f"];
export const HAIR_COLOURS = ["#141110", "#2b1d14", "#4a3020", "#8a6239", "#b48a52"];
export const HAIR_STYLES = ["hair_buzzed", "hair_parted", "shaved"];
export const BOOT_COLOURS = ["#16161a", "#f2f2f2", "#ff5fa2", "#2f7bff", "#ffcf1a", "#ff6b1f"];
// kit texture layout of build_footballer.kit_uv: UV units per metre, the same both ways
const UV_PER_M = 0.8;
// shortcut: two keeper kits picked by side, as the mannequin look did; upgrade when the export carries keeper colours
const GK_KIT = { home: "#1f9d6b", away: "#7a3fb8" };
// screen share (bounding sphere area over viewport area) under which the body switches to the far
// one, which has no shirt number: about 45 px of player height in a 720 px frame, so the wide
// broadcast shot keeps the numbers (at 120 px it lost them)
const LOD_COVERAGE = 0.0008;

// The shadow maps draw one copy of the far body per player (one draw per cascade) instead of the
// near parts (about nine). The far body cannot cast by itself, being a LOD level: render targets
// skip LOD levels. Its twin sits on a layer no camera has, which shadow maps do not check.
const SHADOW_ONLY = 0x10000000;
function shadowTwin(far, main) {
  const m = new B.Mesh(`${far.name}-shadow`, far.getScene(), main);
  far.geometry.applyToMesh(m);
  m.skeleton = far.skeleton;
  m.numBoneInfluencers = far.numBoneInfluencers;
  m.material = far.material;
  m.layerMask = SHADOW_ONLY;
  return m;
}

// FNV-1a: the same player gets the same look in every render.
function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

// Skin tone, hair style and colour, beard: picked from the player id.
export function playerLook(pid) {
  const h = hash(pid);
  return {
    skin: SKIN_TONES[h % SKIN_TONES.length],
    hair: HAIR_STYLES[(h >>> 4) % HAIR_STYLES.length],
    hairColour: HAIR_COLOURS[(h >>> 8) % HAIR_COLOURS.length],
    beard: (h >>> 12) % 4 === 0,
    boots: BOOT_COLOURS[(h >>> 16) % BOOT_COLOURS.length],
  };
}

// Relative luminance and contrast ratio of #rrggbb colours (WCAG 2), for the shirt number.
export function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// A colour that reads on `bg`: `pref` when its contrast is at least 2.5, else near black or white.
const readable = (bg, pref) => (contrast(bg, pref) >= 2.5 ? pref : luminance(bg) > 0.3 ? "#111111" : "#ffffff");

// Kit colours of one player: shirt and socks in the primary colour, shorts, sock band and the
// number in the secondary; keepers in their own shirt with dark shorts and light gloves.
// Team colours are muted on the 3D kits (a quarter less saturation, 12% darker): at full strength
// flat toon shading under the broadcast grade reads as plastic. The 2D page keeps the team colours.
const mute = (hex) => { const c = B.Color3.FromHexString(hex).toHSV(); return B.Color3.FromHSV(c.r, c.g * 0.75, c.b * 0.88).toHexString(); };
export function kitColours(team, gk) {
  const shirt = mute(gk ? GK_KIT[team.side] ?? GK_KIT.home : team.color_primary);
  const second = mute(gk ? "#15171f" : team.color_secondary);
  return {
    shirt, shorts: second, socks: shirt, band: second, number: readable(shirt, second), shortsNumber: readable(second, shirt),
    armband: readable(shirt, "#f2f2f2"), gloves: gk ? "#e9edf2" : null,
  };
}

// Colour of each region of the far body, in REGIONS order.
export function farPalette(kit, look, gk) {
  return [look.skin, kit.shirt, kit.shorts, kit.socks, look.boots, gk ? kit.shirt : look.skin, gk ? kit.gloves : look.skin];
}

// anime: web/vendor/players/anime.glb (scripts/build_anime.py), dressed by dressAnime below
export async function loadFootballer(scene, { anime = false } = {}) {
  const container = await B.LoadAssetContainerAsync(`vendor/players/${anime ? "anime" : "footballer"}.glb`, scene);
  const base = Object.fromEntries(container.materials.map((m) => [m.name, m]));
  return { scene, container, base, mats: new Map(), anime };
}

// One shared material per key: kits of a team share their shorts, socks and far body.
function shared(lib, key, make) {
  if (!lib.mats.has(key)) lib.mats.set(key, make());
  return lib.mats.get(key);
}
const tinted = (lib, baseName, hex, level = 1) => shared(lib, `${baseName}|${hex}|${level}`, () => {
  const m = lib.base[baseName].clone(`fb-${baseName}-${hex}`);
  m.albedoColor = B.Color3.FromHexString(hex).toLinearSpace().scale(1 / level);
  return m;
});

function farMaterial(lib, colours) {
  return shared(lib, `far|${colours.join()}`, () => {
    const tex = new B.DynamicTexture(`fb-far-${lib.mats.size}`, { width: 8, height: 1 }, lib.scene, false, B.Texture.NEAREST_SAMPLINGMODE);
    const g = tex.getContext();
    colours.forEach((c, k) => { g.fillStyle = c; g.fillRect(k, 0, 1, 1); });
    tex.update(false);
    tex.wrapU = tex.wrapV = B.Texture.CLAMP_ADDRESSMODE;
    const m = lib.base.kit_far.clone(`fb-far-${lib.mats.size}`);
    m.albedoTexture = tex;
    return m;
  });
}

// A kit texture in body metres (build_footballer.kit_uv): x across the body (the player's left
// positive), d down from the top line (collar or waistband), on the front or the back.
function kitCanvas(g, S) {
  const px = (m) => m * UV_PER_M * S;
  const at = (x, d, front) => [(0.5 - x * UV_PER_M) * S, (0.5 + (front ? d : -d) * UV_PER_M) * S];
  // text upright on the body: the back runs upwards in v, the front is seen mirrored in u
  const text = (s, x, d, front, height, colour) => {
    g.save();
    g.translate(...at(x, d, front));
    g.scale(front ? -1 : 1, front ? 1 : -1);
    g.fillStyle = colour;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `bold ${Math.round(px(height))}px Arial Narrow, Arial, sans-serif`;
    g.fillText(String(s), 0, 0, px(0.8 * height));
    g.restore();
  };
  return { px, at, text };
}

const canvasTexture = (lib, name, S) => new B.DynamicTexture(name, { width: S, height: S }, lib.scene, true);

function kitMaterial(lib, baseName, name, tex) {
  tex.update(false);
  tex.wrapU = tex.wrapV = B.Texture.CLAMP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 4;
  const m = lib.base[baseName].clone(name);
  m.albedoTexture = tex;
  m.albedoColor = B.Color3.White();
  return m;
}

// The shirt on a 2D context of S x S: pinstripes, collar trim, number on the back and the chest,
// captain's armband on the left sleeve.
export function paintShirt(g, S, kit, shirt, captain) {
  const c = kitCanvas(g, S);
  g.fillStyle = kit.shirt;
  g.fillRect(0, 0, S, S);
  g.globalAlpha = 0.3;
  g.fillStyle = kit.number;
  for (let x = -0.2; x <= 0.2; x += 0.035) g.fillRect(c.at(x, 0, true)[0] - 1, 0, 2, S);
  g.globalAlpha = 1;
  g.fillStyle = kit.band;
  const [x0, y0] = c.at(0.07, 0.01, false), [x1, y1] = c.at(-0.07, 0.01, true);
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  if (shirt != null) {
    c.text(shirt, 0, 0.25, false, 0.24, kit.number);
    c.text(shirt, 0, 0.16, true, 0.13, kit.number);
  }
  if (captain) {
    // the sleeve runs along x in the bind pose, so a band of x is a ring round the arm
    g.fillStyle = kit.armband;
    const [a, b] = [c.at(0.31, 0, true)[0], c.at(0.27, 0, true)[0]];
    g.fillRect(a, 0, b - a, S);
  }
}

function shirtMaterial(lib, name, kit, shirt, captain) {
  const tex = canvasTexture(lib, `${name}-shirtTex`, 512);
  paintShirt(tex.getContext(), 512, kit, shirt, captain);
  return kitMaterial(lib, "kit_shirt", `${name}-shirt`, tex);
}

// The shorts, with the number on the front of the left leg.
function shortsMaterial(lib, name, kit, shirt) {
  const S = 256, tex = canvasTexture(lib, `${name}-shortsTex`, S), g = tex.getContext();
  g.fillStyle = kit.shorts;
  g.fillRect(0, 0, S, S);
  if (shirt != null) kitCanvas(g, S).text(shirt, 0.1, 0.16, true, 0.075, kit.shortsNumber);
  return kitMaterial(lib, "kit_shorts", `${name}-shorts`, tex);
}

// The socks, with a band in the second colour at the top (v 0 at the top, 1 at the boot).
const socksMaterial = (lib, kit) => shared(lib, `socks|${kit.socks}|${kit.band}`, () => {
  const tex = new B.DynamicTexture(`fb-socks-${lib.mats.size}`, { width: 4, height: 32 }, lib.scene, false, B.Texture.BILINEAR_SAMPLINGMODE);
  const g = tex.getContext();
  g.fillStyle = kit.socks;
  g.fillRect(0, 0, 4, 32);
  g.fillStyle = kit.band;
  g.fillRect(0, 2, 4, 6);
  return kitMaterial(lib, "kit_socks", `fb-socks-${lib.mats.size}`, tex);
});

export function dressFootballer(lib, pid, { team, gk = false, shirt = null, captain = false, look = playerLook(pid) }) {
  if (lib.anime) return dressAnime(lib, pid, { team, gk, shirt, captain, look: animeLook(pid) });
  const prefix = `${pid}-`;
  const inst = lib.container.instantiateModelsToScene((n) => prefix + n, false, { doNotInstantiate: true });
  const kit = kitColours(team, gk);
  const skin = tinted(lib, "skin", look.skin, SKIN_LEVEL);
  const mats = {
    skin,
    kit_shirt: shirtMaterial(lib, pid, kit, shirt, captain),
    kit_shorts: shortsMaterial(lib, pid, kit, shirt),
    kit_socks: socksMaterial(lib, kit),
    boots: tinted(lib, "boots", look.boots),
    forearms: gk ? tinted(lib, "kit_shorts", kit.shirt) : skin,
    hands: gk ? tinted(lib, "kit_shorts", kit.gloves) : skin,
    hair1: tinted(lib, "hair1", look.hairColour, HAIR_LEVEL),
    kit_far: farMaterial(lib, farPalette(kit, look, gk)),
  };
  const near = [];
  let main = null;
  let far = null;
  for (const m of inst.rootNodes[0].getChildMeshes(false)) {
    const part = m.name.slice(prefix.length).split("_primitive")[0];
    const hair = HAIR_STYLES.includes(part) || part === "beard";
    if (hair && part !== look.hair && !(part === "beard" && look.beard)) { m.dispose(); continue; }
    const base = m.material?.name;
    if (!base) continue;   // the empty parent of a multi-primitive mesh
    if (mats[base]) m.material = mats[base];
    m.alwaysSelectAsActiveMesh = true;   // the bind-pose bounding box is wrong once animated
    if (part === "footballer_lod1") far = m;
    else {
      if (part === "footballer") near.push(m);
      if (part === "footballer" && base === "skin") main = m;
    }
  }
  // the near body is several draws, the far one a single draw: the skin part hands over to the far
  // body and the other parts vanish, all at once since they share the skin part's bounds
  const bounds = main.getBoundingInfo();
  for (const m of near) {
    m.useLODScreenCoverage = true;
    if (m !== main) m.setBoundingInfo(new B.BoundingInfo(bounds.minimum, bounds.maximum));
    m.addLODLevel(LOD_COVERAGE, m === main ? far : null);
  }
  return { ...inst, casters: [shadowTwin(far, main)] };
}

// --- anime footballers (?players=anime, docs/anime3d.md) ---------------------------------------------
// Hair styles of anime.glb and anime colours. Original characters only: no style and colour pair
// copies a known anime or game character (spiky hair never takes the two palest colours). Natural, muted
// colours only: the owner found green, blue and bright red hair too loud (18/10/2026).
export const ANIME_HAIR = ["hair_messy", "hair_spiky", "hair_swept", "hair_crop"];
// natural tones from black to platinum, any of them on any skin; no copper or auburn (under the
// toon light auburn reads as copper), which the owner found unrealistic, and not only dark ones,
// which read as too uniform (18/10/2026)
export const ANIME_HAIR_COLOURS = ["#1d1d26", "#3a2a22", "#5e3a26", "#8a5a36", "#a8783f", "#c9a25e", "#e2c88e", "#d9d3c9"];
export const EYE_COLOURS = ["#3a6fd8", "#2f9a6a", "#8a5a2b", "#6b4bb8", "#c07a1e", "#3d4a5c"];
// dark or neutral boots: the face and the hair carry the colour, not the feet
export const ANIME_BOOTS = ["#16171a", "#24262b", "#2e2a28", "#1c2433", "#d9d9d6"];
// morph targets of anime_face, in order (build_anime.EXPRESSIONS)
const EXPRESSIONS = ["joy", "sorrow", "determined", "blink"];

export function animeLook(pid) {
  const h = hash(pid), base = playerLook(pid);
  const hair = ANIME_HAIR[(h >>> 4) % ANIME_HAIR.length];
  let k = (h >>> 8) % ANIME_HAIR_COLOURS.length;
  if (hair === "hair_spiky" && k >= ANIME_HAIR_COLOURS.length - 2) k -= 2;   // pale blond or platinum spikes are famous looks
  const hairColour = ANIME_HAIR_COLOURS[k];
  return { ...base, hair, hairColour, eyes: EYE_COLOURS[(h >>> 20) % EYE_COLOURS.length], boots: ANIME_BOOTS[(h >>> 16) % ANIME_BOOTS.length],
    height: 0.95 + ((h >>> 24) % 11) / 100, blink: ((h >>> 12) % 97) / 97 };
}

// Face: the expression from the drivers' emotion (players.js resolve) and the running speed.
// face(r, v, ts): r the resolved drivers, v the ground speed in m/s, ts the match time.
function animeFace(managers, look, relax) {
  const last = new Float32Array(EXPRESSIONS.length);
  return (r, v, ts) => {
    relax(r);
    const w = new Float32Array(EXPRESSIONS.length);
    const k = r.emotion?.kind, e = Math.min(1, r.emotion?.weight ?? 0);
    if (k === "celebrate" || k === "join") w[0] = e;                   // joy
    else if (k === "dejected" || k === "near_miss") w[1] = e;          // frustration
    else if (k === "appeal" || k === "protest") w[2] = e;              // frowning at the referee
    if (!k && v > 5.5) w[2] = 1;                                       // determined: sprinting
    if (!w[0] && (ts * 0.31 + look.blink) % 1 < 0.035) w[3] = 1;       // a blink every ~3 s
    if (w.every((x, i) => x === last[i])) return;
    last.set(w);
    for (const m of managers) w.forEach((x, i) => { m.getTarget(i).influence = x; });
  };
}

const toonOnce = (m, opts) => { if (!m.pluginManager?.getPlugin("Toon")) toon(m, opts); return m; };

function dressAnime(lib, pid, { team, gk, shirt, captain, look }) {
  const prefix = `${pid}-`;
  const inst = lib.container.instantiateModelsToScene((n) => prefix + n, false, { doNotInstantiate: true });
  const kit = kitColours(team, gk);
  const skin = tinted(lib, "skin", look.skin, SKIN_LEVEL);
  const lin = (hex, f) => B.Color3.FromHexString(hex).toLinearSpace().scale(f);
  const face = shared(lib, `face|${look.eyes}|${look.hairColour}`, () => {
    const m = lib.base.face.clone(`fb-face-${lib.mats.size}`);
    const t = toon(m, { face: true, soft: true });
    t.iris = lin(look.eyes, 1.6);
    t.brow = lin(look.hairColour, 0.7);
    return m;
  });
  const hairBase = look.hair === "hair_crop" ? "hair_crop" : "hair";
  const mats = {
    skin, face_skin: tinted(lib, "face_skin", look.skin, SKIN_LEVEL), face,
    kit_shirt: shirtMaterial(lib, pid, kit, shirt, captain),
    kit_shorts: shortsMaterial(lib, pid, kit, shirt),
    kit_socks: socksMaterial(lib, kit),
    boots: tinted(lib, "boots", look.boots),
    forearms: gk ? tinted(lib, "kit_shorts", kit.shirt) : skin,
    hands: gk ? tinted(lib, "kit_shorts", kit.gloves) : skin,
    [hairBase]: tinted(lib, hairBase, look.hairColour, HAIR_LEVEL),
    kit_far: farMaterial(lib, [...farPalette(kit, look, gk), look.hairColour]),
  };
  const outline = shared(lib, "outline", () => outlineMaterial(lib.scene));
  const near = [], managers = [];
  let main = null, far = null;
  for (const m of inst.rootNodes[0].getChildMeshes(false)) {
    const part = m.name.slice(prefix.length).split("_primitive")[0];
    const styled = /^(hair|anime_lod1|anime_outline)_/.exec(part);
    const other = styled && part !== `${styled[1]}_${look.hair.slice(5)}`;
    if (other) { m.dispose(); continue; }
    const base = m.material?.name;
    if (!base) continue;   // the empty parent of a multi-primitive mesh
    m.alwaysSelectAsActiveMesh = true;   // the bind-pose bounding box is wrong once animated
    if (base === "outline") { m.material = outline; near.push(m); continue; }
    m.material = toonOnce(mats[base] ?? m.material, { soft: base === "face_skin" });
    if (part.startsWith("anime_lod1_")) { far = m; continue; }
    near.push(m);
    if (part === "anime" && base === "skin") main = m;
    if (m.morphTargetManager) { m.morphTargetManager.optimizeInfluencers = false; managers.push(m.morphTargetManager); }
  }
  // the near parts hand over to the far body (with its hair) all at once, as in dressFootballer
  const bounds = main.getBoundingInfo();
  for (const m of near) {
    m.useLODScreenCoverage = true;
    if (m !== main) m.setBoundingInfo(new B.BoundingInfo(bounds.minimum, bounds.maximum));
    m.addLODLevel(LOD_COVERAGE, m === main ? far : null);
  }
  return { ...inst, casters: [shadowTwin(far, main)], height: look.height, face: animeFace(managers, look, relaxJoints(lib.scene, inst.rootNodes[0], pid)) };
}

// After the clips and the upper-body emotions (players.js applyUpper), some joints of the anime body
// turn part of the way back to their rest pose:
// - the fingers by 45%, as the mannequin's clips close the hands into fists (at 70% they hung flat
//   and fanned out, a claw in the close-ups); a clip that wants a fist (FIST, cloned per player by
//   players.js) keeps it in proportion to its weight;
// - while a dejected motion clip plays (M_crouch_head_down, M_dejected_hips), the upper spine, neck
//   and head by SLUMP: a 1.4x head with big hair turns their head-down pose into a slump. The
//   look-at layer leaves the head to those clips (awareness-rig.js), so the order with it is moot.
// Returns the per-frame hook the face calls with the driver answers.
const FINGERS = /(thumb|index|middle|ring|pinky)_0[123]_[lr]$/, OPEN = 0.45;
const SLUMPED = /(spine_03|neck_01|Head)$/, SLUMP = 0.5;
const FIST = "M_celeb_jump_fist";
function relaxJoints(scene, root, pid) {
  const joints = root.getChildTransformNodes(false).filter((n) => n.rotationQuaternion && (FINGERS.test(n.name) || SLUMPED.test(n.name)))
    .map((n) => ({ n, rest: n.rotationQuaternion.clone(), finger: FINGERS.test(n.name) }));
  let fist = null, slump = 0, added = false;
  const step = () => {
    if (!root.isEnabled()) return;
    fist ??= scene.getAnimationGroupByName(`${pid}-${FIST}`);
    const open = OPEN * (1 - Math.min(1, fist?.animatables[0]?.weight ?? 0));
    for (const { n, rest, finger } of joints) {
      const a = finger ? open : SLUMP * slump;
      if (a > 0) B.Quaternion.SlerpToRef(n.rotationQuaternion, rest, a, n.rotationQuaternion);
    }
  };
  return (r) => {
    const e = r.emotion;
    slump = e?.kind === "dejected" && e.clip?.startsWith("M_") ? Math.min(1, e.weight ?? 0) : 0;
    // added on the first frame, so it runs after applyUpper (registered once the players exist)
    if (!added) { added = true; scene.onAfterAnimationsObservable.add(step); }
  };
}
