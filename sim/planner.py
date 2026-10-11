"""Search planner: picks an altitude schedule that phases the balloon onto targets.

Every SEG steps (6 h) it samples many altitude plans for the next HORIZON segments,
flies them all at once through the same physics as the sim (venus.advance), keeps the
best, refines the sampling toward them a few times (cross-entropy method), then flies
the first segment of the winner. The commander can narrow `targets` or `band`.
"""
import numpy as np

from venus import CAPTURE_KM, STEP_S, TARGETS, advance, gc_km

LEVELS = np.array([50.5, 52.0, 53.5, 55.0, 56.5, 58.0, 59.5, 61.5])
SEG = 24            # steps per plan segment (6 hours)
HORIZON = 20        # segments looked ahead (5 days, about one lap)


def score_plans(st, plans, todo):
    """Fly every plan (N x HORIZON level indices) from state `st`. Returns a score per plan."""
    n = len(plans)
    lat = np.full(n, st.lat)
    lon = np.full(n, st.lon)
    alt = np.full(n, st.alt)
    hours = st.hours
    tl = np.array([TARGETS[t] for t in todo]).reshape(-1, 2)
    got = np.zeros((n, len(todo)), bool)
    score = np.zeros(n)
    closest = np.full(n, np.inf)
    for k in range(plans.shape[1] * SEG):
        goal = LEVELS[plans[:, k // SEG]]
        lat, lon, alt, _ = advance(lat, lon, alt, hours, np.sign(np.round(goal - alt, 3)))
        hours += STEP_S / 3600
        d = gc_km(lat[:, None], lon[:, None], tl[None, :, 0], tl[None, :, 1])
        new = (d <= CAPTURE_KM) & ~got
        score += new.sum(1) * (1000.0 - k)          # every target counts; sooner is better
        got |= new
        d = np.where(got, np.inf, d)
        closest = np.minimum(closest, d.min(1) if len(todo) else np.inf)
    # Small pull toward the nearest still-unreached target, so empty horizons still steer.
    return score - np.where(np.isfinite(closest), closest, 0) / 20.0


def search_planner(n=192, iters=3, elite=16, seed=0, targets=None, band=None):
    """Return a policy(state) -> action. `targets`/`band` are the commander's knobs."""
    rng = np.random.default_rng(seed)
    allowed = np.ones(len(LEVELS), bool)
    if band:
        allowed = (LEVELS >= band[0]) & (LEVELS <= band[1])
    mem = {"plan": None, "t": -1}

    def replan(st):
        todo = [t for t in (targets or TARGETS) if t not in st.reached]
        probs = np.tile(allowed / allowed.sum(), (HORIZON, 1))
        keep = []
        if mem["plan"] is not None:                     # warm start: shift the last best plan
            keep.append(np.r_[mem["plan"][1:], mem["plan"][-1]])
        keep += [np.full(HORIZON, i) for i in np.flatnonzero(allowed)]   # every fixed altitude
        for _ in range(iters):
            samp = np.array([[rng.choice(len(LEVELS), p=p) for p in probs] for _ in range(n)])
            plans = np.vstack([np.array(keep), samp])
            s = score_plans(st, plans, todo)
            top = plans[np.argsort(s)[::-1][:elite]]
            keep = [top[0]]
            counts = np.stack([(top == i).sum(0) for i in range(len(LEVELS))], 1) + 0.5 * allowed
            probs = counts * allowed / (counts * allowed).sum(1, keepdims=True)
        mem["plan"] = top[0]

    def policy(st):
        k = int(round(st.hours * 3600 / STEP_S))
        if mem["t"] < 0 or k - mem["t"] >= SEG:
            mem["t"] = k
            replan(st)
        return int(np.sign(round(LEVELS[mem["plan"][0]] - st.alt, 3)))

    policy.plan = lambda: LEVELS[mem["plan"]]           # for the commander's log
    return policy
