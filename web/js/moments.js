// "Next key moment" (docs/CONTRACT.md, Page additions): seeks to LEAD_S before the next story graphic
// on the sheet of the audience on screen. Template cues (story_id null) are not key moments. With the AI
// graphics off there are no story graphics: the button goes from goal to goal (score facts are not AI) and says so.

import { inScope } from "./keys.js";

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

/** With the AI off: LEAD_S before each goal, ascending. */
export const goalTargets = (goalTs) => [...goalTs].sort((a, b) => a - b).map((ts) => Math.max(0, ts - LEAD_S));

// the button's words for the same key when it goes from goal to goal
const GOAL_KEY = { next: "nextGoal", nonext: "nonextGoal", nokey: "nokeyGoal" };

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
  return inScope(e.target);
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

  /** @param {boolean} loaded  the stories are in: before that the sheet has templates only
   *  @param {number[]|null} goals  the goal times when the AI graphics are off, else null */
  setSheet(sheet, loaded, goals = null) {
    this.goals = !!goals;
    this.targets = goals ? goalTargets(goals) : momentTargets(sheet);
    this.loaded = loaded || this.goals; // the goals are in the replay from the start
  }

  go() {
    const ts = nextTarget(this.targets, this.state.ts);
    if (ts === undefined) {
      // aria-disabled keeps the focus on the button; the press still says why nothing happened
      if (this.loaded) {
        this.live.textContent = "";
        requestAnimationFrame(() => { this.live.textContent = this.label(momentKey(this.targets, this.state.ts, true)); });
      }
      return;
    }
    if (this.state.speed > 1) this.setSpeed(1); // at 64x the 3 s lead and the card would flash past
    this.seek(ts);
  }

  /** Every frame: touches the DOM only when the button changes state or language. */
  update(now) {
    const key = momentKey(this.targets, now, this.loaded), off = !this.loaded || key !== "next";
    const shown = `${key}|${off}|${this.goals}|${this.state.lang}`;
    if (this.shown === shown) return;
    this.shown = shown;
    this.button.setAttribute("aria-disabled", String(off));
    this.button.lang = this.state.lang;
    this.button.textContent = this.label(key);
    this.button.title = `${this.goals ? `${this.t("goalsHint")}. ` : ""}${this.label(key)} (${KEY.toUpperCase()})`;
  }

  label(key) { return this.t(this.goals ? GOAL_KEY[key] : key); }
}
