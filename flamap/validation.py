"""Validation structurelle des exports publics avant leur publication."""

import json
import os


ROOT_FILES = (
    "overview_hotspots.geojson",
    "burnt_recent.geojson",
    "psfdf_fires.geojson",
    "timeline.json",
    "social_timeline.json",
    "wind_coarse.json",
    "weather_forecast.json",
)
PSFDF_STATUSES = {"Hors de contrôle", "En cours", "Fixé", "Maîtrisé", "Éteint"}


def load_json(path):
    with open(path, encoding="utf-8") as source:
        return json.load(source)


def feature_collection(value, name):
    if value.get("type") != "FeatureCollection" or not isinstance(
        value.get("features"), list
    ):
        raise ValueError(f"{name} n'est pas une FeatureCollection")


def wind_rows(value, name, fields):
    rows = value.get("nt", 0)
    if rows < 2 or any(len(value.get(field, [])) != rows for field in fields):
        raise ValueError(f"{name} absent ou incomplet")


def validate_export(root):
    """Vérifie le contrat consommé par le front et les workflows.

    Le manifeste est validé avec les autres fichiers dans le répertoire de
    préparation. Il reste toutefois le dernier fichier remplacé par le writer :
    il demeure donc le dernier point d'entrée rendu visible au navigateur.
    """
    manifest = load_json(os.path.join(root, "manifest.json"))
    for name in ROOT_FILES:
        if not os.path.isfile(os.path.join(root, name)):
            raise ValueError(f"fichier d'export manquant : {name}")

    zones = manifest.get("zones")
    if not isinstance(zones, list) or not zones or len(zones) != len(set(zones)):
        raise ValueError("liste des zones invalide")
    if not manifest.get("hotspot_count"):
        raise ValueError("export national sans foyer")

    overview = load_json(os.path.join(root, "overview_hotspots.geojson"))
    psfdf = load_json(os.path.join(root, "psfdf_fires.geojson"))
    feature_collection(overview, "aperçu FIRMS")
    feature_collection(psfdf, "export PSFDF")
    if any(
        feature.get("properties", {}).get("status") not in PSFDF_STATUSES
        for feature in psfdf["features"]
    ):
        raise ValueError("export PSFDF invalide")
    if any(
        not isinstance(feature.get("properties", {}).get("frp"), (int, float))
        for feature in overview["features"]
    ):
        raise ValueError("puissance radiative FIRMS absente des agrégats")

    timeline = load_json(os.path.join(root, "timeline.json"))
    if not timeline or not any(step.get("kind") == "sat" for step in timeline):
        raise ValueError("frise satellite absente")
    if any(
        not isinstance(step.get("frp"), (int, float))
        for step in timeline if step.get("kind") == "sat"
    ):
        raise ValueError("puissance radiative FIRMS absente de la frise")

    weather = load_json(os.path.join(root, "weather_forecast.json"))
    coarse = load_json(os.path.join(root, "wind_coarse.json"))
    wind_rows(weather, "export météo", ("u", "v", "gust"))
    if any(
        len(coarse.get(field, [])) != coarse.get("nt", 0)
        for field in ("temperature", "precipitation")
    ):
        raise ValueError("température de repli absente de wind_coarse.json")

    expected = {f"{zone_id}.json" for zone_id in zones}
    zone_root = os.path.join(root, "zones")
    actual = set(os.listdir(zone_root)) if os.path.isdir(zone_root) else set()
    if actual != expected:
        raise ValueError("paquets de zones incomplets")
    fine_zones = manifest.get("fine_wind_zones")
    if not isinstance(fine_zones, list):
        raise ValueError("liste des zones de vent fin invalide")
    fine = set(fine_zones)
    for name in expected:
        zone = load_json(os.path.join(zone_root, name))
        if zone.get("id") != name.removesuffix(".json"):
            raise ValueError(f"identifiant de zone incohérent : {name}")
        if zone["id"] in fine and not zone.get("wind"):
            raise ValueError(f"vent fin absent : {name}")

    return manifest


def validate_thermal(value):
    wind_rows(value, "export thermique", ("temperature", "precipitation"))
