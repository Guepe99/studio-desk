// Render a stretch of a replay's booth plan to one MP3 with ffmpeg, the way web/js/booth-audio.js plays it: the
// booth clips at their planned times, the studio voice clips at their cues (one at a time, as voice.js), the
// crowd bed and reactions ducked under any voice. For listening and for level checks (docs/commentary.md).
//
//   node scripts/booth-render.mjs M001 en 475 715 out.mp3      (match, language, from s, to s, output)
//
// Reads web/data/<match>/ (with booth.json and booth/ copied from replays/<match>/), web/booth/ and
// web/vendor/crowd-audio/. Prints what plays and the ffmpeg command's outcome.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planMatch, inputs, studioInputs } from "../web/js/booth.js";
import { MIX } from "../web/js/booth-audio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [m, lang, from, to, out] = [process.argv[2], process.argv[3], +process.argv[4], +process.argv[5], process.argv[6]];
if (!out || !(to > from)) throw new Error("usage: node scripts/booth-render.mjs M001 en 475 715 out.mp3");
const web = (p) => path.join(ROOT, "web", p);
const read = (p) => JSON.parse(readFileSync(web(p), "utf8"));
const data = Object.fromEntries(["meta", "events", "facts", "cues", "voice", "stories"].map((f) => [f, read(`data/${m}/${f}.json`)]));
const shared = read("booth/booth.json"), local = read(`data/${m}/booth.json`);
const rows = new Map();
for (const [doc, dir] of [[shared, "booth"], [local, `data/${m}`]]) for (const r of doc.clips) if (r.lang === lang) rows.set(r.key, { file: web(`${dir}/${r.file}`), d: r.duration_s });

// the studio clips a first-time visitor hears: auto-approved stories, analyst sheet
const onAir = new Set(data.stories.filter((s) => s.default_status === "auto_approved").map((s) => s.story_id));
const vrows = data.voice.filter((r) => onAir.has(r.story_id));
const studio = studioInputs(data.cues.filter((c) => c.audience === "analyst"), vrows, lang);
const plan = planMatch({ lines: read("booth/lines.json"), lang, meta: data.meta, names: local.names[lang],
  durations: new Map([...rows].map(([k, r]) => [k, r.d])), seed: 1 }, inputs({ ...data, studio }));

// voice.js: one studio clip at a time, a later one waits at most 4 s of match time
const studioPlays = [];
for (const s of studio) {
  const last = studioPlays.at(-1), start = last ? Math.max(s.ts, last.t + last.d) : s.ts;
  if (start - s.ts <= 4) studioPlays.push({ t: start, d: s.d, file: web(`data/${m}/${vrows.find((r) => r.lang === lang && r.story_id === s.story_id).file}`) });
}

const clips = []; // {file, at, dur, bus, cut}
for (const it of plan) {
  if (it.t < from - 30 || it.t > to) continue;
  const stop = it.until ?? Infinity;
  if (stop <= it.t) continue;
  if (it.voice === "crowd") {
    const file = web(`vendor/crowd-audio/${it.kind}.mp3`);
    clips.push({ file, at: it.t, dur: Math.min(probe(file), stop - it.t), bus: "crowd" });
    continue;
  }
  for (const c of it.clips) {
    const at = it.t + c.off;
    if (at >= stop) break;
    clips.push({ file: rows.get(c.key).file, at, dur: Math.min(c.dur, stop - at), bus: "voice", cut: stop < at + c.dur });
  }
  if (it.t >= from) console.log(`${(it.t - from).toFixed(2).padStart(7)} ${it.voice.padEnd(4)} ${it.text}${it.until !== undefined ? " (cut)" : ""}`);
}
for (const s of studioPlays) if (s.t < to && s.t + s.d > from) {
  clips.push({ file: s.file, at: s.t, dur: s.d, bus: "voice" });
  console.log(`${(s.t - from).toFixed(2).padStart(7)} studio ${path.basename(s.file)}`);
}
const kept = clips.filter((c) => c.at + c.dur > from && c.at < to);

