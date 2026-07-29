#!/usr/bin/env python3
"""
Produit les donnees statiques de Flamap pour la France metropolitaine.

Le navigateur ne charge d'abord qu'un apercu national leger :
  - foyers FIRMS agreges spatialement et par heure ;
  - perimetres EFFIS des sept derniers jours ;
  - vent national grossier ;
  - frise et manifest.

Les detections detaillees, la saison EFFIS, le NRT et le vent fin sont repartis
dans des cellules de 1 degre chargees seulement lorsque la carte zoome.

Usage :
    python3 fetch_fires.py
    python3 fetch_fires.py west south east north
"""

import csv
import hashlib
import io
import json
import math
import os
import shutil
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data")
ZONES_OUT = os.path.join(OUT, "zones")

# France metropolitaine et Corse. La bbox assume volontairement une petite
# couronne etrangere : elle evite les coupures sur les frontieres et en mer.
DEFAULT_BBOX = (-5.5, 41.0, 10.0, 51.5)
TILE_DEG = 1.0
DETAIL_ZOOM = 7
OVERVIEW_DEG = 0.25
OVERVIEW_H = 1
RECENT_DAYS = 7

FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"
FIRMS_FEEDS = [
    ("VIIRS/NOAA-20", f"{FIRMS_BASE}/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_7d.csv"),
    ("VIIRS/NOAA-21", f"{FIRMS_BASE}/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_7d.csv"),
    ("VIIRS/S-NPP", f"{FIRMS_BASE}/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_7d.csv"),
    ("MODIS", f"{FIRMS_BASE}/modis-c6.1/csv/MODIS_C6_1_Europe_7d.csv"),
]

EFFIS_WFS = "https://maps.effis.emergency.copernicus.eu/effis"

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
WIND_MODEL = "meteofrance_arome_france_hd"
WIND_PAST_DAYS = 7
WIND_SPACING_KM = 20
WIND_BATCH = 250
WIND_MARGIN_KM = 60
WIND_DETAIL_STRIDE = 3
WIND_COARSE_N = 15
FIRMS_FINE_MIN = 50
FIRMS_TIMEOUT = 60
FIRMS_ATTEMPTS = 2
WIND_REQUEST_PAUSE = 6
# EX_TEMPFAIL : le workflow reconnaît ce cas externe et conserve le site actif.
TEMPORARY_SOURCE_FAILURE = 75

EMPTY_FC = {"type": "FeatureCollection", "features": []}


