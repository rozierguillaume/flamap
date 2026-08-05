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


FRONT = load_script("front_resources")
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
                    "dated_count": 1, "fine_wind_zones": [],
                    "wind_fields": [{"file": "wind_coarse.json"},
                                    {"file": "wind_coarse_es.json"}]}
        files = {
            "data/manifest.json": manifest,
            "data/overview_hotspots.geojson": {"features": [{"properties": {"frp": 1}}]},
            "data/burnt_recent.geojson": {"type": "FeatureCollection", "features": []},
            "data/psfdf_fires.geojson": {"type": "FeatureCollection", "features": []},
            "data/timeline.json": [{"kind": "sat", "frp": 1}],
            "data/social_timeline.json": [{"kind": "sat", "frp": 1}],
            "data/wind_coarse.json": {"nt": 2, "temperature": [1, 2], "precipitation": [0, 0],
                                      "u": [1, 2], "v": [1, 2], "gust": [1, 2]},
            "data/wind_coarse_es.json": {"nt": 2, "u": [1, 2], "v": [1, 2], "gust": [1, 2]},
            "data/weather_forecast.json": {"nt": 2, "u": [1, 2], "v": [1, 2], "gust": [1, 2]},
            "data/zones/x%2B00_y%2B41.json": {"id": "x+00_y+41"},
            "data/thermal.json": {"nt": 2, "nx": 45, "ny": 1, "model": "test",
                                  "temperature": [[1], [2]], "precipitation": [[0], [0]]},
        }
        files.update({
            "index.html": b'''<link rel="stylesheet" href="/css/app.css">
<link rel="stylesheet" href="/vendor/maplibre-gl/maplibre-gl.css">
<link rel="preload" href="/fonts/instrument-sans-latin.woff2">
<script src="/vendor/maplibre-gl/maplibre-gl.js"></script>
<script type="module" src="/js/main.js"></script>''',
            "css/app.css": b'@import url("/css/base.css");',
            "css/base.css": b"body {}",
            "js/main.js": b'import "./fx/wind.js"; import "./fx/smoke.js"; import("/vendor/gifenc/gifenc.esm.js");',
            "js/fx/wind.js": b"export {};",
            "js/fx/smoke.js": b"export {};",
            "vendor/maplibre-gl/maplibre-gl.css": b".map {}",
            "vendor/maplibre-gl/maplibre-gl.js": b"window.maplibregl = {};",
            "vendor/gifenc/gifenc.esm.js": b"export {};",
            "fonts/instrument-sans-latin.woff2": b"font",
            "fonts/OFL.txt": b"licence font",
            "vendor/README.md": b"licences vendor",
            "vendor/gifenc/LICENSE.md": b"licence gifenc",
            "vendor/maplibre-gl/LICENSE.txt": b"licence maplibre",
            "site.webmanifest": b"{}",
        })
        for name in FRONT.FRONT_ROOT_FILES + FRONT.PRESERVED_FRONT_FILES:
            files.setdefault(name, f"published:{name}".encode())
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
        for name in ("css/app.css", "js/main.js", "js/fx/wind.js",
                     "vendor/maplibre-gl/maplibre-gl.js",
                     "vendor/gifenc/gifenc.esm.js", "fonts/instrument-sans-latin.woff2"):
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
            self.assertEqual((fire_site / "vendor/gifenc/gifenc.esm.js").read_text(),
                             "local:vendor/gifenc/gifenc.esm.js")
            self.assertEqual((fire_site / "fonts/instrument-sans-latin.woff2").read_text(),
                             "local:fonts/instrument-sans-latin.woff2")

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
            self.assertEqual((weather_site / "js/fx/wind.js").read_bytes(),
                             files["js/fx/wind.js"])
            self.assertEqual((weather_site / "js/fx/smoke.js").read_bytes(),
                             files["js/fx/smoke.js"])
            self.assertEqual((weather_site / "css/base.css").read_bytes(),
                             files["css/base.css"])
            self.assertEqual((weather_site / "vendor/maplibre-gl/maplibre-gl.js").read_bytes(),
                             files["vendor/maplibre-gl/maplibre-gl.js"])
            self.assertEqual((weather_site / "vendor/gifenc/gifenc.esm.js").read_bytes(),
                             files["vendor/gifenc/gifenc.esm.js"])
            self.assertEqual((weather_site / "fonts/instrument-sans-latin.woff2").read_bytes(),
                             files["fonts/instrument-sans-latin.woff2"])
            self.assertEqual((weather_site / "vendor/gifenc/LICENSE.md").read_bytes(),
                             files["vendor/gifenc/LICENSE.md"])
            self.assertEqual((weather_site / "data/thermal.json").read_bytes(),
                             files["data/thermal.json"])

            (weather_site / "js/fx/wind.js").unlink()
            with self.assertRaises(SystemExit):
                VALIDATE.validate_weather_site(weather_site)

    def test_history_recovery_keeps_only_downloaded_zones_for_the_diff(self):
        files = self.fixture_files()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            DOWNLOAD.recover_fire_history("https://fixture", root / "data", root / "prev",
                                          open_url=self.open_fixture(files))
            self.assertEqual(json.loads((root / "prev/manifest.json").read_text())["zones"],
                             ["x+00_y+41"])
            self.assertTrue((root / "prev/zones/x+00_y+41.json").exists())

    def test_current_front_closure_includes_imported_assets(self):
        resources = FRONT.front_closure(lambda name: (ROOT / name).read_bytes())
        self.assertTrue({
            "css/base.css", "css/tokens.css", "css/map.css", "css/components.css",
            "css/responsive.css", "js/fx/wind.js", "js/fx/smoke.js",
            "vendor/maplibre-gl/maplibre-gl.css", "vendor/maplibre-gl/maplibre-gl.js",
            "vendor/gifenc/gifenc.esm.js", "fonts/instrument-sans-latin.woff2",
        }.issubset(resources))
        self.assertTrue(all((ROOT / name).exists() for name in FRONT.PRESERVED_FRONT_FILES))


if __name__ == "__main__":
    unittest.main()
