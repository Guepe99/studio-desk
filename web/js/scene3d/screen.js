// The stadium's big screens (plan step p66): the two team short names, the score and the match minute,
// on two screens in the far corners of the ground, both showing one texture (one draw call for the
// faces, one for the housings).
//
// Where: on legs in the open corner between the far side stand and each end stand, just behind the
// boards, bottom 1 m and top 4.2 m up, turned to the broadcast camera. That is the only height the
// cameras see: at the far corners camera 1 on its long lens shows the ground up to about 3 to 5 m
// (docs/broadcast3d.md, "Big screen"), so a screen up under a roof would never be on air, and a taller
// one is cut by the top of the frame. The left screen is in the
// wide shot when play is in the far half near the left goal, the right one near the right goal, and
// the pitch-level replay angle ("low", in line with the 18-yard line) looks straight at the screen of
// its end. Beyond the corner flag, so everything on the pitch is in front of it: it never hides play.
//
// What: the numbers come from the match data only, the score facts (match.score) and the match clock
// (match.clock), at the time the scene shows (a replay shows the screen as it was then). The canvas is
// drawn again only when that text changes (once a minute, or at a goal), never per frame; a seek
// draws it at once if the text differs.
export const SIZE = [6.4, 3.2];            // metres, 2:1 like the 1024 x 512 texture (a power of two for WebGL 1)
export const BOTTOM = 1;                   // metres from the ground to the bottom edge, just over the 0.9 m boards
export const SPOT = [58.4, 40.6];          // world |x|, z of the screen centre (the corner at 52.5, 34)
const TEX = [1024, 512];

// The screen's text at match time ts: {home, away, score, clock} and a key that changes when any does.
export function screenText(match, ts) {
  const [h, a] = match.score(ts), clock = `${match.clock(ts).label}'`;
  const home = match.home.short_name, away = match.away.short_name;
  return { home, away, score: [h, a], clock, key: `${home}|${h}|${a}|${away}|${clock}` };
}

export function buildScreens(scene, match, profile, camPos) {
  const B = window.BABYLON;
  const tex = new B.DynamicTexture("bigScreen", { width: TEX[0], height: TEX[1] }, scene, true);
  tex.anisotropicFilteringLevel = profile.aniso ?? 4;
  const m = new B.StandardMaterial("bigScreenMat", scene);
  m.diffuseTexture = tex; m.emissiveTexture = tex;
  m.disableLighting = true;
  const housing = new B.PBRMaterial("bigScreenBox", scene);
  housing.albedoColor = new B.Color3(0.05, 0.06, 0.1);
  housing.metallic = 0; housing.roughness = 0.8;

  const faces = [], boxes = [];
  const [W, H] = SIZE, mid = BOTTOM + H / 2;
  for (const sx of [-1, 1]) {
    const x = sx * SPOT[0], z = SPOT[1];
    // turned to camera 1: a plane shows its front to -Z, so yaw = atan2(-nx, -nz) for the normal n
    const yaw = Math.atan2(-(camPos.x - x), -(camPos.z - z));
    const face = B.MeshBuilder.CreatePlane("bigScreen", { width: W, height: H }, scene);
    face.position.set(x, mid, z); face.rotation.y = yaw; faces.push(face);
    const back = new B.Vector3(Math.sin(yaw), 0, Math.cos(yaw));   // away from the face, towards the stands
    const box = B.MeshBuilder.CreateBox("bigScreenBox", { width: W + 0.3, height: H + 0.3, depth: 0.4 }, scene);
    box.position.set(x + back.x * 0.22, mid, z + back.z * 0.22); box.rotation.y = yaw; boxes.push(box);
    for (const s of [-1, 1]) {
      const leg = B.MeshBuilder.CreateBox("bigScreenLeg", { width: 0.35, height: BOTTOM, depth: 0.35 }, scene);
      const along = s * (W / 2 - 1.2);
      leg.position.set(x + back.x * 0.22 + Math.cos(yaw) * along, BOTTOM / 2, z + back.z * 0.22 - Math.sin(yaw) * along);
      leg.rotation.y = yaw; boxes.push(leg);
    }
  }
  const merge = (list, mat) => {
    const out = B.Mesh.MergeMeshes(list, true, true);
    out.material = mat; out.freezeWorldMatrix(); out.doNotSyncBoundingInfo = true;
    return out;
  };
  const meshes = [merge(faces, m), merge(boxes, housing)];
  m.freeze(); housing.freeze();

  const screen = {
    key: null, draws: 0, meshes,
    update(ts) {
      const s = screenText(match, ts);
      if (s.key === screen.key) return;
      screen.key = s.key;
      draw(tex, s, match);
      screen.draws++;
      // the first draw can come before the web font: draw again once it is in
      if (!document.fonts?.check("800 100px Urbanist")) document.fonts?.ready.then(() => { screen.key = null; });
    },
  };
  return screen;
}

// The board look of the page (broadcast.css): purple, a green score box and edge, white names.
function draw(tex, s, match) {
  const g = tex.getContext(), [w, h] = TEX;
  g.fillStyle = "#37003c"; g.fillRect(0, 0, w, h);
  g.fillStyle = "#00ff87"; g.fillRect(0, h - 16, w, 16);
  g.textBaseline = "middle"; g.textAlign = "center";
  const font = (px) => `800 ${px}px 'Urbanist', Arial, sans-serif`;
  // first row: chip, name, score box, name, chip; shrunk to fit the width
  const score = `${s.score[0]}-${s.score[1]}`;
  let px = 150;
  const widths = () => { g.font = font(px); return [g.measureText(s.home).width, g.measureText(score).width + 60, g.measureText(s.away).width]; };
  let [hw, sw, aw] = widths();
  const room = w - 2 * (40 + 22 + 30);
  if (hw + sw + aw + 60 > room) { px = Math.floor(px * room / (hw + sw + aw + 60)); [hw, sw, aw] = widths(); }
  const row = 190, total = 22 + 30 + hw + 30 + sw + 30 + aw + 30 + 22;
  let x = (w - total) / 2;
  const chip = (color) => { g.fillStyle = color; g.fillRect(x, row - px * 0.42, 22, px * 0.84); x += 22 + 30; };
  chip(match.home.color_primary);
  g.fillStyle = "#ffffff"; g.fillText(s.home, x + hw / 2, row); x += hw + 30;
  g.fillStyle = "#00ff87"; g.fillRect(x, row - px * 0.6, sw, px * 1.2);
  g.fillStyle = "#37003c"; g.fillText(score, x + sw / 2, row + px * 0.04); x += sw + 30;
  g.fillStyle = "#ffffff"; g.fillText(s.away, x + aw / 2, row); x += aw + 30;
  chip(match.away.color_primary);
  // second row: the minute
  g.font = font(130); g.fillStyle = "#00ff87";
  g.fillText(s.clock, w / 2, 395);
  tex.update(true);
}
