#!/usr/bin/env python3
"""
Produit les donnees statiques de Flamap pour la France metropolitaine.

Le navigateur ne charge d'abord qu'un apercu national leger :
  - foyers FIRMS agreges spatialement et par heure ;
  - perimetres EFFIS mis a jour dans les sept derniers jours ;
  - vent national grossier ;
  - frise et manifest.

Les detections detaillees, la saison EFFIS, le NRT et le vent fin sont repartis
dans des cellules de 1 degre chargees seulement lorsque la carte zoome.

Les flux FIRMS publics ne couvrent que sept jours. Le collecteur reprend donc
les detections encore valides du deploiement precedent pour porter la fenetre
d'affichage a dix jours, sans cle d'API.

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
import unicodedata
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from flamap.geo import (
    bounds_gap_km,
    feature_bounds,
    geographic_distance_km,
    geometry_points,
    point_bounds_distance_km,
    swap_axes,
)
from flamap.http import get

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
# Les contours affiches dans l'apercu national restent bornes a sept jours.
RECENT_DAYS = 7
HOTSPOT_DAYS = 10
SOCIAL_DAYS = 14

FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"
FIRMS_FEEDS = [
    ("VIIRS/NOAA-20", f"{FIRMS_BASE}/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_7d.csv"),
    ("VIIRS/NOAA-21", f"{FIRMS_BASE}/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_7d.csv"),
    ("VIIRS/S-NPP", f"{FIRMS_BASE}/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_7d.csv"),
    ("MODIS", f"{FIRMS_BASE}/modis-c6.1/csv/MODIS_C6_1_Europe_7d.csv"),
]

EFFIS_WFS = "https://maps.effis.emergency.copernicus.eu/effis"

PSFDF_API = "https://test1.evan-rngt83060.workers.dev/"
PSFDF_TIMEOUT = 30
PSFDF_MAX_AGE_DAYS = 7
# Le point PSFDF vise souvent la commune plutôt que le front. Un périmètre
# EFFIS récent situé dans cette couronne est considéré comme le même feu ; les
# morceaux distants de moins de trois kilomètres sont ensuite regroupés.
PSFDF_EFFIS_MATCH_KM = 15
PSFDF_EFFIS_CLUSTER_GAP_KM = 3
PSFDF_STATUSES = {
    "hors de controle": "Hors de contrôle",
    "en cours": "En cours",
    "fixe": "Fixé",
    "maitrise": "Maîtrisé",
    "eteint": "Éteint",
}
PARIS_TZ = ZoneInfo("Europe/Paris")

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
WIND_MODEL = "meteofrance_arome_france_hd"
WIND_PAST_DAYS = 10
WIND_SPACING_KM = 20
WIND_BATCH = 250
WIND_MARGIN_KM = 60
WIND_DETAIL_STRIDE = 3
WIND_COARSE_N = 15
# Pas de la grille de temperature, sans rapport avec celui du vent : voir
# `fetch_thermal`. Descendre a 10 km ne gagnerait qu'environ 1 °C en plaine
# pour 3,4 fois le poids du fichier et 36 lots au lieu de 10.
THERMAL_SPACING_KM = 20
THERMAL_PAST_DAYS = 1
# Le vrai plafond d'un lot est la longueur de l'URL, pas le service : 430 points
# de la grille nationale tiennent en 6 750 caracteres et repondent en moins
# d'une seconde, la ou 1 000 points renvoient un HTTP 414. La grille thermique
# tient donc en dix lots au lieu de dix-huit, et chaque aller-retour economise
# est une occasion de moins de tomber sur un bridage.
THERMAL_BATCH = 430
# Meme plafond pour le vent fin, dont les points de toutes les cellules actives
# voyagent ensemble : dix-huit cellules tiennent en six requetes. Voir
# `fetch_fine_winds`.
FINE_WIND_BATCH = 430
# Le vent fin est un enrichissement, comme la grille thermique : mieux vaut le
# champ national partout qu'une etape qui deborde et ne publie rien.
FINE_WIND_DEADLINE = 8 * 60
# Au-dela, on abandonne le champ fin et on repart sur la grille du vent. Sans ce
# plafond la collecte n'est bornee que par la chance : le 30/07/2026, cinq
# poignees de main expirees ont suffi a depasser les 25 min de l'etape et a
# emporter foyers et perimetres avec elles.
THERMAL_DEADLINE = 6 * 60
FIRMS_FINE_MIN = 50
FIRMS_TIMEOUT = 60
FIRMS_ATTEMPTS = 2
WIND_REQUEST_PAUSE = 6
# Une reponse saine arrive en moins d'une seconde. Un timeout genereux ne protege
# donc rien : il fixe le prix d'un incident. A 180 s, cinq poignees de main
# expirees coutaient 15 min de temps mort et faisaient tomber la collecte
# entiere sur son plafond de 25 min.
OPEN_METEO_TIMEOUT = 30
# EX_TEMPFAIL : le workflow reconnaît ce cas externe et conserve le site actif.
TEMPORARY_SOURCE_FAILURE = 75

EMPTY_FC = {"type": "FeatureCollection", "features": []}


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
# PSFDF — incendies suivis par l'association
# ---------------------------------------------------------------------------

def psfdf_status(value):
    """Ramène les variantes accentuées ou non aux cinq statuts affichés."""
    text = unicodedata.normalize("NFD", str(value or "").strip().lower())
    key = "".join(char for char in text if unicodedata.category(char) != "Mn")
    return PSFDF_STATUSES.get(key)


def psfdf_number(value):
    text = str(value or "").strip().replace("\u00a0", "").replace(" ", "")
    if not text:
        return None
    try:
        number = float(text.replace(",", "."))
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def psfdf_timestamp(value, now=None):
    """Convertit Date_MAJ en epoch malgré les deux ordres employés par PSFDF.

    L'API mélange actuellement le français (01/08/2026) et le format américain
    non rembourré (8/1/2026). Quand les deux lectures sont possibles, une date
    de mise à jour est nécessairement celle des deux qui est la plus proche de
    l'instant de collecte. Cette règle interprète donc aussi bien 1/8 que 8/1
    comme le 1er août lors de la collecte du 1er août.
    """
    text = " ".join(
        str(value or "").replace("\u00a0", " ").replace("à", " ").split()
    )
    if not text:
        return None

    chunks = text.split(" ", 1)
    date_bits = chunks[0].split("/")
    if len(date_bits) != 3:
        return None
    try:
        first, second, year = (int(part) for part in date_bits)
    except ValueError:
        return None

    hour = minute = second_of_minute = 0
    if len(chunks) == 2:
        try:
            time_bits = [int(part) for part in chunks[1].split(":")]
        except ValueError:
            return None
        if len(time_bits) not in (2, 3):
            return None
        hour, minute = time_bits[:2]
        if len(time_bits) == 3:
            second_of_minute = time_bits[2]

    candidates = []
    for month, day in ((second, first), (first, second)):
        try:
            candidate = datetime(
                year, month, day, hour, minute, second_of_minute,
                tzinfo=PARIS_TZ,
            )
        except ValueError:
            continue
        if candidate not in candidates:
            candidates.append(candidate)
    if not candidates:
        return None

    reference = now or datetime.now(PARIS_TZ)
    parsed = min(candidates, key=lambda candidate: abs(candidate - reference))
    return int(parsed.timestamp())


def fetch_psfdf(bbox):
    """Extrait les états PSFDF mis à jour au cours des sept derniers jours."""
    west, south, east, north = bbox
    payload = json.loads(get(PSFDF_API, timeout=PSFDF_TIMEOUT))
    if not isinstance(payload, list):
        raise ValueError("la réponse PSFDF n'est pas un tableau")

    now = datetime.now(PARIS_TZ)
    cutoff = now.timestamp() - PSFDF_MAX_AGE_DAYS * 86400
    features = []
    for row in payload:
        if not isinstance(row, dict):
            continue
        status = psfdf_status(row.get("Statut"))
        if not status:
            continue
        lon = psfdf_number(row.get("Longitude"))
        lat = psfdf_number(row.get("Latitude"))
        if (lon is None or lat is None
                or not (west <= lon <= east and south <= lat <= north)):
            continue
        updated_ts = psfdf_timestamp(row.get("Date_MAJ"), now=now)
        if updated_ts is None or updated_ts < cutoff:
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "id": str(row.get("ID") or row.get("rowNumber") or ""),
                "status": status,
                "commune": str(row.get("Commune") or "").strip(),
                "departement": str(row.get("Département") or "").strip(),
                "reported": str(row.get("Date_signalement") or "").strip(),
                "updated": str(row.get("Date_MAJ") or "").strip(),
                "updated_ts": updated_ts,
                "surface": psfdf_number(row.get("Surface")),
                "surface_type": str(row.get("Surface_Type") or "").strip(),
                "personnel": psfdf_number(row.get("Personnel")),
                "helicopteres": psfdf_number(row.get("Hélicoptère")),
                "avions": psfdf_number(row.get("Avion")),
                "canadair": psfdf_number(row.get("Canadair")),
                "dash": psfdf_number(row.get("Dash")),
                "airtractor": psfdf_number(row.get("AirTractor")),
                "hbe": psfdf_number(row.get("HBE")),
                "hbel": psfdf_number(row.get("HBEL")),
                "other_info": str(row.get("Autres_infos") or "").strip(),
            },
        })

    # Ordre stable pour faciliter le diagnostic d'un export et son diff local.
    features.sort(key=lambda feature: (
        list(PSFDF_STATUSES.values()).index(feature["properties"]["status"]),
        -(feature["properties"]["surface"] or 0),
        feature["properties"]["commune"],
    ))
    return fc(features)


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


def extend_hotspot_history(hotspots, bbox):
    """Complete les 7 jours FIRMS avec l'historique du deploiement precedent."""
    if not os.path.isdir(ZONES_OUT) or not hotspots["features"]:
        return hotspots

    west, south, east, north = bbox
    latest = hotspots["features"][-1]["properties"]["ts"]
    cutoff = latest - HOTSPOT_DAYS * 86400
    keys = {
        (
            feature["properties"]["source"],
            feature["properties"]["ts"],
            *feature["geometry"]["coordinates"],
        )
        for feature in hotspots["features"]
    }
    kept = 0
    for name in os.listdir(ZONES_OUT):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(ZONES_OUT, name), encoding="utf-8") as source:
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
            f"(fenetre de {HOTSPOT_DAYS} jours)"
        )
    return hotspots


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


