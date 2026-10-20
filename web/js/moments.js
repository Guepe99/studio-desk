// "Next key moment" (docs/CONTRACT.md, Page additions): seeks to LEAD_S before the next story graphic
// on the sheet of the audience on screen. Template cues (story_id null) are not key moments.

export const LEAD_S = 3;
const AFTER_S = 0.5; // a press right after landing moves on instead of landing on the same moment again
const KEY = "n";

/** Seek targets, ascending. A story graphic that starts while (or right as) an earlier story graphic is
 *  on air, whatever its story, is the same moment: one stop per goal, not one per card. */
export function momentTargets(sheet) {
  const cues = sheet.filter((c) => c.story_id).sort((a, b) => a.ts - b.ts);
  return cues.filter((c, i) => !cues.slice(0, i).some((p) => c.ts <= p.ts + p.duration_s + 1))
    .map((c) => Math.max(0, c.ts - LEAD_S));
}

export const nextTarget = (targets, now) => targets.find((x) => x > now + AFTER_S);

/** The key the button shows: stories still loading, none at all, none ahead, or a next one. */
export function momentKey(targets, now, loaded) {
  if (!loaded) return "next";
  if (!targets.length) return "nokey";
  return nextTarget(targets, now) === undefined ? "nonext" : "next";
}

/** N on its own (no Ctrl, Alt, Meta or Shift, no key repeat) with focus in the broadcast or its controls
 *  and not in a text field: a single-key shortcut scoped to a component (WCAG 2.1.4). */
export function isMomentKey(e) {
  if (e.key?.toLowerCase() !== KEY || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return false;
  const el = e.target;
  return !!el.closest?.("#frame, #controls") && !el.closest("input:not([type=range]), textarea, select, [contenteditable]");
}

export class Moments {
  /** @param {HTMLButtonElement} button
   *  @param {{state, seek: (ts: number) => void, setSpeed: (x: number) => void, t: (key: string) => string,
   *    live: HTMLElement}} opts  live: a polite live region for "no more" */
  constructor(button, opts) {
    Object.assign(this, opts);
    this.button = button;
    this.targets = [];
    this.loaded = false;
    this.shown = "";
    button.setAttribute("aria-keyshortcuts", KEY.toUpperCase());
    button.addEventListener("click", () => this.go());
    window.addEventListener("keydown", (e) => {
      if (!isMomentKey(e)) return;
      e.preventDefault();
      this.go();
    });
  }

  /** @param {boolean} loaded  the stories are in: before that the sheet has templates only */
  setSheet(sheet, loaded) { this.targets = momentTargets(sheet); this.loaded = loaded; }

  go() {
    const ts = nextTarget(this.targets, this.state.ts);
    if (ts === undefined) {
      // aria-disabled keeps the focus on the button; the press still says why nothing happened
      if (this.loaded) {
        this.live.textContent = "";
        requestAnimationFrame(() => { this.live.textContent = this.t(momentKey(this.targets, this.state.ts, true)); });
      }
      return;
    }
    if (this.state.speed > 1) this.setSpeed(1); // at 64x the 3 s lead and the card would flash past
    this.seek(ts);
  }

  /** Every frame: touches the DOM only when the button changes state or language. */
  update(now) {
    const key = momentKey(this.targets, now, this.loaded), off = !this.loaded || key !== "next";
    const shown = `${key}|${off}|${this.state.lang}`;
    if (this.shown === shown) return;
    this.shown = shown;
    this.button.setAttribute("aria-disabled", String(off));
    this.button.lang = this.state.lang;
    this.button.textContent = this.t(key);
    this.button.title = `${this.t(key)} (${KEY.toUpperCase()})`;
  }
}
