"""Fair scoreboard: the search planner vs. EVERY fixed-altitude drifter, from several launch points.

The win condition is "more targets than a balloon riding one altitude", so the planner
has to beat the best drifter at each launch, not just the Vega 54 km one.
"""
import sys
import time

import numpy as np

from planner import search_planner
from venus import State, drifter, run

LAUNCHES = [(15.0, 300.0), (5.0, 60.0), (-10.0, 150.0), (25.0, 200.0), (-5.0, 330.0)]
DAYS = 10.0


def main():
    wins = ties = 0
    for lat, lon in LAUNCHES:
        drift = {a: len(run(drifter(a), DAYS, State(lat, lon, a))[1].reached)
                 for a in np.arange(50.5, 62.0, 0.5)}
        best_alt = max(drift, key=drift.get)
        t0 = time.time()
        _, f = run(search_planner(), DAYS, State(lat, lon, 56.0))
        p, b = len(f.reached), drift[best_alt]
        wins += p > b
        ties += p == b
        print(f"launch {lat:+5.1f},{lon:5.1f}  planner {p} {f.reached}  "
              f"best drifter {b} @ {best_alt:.1f} km  vega54 {drift[54.0]}  ({time.time() - t0:.0f}s)")
        sys.stdout.flush()
    print(f"planner beats the best drifter at {wins}/{len(LAUNCHES)} launches, ties {ties}")


if __name__ == "__main__":
    main()
