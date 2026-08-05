"""Detection heuristique de grands foyers actifs, hors couverture PSFDF.

PSFDF ne couvre que la France (`REGIONS[*]["psfdf"]` dans `fetch_fires.py`).
Ce module repere, pour les regions qui n'ont pas de suivi associatif, les
endroits ou de nombreux foyers FIRMS distincts se regroupent dans un petit
perimetre : cela produit un cercle "Détection auto" au meme format que les
fiches PSFDF, pour que le front les affiche sans code specifique par region.
Contrairement a PSFDF, aucun statut humain, aucune surface, aucun moyen
aerien : seule la densite de detections satellite est connue.
"""

import math

from flamap.geo import geographic_distance_km

HEURISTIC_STATUS = "Détection auto"
# Un feu agricole ou une fausse detection isolee ne depasse presque jamais
# cette taille de groupe sur 72h ; un feu de vegetation etendu, si.
HEURISTIC_MIN_HOTSPOTS = 8
HEURISTIC_RADIUS_KM = 10
HEURISTIC_MAX_AGE_HOURS = 72


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def _bucket(points, cell_lon_deg, cell_lat_deg):
    buckets = {}
    for index, point in enumerate(points):
        key = (math.floor(point[0] / cell_lon_deg), math.floor(point[1] / cell_lat_deg))
        buckets.setdefault(key, []).append(index)
    return buckets


def _cluster_indices(points, radius_km, distance_fn, *, max_abs_lat=60):
    """Regroupe des points par connexite (union-find), un point pouvant
    relier deux groupes distants via une chaine d'intermediaires plus proches.

    Le decoupage en cellules evite de comparer chaque point a tous les
    autres : seuls les points d'une cellule et de ses huit voisines peuvent se
    trouver a moins de `radius_km`, *a condition* que chaque cellule couvre au
    moins `radius_km` en distance reelle sur ses deux axes. Un degre de
    longitude vaut nettement moins de 111 km au-dela de l'equateur
    (`cos(latitude)`) : sans cette correction, des points bien a moins de
    `radius_km` l'un de l'autre auraient pu tomber deux cellules plus loin
    en longitude et etre ignores, cassant l'egalite avec `distance_fn` en
    silence sur la France comme sur l'Iberie.
    """
    n = len(points)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj

    # Latitude la plus proche du pole du domaine : le pire cas, celui qui
    # retrecit le plus un degre de longitude, fixe une largeur de cellule
    # valable partout ailleurs dans la meme collecte.
    lon_scale = max(math.cos(math.radians(max_abs_lat)), 0.05) * 111.32
    cell_lon_deg = max(radius_km / lon_scale, 1e-6)
    cell_lat_deg = max(radius_km / 110.57, 1e-6)
    buckets = _bucket(points, cell_lon_deg, cell_lat_deg)
    for (cx, cy), indices in buckets.items():
        neighbours = [
            index
            for dx in (-1, 0, 1)
            for dy in (-1, 0, 1)
            for index in buckets.get((cx + dx, cy + dy), [])
        ]
        for i in indices:
            for j in neighbours:
                if j > i and distance_fn(points[i], points[j]) <= radius_km:
                    union(i, j)

    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def detect_heuristic_fires(hotspots, bbox, *, now, min_hotspots=None,
                            radius_km=None, max_age_hours=None,
                            distance_fn=None):
    """Cercles rouges synthetiques pour les regions sans suivi PSFDF.

    Un groupe de foyers FIRMS distincts, rapproches a moins de `radius_km`
    les uns des autres (par transitivite) et detectes dans les
    `max_age_hours` dernieres heures, devient un cercle des que sa taille
    atteint `min_hotspots`. Le rayon publie est la distance maximale au
    centroide, elargie d'une marge, a l'image d'`align_psfdf_to_effis`.
    """
    min_hotspots = HEURISTIC_MIN_HOTSPOTS if min_hotspots is None else min_hotspots
    radius_km = HEURISTIC_RADIUS_KM if radius_km is None else radius_km
    max_age_hours = (
        HEURISTIC_MAX_AGE_HOURS if max_age_hours is None else max_age_hours
    )
    distance_fn = geographic_distance_km if distance_fn is None else distance_fn

    west, south, east, north = bbox
    cutoff = now - max_age_hours * 3600
    recent = [
        feature for feature in hotspots.get("features", [])
        if (west <= feature["geometry"]["coordinates"][0] <= east
            and south <= feature["geometry"]["coordinates"][1] <= north
            and (feature["properties"].get("ts") or 0) >= cutoff)
    ]
    points = [feature["geometry"]["coordinates"] for feature in recent]
    max_abs_lat = max(abs(south), abs(north))

    features = []
    for group in _cluster_indices(points, radius_km, distance_fn,
                                  max_abs_lat=max_abs_lat):
        if len(group) < min_hotspots:
            continue
        member_points = [points[index] for index in group]
        member_ts = [recent[index]["properties"].get("ts") or 0 for index in group]
        center = [
            sum(point[0] for point in member_points) / len(member_points),
            sum(point[1] for point in member_points) / len(member_points),
        ]
        spread = max(distance_fn(center, point) for point in member_points)
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [round(center[0], 6), round(center[1], 6)],
            },
            "properties": {
                "id": f"heur-{round(center[0], 3)}-{round(center[1], 3)}",
                "status": HEURISTIC_STATUS,
                "commune": "",
                "departement": "",
                "reported": "",
                "updated": "",
                "updated_ts": int(max(member_ts)),
                "surface": None,
                "surface_type": "",
                "personnel": None,
                "helicopteres": None,
                "avions": None,
                "canadair": None,
                "dash": None,
                "airtractor": None,
                "hbe": None,
                "hbel": None,
                "other_info": "",
                "origin": "heuristic",
                "hotspot_count": len(group),
                # Marge identique a `align_psfdf_to_effis` : le rayon reel d'un
                # feu de vegetation deborde presque toujours son enveloppe de
                # detections, qui n'en couvre que le coeur le plus actif.
                "heuristic_radius_km": round(max(spread, .25) * 1.15, 2),
            },
        })

    # Ordre stable : les groupes les plus etendus d'abord, pour un diagnostic
    # d'export plus lisible.
    features.sort(key=lambda feature: (
        -feature["properties"]["hotspot_count"],
        feature["properties"]["id"],
    ))
    return fc(features)
