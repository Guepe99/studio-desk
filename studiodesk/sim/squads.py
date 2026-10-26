"""Invented clubs, venues, crests and squads. Every name passes studiodesk.names.is_forbidden."""
import numpy as np

from ..names import is_forbidden

PLACES = ["Harbour Vale", "Kestrel Bay", "Ashmoor", "Redwick", "Larkhaven", "Corvane", "Wrenmouth",
          "Calderholt", "Brightwater", "Marrowgate", "Ostwick", "Pellmore", "Fenhallow", "Grisedale",
          "Tarnby", "Quillford"]
SUFFIX = ["Athletic", "Rovers", "Wanderers", "Town", "FC", "Harriers", "Borough", "Sporting Club"]
VENUE_A = ["Lantern", "Ironworks", "Millrace", "Copper Beech", "Saltmarsh", "Foundry", "Weaver's",
           "Lighthouse", "Old Quarry", "Kingfisher"]
VENUE_B = ["Park", "Road", "Ground", "Lane", "Arena", "Meadow"]
COLOURS = ["#c8102e", "#0b3d91", "#f2c500", "#1b7f3b", "#5b2a86", "#f07d00", "#00a3e0", "#111111",
           "#ffffff", "#8a1538", "#7fbf3f", "#e5007e"]
FIRST = ["Mateo", "Luca", "Kofi", "Tomasz", "Hiroshi", "Ade", "Santiago", "Emil", "Yusuf", "Rafael",
         "Jonas", "Kwame", "Diego", "Mikael", "Arjun", "Thiago", "Oskar", "Ibrahima", "Nils", "Joaquin",
         "Dario", "Sefu", "Kenji", "Bastien", "Anders", "Chidi", "Marek", "Felipe", "Ilya", "Tariq",
         "Joao", "Pieter", "Moussa", "Ricardo", "Aleks", "Daniel", "Femi", "Hugo", "Sami", "Wei",
         "Bruno", "Leandro", "Malik", "Stefan", "Teodor", "Nuno", "Aziz", "Callum", "Rui", "Jin"]
LAST = ["Okonkwo", "Varga", "Lindqvist", "Moreau", "Takeda", "Mensah", "Castrovane", "Novak",
        "Brennan", "Haddad", "Vellacott", "Kowalczyk", "Okowande", "Sorensen", "Bianchi", "Dunsavel",
        "Ishikawa", "Rojas", "Selvakov", "Achterberg", "Nwosu", "Quintero", "Halvorsen", "Dunmarrow",
        "Szabo", "Oyelaran", "Orvanelli", "Ombrecht", "Kimura", "Duarte", "Lundgren", "Marravi", "Pavic",
        "Mbeki", "Quennell", "Strand", "Galvan", "Keane-Doyle", "Oduya", "Rinaldi", "Sakamoto",
        "Vasquez", "Holmberg", "Tessaro", "Lisowski", "Abara", "Fontaine", "Morales", "Ekwueme", "Yilmaz"]
SQUAD = ["GK"] * 2 + ["DF"] * 6 + ["MF"] * 6 + ["FW"] * 4  # 18 per club
SHIRTS = {"GK": [1, 13], "DF": [2, 3, 4, 5, 15, 22], "MF": [6, 8, 10, 14, 16, 18], "FW": [7, 9, 11, 19]}


def _pick(rng, used, make, forbid=True):
    while True:  # regenerate until the name is unused and not a real one
        name = make()
        if name not in used and not (forbid and is_forbidden(name)):
            used.add(name)
            return name


def _own_surname(name, taken, names):
    """name with its surname moved along LAST until no one in `taken` has it. No random draw, so the
    league's random stream (and the whole dataset) stays the same as before this rule."""
    first, last = name.rsplit(" ", 1)
    k = LAST.index(last)
    for step in range(len(LAST)):
        cand = LAST[(k + step) % len(LAST)]
        full = f"{first} {cand}"
        if cand not in taken and full not in names and not is_forbidden(full):
            taken.add(cand)
            names.add(full)
            return full
    raise ValueError("surname pool too small for one fixture")


def crest(rng, c1, c2, cid) -> str:
    """A geometric shield: no text, no real emblem."""
    mark = rng.integers(4)
    inner = [f'<path d="M0 0H40V22L0 0Z" fill="{c2}"/>',
             f'<rect x="16" y="0" width="8" height="48" fill="{c2}"/>',
             f'<circle cx="20" cy="22" r="9" fill="{c2}"/>',
             f'<path d="M4 30L20 14L36 30L36 38L20 22L4 38Z" fill="{c2}"/>'][mark]
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 48">'
            f'<clipPath id="{cid}"><path d="M2 2H38V24C38 36 28 44 20 46C12 44 2 36 2 24Z"/></clipPath>'
            f'<g clip-path="url(#{cid})"><rect width="40" height="48" fill="{c1}"/>{inner}</g>'
            f'<path d="M2 2H38V24C38 36 28 44 20 46C12 44 2 36 2 24Z" fill="none" stroke="{c2}" '
            'stroke-width="2"/></svg>')


def make_league(rng, cal, n_teams=8):
    """Teams, players and venues. Odd-numbered clubs (T01, T03, ..) get one fast forward."""
    used, teams, players, venues = set(), [], [], {}
    # surnames per fixture: build.simulate pairs clubs 2k and 2k+1, so no two players of a match share one
    taken, names = {}, set()
    places = list(rng.permutation(PLACES))
    sp = cal["top_speed_kmh_by_position"]["value"]
    fast = cal["fast_forward_kmh"]["value"]
    for i in range(n_teams):
        tid = f"T{i + 1:02d}"
        place = places[i]
        name = _pick(rng, used, lambda: f"{place} {SUFFIX[rng.integers(len(SUFFIX))]}")
        c1, c2 = rng.choice(len(COLOURS), 2, replace=False)
        c1, c2 = COLOURS[c1], COLOURS[c2]
        short = (place.replace(" ", "")[:3]).upper()
        if is_forbidden(short):  # no redraw: PLACES is fixed, so the list itself must change
            raise ValueError(f"short name {short} is a real name")
        teams.append(dict(team_id=tid, name=name, short_name=short, color_primary=c1,
                          color_secondary=c2, crest_svg=crest(rng, c1, c2, f"crest-{tid}")))
        venues[tid] = _pick(rng, used, lambda: f"{VENUE_A[rng.integers(len(VENUE_A))]} "
                                               f"{VENUE_B[rng.integers(len(VENUE_B))]}")
        seen = {k: 0 for k in SHIRTS}
        for k, pos in enumerate(SQUAD):
            shirt = SHIRTS[pos][seen[pos]]
            seen[pos] += 1
            top = rng.uniform(*sp[pos])
            if pos == "FW" and seen[pos] == 1 and i % 2 == 0:
                top = rng.uniform(*fast)
            pname = _pick(rng, used, lambda: f"{FIRST[rng.integers(len(FIRST))]} "
                                             f"{LAST[rng.integers(len(LAST))]}", forbid=False)
            # a real full name is moved by _own_surname without a draw, so listing one keeps the stream
            pname = _own_surname(pname, taken.setdefault(i // 2, set()), names)
            players.append(dict(player_id=f"{tid}-{shirt}", team_id=tid, name=pname, shirt=shirt,
                                position=pos, top_speed_kmh=round(float(top), 2)))
    return teams, players, venues