function probe(file) {
  return +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
}

// the duck: crowd gain MIX.duck while any voice speaks, eased in and out like setTargetAtTime
const voiceSpans = kept.filter((c) => c.bus === "voice").map((c) => [c.at - from, c.at - from + c.dur]).sort((a, b) => a[0] - b[0]);
const merged = [];
for (const s of voiceSpans) {
  if (merged.length && s[0] <= merged.at(-1)[1] + 0.3) merged.at(-1)[1] = Math.max(merged.at(-1)[1], s[1]);
  else merged.push([...s]);
}
const env = merged.map(([a, b]) => `if(between(t,${a.toFixed(3)},${(b + 2).toFixed(3)}),(1-exp(-(t-${a.toFixed(3)})/${MIX.duckIn}))*if(gt(t,${b.toFixed(3)}),exp(-(t-${b.toFixed(3)})/${MIX.duckOut}),1),0)`);
const duckExpr = env.length ? `1-${(1 - MIX.duck).toFixed(3)}*min(1,${env.join("+")})` : "1";

const len = to - from;
const tmp = mkdtempSync(path.join(tmpdir(), "booth-render-"));
const args = ["-v", "error", "-y"];
const graph = [];
kept.forEach((c, i) => {
  args.push("-i", c.file);
  const skip = Math.max(0, from - c.at), dur = c.dur - skip, delay = Math.max(0, c.at - from);
  const f = c.cut ? MIX.cut : MIX.fade;
  graph.push(`[${i}:a]aresample=24000,pan=mono|c0=c0,atrim=${skip.toFixed(3)}:${(skip + dur).toFixed(3)},asetpts=N/SR/TB,`
    + `afade=t=in:d=${MIX.fade},afade=t=out:st=${Math.max(0, dur - f).toFixed(3)}:d=${f},adelay=${Math.round(delay * 1000)},apad=whole_dur=${len}[c${i}]`);
});
const bed = kept.length;
args.push("-stream_loop", "-1", "-i", web("vendor/crowd-audio/bed.mp3"));
graph.push(`[${bed}:a]aresample=24000,atrim=0:${len},asetpts=N/SR/TB[bed]`);
const vs = kept.map((c, i) => (c.bus === "voice" ? `[c${i}]` : "")).join(""), cs = kept.map((c, i) => (c.bus === "crowd" ? `[c${i}]` : "")).join("");
const nv = kept.filter((c) => c.bus === "voice").length, nc = kept.filter((c) => c.bus === "crowd").length;
graph.push(`${vs}amix=inputs=${nv}:normalize=0:duration=longest,atrim=0:${len}[voice]`);
graph.push(`[bed]${cs}amix=inputs=${nc + 1}:normalize=0:duration=first,volume=${MIX.crowd},asetnsamples=240,volume='${duckExpr}':eval=frame[crowd]`);
graph.push("[voice]asplit[v1][v2]", "[crowd]asplit[k1][k2]", "[v1][k1]amix=inputs=2:normalize=0[out]");
const script = path.join(tmp, "graph.txt");
writeFileSync(script, graph.join(";\n"));
const stems = path.join(path.dirname(out), path.basename(out, ".mp3"));
args.push("-filter_complex_script", script,
  "-map", "[out]", "-ac", "1", "-ar", "24000", "-b:a", "96k", out,
  "-map", "[v2]", "-ac", "1", `${stems}.voice.wav`, "-map", "[k2]", "-ac", "1", `${stems}.crowd.wav`);
execFileSync("ffmpeg", args, { stdio: "inherit" });
rmSync(tmp, { recursive: true, force: true });
console.log(`${out}: ${len} s, ${kept.filter((c) => c.bus === "voice").length} voice clips, ${nc} crowd sounds; stems ${stems}.voice.wav, ${stems}.crowd.wav`);
