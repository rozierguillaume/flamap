#!/usr/bin/env python3
"""Rattrape une plage de dates FIRMS absente du journal d'archive.

Outil ponctuel, à lancer à la main — distinct du collecteur (`fetch_fires.py`)
qui n'interroge que le flux NRT glissant sur 7 jours. Ce script interroge
l'API area de FIRMS, qui accepte une date et couvre l'historique NRT sur
~2 mois glissants, largement suffisant pour rattraper quelques jours oubliés
au lancement de l'archive.

La clé FIRMS (MAP_KEY, gratuite : https://firms.modaps.eosdis.nasa.gov/api/map_key/)
ne doit jamais être committée ni ajoutée au collecteur automatique (voir
AGENTS.md, §1 et §8 « aucune clé d'API »). Elle se lit uniquement depuis la
variable d'environnement FIRMS_MAP_KEY, jamais depuis un argument (visible
dans l'historique du shell / `ps`).

Le lot produit est strictement au même format que celui de
scripts/archive_push.py (mêmes flux gzip NDJSON + meta.json) : le serveur
d'archive (dépôt flamap-archive) le fusionne sans distinction. La partition
d'un enregistrement (`_p`) est calculée depuis sa date d'observation, pas
depuis la date d'envoi : rejouer un lot ancien tombe donc naturellement dans
le bon mois du journal, sans traitement particulier côté serveur.

Usage :
    export FIRMS_MAP_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    python3 scripts/backfill_firms_archive.py --start 2026-07-21 --end 2026-07-23

Le script n'envoie rien lui-même : il écrit le lot dans outbox-backfill/ et
affiche la commande rsync à lancer avec les identifiants d'archive (les mêmes
que ceux du workflow GitHub, secrets ARCHIVE_SSH_*).

Piège vérifié en pratique (rattrapage du 21-23 juillet, 5 août 2026) : un alias
SSH personnel vers le VPS (ex. `vps-ecmwf`) se connecte généralement avec un
compte différent (`ubuntu`) de celui utilisé par le workflow GitHub
(`ARCHIVE_SSH_USER`, le compte système `flamap-archive`). Le service de fusion
(`flamap-archive-merge.service`, dans le dépôt `flamap-archive`) ne scanne que
`/var/lib/flamap-archive/inbox/` : un rsync fait sous un autre compte atterrit
ailleurs (le répertoire personnel de ce compte) et n'est jamais fusionné, sans
aucune erreur visible. En dehors du compte `flamap-archive`, il faut déplacer
le lot à la main dans `inbox/` (avec les bons propriétaire/permissions) puis
déclencher `sudo systemctl start flamap-archive-merge.service` — le timer
tourne sinon toutes les dix minutes.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import os
import pathlib
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from flamap.archive import ARCHIVE_STREAMS, build_lot

def load_dotenv(path):
    """Charge un .env minimal (KEY=VALUE) sans écraser l'environnement déjà
    présent, ni introduire de dépendance (voir AGENTS.md, §2)."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv(pathlib.Path(__file__).resolve().parents[1] / ".env")

AREA_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
DEFAULT_BBOX = (-5.5, 41.0, 10.0, 51.5)  # même bbox que fetch_fires.py
MAX_DAY_RANGE = 10  # plafond imposé par l'API area

# mêmes libellés que FIRMS_FEEDS dans flamap/firms.py, pour que ces
# détections soient indiscernables de celles collectées en direct.
SOURCES = [
    ("VIIRS/NOAA-20", "VIIRS_NOAA20_NRT"),
    ("VIIRS/NOAA-21", "VIIRS_NOAA21_NRT"),
    ("VIIRS/S-NPP", "VIIRS_SNPP_NRT"),
    ("MODIS", "MODIS_NRT"),
]


def date_chunks(start, end_exclusive, max_days=MAX_DAY_RANGE):
    """Découpe la fenêtre en tranches d'au plus MAX_DAY_RANGE jours."""
    chunk_start = start
    while chunk_start < end_exclusive:
        chunk_end = min(chunk_start + timedelta(days=max_days), end_exclusive)
        yield chunk_start, chunk_end
        chunk_start = chunk_end


def fetch_area_csv(map_key, source, bbox, date, day_range, *, attempts=3):
    west, south, east, north = bbox
    url = (
        f"{AREA_BASE}/{map_key}/{source}/"
        f"{west},{south},{east},{north}/{day_range}/{date}"
    )
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "flamap/0.2"})
            with urllib.request.urlopen(req, timeout=120) as response:
                return response.read().decode("utf-8")
        except urllib.error.URLError as error:
            if attempt == attempts - 1:
                raise
            print(f"  ! {source} indisponible, nouvel essai dans 5 s ({error})",
                  file=sys.stderr)
            time.sleep(5)