def build_social_timeline(timeline):
    """Conserve quatorze jours de passages pour la carte de publication.

    La frise cartographique reste volontairement bornee a dix jours. Ce petit
    historique agrege est prolonge a chaque collecte sans conserver les lourds
    pixels FIRMS correspondants. Un passage du flux courant remplace l'ancien
    passage du meme satellite situe dans la meme fenetre orbitale.
    """
    current = [dict(step) for step in timeline if step.get("kind") == "sat"]
    if not current:
        return []
    latest = max(step["ts"] for step in current)
    cutoff = latest - SOCIAL_DAYS * 86400
    path = os.path.join(OUT, "social_timeline.json")
    previous = []
    try:
        with open(path, encoding="utf-8") as source:
            loaded = json.load(source)
        if isinstance(loaded, list):
            previous = loaded
    except (OSError, ValueError):
        pass

    gap = 25 * 60
    merged = list(current)
    current_by_source = {}
    for step in current:
        current_by_source.setdefault(step.get("label"), []).append(step["ts"])
    for step in previous:
        if (
            step.get("kind") != "sat"
            or not isinstance(step.get("ts"), (int, float))
            or step["ts"] < cutoff
            or any(abs(step["ts"] - stamp) <= gap
                   for stamp in current_by_source.get(step.get("label"), []))
        ):
            continue
        merged.append(step)
    return sorted((step for step in merged if step["ts"] >= cutoff),
                  key=lambda step: step["ts"])


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


