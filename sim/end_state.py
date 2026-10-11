"""End-of-mission state of each balloon in a world file: health, ballast and gas left at the
finish (day `days`), when it was lost (if it was), hours spent outside the safe 50-62 km band,
and how many check-ins chose to sprint. Used for the website's table."""


def end_state(run, days):
    b = run.get("budget") or []
    if not b:
        return None
    ballast, gas, health = b[min(len(b) - 1, int(days * 24))]          # budget is sampled hourly
    track = run["track"]
    risky_h = sum(1 for p in track[1:] if not (50.0 <= p[2] <= 62.0)) * 0.25
    sprints = sum(1 for l in run["log"] if l["kind"] == "strategy" and l.get("sprint"))
    return {"h": round(health, 3), "b": round(ballast, 1), "g": round(gas, 1), "lost_h": run.get("lost_h"),
            "risky_h": round(risky_h), "sprints": sprints}
