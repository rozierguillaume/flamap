"""Tests de caractérisation des règles métier les plus risquées."""

from __future__ import annotations

import copy
import json
import pathlib
import sys
import unittest
from datetime import datetime as RealDateTime
from unittest import mock
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT))

NETWORK_GUARD = mock.patch.object(
    urllib.request,
    "urlopen",
    side_effect=AssertionError("un test a tenté d'accéder au réseau"),
)
NETWORK_GUARD.start()

import fetch_fires as fires  # noqa: E402


def tearDownModule():
    NETWORK_GUARD.stop()


def load_json(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def hotspot(ts: int, source: str, frp: float, lon=2.0, lat=46.0):
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"ts": ts, "source": source, "frp": frp},
    }


class FrozenDateTime(RealDateTime):
    @classmethod
    def now(cls, tz=None):
        fixed = cls(2026, 8, 2, 12, 0, tzinfo=fires.PARIS_TZ)
        return fixed if tz is None else fixed.astimezone(tz)


class PsfdfTests(unittest.TestCase):
    def test_ambiguous_dates_follow_the_nearest_order(self):
        now = RealDateTime(2026, 8, 2, 12, tzinfo=fires.PARIS_TZ)
        french = fires.psfdf_timestamp("01/08/2026 à 14:30:05", now=now)
        american = fires.psfdf_timestamp("8/1/2026 15:45", now=now)

        self.assertEqual(
            french,
            int(RealDateTime(2026, 8, 1, 14, 30, 5,
                             tzinfo=fires.PARIS_TZ).timestamp()),
        )
        self.assertEqual(
            american,
            int(RealDateTime(2026, 8, 1, 15, 45,
                             tzinfo=fires.PARIS_TZ).timestamp()),
        )
        self.assertIsNone(fires.psfdf_timestamp("31/31/2026", now=now))

    def test_psfdf_fixture_is_filtered_normalized_and_sorted(self):
        payload = (FIXTURES / "psfdf.json").read_bytes()
        with (
            mock.patch.object(fires, "get", return_value=payload),
            mock.patch.object(fires, "datetime", FrozenDateTime),
        ):
            result = fires.fetch_psfdf(fires.DEFAULT_BBOX)

        self.assertEqual(
            [feature["properties"]["id"] for feature in result["features"]],
            ["fr-date", "us-date"],
        )
        first, second = result["features"]
        self.assertEqual(first["geometry"]["coordinates"], [6.1, 43.5])
        self.assertEqual(first["properties"]["surface"], 1234.5)
        self.assertEqual(second["properties"]["status"], "Maîtrisé")


class EffisTests(unittest.TestCase):
    def test_swap_axes_handles_nested_geometries(self):
        geometry = {
            "type": "GeometryCollection",
            "geometries": [
                {"type": "Point", "coordinates": [43.5, 6.2]},
                {
                    "type": "MultiLineString",
                    "coordinates": [[[44.0, 7.0], [44.1, 7.1]]],
                },
            ],
        }

        fires.swap_axes(geometry)

        self.assertEqual(geometry["geometries"][0]["coordinates"], [6.2, 43.5])
        self.assertEqual(
            geometry["geometries"][1]["coordinates"],
            [[[7.0, 44.0], [7.1, 44.1]]],
        )

    def test_effis_fixture_keeps_france_swaps_axes_and_stabilizes_ids(self):
        dated = load_json("effis.geojson")
        nrt = fires.fc([{
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [43.6, 6.3]},
            "properties": {},
        }])
        with mock.patch.object(
            fires, "effis_wfs", side_effect=[copy.deepcopy(dated), nrt]
        ):
            result = fires.fetch_burnt(fires.DEFAULT_BBOX)

        kept = result["burnt_dated"]["features"]
        self.assertEqual(len(kept), 2)
        self.assertEqual(kept[0]["geometry"]["coordinates"][0][0], [6.1, 43.1])
        self.assertEqual(kept[0]["properties"]["_id"], "d-fr-1")
        self.assertEqual(kept[1]["properties"]["_id"], "d-bff9c460bcb66c08")
        self.assertEqual(
            result["burnt_nrt"]["features"][0]["geometry"]["coordinates"],
            [6.3, 43.6],
        )
        self.assertEqual(
            result["burnt_nrt"]["features"][0]["properties"]["_id"],
            "n-4100734dc402dc8d",
        )


