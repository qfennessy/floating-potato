"""Strategists pick, every few hours, where the balloon should hang out (which volcanoes)
and which fixed sites to pursue. Same signature for both:

    strategist(state, view) -> {"focus": [...], "fixed": [...], "hold_lat": deg, "reason": str}

hold_lat is the latitude band the balloon cruises in between chases. Being in the right band is
what scores in this sim: winds only blow west, so a balloon in a busy band passes every site in
it once a lap.

The Gemini version sees a rendered map image: the balloon, its track, the volcanoes with how
many events each has produced so far, and the fixed sites.
"""
import base64
import io
import json
import os
import urllib.request
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from events import VOLCANOES
from venus import TARGETS

ROOT = Path(__file__).resolve().parent.parent
from commander import MODEL, model_url
_BASEMAP = None

REACH_DEG = 3.3     # a balloon in a lane passes within capture range (350 km) of things this close
DEG_PER_DAY = 4.0   # rough best-case north-south speed; near the equator it is much slower


def build_lanes(k=6, min_gap=7.0):
    """Latitude lanes where volcanoes and sites cluster. A lane's worth: volcanoes in reach
    (repeat eruptions) plus half a point per site in reach (each scores once). Greedy, k lanes."""
    def near(lat, pts):
        return [n for n, (l, _) in pts.items() if abs(l - lat) <= REACH_DEG]
    cands = sorted({round(l, 1) for l, _ in list(VOLCANOES.values()) + list(TARGETS.values()) if abs(l) <= 60})
    score = {c: len(near(c, VOLCANOES)) + 0.5 * len(near(c, TARGETS)) for c in cands}
    lanes, vols = {}, {}
    for c in sorted(cands, key=lambda c: -score[c]):
        if len(lanes) == k:
            break
        if all(abs(c - l) >= min_gap for l in lanes.values()):
            nv, ns = len(near(c, VOLCANOES)), len(near(c, TARGETS))
            name = f"lane {abs(c):.0f}{'N' if c >= 0 else 'S'}"     # no counts: read them off the map
            lanes[name] = c
            vols[name] = near(c, VOLCANOES)
    return lanes, vols


LANES, LANE_VOLCANOES = build_lanes()
ROAM = "roam (no lane: fly fast and hunt the nearest unvisited sites)"
PLACES = sorted(set(VOLCANOES) | set(TARGETS))     # names the strategist may head for


def roam_choice(view, reason, goto=None):
    return {"lane": ROAM, "hold_lat": None, "focus": list(VOLCANOES), "fixed": view["unvisited"],
            "reason": reason, "goto": goto}


def lane_choice(lane, view, reason, goto=None):
    return {"lane": lane, "hold_lat": LANES[lane], "focus": LANE_VOLCANOES[lane],
            "fixed": [t for t in view["unvisited"] if abs(TARGETS[t][0] - LANES[lane]) <= 6],
            "reason": reason, "goto": goto}


def travel_days(lat_from, lat_to):
    return abs(lat_to - lat_from) / DEG_PER_DAY


SITE_W, VOLCANO_W = 1.0, 0.3   # a site is a sure point (once); a volcano might erupt while we pass
SWITCH_MARGIN = 1.3             # only move lanes if the new one looks this much better


def lane_worth(lane, st, view, current=None):
    """What a lane still offers: unvisited sites in reach plus a little per volcano, scaled by the
    share of the mission left after getting there (the current lane needs no travel)."""
    left = max(view["days"] - st.hours / 24, 0.1)
    if lane == ROAM:
        return 0.0
    travel = 0.0 if lane == current else travel_days(st.lat, LANES[lane])
    ns = sum(abs(TARGETS[t][0] - LANES[lane]) <= REACH_DEG for t in view["unvisited"])
    return (SITE_W * ns + VOLCANO_W * len(LANE_VOLCANOES[lane])) * max(0.0, left - travel) / left