def burnt_since(dated, reference, days):
    threshold = reference - days * 86400
    return fc([
        feature for feature in dated["features"]
        # `lu` reprend LASTUPDATE ; EFFIS peut continuer a preciser le
        # perimetre plusieurs jours apres FIREDATE. Les classes Today/7DAYS
        # decrivent l'age du feu, pas la fraicheur de ce perimetre.
        if feature["properties"].get("lu", feature["properties"].get("ts", 0)) >= threshold
    ])


# ---------------------------------------------------------------------------
# Decoupage spatial
# ---------------------------------------------------------------------------

def align_psfdf_to_effis(psfdf, recent_effis):
    """Centre et dimensionne les disques PSFDF sur les périmètres EFFIS proches.

    Le premier périmètre est le plus proche du point déclaré par l'association.
    On ne lui rattache ensuite que les morceaux voisins de ce premier groupe :
    cette croissance évite d'englober un autre incendie simplement parce qu'il
    se trouve dans la même couronne de quinze kilomètres autour de la commune.
    """
    fires = psfdf.get("features", [])
    indexed = [(feature, feature_bounds(feature))
               for feature in recent_effis.get("features", [])]
    # Attribution exclusive : deux communes proches ne doivent pas dessiner
    # deux disques identiques autour du même périmètre EFFIS.
    assigned = {index: [] for index in range(len(fires))}
    for feature, bounds in indexed:
        distances = [
            point_bounds_distance_km(fire["geometry"]["coordinates"], bounds)
            for fire in fires
        ]
        if not distances:
            continue
        nearest = min(range(len(distances)), key=distances.__getitem__)
        if distances[nearest] <= PSFDF_EFFIS_MATCH_KM:
            assigned[nearest].append((feature, bounds, distances[nearest]))

    matched_fires = 0
    for fire_index, fire in enumerate(fires):
        original = list(fire["geometry"]["coordinates"])
        candidates = assigned[fire_index]
        if not candidates:
            continue

        seed = min(candidates, key=lambda candidate: candidate[2])
        selected = [seed]
        remaining = [candidate for candidate in candidates if candidate is not seed]
        changed = True
        while changed:
            changed = False
            for candidate in remaining[:]:
                if any(bounds_gap_km(candidate[1], current[1])
                       <= PSFDF_EFFIS_CLUSTER_GAP_KM for current in selected):
                    selected.append(candidate)
                    remaining.remove(candidate)
                    changed = True

        points = [point for feature, _, _ in selected
                  for point in geometry_points(feature["geometry"])]
        west = min(point[0] for point in points)
        south = min(point[1] for point in points)
        east = max(point[0] for point in points)
        north = max(point[1] for point in points)
        center = [(west + east) / 2, (south + north) / 2]
        # Une petite marge empêche le contour coloré de tangenter le contour
        # EFFIS à cause des arrondis de projection côté navigateur.
        radius = max(geographic_distance_km(center, point) for point in points) * 1.08

        fire["geometry"]["coordinates"] = [round(value, 6) for value in center]
        fire["properties"].update({
            "original_center": original,
            "effis_radius_km": round(max(radius, .25), 2),
            "effis_matches": len(selected),
        })
        matched_fires += 1
    return matched_fires


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


