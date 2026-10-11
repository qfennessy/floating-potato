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


def as_targets(targets):
    """Normalise to name -> (lat, lon, value, expires_h). Fixed sites are worth 1 and never expire."""
    out = {}
    for name, t in targets.items():
        out[name] = (t[0], t[1], t[2] if len(t) > 2 else 1.0, t[3] if len(t) > 3 else np.inf)
    return out


WATCH_KM = 1500     # "near a watch spot" for the dwell reward


def score_plans(st, plans, todo, first_hit=False, watch=None, watch_w=0.0):
    """Fly every plan (N x segments level indices) from state `st` toward `todo`
    (name -> (lat, lon, value, expires_h)). Returns a score per plan, or with
    `first_hit` the step index of each plan's first capture (inf if none).
    `watch` is an (M, 2) array of lat/lon spots; each step spent within WATCH_KM of
    one earns `watch_w` per spot in range, so the planner loiters where events cluster."""
    n = len(plans)
    lat = np.full(n, st.lat)
    lon = np.full(n, st.lon)
    alt = np.full(n, st.alt)
    hours = st.hours
    tl = np.array([t for t in todo.values()]).reshape(-1, 4)
    got = np.zeros((n, len(todo)), bool)
    score = np.zeros(n)
    hit = np.full(n, np.inf)
    closest = np.full(n, np.inf)
    for k in range(plans.shape[1] * SEG):
        goal = LEVELS[plans[:, k // SEG]]
        lat, lon, alt, _ = advance(lat, lon, alt, hours, np.sign(np.round(goal - alt, 3)))
        hours += STEP_S / 3600
        live = hours <= tl[:, 3]
        d = gc_km(lat[:, None], lon[:, None], tl[None, :, 0], tl[None, :, 1])
        new = (d <= CAPTURE_KM) & ~got & live[None, :]
        score += (new * tl[None, :, 2]).sum(1) * (1000.0 - k)   # value-weighted; sooner is better
        hit = np.where(new.any(1) & ~np.isfinite(hit), k, hit)
        got |= new
        d = np.where(got | ~live[None, :], np.inf, d)
        closest = np.minimum(closest, d.min(1) if len(todo) else np.inf)
        if watch is not None and watch_w:
            dw = gc_km(lat[:, None], lon[:, None], watch[None, :, 0], watch[None, :, 1])
            score += watch_w * (dw <= WATCH_KM).sum(1)     # near several spots = better
    if first_hit:
        return hit
    # Small pull toward the nearest still-unreached target, so empty horizons still steer.
    return score - np.where(np.isfinite(closest), closest, 0) / 20.0


def eta_hours(st, target, max_hours, n=96, seed=0):
    """Earliest capture time (hours from now) the planner can find for one target, or None."""
    rng = np.random.default_rng(seed)
    segs = max(1, int(np.ceil(max_hours * 3600 / STEP_S / SEG)))
    plans = np.vstack([np.full((len(LEVELS), segs), np.arange(len(LEVELS))[:, None]),
                       rng.integers(0, len(LEVELS), (n, segs))])
    hit = score_plans(st, plans, as_targets({"t": target}), first_hit=True).min()
    return None if not np.isfinite(hit) else (hit + 1) * STEP_S / 3600


def search_planner(n=192, iters=3, elite=16, seed=0, targets=None, band=None):
    """Return a policy(state) -> action. `targets`/`band` are the commander's knobs."""
    rng = np.random.default_rng(seed)
    allowed = np.ones(len(LEVELS), bool)
    if band:
        allowed = (LEVELS >= band[0]) & (LEVELS <= band[1])
    mem = {"plan": None, "t": -1, "targets": as_targets(targets or TARGETS), "watch": None, "watch_w": 0.0}

    def replan(st):
        todo = {k: v for k, v in mem["targets"].items() if k not in st.reached and v[3] > st.hours}
        probs = np.tile(allowed / allowed.sum(), (HORIZON, 1))
        keep = []
        if mem["plan"] is not None:                     # warm start: shift the last best plan
            keep.append(np.r_[mem["plan"][1:], mem["plan"][-1]])
        keep += [np.full(HORIZON, i) for i in np.flatnonzero(allowed)]   # every fixed altitude
        for _ in range(iters):
            samp = np.array([[rng.choice(len(LEVELS), p=p) for p in probs] for _ in range(n)])
            plans = np.vstack([np.array(keep), samp])
            s = score_plans(st, plans, todo, watch=mem["watch"], watch_w=mem["watch_w"])
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

    def set_targets(new):
        """Commander changes what the planner flies toward; replan on the next step."""
        mem["targets"] = as_targets(new)
        mem["t"] = -1

    def set_watch(spots, weight):
        """Places worth hanging around (e.g. volcanoes), and how much each step near one is worth."""
        mem["watch"] = np.array(list(spots), float).reshape(-1, 2)
        mem["watch_w"] = weight
        mem["t"] = -1

    policy.plan = lambda: LEVELS[mem["plan"]]           # for the commander's log
    policy.set_watch = set_watch
    policy.set_targets = set_targets
    return policy
