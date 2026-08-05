"""Caracterisation de la collecte EFFIS et PSFDF."""

import copy
import json
import pathlib
import unittest
from unittest import mock

from flamap import effis
from flamap import psfdf
import fetch_fires as cli


ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"


def load_json(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class EffisTests(unittest.TestCase):
    def test_cli_facades_forward_current_configuration_at_call_time(self):
        with (
            mock.patch.object(cli, "EFFIS_WFS", "https://example.test/wfs"),
            mock.patch.object(cli, "get") as get,
            mock.patch.object(cli, "_effis_wfs", return_value="wfs") as wfs,
        ):
            self.assertEqual(cli.effis_wfs("layer", (1, 2, 3, 4), 12), "wfs")
        wfs.assert_called_once_with(
            "layer", (1, 2, 3, 4), timeout=12,
            http_get=get, base_url="https://example.test/wfs",
        )

        with mock.patch.object(cli, "effis_wfs") as wfs:
            with mock.patch.object(cli, "_fetch_burnt", return_value="burnt") as fetch:
                self.assertEqual(cli.fetch_burnt("bbox"), "burnt")
        fetch.assert_called_once_with(
            "bbox",
            countries=("FR",),
            wfs=wfs,
            swap=cli.swap_axes,
            epoch=cli.to_epoch,
            feature_id=cli.stable_feature_id,
        )

    def test_wfs_retries_twice_with_same_timeout_and_incremental_delays(self):
        payload = json.dumps({"type": "FeatureCollection", "features": []}).encode()
        with (
            mock.patch.object(
                effis, "get", side_effect=[OSError("a"), OSError("b"), payload]
            ) as get,
            mock.patch.object(effis.time, "sleep") as sleep,
        ):
            result = effis.effis_wfs("layer", (1, 2, 3, 4), timeout=17)

        self.assertEqual(result["features"], [])
        self.assertEqual(get.call_count, 3)
        self.assertEqual([call.kwargs["timeout"] for call in get.call_args_list],
                         [17, 17, 17])
        self.assertEqual(sleep.call_args_list, [mock.call(4), mock.call(8)])

    def test_optional_nrt_failure_keeps_dated_perimeters(self):
        dated = load_json("effis.geojson")
        with mock.patch.object(
            effis,
            "effis_wfs",
            side_effect=[copy.deepcopy(dated), OSError("indisponible")],
        ):
            result = effis.fetch_burnt((1, 2, 3, 4))

        self.assertEqual(len(result["burnt_dated"]["features"]), 2)
        self.assertEqual(result["burnt_nrt"]["features"], [])

    def test_country_filter_selects_the_perimeters_of_the_region(self):
        dated = load_json("effis.geojson")
        with mock.patch.object(
            effis, "effis_wfs",
            side_effect=[copy.deepcopy(dated), {"type": "FeatureCollection",
                                                "features": []}],
        ):
            result = effis.fetch_burnt((1, 2, 3, 4), countries=("ES", "PT"))

        self.assertEqual(len(result["burnt_dated"]["features"]), 1)

    def test_merge_drops_the_nrt_scars_seen_by_two_overlapping_regions(self):
        shared = {"type": "Feature", "geometry": {"type": "Point",
                                                  "coordinates": [1, 42]},
                  "properties": {"_id": "n-partage"}}
        french = {"type": "Feature", "geometry": {"type": "Point",
                                                  "coordinates": [2, 48]},
                  "properties": {"_id": "d-fr", "FIREDATE": "2026-07-01"}}
        spanish = {"type": "Feature", "geometry": {"type": "Point",
                                                   "coordinates": [-4, 40]},
                   "properties": {"_id": "d-es", "FIREDATE": "2026-06-01"}}
        merged = effis.merge_burnt([
            {"burnt_dated": effis.fc([french]),
             "burnt_nrt": effis.fc([copy.deepcopy(shared)])},
            {"burnt_dated": effis.fc([spanish]),
             "burnt_nrt": effis.fc([copy.deepcopy(shared)])},
        ])

        self.assertEqual(len(merged["burnt_nrt"]["features"]), 1)
        self.assertEqual(
            [feature["properties"]["_id"]
             for feature in merged["burnt_dated"]["features"]],
            ["d-es", "d-fr"],
        )

    def test_each_region_is_queried_with_its_own_envelope_and_countries(self):
        regions = (
            {"label": "A", "boxes": ((0, 0, 1, 1), (1, 0.5, 2, 1.5)),
             "countries": ("FR",)},
            {"label": "B", "boxes": ((-3, -2, -1, 0),), "countries": ("ES", "PT")},
        )
        empty = {"burnt_dated": effis.fc([]), "burnt_nrt": effis.fc([])}
        with mock.patch.object(cli, "fetch_burnt", return_value=empty) as fetch:
            cli.fetch_burnt_regions(regions)

        self.assertEqual(
            sorted(call.args for call in fetch.call_args_list),
            [((-3, -2, -1, 0), ("ES", "PT")), ((0, 0, 2, 1.5), ("FR",))],
        )


class PsfdfTests(unittest.TestCase):
    def test_direct_api_forwards_custom_statuses_and_timezone_to_parsers(self):
        payload = json.dumps([{
            "ID": "custom",
            "Statut": "local",
            "Longitude": "2",
            "Latitude": "46",
            "Date_MAJ": "02/08/2026 12:00",
        }]).encode()
        timezone = mock.sentinel.timezone
        now = mock.Mock()
        now.timestamp.return_value = 2_000_000_000
        timestamp = 2_000_000_000
        with (
            mock.patch.object(psfdf, "psfdf_status", return_value="Local") as status,
            mock.patch.object(psfdf, "psfdf_timestamp", return_value=timestamp) as stamp,
        ):
            result = psfdf.fetch_psfdf(
                (1, 45, 3, 47),
                http_get=lambda *_args, **_kwargs: payload,
                statuses={"local": "Local"},
                paris_tz=timezone,
                now_factory=lambda tz: now,
            )

        status.assert_called_once_with("local", statuses={"local": "Local"})
        stamp.assert_called_once_with(
            "02/08/2026 12:00", now=now, paris_tz=timezone
        )
        self.assertEqual(result["features"][0]["properties"]["status"], "Local")

    def test_cli_facades_forward_current_configuration_at_call_time(self):
        with (
            mock.patch.object(cli, "PSFDF_API", "https://example.test/psfdf"),
            mock.patch.object(cli, "PSFDF_TIMEOUT", 11),
            mock.patch.object(cli, "PSFDF_MAX_AGE_DAYS", 5),
            mock.patch.object(cli, "get") as get,
            mock.patch.object(cli, "_fetch_psfdf", return_value="psfdf") as fetch,
        ):
            self.assertEqual(cli.fetch_psfdf("bbox"), "psfdf")

        self.assertEqual(fetch.call_args.args, ("bbox",))
        self.assertEqual(fetch.call_args.kwargs["http_get"], get)
        self.assertEqual(fetch.call_args.kwargs["api"], "https://example.test/psfdf")
        self.assertEqual(fetch.call_args.kwargs["timeout"], 11)
        self.assertEqual(fetch.call_args.kwargs["max_age_days"], 5)

    def test_alignment_keeps_distant_cluster_outside_selected_group(self):
        fires = psfdf.fc([{
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [2.0, 46.0]},
            "properties": {},
        }])
        perimeters = psfdf.fc([
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [2.01, 46.0]},
                "properties": {},
            },
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [2.03, 46.0]},
                "properties": {},
            },
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [2.12, 46.0]},
                "properties": {},
            },
        ])

        matched = psfdf.align_psfdf_to_effis(fires, perimeters)

        self.assertEqual(matched, 1)
        self.assertEqual(fires["features"][0]["properties"]["effis_matches"], 2)
        self.assertEqual(fires["features"][0]["geometry"]["coordinates"],
                         [2.02, 46.0])


if __name__ == "__main__":
    unittest.main()
