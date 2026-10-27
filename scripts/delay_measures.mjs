// What a broadcast delay changes on the 4 replay matches (docs/delay.md): for each delay, how many stories
// land on the delayed picture at their own moment, and how late the others land. Offline, reads only the
// exported replays in web/data/<match>/ (stories, cues, events).
//
//   node scripts/delay_measures.mjs
import { readFileSync } from "node:fs";
import { DELAYS, storyTimes } from "../web/js/delay.js";

const read = (m, f) => JSON.parse(readFileSync(new URL(`../web/data/${m}/${f}`, import.meta.url)));
const fmt = (x) => x.toFixed(1);
const rows = [], all = [];
for (const m of ["M001", "M002", "M003", "M004"]) {
  const times = storyTimes(read(m, "cues.json"), read(m, "stories.json"), read(m, "events.json"));
  rows.push([m, times]);
  all.push(...times);
}
rows.push(["all", all]);

console.log(`| match | stories | lead, median / max (s) | ${DELAYS.map((d) => `on the moment at ${d} s`).join(" | ")} | late at 5 s: how late, max (s) |`);
console.log(`|---|---|---|${DELAYS.map(() => "---").join("|")}|---|`);
for (const [m, times] of rows) {
  const leads = times.map((r) => r.lead).sort((a, b) => a - b);
  const median = leads.length % 2 ? leads[(leads.length - 1) / 2] : (leads[leads.length / 2 - 1] + leads[leads.length / 2]) / 2;
  const on = DELAYS.map((d) => times.filter((r) => r.lead <= d + 1e-6).length);
  const late5 = times.filter((r) => r.lead > 5 + 1e-6).map((r) => r.lead - 5);
  console.log(`| ${m} | ${times.length} | ${fmt(median)} / ${fmt(leads.at(-1))} | ${on.join(" | ")} | ${late5.length ? fmt(Math.max(...late5)) : "none late"} |`);
}
console.log("\nLate at 5 s (story, kind, lead in s):");
for (const [m, times] of rows.slice(0, -1)) {
  for (const r of times.filter((x) => x.lead > 5 + 1e-6)) console.log(`- ${m} ${r.story_id} ${r.kind} ${fmt(r.lead)}`);
}
