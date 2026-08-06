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
    WIND_SETTLED_S,
    build_lot,
    effis_records,
    firms_records,
    period,
    psfdf_records,
    record_key,
    wind_records,
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


def grid(t0=JULY - 4 * 3600, nt=8, dt=3600, model="meteofrance_arome_france_hd",
         gust=18):
    """Grille minuscule au format publié, deux points, quelques crans."""
    return {
        "model": model, "unit": "m/s", "bbox": [2.0, 44.0, 3.0, 44.0],
        "nx": 2, "ny": 1, "t0": t0, "dt": dt, "nt": nt,
        "u": [[1.0 + step, 2.0] for step in range(nt)],
        "v": [[-3.0, 0.5] for _ in range(nt)],
        "gust": [[gust, 22] for _ in range(nt)],
    }


class WindTest(unittest.TestCase):
    def test_les_crans_de_prevision_ne_sont_pas_archives(self):
        """La queue de prévision est réécrite à chaque run : elle ne s'archive pas.

        Seules les heures antérieures d'au moins `WIND_SETTLED_S` à la collecte
        sont conservées ; les suivantes reviendront quand elles seront figées.
        """
        # Crans de JULY - 4 h à JULY + 3 h, seuil à JULY - 3 h.
        records = list(wind_records({"coarse:fr": grid()}, seen=JULY))
        self.assertEqual([record["ts"] for record in records],
                         [JULY - 4 * 3600, JULY - 3 * 3600])
        self.assertEqual(JULY - records[-1]["ts"], WIND_SETTLED_S)

    def test_une_heure_figee_ne_se_reecrit_pas(self):
        """Le cœur du dispositif : une heure passée n'a qu'une version.

        Sans quoi la même heure serait archivée quarante-huit fois par jour.
        """
        first = list(wind_records({"coarse:fr": grid()}, seen=JULY))
        later = list(wind_records({"coarse:fr": grid()}, seen=JULY + 7200))
        keys = {record["_k"] for record in first}
        self.assertTrue(keys.issubset({record["_k"] for record in later}))
        # La collecte suivante apporte les heures devenues figées entre-temps.
        self.assertGreater(len(later), len(first))

    def test_grossier_et_fin_ne_se_confondent_pas(self):
        """Deux mailles sur le même point et la même heure sont deux lignes."""
        fields = {"coarse:fr": grid(), "fine:x+02_y+44": grid()}
        records = list(wind_records(fields, seen=JULY))
        self.assertEqual(len({record["_k"] for record in records}),
                         len(records))
        self.assertEqual({record["field"] for record in records}, set(fields))

    def test_bascule_de_modele_cree_une_version(self):
        """AROME indisponible, `best_match` prend la suite : ce n'est pas le même champ."""
        arome = list(wind_records({"coarse:fr": grid()}, seen=JULY))[0]
        fallback = list(wind_records(
            {"coarse:fr": grid(model="best_match")}, seen=JULY))[0]
        self.assertNotEqual(arome["_k"], fallback["_k"])
        self.assertEqual(arome["ts"], fallback["ts"])

    def test_valeur_revisee_cree_une_version(self):
        revised = grid()
        revised["gust"][0][0] = 19
        base = list(wind_records({"coarse:fr": grid()}, seen=JULY))[0]
        other = list(wind_records({"coarse:fr": revised}, seen=JULY))[0]
        self.assertNotEqual(base["_k"], other["_k"])

    def test_partition_suit_l_heure_meteo(self):
        """Une heure de juillet archivée en août appartient à juillet."""
        august = JULY + 13 * 86400  # 2 août 2026
        records = list(wind_records(
            {"coarse:fr": grid(t0=JULY, nt=2)}, seen=august))
        self.assertEqual([record["_p"] for record in records], ["2026-07"] * 2)
        self.assertEqual(records[0]["_seen"], august)

    def test_champ_sans_base_de_temps_est_ignore(self):
        """Un export tronqué ne doit pas faire tomber la collecte entière."""
        broken = grid()
        del broken["t0"]
        self.assertEqual(list(wind_records(
            {"coarse:fr": broken, "fine:x": None}, seen=JULY)), [])


class LotTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def write_export(self, data: pathlib.Path, manifest=None):
        zones = data / "zones"
        zones.mkdir(parents=True)
        # Un polygone à cheval est écrit dans les deux cellules qu'il touche ;
        # le vent fin, lui, n'existe que pour la cellule active.
        for name in ("x2y44", "x3y44"):
            with (zones / f"{name}.json").open("w", encoding="utf-8") as out:
                json.dump({
                    "id": name,
                    "hotspots": {"features": [hotspot(lon=2.5 if name == "x2y44"
                                                      else 3.5)]},
                    "burnt_dated": {"features": [polygon()]},
                    "burnt_nrt": {"features": []},
                    "wind": grid() if name == "x2y44" else None,
                }, out)
        with (data / "psfdf_fires.geojson").open("w", encoding="utf-8") as out:
            json.dump({"features": [fire()]}, out)
        for name in ("wind_coarse.json", "wind_coarse_es.json"):
            with (data / name).open("w", encoding="utf-8") as out:
                json.dump(grid(), out)
        payload = {"generated_at": "2026-07-20T08:26:40+00:00"}
        payload.update(manifest if manifest is not None else {
            "regions": [{"id": "fr"}, {"id": "es"}],
            "wind_fields": [{"id": "fr", "file": "wind_coarse.json"},
                            {"id": "es", "file": "wind_coarse_es.json"}],
        })
        with (data / "manifest.json").open("w", encoding="utf-8") as out:
            json.dump(payload, out)

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

    def test_reassemblage_du_vent_grossier_et_fin(self):
        data = self.root / "data"
        self.write_export(data)
        wind = PUSH.collect_export(data)["wind"]
        self.assertEqual(set(wind), {"coarse:fr", "coarse:es", "fine:x2y44"})

    def test_champ_grossier_nomme_par_la_region_a_defaut_d_identifiant(self):
        """Exports antérieurs à l'archivage du vent : `wind_fields` n'a pas d'`id`.

        Le repli sur `regions`, construit dans le même ordre, doit donner le
        même nom de champ — sinon la bascule reproduirait dix jours de grille.
        """
        data = self.root / "data"
        self.write_export(data, manifest={
            "regions": [{"id": "fr"}, {"id": "es"}],
            "wind_fields": [{"file": "wind_coarse.json"},
                            {"file": "wind_coarse_es.json"}],
        })
        self.assertEqual(set(PUSH.collect_export(data)["wind"]),
                         {"coarse:fr", "coarse:es", "fine:x2y44"})

    def test_manifeste_sans_champ_de_vent_reste_exploitable(self):
        data = self.root / "data"
        self.write_export(data, manifest={})
        export = PUSH.collect_export(data)
        self.assertEqual(set(export["wind"]), {"fine:x2y44"})
        self.assertEqual(len(export["hotspots"]["features"]), 2)

    def test_ecriture_du_lot(self):
        data = self.root / "data"
        self.write_export(data)
        lot = build_lot(PUSH.collect_export(data), seen=JULY)
        meta = PUSH.write_lot(lot, self.root / "outbox" / "essai",
                              run="essai", seen=JULY)
        self.assertEqual(meta["counts"]["firms"], 2)
        self.assertEqual(meta["counts"]["psfdf"], 1)
        # Trois champs de vent, deux crans figés chacun.
        self.assertEqual(meta["counts"]["wind"], 6)
        self.assertTrue(
            (self.root / "outbox" / "essai" / "wind.ndjson.gz").exists())
        path = self.root / "outbox" / "essai" / "firms.ndjson.gz"
        with gzip.open(path, "rt", encoding="utf-8") as source:
            lines = [json.loads(line) for line in source if line.strip()]
        self.assertEqual(len(lines), 2)
        self.assertTrue(all("_k" in line and "_p" in line for line in lines))


if __name__ == "__main__":
    unittest.main()
