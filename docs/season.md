# The season before the replays

The four replays are one matchweek of a league season. Before kick-off the page shows where the two
clubs stand, and at a goal it says what the goal means for the scorer's season. The data contract is in
`docs/CONTRACT.md`, "Season additions".

## What broadcasters and data providers show

- wTVision, a broadcast graphics supplier, lists the pre-match football graphics a channel airs: team
  form, the head-to-head of previous meetings, the standings and the top scorers
  ([Football graphics explained](https://www.wtvision.com/football-graphics-explained)).
- Stats Perform sells Opta graphics to broadcasters with pre-match head-to-head, team and player form,
  the season table, line-ups and season leaders as the standard set
  ([Opta Graphics](https://www.statsperform.com/opta-graphics/)).
- The Opta match facts that Sky Sports publishes before each round are milestones and streaks: a player
  who has scored in several matches in a row, a club unbeaten in its last N, a tally about to reach a
  round number ([Premier League Opta stats](https://www.skysports.com/football/news/11095/10272897/premier-league-opta-stats-saturdays-best-match-facts)).
- Match centres such as FotMob put the last meetings, each side's last five as W, D, L chips and the
  table side by side on a head-to-head page
  ([FotMob head-to-head](https://www.fotmob.com/livescores/3055890/headtohead/brighton-&-hove-albion-vs-wolverhampton-wanderers)).

What we took from them: one card at kick-off with the matchweek, each club's place, points, goal
difference and last five as chips, the last meeting and each club's top scorer; and, during the match,
the scorer's league tally and scoring run on the goal's own card, as a commentator says it.

## How it is made

- The simulator plays matchweeks 1 to 9 of a double round robin with the same event engine as the
  replays, on its own random stream, so the replays do not change. Each replay's pairing met in
  matchweek 3 with home and away swapped, so the replays are the return fixtures of matchweek 10.
- The facts engine counts the season facts from those rows; each names the rows it comes from.
- The page draws the card and the goal lines by code from `season.json`. The recorded stories, cues and
  agent output are untouched.

## Strings for native review

The card's words are in `web/graphics/season_card/graphic.mjs`, the goal lines in `web/js/season.js`,
the proof panel's names of the season facts in `web/js/proof.js`.

| English | Italian | Spanish |
|---|---|---|
| SEASON SO FAR | LA STAGIONE FIN QUI | LA TEMPORADA HASTA AHORA |
| Matchweek 10 | 10ª giornata | Jornada 10 |
| Pos, Pts, GD, Last 5 | Pos, Pt, DR, Ultime 5 | Pos, Pts, DG, Últimos 5 |
| W, D, L | V, N, P | G, E, P |
| 3rd | 3° | 3.º |
| Last meeting | Ultimo confronto | Último enfrentamiento |
| Top scorer | Miglior marcatore | Máximo goleador |
| 5 goals, 1 goal | 5 gol, 1 gol | 5 goles, 1 gol |
| 6th league goal of the season | 6° gol in campionato in questa stagione | 6.º gol en Liga esta temporada |
| First league goal of the season | Primo gol in campionato in questa stagione | Primer gol en Liga esta temporada |
| Scored in 3 league matches in a row | A segno in 3 partite di campionato di fila | Ha marcado en 3 partidos de liga seguidos |
| Season so far (proof button) | La stagione fin qui | La temporada hasta ahora |
| Every number on this card is one of the season facts below, copied by code. | Ogni numero di questa grafica è uno dei fatti della stagione qui sotto, copiato dal codice. | Cada cifra de este gráfico es uno de los datos de la temporada de abajo, copiado por el código. |
| Matchweek, Place in the table, League points, Goal difference, Points from the last five, Goals in the last meeting, League goals this season, League matches in a row with a goal | Giornata, Posizione in classifica, Punti in campionato, Differenza reti, Punti nelle ultime cinque, Gol nell'ultimo confronto, Gol in campionato in questa stagione, Partite di campionato consecutive a segno | Jornada, Puesto en la clasificación, Puntos de liga, Diferencia de goles, Puntos en los últimos cinco, Goles en el último enfrentamiento, Goles de liga esta temporada, Partidos de liga seguidos con gol |

## Not done

- Ask the studio can call `get_season`, but `rules.check_answer` does not accept season fact ids, so an
  answer that cites one is declined.
- The proof panel lists the season card's facts; it does not tie each number on the card to its fact,
  as it does for a story's text.
- The recorded agent stories do not mention the season: they were written before it existed.
