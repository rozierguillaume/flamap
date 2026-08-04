#!/usr/bin/env python3
"""Prépare le lot d'archive d'une collecte, à expédier vers le journal du VPS.

Le site publié n'expose qu'une fenêtre glissante. Ce script relit l'export qui
vient d'être validé, en tire les enregistrements du journal et les écrit dans un
répertoire de lot que le workflow synchronise ensuite par `rsync`.

Il ne parle à personne : ni réseau, ni SSH. Un lot est un simple répertoire de
fichiers NDJSON gzippés, réexpédiable tel quel si la synchronisation échoue.
"""

from __future__ import annotations

import argparse
import gzip
import json
import pathlib
import sys
import tempfile
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from flamap.archive import ARCHIVE_STREAMS, build_lot


def read_json(path: pathlib.Path):
    with path.open(encoding="utf-8") as source:
        return json.load(source)


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def collect_export(data: pathlib.Path) -> dict:
    """Réassemble le détail complet à partir des zones publiées.

    Les foyers détaillés et les périmètres ne vivent que dans `data/zones/` :
    seuls l'aperçu agrégé et les périmètres récents sont à la racine. Un
    polygone à cheval sur plusieurs cellules y est écrit une fois par cellule,
    d'où la déduplication par `_id` avant la construction du lot.
    """
    hotspots: list = []
    dated: dict = {}
    nrt: dict = {}
    zones = data / "zones"
    for path in sorted(zones.glob("*.json")):
        payload = read_json(path)
        hotspots.extend(payload.get("hotspots", {}).get("features", []))
        for key, seen in (("burnt_dated", dated), ("burnt_nrt", nrt)):
            for feature in payload.get(key, {}).get("features", []):
                identifier = feature.get("properties", {}).get("_id")
                if identifier is not None:
                    seen.setdefault(identifier, feature)

    psfdf_path = data / "psfdf_fires.geojson"
    psfdf = read_json(psfdf_path) if psfdf_path.exists() else fc([])
    return {
        "hotspots": fc(hotspots),
        "burnt_dated": fc(list(dated.values())),
        "burnt_nrt": fc(list(nrt.values())),
        "psfdf": psfdf,
    }


def collection_time(data: pathlib.Path) -> int:
    """Instant de la collecte, repris du manifeste plutôt que de l'horloge.

    Un lot rejoué doit produire exactement les mêmes lignes que le lot
    d'origine, sans quoi la déduplication du serveur ne reconnaîtrait pas les
    cicatrices NRT, dont la partition suit l'instant de collecte.
    """
    manifest = read_json(data / "manifest.json")
    generated = manifest.get("generated_at")
    if generated:
        return int(datetime.fromisoformat(generated).timestamp())
    return int(datetime.now(timezone.utc).timestamp())


def write_lot(lot: dict, target: pathlib.Path, *, run: str, seen: int) -> dict:
    """Écrit le lot dans un répertoire temporaire voisin, renommé une fois complet.

    Un lot partiel visible dans la boîte de réception serait fusionné tel quel
    par le serveur, qui n'a aucun moyen de savoir qu'il manque des lignes.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    staged = pathlib.Path(
        tempfile.mkdtemp(prefix=".flamap-lot-", dir=target.parent)
    )
    counts = {}
    for stream in ARCHIVE_STREAMS:
        records = lot.get(stream, [])
        counts[stream] = len(records)
        with gzip.open(staged / f"{stream}.ndjson.gz", "wt",
                       encoding="utf-8", compresslevel=6) as output:
            for record in records:
                output.write(json.dumps(
                    record, sort_keys=True, separators=(",", ":"),
                    ensure_ascii=False,
                ) + "\n")
    meta = {"run": run, "seen": seen, "counts": counts}
    with (staged / "meta.json").open("w", encoding="utf-8") as output:
        json.dump(meta, output, ensure_ascii=False, indent=2)
    staged.replace(target)
    return meta


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=pathlib.Path, default=pathlib.Path("data"))
    parser.add_argument("--outbox", type=pathlib.Path,
                        default=pathlib.Path("outbox"))
    parser.add_argument("--run", default="local",
                        help="identifiant d'exécution, repris dans le nom du lot")
    args = parser.parse_args()

    seen = collection_time(args.data)
    export = collect_export(args.data)
    lot = build_lot(export, seen)
    name = (
        datetime.fromtimestamp(seen, timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        + f"-{args.run}"
    )
    meta = write_lot(lot, args.outbox / name, run=args.run, seen=seen)
    total = sum(meta["counts"].values())
    detail = ", ".join(f"{stream} {meta['counts'][stream]}"
                       for stream in ARCHIVE_STREAMS)
    print(f"lot {name} : {total} enregistrements ({detail})")


if __name__ == "__main__":
    main()
