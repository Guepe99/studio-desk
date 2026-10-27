# Control desk

The control desk is where the producer approves, edits or rejects the graphics the agents propose
(`web/js/desk.js`, `web/css/desk.css`). The product owner found the first version "a jumble of information
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
- **Done**: one line per story, "23' Goal · aired at 23', approved automatically (low risk) · Reject
  Edit": once a story's first graphic has played, its row says when, so Done is also the history of
  what aired. Under it, "Missed: n" counts the stories and graphics nobody put on air before their
  slot ended (below); their rows open from it. NN/g finds
  cards less scannable than a list for items of the same kind
  ([cards](https://www.nngroup.com/articles/cards-component/)), and a dashboard should be one
  glanceable view ([dashboards](https://www.nngroup.com/articles/dashboards-preattentive/)).

Each section says in one line when it is empty; the sentence that said what the desk is for is now
the empty text of Needs you.

## Generated graphics

Every graphic that can go on air passes through the desk, not only the agents' stories. A cue with no
story (the Momentum and Team shape panels and the player check-ins) is a generated graphic: built by code from the fact ledger, one per slot (graphic, time,
audience) across its languages, with the pseudo-id `G-<cue_id>`. It takes the story path in
`desk.js`: the same status, the same cards and rows, the same Undo and audit lines.

- The risk rule applies as it does to stories. The Momentum panels, drawn from the facts alone, are
  approved by the rule and sit in Done ("approved by the risk rule"). The graphics the code adds per
  audience (`studiodesk/agents/audiences.py`, `_generated`: the player check-ins and the analyst's
  Team shape panels) wait in Needs you with Put on air and Skip. The kids sheet keeps its story ids
  and follows its stories. The fillers (`payload.filler`, see No empty minutes) never wait, on any
  sheet the kids' one included: they exist so that a visitor who never opens the desk always has a
  graphic on air. They are not listed in Needs you or Done (a sheet has
  79 to 104 of them, which would bury the decided stories): one shows in On air now while it is on
  screen, labelled "template graphic, no approval needed", as the proof panel says.
- At most one generated graphic waits at a time: the soonest. A broadcast desk takes one decision
  at a time, and the analyst sheet alone has 17 to 18 Team shape panels a match.
- One nobody decided on before its slot ended is missed: it never airs, it leaves Needs you for the
  "Missed" count under Done, and its row says "missed, nobody put it on air in time", with no action
  left. The agents' stories get a limit too, by kind (below, When a story is missed). Done says what
  happened to each: approved by you, approved automatically, skipped by you, or missed. Each status has
  a one-line tooltip that says what it means.
- The AI switch holds the agents' stories only: a generated graphic is code from the facts, so the
  rule above still decides it when the AI is off. A story stays off air with the AI off even when its
  words on air are the code's phrasebook, because an AI agent (the story finder) picked the moment;
  its tooltip says so.
- Decisions on generated graphics stay in the tab, and in the tab's audit lines, even with the API:
  the API keeps decisions for story ids (`S-` followed by six digits) only.

## When a story is missed

A held story whose slot has passed waits a little longer, then leaves Needs you by itself: it is
missed, it never airs afterwards, and the desk writes it to the audit. Before, every story waited 5
match minutes, so a big chance at 8' still asked for a decision at 13' with "was due on air at 8'". Nobody
airs a chance five minutes late: its graphic goes with its replay, at the next stoppage, and with the
ball out of play for about 45 minutes of a top-flight match
([The Analyst, ball in play 2025-26](https://theanalyst.com/articles/premier-league-ball-in-play-are-we-seeing-less-football-2025-26))
a stoppage is rarely far off. The windows are mine, by how long the story stays true:

| kind | waits after its slot |
|---|---|
| big chance, key pass, top sprint | 1 minute |
| momentum swing, pressing spell, high press, tactical shift (a phase of play), and any other kind | 2 minutes |
| goal, comeback, recap (still the story of the match minutes later, and at the break) | 5 minutes |

The slot is the end of the story's last graphic, or its moment when it has no graphic (`MISS_S` and
`missAt` in `web/js/desk.js`). A generated graphic is missed as soon as its slot ends, as before.
Once the slot has passed the card says how long is left: "was due on air at 8', missed in 42 s".
Approving it in that time records the decision, but the slot has passed, so it airs only if you go
back in the match.

The audit lists the miss among Your actions and in the table, "8' Big chance, missed: nobody put it
on air within 1 min of its slot, so it never aired", by the Desk rule, in English, Italian and Spanish.
It is not counted as one of your actions. Only a story you saw waiting is logged and counted under
"Missed": one whose moment passed before you got there (a link to the 20th minute) was never yours to
miss.

Seeking follows the clock, as the replay does. Seek back before the story's window ends and it waits
in Needs you again, and its audit line goes, since nothing aired; play on without deciding and it is
missed again. A decision you made stays whichever way you seek.

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
number"), the UTC time in a tooltip, and the stories the desk marked missed; then the agents' log;
the cost tiles come last.

## Wide screen

From 1100 px the desk is a column beside the broadcast, as tall as the window. The open Ask panel
sits over the foot of that column, so the desk ends above it: `desk.js` measures the panel and the
column keeps that much space free at the bottom. Without it, the last rows of Done and their Details
sat under the panel, where a click landed on the panel's input instead.

## Phone

Under 1100 px the desk is a bottom sheet of at most 60% of the height, so the broadcast stays in
view above it, with a compact On air now strip pinned at the top of the sheet. Colour is never the
only cue: every tally colour also says its state in words (WCAG 1.4.1).

## No empty minutes

The product owner watched M001 and at 8' the desk had nothing on air and nothing waiting. Measured on the
committed packs (English sheet, stretches of play with no cue of the audience on screen), before
this change:

| Match | Analyst | Casual and kids | First story |
|---|---|---|---|
| M001 | first graphic at 5'00, longest gap 5.0 min | first at 7'55; gaps of 18.0, 15.5 and 12.0 min | 7'50 |
| M002 | first at 5'00, longest 5.0 min | first at 16'32; gaps of 16.5, 15.4 and 9.7 min | 10'00 |
| M003 | first at 5'00, longest 5.0 min | first at 6'23; gaps of 15.4, 11.5 and 10.5 min | 6'18 |
| M004 | first at 5'00, longest 5.0 min | first at 6'19; gaps of 17.1, 12.7 and 9.3 min | 5'00 |

The stories come from the agents' run and stay as they are; the graphics fill the gaps.

How the trade fills them (for the kinds of graphic, not the target):

- A broadcast opens on the line-ups. Line-up graphics show the starters, and formation graphics
  place them on the pitch and may come back later in the match
  ([wTVision, Football Graphics Explained](https://www.wtvision.com/football-graphics-explained));
  line-ups and formations are revealed before kick-off
  ([wTVision, Portuguese League](https://www.wtvision.com/portuguese-league-with-a-new-graphic-concept)).
  The team sheet is public before kick-off (75 minutes before in the English top flight since 2024/25,
  [On Tour Football](https://ontourfootball.com/news/confirmed-lineups-when-team-news-actually-drops-and-how-to-get-it-in-time)),
  so showing it at 0' gives nothing away.
- In quiet spells, live stats chosen to explain the phase of play (wTVision, above) and
  momentum and live data in the match apps and data feeds
  ([a club app's Match Centre](https://www.manutd.com/en/news/detail/innovative-live-stats-now-available-in-new-official-manchester-united-app-match-centre),
  [a league broadcaster's Data Zone](https://www.broadcastnow.co.uk/tech-innovation/premier-league-productions-trials-augmented-broadcasts/5181397.article)).
- At the slow end, newspaper live blogs post about every 10 minutes on average
  ([Thurman and Walters 2013](https://openaccess.city.ac.uk/id/eprint/4045/1/Chapter%208%20-%20Live%20Blogging%20-%20with%20discussion%20questions.pdf)),
  and some match apps push only at kick-off, goals and full time
  ([TOK.tv](https://blog.lightstreamer.com/2014/07/meet-our-customers-toktv.html)).

The target is the product owner's: no clock minute without a graphic on air, on every sheet (analyst, casual,
kids, each team's and each player's), for a visitor who never touches the desk. A story listed under
Needs you does not count: a viewer who never opens the desk does not see it. Two graphics less than a
minute apart leave no minute empty, so the code aims at `MAX_GAP_S` = 55 s (in
`studiodesk/agents/audiences.py`) between the end of one graphic and the start of the next, from 0:00 to
half-time and from the second half's start to full time; the half's last, shorter minute counts too.

What fills them, all from the fact ledger and written by code, each marked `payload.filler: true`:

- `lineup` at 0', 15 s, on every sheet: each team's formation from its team sheet (the
  `start_formation` fact) and its eleven by line, keeper first.
- While a stretch with nothing on air is longer than 55 s, or would leave the half's last minute
  empty, one more graphic: a `pass_shot` of a completed pass with its length and difficulty
  (`pass_distance`, `pass_difficulty`, and `ball_speed` when there is one), a `nameplate` of a sprint
  with its speed (`sprint_speed`), the `momentum` graphic of a 5-minute window (not on the analyst
  sheet, which has its own every window), or at a check-in time (15', 30', 45' of each half) the
  check-in card of the player with the most touches (not on a player's sheet, which has that
  player's own card).
- A filler starts no earlier than its facts and at most 60 s after them, a name plate or a pass ends
  before its player is substituted (the plate rings him on the pitch), it overlaps nothing of that
  sheet (a story waiting for the producer included, in case it is approved) and ends before half-time
  or full time. It starts once every fact it cites is in: a pass's `ball_speed` is often stamped up to
  0.5 s after its length.
- A filler never airs over a goal and its 3D replay: from the goal to `GOAL_BUSY_S` = 11.5 s after it
  (`REPLAY.after` + `REPLAY.len` in `web/js/view3d.js`), on every sheet, nor where the page holds a
  Momentum or Team shape panel due in the replay to its end (`holdForReplays`), so the page never
  moves a filler.
- Each fact fills a sheet once, and never one the sheet already shows in its own stories and template
  graphics. A half's fillers use that half's facts only (`period`): the momentum window that ends at
  half-time stays in the first half.
- Which one: never the graphic shown just before when another fits, then not the one just after, then
  the graphic the sheet has gone longest without; on a team's or a player's sheet that team's or that
  player's facts first; then the latest start within the 55 s, then the fastest sprint or the hardest
  pass.
- The kids read their own words: "How hard: 8.1/10" on a pass, "Touched the ball 31 times" or
  "Fastest run: 31.4 km/h" on a check-in (Italian and Spanish too).

On the desk the fillers are generated graphics approved by the risk rule, but they are kept out of
Needs you and Done: one shows in On air now only while it is on screen, as a template graphic, and the
producer can take it out from there. The audit is unchanged. They never wait for a
decision (`GEN_WAITS` in `web/js/desk.js` leaves them out), or the kids sheet, whose generated graphics
all wait, would stay empty for a visitor who never opens the desk.

Measured on the committed packs as a visitor who never touches the desk sees them (auto-approved
stories that are not flagged, and the code graphics that do not wait): the longest stretch with
nothing on air, and the clock minutes with nothing on air.

| Match | Sheets | Before: longest gap | Before: empty minutes | After: longest gap | After: empty minutes |
|---|---|---|---|---|---|
| M001 | analyst | 300 s | 71 | 55 s | 0 |
| M001 | casual, kids, team:T01, team:T02 | 2002 s | 87 | 55 s | 0 |
| M001 | player:T01-9, player:T02-9 | 2002 s | 88 | 55 s | 0 |
| M001 | player:T01-7 | 2793 s | 91 | 55 s | 0 |
| M002 | analyst | 300 s | 70 | 55 s | 0 |
| M002 | casual, kids, the two teams, player:T03-7 | 1324 s | 87 | 55 s | 0 |
| M002 | player:T03-9, player:T04-9 | 1324 s | 88 | 55 s | 0 |
| M002 | player:T04-7, player:T04-11 | 2792 s | 90 and 91 | 55 s | 0 |
| M003 | analyst | 304 s | 72 | 55 s | 0 |
| M003 | casual, kids, the two teams | 2174 s | 90 | 55 s | 0 |
| M003 | player:T05-7, player:T06-9 | 2174 s | 91 | 55 s | 0 |
| M003 | player:T05-11, player:T06-7, player:T06-19 | 2734 s | 92 to 93 | 55 s | 0 |
| M004 | analyst | 301 s | 73 | 55 s | 0 |
| M004 | casual, kids, the two teams | 2175 s | 90 | 55 s | 0 |
| M004 | player:T08-7, player:T08-9 | 2175 s | 91 | 55 s | 0 |
| M004 | the other four players | 2752 to 2872 s | 92 to 94 | 55 s | 0 |

The same holds in Italian and Spanish. M001 minute by minute, English, before and after (`*` a story or
a template graphic, the rest fillers, with their start):

| Minute | Casual before | Casual after | Analyst before | Analyst after |
|---|---|---|---|---|
| 0 | nothing | lineup 0:00 | nothing | lineup 0:00 |
| 1 | nothing | pass 1:10 | nothing | pass 1:10 |
| 2 | nothing | name plate 2:11 | nothing | name plate 2:11 |
| 3 | nothing | pass 3:12 | nothing | pass 3:12 |
| 4 | nothing | name plate 4:13 | nothing | name plate 4:13 |
| 5 | nothing | momentum 5:14 | momentum* 5:00 | momentum* 5:00 |
| 6 | nothing | name plate 6:17 | nothing | pass 6:03 |
| 7 | nothing | pass 7:18 | nothing | name plate 7:04, pass 7:49 |
| 8 | nothing | name plate 8:19 | nothing | name plate 8:50 |
| 9 | pass* 9:56 | pass 9:20, pass* 9:56 | pass* 9:56 | pass 9:49, pass* 9:56 |
| 10 | pass* 9:56, why card* 10:02 | the same | pass* 9:56, why card* 10:02, momentum* 10:02 | the same |
| 11 | nothing | momentum 11:00 | nothing | name plate 11:09 |
| 12 | pass* 12:53, why card* 12:59 | name plate 12:03, then the same | pass* 12:53, why card* 12:59 | pass 12:10, then the same |

Two graphics of the same kind in a row on a sheet happen only when no other kind fits that minute
(checked on every pair of fillers of the four matches). `test_no_sheet_goes_a_minute_with_nothing_on_screen` and
`test_fillers_cover_every_minute_from_facts_take_turns_and_keep_clear_of_waiting_cards` in
`tests/test_audiences.py` keep it so; `test_apply_is_idempotent_on_a_committed_pack` reruns the step
and gets the same cues.
