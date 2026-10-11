"""Precompute demo runs for the website, in two stages so the slow model runs can go in parallel.

1. One process per (world, model) flies that AI balloon and saves a part file:
       uv run --with numpy --with pillow --with matplotlib python sim/export_web.py fly --model er --seeds 3
   --model er | flash | rules. Model calls make this the slow stage.
2. Assemble: fly the fixed-altitude balloons, pick the best SINGLE altitude across all worlds
   (the fair rival), and write web/data/world<N>.json plus index.json:
       uv run --with numpy --with pillow --with matplotlib python sim/export_web.py assemble
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

import commander as cmd
import mission
import strategist as sg
import venus
from mission import fly
from events import VOLCANOES
from end_state import end_state
from missionctl import make_messages, make_samples
from venus import CAPTURE_KM, CORRIDOR_KM, STEP_S, TARGET_SIZE, TARGETS

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
PARTS = WEB / "data" / "parts"
LEVELS = np.arange(50.5, 62.0, 1.5)
DAYS = 30.0
SEEDS = list(range(1, 21))
MODELS = {
    "er": ("gemini-robotics-er-2-preview", "Gemini Robotics-ER 2"),
    "flash": ("gemini-3.8-flash", "Gemini 3.8 Flash"),
}


def slim(run, label, who=None):
    log = run["log"] if who is None else [{**l, "who": who} for l in run["log"]]
    return {
        "label": label, "points": run["points"], "reached": run["reached"],
        "fixed_alt": run["fixed_alt"], "laps": run["laps"], "log": log,
        "track": [[round(a, 2), round(b, 2), round(c, 2)] for a, b, c, _ in run["track"]],
        "budget": run.get("budget", [])[::4],          # ballast, gas and health left, every hour
        "lost_h": run.get("lost_h"),
    }


def basemap():
    """Shift the -180..180 Magellan mosaic to 0..360 to match the sim, and shrink it for the web."""
    img = Image.open(ROOT / "assets" / "venus_magellan.jpg").convert("L")
    a = np.roll(np.asarray(img), img.width // 2, axis=1)
    out = Image.fromarray(a).resize((2048, 1024), Image.LANCZOS)
    (WEB / "data").mkdir(parents=True, exist_ok=True)
    out.save(WEB / "data" / "venus_0_360.jpg", quality=82)


def fly_agent(model_key, seeds, days):
    mission.STRATEGY_H = 48.0          # strategist check-in every 2 days keeps model calls affordable
    PARTS.mkdir(parents=True, exist_ok=True)
    if model_key == "rules":
        com, strat, name = cmd.rule_commander, sg.rule_strategist, "rule-based"
    elif model_key == "hybrid":
        com, strat, name = cmd.rule_commander, sg.hybrid_strategist(model=MODELS["er"][0]), "Rulebook + Gemini ER 2"
    else:
        model, name = MODELS[model_key]
        com, strat = cmd.gemini_commander(model=model), sg.gemini_strategist(model=model)
    for seed in seeds:
        run = fly(f"{model_key}_s{seed}", days, seed=seed, commander=com, strategist=strat)
        fb = sum("rule fallback" in l["text"] for l in run["log"])
        (PARTS / f"world{seed}_{model_key}.json").write_text(json.dumps(
            {"run": slim(run, name, who=name), "events": run["events"], "messages": run["messages"], "start": run["start"],
             "weather": venus.WX, "model": name, "fallbacks": fb}, separators=(",", ":")))
        print(f"world {seed} {name}: {run['points']:.0f} points, {fb} fallbacks", flush=True)


def assemble(days):
    basemap()
    fixed = {s: {float(alt): fly(f"d{alt:g}_s{s}", days, seed=s, fixed_alt=float(alt)) for alt in LEVELS}
             for s in SEEDS}
    totals = {alt: sum(fixed[s][alt]["points"] for s in SEEDS) for alt in map(float, LEVELS)}
    single = max(totals, key=totals.get)
    rows = []
    for s in SEEDS:
        parts = {k: json.loads((PARTS / f"world{s}_{k}.json").read_text())
                 for k in ("er", "flash", "rules", "hybrid") if (PARTS / f"world{s}_{k}.json").exists()}
        if "er" not in parts:
            continue
        vega = fly(f"vega_s{s}", days, seed=s, fixed_alt=54.0)
        er = parts["er"]
        runs = {"agent": er["run"], "vega": slim(vega, "Drifter at 54 km, like Vega 1985"),
                "best": slim(fixed[s][single], f"Best single fixed altitude for all worlds ({single:g} km)")}
        if "flash" in parts:
            runs["flash"] = parts["flash"]["run"]
        if "rules" in parts:
            runs["rules"] = {**parts["rules"]["run"], "label": "Rulebook"}
        if "hybrid" in parts:
            runs["hybrid"] = parts["hybrid"]["run"]
        avg = float(np.mean([fixed[s][a]["points"] for a in map(float, LEVELS)]))
        world = {
            "seed": s, "days": days, "step_h": STEP_S / 3600, "commander": "Gemini Robotics-ER 2 and Gemini 3.8 Flash",
            "capture_km": CAPTURE_KM, "corridor_km": CORRIDOR_KM,
            "targets": {k: list(v) for k, v in TARGETS.items()}, "target_size": TARGET_SIZE,
            "volcanoes": {k: list(v) for k, v in VOLCANOES.items()},
            "samples": {k: [v[0], v[1], v[4], v[5]] for k, v in make_samples(s).items()},
            "events": er["events"], "messages": make_messages(s, days)[0], "start": er["start"], "weather": er["weather"], "forecast": venus.FORECAST,
            "fixed_points": {f"{a:g}": fixed[s][a]["points"] for a in map(float, LEVELS)}, "avg_fixed": avg,
            "runs": runs,
        }
        (WEB / "data" / f"world{s}.json").write_text(json.dumps(world, separators=(",", ":")))
        rows.append({"seed": s, "agent": runs["agent"]["points"], "flash": runs.get("flash", {}).get("points"),
                     "rules": runs.get("rules", {}).get("points"), "hybrid": runs.get("hybrid", {}).get("points"),
                     "vega": runs["vega"]["points"], "best": runs["best"]["points"], "best_alt": single,
                     "avg": round(avg, 1),
                     "end": {k: end_state(v, days) for k, v in runs.items()}})
    (WEB / "data" / "index.json").write_text(json.dumps({"days": days, "worlds": rows}))
    tot = lambda k: sum(r[k] or 0 for r in rows)
    print(f"{len(rows)} worlds, {days:g} days. ER 2 {tot('agent'):.0f}, Flash {tot('flash'):.0f}, rulebook {tot('rules'):.0f}, hybrid {tot('hybrid'):.0f}, "
          f"best single fixed ({single:g} km) {tot('best'):.0f}, Vega {tot('vega'):.0f}, average fixed {tot('avg'):.0f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["fly", "assemble"])
    ap.add_argument("--model", default="er", choices=["er", "flash", "rules", "hybrid"])
    ap.add_argument("--seeds", type=int, nargs="+", default=SEEDS)
    ap.add_argument("--days", type=float, default=DAYS)
    a = ap.parse_args()
    if a.stage == "fly":
        fly_agent(a.model, a.seeds, a.days)
    else:
        assemble(a.days)


if __name__ == "__main__":
    main()