def meteo_request(points, model, variables, past_days):
    lat = ",".join(str(point[0]) for point in points)
    lon = ",".join(str(point[1]) for point in points)
    url = (
        f"{OPEN_METEO}?latitude={lat}&longitude={lon}"
        f"&hourly={','.join(variables)}"
        f"&past_days={past_days}&forecast_days=2"
        "&wind_speed_unit=ms&timezone=UTC"
    )
    if model:
        url += f"&models={model}"
    for attempt in range(4):
        try:
            data = json.loads(get(url, timeout=OPEN_METEO_TIMEOUT))
            return data if isinstance(data, list) else [data]
        except Exception as error:
            if attempt == 3:
                raise
            if getattr(error, "code", None) == 429:
                delay = (10, 30, 60)[attempt]
                reason = "Open-Meteo limite le debit"
            # Une collecte demande maintenant une trentaine de requetes, dont
            # dix-huit pour la seule grille thermique. A ce volume, une coupure
            # reseau passagere — poignee de main TLS expiree, connexion coupee —
            # finit par tomber regulierement : la laisser remonter ferait
            # echouer toute la collecte pour un incident de quelques secondes.
            # `HTTPError` derive de `URLError` : une 400 sur une URL mal formee
            # doit echouer tout de suite, pas etre rejouee quatre fois.
            elif (isinstance(error, (urllib.error.URLError, TimeoutError))
                  and not isinstance(error, urllib.error.HTTPError)):
                delay = (5, 15, 30)[attempt]
                reason = f"Open-Meteo injoignable ({error})"
            else:
                raise
            print(f"  ! {reason}, nouvel essai dans {delay} s", file=sys.stderr)
            time.sleep(delay)


