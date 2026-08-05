#!/usr/bin/env python3
"""
Produit les donnees statiques de Flamap pour les regions de `REGIONS` :
France metropolitaine, puis peninsule Iberique en couverture reduite.

Le navigateur ne charge d'abord qu'un apercu leger :
  - foyers FIRMS agreges spatialement et par heure ;
  - perimetres EFFIS mis a jour dans les sept derniers jours ;
  - un vent grossier par region ;
  - frise et manifest.

Les detections detaillees, la saison EFFIS, le NRT et le vent fin sont repartis
dans des cellules de 1 degre chargees seulement lorsque la carte zoome.

Les flux FIRMS publics ne couvrent que sept jours. Le collecteur reprend donc
les detections encore valides du deploiement precedent pour porter la fenetre
d'affichage a dix jours, sans cle d'API.

Usage :
    python3 fetch_fires.py
    python3 fetch_fires.py west south east north
    python3 fetch_fires.py --regions fr --out data-dev
"""

import argparse
import math
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from flamap.geo import (
    bounds_gap_km,
    feature_bounds,
    geographic_distance_km,
    geometry_points,
    in_any_bbox,
    point_bounds_distance_km,
    swap_axes,
    union_bbox,
)
from flamap.http import get
from flamap.effis import (
    EFFIS_WFS,
    burnt_since,
    effis_wfs as _effis_wfs,
    fetch_burnt as _fetch_burnt,
    merge_burnt,
    stable_feature_id,
    to_epoch,
)
from flamap.firms import (
    FIRMS_ATTEMPTS,
    FIRMS_BASE,
    FIRMS_FEEDS,
    FIRMS_TIMEOUT,
    HOTSPOT_DAYS,
    OVERVIEW_DEG,
    OVERVIEW_H,
    TEMPORARY_SOURCE_FAILURE,
    aggregate_hotspots as _aggregate_hotspots,
    download_firms_feed as _download_firms_feed,
    extend_hotspot_history as _extend_hotspot_history,
    fetch_hotspots as _fetch_hotspots,
)
from flamap.timeline import (
    SOCIAL_DAYS,
    build_social_timeline as _build_social_timeline,
    build_timeline,
)
from flamap.psfdf import (
    PARIS_TZ,
    PSFDF_API,
    PSFDF_EFFIS_CLUSTER_GAP_KM,
    PSFDF_EFFIS_MATCH_KM,
    PSFDF_MAX_AGE_DAYS,
    PSFDF_STATUSES,
    PSFDF_TIMEOUT,
    align_psfdf_to_effis as _align_psfdf_to_effis,
    fetch_psfdf as _fetch_psfdf,
    psfdf_number,
    psfdf_status as _psfdf_status,
    psfdf_timestamp as _psfdf_timestamp,
)
from flamap.heuristic_fires import (
    HEURISTIC_MAX_AGE_HOURS,
    HEURISTIC_MIN_HOTSPOTS,
    HEURISTIC_RADIUS_KM,
    detect_heuristic_fires as _detect_heuristic_fires,
)
from flamap.meteo import (
    build_wind as _build_wind,
    fetch_fine_winds as _fetch_fine_winds,
    fetch_thermal as _fetch_thermal,
    fetch_wind as _fetch_wind,
    fine_wind_tiles as _fine_wind_tiles,
    keep_recent as _keep_recent,
    meteo_request as _meteo_request,
    request_batches as _request_batches,
    request_wind_batches as _request_wind_batches,
    thermal_export as _thermal_export,
    weather_forecast as _weather_forecast,
    whole_wind as _whole_wind,
    wind_box as _wind_box,
    wind_grid as _wind_grid,
    wind_holes as _wind_holes,
    wind_subset as _wind_subset,
)
from flamap.validation import validate_thermal
from flamap.writer import publish_export, publish_json

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data")
ZONES_OUT = os.path.join(OUT, "zones")

