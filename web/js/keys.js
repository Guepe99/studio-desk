// The broadcast's keyboard shortcuts, the usual video player keys. Single keys work only with the focus in the
// broadcast or its controls and never in a text field: shortcuts scoped to a component (WCAG 2.1.4).

/** Focus in the broadcast or its controls, not in a text field, a select or the settings menu (its keys move through it). */
export const inScope = (el) => !!el?.closest?.("#frame, #controls") && !el.closest('input:not([type=range]), textarea, select, [contenteditable], [role="menu"]');

/** The action of a keydown as [name, value], or null. Space and N have their own handlers (app.js, moments.js).
 *  K play or pause; J and L 10 s back or on; arrows 5 s; 0 to 9 a tenth of the match; M voice; F full screen; ? the list. */
export function shortcut(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || !inScope(e.target)) return null;
  if (e.key === "?") return e.repeat ? null : ["keys"];
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code ?? "")?.[1]; // by position: on AZERTY the digits need Shift
  if (digit) return ["fraction", Number(digit) / 10];
  if (e.shiftKey || !e.key) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (/^[0-9]$/.test(k)) return ["fraction", Number(k) / 10];
  const step = { j: -10, l: 10, ArrowLeft: -5, ArrowRight: 5 }[k];
  if (step) return ["step", step];   // held down, it keeps moving
  if (e.repeat) return null;
  return { k: ["play"], m: ["voice"], f: ["fullscreen"] }[k] ?? null;
}
