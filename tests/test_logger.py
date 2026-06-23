from __future__ import annotations

import asyncio
import csv
import unittest
from datetime import UTC
from datetime import datetime
from pathlib import Path

from backend.logger import CompletedScenarioTelemetrySample
from backend.logger import build_completed_log_path
from backend.logger import save_completed_scenario_log
from backend.paths import runtime_path


class CompletedScenarioLoggerTests(unittest.TestCase):
    def test_build_completed_log_path_uses_dedicated_directory(self) -> None:
        completed_at = datetime(2026, 4, 7, 12, 30, 45, tzinfo=UTC)

        path = build_completed_log_path(
            scenario_key="scenario_1",
            drone_name="Inspire 2",
            completed_at=completed_at,
            slot_index=1,
        )

        self.assertEqual(path.parent, runtime_path("logs", "completed_scenarios"))
        self.assertEqual(path.name, "20260407_123045_Inspire_2_scenario_1.csv")

    def test_save_completed_scenario_log_writes_csv(self) -> None:
        completed_at = datetime(2026, 4, 7, 12, 30, 45, tzinfo=UTC)
        samples = [
            CompletedScenarioTelemetrySample(
                timestamp="2026-04-07T12:30:00+00:00",
                drone="Inspire 2",
                scenario="scenario_1",
                flight_mode="자동이륙",
                lat=36.1716947,
                lon=128.4651772,
                alt_m=0.0,
                speed_mps=0.0,
                accel_mps2=0.0,
            ),
            CompletedScenarioTelemetrySample(
                timestamp="2026-04-07T12:30:01+00:00",
                drone="Inspire 2",
                scenario="scenario_1",
                flight_mode="자동비행",
                lat=36.1717000,
                lon=128.4652000,
                alt_m=12.5,
                speed_mps=4.2,
                accel_mps2=0.8,
            ),
        ]

        directory = Path("logs") / "unit_test_output"
        directory.mkdir(parents=True, exist_ok=True)
        saved_path = asyncio.run(
            save_completed_scenario_log(
                scenario_key="scenario_1",
                drone_name="Inspire 2",
                completed_at=completed_at,
                samples=samples,
                slot_index=2,
                directory=directory,
            )
        )

        self.assertTrue(saved_path.exists())
        self.assertEqual(saved_path.name, "20260407_123045_Inspire_2_scenario_1.csv")
        with saved_path.open("r", encoding="utf-8-sig", newline="") as input_file:
            rows = list(csv.reader(input_file))

        saved_path.unlink(missing_ok=True)
        directory.rmdir()

        self.assertEqual(
            rows[0],
            [
                "sample_index",
                "timestamp_utc",
                "drone",
                "scenario",
                "flight_mode",
                "lat_deg",
                "lon_deg",
                "alt_m",
                "speed_mps",
                "accel_mps2",
            ],
        )
        self.assertEqual(rows[1][0], "0")
        self.assertEqual(rows[1][1], "2026-04-07T12:30:00+00:00")
        self.assertEqual(rows[1][4], "자동이륙")
        self.assertEqual(rows[2][0], "1")
        self.assertEqual(rows[2][4], "자동비행")
        self.assertEqual(rows[2][7], "12.50")
        self.assertEqual(rows[2][8], "4.20")

    def test_save_completed_scenario_log_appends_suffix_when_filename_conflicts(self) -> None:
        completed_at = datetime(2026, 4, 7, 12, 30, 45, tzinfo=UTC)
        samples = [
            CompletedScenarioTelemetrySample(
                timestamp="2026-04-07T12:30:00+00:00",
                drone="Inspire 2",
                scenario="scenario_1",
                flight_mode="자동이륙",
                lat=36.1716947,
                lon=128.4651772,
                alt_m=0.0,
                speed_mps=0.0,
                accel_mps2=0.0,
            ),
        ]

        directory = Path("logs") / "unit_test_output"
        directory.mkdir(parents=True, exist_ok=True)
        first_path = asyncio.run(
            save_completed_scenario_log(
                scenario_key="scenario_1",
                drone_name="Inspire 2",
                completed_at=completed_at,
                samples=samples,
                directory=directory,
            )
        )
        second_path = asyncio.run(
            save_completed_scenario_log(
                scenario_key="scenario_1",
                drone_name="Inspire 2",
                completed_at=completed_at,
                samples=samples,
                directory=directory,
            )
        )

        first_path.unlink(missing_ok=True)
        second_path.unlink(missing_ok=True)
        directory.rmdir()

        self.assertEqual(first_path.name, "20260407_123045_Inspire_2_scenario_1.csv")
        self.assertEqual(second_path.name, "20260407_123045_Inspire_2_scenario_1_2.csv")


if __name__ == "__main__":
    unittest.main()
