"""Plain 2D Venus balloon sim with synthetic layered winds (the README fallback).

Longitude is degrees east, 0-360. Winds blow westward, so longitude decreases.
"""
import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

R_KM = 6051.8                       # Venus mean radius
KM_PER_DEG = np.pi * R_KM / 180     # ~105.6 km per degree of latitude
STEP_S = 15 * 60                    # one sim step is 15 minutes
ALT_RATE_KM = 0.5                   # altitude change per step when ascending/descending
CORRIDOR_KM = (50.0, 62.0)          # the safe band; outside it the envelope wears fast and can fail
LIMITS_KM = (44.0, 68.0)            # how far a balloon can physically go
# Envelope wear per hour (fraction of health) and chance per hour of sudden loss, by altitude.
# Inside the band: slow ageing only. Above: sulfuric acid at the cloud tops. Below: heat.
WEAR_ALT = [44, 46, 49, 50, 62, 63, 66, 68]
WEAR_PER_H = [0.04, 0.02, 0.003, 0.0002, 0.0002, 0.004, 0.02, 0.04]
LOSS_ALT = [44, 47, 50, 62, 64, 66, 68]
LOSS_PER_H = [0.02, 0.005, 0.0, 0.0, 0.002, 0.006, 0.02]
RISK_RNG = np.random.default_rng(0)  # mission.fly seeds this per world and balloon
BALLAST_KM = 45.0                   # dropping ballast is how a balloon climbs: 45 km of climbing per flight
GAS_KM = 45.0                       # venting gas is how it sinks: 45 km of sinking per flight
SOLAR_DAY_H = 116.75 * 24           # Venus solar day in Earth hours (sub-solar point moves slowly)

# 60 real named science sites from the USGS/IAU gazetteer (sim/build_targets.py):
# name -> (lat, lon east). Capture radius is CAPTURE_KM; each is worth 1 point, once.
FEATURES = json.loads((Path(__file__).with_name("data") / "venus_features.json").read_text())
TARGETS = {k: (v["lat"], v["lon"]) for k, v in FEATURES["sites"].items()}
TARGET_SIZE = {k: v["diameter_km"] for k, v in FEATURES["sites"].items()}
CAPTURE_KM = 350.0

# Weather. FORECAST is what everyone knows before launch. Each world's TRUE weather differs
# (world_weather): the altitude where north-south drift flips, wind speed, the strength of the
# north-south push, and the timing of the daily tide. WX holds the true weather of the world
# being flown; step() uses it, while planners that call advance() without wx use the forecast.
FORECAST = {"flip_km": 56.0, "zonal": 1.0, "hadley": 6.0, "tide_phase": 0.0}
WX = dict(FORECAST)


def world_weather(seed):
    rng = np.random.default_rng(10_000 + seed)
    return {"flip_km": float(rng.uniform(52, 60)), "zonal": float(rng.uniform(0.85, 1.15)),
            "hadley": float(rng.uniform(4, 8)), "tide_phase": float(rng.uniform(0, 24))}


def world_start(seed):
    """Launch point for a world: anywhere between 30 S and 30 N."""
    rng = np.random.default_rng(20_000 + seed)
    return float(rng.uniform(-30, 30)), float(rng.uniform(0, 360))


def wind(lat, alt_km, local_time_h, wx=FORECAST):
    """Return (u, v) in m/s. u < 0 is westward; v > 0 is northward.

    Zonal: 60 m/s at the corridor floor rising to 100 m/s at the top (times wx zonal),
    falling off with cos(latitude) like near-solid-body superrotation.
    Meridional: a Hadley-style cell, poleward above the flip altitude and equatorward
    below it, plus a small thermal-tide term that lets a balloon cross the equator if
    it times its altitude to local time.
    """
    # Westward speed by altitude, shaped after probe data: slower going down (about 45 m/s at 44 km),
    # 60 at the band floor, 100 at its top, peaking near 110 at the cloud-top jet (66 km), fading above.
    speed = np.interp(alt_km, [44.0, 50.0, 62.0, 66.0, 68.0], [45.0, 60.0, 100.0, 110.0, 90.0])
    d = np.clip((alt_km - wx["flip_km"]) / 6.0, -1.8, 1.8)             # <0 below the flip, >0 above
    lt = local_time_h + wx["tide_phase"]
    lat_r = np.radians(lat)
    u = -speed * wx["zonal"] * np.cos(lat_r)
    u += 4.0 * np.cos(2 * np.pi * lt / 24.0)                             # diurnal tide on speed
    hadley = wx["hadley"] * d * np.sin(2 * lat_r)
    tide_v = 2.0 * np.sin(2 * np.pi * lt / 24.0) * d
    return u, hadley + tide_v