# France metropolitaine et Corse. La bbox assume volontairement une petite
# couronne etrangere : elle evite les coupures sur les frontieres et en mer.
DEFAULT_BBOX = (-5.5, 41.0, 10.0, 51.5)
FRANCE_BOXES = (DEFAULT_BBOX,)
# Peninsule iberique. Deux rectangles et non un seul : le rectangle englobant
# descendrait sur le Rif et sur tout le littoral algerien — Alger est a 36,8 N,
# plus au nord qu'Almeria — qui brulent beaucoup l'ete et n'ont ni perimetre
# EFFIS ni vent collecte ici. Le decrochement du second rectangle laisse les
# Baleares et le Levant sans faire entrer l'Afrique du Nord.
# Les Canaries, a 1 500 km au large, sortiraient du cadrage commun : elles ne
# sont pas collectees.
IBERIA_BOXES = (
    (-9.8, 36.0, -1.5, 44.0),
    (-1.5, 37.4, 4.6, 43.0),
)
TILE_DEG = 1.0
DETAIL_ZOOM = 7
# Les contours affiches dans l'apercu national restent bornes a sept jours.
RECENT_DAYS = 7

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
WIND_MODEL = "meteofrance_arome_france_hd"
# AROME HD s'arrete a son domaine national : interroge sur l'Iberie il renvoie
# des trous, et `fetch_wind` basculerait alors toute la grille sur `best_match`.
# Chaque region garde donc son modele, jamais une grille commune.
IBERIA_WIND_MODEL = "meteofrance_arpege_europe"
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
WIND_REQUEST_PAUSE = 6
# Une reponse saine arrive en moins d'une seconde. Un timeout genereux ne protege
# donc rien : il fixe le prix d'un incident. A 180 s, cinq poignees de main
# expirees coutaient 15 min de temps mort et faisaient tomber la collecte
# entiere sur son plafond de 25 min.
OPEN_METEO_TIMEOUT = 30
# EX_TEMPFAIL : le workflow reconnaît ce cas externe et conserve le site actif.

# Domaine collecte, region par region. Chacune porte ce qu'elle sait fournir :
# l'Iberie n'a ni vent fin, ni temperature, ni suivi PSFDF, et le front ne les
# reclame que la ou le manifeste les annonce.
REGIONS = (
    {
        "id": "fr",
        "label": "France",
        "boxes": FRANCE_BOXES,
        "countries": ("FR",),
        "wind_model": WIND_MODEL,
        "temperature": True,
        "fine_wind": True,
        "psfdf": True,
        "heuristic_fires": False,
        "notify": True,
    },
    {
        "id": "es",
        "label": "Espagne et Portugal",
        "boxes": IBERIA_BOXES,
        "countries": ("ES", "PT"),
        "wind_model": IBERIA_WIND_MODEL,
        "temperature": False,
        "fine_wind": False,
        "psfdf": False,
        # Aucun suivi associatif ici : `detect_heuristic_fires` repere les
        # gros amas de foyers FIRMS pour donner un equivalent au rond rouge
        # PSFDF, etiquete comme detection automatique dans la fiche.
        "heuristic_fires": True,
        # Le canal Telegram parle d'incendies en France, avec des communes
        # francaises : l'Iberie est cartographiee, pas annoncee.
        "notify": False,
    },
)

EMPTY_FC = {"type": "FeatureCollection", "features": []}


def region_envelope(region):
    return union_bbox(region["boxes"])


def domain_boxes(regions):
    return [box for region in regions for box in region["boxes"]]


def cli_regions(bbox):
    """Region unique calquee sur la bbox passee en ligne de commande.

    Le mode local sert a rejouer une zone precise : il garde le comportement
    France complet — vent fin, temperature, PSFDF — sur la seule bbox demandee.
    """
    region = dict(REGIONS[0])
    region["boxes"] = (tuple(bbox),)
    return (region,)


def select_regions(names):
    """Sous-ensemble de `REGIONS`, dans l'ordre de la table."""
    wanted = [name.strip() for name in names.split(",") if name.strip()]
    known = {region["id"] for region in REGIONS}
    unknown = [name for name in wanted if name not in known]
    if unknown:
        raise SystemExit(
            f"region inconnue : {', '.join(unknown)} "
            f"(connues : {', '.join(sorted(known))})"
        )
    return tuple(region for region in REGIONS if region["id"] in wanted)


def collection_plan(regions):
    """Ce que chaque region ecrit pour ce run.

    Le nom du fichier de vent n'appartient pas a la region mais a son rang :
    le premier champ garde le nom historique et porte toujours la temperature
    de repli, parce que c'est celui que le front charge avec l'apercu et que
    `validate_export` exige les deux. Sans ca, collecter l'Iberie seule — ce
    que permet `--regions es` en developpement — produirait un export que le
    front ne saurait pas ouvrir.
    """
    return tuple(
        {
            **region,
            "wind_file": "wind_coarse.json" if index == 0
                         else f"wind_coarse_{region['id']}.json",
            "temperature": region["temperature"] or index == 0,
        }
        for index, region in enumerate(regions)
    )


