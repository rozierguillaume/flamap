#!/usr/bin/env python3
"""
Recupere les donnees incendie quasi temps reel pour une bbox donnee.

Trois sources, complementaires :

  1. NASA FIRMS - foyers actifs (points de detection thermique)
     Flux CSV publics, sans cle API, remis a jour ~toutes les 3h.
     VIIRS 375 m (NOAA-20, NOAA-21, Suomi-NPP) + MODIS 1 km.
     -> data/hotspots.geojson

  2. Copernicus EFFIS - surfaces brulees (polygones)
     WFS MapServer, mis a jour ~1-2x/jour.
     - modis.ba.poly.season : polygones dates (FIREDATE, AREA_HA, COMMUNE...)
     - effis.nrt.ba.poly    : version NRT, plus fraiche mais sans attributs
     -> data/burnt_dated.geojson, data/burnt_nrt.geojson

  3. Open-Meteo / Meteo-France AROME HD - vent a 10 m
     JSON public, sans cle. Grille reguliere debordant la bbox, 7 jours
     passes et 24 h a venir, au pas horaire.
     -> data/wind.json

Usage:
    python3 fetch_fires.py                  # bbox Gironde par defaut
    python3 fetch_fires.py -1.6 44.3 -0.2 45.4
"""

import csv
import io
import json
import math
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

# Vent : Open-Meteo sert le modele AROME HD de Meteo-France (maille 1,5 km sur
# la France) en JSON, sans cle. Une seule requete accepte plusieurs centaines de
# points : on y demande toute la grille d'un coup.
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
WIND_MODEL = "meteofrance_arome_france_hd"
WIND_PAST_DAYS = 7      # meme profondeur que les flux FIRMS, donc que la frise
WIND_SPACING_KM = 10    # pas vise de la grille
WIND_MAX_POINTS = 260   # au-dela, l'URL et le fichier deviennent deraisonnables
# La grille deborde largement la bbox : sur un ecran large, la carte cadree sur
# le feu montre bien plus de terrain que la zone d'interet, et le vent
# s'arreterait net sur les bords. Le pas s'elargit tout seul pour tenir dans le
# budget de points — une nappe un peu plus lissee vaut mieux qu'un trou.
WIND_MARGIN_KM = 60


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


# --------------------------------------------------------------------------
# 3. Vent a 10 m (Open-Meteo / AROME HD)
# --------------------------------------------------------------------------

def wind_box(bbox):
    """La bbox elargie de WIND_MARGIN_KM sur chaque bord."""
    west, south, east, north = bbox
    mid = math.radians((south + north) / 2)
    dy = WIND_MARGIN_KM / 111.0
    dx = WIND_MARGIN_KM / (111.0 * math.cos(mid))
    return (max(west - dx, -180), max(south - dy, -85),
            min(east + dx, 180), min(north + dy, 85))


def wind_grid(box):
    """Points de la grille, en ordre ligne par ligne du sud au nord."""
    west, south, east, north = box
    mid = math.radians((south + north) / 2)
    km_lat, km_lon = 111.0, 111.0 * math.cos(mid)

    def count(span_km):
        return max(2, min(40, round(span_km / WIND_SPACING_KM) + 1))

    nx = count((east - west) * km_lon)
    ny = count((north - south) * km_lat)
    # une requete unique porte toute la grille : on la degrossit tant qu'elle
    # depasse le budget, en gardant les proportions
    while nx * ny > WIND_MAX_POINTS:
        if nx >= ny:
            nx -= 1
        else:
            ny -= 1

    pts = []
    for j in range(ny):
        for i in range(nx):
            pts.append((
                round(south + (north - south) * j / (ny - 1), 4),
                round(west + (east - west) * i / (nx - 1), 4),
            ))
    return nx, ny, pts


def wind_request(pts, model):
    lat = ",".join(str(p[0]) for p in pts)
    lon = ",".join(str(p[1]) for p in pts)
    url = (
        f"{OPEN_METEO}?latitude={lat}&longitude={lon}"
        "&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m"
        f"&past_days={WIND_PAST_DAYS}&forecast_days=2"
        "&wind_speed_unit=ms&timezone=UTC"
    )
    if model:
        url += f"&models={model}"
    data = json.loads(get(url, timeout=120))
    return data if isinstance(data, list) else [data]


