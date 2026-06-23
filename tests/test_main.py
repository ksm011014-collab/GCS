from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import AsyncMock
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.drone_specs import list_drone_spec_entries
from backend.drone_specs import refresh_custom_drone_spec_entries
from backend.main import FLIGHT_MODE_MESSAGE_PREFIX
from backend.main import FIRST_WAYPOINT_MANUAL_HOLD_SECONDS
from backend.main import MISSION_RECORDING_START_MESSAGE
from backend.main import MISSION_RECORDING_STOP_MESSAGE
from backend.main import MissionRuntime
from backend.main import StreamControlState
from backend.main import apply_stream_control_message
from backend.main import app
from backend.main import build_mission_control
from backend.main import build_demo_control
from backend.main import calculate_waypoint_progress_percent
from backend.main import get_flight_mode_label
from backend.main import get_reached_waypoint_count
from backend.main import initialize_mission_runtime
from backend.main import resolve_flight_speed_limits
from backend.main import transition_mission_runtime
from backend.physics import DroneState
from backend.scenario import create_waypoint_scenario
from backend.scenario import get_scenario_definition
from backend.scenario import meters_per_degree_lon
from backend.scenario import ScenarioWaypoint
from backend.sensors import add_attitude_sensor_noise
from backend.sensors import AttitudeEstimate
from backend.sensors import AttitudeEstimatorState
from backend.sensors import estimate_attitude_from_acceleration