def use_output(directory):
    """Redirige les ecritures vers un autre repertoire que `data/`.

    Les facades lisent `OUT` et `ZONES_OUT` a l'appel : les rebinder ici suffit
    a ce que la collecte, la reprise d'historique et la publication suivent.
    """
    global OUT, ZONES_OUT
    OUT = os.path.abspath(directory)
    ZONES_OUT = os.path.join(OUT, "zones")


def fc(features):
    return {"type": "FeatureCollection", "features": features}


# Facades de compatibilite : les scripts et tests qui ajustent les constantes
# de la CLI continuent a agir sur les fonctions extraites.
def download_firms_feed(label, url):
    return _download_firms_feed(
        label,
        url,
        http_get=get,
        timeout=FIRMS_TIMEOUT,
        attempts=FIRMS_ATTEMPTS,
    )


def fetch_hotspots(boxes):
    return _fetch_hotspots(
        boxes,
        feeds=FIRMS_FEEDS,
        download=download_firms_feed,
        failure_code=TEMPORARY_SOURCE_FAILURE,
    )


def extend_hotspot_history(hotspots, boxes):
    return _extend_hotspot_history(
        hotspots,
        boxes,
        zones_out=ZONES_OUT,
        hotspot_days=HOTSPOT_DAYS,
    )


def aggregate_hotspots(hotspots):
    return _aggregate_hotspots(
        hotspots,
        overview_deg=OVERVIEW_DEG,
        overview_h=OVERVIEW_H,
    )


def build_social_timeline(timeline):
    return _build_social_timeline(timeline, out=OUT, social_days=SOCIAL_DAYS)


# ---------------------------------------------------------------------------
# PSFDF — incendies suivis par l'association
# ---------------------------------------------------------------------------

def psfdf_status(value):
    return _psfdf_status(value, statuses=PSFDF_STATUSES)


def psfdf_timestamp(value, now=None):
    return _psfdf_timestamp(value, now=now, paris_tz=PARIS_TZ)


def fetch_psfdf(bbox):
    return _fetch_psfdf(
        bbox,
        http_get=get,
        api=PSFDF_API,
        timeout=PSFDF_TIMEOUT,
        max_age_days=PSFDF_MAX_AGE_DAYS,
        statuses=PSFDF_STATUSES,
        paris_tz=PARIS_TZ,
        now_factory=datetime.now,
        status_parser=psfdf_status,
        number_parser=psfdf_number,
        timestamp_parser=psfdf_timestamp,
    )


def detect_heuristic_fires(hotspots, bbox, now):
    return _detect_heuristic_fires(
        hotspots,
        bbox,
        now=now,
        min_hotspots=HEURISTIC_MIN_HOTSPOTS,
        radius_km=HEURISTIC_RADIUS_KM,
        max_age_hours=HEURISTIC_MAX_AGE_HOURS,
    )


# ---------------------------------------------------------------------------
# EFFIS
# ---------------------------------------------------------------------------

def effis_wfs(typename, bbox, timeout=300):
    return _effis_wfs(
        typename, bbox, timeout=timeout, http_get=get, base_url=EFFIS_WFS
    )


def fetch_burnt(bbox, countries=("FR",)):
    return _fetch_burnt(
        bbox,
        countries=countries,
        wfs=effis_wfs,
        swap=swap_axes,
        epoch=to_epoch,
        feature_id=stable_feature_id,
    )


def fetch_burnt_regions(regions):
    """Une requete WFS par region, menees de front.

    Le WFS EFFIS repond en 40 a 250 s : enchainer les regions ajouterait ce
    delai a chaque collecte, alors que le service les traite en parallele.
    """
    with ThreadPoolExecutor(max_workers=len(regions)) as executor:
        parts = list(executor.map(
            lambda region: fetch_burnt(
                region_envelope(region), region["countries"]
            ),
            regions,
        ))
    # La region d'origine voyage avec l'objet : les cellules de bordure sont
    # partagees, un perimetre espagnol atterrit donc dans une cellule du domaine
    # francais et rien dans sa geometrie ne dit d'ou il vient. La couche NRT n'a
    # meme pas de pays. `merge_burnt` gardant la premiere version d'un doublon,
    # un objet vu par deux regions porte celle qui vient en tete.
    for region, part in zip(regions, parts):
        for key in ("burnt_dated", "burnt_nrt"):
            for feature in part[key]["features"]:
                feature["properties"]["_r"] = region["id"]
    return merge_burnt(parts) if len(parts) > 1 else parts[0]


