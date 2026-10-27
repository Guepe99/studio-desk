# Ball handling in the 3D view

`web/js/ball3d.js` plans the ball and the leg actions for the stretch of match the 3D sample
shows; `web/js/ball3d-rig.js` puts that plan on the Quaternius mannequins. It is a visual layer:
the tracking data, the 2D page, the export and the facts do not change.

## What it does

- **The ball keeps the tracking path but not its clock.** Between two anchors (event times,
  arrivals, dribble touches) the ball's clock is bent with a linear deceleration profile, so it
  leaves the foot fast and slows down. At every anchor it is exactly the tracking ball. Each bend
  is measured against the tracking ball and softened until the gap stays under 1.2 m (the brief
  allows 1.5 m). On DEMO the worst gap is 1.00 m, on M001 1.12 m, and 0 at every event.
- **Kicks** (passes, crosses, shots, set pieces, clearances): backswing, cocking, a fast swing
  through the ball and a follow-through, timed so the foot is on the ball at the event time.
  The kicker is turned to face where the ball goes. The run-up, the trunk, the pelvis and the arms
  of the kicks are in `docs/motion3d.md` ("Kicks with the whole body").
- **First touch**: when a kicked ball reaches a team-mate, he turns to face it and cushions it
  with the inside of the foot at the moment the tracking ball arrives.
- **Dribbling**: a player who keeps the ball between events gets a touch every 0.6 to 1.0 s
  (faster runs, longer touches), alternating with the strong foot; between touches the ball runs
  ahead of him and slows down.
- **Moves with a still ball** (`SKILLS`, `_skills`): a receiver who keeps a still ball (under
  1 m/s) gets a sole roll, a drag-back, a step-over, a shoulder feint or a shimmy from 0.32 s after
  his first touch to 0.45 s before his next kick. On M001, of the 533 receptions kept 1 s or more,
  474 show a move (308 before the shimmy and these margins, which were 0.45 and 0.55 s); every
  one kept 1.17 s or more gets one, except two before a set piece. Under 1 s there is no room
  and none gets one. Details and the full counts in `docs/flow3d.md`.
- **Spin**: the ball rolls without slipping on the ground (axis across the run, rate v/R), and in
  the air keeps the spin of the kick (backspin when lofted).
- **Foot on the ball**: the player is shifted (motion warping) by up to 3 m around each contact so
  that the contact point of the posed foot sits on the ball. Farther than 3 m, no touch is drawn.

## Criteria and sources

| Choice | Value | Source |
|---|---|---|
| Kick phases | backswing about 160 ms, cocking 40 ms, acceleration 60 ms | Aspetar Sports Medicine Journal, kicking biomechanics: https://journal.aspetar.com/en/journals/volume-3-targeted-topic-groin-pain/risk-factors-for-groin-injury-during-football-kicking |
| Foot-ball contact | 9 to 12 ms, foot travels with the ball for about 2/3 of its diameter | ISBS proceedings: https://ojs.ub.uni-konstanz.de/cpa/article/view/5153/4730 ; Lees and Nolan review: https://pmc.ncbi.nlm.nih.gov/articles/PMC3786235 |
| Plant foot | level with the ball, 5 to 37 cm beside it | PMC3786235 above; https://lida.sport-iat.de/dfb/Record/4080379?lng=en |
| Ball speed / foot speed | 1.06 to 1.65; foot 18 to 19 m/s in a full instep kick | PMC3786235; https://www.shobix.co.jp/jssf/contents/supplement/files/P-088.pdf |
| Pass speed and deceleration in matches | 16.2 m/s mean, 7.93 m/s² fitted deceleration | https://arxiv.org/html/2210.16474 |
| Rolling resistance on turf | 0.45 to 1.5 m/s² | ISSS, ball roll on sports surfaces: https://www.isss-sportsurfacescience.org/downloads/documents/A7ZD60AH55_Gabrielsen_Ball_Roll.pdf.pdf |
| Sliding then rolling | a ball struck through its centre slides first, then rolls at 3/5 of its speed (thin shell) | https://phys.libretexts.org/Bookshelves/University_Physics/Mechanics_and_Relativity_(Idema)/05:_Rotational_Motion_Torque_and_Angular_Momentum/5.08:_Rolling_and_Slipping_Motion |
| Kicked ball spin | 3.6 to 5.8 rev/s for straight kicks, 7.8 rev/s for a curve kick | https://ojs.ub.uni-konstanz.de/cpa/article/view/1988/1856 ; https://kaken.nii.ac.jp/grant/KAKENHI-PROJECT-15500424 |
| Air drag | drag coefficient 0.15 to 0.5 | https://ojs.uni-miskolc.hu/index.php/multi/article/download/614/359/2775 |
| Dribble touch rhythm | a touch every step in tight space, longer touches in open space (coaching practice, no measured interval found) | https://www.sportsessionplanner.com/s/dbrDh/Dribbling-different-ways.html |
| Touches and possession from tracking | possession within 0.5 m, lost beyond 1 m | https://arxiv.org/html/2506.22503v1 ; https://pmc.ncbi.nlm.nih.gov/articles/PMC10624867/ |
| Receiving | body open to the ball, the touch absorbs the rebound | https://pmc.ncbi.nlm.nih.gov/articles/PMC7573254 ; https://www.tsukuba.ac.jp/en/research-news/20260806143000.html |
| Contact matched to an event time | motion warping of the root | Unreal Engine docs: https://dev.epicgames.com/documentation/unreal-engine/motion-warping-in-unreal-engine |
| How games do it | contact-aware clips, motion matching, ML-blended touches | https://gdcvault.com/play/1027595/Animation-Summit-FIFA-22-s ; https://gdcvault.com/play/1023280/Motion-Matching-and-The-Road ; https://80.lv/articles/ea-uses-machine-learning-for-animations-in-fifa-22 ; https://arxiv.org/html/2504.21216v2 ; https://history.siggraph.org/?p=100135 |

Note on the numbers we bent on purpose:

- A ground pass slows at 4 m/s² here, between turf rolling resistance (under 1.5) and the
  match fit (7.9, which includes the slide phase). The arrival time is fixed by the tracking,
  so a stronger deceleration is not available within the 1.2 m budget on most passes.
- Between dribble touches the ball ends at 0.3 of its start speed, far more than turf rolling
  would give: it makes the touch readable at broadcast distance.
- The drawn spin is capped at 6 rev/s (72 degrees a frame in the 30 fps capture). Above that the patches alias
  and the ball looks still or turning backwards. Motion blur would be the real fix.

## Animation licences

No animation file was added. Quaternius UAL1 Standard and UAL2 (CC0) have no kick, pass or trap
clip; the "Kick" in the paid UAL1 tiers is a combat kick. Mixamo is excluded by the brief, the
Bandai Namco motion dataset is CC BY-NC. CMU mocap subject 10 has kick takes (free to use and
redistribute, not to resell: http://mocap.cs.cmu.edu/faqs.php) but would need retargeting to
this skeleton. The motions are therefore procedural joint keys on the mannequin we already ship
(UAL1 Standard, CC0).

## Checks

`tests/web/sample3d-shots.mjs` checks that the 3D ball is the tracking ball at every event and
within 1.5 m in between, that there are leg actions, and that a rolling ball turns the way it
goes. `tests/web/ball3d-stills.mjs` writes close-ups of a dribble touch, a first touch and a kick
to `out/shots/ball3d-*.png`.
