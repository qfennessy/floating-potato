"""Fly a full mission with science events: sensors notice events, the commander decides
whether to chase each one, and the planner flies toward whatever the commander picked.

Saves a replay JSON per run (track, events, log, score) for the demo page.

    uv run --with numpy python sim/mission.py            # rule-based commander
    uv run --with numpy python sim/mission.py --gemini   # Gemini Robotics-ER commander
"""
import argparse
import json
from pathlib import Path

import numpy as np

import commander as cmd
from events import VOLCANOES, detectable, generate
from planner import eta_hours, search_planner
from venus import STEP_S, TARGETS, State, drifter, gc_km, step

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "runs"
WATCH_W = 2.0       # planner reward per step spent near a volcano
HOLD_BAND = 1.0     # degrees either side of the held latitude
CHASE_MAX_H = 6.0   # while holding a band, only consider chases this close
STRATEGY_H = 24.0   # how often the strategist re-picks where to hang out and which sites to pursue


def hold_latitude(lat_target, band=HOLD_BAND):
    """Keep latitude near lat_target (signed). High altitude drifts poleward and low drifts
    toward the equator, so which one moves you north depends on the hemisphere you're in.
    Mid-corridor (56 km) has no north-south drift."""
    def policy(st):
        if st.lat < lat_target - band:                     # need to go north
            goal = 61.5 if st.lat >= 0 else 50.5
        elif st.lat > lat_target + band:                   # need to go south
            goal = 50.5 if st.lat > 0 else 61.5
        else:
            goal = 56.0
        return int(np.sign(round(goal - st.alt, 3)))
    return policy


