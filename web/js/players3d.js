// Footballers for the 3D scene: web/vendor/players/footballer.glb (scripts/build_footballer.py),
// a CC0 human body on the exact skeleton of the Quaternius mannequin. The GLB carries no clips:
// each player gets the mannequin's animation groups cloned onto its own nodes by name, so every
// clip of mannequin.glb (and the ball rig's leg poses) drives it unchanged.
//
//   const lib = await loadFootballer(scene, clipsContainer);
//   const inst = dressFootballer(lib, pid, { team, gk, shirt });   // -> { rootNodes, animationGroups }
//
// Materials in the GLB: skin, kit_shirt, kit_shorts, kit_socks, boots, forearms, hands, eyes,
// hair1, hair2. Skin and hair textures are detail maps normalised to a known level, so a tone is
// albedoColor = linear(tone) / level.

const B = window.BABYLON;
const SKIN_LEVEL = 0.6, HAIR_LEVEL = 0.5;
export const SKIN_TONES = ["#f2cfb3", "#e3b08c", "#c98f68", "#a86d4b", "#7d4b31", "#57321f"];
export const HAIR_COLOURS = ["#141110", "#2b1d14", "#4a3020", "#8a6239", "#b48a52"];
export const HAIR_STYLES = ["hair_buzzed", "hair_parted", "hair_buns"];
// shortcut: two keeper kits picked by side, as the mannequin look did; upgrade when the export carries keeper colours
const GK_KIT = { home: "#1f9d6b", away: "#7a3fb8" };
const LOD_COVERAGE = 0.012;   // screen share under which a body part switches to the 4k-triangle body

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
  };
}

// Relative luminance of a #rrggbb colour (WCAG), to pick a number colour that reads on the shirt.
export function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Kit colours of one player: outfield shirt and socks in the primary colour, shorts and the
// number in the secondary; keepers in their own shirt with dark shorts and light gloves.
export function kitColours(team, gk) {
  const shirt = gk ? GK_KIT[team.side] ?? GK_KIT.home : team.color_primary;
  const second = gk ? "#15171f" : team.color_secondary;
  const number = contrast(shirt, second) >= 2.5 ? second : luminance(shirt) > 0.3 ? "#111111" : "#ffffff";
  return { shirt, shorts: second, socks: shirt, number, gloves: gk ? "#e9edf2" : null, boots: "#16161a" };
}

export async function loadFootballer(scene, clips) {
  const container = await B.LoadAssetContainerAsync("vendor/players/footballer.glb", scene);
  const base = Object.fromEntries(container.materials.map((m) => [m.name, m]));
  return { scene, container, clips, base, mats: new Map() };
}

// One shared material per (base material, colour): kits of a team share their shorts and socks.
function tinted(lib, baseName, hex, level = 1) {
  const key = `${baseName}|${hex}|${level}`;
  if (!lib.mats.has(key)) {
    const m = lib.base[baseName].clone(`fb-${key}`);
    m.albedoColor = B.Color3.FromHexString(hex).toLinearSpace().scale(1 / level);
    lib.mats.set(key, m);
  }
  return lib.mats.get(key);
}

// The shirt with its number on the back. The shirt UV (build_footballer.shirt_uv) maps the back
// to v in [0, 0.5] with the collar at 0.5 and the side seen from behind along u, the number in u 0.16..0.34.
function shirtMaterial(lib, name, kit, shirt) {
  const S = 512;
  const tex = new B.DynamicTexture(`${name}-shirtTex`, { width: S, height: S }, lib.scene, true);
  const g = tex.getContext();
  g.fillStyle = kit.shirt;
  g.fillRect(0, 0, S, S);
  if (shirt != null) {
    g.save();
    g.translate(0.25 * S, 0.31 * S);
    g.scale(1, -1);   // the back runs hem-to-collar upwards in v
    g.fillStyle = kit.number;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `bold ${Math.round(0.2 * S)}px Arial Narrow, Arial, sans-serif`;
    g.fillText(String(shirt), 0, 0, 0.17 * S);
    g.restore();
  }
  tex.update(false);
  tex.wrapU = tex.wrapV = B.Texture.CLAMP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 4;
  const m = lib.base.kit_shirt.clone(`${name}-shirt`);
  m.albedoTexture = tex;
  m.albedoColor = B.Color3.White();
  return m;
}

// A footballer for player `pid`, instanced from the library: kit, number, skin, hair, the
// near/far body as LOD levels, and the mannequin's clips retargeted onto its nodes.
export function dressFootballer(lib, pid, { team, gk = false, shirt = null, look = playerLook(pid) }) {
  const prefix = `${pid}-`;
  const inst = lib.container.instantiateModelsToScene((n) => prefix + n, false, { doNotInstantiate: true });
  const root = inst.rootNodes[0];
  const kit = kitColours(team, gk);
  const mats = {
    skin: tinted(lib, "skin", look.skin, SKIN_LEVEL),
    kit_shirt: shirtMaterial(lib, pid, kit, shirt),
    kit_shorts: tinted(lib, "kit_shorts", kit.shorts),
    kit_socks: tinted(lib, "kit_socks", kit.socks),
    boots: tinted(lib, "boots", kit.boots),
    forearms: gk ? tinted(lib, "kit_shorts", kit.shirt) : tinted(lib, "skin", look.skin, SKIN_LEVEL),
    hands: gk ? tinted(lib, "kit_shorts", kit.gloves) : tinted(lib, "skin", look.skin, SKIN_LEVEL),
    hair1: tinted(lib, "hair1", look.hairColour, HAIR_LEVEL),
    hair2: tinted(lib, "hair2", look.hairColour, HAIR_LEVEL),
  };
  const near = {}, far = {};
  for (const m of root.getChildMeshes(false)) {
    const part = m.name.slice(prefix.length).split("_primitive")[0];
    const hair = HAIR_STYLES.includes(part) || part === "beard";
    if (hair && part !== look.hair && !(part === "beard" && look.beard)) { m.dispose(); continue; }
    const base = m.material?.name;
    if (!base) continue;   // the empty parent of a multi-primitive mesh
    if (mats[base]) m.material = mats[base];
    m.alwaysSelectAsActiveMesh = true;   // the bind-pose bounding box is wrong once animated
    if (part === "footballer") near[base] = m;
    if (part === "footballer_lod1") far[base] = m;
  }
  for (const [base, m] of Object.entries(near)) {
    m.useLODScreenCoverage = true;
    if (far[base]) m.addLODLevel(LOD_COVERAGE, far[base]);
  }
  // the clips: same joint names, so each animation is pointed at this player's node of that name
  const nodes = new Map(root.getChildTransformNodes(false).map((n) => [n.name.slice(prefix.length), n]));
  const animationGroups = lib.clips.animationGroups.map((g) => g.clone(prefix + g.name, (t) => nodes.get(t.name) ?? t));
  return { rootNodes: inst.rootNodes, animationGroups, skeletons: inst.skeletons };
}