class DeadlineExceeded(Exception):
    """Le budget de temps d'une serie de lots est epuise.

    Porte les series deja collectees : une grille tronquee est inutilisable,
    mais un ensemble de cellules dont les premieres sont completes reste bon a
    prendre. C'est au demandeur de trancher.
    """

    def __init__(self, message, collected):
        super().__init__(message)
        self.collected = collected


def request_batches(points, model, variables, past_days, batch_size=WIND_BATCH,
                    budget=None):
    batches = [
        points[index:index + batch_size]
        for index in range(0, len(points), batch_size)
    ]
    print(f"  {len(batches)} lots de {batch_size} points au plus")
    limit = None if budget is None else time.monotonic() + budget
    chunks = []
    for number, batch in enumerate(batches, 1):
        # Le controle porte sur le lot suivant, jamais sur celui en cours : une
        # serie interrompue au milieu ne donnerait aucune grille exploitable.
        if limit is not None and time.monotonic() > limit:
            raise DeadlineExceeded(
                f"{number - 1}/{len(batches)} lots en {budget:.0f} s",
                [series for chunk in chunks for series in chunk],
            )
        chunks.append(meteo_request(batch, model, variables, past_days))
        # Les runners GitHub partagent leurs IP avec beaucoup de jobs. Espacer
        # franchement les requêtes évite qu'une série de grilles fines soit
        # prise pour une rafale, même loin du quota journalier.
        time.sleep(WIND_REQUEST_PAUSE)
    return [series for chunk in chunks for series in chunk]


def request_wind_batches(points, model, temperature=False):
    variables = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"]
    if temperature:
        variables += ["temperature_2m", "precipitation"]
    return request_batches(points, model, variables, WIND_PAST_DAYS)


def keep_recent(series):
    """Indices et horodatages retenus : tout le passe, 24 h de prevision."""
    times = series[0]["hourly"]["time"]
    timestamps = [
        int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp())
        for value in times
    ]
    now = datetime.now(timezone.utc).timestamp()
    keep = [index for index, stamp in enumerate(timestamps) if stamp <= now + 24 * 3600]
    return keep, [timestamps[index] for index in keep]


def wind_holes(series):
    holes = sum(
        value is None
        for location in series
        for value in location["hourly"]["wind_speed_10m"]
    )
    total = sum(len(location["hourly"]["wind_speed_10m"]) for location in series)
    return holes, total


def build_wind(box, nx, ny, series, model, temperature=False):
    """Convertit les series horaires d'un lot de points en grille exploitable."""
    keep, timestamps = keep_recent(series)
    count = len(series)

    u = [[0.0] * count for _ in timestamps]
    v = [[0.0] * count for _ in timestamps]
    gust = [[0] * count for _ in timestamps]
    temp = [[None] * count for _ in timestamps] if temperature else None
    precipitation = [[None] * count for _ in timestamps] if temperature else None
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


def fetch_wind(box, spacing_km, label, temperature=False):
    nx, ny, points = wind_grid(box, spacing_km)
    dx = (box[2] - box[0]) * 111 * math.cos(math.radians((box[1] + box[3]) / 2))
    print(f"  {label} {nx}x{ny} = {len(points)} points, pas ~{dx / (nx - 1):.0f} km")

    series = request_wind_batches(points, WIND_MODEL, temperature)
    holes, total = wind_holes(series)
    model = WIND_MODEL
    if holes > total * 0.2:
        print(
            f"  ! AROME HD : {holes}/{total} valeurs manquantes, bascule best_match",
            file=sys.stderr,
        )
        series = request_wind_batches(points, None, temperature)
        model = "best_match"

    result = build_wind(box, nx, ny, series, model, temperature)
    print(f"  {len(result['u'])} heures, modele {model}")
    return result


