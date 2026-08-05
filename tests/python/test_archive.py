"""Lots d'archive : empreintes de contenu et réassemblage depuis les zones.

La fusion côté serveur est testée dans le dépôt `flamap-archive`, qui ne connaît
des lots que leurs champs `_k` et `_p`.
"""

from __future__ import annotations

import gzip
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from flamap.archive import (  # noqa: E402
    build_lot,
    effis_records,
    firms_records,
    period,
    psfdf_records,
    record_key,
)


def load(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


PUSH = load("archive_push", ROOT / "scripts" / "archive_push.py")

JULY = 1784536000  # 20 juillet 2026, 08:26:40 UTC


def hotspot(ts=JULY, lon=2.5, lat=44.0, frp=12.5):
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "source": "VIIRS/NOAA-20", "ts": ts, "t": "2026-07-20T08:00:00",
            "brightness": 330.1, "frp": frp, "confidence": "n",
            "daynight": "D", "scan": 0.4, "track": 0.36,
        },
    }


def polygon(identifier="d-1", lu=JULY, area=42.0, shift=0.0):
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [[
            [2.0 + shift, 44.0], [3.0 + shift, 44.0],
            [3.0 + shift, 45.0], [2.0 + shift, 44.0],
        ]]},
        "properties": {
            "_id": identifier, "ts": JULY - 86400, "lu": lu,
            "AREA_HA": area, "COUNTRY": "FR", "PROVINCE": "Gard",
        },
    }


def fire(identifier="7", status="En cours", updated=JULY, personnel=40):
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [2.5, 44.0]},
        "properties": {
            "id": identifier, "status": status, "commune": "Générac",
            "departement": "Gard", "updated_ts": updated,
            "updated": "20/07/2026 10:00", "surface": 120.0,
            "personnel": personnel, "canadair": 2,
        },
    }


class RecordKeyTest(unittest.TestCase):
    def test_empreinte_ignore_les_metadonnees(self):
        """Deux collectes du même état doivent produire la même empreinte."""
        first = list(firms_records({"features": [hotspot()]}, seen=JULY))[0]
        second = list(firms_records({"features": [hotspot()]}, seen=JULY + 3600))[0]
        self.assertEqual(first["_k"], second["_k"])
        self.assertNotEqual(first["_seen"], second["_seen"])

    def test_detection_differente_change_l_empreinte(self):
        first = list(firms_records({"features": [hotspot()]}, seen=JULY))[0]
        other = list(firms_records({"features": [hotspot(frp=13.0)]}, seen=JULY))[0]
        self.assertNotEqual(first["_k"], other["_k"])

    def test_changement_de_statut_psfdf_cree_une_version(self):
        base = list(psfdf_records({"features": [fire()]}, seen=JULY))[0]
        moved = list(psfdf_records(
            {"features": [fire(status="Fixé")]}, seen=JULY))[0]
        self.assertNotEqual(base["_k"], moved["_k"])

    def test_renfort_sans_changement_de_date_cree_une_version(self):
        """PSFDF fait varier les moyens sans toujours avancer Date_MAJ."""
        base = list(psfdf_records({"features": [fire()]}, seen=JULY))[0]
        reinforced = list(psfdf_records(
            {"features": [fire(personnel=180)]}, seen=JULY))[0]
        self.assertNotEqual(base["_k"], reinforced["_k"])

    def test_perimetre_affine_sans_lastupdate_cree_une_version(self):
        """EFFIS retouche parfois un contour sans avancer LASTUPDATE."""
        base = list(effis_records({"features": [polygon()]}, seen=JULY))[0]
        refined = list(effis_records(
            {"features": [polygon(shift=0.01)]}, seen=JULY))[0]
        self.assertNotEqual(base["_k"], refined["_k"])
        self.assertEqual(base["lu"], refined["lu"])

    def test_region_de_collecte_ne_change_pas_l_empreinte(self):
        """`_r` est une métadonnée de collecte, pas un attribut EFFIS.

        La laisser entrer dans l'empreinte referait une ligne neuve pour chaque
        périmètre déjà archivé.
        """
        tagged = polygon()
        tagged["properties"]["_r"] = "fr"
        base = list(effis_records({"features": [polygon()]}, seen=JULY))[0]
        with_region = list(effis_records({"features": [tagged]}, seen=JULY))[0]
        self.assertEqual(base["_k"], with_region["_k"])
        self.assertNotIn("_r", with_region["props"])

    def test_partition_mensuelle_suit_l_observation(self):
        record = list(firms_records({"features": [hotspot()]}, seen=JULY))[0]
        self.assertEqual(record["_p"], period(JULY))
        self.assertEqual(record["_p"], "2026-07")

    def test_perimetre_partitionne_sur_la_mise_a_jour(self):
        record = list(effis_records({"features": [polygon()]}, seen=JULY))[0]
        self.assertEqual(record["_p"], period(JULY))

    def test_fiche_sans_horodatage_est_conservee(self):
        """Un champ manquant ne doit jamais faire disparaître un incendie."""
        feature = fire()
        del feature["properties"]["updated_ts"]
        records = list(psfdf_records({"features": [feature]}, seen=JULY))
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["_p"], "2026-07")
        # Deux collectes de cette même fiche restent une seule ligne archivée.
        later = list(psfdf_records({"features": [feature]}, seen=JULY + 7200))
        self.assertEqual(records[0]["_k"], later[0]["_k"])

    def test_perimetre_sans_date_est_conserve(self):
        feature = polygon()
        feature["properties"].pop("lu")
        feature["properties"].pop("ts")
        records = list(effis_records({"features": [feature]}, seen=JULY))
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["_p"], "2026-07")

    def test_empreinte_tient_dans_un_entier_signe(self):
        key = record_key({"a": "x" * 500})
        self.assertTrue(-(2 ** 63) <= key < 2 ** 63)


class LotTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def write_export(self, data: pathlib.Path):
        zones = data / "zones"
        zones.mkdir(parents=True)
        # Un polygone à cheval est écrit dans les deux cellules qu'il touche.
        for name in ("x2y44", "x3y44"):
            with (zones / f"{name}.json").open("w", encoding="utf-8") as out:
                json.dump({
                    "id": name,
                    "hotspots": {"features": [hotspot(lon=2.5 if name == "x2y44"
                                                      else 3.5)]},
                    "burnt_dated": {"features": [polygon()]},
                    "burnt_nrt": {"features": []},
                }, out)
        with (data / "psfdf_fires.geojson").open("w", encoding="utf-8") as out:
            json.dump({"features": [fire()]}, out)
        with (data / "manifest.json").open("w", encoding="utf-8") as out:
            json.dump({"generated_at": "2026-07-20T08:26:40+00:00"}, out)

    def test_reassemblage_dedoublonne_les_polygones_a_cheval(self):
        data = self.root / "data"
        self.write_export(data)
        export = PUSH.collect_export(data)
        self.assertEqual(len(export["hotspots"]["features"]), 2)
        self.assertEqual(len(export["burnt_dated"]["features"]), 1)
        self.assertEqual(len(export["psfdf"]["features"]), 1)

    def test_le_lot_reprend_l_instant_du_manifeste(self):
        """Un lot rejoué doit produire exactement les mêmes lignes."""
        data = self.root / "data"
        self.write_export(data)
        seen = PUSH.collection_time(data)
        self.assertEqual(seen, JULY)

    def test_ecriture_du_lot(self):
        data = self.root / "data"
        self.write_export(data)
        lot = build_lot(PUSH.collect_export(data), seen=JULY)
        meta = PUSH.write_lot(lot, self.root / "outbox" / "essai",
                              run="essai", seen=JULY)
        self.assertEqual(meta["counts"]["firms"], 2)
        self.assertEqual(meta["counts"]["psfdf"], 1)
        path = self.root / "outbox" / "essai" / "firms.ndjson.gz"
        with gzip.open(path, "rt", encoding="utf-8") as source:
            lines = [json.loads(line) for line in source if line.strip()]
        self.assertEqual(len(lines), 2)
        self.assertTrue(all("_k" in line and "_p" in line for line in lines))


if __name__ == "__main__":
    unittest.main()
