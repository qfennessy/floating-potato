"""Render the pitch sketch: drifter vs. planner tracks on a Venus map, plus the corridor strip.

Uses assets/venus_magellan.(jpg|png) as the background when present. That mosaic runs
-180 to +180 E with 0 in the centre (see assets/README.md), so it is rolled half a width
to match the sim's 0-360 E longitudes.
"""
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from venus import CORRIDOR_KM, TARGETS, drifter, greedy_planner, run

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "pitch_sketch.png"


def split_wraps(track):
    """Break a track into segments wherever longitude wraps 0/360, so lines don't streak across."""
    jumps = np.where(np.abs(np.diff(track[:, 1])) > 180)[0] + 1
    return np.split(track, jumps)


def main(days=10.0):
    d_track, d_final = run(drifter(54.0), days)          # 54 km, like Vega 1985
    p_track, p_final = run(greedy_planner(), days)

    fig = plt.figure(figsize=(12, 7.2), facecolor="#14110f")
    ax = fig.add_axes([0.05, 0.30, 0.90, 0.62])
    strip = fig.add_axes([0.05, 0.07, 0.90, 0.16])

    basemap = next((p for p in (ROOT / "assets").glob("venus_magellan.*") if p.suffix in {".jpg", ".png"}), None)
    if basemap:
        img = plt.imread(basemap)
        img = np.roll(img, img.shape[1] // 2, axis=1)       # -180..180 -> 0..360
        if img.ndim == 3:
            img = img[..., :3].mean(axis=2)
        ax.imshow(img, extent=(0, 360, -90, 90), aspect="auto", cmap="copper")
    else:
        ax.set_facecolor("#3a2a1a")
    ax.set_xlim(0, 360)
    ax.set_ylim(-90, 90)
    ax.set_xticks(range(0, 361, 60))
    ax.set_yticks(range(-90, 91, 30))
    ax.tick_params(colors="#cfc6b8", labelsize=8)
    ax.set_xlabel("longitude (deg E)   winds blow right to left", color="#cfc6b8", fontsize=9)

    for seg in split_wraps(d_track):
        ax.plot(seg[:, 1], seg[:, 0], color="#b8b8b8", lw=1.6, alpha=0.9)
    for seg in split_wraps(p_track):
        ax.plot(seg[:, 1], seg[:, 0], color="#ffb347", lw=2.2)
    ax.plot(p_track[0, 1], p_track[0, 0], "o", color="white", ms=7)
    ax.annotate("launch", (p_track[0, 1], p_track[0, 0]), xytext=(6, -14),
                textcoords="offset points", color="white", fontsize=9)

    reached = set(p_final.reached)
    for name, (lat, lon) in TARGETS.items():
        c = "#4ade80" if name in reached else "#f87171"
        ax.plot(lon, lat, marker="*", ms=16, color=c, mec="black", mew=0.6)
        ax.annotate(name, (lon, lat), xytext=(7, -12), textcoords="offset points",
                    color="white", fontsize=9, weight="bold")

    ax.set_title(
        f"Venus Balloon Navigator: {days:.0f} Earth days. "
        f"Targets reached: agent (orange) {len(p_final.reached)}, drifter at 54 km like Vega (grey) {len(d_final.reached)}",
        color="white", fontsize=12, loc="left")

    strip.set_facecolor("#1f1a16")
    strip.axhspan(*CORRIDOR_KM, color="#4ade80", alpha=0.12)
    strip.plot(d_track[:, 3] / 24, d_track[:, 2], color="#b8b8b8", lw=1.4)
    strip.plot(p_track[:, 3] / 24, p_track[:, 2], color="#ffb347", lw=1.8)
    strip.set_ylim(48, 64)
    strip.set_xlim(0, days)
    strip.set_ylabel("altitude km", color="#cfc6b8", fontsize=9)
    strip.set_xlabel("Earth days   (green band = 50-62 km safe corridor; higher = faster wind)",
                     color="#cfc6b8", fontsize=9)
    strip.tick_params(colors="#cfc6b8", labelsize=8)

    OUT.parent.mkdir(exist_ok=True)
    fig.savefig(OUT, dpi=110, facecolor=fig.get_facecolor())
    print(f"wrote {OUT.relative_to(ROOT)}  agent={p_final.reached}  drifter={d_final.reached}")


if __name__ == "__main__":
    main()