# ---------------------------------------------------------------------------
# Decoupage spatial
# ---------------------------------------------------------------------------

def align_psfdf_to_effis(psfdf, recent_effis):
    return _align_psfdf_to_effis(
        psfdf,
        recent_effis,
        match_km=PSFDF_EFFIS_MATCH_KM,
        cluster_gap_km=PSFDF_EFFIS_CLUSTER_GAP_KM,
        bounds_fn=feature_bounds,
        point_distance_fn=point_bounds_distance_km,
        bounds_gap_fn=bounds_gap_km,
        points_fn=geometry_points,
        distance_fn=geographic_distance_km,
    )


def tile_id(ix, iy):
    return f"x{ix:+03d}_y{iy:+03d}"


def tile_range(bbox):
    west, south, east, north = bbox
    return [
        (ix, iy)
        for iy in range(math.floor(south), math.floor(math.nextafter(north, -math.inf)) + 1)
        for ix in range(math.floor(west), math.floor(math.nextafter(east, -math.inf)) + 1)
    ]


def domain_tiles(regions):
    """Reunion des cellules des regions, jamais les cellules de leur enveloppe.

    L'enveloppe France + Iberie fabriquerait une centaine de cellules d'ocean,
    de Mediterranee et d'Allemagne, toutes vides et toutes rechargees a chaque
    collecte par la reprise de l'historique FIRMS.
    """
    cells = {
        cell
        for region in regions
        for box in region["boxes"]
        for cell in tile_range(box)
    }
    return sorted(cells, key=lambda cell: (cell[1], cell[0]))


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
    return _wind_box(bbox, margin_km=WIND_MARGIN_KM)


def wind_grid(box, spacing_km):
    return _wind_grid(box, spacing_km)


def meteo_request(points, model, variables, past_days):
    return _meteo_request(
        points, model, variables, past_days, http_get=get,
        base_url=OPEN_METEO, timeout=OPEN_METEO_TIMEOUT,
    )


def request_batches(points, model, variables, past_days, batch_size=WIND_BATCH,
                    budget=None):
    return _request_batches(
        points, model, variables, past_days, batch_size, budget,
        request=meteo_request, request_pause=WIND_REQUEST_PAUSE,
    )


def request_wind_batches(points, model, temperature=False):
    return _request_wind_batches(
        points, model, temperature, batches=request_batches,
        past_days=WIND_PAST_DAYS,
    )


def keep_recent(series):
    return _keep_recent(series, datetime_cls=datetime)


def wind_holes(series):
    return _wind_holes(series)


def build_wind(box, nx, ny, series, model, temperature=False):
    return _build_wind(
        box, nx, ny, series, model, temperature, recent_fn=keep_recent
    )


def fetch_wind(box, spacing_km, label, temperature=False, wind_model=None):
    return _fetch_wind(
        box, spacing_km, label, temperature, grid=wind_grid,
        batches=request_wind_batches, holes_fn=wind_holes, build=build_wind,
        wind_model=WIND_MODEL if wind_model is None else wind_model,
    )


def fetch_coarse_wind(region):
    """Champ grossier d'une region : `WIND_COARSE_N` colonnes sur sa largeur."""
    box = wind_box(region_envelope(region))
    span = (
        (box[2] - box[0]) * 111
        * math.cos(math.radians((box[1] + box[3]) / 2))
    )
    return fetch_wind(
        box, span / (WIND_COARSE_N - 1), f"grille {region['label']}",
        temperature=region["temperature"], wind_model=region["wind_model"],
    )


def fetch_fine_winds(boxes, spacing_km, budget=None):
    return _fetch_fine_winds(
        boxes, spacing_km, budget, grid=wind_grid, batches=request_batches,
        holes_fn=wind_holes, build=build_wind, wind_model=WIND_MODEL,
        past_days=WIND_PAST_DAYS, batch_size=FINE_WIND_BATCH,
    )


