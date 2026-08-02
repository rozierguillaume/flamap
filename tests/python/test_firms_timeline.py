"""Caracterisation de la collecte FIRMS et des frises."""

import json
import pathlib
import tempfile
import unittest
from unittest import mock

from flamap import firms
from flamap import timeline
import fetch_fires as cli


ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"


def hotspot(ts, source="A", frp=1.0, lon=2.0, lat=46.0):
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"ts": ts, "source": source, "frp": frp},
    }


class FirmsTests(unittest.TestCase):
    def test_cli_facades_forward_current_configuration_at_call_time(self):
        with (
            mock.patch.object(cli, "FIRMS_FEEDS", [("fixture", "local")]),
            mock.patch.object(cli, "TEMPORARY_SOURCE_FAILURE", 99),
            mock.patch.object(cli, "download_firms_feed") as download,
            mock.patch.object(cli, "_fetch_hotspots", return_value="hot") as fetch,
        ):
            self.assertEqual(cli.fetch_hotspots((1, 2, 3, 4)), "hot")
        fetch.assert_called_once_with(
            (1, 2, 3, 4),
            feeds=[("fixture", "local")],
            download=download,
            failure_code=99,
        )

        with (
            mock.patch.object(cli, "ZONES_OUT", "/zones"),
            mock.patch.object(cli, "HOTSPOT_DAYS", 12),
            mock.patch.object(
                cli, "_extend_hotspot_history", return_value="history"
            ) as extend,
        ):
            self.assertEqual(cli.extend_hotspot_history("spots", "bbox"), "history")
        extend.assert_called_once_with(
            "spots", "bbox", zones_out="/zones", hotspot_days=12
        )

        with (
            mock.patch.object(cli, "OUT", "/data"),
            mock.patch.object(cli, "SOCIAL_DAYS", 15),
            mock.patch.object(
                cli, "_build_social_timeline", return_value="social"
            ) as social,
        ):
            self.assertEqual(cli.build_social_timeline("steps"), "social")
        social.assert_called_once_with("steps", out="/data", social_days=15)

    def test_download_retries_once_with_same_timeout(self):
        with (
            mock.patch.object(
                firms, "get", side_effect=[OSError("temporaire"), b"ok"]
            ) as get,
            mock.patch.object(firms.time, "sleep") as sleep,
        ):
            result = firms.download_firms_feed("fixture", "local")

        self.assertEqual(result, ("ok", None))
        self.assertEqual(get.call_count, 2)
        get.assert_has_calls([
            mock.call("local", timeout=60),
            mock.call("local", timeout=60),
        ])
        sleep.assert_called_once_with(5)

    def test_all_unavailable_feeds_keep_temporary_failure_exit_code(self):
        with (
            mock.patch.object(
                firms, "FIRMS_FEEDS", [("A", "a"), ("B", "b")]
            ),
            mock.patch.object(
                firms,
                "download_firms_feed",
                side_effect=[(None, OSError("a")), (None, OSError("b"))],
            ),
        ):
            with self.assertRaises(SystemExit) as raised:
                firms.fetch_hotspots((-5.5, 41.0, 10.0, 51.5))

        self.assertEqual(raised.exception.code, 75)

    def test_previous_zones_extend_only_the_valid_window_without_duplicates(self):
        latest = 2_000_000
        current = hotspot(latest)
        duplicate = hotspot(latest)
        kept = hotspot(latest - 9 * 86400, lon=3.0)
        too_old = hotspot(latest - 11 * 86400, lon=4.0)
        outside = hotspot(latest - 86400, lon=12.0)
        payload = {
            "hotspots": {
                "type": "FeatureCollection",
                "features": [duplicate, kept, too_old, outside],
            }
        }
        with tempfile.TemporaryDirectory() as directory:
            pathlib.Path(directory, "z.json").write_text(
                json.dumps(payload), encoding="utf-8"
            )
            pathlib.Path(directory, "broken.json").write_text(
                "{", encoding="utf-8"
            )
            with mock.patch.object(firms, "ZONES_OUT", directory):
                result = firms.extend_hotspot_history(
                    firms.fc([current]), (-5.5, 41.0, 10.0, 51.5)
                )

        self.assertEqual(result["features"], [kept, current])


class TimelineTests(unittest.TestCase):
    def test_social_history_replaces_same_orbit_and_keeps_other_passes(self):
        latest = 2_000_000
        current = [
            {"ts": latest, "kind": "sat", "label": "A", "n": 2, "frp": 3},
            {"ts": latest, "kind": "effis", "label": "EFFIS", "n": 1},
        ]
        previous = [
            {"ts": latest - 1200, "kind": "sat", "label": "A", "n": 1},
            {"ts": latest - 3600, "kind": "sat", "label": "A", "n": 1},
            {"ts": latest - 3600, "kind": "effis", "label": "EFFIS"},
            {"ts": latest - 15 * 86400, "kind": "sat", "label": "B"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            pathlib.Path(directory, "social_timeline.json").write_text(
                json.dumps(previous), encoding="utf-8"
            )
            with mock.patch.object(timeline, "OUT", directory):
                result = timeline.build_social_timeline(current)

        self.assertEqual(
            [(step["ts"], step["label"]) for step in result],
            [(latest - 3600, "A"), (latest, "A")],
        )

    def test_empty_satellite_timeline_does_not_read_previous_file(self):
        with mock.patch("builtins.open") as opened:
            self.assertEqual(timeline.build_social_timeline([]), [])
        opened.assert_not_called()


if __name__ == "__main__":
    unittest.main()
