#!/usr/bin/env python3
"""
Recupere les donnees incendie quasi temps reel pour une bbox donnee.

Deux sources, complementaires :

  1. NASA FIRMS - foyers actifs (points de detection thermique)
     Flux CSV publics, sans cle API, remis a jour ~toutes les 3h.
     VIIRS 375 m (NOAA-20, NOAA-21, Suomi-NPP) + MODIS 1 km.
     -> data/hotspots.geojson

  2. Copernicus EFFIS - surfaces brulees (polygones)
     WFS MapServer, mis a jour ~1-2x/jour.
     - modis.ba.poly.season : polygones dates (FIREDATE, AREA_HA, COMMUNE...)
     - effis.nrt.ba.poly    : version NRT, plus fraiche mais sans attributs
     -> data/burnt_dated.geojson, data/burnt_nrt.geojson

Usage:
    python3 fetch_fires.py                  # bbox Gironde par defaut
    python3 fetch_fires.py -1.6 44.3 -0.2 45.4
"""

import csv
import io
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data")

# bbox par defaut : Gironde / bassin d'Arcachon / nord des Landes
DEFAULT_BBOX = (-1.6, 44.2, -0.2, 45.4)  # west, south, east, north

FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"

# Flux regionaux sans cle API. "7d" = 7 derniers jours, "24h" aussi dispo.
# La zone "Europe" couvre l'Europe continentale ; voir aussi Global, Russia_Asia...
FIRMS_FEEDS = [
    ("VIIRS/NOAA-20", f"{FIRMS_BASE}/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_7d.csv"),
    ("VIIRS/NOAA-21", f"{FIRMS_BASE}/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_7d.csv"),
    ("VIIRS/S-NPP", f"{FIRMS_BASE}/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_7d.csv"),
    ("MODIS", f"{FIRMS_BASE}/modis-c6.1/csv/MODIS_C6_1_Europe_7d.csv"),
]

EFFIS_WFS = "https://maps.effis.emergency.copernicus.eu/effis"


def get(url, timeout=300):
    req = urllib.request.Request(url, headers={"User-Agent": "carte-incendie/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# --------------------------------------------------------------------------
# 1. Foyers actifs (FIRMS)
# --------------------------------------------------------------------------

def fetch_hotspots(bbox):
    west, south, east, north = bbox
    features = []

    for label, url in FIRMS_FEEDS:
        try:
            raw = get(url, timeout=120).decode("utf-8")
        except Exception as e:  # un flux peut etre temporairement indispo
            print(f"  ! {label} : {e}", file=sys.stderr)
            continue

        n = 0
        for row in csv.DictReader(io.StringIO(raw)):
            lon, lat = float(row["longitude"]), float(row["latitude"])
            if not (west <= lon <= east and south <= lat <= north):
                continue

            # acq_time est un HHMM en UTC, parfois sans zero initial
            hhmm = row["acq_time"].zfill(4)
            when = datetime.strptime(
                f"{row['acq_date']} {hhmm}", "%Y-%m-%d %H%M"
            ).replace(tzinfo=timezone.utc)

            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "source": label,
                    "t": when.isoformat(),
                    "ts": int(when.timestamp()),
                    # VIIRS: bright_ti4 / MODIS: brightness
                    "brightness": float(row.get("bright_ti4") or row.get("brightness") or 0),
                    "frp": float(row["frp"]),          # puissance radiative, MW
                    "confidence": row["confidence"],   # low/nominal/high (VIIRS) ou 0-100 (MODIS)
                    "daynight": row["daynight"],
                    # empreinte au sol du pixel, utile pour dessiner a la bonne taille
                    "scan": float(row["scan"]),
                    "track": float(row["track"]),
                },
            })
            n += 1
        print(f"  {label}: {n} detections")

    features.sort(key=lambda f: f["properties"]["ts"])
    return {"type": "FeatureCollection", "features": features}


