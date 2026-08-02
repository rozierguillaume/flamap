"""Collecte et aggregation des detections NASA FIRMS."""

import csv
import io
import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from flamap.http import get


HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "data")
ZONES_OUT = os.path.join(OUT, "zones")

OVERVIEW_DEG = 0.25
OVERVIEW_H = 1
HOTSPOT_DAYS = 10

FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"
FIRMS_FEEDS = [
    ("VIIRS/NOAA-20", f"{FIRMS_BASE}/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_7d.csv"),
    ("VIIRS/NOAA-21", f"{FIRMS_BASE}/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_7d.csv"),
    ("VIIRS/S-NPP", f"{FIRMS_BASE}/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_7d.csv"),
    ("MODIS", f"{FIRMS_BASE}/modis-c6.1/csv/MODIS_C6_1_Europe_7d.csv"),
]
FIRMS_TIMEOUT = 60
FIRMS_ATTEMPTS = 2
TEMPORARY_SOURCE_FAILURE = 75


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def download_firms_feed(label, url, *, http_get=None, timeout=None,
                        attempts=None):
    http_get = get if http_get is None else http_get
    timeout = FIRMS_TIMEOUT if timeout is None else timeout
    attempts = FIRMS_ATTEMPTS if attempts is None else attempts
    for attempt in range(attempts):
        try:
            return http_get(url, timeout=timeout).decode("utf-8"), None
        except Exception as error:
            if attempt == attempts - 1:
                return None, error
            print(f"  ! {label} indisponible, nouvel essai dans 5 s",
                  file=sys.stderr)
            time.sleep(5)


def fetch_hotspots(bbox, *, feeds=None, download=None, failure_code=None):
    feeds = FIRMS_FEEDS if feeds is None else feeds
    download = download_firms_feed if download is None else download
    failure_code = (
        TEMPORARY_SOURCE_FAILURE if failure_code is None else failure_code
    )
    west, south, east, north = bbox
    features = []

    # Les quatre fichiers sont indépendants. Les télécharger ensemble réduit
    # surtout le coût d'un incident réseau du runner : les timeouts ne
    # s'additionnent plus pendant huit minutes avant d'annuler l'export.
    with ThreadPoolExecutor(max_workers=len(feeds)) as executor:
        downloads = list(executor.map(
            lambda feed: download(*feed),
            feeds,
        ))

    if not any(raw is not None for raw, _ in downloads):
        for (label, _), (_, error) in zip(feeds, downloads):
            print(f"  ! {label} : {error}", file=sys.stderr)
        print("tous les flux FIRMS sont indisponibles : mise à jour reportée",
              file=sys.stderr)
        raise SystemExit(failure_code)

    for (label, _), (raw, error) in zip(feeds, downloads):
        if raw is None:
            print(f"  ! {label} : {error}", file=sys.stderr)
            continue

        count = 0
        for row in csv.DictReader(io.StringIO(raw)):
            lon, lat = float(row["longitude"]), float(row["latitude"])
            if not (west <= lon <= east and south <= lat <= north):
                continue

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
                    "brightness": float(
                        row.get("bright_ti4") or row.get("brightness") or 0
                    ),
                    "frp": float(row["frp"]),
                    "confidence": row["confidence"],
                    "daynight": row["daynight"],
                    "scan": float(row["scan"]),
                    "track": float(row["track"]),
                },
            })
            count += 1
        print(f"  {label}: {count} detections")

    features.sort(key=lambda feature: feature["properties"]["ts"])
    return fc(features)


def extend_hotspot_history(hotspots, bbox, *, zones_out=None,
                           hotspot_days=None):
    """Complete les 7 jours FIRMS avec l'historique du deploiement precedent."""
    zones_out = ZONES_OUT if zones_out is None else zones_out
    hotspot_days = HOTSPOT_DAYS if hotspot_days is None else hotspot_days
    if not os.path.isdir(zones_out) or not hotspots["features"]:
        return hotspots

    west, south, east, north = bbox
    latest = hotspots["features"][-1]["properties"]["ts"]
    cutoff = latest - hotspot_days * 86400
    keys = {
        (
            feature["properties"]["source"],
            feature["properties"]["ts"],
            *feature["geometry"]["coordinates"],
        )
        for feature in hotspots["features"]
    }
    kept = 0
    for name in os.listdir(zones_out):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(zones_out, name), encoding="utf-8") as source:
                previous = json.load(source)
        except (OSError, ValueError):
            continue
        for feature in previous.get("hotspots", {}).get("features", []):
            prop = feature.get("properties", {})
            coordinates = feature.get("geometry", {}).get("coordinates", [])
            if len(coordinates) < 2:
                continue
            lon, lat = coordinates[:2]
            ts = prop.get("ts", 0)
            key = (prop.get("source"), ts, lon, lat)
            if (
                cutoff <= ts <= latest
                and west <= lon <= east
                and south <= lat <= north
                and key not in keys
            ):
                hotspots["features"].append(feature)
                keys.add(key)
                kept += 1

    hotspots["features"].sort(key=lambda feature: feature["properties"]["ts"])
    if kept:
        print(
            f"  historique conserve : {kept} detections "
            f"(fenetre de {hotspot_days} jours)"
        )
    return hotspots


def aggregate_hotspots(hotspots, *, overview_deg=None, overview_h=None):
    """Une feature par cellule de 0,25 degre, heure et satellite."""
    overview_deg = OVERVIEW_DEG if overview_deg is None else overview_deg
    overview_h = OVERVIEW_H if overview_h is None else overview_h
    groups = {}
    seconds = overview_h * 3600
    for feature in hotspots["features"]:
        lon, lat = feature["geometry"]["coordinates"]
        prop = feature["properties"]
        key = (
            math.floor(lon / overview_deg),
            math.floor(lat / overview_deg),
            prop["ts"] // seconds,
            prop["source"],
        )
        if key not in groups:
            groups[key] = {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [
                        round((key[0] + 0.5) * overview_deg, 4),
                        round((key[1] + 0.5) * overview_deg, 4),
                    ],
                },
                "properties": {
                    "ts": key[2] * seconds,
                    "source": prop["source"],
                    "n": 0,
                    "frp": 0,
                    "overview": 1,
                },
            }
        groups[key]["properties"]["n"] += 1
        groups[key]["properties"]["frp"] += prop["frp"]
    for feature in groups.values():
        feature["properties"]["frp"] = round(feature["properties"]["frp"], 2)
    features = sorted(groups.values(), key=lambda feature: feature["properties"]["ts"])
    return fc(features)