def fetch_fine_winds(boxes, spacing_km, budget=None):
    """Vent fin de plusieurs cellules, en lots partages entre les cellules.

    Le decoupage en cellules de 1° sert le navigateur, pas l'API : Open-Meteo
    accepte une liste de coordonnees quelconque, et son quota se compte par
    variables et par duree, pas par point. Une requete par cellule gaspillait
    donc dix-huit aller-retours la ou six suffisent — et c'est le rythme des
    aller-retours depuis l'IP partagee du runner qui declenche les bridages, pas
    le volume demande. Les points de toutes les cellules partent donc ensemble,
    et chaque grille est reconstruite depuis sa tranche de la reponse.
    """
    grids = {}
    points = []
    for key, box in boxes.items():
        nx, ny, cell = wind_grid(box, spacing_km)
        grids[key] = (box, nx, ny, len(points), len(cell))
        points.extend(cell)
    print(f"  {len(boxes)} cellules, {len(points)} points au total")

    variables = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"]
    model = WIND_MODEL
    try:
        series = request_batches(points, WIND_MODEL, variables, WIND_PAST_DAYS,
                                 FINE_WIND_BATCH, budget)
        holes, total = wind_holes(series)
        if holes > total * 0.2:
            print(
                f"  ! AROME HD : {holes}/{total} valeurs manquantes, "
                "bascule best_match",
                file=sys.stderr,
            )
            series = request_batches(points, None, variables, WIND_PAST_DAYS,
                                     FINE_WIND_BATCH, budget)
            model = "best_match"
    except DeadlineExceeded as error:
        # Les cellules entierement couvertes par les lots deja recus restent
        # exploitables. Les suivantes retomberont sur le champ national, comme
        # lorsqu'une cellule n'est pas encore telechargee par le navigateur.
        print(f"  ! vent fin ecourte ({error})", file=sys.stderr)
        series = error.collected

    result = {}
    for key, (box, nx, ny, start, count) in grids.items():
        if start + count > len(series):
            continue
        result[key] = build_wind(box, nx, ny, series[start:start + count], model)
    if not result:
        return {}
    hours = len(result[next(iter(result))]["u"])
    print(f"  {len(result)}/{len(boxes)} cellules, {hours} heures, modele {model}")
    return result


def fetch_thermal(box, spacing_km):
    """Grille dediee a la temperature, bien plus fine que celle du vent.

    La temperature a 2 m suit le relief : sur la grille nationale du vent, dont
    le pas atteint ~94 km, un point tombe en altitude tire toute la plaine
    voisine vers le bas — Lyon ressortait a 33 °C un jour ou AROME en prevoyait
    39. Le pas de 20 km ramene l'ecart sous le degre en plaine. Le vent, lui,
    varie assez lentement dans l'espace pour se contenter de la grille large :
    le raffiner couterait cinq fois plus de requetes sans rien corriger.

    Fenetre volontairement courte — 1 jour de passe, 2 de prevision — la ou le
    vent en garde 10 : le volet meteo n'affiche que +/-12 h, et c'est cette
    profondeur reduite qui paie les points supplementaires.
    """
    nx, ny, points = wind_grid(box, spacing_km)
    dx = (box[2] - box[0]) * 111 * math.cos(math.radians((box[1] + box[3]) / 2))
    print(f"  grille thermique {nx}x{ny} = {len(points)} points, "
          f"pas ~{dx / (nx - 1):.0f} km")

    variables = ["temperature_2m", "precipitation"]
    started = time.monotonic()

    def remaining():
        return THERMAL_DEADLINE - (time.monotonic() - started)

    series = request_batches(points, WIND_MODEL, variables, THERMAL_PAST_DAYS,
                            THERMAL_BATCH, remaining())
    holes = sum(
        value is None
        for location in series
        for value in location["hourly"]["temperature_2m"]
    )
    total = sum(len(location["hourly"]["temperature_2m"]) for location in series)
    model = WIND_MODEL
    if holes > total * 0.2:
        print(
            f"  ! AROME HD : {holes}/{total} temperatures manquantes, "
            "bascule best_match",
            file=sys.stderr,
        )
        # La reprise partage le meme budget : hors domaine AROME, mieux vaut un
        # champ large qu'une seconde serie complete payee au prix du delai.
        series = request_batches(points, None, variables, THERMAL_PAST_DAYS,
                                 THERMAL_BATCH, remaining())
        model = "best_match"

    keep, timestamps = keep_recent(series)
    temp = [[None] * len(points) for _ in timestamps]
    precipitation = [[None] * len(points) for _ in timestamps]
    for column, location in enumerate(series):
        hourly = location["hourly"]
        for row, index in enumerate(keep):
            value = hourly["temperature_2m"][index]
            temp[row][column] = round(value, 1) if value is not None else None
            value = hourly["precipitation"][index]
            precipitation[row][column] = round(value, 2) if value is not None else None

    print(f"  {len(timestamps)} heures, modele {model}")
    return {
        "model": model,
        "box": box,
        "nx": nx,
        "ny": ny,
        "t0": timestamps[0],
        "dt": 3600,
        "temperature": temp,
        "precipitation": precipitation,
    }


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
    # Temperature et pluie grossieres : repli du volet meteo et du badge quand
    # `thermal.json` manque — premier deploiement, ou workflow meteo en retard —
    # ou quand la frise remonte au-dela de la fenetre du champ fin.
    for name in ("temperature", "precipitation"):
        if name in wind:
            result[name] = [
                [wind[name][row][index] for index in indices]
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
    """Extrait 12 h passees et 12 h futures de vent pour le volet meteo.

    Ne porte que le vent. La temperature et les pluies vivent dans
    `thermal.json`, sur une grille bien plus fine et avec leur propre base de
    temps : les deux champs sont collectes par des workflows de cadences
    differentes, et le navigateur les interpole separement.
    """
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
    }