def fetch_thermal(box, spacing_km):
    return _fetch_thermal(
        box, spacing_km, grid=wind_grid, batches=request_batches,
        wind_model=WIND_MODEL, past_days=THERMAL_PAST_DAYS,
        batch_size=THERMAL_BATCH, deadline=THERMAL_DEADLINE,
        recent_fn=keep_recent,
    )


def wind_subset(wind, xs, ys, time_stride=1):
    return _wind_subset(wind, xs, ys, time_stride)


def whole_wind(wind, time_stride=1):
    return _whole_wind(wind, time_stride)


def weather_forecast(wind, now, hours=12):
    return _weather_forecast(wind, now, hours)


def thermal_export(thermal, now, hours=18):
    return _thermal_export(thermal, now, hours)


def fine_wind_tiles(recent, hotspots, latest):
    return _fine_wind_tiles(
        recent, hotspots, latest, feature_tiles_fn=feature_tiles,
        min_count=FIRMS_FINE_MIN,
    )


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
    print(f"bbox {bbox}\n")
    print("Open-Meteo / AROME HD - temperature a 2 m")
    thermal = fetch_thermal(wind_box(bbox), THERMAL_SPACING_KM)
    now = datetime.now(timezone.utc).timestamp()
    export = thermal_export(thermal, now)
    export["generated_at"] = datetime.now(timezone.utc).isoformat()
    publish_json(
        os.path.join(OUT, "thermal.json"), export, validate=validate_thermal
    )
    print(f"\n-> {export['nt']} heures, grille {export['nx']}x{export['ny']}")
    print(f"-> ecrit dans {OUT}/thermal.json")


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="fetch_fires.py",
        description="Collecte les donnees statiques de Flamap.",
    )
    parser.add_argument(
        "bbox", nargs="*", type=float,
        metavar="west south east north",
        help="bbox unique a collecter, en degres ; sinon toutes les regions",
    )
    parser.add_argument("--thermal", action="store_true",
                        help="grille de temperature seule")
    parser.add_argument(
        "--regions",
        help="sous-ensemble de REGIONS, par identifiants separes par des "
             "virgules (ex. --regions es). Le premier collecte fournit le "
             "champ de vent de reference.",
    )
    parser.add_argument(
        "--out",
        help="repertoire de sortie, a la place de data/ (mode developpement)",
    )
    options = parser.parse_args(argv)
    if options.bbox and len(options.bbox) != 4:
        parser.error("la bbox demande quatre nombres : west south east north")
    if options.bbox and options.regions:
        parser.error("--regions et une bbox explicite s'excluent")
    return options


