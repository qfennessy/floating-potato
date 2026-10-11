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
from missionctl import bonus_targets, make_messages, make_samples, personalize, points_for
from planner import eta_hours, search_planner
import venus
from venus import KM_PER_DEG, STEP_S, TARGETS, State, drifter, gc_km, step, wind, world_start, world_weather

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "runs"
WATCH_W = 2.0       # planner reward per step spent near a volcano
HOLD_BAND = 1.0     # degrees either side of the held latitude
CHASE_MAX_H = 6.0   # while holding a band, only consider chases this close
STRATEGY_H = 24.0   # how often the strategist re-picks where to hang out and which sites to pursue


class LaneHolder:
    """Holds a latitude by learning, as it flies, which altitudes push it north or south.

    The balloon only knows the forecast before launch, and each world's real weather differs
    (the altitude where the north-south drift flips moves between 52 and 60 km). So for each
    altitude level it keeps a running average of the push it actually felt, starting from the
    forecast as a guess, and flies to whichever level pushes it toward its lane."""
    LEVELS = np.arange(50.5, 62.0, 1.5)
    PRIOR_WEIGHT = 2.0          # the forecast counts as this many observations

    def __init__(self, band=HOLD_BAND):
        self.band = band
        self.prior = np.array([wind(45.0, a, 6.0)[1] for a in self.LEVELS])   # push at sin(2 lat) = 1
        self.sum = np.zeros(len(self.LEVELS))
        self.n = np.zeros(len(self.LEVELS))

    def estimate(self):
        return (self.prior * self.PRIOR_WEIGHT + self.sum) / (self.PRIOR_WEIGHT + self.n)

    def observe(self, before, after):
        """Learn from one step: how fast did we really move north, at this altitude?"""
        s2 = np.sin(2 * np.radians(before.lat))
        k = int(np.argmin(np.abs(self.LEVELS - after.alt)))
        if abs(s2) < 0.2 or abs(self.LEVELS[k] - after.alt) > 0.3 or abs(after.alt - before.alt) > 0:
            return                                          # near the equator, or still climbing
        v = (after.lat - before.lat) * KM_PER_DEG * 1000 / STEP_S
        self.sum[k] += v / s2
        self.n[k] += 1

    def act(self, st, lat_target):
        """Move as little as possible: inside the band, stay put; outside it, go to the nearest
        altitude level that pushes the right way (stronger push only if ballast and gas allow)."""
        need = lat_target - st.lat
        if abs(need) <= self.band:
            return 0
        est = self.estimate() * np.sign(np.sin(2 * np.radians(st.lat)) or 1.0)   # push north per level
        push = est * np.sign(need)                                                # push toward target
        usable = [k for k in range(len(self.LEVELS))
                  if push[k] > 0.8 and (self.LEVELS[k] <= st.alt + 0.25 or st.ballast >= self.LEVELS[k] - st.alt)
                  and (self.LEVELS[k] >= st.alt - 0.25 or st.gas >= st.alt - self.LEVELS[k])]
        if not usable:
            usable = [int(np.argmax(push))]
        k = min(usable, key=lambda k: abs(self.LEVELS[k] - st.alt))              # the closest that works
        return int(np.sign(round(self.LEVELS[k] - st.alt, 3)))