def rule_strategist(st, view):
    """Hold a lane while it still has at least 3 unvisited sites; otherwise roam. With many
    one-time sites, a lane runs dry after a lap or two, and roaming sweeps up new ones."""
    cur = view.get("lane")
    best = max(LANES, key=lambda l: lane_worth(l, st, view, cur))
    in_reach = sum(abs(TARGETS[t][0] - LANES[best]) <= REACH_DEG for t in view["unvisited"])
    if in_reach < 3:
        return roam_choice(view, "No lane has enough unvisited sites left, so roaming to sweep up new ones.")
    if cur in LANES and lane_worth(best, st, view, cur) <= SWITCH_MARGIN * lane_worth(cur, st, view, cur):
        best = cur
    return lane_choice(best, view, f"Cruising in the {best} lane: the most still to see for the travel time.")


def render_map(st, view, px=1024):
    """PNG bytes: Magellan basemap (0-360 E), track, balloon, volcanoes with event counts, sites."""
    global _BASEMAP
    if _BASEMAP is None:
        img = plt.imread(ROOT / "assets" / "venus_magellan.jpg")
        _BASEMAP = np.roll(img, img.shape[1] // 2, axis=1)
    fig = plt.figure(figsize=(px / 100, px / 200), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.imshow(_BASEMAP, extent=(0, 360, -90, 90), aspect="auto", cmap="copper")
    tr = np.array(view["track"])
    jumps = np.where(np.abs(np.diff(tr[:, 1])) > 180)[0] + 1
    for seg in np.split(tr, jumps):
        ax.plot(seg[:, 1], seg[:, 0], color="orange", lw=2)
    ax.plot(st.lon, st.lat, "o", color="white", mec="black", ms=11)
    ax.annotate("BALLOON", (st.lon, st.lat), xytext=(8, 8), textcoords="offset points",
                color="white", fontsize=10, weight="bold")
    counts = {v: 0 for v in VOLCANOES}
    for e in view["known"]:
        if e.site in counts:
            counts[e.site] += 1
    for lane, lat in LANES.items():                     # lanes as labelled bands
        ax.axhspan(lat - REACH_DEG, lat + REACH_DEG, color="cyan", alpha=0.12)
        ax.annotate(lane, (2, lat), xytext=(0, 3), textcoords="offset points", color="cyan", fontsize=9)
    for v, (lat, lon) in VOLCANOES.items():
        ax.plot(lon, lat, "^", color="red" if counts[v] == 0 else "yellow", mec="black", ms=7)
    for t, (lat, lon) in TARGETS.items():
        ax.plot(lon, lat, "*", color="lime" if t in view["reached"] else "white", mec="black", ms=8)
    for m in view.get("messages", []):                  # what mission control asked for, if still live
        if m["type"] == "priority" and st.hours < m["until_h"]:
            ax.plot(m["lon"], m["lat"], "o", mfc="none", mec="magenta", ms=22, mew=3)
            ax.annotate("PRIORITY", (m["lon"], m["lat"]), xytext=(12, 10), textcoords="offset points",
                        color="magenta", fontsize=10, weight="bold")
        if m["type"] == "tip" and st.hours < m["erupt_h"] + 72:
            lat, lon = VOLCANOES[m["site"]]
            ax.plot(lon, lat, "o", mfc="none", mec="orange", ms=22, mew=3)
            ax.annotate("ALERT", (lon, lat), xytext=(12, 10), textcoords="offset points",
                        color="orange", fontsize=10, weight="bold")
        if m["type"] == "outage" and m["t_h"] <= st.hours < m["until_h"]:
            lo, hi = (-90, 0) if m["hemi"] == "south" else (0, 90)
            ax.axhspan(lo, hi, color="black", alpha=0.35, hatch="//")
    ax.set_xlim(0, 360)
    ax.set_ylim(-90, 90)
    ax.axis("off")
    buf = io.BytesIO()
    fig.savefig(buf, format="png")
    plt.close(fig)
    return buf.getvalue()


def _prompt(st, view):
    heard = view["events_heard"][-12:]
    lines = "\n".join(f"- hour {l['t_h']:.0f}: {l['text']}" for l in heard) or "- nothing yet"
    msgs = "\n".join(f"- hour {m['t_h']:.0f}: {m['text']}" for m in view.get("messages", [])) or "- none yet"
    current = view.get("lane")
    lanes = "\n".join(
        f"- {lane} (latitude {lat:+.0f}): about {travel_days(st.lat, lat):.1f} days to get there"
        + ("  <- CURRENT" if lane == current else "") for lane, lat in LANES.items())
    lanes += f"\n- {ROAM}" + ("  <- CURRENT" if current == ROAM else "")
    left_days = view["days"] - st.hours / 24
    goto = f"Currently heading for: {view['goto']}.\n" if view.get("goto") else ""
    return (
        "You are the strategist for a research balloon in the clouds of Venus. The image is a map "
        "(longitude 0-360 E left to right, latitude +90 top to -90 bottom). Winds carry the balloon "
        "WEST (leftward on the map) all the time, about one lap of the planet every 4-5 days. "
        "The balloon steers only by altitude: low (50 km) is slower and drifts toward the equator; "
        "high (62 km) is faster and drifts toward the poles. A planner handles altitude for you.\n"
        f"Hour {st.hours:.0f} of {view['days'] * 24:.0f}. Balloon at lat {st.lat:.1f}, lon {st.lon:.1f} E.\n"
        "Points: each named site 1 (once), eruption 2, gas plume 3, lightning 1, unless mission "
        "control says otherwise. Events last 1-3 days and the balloon must pass within 350 km while "
        "one is active.\n"
        "Map key: red triangles are volcanoes (yellow once one has erupted during this mission), "
        "white stars are sites not yet visited, green stars visited ones, cyan bands are the lanes, "
        "magenta PRIORITY and orange ALERT circles mark mission control requests, hatched area is a "
        "relay outage.\n"
        f"Messages from mission control:\n{msgs}\n"
        f"Sensor reports so far (most recent last):\n{lines}\n"
        "Holding a lane means cruising at the altitude with no north-south drift, passing everything "
        "in it once a lap; it is slower than flying high. Sites score only once, so judge from the map "
        "how many unvisited sites each lane still has. Roaming lets the planner chase the nearest "
        "unvisited sites, flying high and fast across latitudes. You can also name one place to head "
        "for first (head_for); the planner flies there, then goes back to your lane or roaming.\n"
        f"{goto}Choices ({left_days:.1f} days of mission left):\n{lanes}\n"
        "Call choose_lane once, with a one-sentence reason a mission log reader understands."
    )


def gemini_strategist(model=MODEL, thinking="medium", timeout=120):
    key = os.environ.get("GEMINI_API_KEY")
    tool = {"functionDeclarations": [{
        "name": "choose_lane",
        "description": "Choose the latitude lane (or roam) until the next check-in, and optionally one place to head for first.",
        "parameters": {"type": "object", "properties": {
            "lane": {"type": "string", "enum": list(LANES) + [ROAM]},
            "head_for": {"type": "string", "enum": ["none"] + PLACES,
                         "description": "A named site or volcano to fly to first, or none."},
            "reason": {"type": "string"}},
            "required": ["lane", "reason"]}}]}

    def decide(st, view):
        if not key:
            out = rule_strategist(st, view)
            out["reason"] += " (rule fallback: no GEMINI_API_KEY)"
            return out
        body = {
            "contents": [{"role": "user", "parts": [
                {"inline_data": {"mime_type": "image/png",
                                 "data": base64.b64encode(render_map(st, view)).decode()}},
                {"text": _prompt(st, view)}]}],
            "tools": [tool],
            "toolConfig": {"functionCallingConfig": {"mode": "ANY"}},
            "generationConfig": {"thinkingConfig": {"thinkingLevel": thinking}},
        }
        req = urllib.request.Request(model_url(model), json.dumps(body).encode(), method="POST", headers={
            "Content-Type": "application/json", "x-goog-api-key": key})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                parts = json.load(resp)["candidates"][0]["content"]["parts"]
            args = next(p["functionCall"] for p in parts if "functionCall" in p).get("args", {})
            lane, reason = args.get("lane"), args.get("reason", "").strip()
            goto = args.get("head_for") if args.get("head_for") in PLACES else None
            if lane == ROAM:
                return roam_choice(view, reason, goto)
            if lane not in LANES:
                lane = view.get("lane") if view.get("lane") in LANES else list(LANES)[0]
            return lane_choice(lane, view, reason, goto)
        except Exception as e:
            out = rule_strategist(st, view)
            out["reason"] += f" (rule fallback: {type(e).__name__})"
            return out

    return decide