class DemoControlTests(unittest.TestCase):
    def test_flight_mode_labels_collapse_to_manual_or_automatic(self) -> None:
        self.assertEqual(get_flight_mode_label("takeoff"), "수동비행")
        self.assertEqual(get_flight_mode_label("formation_hold"), "수동비행")
        self.assertEqual(get_flight_mode_label("hold"), "자동비행")
        self.assertEqual(get_flight_mode_label("waypoint"), "자동비행")

    def test_build_demo_control_uses_scenario_profile_and_unknown_fallback(self) -> None:
        scenario_1_control = build_demo_control(
            step_index=0,
            scenario_key="scenario_1",
            current_vertical_speed_mps=0.0,
            max_ascent_speed_mps=6.0,
            max_descent_speed_mps=6.0,
        )
        unknown_scenario_control = build_demo_control(
            step_index=0,
            scenario_key="unknown_scenario",
            current_vertical_speed_mps=0.0,
            max_ascent_speed_mps=6.0,
            max_descent_speed_mps=6.0,
        )

        self.assertGreater(scenario_1_control.accel_up_mps2, 0.0)
        self.assertGreater(
            unknown_scenario_control.accel_up_mps2,
            0.0,
        )

    def test_build_demo_control_bleeds_vertical_speed_outside_climb_window(self) -> None:
        control = build_demo_control(
            step_index=400,
            scenario_key="scenario_1",
            current_vertical_speed_mps=1.2,
            max_ascent_speed_mps=6.0,
            max_descent_speed_mps=6.0,
        )

        self.assertLess(control.accel_up_mps2, 0.0)

    def test_build_mission_control_takeoff_climbs_vertically_before_departure(self) -> None:
        scenario = get_scenario_definition("scenario_1")
        control = build_mission_control(
            runtime=initialize_mission_runtime(),
            state=DroneState(
                lat=scenario.home_lat,
                lon=scenario.home_lon,
                alt_m=scenario.home_alt_m,
                velocity_north_mps=0.0,
                velocity_east_mps=0.0,
                velocity_up_mps=0.0,
            ),
            scenario_key=scenario.key,
            max_horizontal_speed_mps=26.0,
            max_ascent_speed_mps=6.0,
            max_descent_speed_mps=6.0,
        )

        self.assertEqual(control.accel_north_mps2, 0.0)
        self.assertEqual(control.accel_east_mps2, 0.0)
        self.assertGreater(control.accel_up_mps2, 0.0)

    def test_build_mission_control_takeoff_starts_horizontal_flight_after_20m_climb(self) -> None:
        scenario = get_scenario_definition("scenario_1")
        control = build_mission_control(
            runtime=initialize_mission_runtime(),
            state=DroneState(
                lat=scenario.home_lat,
                lon=scenario.home_lon,
                alt_m=scenario.home_alt_m + 20.0,
                velocity_north_mps=0.0,
                velocity_east_mps=0.0,
                velocity_up_mps=0.0,
            ),
            scenario_key=scenario.key,
            max_horizontal_speed_mps=26.0,
            max_ascent_speed_mps=6.0,
            max_descent_speed_mps=6.0,
        )

        self.assertLess(control.accel_north_mps2, 0.0)
        self.assertLess(control.accel_east_mps2, 0.0)
        self.assertGreater(control.accel_up_mps2, 0.0)

    def test_transition_starts_recording_at_first_waypoint(self) -> None:
        scenario = get_scenario_definition("scenario_1")
        first_waypoint = scenario.waypoints[0]
        runtime, logs, mission_complete = transition_mission_runtime(
            runtime=MissionRuntime(
                phase="waypoint",
                waypoint_index=0,
                hold_remaining_s=0.0,
                mission_recording_active=False,
            ),
            state=DroneState(
                lat=first_waypoint.lat,
                lon=first_waypoint.lon,
                alt_m=first_waypoint.alt_m,
                velocity_north_mps=0.0,
                velocity_east_mps=0.0,
                velocity_up_mps=0.0,
            ),
            scenario_key=scenario.key,
        )

        self.assertFalse(mission_complete)
        self.assertIn(MISSION_RECORDING_START_MESSAGE, logs)
        self.assertTrue(runtime.mission_recording_active)

    def test_transition_takeoff_starts_manual_hold_at_first_waypoint(self) -> None:
        scenario = get_scenario_definition("scenario_1")
        first_waypoint = scenario.waypoints[0]
        runtime, logs, mission_complete = transition_mission_runtime(
            runtime=initialize_mission_runtime(),
            state=DroneState(
                lat=first_waypoint.lat,
                lon=first_waypoint.lon,
                alt_m=first_waypoint.alt_m,
                velocity_north_mps=0.0,
                velocity_east_mps=0.0,
                velocity_up_mps=0.0,
            ),
            scenario_key=scenario.key,
        )

        self.assertFalse(mission_complete)
        self.assertEqual(runtime.phase, "takeoff")
        self.assertAlmostEqual(runtime.hold_remaining_s, FIRST_WAYPOINT_MANUAL_HOLD_SECONDS)
        self.assertTrue(runtime.mission_recording_active)
        self.assertIn("1번 Waypoint 도착", logs)
        self.assertIn(MISSION_RECORDING_START_MESSAGE, logs)
        self.assertFalse(
            any(log.startswith(f"{FLIGHT_MODE_MESSAGE_PREFIX}waypoint|") for log in logs)
        )

    def test_transition_takeoff_switches_to_automatic_after_manual_hold(self) -> None:
        scenario = get_scenario_definition("scenario_1")
        runtime, logs, mission_complete = transition_mission_runtime(
            runtime=MissionRuntime(
                phase="takeoff",
                waypoint_index=0,
                hold_remaining_s=0.01,
                mission_recording_active=True,
            ),
            state=DroneState(
                lat=scenario.waypoints[0].lat,
                lon=scenario.waypoints[0].lon,
                alt_m=scenario.waypoints[0].alt_m,
                velocity_north_mps=0.0,
                velocity_east_mps=0.0,
                velocity_up_mps=0.0,
            ),
            scenario_key=scenario.key,
        )

        self.assertFalse(mission_complete)
        self.assertEqual(runtime.phase, "waypoint")
        self.assertEqual(runtime.waypoint_index, 1)
        self.assertTrue(
            any(log.startswith(f"{FLIGHT_MODE_MESSAGE_PREFIX}waypoint|") for log in logs)
        )

    def test_transition_takeoff_enters_formation_hold_at_first_waypoint_when_enabled(self) -> None:
        scenario = get_scenario_definition("scenario_1")
        first_waypoint = scenario.waypoints[0]
        runtime, logs, mission_complete = transition_mission_runtime(
            runtime=initialize_mission_runtime(),
            state=DroneState(
                lat=first_waypoint.lat,
                lon=first_waypoint.lon,
                alt_m=first_waypoint.alt_m,
                velocity_north_mps=0.0,
                velocity_east_mps=0.0,
                velocity_up_mps=0.0,
            ),
            scenario_key=scenario.key,
            enable_first_waypoint_barrier=True,
        )

        self.assertFalse(mission_complete)
        self.assertEqual(runtime.phase, "formation_hold")
        self.assertAlmostEqual(runtime.hold_remaining_s, FIRST_WAYPOINT_MANUAL_HOLD_SECONDS)
        self.assertTrue(
            any(log.startswith(f"{FLIGHT_MODE_MESSAGE_PREFIX}formation_hold|") for log in logs)
        )

    def test_transition_enters_formation_hold_at_first_waypoint_when_enabled(self) -> None:
        scenario = get_scenario_definition("scenario_1")
        first_waypoint = scenario.waypoints[0]
        runtime, logs, mission_complete = transition_mission_runtime(
            runtime=MissionRuntime(
                phase="waypoint",
                waypoint_index=0,
                hold_remaining_s=0.0,
                mission_recording_active=False,
            ),
            state=DroneState(
                lat=first_waypoint.lat,
                lon=first_waypoint.lon,
                alt_m=first_waypoint.alt_m,
                velocity_north_mps=0.0,
                velocity_east_mps=0.0,
                velocity_up_mps=0.0,
            ),
            scenario_key=scenario.key,
            enable_first_waypoint_barrier=True,
        )

        self.assertFalse(mission_complete)
        self.assertEqual(runtime.phase, "formation_hold")
        self.assertIn("1번 Waypoint 도착", logs)
        self.assertIn(MISSION_RECORDING_START_MESSAGE, logs)
        self.assertTrue(
            any(log.startswith(f"{FLIGHT_MODE_MESSAGE_PREFIX}formation_hold|") for log in logs)
        )

    def test_transition_allows_fly_through_on_non_hold_waypoint(self) -> None:
        scenario = get_scenario_definition("scenario_1")
        second_waypoint = scenario.waypoints[1]
        runtime, logs, mission_complete = transition_mission_runtime(
            runtime=MissionRuntime(
                phase="waypoint",
                waypoint_index=1,
                hold_remaining_s=0.0,
                mission_recording_active=True,
            ),
            state=DroneState(
                lat=second_waypoint.lat,
                lon=second_waypoint.lon,
                alt_m=second_waypoint.alt_m,
                velocity_north_mps=6.0,
                velocity_east_mps=0.0,
                velocity_up_mps=0.0,
            ),
            scenario_key=scenario.key,
        )

        self.assertFalse(mission_complete)
        self.assertIn("2번 Waypoint 도착", logs)
        self.assertEqual(runtime.phase, "waypoint")
        self.assertEqual(runtime.waypoint_index, 2)

    def test_build_mission_control_blends_into_next_leg_for_fly_through_waypoint(self) -> None:
        scenario = get_scenario_definition("scenario_1")
        second_waypoint = scenario.waypoints[1]
        ten_meters_in_lon = 10.0 / meters_per_degree_lon(second_waypoint.lat)
        control = build_mission_control(
            runtime=MissionRuntime(
                phase="waypoint",
                waypoint_index=1,
                hold_remaining_s=0.0,
                mission_recording_active=True,
            ),
            state=DroneState(
                lat=second_waypoint.lat,
                lon=second_waypoint.lon - ten_meters_in_lon,
                alt_m=second_waypoint.alt_m,
                velocity_north_mps=0.0,
                velocity_east_mps=0.0,
                velocity_up_mps=0.0,
            ),
            scenario_key=scenario.key,
            max_horizontal_speed_mps=26.0,
            max_ascent_speed_mps=6.0,
            max_descent_speed_mps=6.0,
        )

        self.assertGreater(control.accel_north_mps2, 0.0)
        self.assertGreater(control.accel_east_mps2, 0.0)

    def test_transition_keeps_hold_waypoint_until_stabilized(self) -> None:
        scenario = get_scenario_definition("scenario_1")
        first_waypoint = scenario.waypoints[0]
        runtime, logs, mission_complete = transition_mission_runtime(
            runtime=MissionRuntime(
                phase="waypoint",
                waypoint_index=0,
                hold_remaining_s=0.0,
                mission_recording_active=False,
            ),
            state=DroneState(
                lat=first_waypoint.lat,
                lon=first_waypoint.lon,
                alt_m=first_waypoint.alt_m,
                velocity_north_mps=6.0,
                velocity_east_mps=0.0,
                velocity_up_mps=0.0,
            ),
            scenario_key=scenario.key,
        )

        self.assertFalse(mission_complete)
        self.assertEqual(logs, [])
        self.assertEqual(runtime.phase, "waypoint")
        self.assertEqual(runtime.waypoint_index, 0)

    def test_transition_stops_recording_before_return_home(self) -> None:
        scenario = get_scenario_definition("scenario_1")
        last_waypoint = scenario.waypoints[-1]
        runtime, logs, mission_complete = transition_mission_runtime(
            runtime=MissionRuntime(
                phase="hold",
                waypoint_index=len(scenario.waypoints) - 1,
                hold_remaining_s=0.0,
                mission_recording_active=True,
            ),
            state=DroneState(
                lat=last_waypoint.lat,
                lon=last_waypoint.lon,
                alt_m=last_waypoint.alt_m,
                velocity_north_mps=0.0,
                velocity_east_mps=0.0,
                velocity_up_mps=0.0,
            ),
            scenario_key=scenario.key,
        )

        self.assertFalse(mission_complete)
        self.assertIn(MISSION_RECORDING_STOP_MESSAGE, logs)
        self.assertEqual(runtime.phase, "return_home")
        self.assertFalse(runtime.mission_recording_active)
        self.assertTrue(
            any(log.startswith(f"{FLIGHT_MODE_MESSAGE_PREFIX}return_home|") for log in logs)
        )

    def test_resolve_flight_speed_limits_keeps_individual_caps_during_takeoff(self) -> None:
        speed_limits = resolve_flight_speed_limits(
            runtime=initialize_mission_runtime(),
            individual_max_horizontal_speed_mps=26.0,
            individual_max_ascent_speed_mps=6.0,
            individual_max_descent_speed_mps=9.0,
            formation_horizontal_cap_mps=15.0,
            formation_ascent_cap_mps=4.0,
            formation_descent_cap_mps=5.0,
        )

        self.assertEqual(speed_limits.max_horizontal_speed_mps, 26.0)
        self.assertEqual(speed_limits.max_ascent_speed_mps, 6.0)
        self.assertEqual(speed_limits.max_descent_speed_mps, 9.0)

    def test_resolve_flight_speed_limits_uses_formation_caps_after_first_waypoint(self) -> None:
        speed_limits = resolve_flight_speed_limits(
            runtime=MissionRuntime(
                phase="waypoint",
                waypoint_index=1,
                hold_remaining_s=0.0,
                mission_recording_active=True,
            ),
            individual_max_horizontal_speed_mps=26.0,
            individual_max_ascent_speed_mps=6.0,
            individual_max_descent_speed_mps=9.0,
            formation_horizontal_cap_mps=15.0,
            formation_ascent_cap_mps=4.0,
            formation_descent_cap_mps=5.0,
        )

        self.assertEqual(speed_limits.max_horizontal_speed_mps, 15.0)
        self.assertEqual(speed_limits.max_ascent_speed_mps, 4.0)
        self.assertEqual(speed_limits.max_descent_speed_mps, 5.0)


class ScenarioRouteApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app)

    def test_drone_specs_api_returns_all_known_drone_keys(self) -> None:
        response = self.client.get("/api/drone-specs")
        expected_keys = [key for key, _spec in list_drone_spec_entries()]
        payload_keys = [drone["key"] for drone in response.json()]

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload_keys[:len(expected_keys)], expected_keys)

    def test_custom_drone_spec_api_persists_user_defined_drone(self) -> None:
        payload = {
            "name": "테스트 사용자 기체",
            "category": "FPV",
            "max_horizontal_speed_mps": 22.5,
            "max_ascent_speed_mps": 6.5,
            "max_descent_speed_mps": 5.2,
            "max_service_ceiling_m": 3200.0,
            "max_flight_time_min": 18.0,
            "weight_g": 780.0,
            "rcs_estimate_m2": 0.05,
            "rf_signature": "ELRS",
            "rf_band": "2.4GHz",
            "acoustic_signature_hz": 245.0,
            "thermal_signature_level": "중열",
            "payload_capacity_g": 250.0,
            "sensor_notes": "테스트용",
        }

        response = self.client.post("/api/custom-drone-specs", json=payload)

        self.assertEqual(response.status_code, 200)
        response_payload = response.json()
        self.assertTrue(response_payload["key"].startswith("custom_drone_"))
        self.assertTrue(response_payload["is_custom"])
        self.assertEqual(response_payload["name"], payload["name"])
        self.assertEqual(response_payload["rf_signature"], payload["rf_signature"])
        self.assertEqual(response_payload["payload_capacity_g"], payload["payload_capacity_g"])

        custom_path = Path("drone_specs") / "custom" / f"{response_payload['key']}.json"
        try:
            self.assertTrue(custom_path.exists())
        finally:
            custom_path.unlink(missing_ok=True)
            refresh_custom_drone_spec_entries()

    @patch.dict("os.environ", {"MOLIT_AIRSPACE_API_KEY": "", "DATA_GO_KR_SERVICE_KEY": "", "VWORLD_API_KEY": "", "VWORLD_KEY": ""})
    def test_airspace_status_reports_disabled_without_airspace_key(self) -> None:
        response = self.client.get("/api/airspace-zones/status")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload["enabled"])
        self.assertIn("prohibited", payload["zone_types"])

    @patch.dict("os.environ", {"MOLIT_AIRSPACE_API_KEY": "test-key", "DATA_GO_KR_SERVICE_KEY": "", "VWORLD_API_KEY": "", "VWORLD_KEY": ""})
    def test_airspace_status_reports_enabled_with_airspace_key(self) -> None:
        response = self.client.get("/api/airspace-zones/status")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["enabled"])

    @patch.dict("os.environ", {"MOLIT_AIRSPACE_API_KEY": "", "DATA_GO_KR_SERVICE_KEY": "", "VWORLD_API_KEY": "", "VWORLD_KEY": ""})
    def test_airspace_zones_rejects_missing_airspace_key(self) -> None:
        response = self.client.get("/api/airspace-zones?bbox=0,0,1,1")

        self.assertEqual(response.status_code, 503)

    @patch.dict("os.environ", {"MOLIT_AIRSPACE_API_KEY": "test-key", "DATA_GO_KR_SERVICE_KEY": "", "VWORLD_API_KEY": "", "VWORLD_KEY": ""})
    def test_airspace_zones_returns_geojson_features(self) -> None:
        payload = {
            "response": {
                "result": {
                    "featureCollection": {
                        "type": "FeatureCollection",
                        "features": [
                            {
                                "type": "Feature",
                                "properties": {"name": "zone"},
                                "geometry": {"type": "Polygon", "coordinates": []},
                            }
                        ],
                    }
                }
            }
        }
        with patch(
            "backend.main.fetch_molit_airspace_payload",
            new=AsyncMock(return_value=payload),
        ) as fetch_mock:
            response = self.client.get(
                "/api/airspace-zones?bbox=0,0,1,1&zone_types=prohibited",
            )

        self.assertEqual(response.status_code, 200)
        response_payload = response.json()
        self.assertEqual(response_payload["type"], "FeatureCollection")
        self.assertEqual(response_payload["features"][0]["properties"]["zone_type"], "prohibited")
        forwarded_params = fetch_mock.await_args.args[0]
        self.assertEqual(forwarded_params["key"], "test-key")
        self.assertEqual(forwarded_params["data"], "LT_C_AISPRHC")
        self.assertEqual(forwarded_params["geomFilter"], "BOX(0.0,0.0,1.0,1.0)")

    @patch.dict("os.environ", {"MOLIT_AIRSPACE_API_KEY": "test-key", "DATA_GO_KR_SERVICE_KEY": "", "VWORLD_API_KEY": "", "VWORLD_KEY": ""})
    def test_airspace_zones_rejects_unknown_zone_type(self) -> None:
        response = self.client.get("/api/airspace-zones?bbox=0,0,1,1&zone_types=unsafe")

        self.assertEqual(response.status_code, 400)

    def test_scenario_route_returns_home_and_waypoints(self) -> None:
        scenario = get_scenario_definition("scenario_1")

        response = self.client.get("/api/scenarios/scenario_1/route")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["scenario_key"], scenario.key)
        self.assertEqual(payload["scenario_name"], scenario.name)
        self.assertEqual(payload["home"]["lat"], scenario.home_lat)
        self.assertEqual(payload["home"]["lon"], scenario.home_lon)
        self.assertEqual(len(payload["waypoints"]), scenario.waypoint_count)
        self.assertEqual(payload["waypoints"][0]["index"], 1)
        self.assertEqual(payload["waypoints"][-1]["index"], scenario.waypoint_count)

    def test_scenario_route_returns_404_for_unknown_scenario(self) -> None:
        response = self.client.get("/api/scenarios/unknown/route")

        self.assertEqual(response.status_code, 404)

    def test_scenario_detail_returns_editable_fields(self) -> None:
        scenario = get_scenario_definition("scenario_1")

        response = self.client.get("/api/scenarios/scenario_1")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["key"], scenario.key)
        self.assertEqual(payload["name"], scenario.name)
        self.assertFalse(payload["is_custom"])
        self.assertEqual(payload["home"]["lat"], scenario.home_lat)
        self.assertEqual(payload["target_climb_speed_mps"], scenario.target_climb_speed_mps)
        self.assertEqual(len(payload["waypoints"]), scenario.waypoint_count)

    def test_scenario_route_supports_formation_slot_offsets(self) -> None:
        response = self.client.get("/api/scenarios/scenario_1/route?slot=1")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertNotEqual(payload["home"]["lat"], get_scenario_definition("scenario_1").home_lat)
        self.assertNotEqual(payload["waypoints"][0]["lon"], get_scenario_definition("scenario_1").waypoints[0].lon)

    def test_custom_scenario_api_returns_saved_scenario_summary(self) -> None:
        saved_definition = create_waypoint_scenario(
            key="custom_test",
            name="사용자 저장 시나리오",
            target_climb_speed_mps=2.4,
            target_descent_speed_mps=1.8,
            vertical_accel_limit_mps2=1.0,
            home_lat=36.1716947,
            home_lon=128.4651771,
            home_alt_m=0.0,
            waypoints=(
                ScenarioWaypoint(
                    lat=36.1719,
                    lon=128.4653,
                    alt_m=120.0,
                    target_speed_mps=9.0,
                    hold_seconds=1.0,
                ),
            ),
        )
        with patch("backend.main.save_custom_scenario", return_value=saved_definition) as save_mock:
            response = self.client.post(
                "/api/custom-scenarios",
                json={
                    "name": "사용자 저장 시나리오",
                    "home": {
                        "lat": 36.1716947,
                        "lon": 128.4651771,
                        "alt_m": 0.0,
                    },
                    "target_climb_speed_mps": 2.4,
                    "target_descent_speed_mps": 1.8,
                    "vertical_accel_limit_mps2": 1.0,
                    "waypoints": [
                        {
                            "lat": 36.1719,
                            "lon": 128.4653,
                            "alt_m": 120.0,
                            "target_speed_mps": 9.0,
                            "hold_seconds": 1.0,
                        },
                    ],
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["key"], "custom_test")
        self.assertEqual(payload["name"], "사용자 저장 시나리오")
        self.assertEqual(payload["waypoint_count"], 1)
        save_mock.assert_called_once()

    def test_delete_custom_scenario_api_returns_removed_scenario_summary(self) -> None:
        deleted_definition = create_waypoint_scenario(
            key="custom_delete_test",
            name="삭제 대상 시나리오",
            target_climb_speed_mps=2.4,
            target_descent_speed_mps=1.8,
            vertical_accel_limit_mps2=1.0,
            home_lat=36.1716947,
            home_lon=128.4651771,
            home_alt_m=0.0,
            waypoints=(
                ScenarioWaypoint(
                    lat=36.1719,
                    lon=128.4653,
                    alt_m=120.0,
                    target_speed_mps=9.0,
                    hold_seconds=1.0,
                ),
            ),
        )
        with patch("backend.main.delete_custom_scenario_definition", return_value=deleted_definition) as delete_mock:
            response = self.client.delete("/api/custom-scenarios/custom_delete_test")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["key"], "custom_delete_test")
        self.assertEqual(payload["name"], "삭제 대상 시나리오")
        self.assertEqual(payload["waypoint_count"], 1)
        delete_mock.assert_called_once_with("custom_delete_test")

    def test_delete_custom_scenario_api_rejects_non_custom_key(self) -> None:
        response = self.client.delete("/api/custom-scenarios/not_a_custom_key")

        self.assertEqual(response.status_code, 400)

    def test_delete_custom_scenario_api_rejects_builtin_scenario(self) -> None:
        response = self.client.delete("/api/custom-scenarios/scenario_1")

        self.assertEqual(response.status_code, 400)

    def test_update_custom_scenario_api_returns_updated_summary(self) -> None:
        updated_definition = create_waypoint_scenario(
            key="custom_update_test",
            name="수정된 사용자 시나리오",
            target_climb_speed_mps=3.0,
            target_descent_speed_mps=1.6,
            vertical_accel_limit_mps2=1.0,
            home_lat=36.1716947,
            home_lon=128.4651771,
            home_alt_m=0.0,
            waypoints=(
                ScenarioWaypoint(
                    lat=36.1719,
                    lon=128.4653,
                    alt_m=140.0,
                    target_speed_mps=10.0,
                    hold_seconds=2.0,
                ),
            ),
        )
        with patch("backend.main.update_custom_scenario_definition", return_value=updated_definition) as update_mock:
            response = self.client.put(
                "/api/custom-scenarios/custom_update_test",
                json={
                    "name": "수정된 사용자 시나리오",
                    "home": {
                        "lat": 36.1716947,
                        "lon": 128.4651771,
                        "alt_m": 0.0,
                    },
                    "target_climb_speed_mps": 3.0,
                    "target_descent_speed_mps": 1.6,
                    "vertical_accel_limit_mps2": 1.0,
                    "waypoints": [
                        {
                            "lat": 36.1719,
                            "lon": 128.4653,
                            "alt_m": 140.0,
                            "target_speed_mps": 10.0,
                            "hold_seconds": 2.0,
                        },
                    ],
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["key"], "custom_update_test")
        self.assertEqual(payload["name"], "수정된 사용자 시나리오")
        self.assertEqual(payload["waypoint_count"], 1)
        update_mock.assert_called_once()


class SimulationProgressTests(unittest.TestCase):
    def test_get_reached_waypoint_count_reflects_runtime_phase(self) -> None:
        self.assertEqual(
            get_reached_waypoint_count(MissionRuntime("takeoff", 0, 0.0, False), 4),
            0,
        )
        self.assertEqual(
            get_reached_waypoint_count(MissionRuntime("waypoint", 2, 0.0, True), 4),
            2,
        )
        self.assertEqual(
            get_reached_waypoint_count(MissionRuntime("hold", 2, 0.5, True), 4),
            3,
        )

    def test_waypoint_progress_stays_zero_before_first_waypoint_arrival(self) -> None:
        self.assertEqual(
            calculate_waypoint_progress_percent(
                runtime=MissionRuntime(
                    phase="takeoff",
                    waypoint_index=0,
                    hold_remaining_s=0.0,
                    mission_recording_active=False,
                ),
                total_waypoints=4,
            ),
            0.0,
        )

    def test_waypoint_progress_uses_first_and_last_waypoint_as_bounds(self) -> None:
        self.assertEqual(
            calculate_waypoint_progress_percent(
                runtime=MissionRuntime(
                    phase="hold",
                    waypoint_index=0,
                    hold_remaining_s=1.0,
                    mission_recording_active=True,
                ),
                total_waypoints=4,
            ),
            0.0,
        )
        self.assertEqual(
            calculate_waypoint_progress_percent(
                runtime=MissionRuntime(
                    phase="waypoint",
                    waypoint_index=2,
                    hold_remaining_s=0.0,
                    mission_recording_active=True,
                ),
                total_waypoints=4,
            ),
            (1.0 / 3.0) * 100.0,
        )
        self.assertEqual(
            calculate_waypoint_progress_percent(
                runtime=MissionRuntime(
                    phase="return_home",
                    waypoint_index=3,
                    hold_remaining_s=0.0,
                    mission_recording_active=False,
                ),
                total_waypoints=4,
            ),
            100.0,
        )

    def test_waypoint_progress_handles_single_waypoint_scenarios(self) -> None:
        self.assertEqual(
            calculate_waypoint_progress_percent(
                runtime=MissionRuntime(
                    phase="hold",
                    waypoint_index=0,
                    hold_remaining_s=1.0,
                    mission_recording_active=True,
                ),
                total_waypoints=1,
            ),
            100.0,
        )


class StreamControlTests(unittest.TestCase):
    def test_apply_stream_control_message_updates_pause_state(self) -> None:
        control_state = StreamControlState()

        apply_stream_control_message({"type": "control", "action": "pause"}, control_state)
        self.assertTrue(control_state.paused)

        apply_stream_control_message({"type": "control", "action": "resume"}, control_state)
        self.assertFalse(control_state.paused)

    def test_apply_stream_control_message_ignores_unrelated_payloads(self) -> None:
        control_state = StreamControlState(paused=True)

        apply_stream_control_message({"type": "telemetry"}, control_state)
        self.assertTrue(control_state.paused)

        apply_stream_control_message("pause", control_state)
        self.assertTrue(control_state.paused)


class AttitudeEstimatorTests(unittest.TestCase):
    def test_add_attitude_sensor_noise_adds_gaussian_offsets(self) -> None:
        with patch("backend.sensors.np.random.normal", side_effect=[0.12, -0.08, 0.25]):
            estimate = add_attitude_sensor_noise(
                AttitudeEstimate(
                    roll_deg=1.0,
                    pitch_deg=-2.0,
                    yaw_deg=45.0,
                ),
            )

        self.assertAlmostEqual(estimate.roll_deg, 1.12)
        self.assertAlmostEqual(estimate.pitch_deg, -2.08)
        self.assertAlmostEqual(estimate.yaw_deg, 45.25)

    def test_estimate_attitude_projects_acceleration_into_body_frame(self) -> None:
        estimator_state = AttitudeEstimatorState()

        estimate = estimate_attitude_from_acceleration(
            accel_north_mps2=9.80665,
            accel_east_mps2=0.0,
            velocity_north_mps=5.0,
            velocity_east_mps=0.0,
            estimator_state=estimator_state,
            dt=0.05,
        )

        self.assertAlmostEqual(estimate.roll_deg, 0.0)
        self.assertAlmostEqual(estimate.pitch_deg, -3.2, places=1)
        self.assertAlmostEqual(estimate.yaw_deg, 0.0)

    def test_estimate_attitude_uses_velocity_heading_for_yaw(self) -> None:
        estimator_state = AttitudeEstimatorState()

        estimate = estimate_attitude_from_acceleration(
            accel_north_mps2=0.0,
            accel_east_mps2=0.0,
            velocity_north_mps=0.0,
            velocity_east_mps=5.0,
            estimator_state=estimator_state,
            dt=0.05,
        )

        self.assertGreater(estimate.yaw_deg, 0.0)
        self.assertLess(estimate.yaw_deg, 10.0)

        for _ in range(80):
            estimate = estimate_attitude_from_acceleration(
                accel_north_mps2=0.0,
                accel_east_mps2=0.0,
                velocity_north_mps=0.0,
                velocity_east_mps=5.0,
                estimator_state=estimator_state,
                dt=0.05,
            )

        self.assertAlmostEqual(estimate.yaw_deg, 90.0, delta=2.0)


if __name__ == "__main__":
    unittest.main()
