// The stadium's big screens (plan step p66): the show's wordmark on two screens in the far corners of the
// ground, both showing one texture (one draw call for the faces, one for the housings).
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
// What: a fixed wordmark, never the score or the clock. The screens used to show both in the score bug's
// look, and in the wide shot the left one sits just behind and above the score bug: viewers read it as a
// second, smaller score bug peeking out. The score has one place on screen, the score bug. The canvas is
// drawn once, and again when the web font arrives.
export const SIZE = [6.4, 3.2];            // metres, 2:1 like the 1024 x 512 texture (a power of two for WebGL 1)
export const BOTTOM = 1;                   // metres from the ground to the bottom edge, just over the 0.9 m boards
export const SPOT = [58.4, 40.6];          // world |x|, z of the screen centre (the corner at 52.5, 34)
export const WORDMARK = "STUDIO DESK";
const TEX = [1024, 512];

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

  const screen = { draws: 0, meshes, text: WORDMARK };
  const paint = () => { draw(tex, match); screen.draws++; };
  paint();
  // the first draw can come before the web font: draw again once it is in
  if (!document.fonts?.check("800 100px Urbanist")) document.fonts?.ready.then(paint);
  return screen;
}

// The board look of the page (broadcast.css): purple, a green edge, the two club colours on top, the white wordmark.
function draw(tex, match) {
  const g = tex.getContext(), [w, h] = TEX;
  g.fillStyle = "#37003c"; g.fillRect(0, 0, w, h);
  g.fillStyle = "#00ff87"; g.fillRect(0, h - 16, w, 16);
  g.fillStyle = match.home.color_primary; g.fillRect(0, 0, w / 2, 16);
  g.fillStyle = match.away.color_primary; g.fillRect(w / 2, 0, w / 2, 16);
  g.textBaseline = "middle"; g.textAlign = "center";
  const font = (px) => `800 ${px}px 'Urbanist', Arial, sans-serif`;
  g.font = font(150);
  g.font = font(Math.min(150, Math.floor(150 * (w - 120) / g.measureText(WORDMARK).width)));   // shrunk to fit the width
  g.fillStyle = "#ffffff"; g.fillText(WORDMARK, w / 2, h / 2);
  tex.update(true);
}
