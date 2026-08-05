#!/usr/bin/env python3
"""Assemble l'artefact Pages à partir des fichiers du dépôt et des données."""

from __future__ import annotations

import argparse
import json
import pathlib
import shutil


FRONT_FILES = (
    "index.html", "archives.html", "mentions-legales.html", "aviso-legal.html",
    "social.html", "og.png",
    "favicon.svg", "favicon.ico", "apple-touch-icon.png", "icon-192.png",
    "icon-512.png", "site.webmanifest", "robots.txt", "sitemap.xml",
)
FIRE_DATA_FILES = (
    "manifest.json", "overview_hotspots.geojson", "burnt_recent.geojson",
    "psfdf_fires.geojson", "timeline.json", "social_timeline.json",
    "wind_coarse.json", "weather_forecast.json",
)


def copy_front(source: pathlib.Path, target: pathlib.Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for name in FRONT_FILES:
        shutil.copy2(source / name, target / name)
    for name in ("css", "js", "vendor", "fonts"):
        shutil.copytree(source / name, target / name, dirs_exist_ok=True)


def assemble_fire(source: pathlib.Path, data: pathlib.Path, target: pathlib.Path) -> None:
    copy_front(source, target)
    target_data = target / "data"
    target_data.mkdir(parents=True, exist_ok=True)
    for name in FIRE_DATA_FILES:
        shutil.copy2(data / name, target_data / name)
    # Les champs de vent regionaux suivent les regions collectees : les lire
    # dans le manifeste evite d'avoir a tenir une seconde liste a jour ici.
    manifest = json.loads((data / "manifest.json").read_text(encoding="utf-8"))
    for field in manifest.get("wind_fields", []):
        name = field["file"]
        if name not in FIRE_DATA_FILES:
            shutil.copy2(data / name, target_data / name)
    thermal = data / "thermal.json"
    if thermal.exists():
        shutil.copy2(thermal, target_data / thermal.name)
    shutil.copytree(data / "zones", target_data / "zones", dirs_exist_ok=True)


def assemble_front(source: pathlib.Path, target: pathlib.Path) -> None:
    copy_front(source, target)


def assemble_weather(data: pathlib.Path, target: pathlib.Path) -> None:
    target_data = target / "data"
    target_data.mkdir(parents=True, exist_ok=True)
    shutil.copy2(data / "thermal.json", target_data / "thermal.json")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("fire", "front", "weather"))
    parser.add_argument("--source", type=pathlib.Path, default=pathlib.Path("."))
    parser.add_argument("--data", type=pathlib.Path, default=pathlib.Path("data"))
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("_site"))
    args = parser.parse_args()
    if args.mode == "fire":
        assemble_fire(args.source, args.data, args.output)
    elif args.mode == "front":
        assemble_front(args.source, args.output)
    else:
        assemble_weather(args.data, args.output)


if __name__ == "__main__":
    main()