def fly(name, days=10.0, start=None, seed=1, commander=None, fixed_alt=None, strategist=None,
        hold_lat=None, varied=True):
    """commander=None with fixed_alt flies a drifter; sensors still record events it passes.

    strategist(st, view) -> {"focus": [volcano names], "fixed": [fixed site names], "reason": str}
    runs every STRATEGY_H hours: focus sets where the planner loiters, fixed which sites it pursues.
    It may also return "hold_lat": the latitude to hold between chases.

    hold_lat: when set, the balloon holds that latitude band and the planner only flies chases.
    varied: each world gets its own launch point and real weather (from its seed); False flies the
    original fixed world (launch 15 N 300 E, weather = forecast)."""
    venus.WX = world_weather(seed) if varied else dict(venus.FORECAST)
    import zlib
    venus.RISK_RNG = np.random.default_rng(zlib.crc32(f"{seed}:{name}".encode()))   # this balloon's luck
    if start is None:
        start = world_start(seed) if varied else (15.0, 300.0)
    events = generate(days, seed)
    msgs, extra = make_messages(seed, days) if varied else ([], [])
    events = sorted(events + extra, key=lambda e: e.t_h)
    by_id = {e.id: e for e in events}
    samples = make_samples(seed) if varied else {}
    delivered = []
    st = State(start[0], start[1], fixed_alt or 56.0)
    planner = None if fixed_alt else search_planner(end_h=days * 24)
    policy = drifter(fixed_alt) if fixed_alt else planner
    known, chasing, ignored = {}, None, set()
    holder = LaneHolder()
    flags = {}
    lost_h = None
    plan = {"focus": list(VOLCANOES), "fixed": list(TARGETS), "next_h": 0.0, "hold": hold_lat, "lane": None,
            "goto": None}
    PLACES = {**VOLCANOES, **TARGETS}
    log, track = [], [(st.lat, st.lon, st.alt, st.hours)]
    budget = [(st.ballast, st.gas, st.health)]

    def say(kind, text, **extra):
        log.append({"t_h": round(st.hours, 2), "kind": kind, "text": text, **extra})

    def planner_targets():
        if chasing:
            return {chasing.id: chasing.as_target()}
        live = {e.id: e.as_target() for e in known.values()
                if e.id not in ignored and e.ends_h > st.hours}
        if plan["goto"]:                                     # strategist named a place to head for
            lat, lon = PLACES[plan["goto"]]
            return {f"GOTO:{plan['goto']}": (lat, lon, 10.0), **live}
        fixed = {k: TARGETS[k] for k in plan["fixed"] if k in TARGETS}
        layer = {k: v for k, v in samples.items() if k not in st.reached} if planner and plan.get("sprint") else {}
        return {**fixed, **live, **layer}

    def restrategize():
        view = {"track": track, "known": [e for e in known.values()], "events_heard":
                [l for l in log if l["kind"] == "detect"], "reached": list(st.reached),
                "unvisited": [t for t in TARGETS if t not in st.reached], "days": days,
                "lane": plan["lane"], "messages": list(delivered), "goto": plan["goto"],
                "ballast": st.ballast, "gas": st.gas, "health": st.health, "samples": samples}
        out = strategist(st, view)
        plan["focus"] = [v for v in out.get("focus", []) if v in VOLCANOES] or plan["focus"]
        plan["fixed"] = [t for t in out.get("fixed", []) if t in TARGETS]
        if "hold_lat" in out:                                 # None means roam
            plan["hold"] = None if out["hold_lat"] is None else float(out["hold_lat"])
        plan["lane"] = out.get("lane", plan["lane"])
        plan["sprint"] = bool(out.get("sprint"))
        planner.set_sprint(plan["sprint"])
        plan["goto"] = out.get("goto") if out.get("goto") in PLACES else None
        say("strategy", out.get("reason", ""), focus=plan["focus"], fixed=plan["fixed"], hold_lat=plan["hold"],
            ballast=round(st.ballast, 1), gas=round(st.gas, 1), health=round(st.health, 3),
            sprint=bool(out.get("sprint")),
            lane=plan["lane"], goto=plan["goto"])
        planner.set_watch([VOLCANOES[v] for v in plan["focus"]], WATCH_W)
        planner.set_targets(planner_targets())

    if planner:
        planner.set_watch(VOLCANOES.values(), WATCH_W)   # hang around where eruptions happen
        planner.set_targets(planner_targets())

    for _ in range(int(days * 24 * 3600 / STEP_S)):
        for m in msgs:                                       # mission control: deliver on time
            if m["t_h"] <= st.hours and m["id"] not in {d["id"] for d in delivered}:
                m, extra_ev = personalize(m, st.lat, st.reached, seed)   # reachable from where we are
                if extra_ev:
                    events.append(extra_ev)
                    by_id[extra_ev.id] = extra_ev
                delivered.append(m)
                say("message", m["text"], msg=m["id"], **{k: m[k] for k in ("site", "lat", "lon") if k in m})
                plan["next_h"] = st.hours                    # every agent gets a check-in right away
        if plan["goto"] and gc_km(st.lat, st.lon, *PLACES[plan["goto"]]) <= venus.CAPTURE_KM:
            say("arrived", f"arrived at {plan['goto']}; holding its latitude until the next check-in", goto=plan["goto"])
            plan["hold"] = PLACES[plan["goto"]][0]           # stay on its latitude: we pass it again each lap
            plan["goto"] = None
            if planner:
                planner.set_targets(planner_targets())
        if strategist and planner and st.alive and not chasing and st.hours >= plan["next_h"]:
            plan["next_h"] = st.hours + STRATEGY_H
            restrategize()
        for ev in events:
            if st.alive and ev.id not in known and detectable(ev, st.lat, st.lon, st.hours):
                known[ev.id] = ev
                dist = gc_km(st.lat, st.lon, ev.rep_lat, ev.rep_lon)
                say("detect", f"{ev.spec['sensor']}: {ev.label()}, about {dist:.0f} km away",
                    event=ev.id)
                if commander and not chasing:
                    ev.cur_value = points_for(ev.id, st.hours, ev.lat, by_id, [m for m in delivered if m["type"] == "plumes"])
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
        active = {**TARGETS, **{e.id: (e.lat, e.lon) for e in events if e.t_h <= st.hours < e.ends_h},
                  **bonus_targets(delivered, st.hours), **samples}
        before = set(st.reached)
        if planner and plan["goto"] and not chasing:
            # Head for a place = get onto its latitude and hold it: the westward wind brings every
            # longitude past about every 4-5 days. The lane holder learns the real drift; the
            # planner only knows the forecast, which can push the wrong way.
            action = holder.act(st, PLACES[plan["goto"]][0])
        elif planner and plan["hold"] is not None and not chasing:
            action = holder.act(st, plan["hold"])            # cruise in the chosen band
        else:
            action = policy(st)
        prev = st
        st = step(st, action, active)
        if planner:
            holder.observe(prev, st)
        if not st.alive and not flags.get("lost"):
            flags["lost"] = True
            lost_h = st.hours
            say("lost", f"Balloon lost at {st.alt:.1f} km, health {st.health:.0%}. No more points.")
        for what, left in (("ballast", st.ballast), ("gas", st.gas)):          # tell the log once
            if left < venus.ALT_RATE_KM and not flags.get(what):
                flags[what] = True
                say("budget", f"Out of {what}: can no longer {'climb' if what == 'ballast' else 'sink'}.")
        for got in set(st.reached) - before:
            what = (f"the priority site {got[6:]} (bonus)" if got.startswith("BONUS:")
                    else f"a {'cloud-top' if got.startswith('SKY:') else 'deep-air'} sample" if got.startswith(("SKY:", "DEEP:"))
                    else got if got in TARGETS else by_id[got].label())
            say("reached", f"reached {what}", target=got, pts=points_for(got, st.hours, st.lat, by_id, delivered))
        track.append((st.lat, st.lon, st.alt, st.hours))
        budget.append((st.ballast, st.gas, st.health))

    points = sum(l["pts"] for l in log if l["kind"] == "reached")
    run = {
        "name": name, "days": days, "start": start, "seed": seed, "fixed_alt": fixed_alt,
        "points": points, "reached": st.reached, "laps": round(st.laps, 2),
        "events": [{**{k: v for k, v in e.__dict__.items() if k != "cur_value"}, "sensor": e.spec["sensor"],
                    "value": e.spec["value"], "ends_h": e.ends_h, "text": e.label()} for e in events],
        "messages": delivered,
        "samples": {k: list(v[:2]) + [v[4], v[5]] for k, v in samples.items()},
        "targets": {k: list(v) for k, v in TARGETS.items()},
        "log": log,
        "track": np.round(np.array(track), 3).tolist(),
        "budget": [[round(b, 1), round(g, 1), round(h, 3)] for b, g, h in budget],
        "lost_h": lost_h, "health_left": round(st.health, 3),
        "ballast_left": round(st.ballast, 1), "gas_left": round(st.gas, 1),
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
