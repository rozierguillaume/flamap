"""Caracterisation de la detection heuristique hors couverture PSFDF."""

import unittest
from unittest import mock

import fetch_fires as cli
from flamap import heuristic_fires


def hotspot(lon, lat, ts):
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"ts": ts},
    }


class HeuristicFiresTests(unittest.TestCase):
    def test_dense_cluster_becomes_a_circle_sparse_points_do_not(self):
        now = 1_000_000
        dense = [hotspot(2.0 + i * 0.01, 40.0, now - 60) for i in range(8)]
        sparse = [hotspot(5.0, 40.0, now - 60), hotspot(5.2, 40.0, now - 60)]
        hotspots = heuristic_fires.fc(dense + sparse)

        result = heuristic_fires.detect_heuristic_fires(
            hotspots, (0, 39, 10, 41), now=now,
            min_hotspots=8, radius_km=10, max_age_hours=72,
        )

        self.assertEqual(len(result["features"]), 1)
        feature = result["features"][0]
        self.assertEqual(feature["properties"]["status"], "Détection auto")
        self.assertEqual(feature["properties"]["origin"], "heuristic")
        self.assertEqual(feature["properties"]["hotspot_count"], 8)
        self.assertAlmostEqual(feature["geometry"]["coordinates"][0], 2.035,
                               places=2)

    def test_stale_hotspots_outside_the_max_age_window_are_ignored(self):
        now = 1_000_000
        stale = [hotspot(2.0 + i * 0.01, 40.0, now - 90 * 3600) for i in range(8)]
        hotspots = heuristic_fires.fc(stale)

        result = heuristic_fires.detect_heuristic_fires(
            hotspots, (0, 39, 10, 41), now=now,
            min_hotspots=8, radius_km=10, max_age_hours=72,
        )

        self.assertEqual(result["features"], [])

    def test_hotspots_outside_bbox_are_excluded(self):
        now = 1_000_000
        outside = [hotspot(20.0 + i * 0.01, 40.0, now - 60) for i in range(8)]
        hotspots = heuristic_fires.fc(outside)

        result = heuristic_fires.detect_heuristic_fires(
            hotspots, (0, 39, 10, 41), now=now,
            min_hotspots=8, radius_km=10, max_age_hours=72,
        )

        self.assertEqual(result["features"], [])

    def test_transitive_chain_joins_across_cell_boundaries(self):
        # Une chaine de points espaces de 4 km relie deux extremites a plus de
        # 10 km l'une de l'autre : le decoupage en cellules ne doit pas casser
        # la connexite portee par les intermediaires.
        now = 1_000_000
        chain = [hotspot(2.0 + i * 0.04, 40.0, now - 60) for i in range(8)]
        hotspots = heuristic_fires.fc(chain)

        result = heuristic_fires.detect_heuristic_fires(
            hotspots, (0, 39, 10, 41), now=now,
            min_hotspots=8, radius_km=5, max_age_hours=72,
        )

        self.assertEqual(len(result["features"]), 1)
        self.assertEqual(result["features"][0]["properties"]["hotspot_count"], 8)

    def test_cli_facade_forwards_current_configuration_at_call_time(self):
        with (
            mock.patch.object(cli, "HEURISTIC_MIN_HOTSPOTS", 3),
            mock.patch.object(cli, "HEURISTIC_RADIUS_KM", 7),
            mock.patch.object(cli, "HEURISTIC_MAX_AGE_HOURS", 24),
            mock.patch.object(cli, "_detect_heuristic_fires",
                              return_value="heuristic") as detect,
        ):
            self.assertEqual(
                cli.detect_heuristic_fires("hotspots", "bbox", 42), "heuristic"
            )

        detect.assert_called_once_with(
            "hotspots", "bbox", now=42,
            min_hotspots=3, radius_km=7, max_age_hours=24,
        )


if __name__ == "__main__":
    unittest.main()
