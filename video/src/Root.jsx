import { AbsoluteFill, Audio, Composition, Still, Easing, Img, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";

// The submission video, docs/VIDEO-SCRIPT.md, built from stills of the live site (video/capture.mjs) and the
// Kokoro voice-over (video/voice.py). Times are in seconds; each segment lasts its voice line plus a pause.
const FPS = 30;
const W = 1920, H = 1080;
const PURPLE = "#37003c", GREEN = "#00ff85", CYAN = "#04f5ff", INK = "#1a0a1e";
const font = { fontFamily: "Urbanist, sans-serif" };
const fontFace = `@font-face { font-family: "Urbanist"; font-weight: 400 800; src: url("${staticFile("Urbanist-latin-wght.woff2")}") format("woff2"); }`;
const s = (sec) => Math.round(sec * FPS);
const ease = Easing.bezier(0.45, 0, 0.25, 1);

// one still, moving from rect a to rect b ({x, y, w} in screenshot pixels, 16:9) between frames f0 and f1
const Shot = ({ src, a, b = a, f0 = 0, f1 = 90 }) => {
  const f = useCurrentFrame();
  const t = interpolate(f, [f0, f1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, w = a.w + (b.w - a.w) * t;
  const k = W / w;
  return (
    <AbsoluteFill style={{ background: "#fff", overflow: "hidden" }}>
      <Img src={staticFile(`shots/${src}.png`)} style={{ position: "absolute", width: W, height: H, transformOrigin: "0 0", transform: `scale(${k}) translate(${-x}px, ${-y}px)` }} />
    </AbsoluteFill>
  );
};

// a 3D clip of the live site: frames clips/<name>/NNNN.jpg captured at 30 fps by video/clips.mjs, the last one held
const Clip = ({ name, n }) => {
  const f = Math.min(useCurrentFrame(), n - 1);
  return (
    <AbsoluteFill style={{ background: INK }}>
      <Img src={staticFile(`clips/${name}/${String(f).padStart(4, "0")}.jpg`)} style={{ width: W, height: H, objectFit: "cover" }} />
    </AbsoluteFill>
  );
};

const Fade = ({ children, dur, inF = 8, outF = 8 }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, inF, dur - outF, dur], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

// pos: "center" (bottom), "top", or "left" (bottom left, over the 3D, when the zoom is on the desk)
const Caption = ({ text, small, pos = "center" }) => (
  <AbsoluteFill style={{ justifyContent: pos === "top" ? "flex-start" : "flex-end", alignItems: pos === "left" ? "flex-start" : "center", padding: "90px 50px 56px" }}>
    <div style={{ ...font, background: PURPLE, color: "#fff", fontWeight: 700, fontSize: small ? 38 : 50, lineHeight: 1.2, padding: "18px 36px", borderRadius: 10, maxWidth: pos === "left" ? 760 : 1600, textAlign: pos === "left" ? "left" : "center", boxShadow: "0 8px 30px rgba(0,0,0,.35)", borderBottom: `6px solid ${GREEN}` }}>{text}</div>
  </AbsoluteFill>
);

// top right over the 3D (stands, not the scoreboard), bottom right over the desk stills (not the page's own text)
const Label = ({ text = "Live site, stills · replay of agent output recorded on Azure", top }) => (
  <AbsoluteFill style={{ alignItems: "flex-end", justifyContent: top ? "flex-start" : "flex-end", padding: 12 }}>
    <div style={{ ...font, background: "rgba(26,10,30,.82)", color: "#fff", fontSize: 20, fontWeight: 600, padding: "6px 14px", borderRadius: 6 }}>
      {text}
    </div>
  </AbsoluteFill>
);

const Card = ({ children }) => (
  <AbsoluteFill style={{ ...font, background: PURPLE, color: "#fff", justifyContent: "center", alignItems: "center", padding: 120 }}>{children}</AbsoluteFill>
);

const Pipeline = () => {
  const f = useCurrentFrame();
  const names = ["Ingest", "Interpret", "Explain", "Render", "Personalize"];
  return (
    <Card>
      <div style={{ fontSize: 50, fontWeight: 700, marginBottom: 80, textAlign: "center" }}>Studio Desk: AI agents find the stories in a match.<br /><span style={{ color: GREEN }}>The producer decides what goes on air.</span></div>
      <div style={{ display: "flex", gap: 28, alignItems: "center" }}>
        {names.map((n, i) => {
          const on = f >= s(0.6 + i * 0.9);
          return (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: 28 }}>
              <div style={{ fontSize: 58, fontWeight: 800, padding: "22px 34px", borderRadius: 12, background: on ? GREEN : "rgba(255,255,255,.08)", color: on ? INK : "rgba(255,255,255,.45)" }}>{n}</div>
              {i < names.length - 1 && <div style={{ fontSize: 50, color: on ? GREEN : "rgba(255,255,255,.3)" }}>›</div>}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 40, marginTop: 70, color: CYAN, fontWeight: 600 }}>Synthetic match data from our own simulator</div>
    </Card>
  );
};

const Lines = ({ lines, step = 1.6, size = 64 }) => {
  const f = useCurrentFrame();
  return (
    <Card>
      <div style={{ display: "grid", gap: 44, width: "100%" }}>
        {lines.map((l, i) => (
          <div key={l} style={{ fontSize: size, fontWeight: 700, opacity: interpolate(f, [s(i * step), s(i * step) + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }), borderLeft: `10px solid ${GREEN}`, paddingLeft: 36 }}>{l}</div>
        ))}
      </div>
    </Card>
  );
};

// the On air card of the desk, cropped from a still
const End = () => (
  <Card>
    <div style={{ fontSize: 96, fontWeight: 800, color: GREEN }}>Try it now. No account needed.</div>
    <div style={{ fontSize: 40, marginTop: 60, fontWeight: 600 }}>studiodesk.calmmoss-3f076252.swedencentral.azurecontainerapps.io</div>
    <div style={{ fontSize: 40, marginTop: 24, color: CYAN, fontWeight: 600 }}>github.com/Guepe99/studio-desk</div>
  </Card>
);

const R = (x, y, w) => ({ x, y, w });
// the English subtitle of the Italian fan's card in the multiview (Official Rules 4.9), filled from the still
const MV_SUB = "Italian card: shot speed, Hugo Okowande, 92.1 km/h. Goal";
const FULL = R(0, 0, 1920), DESK = R(1100, 60, 820);

// segments: voice file, length in seconds, and what is on screen (relative times)
const SEGMENTS = [
  { v: 1, len: 6.2, clip: [["chance", 150]], caps: [["Seconds to decide what goes on air.", 0]] },
  { v: 2, len: 15.4, cards: [[Pipeline, 0, 6.5]], shots: [{ src: "03-agents", a: FULL, b: R(160, 90, 1700), at: 6.5 }], caps: [["Microsoft Agent Framework and Foundry: every number from code", 6.8], ["Low risk airs on its own. Anything risky waits for the producer.", 11.0]] },
  { v: 3, len: 9.4, shots: [{ src: "03-agents", a: R(0, 281, 1420), b: R(0, 281, 1420), at: 0, dur: 4.6 }, { src: "03-agents", a: R(1000, 60, 920), b: DESK, at: 4.6 }],
    caps: [["Story finder, analyst, 3 commentators, verifier, director", 0, false, "top"], ["MCP server: the agents see the match only up to now", 4.6, false, "left"]] },
  { v: 4, len: 5.6, shots: [{ src: "04a-typing", a: R(1000, 60, 920), at: 0, dur: 2.2 }, { src: "04b-refused", a: R(1000, 60, 920), b: DESK, at: 2.2 }], pos: "left", caps: [["Invented number: refused and logged.", 2.2]] },
  { v: 5, len: 6.0, shots: [{ src: "05-details", a: R(1100, 290, 820), b: R(1100, 520, 820), at: 0 }], pos: "left", caps: [["Every number: a fact computed by code.", 0.3]] },
  { v: 6, len: 7.4, shots: [{ src: "06a-proposal", a: DESK, at: 0, dur: 2.4 }, { src: "06b-onair", a: R(0, 40, 1500), at: 2.4, dur: 2.4 }, { src: "06c-audit", a: R(1300, 40, 620), b: R(1320, 60, 580), at: 4.8 }],
    caps: [["One click puts the agents' line on air", 0, false, "left"], ["One click puts the agents' line on air", 2.4], ["Both decisions in the audit log", 4.8, false, "left"]] },
  // no narrator: the goal, then the site's own booth call (sfx/goal-call.wav: English, Italian, Spanish)
  { len: 10.0, clip: [["goal", 195], ["goal2", 75]], call: 3.8,
    caps: [["", 0], ["Booth commentary on the site · English", 3.8, true], ["Booth commentary on the site · Italian", 5.85, true], ["Booth commentary on the site · Spanish", 8.2, true]] },
  { v: 7, len: 12.6, shots: [{ src: "07a-multiview", a: FULL, b: R(60, 40, 1800), at: 0, dur: 6.2 }, { src: "07b-multiview-it", a: FULL, b: R(60, 34, 1800), at: 6.2 }],
    caps: [["One desk, four audiences at once: analyst, kids, a fan in Italian, a casual fan in Spanish", 0.3, true, "top"], [MV_SUB, 6.2, true]] },
  { v: 8, len: 8.2, shots: [{ src: "08a-ask", a: R(1000, 520, 920), at: 0, dur: 2.8 }, { src: "08b-answer", a: R(1000, 563, 920), b: R(1040, 583, 880), at: 2.8 }], pos: "left", caps: [["Only facts up to the replay time. Content Safety on question and answer.", 0.5, true]] },
  { v: 9, len: 11.6, shots: [{ src: "09b-ai-off", a: R(900, 0, 1020), b: R(1000, 0, 920), at: 0, dur: 4.2 }, { src: "09c-traces", a: R(1100, 380, 820), b: R(1100, 600, 820), at: 8.6 }],
    cards: [[() => <Lines lines={["Tested with every model call failing:", "the test match still aired 15 stories in 3 languages."]} step={0.6} />, 4.2, 4.4]],
    pos: "left", caps: [["AI off: only template graphics on air", 0], ["", 4.2], ["Traces: agent, model, tokens and cost for every step", 8.6, true]] },
  { v: 10, len: 8.0, cards: [[() => <Lines lines={["$0.06 to $0.10 a match in model calls", "Managed identity: no key for the model", "Every Azure resource in Bicep, on Azure Container Apps", "668 + 282 tests on every push"]} step={1.8} size={58} />, 0, 8.0]] },
  { v: 11, len: 9.8, shots: [{ src: "11a-shift", a: R(0, 40, 1500), at: 0, dur: 3.6 }, { src: "11b-shift-details", a: R(1100, 60, 820), b: R(1100, 600, 820), at: 3.6 }],
    caps: [["Agents found 11 of 14 planted storylines (rules alone: 9)", 0, true], ["", 3.6], ["Today: no sign-in. Next: Entra ID roles, durable audit store, real feed", 5.2, true, "left"]] },
  { end: true, len: 5.0 },
];

// the YouTube thumbnail is the first second, so the video opens on it; then a short lead
const COVER = 1.0, LEAD = 0.3;
let at = COVER + LEAD;
const TIMED = SEGMENTS.map((g) => { const r = { ...g, start: at }; at += g.len; return r; });
const TOTAL = s(at);

const Segment = ({ g }) => {
  const L = s(g.len);
  const items = (g.shots ?? []).map((sh, i, all) => {
    const st = s(sh.at), en = sh.dur != null ? s(sh.at + sh.dur) : (all[i + 1] ? s(all[i + 1].at) : L);
    return { kind: "shot", from: st, dur: en - st, sh };
  });
  return (
    <AbsoluteFill>
      {g.clip && <><Fade dur={L} inF={g.v === 1 ? 1 : 6} outF={6}>{g.clip.map(([name, n], i) => {
        const from = g.clip.slice(0, i).reduce((a, c) => a + c[1], 0), last = i === g.clip.length - 1;
        return <Sequence key={name} from={from} durationInFrames={last ? L - from : n}><Clip name={name} n={n} /></Sequence>;
      })}</Fade><Label top text="Live site · 3D replay of the synthetic match, recorded frame by frame" /></>}
      {items.map(({ from, dur, sh }, i) => (
        <Sequence key={`s${i}`} from={from} durationInFrames={dur}>
          <Fade dur={dur} inF={6} outF={6}><Shot src={sh.src} a={sh.a} b={sh.b} f0={0} f1={dur} /></Fade>
          <Label />
        </Sequence>
      ))}
      {(g.cards ?? []).map(([C, st, d], i) => (
        <Sequence key={`c${i}`} from={s(st)} durationInFrames={s(d)}><Fade dur={s(d)}><C /></Fade></Sequence>
      ))}
      {(g.caps ?? []).map(([text, st, small, pos], i, all) => {
        const end = all[i + 1] ? s(all[i + 1][1]) : L;
        if (!text) return null;
        return <Sequence key={`t${i}`} from={s(st)} durationInFrames={end - s(st)}><Fade dur={end - s(st)} inF={6} outF={6}><Caption text={text} small={small} pos={pos ?? g.pos} /></Fade></Sequence>;
      })}
      {g.end && <Fade dur={L} outF={1}><End /></Fade>}
    </AbsoluteFill>
  );
};

// No crowd sound under the voice: the only sound besides the narrator is the booth's own goal call.
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" };
const GOAL = TIMED.find((g) => g.call);
const SFX = [["goal-call", GOAL.start + GOAL.call, 6.2, 0.6]];
const Sfx = ([name, st, len, vol]) => (
  <Sequence key={name} from={s(st)} durationInFrames={s(len)}>
    <Audio src={staticFile(`sfx/${name}${name.includes("-") ? ".wav" : ".mp3"}`)} volume={(f) => vol * interpolate(f, [0, 3, s(len) - s(1.2), s(len)], [0, 1, 1, 0], clamp)} />
  </Sequence>
);

const Video = () => (
  <AbsoluteFill style={{ background: PURPLE }}>
    <style>{fontFace}</style>
    <Sequence durationInFrames={s(COVER)}>
      <AbsoluteFill style={{ width: 1280, height: 720, transformOrigin: "0 0", transform: `scale(${W / 1280})` }}><Thumbnail /></AbsoluteFill>
    </Sequence>
    {TIMED.map((g, i) => (
      <Sequence key={i} from={s(g.start)} durationInFrames={s(g.len)}>
        <Segment g={g} />
        {g.v && <Audio src={staticFile(`voice/v${String(g.v).padStart(2, "0")}.wav`)} />}
      </Sequence>
    ))}
    {SFX.map(Sfx)}
  </AbsoluteFill>
);

// the YouTube thumbnail, 1280x720: the goal in 3D behind, the promise in big words, the card waiting for the producer
const Thumbnail = () => (
  <AbsoluteFill style={{ ...font, background: INK }}>
    <style>{fontFace}</style>
    <Img src={staticFile("clips/chance/0104.jpg")} style={{ position: "absolute", width: 1372, height: 771, left: -20, top: -12 }} />
    <AbsoluteFill style={{ background: "linear-gradient(270deg, rgba(26,10,30,.95) 0%, rgba(26,10,30,.85) 36%, rgba(26,10,30,0) 52%)" }} />
    <AbsoluteFill style={{ background: "radial-gradient(ellipse 330px 190px at 1100px 690px, rgba(26,10,30,.95) 50%, rgba(26,10,30,0) 100%)" }} />
    <div style={{ position: "absolute", right: 40, top: 40, textAlign: "right", fontWeight: 800, fontSize: 70, lineHeight: 1.02, color: "#fff", textShadow: "0 4px 18px rgba(0,0,0,.7)" }}>
      AI finds<br />the stories.<br /><span style={{ color: GREEN }}>You put them<br />on air.</span>
    </div>
    <div style={{ position: "absolute", left: 35, top: 539, width: 645, height: 174, borderRadius: 16, border: `6px solid ${GREEN}`, boxShadow: `0 0 24px ${GREEN}` }} />
    <div style={{ position: "absolute", left: 35, top: 497, background: GREEN, color: INK, fontWeight: 800, fontSize: 30, padding: "4px 14px", borderRadius: 8 }}>EVERY NUMBER FROM CODE</div>
    <div style={{ position: "absolute", right: 16, bottom: 18, background: PURPLE, color: "#fff", fontWeight: 800, fontSize: 50, padding: "20px 40px", borderRadius: 999, boxShadow: `0 0 0 6px ${GREEN}, 0 16px 40px rgba(0,0,0,.6)` }}>✓ Put on air</div>
    <svg width="70" height="90" viewBox="0 0 14 18" style={{ position: "absolute", right: 44, bottom: -34 }}>
      <path d="M1 1 L1 15 L4.5 11.5 L7 17 L9.5 16 L7 10.5 L12 10.5 Z" fill="#fff" stroke={INK} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  </AbsoluteFill>
);

export const Root = () => (
  <>
    <Composition id="studio-desk" component={Video} durationInFrames={TOTAL} fps={FPS} width={W} height={H} />
    <Still id="thumbnail" component={Thumbnail} width={1280} height={720} />
  </>
);