def parse_rows(label, raw, bbox, start, end_exclusive):
    # L'API renvoie parfois un message d'erreur texte avec un code 200
    # (clé invalide, quota dépassé, zone trop grande) : sans en-tête CSV
    # reconnu, mieux vaut échouer bruyamment que publier un lot vide.
    reader = csv.DictReader(io.StringIO(raw))
    if reader.fieldnames is None or "latitude" not in reader.fieldnames:
        raise RuntimeError(f"réponse FIRMS inattendue pour {label} : {raw[:200]!r}")

    west, south, east, north = bbox
    features = []
    for row in reader:
        lon, lat = float(row["longitude"]), float(row["latitude"])
        if not (west <= lon <= east and south <= lat <= north):
            continue
        hhmm = row["acq_time"].zfill(4)
        when = datetime.strptime(
            f"{row['acq_date']} {hhmm}", "%Y-%m-%d %H%M"
        ).replace(tzinfo=timezone.utc)
        if not (start <= when < end_exclusive):
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "source": label,
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
    return features


def write_lot(lot, target, *, run, seen):
    """Même mise en forme que scripts/archive_push.py::write_lot."""
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


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--start", required=True,
                        help="date de début, incluse (YYYY-MM-DD, UTC)")
    parser.add_argument("--end", required=True,
                        help="date de fin, incluse (YYYY-MM-DD, UTC)")
    parser.add_argument("--bbox", nargs=4, type=float, default=DEFAULT_BBOX,
                        metavar=("WEST", "SOUTH", "EAST", "NORTH"))
    parser.add_argument("--outbox", type=pathlib.Path,
                        default=pathlib.Path("outbox-backfill"))
    parser.add_argument("--run", default="backfill",
                        help="identifiant repris dans le nom du lot")
    args = parser.parse_args()

    map_key = os.environ.get("FIRMS_MAP_KEY")
    if not map_key:
        sys.exit(
            "FIRMS_MAP_KEY absente. Clé gratuite : "
            "https://firms.modaps.eosdis.nasa.gov/api/map_key/"
        )

    start = datetime.strptime(args.start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    end_exclusive = (
        datetime.strptime(args.end, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        + timedelta(days=1)
    )
    if end_exclusive <= start:
        sys.exit("--end doit être postérieur ou égal à --start")

    bbox = tuple(args.bbox)
    print(f"bbox {bbox}\nfenêtre {args.start} -> {args.end} (UTC, incluse)\n")

    features = []
    for chunk_start, chunk_end in date_chunks(start, end_exclusive):
        day_range = (chunk_end - chunk_start).days
        # `date` est le DÉBUT de la plage côté API area (day_range avance
        # vers l'avenir) — dans l'autre sens que ce qu'indiquent certaines
        # lectures de la doc FIRMS. Vérifié empiriquement : date=J,
        # day_range=3 renvoie J, J+1, J+2, jamais J-1/J-2.
        date_param = chunk_start.strftime("%Y-%m-%d")
        for label, source in SOURCES:
            raw = fetch_area_csv(map_key, source, bbox, date_param, day_range)
            rows = parse_rows(label, raw, bbox, chunk_start, chunk_end)
            print(f"  {label} [{chunk_start.date()} -> "
                  f"{(chunk_end - timedelta(days=1)).date()}] : "
                  f"{len(rows)} détections")
            features.extend(rows)

    features.sort(key=lambda feature: feature["properties"]["ts"])
    hotspots = {"type": "FeatureCollection", "features": features}

    if not features:
        sys.exit("\naucune détection récupérée : rien à archiver, lot non écrit")

    # `seen` : instant de ce rattrapage, pas de l'observation — la partition
    # (`_p`) suit `ts`, calculée dans flamap/archive.py, donc l'enregistrement
    # rejoint quand même le mois de juillet dans le journal.
    seen = int(time.time())
    lot = build_lot({"hotspots": hotspots}, seen)
    name = f"{start.strftime('%Y%m%d')}-{(end_exclusive - timedelta(days=1)).strftime('%Y%m%d')}-{args.run}"
    target = args.outbox / name
    meta = write_lot(lot, target, run=args.run, seen=seen)

    total = sum(meta["counts"].values())
    print(f"\nlot {name} : {total} enregistrements (firms {meta['counts']['firms']})")
    print(f"écrit dans {target}\n")

    print("pour l'expédier vers le serveur d'archive (rien n'est envoyé "
          "automatiquement — commande à lancer toi-même) :\n")
    alias = os.environ.get("ARCHIVE_SSH_ALIAS")
    if alias:
        # Alias d'~/.ssh/config : user, hôte et clé y sont déjà résolus.
        print(f'  rsync -rt --exclude meta.json {target}/ {alias}:{name}/')
        print(f'  rsync -t {target}/meta.json {alias}:{name}/meta.json')
    else:
        host = os.environ.get("ARCHIVE_SSH_HOST", "<host>")
        user = os.environ.get("ARCHIVE_SSH_USER", "<user>")
        key = os.environ.get("ARCHIVE_SSH_KEY_PATH", "<clé>")
        print(f'  rsync -rt --exclude meta.json -e "ssh -i {key} -o StrictHostKeyChecking=yes" \\\n'
              f'      {target}/ {user}@{host}:{name}/')
        print(f'  rsync -t -e "ssh -i {key} -o StrictHostKeyChecking=yes" \\\n'
              f'      {target}/meta.json {user}@{host}:{name}/meta.json')


if __name__ == "__main__":
    main()
