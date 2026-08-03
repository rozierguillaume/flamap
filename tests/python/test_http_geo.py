"""Caracterisation du socle HTTP et geographique du collecteur."""

import unittest
from unittest import mock

from flamap import geo
from flamap import http


class Response:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self):
        return b"fixture"


class HttpTests(unittest.TestCase):
    def test_get_preserves_user_agent_timeout_and_bytes(self):
        with mock.patch.object(
            http.urllib.request, "urlopen", return_value=Response()
        ) as urlopen:
            result = http.get("https://example.test/data", timeout=17)

        request = urlopen.call_args.args[0]
        self.assertEqual(result, b"fixture")
        self.assertEqual(request.full_url, "https://example.test/data")
        self.assertEqual(request.get_header("User-agent"), "flamap/0.2")
        self.assertEqual(urlopen.call_args.kwargs, {"timeout": 17})


class GeoTests(unittest.TestCase):
    def test_geometry_collection_points_bounds_and_axis_swap(self):
        geometry = {
            "type": "GeometryCollection",
            "geometries": [
                {"type": "Point", "coordinates": [43.5, 6.2]},
                {
                    "type": "LineString",
                    "coordinates": [[44.0, 7.0], [44.1, 7.1]],
                },
            ],
        }

        self.assertIs(geo.swap_axes(geometry), geometry)
        self.assertEqual(
            list(geo.geometry_points(geometry)),
            [[6.2, 43.5], [7.0, 44.0], [7.1, 44.1]],
        )
        self.assertEqual(
            geo.feature_bounds({"geometry": geometry}),
            (6.2, 43.5, 7.1, 44.1),
        )

    def test_local_distances_keep_touching_and_inside_bounds_at_zero(self):
        self.assertEqual(
            geo.point_bounds_distance_km((2.0, 46.0), (1.0, 45.0, 3.0, 47.0)),
            0,
        )
        self.assertEqual(
            geo.bounds_gap_km((1.0, 45.0, 2.0, 46.0),
                              (2.0, 45.5, 3.0, 46.5)),
            0,
        )
        self.assertAlmostEqual(
            geo.geographic_distance_km((2.0, 46.0), (2.0, 47.0)),
            110.57,
        )


if __name__ == "__main__":
    unittest.main()
