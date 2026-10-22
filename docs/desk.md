# Control desk

The control desk is where the producer approves, edits or rejects the graphics the agents propose
(`web/js/desk.js`, `web/css/desk.css`). The owner found the first version "a jumble of information
and hard for the user": it listed every story of the match, future ones included, as 24 cards of the
same shape with a filled "Keep on air" on each, a header and footer that took about a third of the
desk, Details three levels deep with raw fact ids, and no keyboard path. This note says how the
redesign of 20 Oct 2026 works and which professional tools and guidelines each choice comes from.

## What the desk lists

Only the stories the match has reached: a story is listed once the replay time, the same `state.ts`
the broadcast plays, has passed its facts (the story's `ts`) and its first graphic is at most
`LOOKAHEAD_S` (60 s) away. Live, a story is written only after its facts, so the rule works
unchanged on a live clock: a goal is never listed before it is scored. A story inside the look-ahead carries a yellow "Next" tag and the
seconds to its slot. Playout rundowns mark the item on air in red and the next one in yellow
([Viz Mosart Rundown View](https://docs.vizrt.com/viz-mosart-users-guide/5.7/Rundown_View.html)); a
desk that showed the 23' goal at 11' would spoil the replay and could never happen live.

## Three sections

- **On air now**: every graphic on screen, generated graphics included, each with its time left and
  a Take out button. Viz Mosart lists the overlays on air in one place, each with "Take out" and its
  remaining time ([Program Window](https://docs.vizrt.com/viz-mosart-users-guide/5.5/Program_Window.html)).
- **Needs you**: the held stories, oldest first, each with the time to its slot. These are the only
  full cards.
- **Done**: one line per story, "23' Goal · approved by the risk rule · Reject Edit". NN/g finds
  cards less scannable than a list for items of the same kind
  ([cards](https://www.nngroup.com/articles/cards-component/)), and a dashboard should be one
  glanceable view ([dashboards](https://www.nngroup.com/articles/dashboards-preattentive/)).

Each section says in one line when it is empty; the sentence that said what the desk is for is now
the empty text of Needs you.

## Generated graphics

Every graphic that can go on air passes through the desk, not only the agents' stories. A cue with no
story (the Momentum and Team shape panels, the name plates, pass and shot, the player check-ins, the
recaps) is a generated graphic: built by code from the fact ledger, one per slot (graphic, time,
audience) across its languages, with the pseudo-id `G-<cue_id>`. It takes the story path in
`desk.js`: the same status, the same cards and rows, the same Undo and audit lines.

- The risk rule applies as it does to stories. The template graphics, drawn from the facts alone,
  are approved by the rule and sit in Done ("approved by the risk rule"). The graphics the code adds
  per audience (`studiodesk/agents/audiences.py`, `_generated`: the kids sheet, the player check-ins,
  the analyst's Team shape panels) wait in Needs you with Put on air and Skip.
- At most one generated graphic waits at a time: the soonest. A broadcast desk takes one decision
  at a time, and the analyst sheet alone has 17 Team shape panels a match.
- One nobody decided on before its slot ended has expired: it never airs, and Done says "expired,
  its moment passed", with no action left. Done says what happened to each: approved by you, by the
  risk rule, skipped by you, or expired.
- The AI switch holds the agents' stories only: a generated graphic is code from the facts, so the
  rule above still decides it when the AI is off.
- Decisions on generated graphics stay in the tab, and in the tab's audit lines, even with the API:
  the API keeps decisions for story ids (`S-` followed by six digits) only.

## Settings explained

Each group of the settings menu (the gear) has one plain line under it saying what changes, and the
audience choices that differ (Analyst, Casual fan, Kids) have one each. The lines describe what the
code does: the AI voice speaks only at 1x (`voice.js`, `booth-audio.js`), the analyst sheet adds the
Momentum and Team shape panels, the agent notes in the desk stay in English. The patterns:

- Short help in context, where the decision is made, not in a separate page
  ([NN/g, Help and documentation](https://www.nngroup.com/articles/help-and-documentation/)).
- Settings are changed rarely, so their options are explained inline rather than learned
  ([IntelliJ Platform UI guidelines, Context help](https://plugins.jetbrains.com/docs/intellij/context-help.html)).
- The text goes under the control, for a group at the bottom of the group, says what the setting
  does without repeating its name, and stays under five lines of 70 characters
  ([IntelliJ, Inline help text](https://plugins.jetbrains.com/docs/intellij/inline-help-text.html);
  [Oracle Alta, Inline text](https://www.oracle.com/webfolder/ux/middleware/alta/patterns/InlineText.html)).
- Help text says the outcome of the change
  ([GitLab Pajamas, Toggle](https://design.gitlab.com/components/toggle)), and is tied to its
  control with `aria-describedby`
  ([Persona design system, Toggle](https://design.withpersona.com/components/toggle)).
- The team and the player can be cleared: picking the selected one again, or the "Both teams" and
  "Everyone" choices, goes back to the general view and clears the `audience` URL parameter.

## What a card shows

The kicker, the headline and the body of the why card, in the page language, exactly as they will
air: the kicker comes from `web/graphics/why_card/kicker.mjs`, the same file the graphic reads.
Singular keeps a preview of the selected overlay apart from the live output
([Studio reference](https://developer.singular.live/singular-basics/controlling-overlays-in-studio-and-uno/studio-reference)).
The editor changes the headline as well as the body in all three languages; the API takes
`title_en`, `title_it` and `title_es` in `edited_text` (docs/CONTRACT.md, one line of at most 80
characters).

One filled button, and only where a decision waits: a held story has "Put on air" filled, Edit and
Reject; a story on air has Take out and Edit; an approved story not on screen has Reject (or Put on
air, once rejected) and Edit as quiet links in its row. There is no "Keep on air": the risk rule
already keeps it there, and a filled button on every card made none of them stand out.

## Keys

| key | action |
|---|---|
| A | put the story on air |
| E | edit it |
| R | reject it, or take it off air |
| J, K | next and previous story |
| U | undo the last decision |
| ? | the key list (the broadcast's own dialog, `#keys`) |

The keys follow the moderation tools: Coral Talk uses j and k for next and previous, single letters
to approve and reject, and ? for the key list
([moderator features](https://legacy.docs.coralproject.net/talk/moderator-features)); Viz Trio puts
TAKE, TAKE OUT and READ NEXT on single keys
([Viz Trio keyboard](https://docs.vizrt.com/viz-trio-guide/3.2/Viz_Trio_Keyboard.html)). After a
decision the focus moves to the next story waiting, as Moderation API opens the next item
([using queues](https://docs.moderationapi.com/review-queues/using-queues)). Accelerators are for
the expert and stay out of the novice's way
([flexibility and efficiency](https://www.nngroup.com/articles/flexibility-efficiency-heuristic/)):
each button shows its key next to its label (hidden on touch screens), and the keys act only with
the focus in the desk and never in a text field, so a single letter never fires by accident
(WCAG 2.1.4).

## Header and Details

The header is one line, "Control desk · AI graphics on · 2 waiting", with the tabs under it; the
note on where decisions are kept sits behind an info button, and opens by itself when the server
refused or did not answer. Key words first: people scan the start of each line
([F-shaped pattern](https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content/)).

Details is one level, at most two in all
([progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)): why the story is
held (the risk category and what to do, the score only in its tooltip), the verifier and safety
results, the earlier drafts as a plain list, the evidence table and pitch map, the analyst's note.
Google PAIR advises explaining at the moment of decision and showing a category with the action to
take rather than a bare confidence number
([explainability and trust](https://pair.withgoogle.com/chapter/explainability-trust/)); Microsoft
HAX G11 asks to make clear why the system did what it did
([HAX library](https://www.microsoft.com/en-us/haxtoolkit/library/)). Fact ids are debug codes:
the desk shows the fact's label instead, in Details and in Traces. The actions sit above Details, so
opening it never pushes them out of view.

## Undo and the audit

A decision says what it did on air in one line, with its Undo next to it, and the Undo stays until
the next decision; after a reject, the reason chips sit under the line. NN/g prefers undo to a
confirmation dialog for routine actions
([confirmation dialogs](https://www.nngroup.com/articles/confirmation-dialog/)); HAX G8 and G9 ask
for efficient dismissal and correction, G16 for the consequences of an action to be clear.

The audit starts with your own actions, newest first, in match minutes ("23' Goal, rejected: a
number"), the UTC time in a tooltip; then the agents' log; the cost tiles come last.

## Phone

Under 1100 px the desk is a bottom sheet of at most 60% of the height, so the broadcast stays in
view above it, with a compact On air now strip pinned at the top of the sheet. Colour is never the
only cue: every tally colour also says its state in words (WCAG 1.4.1).