def thermal_export(thermal, now, hours=18):
    """Reduit la grille thermique a la fenetre affichee par le volet meteo.

    Volontairement plus large que les +/-12 h du vent. Les deux champs sont
    collectes par des workflows de cadences differentes — 30 min et 6 h — donc
    centres sur des instants qui peuvent differer de six heures. Soit F l'instant
    de la collecte du vent et T celui de la temperature, avec T <= F et
    F - T <= 6 h : le vent couvre [F-12, F+12], et il faut que la temperature
    aille au moins jusqu'a F+12, donc T+18 >= F+12. Le passe est acquis, T-18
    precedant toujours F-12. Sans cette marge le graphique perdait une heure des
    le premier decalage, et jusqu'a six au pire.
    """
    pivot = next(
        (index for index in range(len(thermal["temperature"]))
         if thermal["t0"] + index * thermal["dt"] >= now),
        len(thermal["temperature"]),
    )
    start = max(0, pivot - hours)
    stop = min(pivot + hours + 1, len(thermal["temperature"]))
    rows = range(start, stop)
    return {
        "model": thermal["model"],
        "bbox": [round(value, 4) for value in thermal["box"]],
        "nx": thermal["nx"],
        "ny": thermal["ny"],
        "t0": thermal["t0"] + start * thermal["dt"],
        "dt": thermal["dt"],
        "nt": stop - start,
        "temperature": [thermal["temperature"][row] for row in rows],
        "precipitation": [thermal["precipitation"][row] for row in rows],
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

def main_thermal(bbox):
    """Grille de temperature seule, pour le workflow meteo lent.

    Elle ne partage aucun fichier avec la collecte des foyers : `thermal.json`
    porte sa propre base de temps, donc les deux cadences n'ont pas a s'aligner.
    AROME HD ne sort une nouvelle echeance que toutes les 3 h — l'interroger
    douze fois par jour ne gagnait rien et alimentait les bridages.
    """
    os.makedirs(OUT, exist_ok=True)
    print(f"bbox {bbox}\n")
    print("Open-Meteo / AROME HD - temperature a 2 m")
    thermal = fetch_thermal(wind_box(bbox), THERMAL_SPACING_KM)
    now = datetime.now(timezone.utc).timestamp()
    export = thermal_export(thermal, now)
    export["generated_at"] = datetime.now(timezone.utc).isoformat()
    write_json(os.path.join(OUT, "thermal.json"), export)
    print(f"\n-> {export['nt']} heures, grille {export['nx']}x{export['ny']}")
    print(f"-> ecrit dans {OUT}/thermal.json")


def main():
    bbox = DEFAULT_BBOX
    args = sys.argv[1:]
    thermal_only = "--thermal" in args
    args = [value for value in args if value != "--thermal"]
    if len(args) == 4:
        bbox = tuple(float(value) for value in args)
    elif args:
        raise SystemExit(
            "usage: fetch_fires.py [--thermal] [west south east north]"
        )
    if thermal_only:
        return main_thermal(bbox)

    os.makedirs(OUT, exist_ok=True)
    print(f"bbox {bbox}\n")

    print("NASA FIRMS - foyers actifs")
    hotspots = fetch_hotspots(bbox)
    if not hotspots["features"]:
        raise SystemExit("aucun foyer FIRMS : export annule")
    # `latest` vient du flux frais : l'historique repris ne doit jamais reculer
    # l'instant de reference si un ancien paquet est incomplet ou corrompu.
    latest = hotspots["features"][-1]["properties"]["ts"]
    hotspots = extend_hotspot_history(hotspots, bbox)

    print("\nCopernicus EFFIS - surfaces brulees")
    burnt = fetch_burnt(bbox)
    recent = burnt_since(burnt["burnt_dated"], latest, RECENT_DAYS)

    print("\nAssociation PSFDF - incendies suivis")
    try:
        psfdf = fetch_psfdf(bbox)
        print(f"  {len(psfdf['features'])} incendies mis à jour depuis 7 jours")
        matched = align_psfdf_to_effis(psfdf, recent)
        print(f"  {matched} disques ajustés sur un périmètre EFFIS récent")
    except Exception as error:
        # Cette couche éditoriale enrichit la carte mais ne doit pas empêcher la
        # publication des observations satellitaires si son API est indisponible.
        print(f"  ! PSFDF indisponible ({error})", file=sys.stderr)
        psfdf = fc([])

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
    if fine_keys:
        # La grille dépasse la cellule active de 60 km. Le navigateur fond
        # ensuite cette marge dans le champ national : sans débord, la rupture
        # de résolution dessinerait un carré net dans les particules.
        fine_boxes = {
            (ix, iy): wind_box((ix, iy, ix + TILE_DEG, iy + TILE_DEG))
            for ix, iy in sorted(fine_keys)
        }
        try:
            raw = fetch_fine_winds(fine_boxes, WIND_SPACING_KM,
                                   FINE_WIND_DEADLINE)
        except Exception as error:
            # Le champ national grossier reste disponible partout : une maille
            # fine est un enrichissement, pas une raison de bloquer la mise à
            # jour des foyers et périmètres pendant plusieurs heures. Les points
            # voyageant desormais en lots partages, une serie interrompue ne
            # donne aucune cellule exploitable : c'est tout ou rien, la ou la
            # boucle par cellule gardait les premieres.
            print(f"  ! vent fin abandonne ({error})", file=sys.stderr)
            raw = {}
        for key, grid in raw.items():
            fine_wind[key] = whole_wind(grid, WIND_DETAIL_STRIDE)

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
    social_timeline = build_social_timeline(timeline)
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
        "psfdf_count": len(psfdf["features"]),
        "fine_wind_zones": [tile_id(*key) for key in sorted(fine_wind)],
        "wind_model": coarse_wind["model"],
    }

    write_json(os.path.join(OUT, "overview_hotspots.geojson"), overview)
    write_json(os.path.join(OUT, "burnt_recent.geojson"), recent)
    write_json(os.path.join(OUT, "psfdf_fires.geojson"), psfdf)
    write_json(os.path.join(OUT, "timeline.json"), timeline)
    write_json(os.path.join(OUT, "social_timeline.json"), social_timeline)
    write_json(os.path.join(OUT, "wind_coarse.json"), coarse)
    write_json(os.path.join(OUT, "weather_forecast.json"), weather)
    write_json(os.path.join(OUT, "manifest.json"), manifest, compact=False)
    # `thermal.json` appartient au workflow meteo : ne jamais l'ecrire ici, sous
    # peine de le remplacer par un champ vieux de plusieurs heures.

    print(
        f"  {len(zone_ids)} zones, {len(overview['features'])} foyers agreges, "
        f"{len(recent['features'])} perimetres recents"
    )
    print(f"\n-> {len(hotspots['features'])} detections detaillees")
    print(f"-> ecrit dans {OUT}/ (donnees generees non versionnees)")


if __name__ == "__main__":
    main()
