from __future__ import annotations

from pathlib import Path
import shutil
import unittest

from backend.drone_specs import get_drone_spec
from backend.scenario import DEFAULT_HOME_LAT
from backend.scenario import DEFAULT_HOME_LON
from backend.scenario import build_custom_scenario_path
from backend.scenario import calculate_horizontal_distance_m
from backend.scenario import delete_custom_scenario
from backend.scenario import load_custom_scenario_definitions
from backend.scenario import save_custom_scenario
from backend.scenario import ScenarioDefinition
from backend.scenario import ScenarioWaypoint
from backend.scenario import estimate_scenario_duration_seconds
from backend.scenario import generate_scenario
from backend.scenario import get_formation_scenario_definition
from backend.scenario import get_scenario_definition
from backend.scenario import get_scenario_waypoints
from backend.scenario import list_scenarios
from backend.scenario import update_custom_scenario


class ScenarioDefinitionTests(unittest.TestCase):
    def test_save_custom_scenario_persists_definition_to_json(self) -> None:
        test_directory = Path("scenarios") / "__unit_test_custom__"
        if test_directory.exists():
            shutil.rmtree(test_directory)
        try:
            definition = save_custom_scenario(
                name="사용자 시나리오",
                home_lat=DEFAULT_HOME_LAT,
                home_lon=DEFAULT_HOME_LON,
                home_alt_m=0.0,
                target_climb_speed_mps=2.6,
                target_descent_speed_mps=1.7,
                vertical_accel_limit_mps2=1.2,
                waypoints=[
                    ScenarioWaypoint(
                        lat=DEFAULT_HOME_LAT + (20.0 / 111_320.0),
                        lon=DEFAULT_HOME_LON,
                        alt_m=80.0,
                        target_speed_mps=8.5,
                        hold_seconds=1.0,
                    ),
                ],
                directory=test_directory,
            )

            saved_path = build_custom_scenario_path(definition.key, test_directory)
            loaded_definitions = load_custom_scenario_definitions(test_directory)

            self.assertTrue(saved_path.exists())
            self.assertIn(definition.key, loaded_definitions)
            self.assertEqual(loaded_definitions[definition.key].name, "사용자 시나리오")
            self.assertEqual(loaded_definitions[definition.key].waypoint_count, 1)
            self.assertEqual(loaded_definitions[definition.key].waypoints[0].hold_seconds, 1.0)
        finally:
            if test_directory.exists():
                shutil.rmtree(test_directory)

    def test_delete_custom_scenario_removes_saved_definition_json(self) -> None:
        test_directory = Path("scenarios") / "__unit_test_custom_delete__"
        if test_directory.exists():
            shutil.rmtree(test_directory)
        try:
            definition = save_custom_scenario(
                name="삭제 시나리오",
                home_lat=DEFAULT_HOME_LAT,
                home_lon=DEFAULT_HOME_LON,
                home_alt_m=0.0,
                target_climb_speed_mps=2.4,
                target_descent_speed_mps=1.8,
                vertical_accel_limit_mps2=1.0,
                waypoints=[
                    ScenarioWaypoint(
                        lat=DEFAULT_HOME_LAT + (15.0 / 111_320.0),
                        lon=DEFAULT_HOME_LON,
                        alt_m=70.0,
                        target_speed_mps=7.0,
                        hold_seconds=0.0,
                    ),
                ],
                directory=test_directory,
            )

            saved_path = build_custom_scenario_path(definition.key, test_directory)
            deleted_definition = delete_custom_scenario(definition.key, directory=test_directory)

            self.assertEqual(deleted_definition.key, definition.key)
            self.assertFalse(saved_path.exists())
            self.assertNotIn(definition.key, load_custom_scenario_definitions(test_directory))
        finally:
            if test_directory.exists():
                shutil.rmtree(test_directory)

    def test_update_custom_scenario_overwrites_saved_definition(self) -> None:
        test_directory = Path("scenarios") / "__unit_test_custom_update__"
        if test_directory.exists():
            shutil.rmtree(test_directory)
        try:
            definition = save_custom_scenario(
                name="수정 전 시나리오",
                home_lat=DEFAULT_HOME_LAT,
                home_lon=DEFAULT_HOME_LON,
                home_alt_m=0.0,
                target_climb_speed_mps=2.4,
                target_descent_speed_mps=1.8,
                vertical_accel_limit_mps2=1.0,
                waypoints=[
                    ScenarioWaypoint(
                        lat=DEFAULT_HOME_LAT + (15.0 / 111_320.0),
                        lon=DEFAULT_HOME_LON,
                        alt_m=70.0,
                        target_speed_mps=7.0,
                        hold_seconds=0.0,
                    ),
                ],
                directory=test_directory,
            )

            updated_definition = update_custom_scenario(
                scenario_key=definition.key,
                name="수정 후 시나리오",
                home_lat=DEFAULT_HOME_LAT + (10.0 / 111_320.0),
                home_lon=DEFAULT_HOME_LON,
                home_alt_m=5.0,
                target_climb_speed_mps=3.0,
                target_descent_speed_mps=1.5,
                vertical_accel_limit_mps2=1.0,
                waypoints=[
                    ScenarioWaypoint(
                        lat=DEFAULT_HOME_LAT + (25.0 / 111_320.0),
                        lon=DEFAULT_HOME_LON,
                        alt_m=90.0,
                        target_speed_mps=9.0,
                        hold_seconds=2.0,
                    ),
                ],
                directory=test_directory,
            )

            loaded_definitions = load_custom_scenario_definitions(test_directory)
            self.assertEqual(updated_definition.key, definition.key)
            self.assertEqual(loaded_definitions[definition.key].name, "수정 후 시나리오")
            self.assertEqual(loaded_definitions[definition.key].home_alt_m, 5.0)
            self.assertEqual(loaded_definitions[definition.key].waypoints[0].hold_seconds, 2.0)
        finally:
            if test_directory.exists():
                shutil.rmtree(test_directory)

    def test_scenario_1_keeps_waypoint_count_in_sync(self) -> None:
        definition = get_scenario_definition("scenario_1")

        self.assertEqual(definition.waypoint_count, len(definition.waypoints))
        self.assertGreater(definition.waypoint_count, 0)
        self.assertAlmostEqual(definition.home_lat, DEFAULT_HOME_LAT)
        self.assertAlmostEqual(definition.home_lon, DEFAULT_HOME_LON)

    def test_scenario_1_waypoint_access_matches_definition(self) -> None:
        definition = get_scenario_definition("scenario_1")
        waypoints = get_scenario_waypoints("scenario_1")

        self.assertEqual(waypoints, definition.waypoints)
        self.assertGreater(waypoints[0].target_speed_mps, 0.0)
        self.assertGreaterEqual(waypoints[-1].hold_seconds, 0.0)

    def test_all_listed_scenarios_keep_metadata_synced_to_waypoints(self) -> None:
        for definition in list_scenarios():
            with self.subTest(scenario=definition.key):
                self.assertEqual(definition.waypoint_count, len(definition.waypoints))
                if definition.waypoints:
                    self.assertGreater(definition.estimated_frames, 0)
                    self.assertGreater(definition.duration_seconds, 0.0)
                    self.assertGreater(definition.waypoints[0].hold_seconds, 0.0)
                else:
                    self.assertEqual(definition.estimated_frames, 0)
                    self.assertEqual(definition.duration_seconds, 0.0)

    def test_generate_scenario_uses_waypoint_based_duration(self) -> None:
        definition = get_scenario_definition("scenario_1")
        generated = generate_scenario("scenario_1", ["inspire_2"])
        drone_spec = get_drone_spec("inspire_2")

        self.assertEqual(generated.waypoint_count, definition.waypoint_count)
        self.assertGreater(generated.estimated_duration_seconds, 0.0)
        self.assertEqual(
            generated.estimated_duration_seconds,
            estimate_scenario_duration_seconds(
                definition=definition,
                max_horizontal_speed_mps=drone_spec.max_horizontal_speed_mps,
                max_ascent_speed_mps=drone_spec.max_ascent_speed_mps,
                max_descent_speed_mps=drone_spec.max_descent_speed_mps,
            ),
        )

    def test_duration_includes_home_takeoff_and_return_landing(self) -> None:
        definition = ScenarioDefinition(
            key="unit_test",
            name="Unit Test",
            waypoint_count=1,
            estimated_frames=0,
            duration_seconds=0.0,
            target_climb_speed_mps=2.0,
            target_descent_speed_mps=1.0,
            vertical_accel_limit_mps2=1.0,
            home_lat=DEFAULT_HOME_LAT,
            home_lon=DEFAULT_HOME_LON,
            home_alt_m=0.0,
            waypoints=(
                ScenarioWaypoint(
                    lat=DEFAULT_HOME_LAT,
                    lon=DEFAULT_HOME_LON,
                    alt_m=20.0,
                    target_speed_mps=5.0,
                    hold_seconds=0.0,
                ),
            ),
        )

        self.assertEqual(
            estimate_scenario_duration_seconds(definition),
            30.0,
        )

    def test_duration_uses_max_speed_for_initial_departure_when_available(self) -> None:
        definition = ScenarioDefinition(
            key="unit_test_horizontal",
            name="Unit Test Horizontal",
            waypoint_count=1,
            estimated_frames=0,
            duration_seconds=0.0,
            target_climb_speed_mps=2.0,
            target_descent_speed_mps=1.0,
            vertical_accel_limit_mps2=1.0,
            home_lat=DEFAULT_HOME_LAT,
            home_lon=DEFAULT_HOME_LON,
            home_alt_m=0.0,
            waypoints=(
                ScenarioWaypoint(
                    lat=DEFAULT_HOME_LAT + (100.0 / 111_320.0),
                    lon=DEFAULT_HOME_LON,
                    alt_m=0.0,
                    target_speed_mps=5.0,
                    hold_seconds=0.0,
                ),
            ),
        )

        self.assertEqual(
            estimate_scenario_duration_seconds(
                definition,
                max_horizontal_speed_mps=10.0,
            ),
            30.0,
        )

    def test_formation_scenario_definition_offsets_home_and_waypoints(self) -> None:
        base_definition = get_scenario_definition("scenario_1")
        shifted_definition = get_formation_scenario_definition("scenario_1", slot_index=1)

        self.assertEqual(shifted_definition.key, base_definition.key)
        self.assertEqual(shifted_definition.estimated_frames, base_definition.estimated_frames)
        self.assertNotEqual(shifted_definition.home_lat, base_definition.home_lat)
        self.assertNotEqual(shifted_definition.home_lon, base_definition.home_lon)
        self.assertNotEqual(shifted_definition.waypoints[0].lat, base_definition.waypoints[0].lat)
        self.assertEqual(
            shifted_definition.waypoints[0].alt_m,
            base_definition.waypoints[0].alt_m + 15.0,
        )
        self.assertEqual(
            shifted_definition.waypoints[-1].alt_m,
            base_definition.waypoints[-1].alt_m + 15.0,
        )
        self.assertAlmostEqual(
            calculate_horizontal_distance_m(
                shifted_definition.home_lat,
                shifted_definition.home_lon,
                shifted_definition.waypoints[0].lat,
                shifted_definition.waypoints[0].lon,
            ),
            calculate_horizontal_distance_m(
                base_definition.home_lat,
                base_definition.home_lon,
                base_definition.waypoints[0].lat,
                base_definition.waypoints[0].lon,
            ),
            places=3,
        )


if __name__ == "__main__":
    unittest.main()
