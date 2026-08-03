"""Fixtures locales des trois variantes d'assemblage Pages."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]


def load_script(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


DOWNLOAD = load_script("download_live_artifact")
ASSEMBLE = load_script("assemble_site")
VALIDATE = load_script("validate_export")


class Response:
    def __init__(self, payload: bytes):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self) -> bytes:
        return self.payload


class WorkflowScriptsTest(unittest.TestCase):
    def fixture_files(self) -> dict[str, bytes]:
        manifest = {"zones": ["x+00_y+41"], "hotspot_count": 1,
                    "dated_count": 1, "fine_wind_zones": []}
        files = {
            "data/manifest.json": manifest,
            "data/overview_hotspots.geojson": {"features": [{"properties": {"frp": 1}}]},
            "data/burnt_recent.geojson": {"type": "FeatureCollection", "features": []},
            "data/psfdf_fires.geojson": {"type": "FeatureCollection", "features": []},
            "data/timeline.json": [{"kind": "sat", "frp": 1}],
            "data/social_timeline.json": [{"kind": "sat", "frp": 1}],
            "data/wind_coarse.json": {"nt": 2, "temperature": [1, 2], "precipitation": [0, 0]},
            "data/weather_forecast.json": {"nt": 2, "u": [1, 2], "v": [1, 2], "gust": [1, 2]},
            "data/zones/x%2B00_y%2B41.json": {"id": "x+00_y+41"},
            "data/thermal.json": {"nt": 2, "nx": 45, "ny": 1, "model": "test",
                                  "temperature": [[1], [2]], "precipitation": [[0], [0]]},
        }
        for name in DOWNLOAD.PUBLISHED_FRONT_FILES:
            files[name] = f"published:{name}".encode()
        return {name: json.dumps(value).encode() if isinstance(value, (dict, list)) else value
                for name, value in files.items()}

    def open_fixture(self, files):
        def open_url(url, timeout):
            relative = url.split("https://fixture/", 1)[1]
            if relative == "data/social_timeline.json":
                raise OSError("missing social history")
            return Response(files[relative])
        return open_url

    def write_front(self, root: pathlib.Path) -> None:
        for name in ASSEMBLE.FRONT_FILES:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"local:{name}")
        for name in ("css/app.css", "js/main.js", "js/fx/wind.js"):
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"local:{name}")

    def test_front_weather_and_fire_modes_keep_their_own_substitutions(self):
        files = self.fixture_files()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source, data = root / "source", root / "data"
            source.mkdir()
            self.write_front(source)
            for name, payload in files.items():
                relative = name.removeprefix("data/").replace("%2B", "+")
                target = data / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(payload)

            fire_site = root / "fire"
            ASSEMBLE.assemble_fire(source, data, fire_site)
            VALIDATE.validate_fire_data(data)
            VALIDATE.check_size(fire_site)
            self.assertEqual((fire_site / "js/fx/wind.js").read_text(), "local:js/fx/wind.js")

            front_site = root / "front"
            DOWNLOAD.download_artifact("https://fixture", front_site,
                                       open_url=self.open_fixture(files))
            ASSEMBLE.assemble_front(source, front_site)
            VALIDATE.validate_front_site(front_site)
            self.assertEqual((front_site / "index.html").read_text(), "local:index.html")
            self.assertEqual((front_site / "data/social_timeline.json").read_bytes(),
                             files["data/timeline.json"])

            weather_site = root / "weather"
            DOWNLOAD.download_artifact("https://fixture", weather_site, include_front=True,
                                       open_url=self.open_fixture(files))
            ASSEMBLE.assemble_weather(data, weather_site)
            VALIDATE.validate_weather_site(weather_site)
            # La liste publiée est intentionnellement celle du workflow météo
            # antérieur. Son omission préexistante de fx/ est hors lot 15.
            self.assertFalse((weather_site / "js/fx/wind.js").exists())
            self.assertEqual((weather_site / "data/thermal.json").read_bytes(),
                             files["data/thermal.json"])

    def test_history_recovery_keeps_only_downloaded_zones_for_the_diff(self):
        files = self.fixture_files()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            DOWNLOAD.recover_fire_history("https://fixture", root / "data", root / "prev",
                                          open_url=self.open_fixture(files))
            self.assertEqual(json.loads((root / "prev/manifest.json").read_text())["zones"],
                             ["x+00_y+41"])
            self.assertTrue((root / "prev/zones/x+00_y+41.json").exists())


if __name__ == "__main__":
    unittest.main()
