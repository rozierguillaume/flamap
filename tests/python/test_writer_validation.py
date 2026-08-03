"""Caractérisation de l'écriture préparée des exports publics."""

import json
import os
import pathlib
import tempfile
import unittest
from unittest import mock

from flamap.validation import validate_export, validate_thermal
from flamap.writer import publish_export, publish_json


def export_payload():
    zone = {
        "id": "x+01_y+43", "bbox": [1, 43, 2, 44],
        "hotspots": {"type": "FeatureCollection", "features": []},
        "burnt_dated": {"type": "FeatureCollection", "features": []},
        "burnt_nrt": {"type": "FeatureCollection", "features": []},
        "wind": None,
    }
    return {
        "overview_hotspots.geojson": {
            "type": "FeatureCollection", "features": [{"properties": {"frp": 1.2}}],
        },
        "burnt_recent.geojson": {"type": "FeatureCollection", "features": []},
        "psfdf_fires.geojson": {"type": "FeatureCollection", "features": []},
        "timeline.json": [{"kind": "sat", "frp": 1.2}],
        "social_timeline.json": [],
        "wind_coarse.json": {
            "nt": 2, "temperature": [[1], [2]], "precipitation": [[0], [0]],
        },
        "weather_forecast.json": {
            "nt": 2, "u": [[0], [0]], "v": [[0], [0]], "gust": [[0], [0]],
        },
        "manifest.json": {
            "hotspot_count": 1, "zones": ["x+01_y+43"], "fine_wind_zones": [],
        },
    }, {"x+01_y+43": zone}


class WriterTests(unittest.TestCase):
    def test_validated_export_replaces_manifest_last_and_keeps_thermal(self):
        files, zones = export_payload()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, "data")
            root.mkdir()
            (root / "thermal.json").write_text('{"old":true}', encoding="utf-8")
            (root / "hors-perimetre.txt").write_text("préservé", encoding="utf-8")
            (root / "manifest.json").write_text('{"old":true}', encoding="utf-8")

            with (
                mock.patch("flamap.writer.os.replace", wraps=os.replace) as replace,
                mock.patch("flamap.writer.shutil.copytree") as copytree,
            ):
                publish_export(str(root), files, zones)

            self.assertEqual(json.loads((root / "thermal.json").read_text()), {"old": True})
            self.assertEqual((root / "hors-perimetre.txt").read_text(), "préservé")
            copytree.assert_not_called()
            self.assertEqual(
                json.loads((root / "manifest.json").read_text())["zones"], ["x+01_y+43"]
            )
            validate_export(str(root))
            visible = [
                pathlib.Path(call.args[1]).name for call in replace.call_args_list
                if pathlib.Path(call.args[1]).parent == root
            ]
            self.assertEqual(visible[-1], "manifest.json")

    def test_invalid_staging_never_replaces_the_previous_manifest(self):
        files, zones = export_payload()
        files["timeline.json"] = []
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory, "data")
            root.mkdir()
            (root / "manifest.json").write_text('{"old":true}', encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "frise satellite"):
                publish_export(str(root), files, zones)

            self.assertEqual((root / "manifest.json").read_text(), '{"old":true}')

    def test_thermal_is_validated_before_its_atomic_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory, "thermal.json")
            path.write_text('{"old":true}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "export thermique"):
                publish_json(str(path), {"nt": 1}, validate=validate_thermal)
            self.assertEqual(path.read_text(), '{"old":true}')


if __name__ == "__main__":
    unittest.main()
