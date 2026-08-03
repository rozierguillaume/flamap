#!/usr/bin/env python3
"""Reprend les fichiers nécessaires depuis l'artefact Pages publié."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Callable

from front_resources import PRESERVED_FRONT_FILES, front_closure


CORE_DATA_FILES = (
    "overview_hotspots.geojson",
    "burnt_recent.geojson",
    "psfdf_fires.geojson",
    "timeline.json",
    "wind_coarse.json",
    "weather_forecast.json",
)

def download_artifact(
    base: str,
    root: pathlib.Path,
    *,
    include_front: bool = False,
    open_url: Callable[..., object] = urllib.request.urlopen,
) -> None:
    """Télécharge les données publiées, et le front si le mode météo le demande."""
    base = base.rstrip("/")

    def download(item: tuple[str, str]) -> bytes:
        relative, local = item
        url = f"{base}/{relative}"
        target = root / local
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open_url(url, timeout=60) as response:
                payload = response.read()
        except Exception as error:
            raise SystemExit(f"impossible de reprendre {url}: {error}") from error
        if not payload:
            raise SystemExit(f"fichier vide recu: {url}")
        target.write_bytes(payload)
        return payload

    manifest = json.loads(download(("data/manifest.json", "data/manifest.json")))
    files = [(f"data/{name}", f"data/{name}") for name in CORE_DATA_FILES]
    for zone_id in manifest["zones"]:
        encoded = urllib.parse.quote(str(zone_id), safe="")
        files.append((f"data/zones/{encoded}.json", f"data/zones/{zone_id}.json"))
    with ThreadPoolExecutor(max_workers=12) as pool:
        for _ in pool.map(download, files):
            pass

    try:
        download(("data/social_timeline.json", "data/social_timeline.json"))
    except SystemExit as error:
        print(f"::warning::Historique social repris depuis la frise : {error}")
        shutil.copy(root / "data/timeline.json", root / "data/social_timeline.json")

    if include_front:
        def download_front(names: list[str]) -> dict[str, bytes]:
            with ThreadPoolExecutor(max_workers=12) as pool:
                payloads = pool.map(lambda name: download((name, name)), names)
                return dict(zip(names, payloads))

        front_closure(lambda name: download((name, name)), read_many=download_front)
        def preserve_front(name: str) -> None:
            try:
                download((name, name))
            except SystemExit:
                pass

        with ThreadPoolExecutor(max_workers=12) as pool:
            for _ in pool.map(preserve_front, PRESERVED_FRONT_FILES):
                pass
        return
    download_thermal(base, root / "data/thermal.json", open_url=open_url)


def download_thermal(
    base: str,
    target: pathlib.Path,
    *,
    open_url: Callable[..., object] = urllib.request.urlopen,
) -> None:
    """Reprend uniquement thermal.json, facultatif avant la première collecte."""
    base = base.rstrip("/")
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open_url(f"{base}/data/thermal.json", timeout=60) as response:
            payload = response.read()
        if not payload:
            raise ValueError("réponse vide")
    except Exception as error:
        print(f"::warning::Grille de température non reprise : {error}. "
              "Le front retombera sur le champ large.")
    else:
        target.write_bytes(payload)
        print(f"Grille de température reprise : {len(payload) / 1e6:.2f} Mo")


def recover_fire_history(
    base: str,
    data_root: pathlib.Path,
    prev_root: pathlib.Path,
    *,
    open_url: Callable[..., object] = urllib.request.urlopen,
) -> None:
    """Reprend l'historique FIRMS et prépare la référence Telegram."""
    base = base.rstrip("/")
    zones_root = data_root / "zones"
    backoff = (0, 3, 9)

    def fetch(url: str) -> tuple[bytes | None, str | None]:
        last: object = "réponse vide"
        for pause in backoff:
            if pause:
                time.sleep(pause)
            try:
                with open_url(url, timeout=60) as response:
                    body = response.read()
            except Exception as error:
                last = error
                continue
            if body:
                return body, None
            last = "réponse vide"
        return None, f"{last} (après {len(backoff)} tentatives)"

    payload, error = fetch(f"{base}/data/manifest.json")
    if payload is None:
        print(f"::warning::Historique FIRMS indisponible : {error}")
        return
    manifest = json.loads(payload)
    social, social_error = fetch(f"{base}/data/social_timeline.json")
    if social is None:
        print(f"::warning::Historique social indisponible : {social_error}")
    else:
        (data_root / "social_timeline.json").write_bytes(social)

    zones_root.mkdir(parents=True, exist_ok=True)

    def fetch_zone(zone_id: str) -> str | None:
        encoded = urllib.parse.quote(str(zone_id), safe="")
        body, zone_error = fetch(f"{base}/data/zones/{encoded}.json")
        if body is None:
            print(f"::warning::Historique {zone_id} ignoré : {zone_error}")
            return None
        (zones_root / f"{zone_id}.json").write_bytes(body)
        return zone_id

    zones = manifest.get("zones", [])
    with ThreadPoolExecutor(max_workers=12) as pool:
        taken = [zone_id for zone_id in pool.map(fetch_zone, zones) if zone_id]
    if not taken:
        print("::warning::Aucune zone reprise : pas de référence pour la "
              "notification Telegram.")
        return

    (prev_root / "zones").mkdir(parents=True, exist_ok=True)
    for zone_id in taken:
        shutil.copy(zones_root / f"{zone_id}.json", prev_root / "zones")
    manifest["zones"] = taken
    (prev_root / "manifest.json").write_text(json.dumps(manifest))
    missing = len(zones) - len(taken)
    print(f"Référence Telegram : {len(taken)} zones reprises"
          + (f", {missing} écartées du diff" if missing else ""))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", default=os.environ.get("LIVE_SITE"))
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("_site"))
    parser.add_argument("--mode", choices=("front", "weather", "history", "thermal"), required=True)
    parser.add_argument("--data", type=pathlib.Path, default=pathlib.Path("data"))
    parser.add_argument("--prev", type=pathlib.Path, default=pathlib.Path("prev"))
    args = parser.parse_args()
    if not args.site:
        parser.error("--site ou LIVE_SITE est requis")
    if args.mode == "history":
        recover_fire_history(args.site, args.data, args.prev)
    elif args.mode == "thermal":
        download_thermal(args.site, args.data / "thermal.json")
    else:
        download_artifact(args.site, args.output, include_front=args.mode == "weather")


if __name__ == "__main__":
    main()