class FirmsAndTimelineTests(unittest.TestCase):
    def test_firms_fixture_respects_inclusive_geographic_bounds(self):
        raw = (FIXTURES / "firms.csv").read_text(encoding="utf-8")
        with (
            mock.patch.object(fires, "FIRMS_FEEDS", [("fixture", "local")]),
            mock.patch.object(
                fires, "download_firms_feed", return_value=(raw, None)
            ),
        ):
            result = fires.fetch_hotspots(fires.FRANCE_BOXES)

        coordinates = [
            feature["geometry"]["coordinates"] for feature in result["features"]
        ]
        self.assertEqual(len(coordinates), 4)
        self.assertIn([-5.5, 41.0], coordinates)
        self.assertIn([10.0, 51.5], coordinates)
        self.assertNotIn([10.1, 48.85], coordinates)
        self.assertEqual(result["features"][0]["properties"]["ts"], 1785542700)

    def test_aggregates_share_cell_hour_and_source_only(self):
        features = [
            hotspot(3605, "A", 1.111, -0.01, 46.01),
            hotspot(3660, "A", 2.224, -0.02, 46.02),
            hotspot(3700, "B", 4.0, -0.02, 46.02),
            hotspot(7200, "A", 8.0, -0.02, 46.02),
        ]

        result = fires.aggregate_hotspots(fires.fc(features))["features"]

        self.assertEqual(len(result), 3)
        first = next(
            feature for feature in result
            if feature["properties"]["source"] == "A"
            and feature["properties"]["ts"] == 3600
        )
        self.assertEqual(first["geometry"]["coordinates"], [-0.125, 46.125])
        self.assertEqual(first["properties"]["n"], 2)
        self.assertEqual(first["properties"]["frp"], 3.33)

    def test_timeline_groups_passes_and_bounds_effis_to_firms_window(self):
        hotspots = fires.fc([
            hotspot(1000, "A", 1.11),
            hotspot(1200, "B", 4.0),
            hotspot(2499, "A", 2.22),
            hotspot(4000, "A", 8.0),
        ])
        dated = fires.fc([
            {"properties": {"lu": 900, "AREA_HA": 99}},
            {"properties": {"lu": 2600, "AREA_HA": "1.1"}},
            {"properties": {"lu": 2600, "AREA_HA": "2.2"}},
            {"properties": {"lu": 4200, "AREA_HA": "inconnu"}},
        ])

        result = fires.build_timeline(hotspots, dated)

        self.assertEqual([step["ts"] for step in result], [1000, 1200, 2600, 4000, 4200])
        self.assertEqual(result[0]["n"], 2)
        self.assertEqual(result[0]["frp"], 3.33)
        self.assertEqual(result[2]["n"], 2)
        self.assertEqual(result[2]["ha"], 3.3)
        self.assertEqual(result[-1]["ha"], 0)

    def test_iberian_boxes_leave_north_africa_out_of_the_domain(self):
        boxes = fires.domain_boxes(fires.REGIONS)
        inside = {
            "Lisbonne": (-9.14, 38.72),
            "Almeria": (-2.46, 36.84),
            "Majorque": (2.65, 39.57),
            "Bordeaux": (-0.58, 44.84),
        }
        outside = {
            "Alger": (3.06, 36.75),
            "Oran": (-0.64, 35.70),
            "Tanger": (-5.80, 35.77),
            "Annaba": (7.75, 36.90),
        }
        for label, (lon, lat) in inside.items():
            self.assertTrue(fires.in_any_bbox(boxes, lon, lat), label)
        for label, (lon, lat) in outside.items():
            self.assertFalse(fires.in_any_bbox(boxes, lon, lat), label)

    def test_domain_tiles_skip_the_cells_of_the_bounding_envelope(self):
        cells = fires.domain_tiles(fires.REGIONS)
        self.assertEqual(len(cells), len(set(cells)))
        self.assertIn((-4, 39), cells)          # Espagne centrale
        self.assertIn((2, 48), cells)           # bassin parisien
        self.assertNotIn((-9, 50), cells)       # Atlantique nord
        self.assertNotIn((8, 37), cells)        # Mediterranee au large de Tunis
        self.assertLess(
            len(cells),
            len(fires.tile_range(fires.union_bbox(fires.domain_boxes(fires.REGIONS)))),
        )

    def test_command_line_bbox_collects_a_single_french_region(self):
        regions = fires.cli_regions((-1.6, 44.2, -0.2, 45.4))
        self.assertEqual(len(regions), 1)
        self.assertEqual(regions[0]["boxes"], ((-1.6, 44.2, -0.2, 45.4),))
        self.assertTrue(regions[0]["fine_wind"])
        self.assertTrue(regions[0]["psfdf"])
        self.assertEqual(fires.REGIONS[0]["boxes"], fires.FRANCE_BOXES)

    def test_the_first_collected_region_writes_the_reference_field(self):
        """Le nom et la temperature suivent le rang, pas la region."""
        plan = fires.collection_plan(fires.REGIONS)
        self.assertEqual([region["wind_file"] for region in plan],
                         ["wind_coarse.json", "wind_coarse_es.json"])
        self.assertEqual([region["temperature"] for region in plan], [True, False])

        alone = fires.collection_plan(fires.REGIONS[1:])
        self.assertEqual(alone[0]["wind_file"], "wind_coarse.json")
        self.assertTrue(alone[0]["temperature"],
                        "le champ de reference porte la temperature de repli")
        self.assertFalse(alone[0]["fine_wind"])

    def test_exact_north_and_east_edges_do_not_create_extra_tiles(self):
        self.assertEqual(fires.tile_range((1, 43, 2, 44)), [(1, 43)])
        feature = {
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[1, 43], [2, 43], [2, 44], [1, 43]]],
            }
        }
        self.assertEqual(fires.feature_tiles(feature), [(1, 43)])