def fetch_wind(bbox):
    box = wind_box(bbox)
    nx, ny, pts = wind_grid(box)
    span = (box[2] - box[0]) * 111.0 * math.cos(math.radians((box[1] + box[3]) / 2))
    print(f"  grille {nx}x{ny} = {len(pts)} points, pas ~{span / (nx - 1):.0f} km")

    series = wind_request(pts, WIND_MODEL)
    holes = sum(1 for p in series for v in p["hourly"]["wind_speed_10m"] if v is None)
    total = sum(len(p["hourly"]["wind_speed_10m"]) for p in series)
    model = WIND_MODEL

    # AROME ne couvre que la France et ses abords : hors domaine, la reponse est
    # une grille de null. On retombe alors sur le modele automatique d'Open-Meteo
    # (maille plus large, couverture mondiale).
    if holes > total * 0.2:
        print(f"  ! AROME HD : {holes}/{total} valeurs manquantes, bascule sur "
              f"le modele automatique", file=sys.stderr)
        series = wind_request(pts, None)
        model = "best_match"

    times = series[0]["hourly"]["time"]
    steps = [int(datetime.fromisoformat(t).replace(tzinfo=timezone.utc).timestamp())
             for t in times]

    # 7 jours passes, mais seulement 24 h a venir : au-dela on afficherait une
    # prevision que plus rien ne vient corriger avant le prochain rafraichissement
    now = datetime.now(timezone.utc).timestamp()
    keep = [k for k, ts in enumerate(steps) if ts <= now + 24 * 3600]
    steps = [steps[k] for k in keep]

    u = [[0.0] * len(pts) for _ in steps]
    v = [[0.0] * len(pts) for _ in steps]
    gust = [[0] * len(pts) for _ in steps]

    for n, p in enumerate(series):
        h = p["hourly"]
        for row, k in enumerate(keep):
            spd, deg = h["wind_speed_10m"][k], h["wind_direction_10m"][k]
            if spd is None or deg is None:
                continue
            # direction meteo = d'ou vient le vent ; les composantes pointent
            # donc a l'oppose
            rad = math.radians(deg)
            u[row][n] = round(-spd * math.sin(rad), 1)
            v[row][n] = round(-spd * math.cos(rad), 1)
            g = h["wind_gusts_10m"][k]
            gust[row][n] = round(g * 3.6) if g is not None else 0   # km/h entiers

    fastest = max((math.hypot(a, b) for row_u, row_v in zip(u, v)
                   for a, b in zip(row_u, row_v)), default=0)
    print(f"  {len(steps)} heures, du {times[keep[0]]} au {times[keep[-1]]} UTC")
    print(f"  modele {model}, pointe a {fastest * 3.6:.0f} km/h")

    return {
        "model": model,
        "unit": "m/s",          # u, v ; les rafales sont en km/h entiers
        "bbox": [round(c, 4) for c in box],   # la bbox elargie, pas celle du feu
        "nx": nx, "ny": ny,
        "t0": steps[0], "dt": 3600, "nt": len(steps),
        "u": u, "v": v, "gust": gust,
    }


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

    # Le vent n'est qu'un habillage : s'il manque, la carte reste juste. On ne
    # fait donc pas echouer la recuperation entiere pour lui.
    print("\nOpen-Meteo / AROME HD - vent a 10 m")
    wind = None
    try:
        wind = fetch_wind(bbox)
        with open(os.path.join(OUT, "wind.json"), "w") as f:
            json.dump(wind, f, separators=(",", ":"))
    except Exception as e:
        print(f"  ! vent indisponible : {e}", file=sys.stderr)

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bbox": list(bbox),
        "hotspot_count": len(hs["features"]),
        "latest_hotspot": hs["features"][-1]["properties"]["t"] if hs["features"] else None,
        "wind_model": wind["model"] if wind else None,
    }
    with open(os.path.join(OUT, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

    print(f"\n-> {len(hs['features'])} foyers, dernier : {meta['latest_hotspot']}")
    print(f"-> ecrit dans {OUT}/")


if __name__ == "__main__":
    main()
