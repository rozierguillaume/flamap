"""Caracterisation de la collecte Open-Meteo."""

import json
import pathlib
import unittest
from unittest import mock

from flamap import meteo
import fetch_fires as cli


ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"


def load_json(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class MeteoTests(unittest.TestCase):
    def test_cli_facade_reads_open_meteo_configuration_at_call_time(self):
        with (
            mock.patch.object(cli, "OPEN_METEO", "https://example.test/meteo"),
            mock.patch.object(cli, "OPEN_METEO_TIMEOUT", 11),
            mock.patch.object(cli, "get") as get,
            mock.patch.object(cli, "_meteo_request", return_value="series") as request,
        ):
            self.assertEqual(cli.meteo_request([(46, 2)], "model", ["wind"], 3), "series")

        request.assert_called_once_with(
            [(46, 2)], "model", ["wind"], 3, http_get=get,
            base_url="https://example.test/meteo", timeout=11,
        )

    def test_cli_build_wind_keeps_its_shared_time_helper(self):
        with (
            mock.patch.object(cli, "keep_recent") as recent,
            mock.patch.object(cli, "_build_wind", return_value="wind") as build,
        ):
            self.assertEqual(cli.build_wind("box", 2, 3, "series", "model"), "wind")

        self.assertIs(build.call_args.kwargs["recent_fn"], recent)

    def test_rate_limit_retries_with_unchanged_url_and_timeout(self):
        payload = json.dumps({"hourly": {}}).encode()
        limited = type("Limited", (OSError,), {"code": 429})("limite")
        with (
            mock.patch.object(meteo, "get", side_effect=[limited, payload]) as get,
            mock.patch.object(meteo.time, "sleep") as sleep,
        ):
            result = meteo.meteo_request([(46, 2)], "model", ["wind"], 3)

        self.assertEqual(result, [{"hourly": {}}])
        self.assertEqual(get.call_count, 2)
        self.assertEqual(
            [call.kwargs["timeout"] for call in get.call_args_list], [30, 30]
        )
        self.assertEqual(get.call_args_list[0].args[0], get.call_args_list[1].args[0])
        sleep.assert_called_once_with(10)

    def test_budget_keeps_completed_batches_for_fine_wind_fallback(self):
        completed = [{"hourly": {"wind_speed_10m": []}}]
        with (
            mock.patch.object(meteo.time, "monotonic", side_effect=[0, 0, 2]),
            mock.patch.object(meteo.time, "sleep"),
        ):
            with self.assertRaises(meteo.DeadlineExceeded) as raised:
                meteo.request_batches(
                    [1, 2], "model", ["wind"], 3, batch_size=1, budget=1,
                    request=lambda *_args: completed,
                )

        self.assertEqual(raised.exception.collected, completed)

    def test_fixture_exports_keep_vector_units_and_independent_windows(self):
        fixture = load_json("meteo.json")
        wind = meteo.build_wind(
            fixture["box"], fixture["nx"], fixture["ny"], fixture["series"],
            "fixture", temperature=True,
        )
        now = wind["t0"] + 2 * wind["dt"]

        self.assertEqual(wind["gust"][0], [36, 72])
        self.assertNotIn("temperature", meteo.weather_forecast(wind, now, hours=1))
        self.assertEqual(
            meteo.thermal_export(wind, now, hours=1)["temperature"],
            wind["temperature"][1:4],
        )


if __name__ == "__main__":
    unittest.main()
