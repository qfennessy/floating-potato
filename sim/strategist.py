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
MODEL = "gemini-robotics-er-2-preview"
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
_BASEMAP = None

# Lanes the balloon can cruise in: volcanoes grouped by latitude.
LANES = {
    "north (22N: Theia, Gula, Sif Mons)": 22.2,
    "equator (5N: Maat, Sapas, Ozza Mons)": 4.5,
    "south (47S: Idunn Mons)": -46.6,
}
LANE_VOLCANOES = {
    "north (22N: Theia, Gula, Sif Mons)": ["Theia Mons", "Gula Mons", "Sif Mons"],
    "equator (5N: Maat, Sapas, Ozza Mons)": ["Maat Mons", "Sapas Mons", "Ozza Mons"],
    "south (47S: Idunn Mons)": ["Idunn Mons"],
}
DEG_PER_DAY = 4.0   # rough best-case north-south speed; near the equator it is much slower


def travel_days(lat_from, lat_to):
    return abs(lat_to - lat_from) / DEG_PER_DAY


def rule_strategist(st, view):
    """Pick the lane with the most volcanoes; on a tie, the closer one. Never switch after that:
    switching costs days, and recent activity doesn't predict where the next event will be."""
    lane = view.get("lane") or max(LANES, key=lambda l: (len(LANE_VOLCANOES[l]), -abs(LANES[l] - st.lat)))
    return {"lane": lane, "hold_lat": LANES[lane], "focus": LANE_VOLCANOES[lane],
            "fixed": [t for t in view["unvisited"] if abs(TARGETS[t][0] - LANES[lane]) <= 6],
            "reason": f"Cruising in the {lane} lane."}


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
    for v, (lat, lon) in VOLCANOES.items():
        ax.plot(lon, lat, "^", color="red", mec="black", ms=10)
        ax.annotate(f"{v} ({counts[v]} events)", (lon, lat), xytext=(6, -12),
                    textcoords="offset points", color="yellow", fontsize=9, weight="bold")
    for t, (lat, lon) in TARGETS.items():
        done = t in view["reached"]
        ax.plot(lon, lat, "*", color="lime" if done else "white", mec="black", ms=14)
        ax.annotate(t + (" (done)" if done else ""), (lon, lat), xytext=(8, 4),
                    textcoords="offset points", color="white", fontsize=9)
    ax.set_xlim(0, 360)
    ax.set_ylim(-90, 90)
    ax.axis("off")
    buf = io.BytesIO()
    fig.savefig(buf, format="png")
    plt.close(fig)
    return buf.getvalue()


def _prompt(st, view):
    heard = view["events_heard"][-6:]
    lines = "\n".join(f"- hour {l['t_h']:.0f}: {l['text']}" for l in heard) or "- nothing yet"
    current = view.get("lane")
    counts = {lane: sum(e.site in vs for e in view["known"]) for lane, vs in LANE_VOLCANOES.items()}
    lanes = "\n".join(
        f"- {lane}: about {travel_days(st.lat, lat):.1f} days to get there; "
        f"{counts[lane]} events heard there so far" + ("  <- CURRENT LANE" if lane == current else "")
        for lane, lat in LANES.items())
    left_days = view["days"] - st.hours / 24
    return (
        "You are the strategist for a research balloon in the clouds of Venus. The image is a map "
        "(longitude 0-360 E left to right, latitude +90 top to -90 bottom). Winds carry the balloon "
        "WEST (leftward on the map) all the time, about one lap of the planet every 4-5 days. "
        "The balloon steers only by altitude: low (50 km) is slower and drifts toward the equator; "
        "high (62 km) is faster and drifts toward the poles. A planner handles altitude for you.\n"
        f"Hour {st.hours:.0f} of {view['days'] * 24:.0f}. Balloon at lat {st.lat:.1f}, lon {st.lon:.1f} E.\n"
        "Points: fixed site 1 (once each), eruption 2, gas plume 3, lightning 1. Eruptions and plumes "
        "happen at the red volcanoes; the label shows how many each has produced so far. Events last "
        "1-3 days and the balloon must pass within 350 km while one is active.\n"
        f"Recent sensor reports:\n{lines}\n"
        "Because the wind always blows west, a balloon that holds one latitude passes every site in "
        "that lane once a lap, about every 4-5 days. So the key choice is which lane to cruise in.\n"
        f"Lanes ({left_days:.1f} days of mission left):\n{lanes}\n"
        "Every day spent travelling between lanes is a day not passing volcanoes, and events happen "
        "at random, so a burst of recent activity does not mean more is coming there. Switch lanes "
        "only if it clearly pays off in the time left. Call choose_lane once, with a one-sentence "
        "reason a mission log reader understands."
    )


def gemini_strategist(thinking="medium", timeout=60):
    key = os.environ.get("GEMINI_API_KEY")
    tool = {"functionDeclarations": [{
        "name": "choose_lane",
        "description": "Choose the latitude lane the balloon cruises in until the next check-in.",
        "parameters": {"type": "object", "properties": {
            "lane": {"type": "string", "enum": list(LANES)},
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
        req = urllib.request.Request(URL, json.dumps(body).encode(), method="POST", headers={
            "Content-Type": "application/json", "x-goog-api-key": key})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                parts = json.load(resp)["candidates"][0]["content"]["parts"]
            args = next(p["functionCall"] for p in parts if "functionCall" in p).get("args", {})
            lane = args.get("lane") if args.get("lane") in LANES else view.get("lane") or list(LANES)[0]
            return {"lane": lane, "hold_lat": LANES[lane], "focus": LANE_VOLCANOES[lane],
                    "fixed": [t for t in view["unvisited"] if abs(TARGETS[t][0] - LANES[lane]) <= 6],
                    "reason": args.get("reason", "").strip()}
        except Exception as e:
            out = rule_strategist(st, view)
            out["reason"] += f" (rule fallback: {type(e).__name__})"
            return out

    return decide
