#!/usr/bin/env python3
"""Valide les données et les artefacts produits par les trois workflows."""

from __future__ import annotations

import argparse
import json
import pathlib
import sys


LIMIT = 100 * 1024 * 1024


def load(path: pathlib.Path) -> object:
    with path.open() as handle:
        return json.load(handle)


def zones(root: pathlib.Path, manifest: dict[str, object]) -> list[pathlib.Path]:
    paths = list((root / "zones").glob("*.json"))
    expected = {f"{zone_id}.json" for zone_id in manifest["zones"]}
    actual = {path.name for path in paths}
    if actual != expected:
        sys.exit("export national incomplet, déploiement annulé")
    return paths


def check_size(root: pathlib.Path, *, details: bool = False) -> None:
    files = [path for path in root.rglob("*") if path.is_file()]
    size = sum(path.stat().st_size for path in files)
    if size > LIMIT:
        sys.exit("site supérieur à 100 Mio, déploiement annulé")
    if details:
        largest = max(files, key=lambda path: path.stat().st_size)
        print(f"{len(files)} fichiers, {size / 1024 / 1024:.1f} Mio "
              f"(plus gros : {largest}, {largest.stat().st_size / 1024 / 1024:.1f} Mio)")
    else:
        print(f"{len(files)} fichiers, {size / 1024 / 1024:.1f} Mio")


def validate_fire_data(root: pathlib.Path) -> None:
    manifest = load(root / "manifest.json")
    timeline = load(root / "timeline.json")
    overview = load(root / "overview_hotspots.geojson")
    psfdf = load(root / "psfdf_fires.geojson")
    weather = load(root / "weather_forecast.json")
    zone_paths = zones(root, manifest)
    print(f"{manifest['hotspot_count']} foyers, {manifest['dated_count']} "
          f"polygones datés, {len(zone_paths)} zones")
    if not manifest["hotspot_count"] or not timeline:
        sys.exit("export national incomplet, déploiement annulé")
    allowed = {"Hors de contrôle", "En cours", "Fixé", "Maîtrisé", "Éteint"}
    if (psfdf.get("type") != "FeatureCollection"
            or any(feature.get("properties", {}).get("status") not in allowed
                   for feature in psfdf.get("features", []))):
        sys.exit("export PSFDF invalide")
    passages = [step for step in timeline if step["kind"] == "sat"]
    if (not passages
            or any(not isinstance(step.get("frp"), (int, float)) for step in passages)
            or any(not isinstance(feature["properties"].get("frp"), (int, float))
                   for feature in overview["features"])):
        sys.exit("puissance radiative FIRMS absente des agrégats")
    check_wind(weather)
    coarse = load(root / "wind_coarse.json")
    if any(len(coarse.get(name, [])) != coarse.get("nt", 0)
           for name in ("temperature", "precipitation")):
        sys.exit("température de repli absente de wind_coarse.json")
    if not (root / "thermal.json").exists():
        print("::warning::aucune grille de température reprise, le front affichera le champ large")
    check_fine_wind(zone_paths, manifest)


def check_wind(weather: dict[str, object]) -> None:
    rows = weather.get("nt", 0)
    if (rows < 2
            or any(len(weather.get(name, [])) != rows for name in ("u", "v", "gust"))):
        sys.exit("export météo absent ou incomplet")


def check_fine_wind(paths: list[pathlib.Path], manifest: dict[str, object]) -> None:
    fine = set(manifest["fine_wind_zones"])
    for path in paths:
        zone = load(path)
        if zone.get("id") != path.stem:
            sys.exit(f"identifiant de zone incohérent : {path}")
        if path.stem in fine and not zone.get("wind"):
            sys.exit(f"vent fin absent : {path}")


def validate_thermal_data(root: pathlib.Path) -> None:
    thermal = load(root / "thermal.json")
    rows = thermal.get("nt", 0)
    print(f"{rows} heures, grille {thermal.get('nx')}x{thermal.get('ny')}, "
          f"modèle {thermal.get('model')}")
    if (rows < 2
            or any(len(thermal.get(name, [])) != rows
                   for name in ("temperature", "precipitation"))):
        sys.exit("grille de température incomplète")
    if thermal.get("nx", 0) < 45:
        sys.exit(f"grille trop grossière : nx={thermal.get('nx')}")
    if any(row.count(None) > len(row) * 0.5 for row in thermal["temperature"]):
        sys.exit("plus de la moitié des températures manquantes")


def validate_front_site(root: pathlib.Path) -> None:
    data = root / "data"
    manifest = load(data / "manifest.json")
    timeline = load(data / "timeline.json")
    weather = load(data / "weather_forecast.json")
    zone_paths = zones(data, manifest)
    print(f"{manifest['hotspot_count']} foyers, {manifest['dated_count']} "
          f"polygones datés, {len(zone_paths)} zones reprises")
    if not manifest["hotspot_count"] or not timeline:
        sys.exit("artefact publie incomplet, déploiement annulé")
    check_wind(weather)
    check_fine_wind(zone_paths, manifest)
    check_size(root)


def validate_weather_site(root: pathlib.Path) -> None:
    data = root / "data"
    manifest = load(data / "manifest.json")
    timeline = load(data / "timeline.json")
    thermal = load(data / "thermal.json")
    zone_paths = zones(data, manifest)
    if not manifest["hotspot_count"] or not timeline:
        sys.exit("artefact publie incomplet, déploiement annulé")
    if thermal.get("nx", 0) < 45:
        sys.exit("grille de température perdue dans l’artefact")
    if not (root / "index.html").exists():
        sys.exit("front absent de l’artefact")
    check_size(root)
    print(f"{manifest['hotspot_count']} foyers conservés, {len(zone_paths)} zones")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("fire-data", "thermal-data", "front", "weather", "size"))
    parser.add_argument("root", type=pathlib.Path)
    args = parser.parse_args()
    if args.mode == "fire-data":
        validate_fire_data(args.root)
    elif args.mode == "thermal-data":
        validate_thermal_data(args.root)
    elif args.mode == "front":
        validate_front_site(args.root)
    elif args.mode == "weather":
        validate_weather_site(args.root)
    else:
        check_size(args.root, details=True)


if __name__ == "__main__":
    main()
