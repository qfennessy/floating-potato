"""Mission control: plain-text messages that arrive mid-flight and change what scores.

Every world gets four, at random times (seeded, so every balloon in a world sees the same ones):
  plumes    "Gas plumes are worth 3x until day N."           plumes reached in the window score 3x
  priority  "Pass over <site> before day N for +10 points."  a bonus target, live only in the window
  outage    "Nothing reached in the <south|north> counts..." captures in that hemisphere score 0
  tip       "<volcano> is likely to erupt around day N."     a 5-point major eruption really happens

Scoring applies to every balloon equally. Only agents that read the messages can act on them.

The priority site and the alert volcano are chosen per balloon when the message arrives, within
REACH_LAT degrees of that balloon's latitude, so every request is reachable in its window (the
balloon drifts a few degrees a day and passes every longitude about every 4-5 days).
"""
import numpy as np

from events import KINDS, VOLCANOES, Event
from venus import TARGETS

BONUS = 10.0
PLUME_MULT = 3.0
REACH_LAT = 6.0


def make_messages(seed, days):
    """Returns (messages, extra_events). Times in hours."""
    rng = np.random.default_rng(30_000 + seed)
    H = 24.0
    span = min(days, 30.0)
    t1 = rng.uniform(0.07, 0.33) * span * H
    t2 = rng.uniform(0.2, 0.55) * span * H
    t3 = rng.uniform(0.35, 0.65) * span * H
    t4 = rng.uniform(0.45, 0.8) * span * H
    hemi = rng.choice(["south", "north"])
    msgs = [
        {"id": "M1", "t_h": t1, "type": "plumes", "until_h": t1 + 8 * H,
         "text": f"Science team: gas plumes are worth {PLUME_MULT:g}x until day {(t1 + 8 * H) / H:.0f}."},
        {"id": "M2", "t_h": t2, "type": "priority", "until_h": t2 + 7 * H},      # site chosen per balloon
        {"id": "M3", "t_h": t3, "type": "outage", "hemi": str(hemi), "until_h": t3 + 6 * H,
         "text": f"Relay outage: nothing reached in the {hemi}ern hemisphere counts until day {(t3 + 6 * H) / H:.0f}."},
        {"id": "M4", "t_h": t4, "type": "tip", "erupt_h": t4 + rng.uniform(2.0, 3.5) * H},  # volcano per balloon
    ]
    return msgs, []


def personalize(m, lat, reached, seed):
    """Fill in a priority or tip message for a balloon now at `lat`: something reachable.
    Returns (message, extra_event or None)."""
    m = dict(m)
    rng = np.random.default_rng(40_000 + seed * 10 + int(m["id"][1:]))
    if m["type"] == "priority":
        pool = [k for k, (la, _) in TARGETS.items() if k not in reached and abs(la - lat) <= REACH_LAT]
        site = rng.choice(sorted(pool)) if pool else min(TARGETS, key=lambda k: abs(TARGETS[k][0] - lat))
        m.update(site=str(site), lat=TARGETS[site][0], lon=TARGETS[site][1],
                 text=f"Priority request: pass over {site} before day {m['until_h'] / 24:.0f} for a {BONUS:g}-point bonus.")
        return m, None
    if m["type"] == "tip":
        pool = [k for k, (la, _) in VOLCANOES.items() if abs(la - lat) <= REACH_LAT]
        v = rng.choice(sorted(pool)) if pool else min(VOLCANOES, key=lambda k: abs(VOLCANOES[k][0] - lat))
        m.update(site=str(v), text=f"Seismic alert: {v} is likely to erupt around day {m['erupt_h'] / 24:.0f}. "
                                   f"A major eruption is worth 5 points.")
        la, lo = VOLCANOES[v]
        return m, Event("TIP", "major", round(float(m["erupt_h"]), 2), float(la), float(lo), float(la), float(lo), str(v))
    return m, None


def bonus_targets(msgs, hours):
    """Bonus targets live right now: name -> (lat, lon)."""
    return {f"BONUS:{m['site']}": (m["lat"], m["lon"]) for m in msgs
            if m["type"] == "priority" and m["t_h"] <= hours < m["until_h"]}


def points_for(target, t_h, lat, events_by_id, msgs):
    """What one capture is worth, given the messages in force when it happened."""
    if target.startswith("BONUS:"):
        base = BONUS
    elif target in events_by_id:
        ev = events_by_id[target]
        base = KINDS[ev.kind]["value"]
        if ev.kind == "so2" and any(m["type"] == "plumes" and m["t_h"] <= t_h < m["until_h"] for m in msgs):
            base *= PLUME_MULT
    else:
        base = 1.0
    for m in msgs:
        if m["type"] == "outage" and m["t_h"] <= t_h < m["until_h"] and (lat < 0) == (m["hemi"] == "south"):
            return 0.0
    return base
