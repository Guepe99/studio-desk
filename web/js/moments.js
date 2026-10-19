// "Next key moment" (docs/CONTRACT.md, Page additions): seeks to LEAD_S before the next story graphic
// on the sheet of the audience on screen. Template cues (story_id null) are not key moments.

export const LEAD_S = 3;
const AFTER_S = 0.5; // a press right after landing moves on instead of landing on the same moment again
const KEY = "n";

/** Seek targets, ascending. A story's graphic that starts while (or right as) the one before it from the
 *  same story ends is the same moment: the why card after a story's pass card is not a second stop. */
export function momentTargets(sheet) {
  const cues = sheet.filter((c) => c.story_id).sort((a, b) => a.ts - b.ts);
  return cues.filter((c, i) => !cues.slice(0, i).some((p) => p.story_id === c.story_id && c.ts <= p.ts + p.duration_s + 1))
    .map((c) => Math.max(0, c.ts - LEAD_S));
}

export const nextTarget = (targets, now) => targets.find((x) => x > now + AFTER_S);

export class Moments {
  /** @param {HTMLButtonElement} button
   *  @param {{state, seek: (ts: number) => void, t: (key: string) => string}} opts */
  constructor(button, opts) {
    Object.assign(this, opts);
    this.button = button;
    this.targets = [];
    this.shown = "";
    button.setAttribute("aria-keyshortcuts", KEY.toUpperCase());
    button.addEventListener("click", () => this.go());
    window.addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() !== KEY || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (e.target.closest?.("input:not([type=range]), textarea, select, [contenteditable], #desk")) return;
      e.preventDefault();
      this.go();
    });
  }

  setSheet(sheet) { this.targets = momentTargets(sheet); }

  go() {
    const ts = nextTarget(this.targets, this.state.ts);
    if (ts !== undefined) this.seek(ts);
  }

  /** Every frame: touches the DOM only when the button changes state or language. */
  update(now) {
    const key = nextTarget(this.targets, now) === undefined ? "nonext" : "next";
    if (this.shown === `${key}|${this.state.lang}`) return;
    this.shown = `${key}|${this.state.lang}`;
    this.button.disabled = key === "nonext";
    this.button.textContent = this.t(key);
    this.button.title = `${this.t(key)} (${KEY.toUpperCase()})`;
  }
}