class WeatherExportTests(unittest.TestCase):
    def setUp(self):
        self.fixture = load_json("meteo.json")
        self.wind = fires.build_wind(
            self.fixture["box"],
            self.fixture["nx"],
            self.fixture["ny"],
            self.fixture["series"],
            "fixture",
            temperature=True,
        )

    def test_build_wind_converts_vectors_but_gusts_only_once(self):
        self.assertEqual(self.wind["u"][0], [-1.0, 2.0])
        self.assertEqual(self.wind["v"][0], [-0.0, 0.0])
        self.assertEqual(self.wind["gust"][0], [36, 72])
        self.assertEqual(self.wind["temperature"][1], [11.1, 21.1])
        self.assertEqual(self.wind["precipitation"][1], [0.13, 0.02])

    def test_weather_forecast_exports_only_the_centered_wind_window(self):
        now = self.wind["t0"] + 2 * self.wind["dt"]

        result = fires.weather_forecast(self.wind, now, hours=1)

        self.assertEqual(result["bbox"], [1.1235, 42.1235, 2.9877, 43.9877])
        self.assertEqual(result["t0"], self.wind["t0"] + self.wind["dt"])
        self.assertEqual(result["nt"], 3)
        self.assertEqual(result["gust"], self.wind["gust"][1:4])
        self.assertNotIn("temperature", result)
        self.assertNotIn("precipitation", result)

    def test_thermal_export_keeps_its_independent_centered_window(self):
        now = self.wind["t0"] + 2 * self.wind["dt"]

        result = fires.thermal_export(self.wind, now, hours=1)

        self.assertEqual(result["t0"], self.wind["t0"] + self.wind["dt"])
        self.assertEqual(result["nt"], 3)
        self.assertEqual(result["temperature"], self.wind["temperature"][1:4])
        self.assertEqual(result["precipitation"], self.wind["precipitation"][1:4])
        self.assertNotIn("u", result)


if __name__ == "__main__":
    unittest.main()