def fly(name, days=10.0, start=(15.0, 300.0), seed=1, commander=None, fixed_alt=None, strategist=None,
        hold_lat=None):
    """commander=None with fixed_alt flies a drifter; sensors still record events it passes.

    strategist(st, view) -> {"focus": [volcano names], "fixed": [fixed site names], "reason": str}
    runs every STRATEGY_H hours: focus sets where the planner loiters, fixed which sites it pursues.
    It may also return "hold_lat": the latitude to hold between chases.

    hold_lat: when set, the balloon holds that latitude band and the planner only flies chases."""
    events = generate(days, seed)
    st = State(start[0], start[1], fixed_alt or 56.0)
    planner = None if fixed_alt else search_planner()
    policy = drifter(fixed_alt) if fixed_alt else planner
    known, chasing, ignored = {}, None, set()
    plan = {"focus": list(VOLCANOES), "fixed": list(TARGETS), "next_h": 0.0, "hold": hold_lat, "lane": None}
    log, track = [], [(st.lat, st.lon, st.alt, st.hours)]

    def say(kind, text, **extra):
        log.append({"t_h": round(st.hours, 2), "kind": kind, "text": text, **extra})

    def planner_targets():
        if chasing:
            return {chasing.id: chasing.as_target()}
        live = {e.id: e.as_target() for e in known.values()
                if e.id not in ignored and e.ends_h > st.hours}
        fixed = {k: TARGETS[k] for k in plan["fixed"] if k in TARGETS}
        return {**fixed, **live}

    def restrategize():
        view = {"track": track, "known": [e for e in known.values()], "events_heard":
                [l for l in log if l["kind"] == "detect"], "reached": list(st.reached),
                "unvisited": [t for t in TARGETS if t not in st.reached], "days": days,
                "lane": plan["lane"]}
        out = strategist(st, view)
        plan["focus"] = [v for v in out.get("focus", []) if v in VOLCANOES] or plan["focus"]
        plan["fixed"] = [t for t in out.get("fixed", []) if t in TARGETS]
        if out.get("hold_lat") is not None:
            plan["hold"] = float(out["hold_lat"])
        plan["lane"] = out.get("lane", plan["lane"])
        say("strategy", out.get("reason", ""), focus=plan["focus"], fixed=plan["fixed"], hold_lat=plan["hold"])
        planner.set_watch([VOLCANOES[v] for v in plan["focus"]], WATCH_W)
        planner.set_targets(planner_targets())

    if planner:
        planner.set_watch(VOLCANOES.values(), WATCH_W)   # hang around where eruptions happen
        planner.set_targets(planner_targets())

    for _ in range(int(days * 24 * 3600 / STEP_S)):
        if strategist and planner and not chasing and st.hours >= plan["next_h"]:
            plan["next_h"] = st.hours + STRATEGY_H
            restrategize()
        for ev in events:
            if ev.id not in known and detectable(ev, st.lat, st.lon, st.hours):
                known[ev.id] = ev
                dist = gc_km(st.lat, st.lon, ev.rep_lat, ev.rep_lon)
                say("detect", f"{ev.spec['sensor']}: {ev.label()}, about {dist:.0f} km away",
                    event=ev.id)
                if commander and not chasing:
                    left = ev.ends_h - st.hours
                    eta = eta_hours(st, ev.as_target(), left)
                    if plan["hold"] is not None and (eta is None or eta > CHASE_MAX_H):
                        # Long chases pull the balloon out of its band and cost more than they win.
                        choice = "ignore"
                        reason = (f"Staying in the {plan['hold']:.0f}° band: {ev.label()} is "
                                  + ("out of reach before it fades." if eta is None else f"{eta:.0f} h away."))
                    else:
                        choice, reason = commander(ev, st, eta, left, [t for t in TARGETS if t not in st.reached])
                    say("decision", reason, event=ev.id, choice=choice,
                        eta_h=None if eta is None else round(eta, 1))
                    if choice == "chase":
                        chasing = ev
                    else:
                        ignored.add(ev.id)
                    planner.set_targets(planner_targets())

        if chasing and (chasing.id in st.reached or chasing.ends_h <= st.hours):
            if chasing.id not in st.reached:
                say("missed", f"{chasing.label()} faded before we got there", event=chasing.id)
            chasing = None
            planner.set_targets(planner_targets())

        # Captures are judged at the TRUE source; the planner only knows the reported spot.
        active = {**TARGETS, **{e.id: (e.lat, e.lon) for e in events if e.t_h <= st.hours < e.ends_h}}
        before = set(st.reached)
        if planner and plan["hold"] is not None and not chasing:
            action = hold_latitude(plan["hold"])(st)          # cruise in the chosen band
        else:
            action = policy(st)
        st = step(st, action, active)
        for got in set(st.reached) - before:
            what = got if got in TARGETS else next(e.label() for e in events if e.id == got)
            say("reached", f"reached {what}", target=got)
        track.append((st.lat, st.lon, st.alt, st.hours))

    value = {e.id: e.spec["value"] for e in events}
    points = sum(value.get(t, 1.0) for t in st.reached)
    run = {
        "name": name, "days": days, "start": start, "seed": seed, "fixed_alt": fixed_alt,
        "points": points, "reached": st.reached, "laps": round(st.laps, 2),
        "events": [{**e.__dict__, "sensor": e.spec["sensor"], "value": e.spec["value"],
                    "ends_h": e.ends_h, "text": e.label()} for e in events],
        "targets": {k: list(v) for k, v in TARGETS.items()},
        "log": log,
        "track": np.round(np.array(track), 3).tolist(),
    }
    RUNS.mkdir(exist_ok=True)
    (RUNS / f"{name}.json").write_text(json.dumps(run))
    return run


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gemini", action="store_true", help="use Gemini Robotics-ER as commander")
    ap.add_argument("--days", type=float, default=10.0)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()

    agent_cmd = cmd.gemini_commander() if a.gemini else cmd.rule_commander
    tag = "gemini" if a.gemini else "rules"
    agent = fly(f"agent_{tag}_s{a.seed}", a.days, seed=a.seed, commander=agent_cmd)
    vega = fly(f"drifter54_s{a.seed}", a.days, seed=a.seed, fixed_alt=54.0)
    best = max((fly(f"drifter{alt:g}_s{a.seed}", a.days, seed=a.seed, fixed_alt=alt)
                for alt in np.arange(50.5, 62.0, 1.5)), key=lambda r: r["points"])

    for entry in agent["log"]:
        print(f"  {entry['t_h']:6.1f} h  {entry['kind']:8s} {entry['text']}")
    print(f"agent ({tag}): {agent['points']:.0f} points {agent['reached']}")
    print(f"drifter 54 km (Vega): {vega['points']:.0f} points {vega['reached']}")
    print(f"best drifter {best['fixed_alt']:g} km: {best['points']:.0f} points {best['reached']}")


if __name__ == "__main__":
    main()
