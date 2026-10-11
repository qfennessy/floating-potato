"""Build sim/data/venus_features.json from the USGS Gazetteer of Planetary Nomenclature.

Source (public domain): https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/VENUS_nomenclature_center_pts.zip
Unzip it, then:  uv run --with pyshp python sim/build_targets.py <unzipped folder>

Picks the 60 largest named science sites and the 70 largest named mountains (eruption sources),
always keeping the original hand-picked six sites and seven volcanoes.
"""
import glob
import json
import sys
from pathlib import Path

import shapefile

SITE_TYPES = ("Regio", "Terra", "Mons", "Corona", "Tessera", "Planum", "Patera", "Fluctus")
KEEP_SITES = ["Maat Mons", "Ovda Regio", "Alpha Regio", "Maxwell Montes", "Beta Regio", "Idunn Mons"]
KEEP_VOLCANOES = ["Maat Mons", "Sapas Mons", "Ozza Mons", "Theia Mons", "Gula Mons", "Sif Mons", "Idunn Mons"]
N_SITES, N_VOLCANOES = 60, 70


def main(folder):
    shp = glob.glob(f"{folder}/**/*.shp", recursive=True)[0]
    rows = [r.as_dict() for r in shapefile.Reader(shp).records()]
    feat = {r["clean_name"]: {"lat": round(r["center_lat"], 2), "lon": round(r["center_lon"] % 360, 2),
                              "diameter_km": round(r["diameter"], 1), "type": r["type"].split(",")[0]}
            for r in rows if r.get("approval", "").startswith("Adopted")}
    def pick(names_first, pool, n):
        out = [k for k in names_first if k in feat]
        for k in sorted(pool, key=lambda k: -feat[k]["diameter_km"]):
            if len(out) >= n:
                break
            if k not in out:
                out.append(k)
        return out
    sites = pick(KEEP_SITES, [k for k, v in feat.items() if v["type"] in SITE_TYPES], N_SITES)
    volcanoes = pick(KEEP_VOLCANOES, [k for k, v in feat.items() if v["type"] == "Mons"], N_VOLCANOES)
    missing = [k for k in KEEP_SITES + KEEP_VOLCANOES if k not in feat]
    out = {"source": "USGS Gazetteer of Planetary Nomenclature (IAU), public domain",
           "sites": {k: feat[k] for k in sites}, "volcanoes": {k: feat[k] for k in volcanoes}}
    Path(__file__).with_name("data").joinpath("venus_features.json").write_text(json.dumps(out, indent=1))
    print(f"{len(sites)} sites, {len(volcanoes)} volcanoes; missing keepers: {missing}")


if __name__ == "__main__":
    main(sys.argv[1])
