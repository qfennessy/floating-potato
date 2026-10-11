"""Science sensor events: things happen on Venus, and the balloon only learns of them
if it is close enough for one of its sensors to pick them up.

Each event becomes a temporary target worth more than a fixed site, until it fades.
The reported location is a little off from the true one, as a real sensor's would be.
"""
from dataclasses import dataclass

import numpy as np

from venus import KM_PER_DEG, gc_km

VOLCANOES = {
    "Maat Mons": (0.5, 194.6),
    "Sapas Mons": (8.5, 188.3),
    "Ozza Mons": (4.5, 201.0),
    "Theia Mons": (22.7, 281.0),
    "Gula Mons": (21.9, 359.0),
    "Sif Mons": (22.0, 352.0),
    "Idunn Mons": (-46.6, 214.5),
}

KINDS = {
    # sensor, points if reached, hours before it fades, how far away the sensor notices it,
    # how far off the reported location can be, and the line the balloon reports.
    "rumble": dict(sensor="microphone", value=2.0, life_h=72, detect_km=6000, blur_km=250,
                   text="low rumble, maybe an eruption"),
    "so2": dict(sensor="gas sniffer", value=3.0, life_h=48, detect_km=3000, blur_km=120,
                text="sulfur dioxide spike, a fresh plume"),
    "lightning": dict(sensor="radio receiver", value=1.0, life_h=12, detect_km=3000, blur_km=100,
                      text="radio crackle, possible lightning"),
}


@dataclass
class Event:
    id: str
    kind: str
    t_h: float          # when it starts, Earth hours after launch
    lat: float          # true source
    lon: float
    rep_lat: float      # where the sensor says it is
    rep_lon: float
    site: str = ""

    @property
    def spec(self):
        return KINDS[self.kind]

    @property
    def ends_h(self):
        return self.t_h + self.spec["life_h"]

    def as_target(self):
        """Planner target: aim at the reported spot, worth `value`, gone after `ends_h`."""
        return (self.rep_lat, self.rep_lon, self.spec["value"], self.ends_h)

    def label(self):
        where = f" near {self.site}" if self.site else ""
        return f"{self.spec['text']}{where}"


def generate(days=10.0, seed=1, every_h=10.0):
    """A repeatable list of events, about one every `every_h` hours."""
    rng = np.random.default_rng(seed)
    out, t, n = [], rng.uniform(2, every_h), 0
    names = list(VOLCANOES)
    while t < days * 24:
        kind = rng.choice(list(KINDS), p=[0.4, 0.35, 0.25])
        if kind == "lightning":
            lat, lon, site = rng.uniform(-35, 35), rng.uniform(0, 360), ""
        else:
            site = names[rng.integers(len(names))]
            lat, lon = VOLCANOES[site]
        blur = KINDS[kind]["blur_km"] / KM_PER_DEG
        rep_lat = float(np.clip(lat + rng.normal(0, blur / 2), -85, 85))
        rep_lon = float((lon + rng.normal(0, blur / 2) / max(np.cos(np.radians(lat)), 0.2)) % 360)
        n += 1
        out.append(Event(f"E{n}", str(kind), round(float(t), 2), float(lat), float(lon),
                         rep_lat, rep_lon, site))
        t += rng.exponential(every_h)
    return out


def detectable(ev: Event, lat, lon, hours):
    """True if the event is happening now and the balloon is within sensor range."""
    return ev.t_h <= hours < ev.ends_h and gc_km(lat, lon, ev.lat, ev.lon) <= ev.spec["detect_km"]
