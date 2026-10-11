"""Precompute demo runs for the website: for each world (seed), fly the agent, the Vega-style
54 km drifter, and the best fixed-altitude drifter, and write web/data/world<seed>.json.

    uv run --with numpy --with pillow python sim/export_web.py            # rule commander
    uv run --with numpy --with pillow python sim/export_web.py --gemini   # Gemini commander
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

import commander as cmd
from mission import fly
from venus import CAPTURE_KM, CORRIDOR_KM, STEP_S, TARGETS

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
LEVELS = np.arange(50.5, 62.0, 1.5)


def slim(run, label):
    return {
        "label": label, "points": run["points"], "reached": run["reached"],
        "fixed_alt": run["fixed_alt"], "laps": run["laps"], "log": run["log"],
        "track": [[round(a, 2), round(b, 2), round(c, 2)] for a, b, c, _ in run["track"]],
    }


def basemap():
    """Shift the -180..180 Magellan mosaic to 0..360 to match the sim, and shrink it for the web."""
    img = Image.open(ROOT / "assets" / "venus_magellan.jpg").convert("L")
    a = np.roll(np.asarray(img), img.width // 2, axis=1)
    out = Image.fromarray(a).resize((2048, 1024), Image.LANCZOS)
    (WEB / "data").mkdir(parents=True, exist_ok=True)
    out.save(WEB / "data" / "venus_0_360.jpg", quality=82)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gemini", action="store_true")
    ap.add_argument("--seeds", type=int, nargs="+", default=[1, 2, 3, 4, 5])
    ap.add_argument("--days", type=float, default=10.0)
    a = ap.parse_args()
    basemap()
    commander = cmd.gemini_commander() if a.gemini else cmd.rule_commander
    who = "Gemini Robotics-ER 2" if a.gemini else "rule-based"
    summary = []
    for seed in a.seeds:
        agent = fly(f"agent_s{seed}", a.days, seed=seed, commander=commander)
        vega = fly(f"vega_s{seed}", a.days, seed=seed, fixed_alt=54.0)
        drifters = [fly(f"d{alt:g}_s{seed}", a.days, seed=seed, fixed_alt=float(alt)) for alt in LEVELS]
        best = max(drifters, key=lambda r: r["points"])
        world = {
            "seed": seed, "days": a.days, "step_h": STEP_S / 3600, "commander": who,
            "capture_km": CAPTURE_KM, "corridor_km": CORRIDOR_KM,
            "targets": {k: list(v) for k, v in TARGETS.items()},
            "events": agent["events"],
            "runs": {
                "agent": slim(agent, f"Agent ({who} commander)"),
                "vega": slim(vega, "Drifter at 54 km, like Vega 1985"),
                "best": slim(best, f"Best fixed altitude ({best['fixed_alt']:g} km, chosen in hindsight)"),
            },
        }
        (WEB / "data" / f"world{seed}.json").write_text(json.dumps(world, separators=(",", ":")))
        summary.append({"seed": seed, "agent": agent["points"], "vega": vega["points"],
                        "best": best["points"], "best_alt": best["fixed_alt"]})
        print(f"world {seed}: agent {agent['points']:.0f}  vega {vega['points']:.0f}  "
              f"best {best['points']:.0f} @ {best['fixed_alt']:g} km")
    (WEB / "data" / "index.json").write_text(json.dumps({"commander": who, "worlds": summary}))


if __name__ == "__main__":
    main()
