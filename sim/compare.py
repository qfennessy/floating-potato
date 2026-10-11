"""Fair scoreboard over many worlds: the agent vs. EVERY fixed-altitude drifter.

Uses the rule strategist and rule commander (no API calls), so it is quick and repeatable.
A fixed altitude has to be chosen before launch; "best in hindsight" is shown only for context.

    uv run --with numpy --with matplotlib python sim/compare.py --worlds 20
"""
import argparse

import numpy as np

import commander as cmd
import strategist as sg
from mission import fly

ALTS = np.arange(50.5, 62.0, 1.5)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--worlds", type=int, default=20)
    a = ap.parse_args()
    seeds = range(1, a.worlds + 1)
    agent = np.array([fly("cmp", seed=s, strategist=sg.rule_strategist,
                          commander=cmd.rule_commander)["points"] for s in seeds])
    fixed = np.array([[fly("cmp", seed=s, fixed_alt=float(alt))["points"] for alt in ALTS] for s in seeds])
    print(f"agent: {agent.sum():.0f} points over {a.worlds} worlds")
    for alt, col in zip(ALTS, fixed.T):
        print(f"  fixed {alt:4.1f} km: {col.sum():4.0f}   agent ahead in {(agent > col).sum()}, "
              f"tied {(agent == col).sum()}, behind {(agent < col).sum()}")
    print(f"average fixed altitude: {fixed.sum(0).mean():.0f}")
    print(f"best fixed altitude per world, picked in hindsight: {fixed.max(1).sum():.0f}")


if __name__ == "__main__":
    main()
