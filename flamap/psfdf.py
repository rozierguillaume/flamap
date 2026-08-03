"""Collecte PSFDF et rapprochement avec les perimetres EFFIS."""

import json
import math
import unicodedata
from datetime import datetime
from zoneinfo import ZoneInfo

from flamap.geo import (
    bounds_gap_km,
    feature_bounds,
    geographic_distance_km,
    geometry_points,
    point_bounds_distance_km,
)
from flamap.http import get


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


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def psfdf_status(value, *, statuses=None):
    """Ramène les variantes accentuées ou non aux cinq statuts affichés."""
    statuses = PSFDF_STATUSES if statuses is None else statuses
    text = unicodedata.normalize("NFD", str(value or "").strip().lower())
    key = "".join(char for char in text if unicodedata.category(char) != "Mn")
    return statuses.get(key)


def psfdf_number(value):
    text = str(value or "").strip().replace("\u00a0", "").replace(" ", "")
    if not text:
        return None
    try:
        number = float(text.replace(",", "."))
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def psfdf_timestamp(value, now=None, *, paris_tz=None):
    """Convertit Date_MAJ en epoch malgré les deux ordres employés par PSFDF.

    L'API mélange actuellement le français (01/08/2026) et le format américain
    non rembourré (8/1/2026). Quand les deux lectures sont possibles, une date
    de mise à jour est nécessairement celle des deux qui est la plus proche de
    l'instant de collecte. Cette règle interprète donc aussi bien 1/8 que 8/1
    comme le 1er août lors de la collecte du 1er août.
    """
    paris_tz = PARIS_TZ if paris_tz is None else paris_tz
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
                tzinfo=paris_tz,
            )
        except ValueError:
            continue
        if candidate not in candidates:
            candidates.append(candidate)
    if not candidates:
        return None

    reference = now or datetime.now(paris_tz)
    parsed = min(candidates, key=lambda candidate: abs(candidate - reference))
    return int(parsed.timestamp())


def fetch_psfdf(bbox, *, http_get=None, api=None, timeout=None,
                max_age_days=None, statuses=None, paris_tz=None,
                now_factory=None, status_parser=None, number_parser=None,
                timestamp_parser=None):
    """Extrait les états PSFDF mis à jour au cours des sept derniers jours."""
    http_get = get if http_get is None else http_get
    api = PSFDF_API if api is None else api
    timeout = PSFDF_TIMEOUT if timeout is None else timeout
    max_age_days = PSFDF_MAX_AGE_DAYS if max_age_days is None else max_age_days
    statuses = PSFDF_STATUSES if statuses is None else statuses
    paris_tz = PARIS_TZ if paris_tz is None else paris_tz
    now_factory = datetime.now if now_factory is None else now_factory
    if status_parser is None:
        status_parser = lambda value: psfdf_status(value, statuses=statuses)
    number_parser = psfdf_number if number_parser is None else number_parser
    if timestamp_parser is None:
        timestamp_parser = lambda value, now=None: psfdf_timestamp(
            value, now=now, paris_tz=paris_tz
        )
    west, south, east, north = bbox
    payload = json.loads(http_get(api, timeout=timeout))
    if not isinstance(payload, list):
        raise ValueError("la réponse PSFDF n'est pas un tableau")

    now = now_factory(paris_tz)
    cutoff = now.timestamp() - max_age_days * 86400
    features = []
    for row in payload:
        if not isinstance(row, dict):
            continue
        status = status_parser(row.get("Statut"))
        if not status:
            continue
        lon = number_parser(row.get("Longitude"))
        lat = number_parser(row.get("Latitude"))
        if (lon is None or lat is None
                or not (west <= lon <= east and south <= lat <= north)):
            continue
        updated_ts = timestamp_parser(row.get("Date_MAJ"), now=now)
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
                "surface": number_parser(row.get("Surface")),
                "surface_type": str(row.get("Surface_Type") or "").strip(),
                "personnel": number_parser(row.get("Personnel")),
                "helicopteres": number_parser(row.get("Hélicoptère")),
                "avions": number_parser(row.get("Avion")),
                "canadair": number_parser(row.get("Canadair")),
                "dash": number_parser(row.get("Dash")),
                "airtractor": number_parser(row.get("AirTractor")),
                "hbe": number_parser(row.get("HBE")),
                "hbel": number_parser(row.get("HBEL")),
                "other_info": str(row.get("Autres_infos") or "").strip(),
            },
        })

    # Ordre stable pour faciliter le diagnostic d'un export et son diff local.
    features.sort(key=lambda feature: (
        list(statuses.values()).index(feature["properties"]["status"]),
        -(feature["properties"]["surface"] or 0),
        feature["properties"]["commune"],
    ))
    return fc(features)


def align_psfdf_to_effis(psfdf, recent_effis, *, match_km=None,
                         cluster_gap_km=None, bounds_fn=None,
                         point_distance_fn=None, bounds_gap_fn=None,
                         points_fn=None, distance_fn=None):
    """Centre et dimensionne les disques PSFDF sur les périmètres EFFIS proches.

    Le premier périmètre est le plus proche du point déclaré par l'association.
    On ne lui rattache ensuite que les morceaux voisins de ce premier groupe :
    cette croissance évite d'englober un autre incendie simplement parce qu'il
    se trouve dans la même couronne de quinze kilomètres autour de la commune.
    """
    match_km = PSFDF_EFFIS_MATCH_KM if match_km is None else match_km
    cluster_gap_km = (
        PSFDF_EFFIS_CLUSTER_GAP_KM
        if cluster_gap_km is None else cluster_gap_km
    )
    bounds_fn = feature_bounds if bounds_fn is None else bounds_fn
    point_distance_fn = (
        point_bounds_distance_km
        if point_distance_fn is None else point_distance_fn
    )
    bounds_gap_fn = bounds_gap_km if bounds_gap_fn is None else bounds_gap_fn
    points_fn = geometry_points if points_fn is None else points_fn
    distance_fn = (
        geographic_distance_km if distance_fn is None else distance_fn
    )
    fires = psfdf.get("features", [])
    indexed = [(feature, bounds_fn(feature))
               for feature in recent_effis.get("features", [])]
    # Attribution exclusive : deux communes proches ne doivent pas dessiner
    # deux disques identiques autour du même périmètre EFFIS.
    assigned = {index: [] for index in range(len(fires))}
    for feature, bounds in indexed:
        distances = [
            point_distance_fn(fire["geometry"]["coordinates"], bounds)
            for fire in fires
        ]
        if not distances:
            continue
        nearest = min(range(len(distances)), key=distances.__getitem__)
        if distances[nearest] <= match_km:
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
                if any(bounds_gap_fn(candidate[1], current[1])
                       <= cluster_gap_km for current in selected):
                    selected.append(candidate)
                    remaining.remove(candidate)
                    changed = True

        points = [point for feature, _, _ in selected
                  for point in points_fn(feature["geometry"])]
        west = min(point[0] for point in points)
        south = min(point[1] for point in points)
        east = max(point[0] for point in points)
        north = max(point[1] for point in points)
        center = [(west + east) / 2, (south + north) / 2]
        # Une petite marge empêche le contour coloré de tangenter le contour
        # EFFIS à cause des arrondis de projection côté navigateur.
        radius = max(distance_fn(center, point) for point in points) * 1.08

        fire["geometry"]["coordinates"] = [round(value, 6) for value in center]
        fire["properties"].update({
            "original_center": original,
            "effis_radius_km": round(max(radius, .25), 2),
            "effis_matches": len(selected),
        })
        matched_fires += 1
    return matched_fires