def get(url, timeout=300):
    req = urllib.request.Request(url, headers={"User-Agent": "flamap/0.2"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def write_json(path, data, compact=True):
    with open(path, "w", encoding="utf-8") as output:
        json.dump(
            data,
            output,
            ensure_ascii=False,
            separators=(",", ":") if compact else None,
            indent=None if compact else 2,
        )


def fc(features):
    return {"type": "FeatureCollection", "features": features}


# ---------------------------------------------------------------------------
# FIRMS
# ---------------------------------------------------------------------------

def download_firms_feed(label, url):
    for attempt in range(FIRMS_ATTEMPTS):
        try:
            return get(url, timeout=FIRMS_TIMEOUT).decode("utf-8"), None
        except Exception as error:
            if attempt == FIRMS_ATTEMPTS - 1:
                return None, error
            print(f"  ! {label} indisponible, nouvel essai dans 5 s",
                  file=sys.stderr)
            time.sleep(5)


def fetch_hotspots(bbox):
    west, south, east, north = bbox
    features = []

    # Les quatre fichiers sont indépendants. Les télécharger ensemble réduit
    # surtout le coût d'un incident réseau du runner : les timeouts ne
    # s'additionnent plus pendant huit minutes avant d'annuler l'export.
    with ThreadPoolExecutor(max_workers=len(FIRMS_FEEDS)) as executor:
        downloads = list(executor.map(
            lambda feed: download_firms_feed(*feed),
            FIRMS_FEEDS,
        ))

    if not any(raw is not None for raw, _ in downloads):
        for (label, _), (_, error) in zip(FIRMS_FEEDS, downloads):
            print(f"  ! {label} : {error}", file=sys.stderr)
        print("tous les flux FIRMS sont indisponibles : mise à jour reportée",
              file=sys.stderr)
        raise SystemExit(TEMPORARY_SOURCE_FAILURE)

    for (label, _), (raw, error) in zip(FIRMS_FEEDS, downloads):
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


def aggregate_hotspots(hotspots):
    """Une feature par cellule de 0,25 degre, heure et satellite."""
    groups = {}
    seconds = OVERVIEW_H * 3600
    for feature in hotspots["features"]:
        lon, lat = feature["geometry"]["coordinates"]
        prop = feature["properties"]
        key = (
            math.floor(lon / OVERVIEW_DEG),
            math.floor(lat / OVERVIEW_DEG),
            prop["ts"] // seconds,
            prop["source"],
        )
        if key not in groups:
            groups[key] = {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [
                        round((key[0] + 0.5) * OVERVIEW_DEG, 4),
                        round((key[1] + 0.5) * OVERVIEW_DEG, 4),
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


def build_timeline(hotspots, dated):
    """Passages nationaux exacts, independants des donnees detaillees chargees."""
    steps = []
    current_by_source = {}
    gap = 25 * 60
    for feature in hotspots["features"]:
        prop = feature["properties"]
        current = current_by_source.get(prop["source"])
        if (
            current
            and prop["ts"] - current["last"] <= gap
        ):
            current["n"] += 1
            current["frp"] += prop["frp"]
            current["last"] = prop["ts"]
            continue
        current = {
            "ts": prop["ts"],
            "last": prop["ts"],
            "kind": "sat",
            "label": prop["source"],
            "n": 1,
            "frp": prop["frp"],
        }
        current_by_source[prop["source"]] = current
        steps.append(current)

    first = steps[0]["ts"] if steps else 0
    # Une publication EFFIS peut mettre a jour plusieurs perimetres. Les
    # regrouper donne a la frise, et au journal d'information, une mesure utile
    # de chaque reponse du service plutot qu'une simple date repetitive.
    effis_updates = {}
    for feature in dated["features"]:
        prop = feature["properties"]
        stamp = prop.get("lu")
        if not stamp or stamp < first:
            continue
        update = effis_updates.setdefault(stamp, {"n": 0, "ha": 0})
        update["n"] += 1
        try:
            update["ha"] += float(prop.get("AREA_HA") or 0)
        except (TypeError, ValueError):
            pass
    for stamp, update in effis_updates.items():
        steps.append({"ts": stamp, "kind": "effis", "label": "EFFIS",
                      "n": update["n"], "ha": round(update["ha"], 1)})

    for step in steps:
        step.pop("last", None)
        if step["kind"] == "sat":
            step["frp"] = round(step["frp"], 2)
    return sorted(steps, key=lambda step: step["ts"])


# ---------------------------------------------------------------------------
# EFFIS
# ---------------------------------------------------------------------------

def effis_wfs(typename, bbox, timeout=300):
    west, south, east, north = bbox
    url = (
        f"{EFFIS_WFS}?service=WFS&version=1.0.0&request=GetFeature"
        f"&typename=ms:{typename}&outputformat=geojson"
        f"&bbox={west},{south},{east},{north}"
    )
    for attempt in range(3):
        try:
            return json.loads(get(url, timeout=timeout))
        except Exception:
            if attempt == 2:
                raise
            delay = 4 * (attempt + 1)
            print(f"  ! EFFIS {typename} indisponible, nouvel essai dans {delay} s",
                  file=sys.stderr)
            time.sleep(delay)


def to_epoch(value):
    if not value:
        return None
    try:
        return int(
            datetime.fromisoformat(str(value).replace(" ", "T"))
            .replace(tzinfo=timezone.utc)
            .timestamp()
        )
    except ValueError:
        return None


def swap_axes(geometry):
    """EFFIS emet [lat, lon], y compris dans des GeometryCollection."""
    def walk(coords):
        if isinstance(coords[0], (int, float)):
            return [coords[1], coords[0]]
        return [walk(child) for child in coords]

    if "coordinates" in geometry:
        geometry["coordinates"] = walk(geometry["coordinates"])
    for child in geometry.get("geometries", []):
        swap_axes(child)
    return geometry


def stable_feature_id(feature, prefix):
    value = feature.get("properties", {}).get("id")
    if value in (None, ""):
        raw = json.dumps(
            feature["geometry"], sort_keys=True, separators=(",", ":")
        ).encode()
        value = hashlib.sha1(raw).hexdigest()[:16]
    return f"{prefix}-{value}"


def fetch_burnt(bbox):
    dated = effis_wfs("modis.ba.poly.season", bbox)
    kept = []
    for feature in dated["features"]:
        # La couche datee fournit le pays : ne pas envoyer au navigateur les
        # milliers de polygones espagnols et italiens pris dans la grande bbox.
        if feature["properties"].get("COUNTRY") != "FR":
            continue
        swap_axes(feature["geometry"])
        prop = feature["properties"]
        prop["ts"] = to_epoch(prop.get("FIREDATE"))
        prop["lu"] = to_epoch(prop.get("LASTUPDATE")) or prop["ts"]
        prop["_id"] = stable_feature_id(feature, "d")
        kept.append(feature)
    dated["features"] = sorted(
        kept, key=lambda feature: feature["properties"].get("FIREDATE") or ""
    )
    print(f"  EFFIS dates France : {len(kept)} polygones")

    try:
        nrt = effis_wfs("effis.nrt.ba.poly", bbox)
    except Exception as error:
        # Cette couche est un complément sans attribut, qui contient aussi
        # d'anciennes cicatrices et ne participe ni à la frise ni au cadrage.
        # La perdre ponctuellement ne doit pas bloquer les foyers FIRMS et les
        # périmètres datés de la saison, qui restent obligatoires.
        print(f"  ! EFFIS NRT ignoré après les reprises : {error}",
              file=sys.stderr)
        nrt = fc([])
    for feature in nrt["features"]:
        swap_axes(feature["geometry"])
        feature.setdefault("properties", {})["_id"] = stable_feature_id(feature, "n")
    print(f"  EFFIS NRT bbox     : {len(nrt['features'])} polygones")
    return {"burnt_dated": dated, "burnt_nrt": nrt}


def recent_burnt(dated, reference):
    threshold = reference - RECENT_DAYS * 86400
    return fc([
        feature for feature in dated["features"]
        if (
            feature["properties"].get("CLASS") in ("Today", "7DAYS")
            or feature["properties"].get("ts", 0) >= threshold
        )
    ])


# ---------------------------------------------------------------------------
# Decoupage spatial
# ---------------------------------------------------------------------------

def geometry_points(geometry):
    def walk(coords):
        if (
            isinstance(coords, list)
            and len(coords) >= 2
            and isinstance(coords[0], (int, float))
        ):
            yield coords
        elif isinstance(coords, list):
            for child in coords:
                yield from walk(child)

    if "coordinates" in geometry:
        yield from walk(geometry["coordinates"])
    for child in geometry.get("geometries", []):
        yield from geometry_points(child)


def feature_bounds(feature):
    points = list(geometry_points(feature["geometry"]))
    lon = [point[0] for point in points]
    lat = [point[1] for point in points]
    return min(lon), min(lat), max(lon), max(lat)


def tile_id(ix, iy):
    return f"x{ix:+03d}_y{iy:+03d}"


def tile_range(bbox):
    west, south, east, north = bbox
    return [
        (ix, iy)
        for iy in range(math.floor(south), math.floor(math.nextafter(north, -math.inf)) + 1)
        for ix in range(math.floor(west), math.floor(math.nextafter(east, -math.inf)) + 1)
    ]


def feature_tiles(feature):
    west, south, east, north = feature_bounds(feature)
    return [
        (ix, iy)
        for iy in range(math.floor(south), math.floor(math.nextafter(north, -math.inf)) + 1)
        for ix in range(math.floor(west), math.floor(math.nextafter(east, -math.inf)) + 1)
    ]


def partition_features(features, point=False):
    cells = {}
    for feature in features:
        if point:
            lon, lat = feature["geometry"]["coordinates"]
            keys = [(math.floor(lon), math.floor(lat))]
        else:
            keys = feature_tiles(feature)
        for key in keys:
            cells.setdefault(key, []).append(feature)
    return cells


# ---------------------------------------------------------------------------
# Vent
# ---------------------------------------------------------------------------

def wind_box(bbox):
    west, south, east, north = bbox
    mid = math.radians((south + north) / 2)
    dy = WIND_MARGIN_KM / 111.0
    dx = WIND_MARGIN_KM / (111.0 * math.cos(mid))
    return west - dx, south - dy, east + dx, north + dy


def wind_grid(box, spacing_km):
    west, south, east, north = box
    mid = math.radians((south + north) / 2)
    nx = max(2, round((east - west) * 111 * math.cos(mid) / spacing_km) + 1)
    ny = max(2, round((north - south) * 111 / spacing_km) + 1)
    points = [
        (
            round(south + (north - south) * iy / (ny - 1), 4),
            round(west + (east - west) * ix / (nx - 1), 4),
        )
        for iy in range(ny)
        for ix in range(nx)
    ]
    return nx, ny, points


def wind_request(points, model, temperature=False):
    lat = ",".join(str(point[0]) for point in points)
    lon = ",".join(str(point[1]) for point in points)
    variables = "wind_speed_10m,wind_direction_10m,wind_gusts_10m"
    if temperature:
        variables += ",temperature_2m,precipitation"
    url = (
        f"{OPEN_METEO}?latitude={lat}&longitude={lon}"
        f"&hourly={variables}"
        f"&past_days={WIND_PAST_DAYS}&forecast_days=2"
        "&wind_speed_unit=ms&timezone=UTC"
    )
    if model:
        url += f"&models={model}"
    for attempt in range(4):
        try:
            data = json.loads(get(url, timeout=180))
            return data if isinstance(data, list) else [data]
        except Exception as error:
            if getattr(error, "code", None) != 429 or attempt == 3:
                raise
            delay = (10, 30, 60)[attempt]
            print(f"  ! Open-Meteo limite le debit, nouvel essai dans {delay} s",
                  file=sys.stderr)
            time.sleep(delay)


def request_wind_batches(points, model, temperature=False):
    batches = [
        points[index:index + WIND_BATCH]
        for index in range(0, len(points), WIND_BATCH)
    ]
    print(f"  {len(batches)} lots de {WIND_BATCH} points au plus")
    chunks = []
    for batch in batches:
        chunks.append(wind_request(batch, model, temperature))
        # Les runners GitHub partagent leurs IP avec beaucoup de jobs. Espacer
        # franchement les requêtes évite qu'une série de grilles fines soit
        # prise pour une rafale, même loin du quota journalier.
        time.sleep(WIND_REQUEST_PAUSE)
    return [series for chunk in chunks for series in chunk]


def fetch_wind(box, spacing_km, label, temperature=False):
    nx, ny, points = wind_grid(box, spacing_km)
    dx = (box[2] - box[0]) * 111 * math.cos(math.radians((box[1] + box[3]) / 2))
    print(f"  {label} {nx}x{ny} = {len(points)} points, pas ~{dx / (nx - 1):.0f} km")

    series = request_wind_batches(points, WIND_MODEL, temperature)
    holes = sum(
        value is None
        for location in series
        for value in location["hourly"]["wind_speed_10m"]
    )
    total = sum(len(location["hourly"]["wind_speed_10m"]) for location in series)
    model = WIND_MODEL
    if holes > total * 0.2:
        print(
            f"  ! AROME HD : {holes}/{total} valeurs manquantes, bascule best_match",
            file=sys.stderr,
        )
        series = request_wind_batches(points, None, temperature)
        model = "best_match"

    times = series[0]["hourly"]["time"]
    timestamps = [
        int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp())
        for value in times
    ]
    now = datetime.now(timezone.utc).timestamp()
    keep = [index for index, stamp in enumerate(timestamps) if stamp <= now + 24 * 3600]
    timestamps = [timestamps[index] for index in keep]

    u = [[0.0] * len(points) for _ in timestamps]
    v = [[0.0] * len(points) for _ in timestamps]
    gust = [[0] * len(points) for _ in timestamps]
    temp = [[None] * len(points) for _ in timestamps] if temperature else None
    precipitation = [[None] * len(points) for _ in timestamps] if temperature else None
    for column, location in enumerate(series):
        hourly = location["hourly"]
        for row, index in enumerate(keep):
            if temperature:
                value = hourly["temperature_2m"][index]
                temp[row][column] = round(value, 1) if value is not None else None
                value = hourly["precipitation"][index]
                precipitation[row][column] = (
                    round(value, 2) if value is not None else None
                )
            speed = hourly["wind_speed_10m"][index]
            direction = hourly["wind_direction_10m"][index]
            if speed is None or direction is None:
                continue
            angle = math.radians(direction)
            u[row][column] = round(-speed * math.sin(angle), 1)
            v[row][column] = round(-speed * math.cos(angle), 1)
            value = hourly["wind_gusts_10m"][index]
            gust[row][column] = round(value * 3.6) if value is not None else 0

    print(f"  {len(timestamps)} heures, modele {model}")
    result = {
        "model": model,
        "box": box,
        "nx": nx,
        "ny": ny,
        "t0": timestamps[0],
        "dt": 3600,
        "u": u,
        "v": v,
        "gust": gust,
    }
    if temperature:
        result["temperature"] = temp
        result["precipitation"] = precipitation
    return result


def wind_subset(wind, xs, ys, time_stride=1):
    indices = [iy * wind["nx"] + ix for iy in ys for ix in xs]
    rows = range(0, len(wind["u"]), time_stride)
    x0, x1 = xs[0], xs[-1]
    y0, y1 = ys[0], ys[-1]
    box = wind["box"]
    dx = (box[2] - box[0]) / (wind["nx"] - 1)
    dy = (box[3] - box[1]) / (wind["ny"] - 1)
    result = {
        "model": wind["model"],
        "unit": "m/s",
        "bbox": [
            round(box[0] + x0 * dx, 4),
            round(box[1] + y0 * dy, 4),
            round(box[0] + x1 * dx, 4),
            round(box[1] + y1 * dy, 4),
        ],
        "nx": len(xs),
        "ny": len(ys),
        "t0": wind["t0"],
        "dt": wind["dt"] * time_stride,
        "nt": len(list(rows)),
        "u": [[wind["u"][row][index] for index in indices] for row in rows],
        "v": [[wind["v"][row][index] for index in indices] for row in rows],
        "gust": [[wind["gust"][row][index] for index in indices] for row in rows],
    }
    if "temperature" in wind:
        result["temperature"] = [
            [wind["temperature"][row][index] for index in indices]
            for row in rows
        ]
    return result


def whole_wind(wind, time_stride=1):
    return wind_subset(
        wind,
        list(range(wind["nx"])),
        list(range(wind["ny"])),
        time_stride,
    )


def weather_forecast(wind, now, hours=12):
    """Extrait 12 h passees et 12 h futures pour le volet meteo."""
    pivot = next(
        (index for index in range(len(wind["u"]))
         if wind["t0"] + index * wind["dt"] >= now),
        len(wind["u"]),
    )
    start = max(0, pivot - hours)
    stop = min(pivot + hours + 1, len(wind["u"]))
    rows = range(start, stop)
    return {
        "model": wind["model"],
        "bbox": [round(value, 4) for value in wind["box"]],
        "nx": wind["nx"],
        "ny": wind["ny"],
        "t0": wind["t0"] + start * wind["dt"],
        "dt": wind["dt"],
        "nt": stop - start,
        "u": [wind["u"][row] for row in rows],
        "v": [wind["v"][row] for row in rows],
        "gust": [wind["gust"][row] for row in rows],
        "temperature": [wind["temperature"][row] for row in rows],
        "precipitation": [wind["precipitation"][row] for row in rows],
    }


def fine_wind_tiles(recent, hotspots, latest):
    """Cellules avec feu confirme EFFIS ou rafale FIRMS recente significative."""
    keys = set()
    for feature in recent["features"]:
        keys.update(feature_tiles(feature))

    counts = {}
    threshold = latest - 24 * 3600
    for feature in hotspots["features"]:
        if feature["properties"]["ts"] < threshold:
            continue
        lon, lat = feature["geometry"]["coordinates"]
        key = math.floor(lon), math.floor(lat)
        counts[key] = counts.get(key, 0) + 1
    keys.update(key for key, count in counts.items() if count >= FIRMS_FINE_MIN)
    return keys


# ---------------------------------------------------------------------------
# Assemblage
# ---------------------------------------------------------------------------

def main():
    bbox = DEFAULT_BBOX
    if len(sys.argv) == 5:
        bbox = tuple(float(value) for value in sys.argv[1:5])
    elif len(sys.argv) != 1:
        raise SystemExit("usage: fetch_fires.py [west south east north]")

    os.makedirs(OUT, exist_ok=True)
    print(f"bbox {bbox}\n")

    print("NASA FIRMS - foyers actifs")
    hotspots = fetch_hotspots(bbox)
    if not hotspots["features"]:
        raise SystemExit("aucun foyer FIRMS : export annule")
    latest = hotspots["features"][-1]["properties"]["ts"]

    print("\nCopernicus EFFIS - surfaces brulees")
    burnt = fetch_burnt(bbox)
    recent = recent_burnt(burnt["burnt_dated"], latest)

    print("\nOpen-Meteo / AROME HD - vent a 10 m")
    coarse_box = wind_box(bbox)
    coarse_span = (
        (coarse_box[2] - coarse_box[0])
        * 111
        * math.cos(math.radians((coarse_box[1] + coarse_box[3]) / 2))
    )
    coarse_spacing = coarse_span / (WIND_COARSE_N - 1)
    coarse_wind = fetch_wind(
        coarse_box, coarse_spacing, "grille nationale", temperature=True
    )

    fine_keys = fine_wind_tiles(recent, hotspots, latest)
    fine_wind = {}
    print(f"  {len(fine_keys)} cellules avec vent fin")
    for ix, iy in sorted(fine_keys):
        # La grille dépasse la cellule active de 60 km. Le navigateur fond
        # ensuite cette marge dans le champ national : sans débord, la rupture
        # de résolution dessinerait un carré net dans les particules.
        fine_box = wind_box((ix, iy, ix + TILE_DEG, iy + TILE_DEG))
        name = tile_id(ix, iy)
        try:
            raw = fetch_wind(
                fine_box,
                WIND_SPACING_KM,
                f"    {name}",
            )
        except Exception as error:
            # Le champ national grossier reste disponible partout : une maille
            # fine est un enrichissement, pas une raison de bloquer la mise à
            # jour des foyers et périmètres pendant plusieurs heures. Après un
            # épuisement des reprises, les cellules suivantes rencontreraient
            # vraisemblablement la même limite : on arrête proprement la série.
            print(f"  ! {name} : fin du vent fin ({error})", file=sys.stderr)
            break
        fine_wind[(ix, iy)] = whole_wind(raw, WIND_DETAIL_STRIDE)

    print("\nDecoupage")
    hotspot_cells = partition_features(hotspots["features"], point=True)
    dated_cells = partition_features(burnt["burnt_dated"]["features"])
    nrt_cells = partition_features(burnt["burnt_nrt"]["features"])
    cells = tile_range(bbox)

    if os.path.isdir(ZONES_OUT):
        shutil.rmtree(ZONES_OUT)
    os.makedirs(ZONES_OUT)

    zone_ids = []
    for ix, iy in cells:
        name = tile_id(ix, iy)
        zone_ids.append(name)
        payload = {
            "id": name,
            "bbox": [ix, iy, ix + TILE_DEG, iy + TILE_DEG],
            "hotspots": fc(hotspot_cells.get((ix, iy), [])),
            "burnt_dated": fc(dated_cells.get((ix, iy), [])),
            "burnt_nrt": fc(nrt_cells.get((ix, iy), [])),
            "wind": fine_wind.get((ix, iy)),
        }
        write_json(os.path.join(ZONES_OUT, f"{name}.json"), payload)

    generated = datetime.now(timezone.utc).isoformat()
    timeline = build_timeline(hotspots, burnt["burnt_dated"])
    overview = aggregate_hotspots(hotspots)
    coarse = whole_wind(coarse_wind)
    now = datetime.now(timezone.utc).timestamp()
    weather = weather_forecast(coarse_wind, now)
    manifest = {
        "version": 1,
        "generated_at": generated,
        "bbox": list(bbox),
        "tile_deg": TILE_DEG,
        "detail_zoom": DETAIL_ZOOM,
        "zone_template": "data/zones/{id}.json",
        "zones": zone_ids,
        "hotspot_count": len(hotspots["features"]),
        "overview_count": len(overview["features"]),
        "dated_count": len(burnt["burnt_dated"]["features"]),
        "nrt_count": len(burnt["burnt_nrt"]["features"]),
        "fine_wind_zones": [tile_id(*key) for key in sorted(fine_wind)],
        "wind_model": coarse_wind["model"],
    }

    write_json(os.path.join(OUT, "overview_hotspots.geojson"), overview)
    write_json(os.path.join(OUT, "burnt_recent.geojson"), recent)
    write_json(os.path.join(OUT, "timeline.json"), timeline)
    write_json(os.path.join(OUT, "wind_coarse.json"), coarse)
    write_json(os.path.join(OUT, "weather_forecast.json"), weather)
    write_json(os.path.join(OUT, "manifest.json"), manifest, compact=False)

    print(
        f"  {len(zone_ids)} zones, {len(overview['features'])} foyers agreges, "
        f"{len(recent['features'])} perimetres recents"
    )
    print(f"\n-> {len(hotspots['features'])} detections detaillees")
    print(f"-> ecrit dans {OUT}/ (donnees generees non versionnees)")


if __name__ == "__main__":
    main()