def main():
    bbox = DEFAULT_BBOX
    options = parse_args(sys.argv[1:])
    if options.out:
        use_output(options.out)
        print(f"ecriture dans {OUT}")
    bbox = tuple(options.bbox) if options.bbox else bbox
    if options.thermal:
        return main_thermal(bbox)

    if options.bbox:
        regions = cli_regions(bbox)
    elif options.regions:
        regions = select_regions(options.regions)
    else:
        regions = REGIONS
    regions = collection_plan(regions)
    boxes = domain_boxes(regions)
    domain = union_bbox(boxes)
    print("domaine " + ", ".join(
        f"{region['label']} {region_envelope(region)}" for region in regions
    ) + "\n")

    print("NASA FIRMS - foyers actifs")
    hotspots = fetch_hotspots(boxes)
    if not hotspots["features"]:
        raise SystemExit("aucun foyer FIRMS : export annule")
    # `latest` vient du flux frais : l'historique repris ne doit jamais reculer
    # l'instant de reference si un ancien paquet est incomplet ou corrompu.
    latest = hotspots["features"][-1]["properties"]["ts"]
    hotspots = extend_hotspot_history(hotspots, boxes)

    print("\nCopernicus EFFIS - surfaces brulees")
    burnt = fetch_burnt_regions(regions)
    recent = burnt_since(burnt["burnt_dated"], latest, RECENT_DAYS)

    psfdf_regions = [region for region in regions if region["psfdf"]]
    psfdf = fc([])
    if psfdf_regions:
        print("\nAssociation PSFDF - incendies suivis")
        try:
            psfdf = fetch_psfdf(region_envelope(psfdf_regions[0]))
            print(f"  {len(psfdf['features'])} incendies mis à jour depuis 7 jours")
            matched = align_psfdf_to_effis(psfdf, recent)
            print(f"  {matched} disques ajustés sur un périmètre EFFIS récent")
        except Exception as error:
            # Cette couche éditoriale enrichit la carte mais ne doit pas empêcher
            # la publication des observations satellitaires si son API est
            # indisponible.
            print(f"  ! PSFDF indisponible ({error})", file=sys.stderr)
            psfdf = fc([])

    heuristic_regions = [region for region in regions if region["heuristic_fires"]]
    if heuristic_regions:
        print("\nDétection heuristique - amas de foyers FIRMS")
        heuristic = detect_heuristic_fires(
            hotspots, region_envelope(heuristic_regions[0]), latest
        )
        print(f"  {len(heuristic['features'])} zones detectees "
              f"(>= {HEURISTIC_MIN_HOTSPOTS} foyers a {HEURISTIC_RADIUS_KM} km, "
              f"{HEURISTIC_MAX_AGE_HOURS} h)")
        # Meme fichier que PSFDF : le front n'ouvre qu'une seule source pour
        # les deux, distinguees par `properties.origin` cote JS.
        psfdf["features"].extend(heuristic["features"])

    print("\nOpen-Meteo - vent a 10 m")
    # Les champs restent separes, un fichier par region : voir IBERIA_WIND_MODEL.
    coarse_winds = [(region, fetch_coarse_wind(region)) for region in regions]
    # Le premier porte la temperature de repli et les previsions : c'est la
    # region de reference, celle dont le fichier garde le nom historique.
    reference_wind = coarse_winds[0][1]

    fine_regions = [region for region in regions if region["fine_wind"]]
    fine_keys = fine_wind_tiles(recent, hotspots, latest)
    fine_keys = {
        key for key in fine_keys
        if any(
            in_any_bbox(region["boxes"], key[0] + TILE_DEG / 2, key[1] + TILE_DEG / 2)
            for region in fine_regions
        )
    }
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
    cells = domain_tiles(regions)

    zone_payloads = {}
    for ix, iy in cells:
        name = tile_id(ix, iy)
        zone_payloads[name] = {
            "id": name,
            "bbox": [ix, iy, ix + TILE_DEG, iy + TILE_DEG],
            "hotspots": fc(hotspot_cells.get((ix, iy), [])),
            "burnt_dated": fc(dated_cells.get((ix, iy), [])),
            "burnt_nrt": fc(nrt_cells.get((ix, iy), [])),
            "wind": fine_wind.get((ix, iy)),
        }
    zone_ids = list(zone_payloads)

    generated = datetime.now(timezone.utc).isoformat()
    timeline = build_timeline(hotspots, burnt["burnt_dated"])
    social_timeline = build_social_timeline(timeline)
    overview = aggregate_hotspots(hotspots)
    coarse_exports = {
        region["wind_file"]: whole_wind(wind) for region, wind in coarse_winds
    }
    now = datetime.now(timezone.utc).timestamp()
    weather = weather_forecast(reference_wind, now)
    manifest = {
        "version": 1,
        "generated_at": generated,
        "bbox": list(domain),
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
        "wind_model": reference_wind["model"],
        "regions": [
            {
                "id": region["id"],
                "label": region["label"],
                "boxes": [list(box) for box in region["boxes"]],
                "countries": list(region["countries"]),
                "psfdf": region["psfdf"],
                "notify": region["notify"],
            }
            for region in regions
        ],
        # Le front lit ces champs dans l'ordre : le premier est charge avec le
        # reste de l'apercu national, les suivants viennent en complement.
        "wind_fields": [
            {
                "file": region["wind_file"],
                "model": coarse_exports[region["wind_file"]]["model"],
                "bbox": coarse_exports[region["wind_file"]]["bbox"],
            }
            for region, _ in coarse_winds
        ],
    }

    publish_export(OUT, {
        "overview_hotspots.geojson": overview,
        "burnt_recent.geojson": recent,
        "psfdf_fires.geojson": psfdf,
        "timeline.json": timeline,
        "social_timeline.json": social_timeline,
        "weather_forecast.json": weather,
        **coarse_exports,
        "manifest.json": manifest,
    }, zone_payloads)
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