# --------------------------------------------------------------------------
# 2. Surfaces brulees (EFFIS)
# --------------------------------------------------------------------------

def effis_wfs(typename, bbox, timeout=300):
    west, south, east, north = bbox
    url = (
        f"{EFFIS_WFS}?service=WFS&version=1.0.0&request=GetFeature"
        f"&typename=ms:{typename}&outputformat=geojson"
        f"&bbox={west},{south},{east},{north}"
    )
    return json.loads(get(url, timeout=timeout))


def to_epoch(s):
    """'2026-07-23 07:45:17.536' (UTC) -> timestamp, ou None."""
    if not s:
        return None
    try:
        return int(datetime.fromisoformat(str(s).replace(" ", "T"))
                   .replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        return None


def swap_axes(geom):
    """EFFIS renvoie du GeoJSON en [lat, lon] : on remet en [lon, lat]."""
    def walk(c):
        if isinstance(c[0], (int, float)):
            return [c[1], c[0]]
        return [walk(x) for x in c]

    geom["coordinates"] = walk(geom["coordinates"])
    return geom


def fetch_burnt(bbox):
    out = {}

    # Polygones dates : FIREDATE, FINALDATE, AREA_HA, COMMUNE, CLASS...
    # CLASS vaut Today / 7DAYS / 30DAYS / FireSeason -> exactement la
    # distinction "brule recemment" vs "brule plus tot dans la saison".
    fc = effis_wfs("modis.ba.poly.season", bbox)
    for f in fc["features"]:
        swap_axes(f["geometry"])
        p = f["properties"]
        # epochs exploitables directement par le curseur temporel :
        # 'lu' = date a laquelle EFFIS a publie/ravise ce polygone, donc le
        # moment ou la carte aurait change si on l'avait suivie en direct.
        p["ts"] = to_epoch(p.get("FIREDATE"))
        p["lu"] = to_epoch(p.get("LASTUPDATE")) or p["ts"]
    fc["features"].sort(key=lambda f: f["properties"].get("FIREDATE") or "")
    print(f"  EFFIS dates : {len(fc['features'])} polygones")
    for f in fc["features"]:
        p = f["properties"]
        print(f"    {p.get('FIREDATE','?')[:10]}  {p.get('COMMUNE','?'):<24} "
              f"{p.get('AREA_HA','?'):>8} ha  [{p.get('CLASS','?')}]")
    out["burnt_dated"] = fc

    # Produit NRT : contour plus frais (mis a jour plus souvent) mais sans
    # aucun attribut expose par le WFS - geometrie seule.
    nrt = effis_wfs("effis.nrt.ba.poly", bbox)
    for f in nrt["features"]:
        swap_axes(f["geometry"])
    print(f"  EFFIS NRT   : {len(nrt['features'])} polygones")
    out["burnt_nrt"] = nrt

    return out


def main():
    bbox = DEFAULT_BBOX
    if len(sys.argv) == 5:
        bbox = tuple(float(x) for x in sys.argv[1:5])

    os.makedirs(OUT, exist_ok=True)
    print(f"bbox {bbox}\n")

    print("NASA FIRMS - foyers actifs")
    hs = fetch_hotspots(bbox)
    with open(os.path.join(OUT, "hotspots.geojson"), "w") as f:
        json.dump(hs, f)

    print("\nCopernicus EFFIS - surfaces brulees")
    burnt = fetch_burnt(bbox)
    for name, fc in burnt.items():
        with open(os.path.join(OUT, f"{name}.geojson"), "w") as f:
            json.dump(fc, f)

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bbox": list(bbox),
        "hotspot_count": len(hs["features"]),
        "latest_hotspot": hs["features"][-1]["properties"]["t"] if hs["features"] else None,
    }
    with open(os.path.join(OUT, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

    print(f"\n-> {len(hs['features'])} foyers, dernier : {meta['latest_hotspot']}")
    print(f"-> ecrit dans {OUT}/")


if __name__ == "__main__":
    main()
