# Highlights

The settings menu (the gear, under More) has **Highlights: first half**, **Highlights: second half** and
**Highlights: full match**. The page then plays a reel: the key moments of that part of the match back
to back, at 1x, on the page's own clock. Nothing else changes: the reel only seeks and plays, so it works
in the 2D and 3D views, for every audience and in every language, and the graphics on air are the ones
the visitor would see at that moment. Code in `web/js/highlights.js` picks and orders the moments. There
are no model calls.

While the reel plays, a strip at the top right of the picture says the minute and what the moment is,
and the score once a goal is in. A **Stop highlights N/M** button appears beside **Next key moment**
and says which clip is playing. Stop returns to where the visitor was, at the
same speed, playing or paused. The reel also ends there by itself after the last clip. A seek of the
visitor's own (the seek bar, a goal button, Next key moment, a key) ends the reel and stays where it
went.

At half-time and at full time, while the recap card is on air, a **Watch the first half highlights** or
**Watch the match highlights** button appears in the same row, beside the recap's proof button. It
never plays by itself and does not hold the picture: the match goes on and the button goes when the
half-time recap ends. At full time it stays, since the clock stops there. The recap times come from the
`why_card` cues of kind `recap`; without them the button shows for 12 s from half-time.

## How broadcasters build a highlights package

- A short highlights report is capped at 90 seconds per match in several regimes: the Spanish
  competition regulator (CNMC) limits free-to-air summaries of league games to two broadcasts of
  90 seconds per game, confirmed per game by the Supreme Court
  ([SportBusiness](https://media.sportbusiness.com/news/mediaset-prevails-with-court-ruling-in-laliga-highlights-row)).
  Austria and Germany have the same 90 second short-reporting figure
  ([IRIS Merlin, European Audiovisual Observatory](https://merlin.obs.coe.int/article/3775)).
- What goes into such a short report, in the Austrian ruling: goals, missed penalties, shots that hit
  the woodwork, serious fouls leading to a red card and crowd trouble; missed chances only in matches
  that decide the title or relegation
  ([IRIS Merlin](https://merlin.obs.coe.int/article/3775), read from the search summary: the page
  refused a direct download).
- In a full highlights programme each match has its own producer who logs the moments and cuts the
  match. The programme editor then decides the running order, how long each edit is and how much time
  goes to analysis. Match action is at least 80 per cent of the show
  ([Football Writers' Association, behind the scenes at Match of the Day](https://footballwriters.co.uk/features/behind-the-scenes-at-match-of-the-day/)).
- A replay in a football broadcast lasts 6.8 seconds on average; an action is shown again 1 to 3
  times; logo transitions are 14.2 per cent of camera changes, "widely used in sports broadcasts" to
  bring a replay in (SoccerNet-v2, [Deliège et al., CVPR Workshops 2021](https://ar5iv.labs.arxiv.org/html/2011.13367)).
- Automatic highlight systems cut a fixed window around each event: 125 frames before and 125 after,
  10 seconds a clip ([Vaidya et al., Journal of Himalaya College of Engineering, 2026](https://www.nepjol.info/index.php/jhcoe/article/view/101048));
  manual clipping also uses a preset interval around a goal
  ([OsloMet thesis](https://oda.oslomet.no/oda-xmlui/handle/11250/3101178?show=full)).

## The rules

1. **Moments.** Every goal (the `score` facts of the ledger, not AI). Then the big chances the agents
   found (`big_chance` stories). Sprints, pressing spells, momentum swings, changes of shape and recaps
   are analysis, not footage of a moment, so they stay out, as in the short-report rules above. A
   comeback is the goal it happens on.
2. **The producer's word.** A story the visitor rejected on the desk is out. A story Content Safety
   flagged goes in only once approved or edited. A big chance still waiting for review goes in: the
   reel shows the pitch, not the story's line, and its card stays held as before. With the AI graphics
   switched off the reel is goals only, as Next key moment then goes from goal to goal.
3. **Ranking of the chances**, from the outcome in the shot's `shot_distance` fact: saved (the keeper
   had to stop it) first, then near misses (over, wide), then blocked; at the same outcome the closer
   shot first. This follows the short-report list, where only shots that came closest to a goal earn a
   place.
4. **Length.** A clip starts 6 s before the shot (`LEAD_S`, the build-up, as Next key moment). A chance
   ends 4 s after the shot: 10 s, the automatic systems' window. A goal ends 12 s after the shot. That
   keeps the celebration and the 3D view's own goal replay, which runs from 6 s to 11.5 s after the
   goal when the restart leaves time for it, close to the 6.8 s average replay. A clip never crosses
   half-time or full time.
5. **Budget.** Each half's reel stays within 90 s, the short-report cap: all its goals first, then
   chances in ranking order while they fit. The full match is the two halves' reels one after the
   other, so up to 180 s.
6. **Order.** Back to back in match order, so the score in the strip always follows the one before.
   Clips that touch are played as one, so nothing plays twice. Match order is a choice made here for a
   single-match reel; no source above states it as a rule.
7. **Replay in.** Each new moment's strip comes in with a short wipe, as a replay comes in behind a
   logo transition; no wipe with reduced motion.

## Words on screen

The strip is built from existing strings and data, in the page's language: the goal button's
`goalAt` ("Goal, Okowande (RED), 10'"), the desk's story kind names ("Big chance", "Grande occasione",
"Ocasión clara"), player names and team codes from `meta.json`, the minute from the match clock and
the score from the `score` facts. The new strings are the menu items, the Stop button, the strip's tag,
the half-time and full-time offer and the message when a part has no moments (`HL_STRINGS` in `highlights.js`); the Italian and Spanish
ones wait for a native speaker's review.

## Reel lengths on the four replays

| match | first half | second half | full match |
|---|---|---|---|
| M001 | 76 s, 6 moments | 56 s, 4 | 132 s, 10 |
| M002 | 76 s, 6 | 86 s, 7 | 162 s, 13 |
| M003 | 48 s, 4 | 58 s, 5 | 106 s, 9 |
| M004 | 48 s, 4 | 88 s, 8 (11 chances, 7 fit) | 136 s, 12 |

For a visitor who has not touched the desk. `node --test tests/web/highlights.test.mjs` prints them.

## Tests

- `node --test tests/web/highlights.test.mjs`: windows, merging, ranking under the budget, the
  producer's decisions, AI off, the strip's words in three languages, and on M001 to M004 every goal
  in, each half within 90 s, clips in order and inside their half.
- `scripts/with-lock.sh chromium tests/web/run-smoke.sh highlights.mjs`: M001 in 2D starts the full
  match reel, cuts to the first goal, shows the score after it, and Stop returns to 0', paused, at 4x;
  in 3D and Italian the second half reel opens on the 50' goal. Screenshots in `out/shots/`.