def gc_km(lat1, lon1, lat2, lon2):
    """Great-circle distance in km."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians(lon2 - lon1)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * R_KM * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def local_time(lon, hours):
    """Local solar time in hours. The sub-solar point drifts slowly westward; it is noon there."""
    subsolar = (-360.0 * hours / SOLAR_DAY_H) % 360
    return (12.0 + (lon - subsolar) / 15.0) % 24


def advance(lat, lon, alt, hours, action, wx=FORECAST):
    """One 15-minute step for scalars or numpy arrays. Returns (lat, lon, alt, dlon).
    Defaults to the forecast weather: that is all a planner knows."""
    alt = np.clip(alt + action * ALT_RATE_KM, *LIMITS_KM)
    u, v = wind(lat, alt, local_time(lon, hours), wx)
    dlat = v * STEP_S / 1000 / KM_PER_DEG
    dlon = u * STEP_S / 1000 / (KM_PER_DEG * np.maximum(np.cos(np.radians(lat)), 0.05))
    return np.clip(lat + dlat, -85, 85), (lon + dlon) % 360, alt, dlon


@dataclass
class State:
    lat: float = 15.0
    lon: float = 300.0
    alt: float = 56.0
    hours: float = 0.0
    lon_flown: float = 0.0          # cumulative degrees travelled westward, for lap counting
    reached: list = field(default_factory=list)
    ballast: float = BALLAST_KM     # km of climbing left
    gas: float = GAS_KM             # km of sinking left
    health: float = 1.0             # envelope health; the balloon is lost at 0
    alive: bool = True

    @property
    def local_time(self):
        return local_time(self.lon, self.hours)

    @property
    def laps(self):
        return self.lon_flown / 360.0


def step(st: State, action: int, targets=None) -> State:
    """Advance one 15-minute step. action: -1 descend, 0 hold, +1 ascend.
    Climbing spends ballast and sinking spends gas; with none left, that direction is gone.
    `targets` maps name -> (lat, lon, ...); defaults to the fixed science sites."""
    if not st.alive:                                     # a lost balloon goes nowhere and scores nothing
        return State(st.lat, st.lon, st.alt, st.hours + STEP_S / 3600, st.lon_flown, list(st.reached),
                     st.ballast, st.gas, 0.0, False)
    if action > 0 and st.ballast < ALT_RATE_KM:
        action = 0
    if action < 0 and st.gas < ALT_RATE_KM:
        action = 0
    lat, lon, alt, dlon = advance(st.lat, st.lon, st.alt, st.hours, action, WX)    # the real weather
    moved = float(alt) - st.alt
    dt = STEP_S / 3600
    health = st.health - float(np.interp(alt, WEAR_ALT, WEAR_PER_H)) * dt
    p_loss = float(np.interp(alt, LOSS_ALT, LOSS_PER_H)) * dt * (1 + 3 * (1 - max(health, 0.0)))
    alive = health > 0 and RISK_RNG.random() >= p_loss
    new = State(float(lat), float(lon), float(alt), st.hours + dt,
                st.lon_flown - float(dlon), list(st.reached),
                st.ballast - max(moved, 0.0), st.gas - max(-moved, 0.0), max(health, 0.0), alive)
    if not alive:
        return new
    for name, t in (TARGETS if targets is None else targets).items():
        if name not in new.reached and gc_km(new.lat, new.lon, t[0], t[1]) <= CAPTURE_KM:
            if len(t) >= 6 and not (t[4] <= new.alt <= t[5]):
                continue                                 # a layer sample: only counts inside its layer
            new.reached.append(name)
    return new


def run(policy, days=10.0, start=None):
    """Fly `policy(state) -> action` for `days` Earth days. Returns the track and final state."""
    st = start or State()
    track = [(st.lat, st.lon, st.alt, st.hours)]
    for _ in range(int(days * 24 * 3600 / STEP_S)):
        st = step(st, policy(st))
        track.append((st.lat, st.lon, st.alt, st.hours))
    return np.array(track), st


def drifter(alt_km=56.0):
    """Vega-style baseline: go to one altitude and stay there."""
    def policy(st):
        return int(np.sign(round(alt_km - st.alt, 3)))
    return policy


def greedy_planner(levels=(50.5, 53.0, 56.0, 59.0, 61.5), horizon=192, every=8):
    """Placeholder planner: every `every` steps, try each altitude level for `horizon`
    steps ahead and pick the one that gets closest to any unreached target.
    The real planner (phasing search) replaces this."""
    plan = {"alt": 56.0, "t": -1}

    def policy(st):
        k = int(round(st.hours * 3600 / STEP_S))
        if k - plan["t"] >= every:
            plan["t"] = k
            best = (np.inf, plan["alt"])
            todo = [t for n, t in TARGETS.items() if n not in st.reached]
            for lvl in levels:
                sim = State(st.lat, st.lon, st.alt, st.hours, st.lon_flown, list(st.reached))
                d_min = np.inf
                for _ in range(horizon):
                    sim = step(sim, int(np.sign(round(lvl - sim.alt, 3))))
                    if len(sim.reached) > len(st.reached):
                        d_min = -1e9 + _          # reaching a target beats everything; sooner is better
                        break
                    for tlat, tlon in todo:
                        d_min = min(d_min, gc_km(sim.lat, sim.lon, tlat, tlon))
                best = min(best, (d_min, lvl))
            plan["alt"] = best[1]
        return int(np.sign(round(plan["alt"] - st.alt, 3)))
    return policy


if __name__ == "__main__":
    for name, pol in [("drifter", drifter()), ("planner", greedy_planner())]:
        _, final = run(pol)
        print(f"{name:8s} laps={final.laps:4.1f} reached={final.reached}")
