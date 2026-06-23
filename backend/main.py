from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from math import hypot
from math import log10
from math import sin

from fastapi import FastAPI
from fastapi import HTTPException
from fastapi import Request
from fastapi import WebSocket
from fastapi import WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.airspace import AirspaceDataFetchError
from backend.airspace import build_molit_airspace_params
from backend.airspace import extract_airspace_features
from backend.airspace import fetch_molit_airspace_payload
from backend.airspace import get_molit_airspace_api_key
from backend.airspace import MOLIT_AIRSPACE_DATASETS
from backend.airspace import parse_bbox
from backend.drone_specs import DroneSpec
from backend.drone_specs import delete_drone_spec
from backend.drone_specs import get_drone_spec
from backend.drone_specs import has_custom_drone_spec_override
from backend.drone_specs import is_builtin_drone_spec_key
from backend.drone_specs import list_drone_spec_entries
from backend.drone_specs import save_custom_drone_spec
from backend.drone_specs import update_drone_spec
from backend.formation import FormationSyncManager
from backend.logger import CompletedScenarioReplayLog
from backend.logger import list_completed_scenario_logs
from backend.logger import read_completed_scenario_log
from backend.logger import CompletedScenarioTelemetrySample
from backend.logger import save_completed_scenario_log
from backend.mavlink_bridge import close_mavlink_connection
from backend.mavlink_bridge import clear_mission
from backend.mavlink_bridge import command_ack_is_expected_stream_request_rejection
from backend.mavlink_bridge import command_ack_succeeded
from backend.mavlink_bridge import create_mission_item
from backend.mavlink_bridge import create_mavlink_connection
from backend.mavlink_bridge import describe_command_ack
from backend.mavlink_bridge import describe_mission_ack
from backend.mavlink_bridge import extract_statustext
from backend.mavlink_bridge import has_position
from backend.mavlink_bridge import is_vehicle_heartbeat
from backend.mavlink_bridge import list_serial_ports
from backend.mavlink_bridge import MavlinkMissionItem
from backend.mavlink_bridge import MavlinkTelemetrySnapshot
from backend.mavlink_bridge import MavlinkVehicleStatusSnapshot
from backend.mavlink_bridge import message_matches_filters
from backend.mavlink_bridge import mission_ack_succeeded
from backend.mavlink_bridge import request_live_data_streams
from backend.mavlink_bridge import send_arm_command
from backend.mavlink_bridge import send_auto_mode_command
from backend.mavlink_bridge import send_gcs_heartbeat
from backend.mavlink_bridge import send_guided_mode_command
from backend.mavlink_bridge import send_hold_mode_command
from backend.mavlink_bridge import send_land_command
from backend.mavlink_bridge import send_mission_count
from backend.mavlink_bridge import send_mission_item
from backend.mavlink_bridge import send_mission_start_command
from backend.mavlink_bridge import send_rtl_mode_command
from backend.mavlink_bridge import send_takeoff_command
from backend.mavlink_bridge import set_connection_target
from backend.mavlink_bridge import set_current_mission_item
from backend.mavlink_bridge import update_snapshot_from_message
from backend.mavlink_bridge import update_vehicle_status_from_message
from backend.paths import bundled_path
from backend.physics import ControlInput
from backend.physics import DroneState
from backend.physics import SIMULATION_DT_SECONDS
from backend.physics import render_telemetry
from backend.physics import step_state
from backend.scenario import delete_custom_scenario as delete_custom_scenario_definition
from backend.scenario import EARTH_METERS_PER_DEGREE_LAT
from backend.scenario import get_formation_scenario_definition
from backend.scenario import get_scenario_definition
from backend.scenario import is_custom_scenario_key
from backend.scenario import meters_per_degree_lon
from backend.scenario import generate_scenario
from backend.scenario import list_scenarios
from backend.scenario import save_custom_scenario
from backend.scenario import ScenarioDefinition
from backend.scenario import ScenarioWaypoint
from backend.scenario import update_custom_scenario as update_custom_scenario_definition
from backend.sensors import add_attitude_sensor_noise
from backend.sensors import apply_sensor_telemetry_model
from backend.sensors import AttitudeEstimatorState
from backend.sensors import estimate_attitude_from_acceleration
from backend.sensors import SensorTelemetryState
from backend.schemas import AirspaceStatusResponse
from backend.schemas import CustomDroneSpecCreateRequest
from backend.schemas import CustomScenarioCreateRequest
from backend.schemas import CustomScenarioWaypointRequest
from backend.schemas import DroneSpecDeleteResponse
from backend.schemas import DroneSpecResponse
from backend.schemas import HealthResponse
from backend.schemas import ReplayLogDetailResponse
from backend.schemas import ReplayLogSampleResponse
from backend.schemas import ReplayLogSummaryResponse
from backend.schemas import ScenarioDetailResponse
from backend.schemas import ScenarioGenerateRequest
from backend.schemas import ScenarioGenerateResponse
from backend.schemas import ScenarioResponse
from backend.schemas import ScenarioRoutePointResponse
from backend.schemas import ScenarioRouteResponse
from backend.schemas import ScenarioWaypointRouteResponse
from backend.schemas import SerialPortResponse
from backend.ws_manager import WebSocketManager


def build_scenario_response(scenario_definition: ScenarioDefinition) -> ScenarioResponse:
    """Serialize a scenario definition into the list/summary payload."""

    return ScenarioResponse(
        key=scenario_definition.key,
        name=scenario_definition.name,
        waypoint_count=scenario_definition.waypoint_count,
        estimated_frames=scenario_definition.estimated_frames,
        duration_seconds=scenario_definition.duration_seconds,
    )


def build_drone_spec_response(key: str, spec: DroneSpec, is_custom: bool) -> DroneSpecResponse:
    """Serialize a drone spec entry into the public API payload."""

    return DroneSpecResponse(
        key=key,
        is_custom=is_custom,
        is_overridden=(is_builtin_drone_spec_key(key) and has_custom_drone_spec_override(key)),
        name=spec.name,
        category=spec.category,
        max_horizontal_speed_mps=spec.max_horizontal_speed_mps,
        max_ascent_speed_mps=spec.max_ascent_speed_mps,
        max_descent_speed_mps=spec.max_descent_speed_mps,
        max_service_ceiling_m=spec.max_service_ceiling_m,
        max_flight_time_min=spec.max_flight_time_min,
        weight_g=spec.weight_g,
        rcs_estimate_m2=spec.rcs_estimate_m2,
        rf_signature=spec.rf_signature,
        rf_band=spec.rf_band,
        acoustic_signature_hz=spec.acoustic_signature_hz,
        thermal_signature_level=spec.thermal_signature_level,
        payload_capacity_g=spec.payload_capacity_g,
        sensor_notes=spec.sensor_notes,
    )


def build_scenario_detail_response(scenario_definition: ScenarioDefinition) -> ScenarioDetailResponse:
    """Serialize a scenario definition into the editable builder payload."""

    return ScenarioDetailResponse(
        key=scenario_definition.key,
        name=scenario_definition.name,
        is_custom=is_custom_scenario_key(scenario_definition.key),
        home=ScenarioRoutePointResponse(
            lat=scenario_definition.home_lat,
            lon=scenario_definition.home_lon,
            alt_m=scenario_definition.home_alt_m,
        ),
        target_climb_speed_mps=scenario_definition.target_climb_speed_mps,
        target_descent_speed_mps=scenario_definition.target_descent_speed_mps,
        vertical_accel_limit_mps2=scenario_definition.vertical_accel_limit_mps2,
        waypoints=[
            CustomScenarioWaypointRequest(
                lat=waypoint.lat,
                lon=waypoint.lon,
                alt_m=waypoint.alt_m,
                target_speed_mps=waypoint.target_speed_mps,
                hold_seconds=waypoint.hold_seconds,
            )
            for waypoint in scenario_definition.waypoints
        ],
    )


def resolve_replay_scenario_name(scenario_key: str) -> str:
    """Resolve a replay log scenario key into a human-friendly name."""

    if not scenario_key:
        return "-"

    try:
        return get_scenario_definition(scenario_key).name
    except ValueError:
        return scenario_key


def build_replay_log_summary_response(
    replay_log: CompletedScenarioReplayLog,
) -> ReplayLogSummaryResponse:
    """Serialize replay log metadata for the frontend."""

    return ReplayLogSummaryResponse(
        log_id=replay_log.log_id,
        filename=replay_log.filename,
        drone_name=replay_log.drone_name,
        scenario_key=replay_log.scenario_key,
        scenario_name=resolve_replay_scenario_name(replay_log.scenario_key),
        sample_count=replay_log.sample_count,
        started_at_utc=replay_log.started_at_utc,
        ended_at_utc=replay_log.ended_at_utc,
        duration_seconds=replay_log.duration_seconds,
    )


def build_replay_log_detail_response(
    replay_log: CompletedScenarioReplayLog,
) -> ReplayLogDetailResponse:
    """Serialize replay log metadata and samples for the frontend."""

    return ReplayLogDetailResponse(
        **build_replay_log_summary_response(replay_log).model_dump(),
        samples=[
            ReplayLogSampleResponse(
                sample_index=sample.sample_index,
                timestamp_utc=sample.timestamp_utc,
                elapsed_ms=sample.elapsed_ms,
                drone=sample.drone,
                scenario=sample.scenario,
                flight_mode=sample.flight_mode,
                lat_deg=sample.lat_deg,
                lon_deg=sample.lon_deg,
                alt_m=sample.alt_m,
                speed_mps=sample.speed_mps,
                accel_mps2=sample.accel_mps2,
            )
            for sample in replay_log.samples
        ],
    )


app = FastAPI(
    title="Drone Simulation System",
    version="1.0.0",
)
ws_manager = WebSocketManager()
formation_sync_manager = FormationSyncManager()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/css", StaticFiles(directory=bundled_path("frontend", "css")), name="css")
app.mount("/js", StaticFiles(directory=bundled_path("frontend", "js")), name="js")
app.mount("/vendor", StaticFiles(directory=bundled_path("frontend", "vendor")), name="vendor")
app.mount("/frontend", StaticFiles(directory=bundled_path("frontend")), name="frontend")


@app.get("/", response_model=HealthResponse)
async def read_root() -> HealthResponse:
    """Provide a basic health response for local checks."""

    return HealthResponse(status="ok", service="backend")


@app.get("/app")
async def read_app() -> FileResponse:
    """Serve the frontend entrypoint through the backend origin."""

    return FileResponse(bundled_path("frontend", "index.html"))


@app.get("/health", response_model=HealthResponse)
async def read_health() -> HealthResponse:
    """Provide a stable health endpoint for monitoring."""

    return HealthResponse(status="ok", service="backend")


@app.get("/api/mavlink/serial-ports", response_model=list[SerialPortResponse])
async def read_mavlink_serial_ports() -> list[SerialPortResponse]:
    """Return detected local serial ports for MAVLink connection setup."""

    try:
        ports = list_serial_ports()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return [
        SerialPortResponse(
            device=port.device,
            description=port.description,
            hwid=port.hwid,
            is_pixhawk_candidate=port.is_pixhawk_candidate,
        )
        for port in ports
    ]


@app.get("/api/airspace-zones/status", response_model=AirspaceStatusResponse)
async def read_airspace_status() -> AirspaceStatusResponse:
    """Report whether official airspace data can be loaded."""

    enabled = bool(get_molit_airspace_api_key())
    return AirspaceStatusResponse(
        enabled=enabled,
        source="국토교통부 공공데이터 REST API",
        zone_types=list(MOLIT_AIRSPACE_DATASETS.keys()),
        message=(
            "Public airspace API key configured."
            if enabled
            else "Set MOLIT_AIRSPACE_API_KEY to enable official airspace overlays."
        ),
    )


@app.get("/api/airspace-zones")
async def read_airspace_zones(
    bbox: str,
    zone_types: str = "prohibited,restricted",
) -> dict:
    """Return official airspace zones as GeoJSON features."""

    api_key = get_molit_airspace_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="Set MOLIT_AIRSPACE_API_KEY to enable official airspace overlays.",
        )

    parsed_bbox = parse_bbox(bbox)
    requested_zone_types = [
        zone_type.strip()
        for zone_type in zone_types.split(",")
        if zone_type.strip()
    ]
    invalid_zone_types = [
        zone_type for zone_type in requested_zone_types if zone_type not in MOLIT_AIRSPACE_DATASETS
    ]
    if invalid_zone_types:
        raise HTTPException(status_code=400, detail=f"Unknown zone type: {invalid_zone_types[0]}")

    features: list[dict] = []
    for zone_type in requested_zone_types or list(MOLIT_AIRSPACE_DATASETS.keys()):
        params = build_molit_airspace_params(
            api_key=api_key,
            dataset_key=zone_type,
            bbox=parsed_bbox,
        )
        try:
            payload = await fetch_molit_airspace_payload(params)
        except AirspaceDataFetchError as exc:
            raise HTTPException(status_code=502, detail="Failed to fetch public airspace data.") from exc
        features.extend(extract_airspace_features(payload, zone_type))

    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "source": "국토교통부 공공데이터 REST API",
            "zone_types": requested_zone_types or list(MOLIT_AIRSPACE_DATASETS.keys()),
        },
    }


@app.get("/api/airspace-zones/wms")
async def read_airspace_zone_wms_legacy(request: Request) -> dict:
    """Legacy compatibility endpoint for older frontends."""

    try:
        bbox = request.query_params["bbox"]
    except KeyError as exc:
        raise HTTPException(status_code=400, detail="bbox is required.") from exc
    return await read_airspace_zones(bbox=bbox)


@app.get("/api/drone-specs", response_model=list[DroneSpecResponse])
async def read_drone_specs() -> list[DroneSpecResponse]:
    """Return supported drone specifications for the frontend."""

    return [
        build_drone_spec_response(
            key=key,
            spec=spec,
            is_custom=key.startswith("custom_drone_"),
        )
        for key, spec in list_drone_spec_entries()
    ]


@app.post("/api/custom-drone-specs", response_model=DroneSpecResponse)
async def create_custom_drone_spec(
    payload: CustomDroneSpecCreateRequest,
) -> DroneSpecResponse:
    """Persist a user-authored drone specification for later simulation selection."""

    drone_name = payload.name.strip()
    if not drone_name:
        raise HTTPException(status_code=400, detail="Drone name is required.")

    drone_key, spec = save_custom_drone_spec(
        name=drone_name,
        category=payload.category,
        max_horizontal_speed_mps=payload.max_horizontal_speed_mps,
        max_ascent_speed_mps=payload.max_ascent_speed_mps,
        max_descent_speed_mps=payload.max_descent_speed_mps,
        max_service_ceiling_m=payload.max_service_ceiling_m,
        max_flight_time_min=payload.max_flight_time_min,
        weight_g=payload.weight_g,
        rcs_estimate_m2=payload.rcs_estimate_m2,
        rf_signature=payload.rf_signature,
        rf_band=payload.rf_band,
        acoustic_signature_hz=payload.acoustic_signature_hz,
        thermal_signature_level=payload.thermal_signature_level,
        payload_capacity_g=payload.payload_capacity_g,
        sensor_notes=payload.sensor_notes,
    )
    return build_drone_spec_response(key=drone_key, spec=spec, is_custom=True)


@app.put("/api/drone-specs/{drone_key}", response_model=DroneSpecResponse)
async def update_drone_spec_route(
    drone_key: str,
    payload: CustomDroneSpecCreateRequest,
) -> DroneSpecResponse:
    """Update a built-in drone override or an existing custom drone specification."""

    drone_name = payload.name.strip()
    if not drone_name:
        raise HTTPException(status_code=400, detail="Drone name is required.")

    try:
        spec = update_drone_spec(
            drone_key=drone_key,
            name=drone_name,
            category=payload.category,
            max_horizontal_speed_mps=payload.max_horizontal_speed_mps,
            max_ascent_speed_mps=payload.max_ascent_speed_mps,
            max_descent_speed_mps=payload.max_descent_speed_mps,
            max_service_ceiling_m=payload.max_service_ceiling_m,
            max_flight_time_min=payload.max_flight_time_min,
            weight_g=payload.weight_g,
            rcs_estimate_m2=payload.rcs_estimate_m2,
            rf_signature=payload.rf_signature,
            rf_band=payload.rf_band,
            acoustic_signature_hz=payload.acoustic_signature_hz,
            thermal_signature_level=payload.thermal_signature_level,
            payload_capacity_g=payload.payload_capacity_g,
            sensor_notes=payload.sensor_notes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Failed to update drone spec.") from exc

    return build_drone_spec_response(
        key=drone_key,
        spec=spec,
        is_custom=not is_builtin_drone_spec_key(drone_key),
    )


@app.delete("/api/drone-specs/{drone_key}", response_model=DroneSpecDeleteResponse)
async def delete_drone_spec_route(drone_key: str) -> DroneSpecDeleteResponse:
    """Delete a custom drone or restore a built-in drone to its default specification."""

    try:
        removed_spec, restored_builtin = delete_drone_spec(drone_key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Failed to delete drone spec.") from exc

    return DroneSpecDeleteResponse(
        key=drone_key,
        name=removed_spec.name,
        is_custom=not restored_builtin,
        restored_builtin=restored_builtin,
    )


@app.get("/api/scenarios", response_model=list[ScenarioResponse])
async def read_scenarios() -> list[ScenarioResponse]:
    """Return supported scenario definitions."""

    return [build_scenario_response(scenario) for scenario in list_scenarios()]


@app.get("/api/scenarios/{scenario_key}", response_model=ScenarioDetailResponse)
async def read_scenario_detail(
    scenario_key: str,
) -> ScenarioDetailResponse:
    """Return the full editable payload for a scenario definition."""

    try:
        scenario_definition = get_scenario_definition(scenario_key)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return build_scenario_detail_response(scenario_definition)


@app.post("/api/custom-scenarios", response_model=ScenarioResponse)
async def create_custom_scenario(
    payload: CustomScenarioCreateRequest,
) -> ScenarioResponse:
    """Persist a user-authored waypoint scenario and expose it to the UI."""

    scenario_name = payload.name.strip()
    if not scenario_name:
        raise HTTPException(status_code=400, detail="Scenario name is required.")
    if not payload.waypoints:
        raise HTTPException(status_code=400, detail="At least one waypoint is required.")

    try:
        scenario_definition = save_custom_scenario(
            name=scenario_name,
            home_lat=payload.home.lat,
            home_lon=payload.home.lon,
            home_alt_m=payload.home.alt_m,
            target_climb_speed_mps=payload.target_climb_speed_mps,
            target_descent_speed_mps=payload.target_descent_speed_mps,
            vertical_accel_limit_mps2=payload.vertical_accel_limit_mps2,
            waypoints=[
                ScenarioWaypoint(
                    lat=waypoint.lat,
                    lon=waypoint.lon,
                    alt_m=waypoint.alt_m,
                    target_speed_mps=waypoint.target_speed_mps,
                    hold_seconds=waypoint.hold_seconds,
                )
                for waypoint in payload.waypoints
            ],
        )
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Failed to save custom scenario.") from exc

    return build_scenario_response(scenario_definition)


@app.put("/api/custom-scenarios/{scenario_key}", response_model=ScenarioResponse)
async def update_custom_scenario_route(
    scenario_key: str,
    payload: CustomScenarioCreateRequest,
) -> ScenarioResponse:
    """Update a persisted custom scenario while keeping its key stable."""

    scenario_name = payload.name.strip()
    if not scenario_name:
        raise HTTPException(status_code=400, detail="Scenario name is required.")
    if not payload.waypoints:
        raise HTTPException(status_code=400, detail="At least one waypoint is required.")

    try:
        scenario_definition = update_custom_scenario_definition(
            scenario_key=scenario_key,
            name=scenario_name,
            home_lat=payload.home.lat,
            home_lon=payload.home.lon,
            home_alt_m=payload.home.alt_m,
            target_climb_speed_mps=payload.target_climb_speed_mps,
            target_descent_speed_mps=payload.target_descent_speed_mps,
            vertical_accel_limit_mps2=payload.vertical_accel_limit_mps2,
            waypoints=[
                ScenarioWaypoint(
                    lat=waypoint.lat,
                    lon=waypoint.lon,
                    alt_m=waypoint.alt_m,
                    target_speed_mps=waypoint.target_speed_mps,
                    hold_seconds=waypoint.hold_seconds,
                )
                for waypoint in payload.waypoints
            ],
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Failed to update custom scenario.") from exc

    return build_scenario_response(scenario_definition)


@app.delete("/api/custom-scenarios/{scenario_key}", response_model=ScenarioResponse)
async def delete_custom_scenario_route(
    scenario_key: str,
) -> ScenarioResponse:
    """Delete a saved custom scenario and return its summary."""

    if not is_custom_scenario_key(scenario_key):
        raise HTTPException(status_code=400, detail="Only custom scenarios can be deleted.")

    try:
        scenario_definition = delete_custom_scenario_definition(scenario_key)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Failed to delete custom scenario.") from exc

    return build_scenario_response(scenario_definition)


@app.post("/api/scenarios/generate", response_model=ScenarioGenerateResponse)
async def create_scenario(
    payload: ScenarioGenerateRequest,
) -> ScenarioGenerateResponse:
    """Generate a scenario summary for the selected drones."""

    scenario = generate_scenario(
        scenario_key=payload.scenario_key,
        drones=payload.drones,
    )
    return ScenarioGenerateResponse(
        scenario_key=scenario.scenario_key,
        scenario_name=scenario.scenario_name,
        drones=scenario.drones,
        waypoint_count=scenario.waypoint_count,
        estimated_frames=scenario.estimated_frames,
        estimated_duration_seconds=scenario.estimated_duration_seconds,
        recommended_primary_drone=scenario.recommended_primary_drone,
    )


@app.get("/api/scenarios/{scenario_key}/route", response_model=ScenarioRouteResponse)
async def read_scenario_route(
    scenario_key: str,
    slot: int = 0,
) -> ScenarioRouteResponse:
    """Return home and waypoint coordinates for the selected scenario."""

    try:
        scenario = get_formation_scenario_definition(scenario_key, slot)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return ScenarioRouteResponse(
        scenario_key=scenario.key,
        scenario_name=scenario.name,
        home=ScenarioRoutePointResponse(
            lat=scenario.home_lat,
            lon=scenario.home_lon,
            alt_m=scenario.home_alt_m,
        ),
        waypoints=[
            ScenarioWaypointRouteResponse(
                index=index,
                lat=waypoint.lat,
                lon=waypoint.lon,
                alt_m=waypoint.alt_m,
                target_speed_mps=waypoint.target_speed_mps,
                hold_seconds=waypoint.hold_seconds,
            )
            for index, waypoint in enumerate(scenario.waypoints, start=1)
        ],
    )


@app.get("/api/replay/logs", response_model=list[ReplayLogSummaryResponse])
async def read_replay_logs() -> list[ReplayLogSummaryResponse]:
    """Return saved completed-scenario logs that can be replayed in the UI."""

    return [
        build_replay_log_summary_response(replay_log)
        for replay_log in list_completed_scenario_logs()
    ]


@app.get("/api/replay/logs/{log_id}", response_model=ReplayLogDetailResponse)
async def read_replay_log_detail(
    log_id: str,
) -> ReplayLogDetailResponse:
    """Return the full sample sequence for a saved replay log."""

    try:
        replay_log = read_completed_scenario_log(log_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Failed to read replay log.") from exc

    return build_replay_log_detail_response(replay_log)


def clamp_acceleration_toward_target(
    current_velocity_mps: float,
    target_velocity_mps: float,
    accel_limit_mps2: float,
) -> float:
    """Return a bounded acceleration command that steers velocity toward a target."""

    required_accel = (target_velocity_mps - current_velocity_mps) / SIMULATION_DT_SECONDS
    return max(-accel_limit_mps2, min(accel_limit_mps2, required_accel))


MISSION_RECORDING_START_MESSAGE = "__mission_recording_start__"
MISSION_RECORDING_STOP_MESSAGE = "__mission_recording_stop__"
FLIGHT_MODE_MESSAGE_PREFIX = "__flight_mode__|"
WAYPOINT_POSITION_TOLERANCE_M = 3.0
WAYPOINT_ALTITUDE_TOLERANCE_M = 1.0
VELOCITY_SETTLE_TOLERANCE_MPS = 0.6
LANDING_SETTLE_TOLERANCE_MPS = 0.8
LANDING_POSITION_TOLERANCE_M = 4.0
LANDING_ALTITUDE_TOLERANCE_M = 1.2
WAYPOINT_PASS_WINDOW_MIN_DISTANCE_M = 6.0
WAYPOINT_PASS_WINDOW_MAX_DISTANCE_M = 12.0
WAYPOINT_PASS_ALTITUDE_TOLERANCE_M = 3.0
TURN_LOOKAHEAD_TIME_S = 2.0
TURN_LOOKAHEAD_MIN_DISTANCE_M = 8.0
TURN_LOOKAHEAD_MAX_DISTANCE_M = 24.0
TURN_OUTBOUND_ADVANCE_RATIO = 0.35
FIRST_WAYPOINT_MANUAL_HOLD_SECONDS = 5.0
TAKEOFF_VERTICAL_DEPARTURE_ALTITUDE_M = 20.0
MANUAL_FLIGHT_LATERAL_VARIATION_M = 2.4
MANUAL_FLIGHT_ALTITUDE_VARIATION_M = 1.1
MANUAL_LANDING_ALTITUDE_VARIATION_M = 0.35
MANUAL_FLIGHT_SPEED_VARIATION_RATIO = 0.0
MANUAL_FLIGHT_NOISE_FADE_DISTANCE_M = 28.0
MANUAL_FLIGHT_NOISE_FADE_ALTITUDE_M = 8.0
LIVE_TELEMETRY_SEND_INTERVAL_SECONDS = 0.1
LIVE_ATTITUDE_SEND_INTERVAL_SECONDS = 0.1
LIVE_GCS_HEARTBEAT_INTERVAL_SECONDS = 1.0
LIVE_STREAM_REQUEST_INTERVAL_SECONDS = 5.0
LIVE_HEARTBEAT_LOST_SECONDS = 5.0
LIVE_REQUIRED_HEARTBEATS = 2
FLIGHT_MODE_LABELS: dict[str, str] = {
    "takeoff": "AUTO",
    "waypoint": "GPS",
    "hold": "GPS",
    "formation_hold": "GPS",
    "return_home": "RTH",
    "landing": "LAND",
    "complete": "IDLE",
}

LEGACY_FLIGHT_MODE_LABELS: dict[str, str] = {
    "수동비행": "ATTITUDE",
    "자동비행": "GPS",
    "자동호버": "GPS",
    "임무종료": "IDLE",
}


@dataclass(frozen=True)
class MissionRuntime:
    """Mutable mission phase collapsed into an immutable step state."""

    phase: str
    waypoint_index: int
    hold_remaining_s: float
    mission_recording_active: bool


@dataclass(frozen=True)
class FlightSpeedLimits:
    """Resolved per-phase speed limits applied to control and physics."""

    max_horizontal_speed_mps: float
    max_ascent_speed_mps: float
    max_descent_speed_mps: float


@dataclass
class StreamControlState:
    """Mutable websocket control flags shared with the simulation loop."""

    paused: bool = False


@dataclass(frozen=True)
class LiveCommandRequest:
    """Outbound MAVLink command requested by the live-control UI."""

    action: str
    scenario_key: str = ""


@dataclass
class LiveMissionUploadState:
    """Mission upload handshake state tracked inside the live MAVLink loop."""

    scenario_name: str
    mission_items: list[MavlinkMissionItem]
    last_activity_s: float
    retry_count: int = 0


def get_flight_mode_label(phase: str) -> str:
    """Return the user-facing label for a mission phase."""

    return FLIGHT_MODE_LABELS.get(phase, phase)


def normalize_mode_token(value: str) -> str:
    """Convert mode text into a stable lowercase token."""

    return "".join(
        character.lower() if character.isalnum() else "_"
        for character in value.strip()
    ).strip("_")


def resolve_display_flight_mode(
    *,
    mode_key: str = "",
    mode_label: str = "",
) -> tuple[str, str]:
    """Normalize live and replay mode labels into a shared UI vocabulary."""

    normalized_key = normalize_mode_token(mode_key) or normalize_mode_token(mode_label)
    if not normalized_key:
        return "", ""

    legacy_label = LEGACY_FLIGHT_MODE_LABELS.get(mode_label.strip())
    if legacy_label:
        return normalize_mode_token(legacy_label), legacy_label

    if (
        normalized_key in {"rth", "rtl", "return_home", "smart_rtl", "return", "return_to_launch"}
        or "rtl" in normalized_key
        or "return" in normalized_key
    ):
        return "rth", "RTH"

    if "land" in normalized_key:
        return "land", "LAND"

    if (
        normalized_key in {"gps", "loiter", "poshold", "position", "posctl", "hold", "brake"}
        or normalized_key.startswith("pos")
        or "loiter" in normalized_key
        or "guided" in normalized_key
    ):
        return "gps", "GPS"

    if (
        normalized_key in {"auto", "mission", "takeoff", "take_off"}
        or normalized_key.startswith("auto")
        or normalized_key.startswith("mission")
        or "takeoff" in normalized_key
    ):
        return "auto", "AUTO"

    if (
        normalized_key in {"manual", "acro"}
        or normalized_key.startswith("manual")
        or normalized_key.startswith("acro")
    ):
        return "manual", "MANUAL"

    if (
        normalized_key in {"attitude", "stabilize", "stabilized", "stabilise", "stabilized_mode", "sport"}
        or normalized_key.startswith("stabil")
        or "attitude" in normalized_key
    ):
        return "attitude", "ATTITUDE"

    if (
        normalized_key in {"altitude", "alt_hold", "althold", "altctl", "altitude_hold"}
        or normalized_key.startswith("alt")
    ):
        return "altitude", "ALTITUDE"

    if normalized_key in {"idle", "complete", "mission_end"}:
        return "idle", "IDLE"

    display_label = mode_label.strip().upper() or normalized_key.upper()
    return normalize_mode_token(display_label), display_label


def resolve_live_flight_mode_presentation(
    status_snapshot: MavlinkVehicleStatusSnapshot,
) -> tuple[str, str]:
    """Return the normalized live mode key and label for UI display."""

    return resolve_display_flight_mode(
        mode_key=status_snapshot.mode_key or "",
        mode_label=status_snapshot.mode_label or "",
    )


def build_flight_mode_log_message(phase: str) -> str:
    """Encode a machine-readable mode change event inside a log message."""

    return f"{FLIGHT_MODE_MESSAGE_PREFIX}{phase}|{get_flight_mode_label(phase)}"


def build_live_flight_mode_log_message(mode_key: str, mode_label: str) -> str:
    """Encode a live-vehicle mode change for the existing frontend event parser."""

    normalized_mode_key = "".join(
        character.lower() if character.isalnum() else "_"
        for character in mode_key.strip()
    ).strip("_") or "unknown"
    normalized_mode_label = mode_label.strip() or normalized_mode_key.upper()
    return f"{FLIGHT_MODE_MESSAGE_PREFIX}{normalized_mode_key}|{normalized_mode_label}"


def build_live_status_signature(
    *,
    connection_phase: str,
    heartbeat_seen: bool,
    heartbeat_count: int,
    target_system_id: int | None,
    target_component_id: int | None,
    status_snapshot: MavlinkVehicleStatusSnapshot,
) -> tuple[object, ...]:
    """Build a stable comparison key for live status updates."""

    display_mode_key, display_mode_label = resolve_live_flight_mode_presentation(status_snapshot)
    return (
        connection_phase,
        heartbeat_seen,
        heartbeat_count,
        target_system_id,
        target_component_id,
        display_mode_key,
        display_mode_label,
        status_snapshot.armed,
        status_snapshot.autopilot_label,
        status_snapshot.vehicle_type_label,
        status_snapshot.system_status_label,
        status_snapshot.battery_remaining_pct,
        status_snapshot.battery_voltage_v,
        status_snapshot.battery_current_a,
        status_snapshot.gps_fix_label,
        status_snapshot.satellites_visible,
        status_snapshot.firmware_version_label,
        status_snapshot.autopilot_capabilities,
    )


def build_live_status_payload(
    *,
    timestamp: str,
    connection_phase: str,
    heartbeat_seen: bool,
    heartbeat_count: int,
    target_system_id: int | None,
    target_component_id: int | None,
    status_snapshot: MavlinkVehicleStatusSnapshot,
) -> dict[str, object]:
    """Serialize the latest live-vehicle status for the frontend."""

    display_mode_key, display_mode_label = resolve_live_flight_mode_presentation(status_snapshot)
    return {
        "type": "live_status",
        "timestamp": timestamp,
        "connection_phase": connection_phase,
        "heartbeat_seen": heartbeat_seen,
        "heartbeat_count": heartbeat_count,
        "target_system_id": target_system_id,
        "target_component_id": target_component_id,
        "mode_key": display_mode_key,
        "mode_label": display_mode_label,
        "armed": status_snapshot.armed,
        "autopilot_label": status_snapshot.autopilot_label or "",
        "vehicle_type_label": status_snapshot.vehicle_type_label or "",
        "system_status_label": status_snapshot.system_status_label or "",
        "battery_remaining_pct": status_snapshot.battery_remaining_pct,
        "battery_voltage_v": status_snapshot.battery_voltage_v,
        "battery_current_a": status_snapshot.battery_current_a,
        "gps_fix_label": status_snapshot.gps_fix_label or "",
        "satellites_visible": status_snapshot.satellites_visible,
        "firmware_version_label": status_snapshot.firmware_version_label or "",
        "autopilot_capabilities": status_snapshot.autopilot_capabilities,
    }


def build_live_alert_payload(
    *,
    timestamp: str,
    message: str,
    title: str = "실기체 경고",
    severity: str = "error",
) -> dict[str, object]:
    """Serialize a user-facing live-control alert for the frontend."""

    return {
        "type": "alert",
        "timestamp": timestamp,
        "title": title,
        "message": message,
        "level": severity,
    }


def append_mode_change_log(
    pending_logs: list[str],
    previous_phase: str,
    next_phase: str,
) -> None:
    """Append a hidden mode change event when the mission phase changes."""

    if previous_phase == next_phase:
        return

    pending_logs.append(build_flight_mode_log_message(next_phase))


def initialize_mission_runtime() -> MissionRuntime:
    """Create the initial climb-and-departure phase for a waypoint mission."""

    return MissionRuntime(
        phase="takeoff",
        waypoint_index=0,
        hold_remaining_s=0.0,
        mission_recording_active=False,
    )


def release_formation_hold(runtime: MissionRuntime) -> MissionRuntime:
    """Resume the manual first-waypoint hold after a formation barrier releases."""

    return MissionRuntime(
        phase="takeoff",
        waypoint_index=runtime.waypoint_index,
        hold_remaining_s=runtime.hold_remaining_s,
        mission_recording_active=runtime.mission_recording_active,
    )


def resolve_flight_speed_limits(
    runtime: MissionRuntime,
    individual_max_horizontal_speed_mps: float,
    individual_max_ascent_speed_mps: float,
    individual_max_descent_speed_mps: float,
    formation_horizontal_cap_mps: float | None = None,
    formation_ascent_cap_mps: float | None = None,
    formation_descent_cap_mps: float | None = None,
) -> FlightSpeedLimits:
    """Apply per-drone caps before waypoint 1 and formation caps after rendezvous."""

    if runtime.phase == "takeoff":
        return FlightSpeedLimits(
            max_horizontal_speed_mps=individual_max_horizontal_speed_mps,
            max_ascent_speed_mps=individual_max_ascent_speed_mps,
            max_descent_speed_mps=individual_max_descent_speed_mps,
        )

    return FlightSpeedLimits(
        max_horizontal_speed_mps=min(
            individual_max_horizontal_speed_mps,
            (
                formation_horizontal_cap_mps
                if formation_horizontal_cap_mps is not None
                else individual_max_horizontal_speed_mps
            ),
        ),
        max_ascent_speed_mps=min(
            individual_max_ascent_speed_mps,
            (
                formation_ascent_cap_mps
                if formation_ascent_cap_mps is not None
                else individual_max_ascent_speed_mps
            ),
        ),
        max_descent_speed_mps=min(
            individual_max_descent_speed_mps,
            (
                formation_descent_cap_mps
                if formation_descent_cap_mps is not None
                else individual_max_descent_speed_mps
            ),
        ),
    )


def calculate_offset_to_target_m(
    current_lat: float,
    current_lon: float,
    target_lat: float,
    target_lon: float,
) -> tuple[float, float]:
    """Convert target WGS84 coordinates into local north/east offsets."""

    average_lat = (current_lat + target_lat) / 2.0
    north_offset_m = (target_lat - current_lat) * EARTH_METERS_PER_DEGREE_LAT
    east_offset_m = (target_lon - current_lon) * meters_per_degree_lon(average_lat)
    return north_offset_m, east_offset_m


def calculate_horizontal_speed_mps(state: DroneState) -> float:
    """Return horizontal speed from the N/E velocity components."""

    return hypot(state.velocity_north_mps, state.velocity_east_mps)


def has_reached_position_target(
    state: DroneState,
    target_lat: float,
    target_lon: float,
) -> bool:
    """Return whether the aircraft is close enough to a horizontal target."""

    north_offset_m, east_offset_m = calculate_offset_to_target_m(
        state.lat,
        state.lon,
        target_lat,
        target_lon,
    )
    return hypot(north_offset_m, east_offset_m) <= WAYPOINT_POSITION_TOLERANCE_M


def calculate_horizontal_distance_to_target_m(
    state: DroneState,
    target_lat: float,
    target_lon: float,
) -> float:
    """Return the planar distance from the aircraft to the target point."""

    north_offset_m, east_offset_m = calculate_offset_to_target_m(
        state.lat,
        state.lon,
        target_lat,
        target_lon,
    )
    return hypot(north_offset_m, east_offset_m)


def has_reached_altitude_target(state: DroneState, target_alt_m: float) -> bool:
    """Return whether the aircraft is close enough to the target altitude."""

    return abs(state.alt_m - target_alt_m) <= WAYPOINT_ALTITUDE_TOLERANCE_M


def has_reached_waypoint_target(
    state: DroneState,
    target_lat: float,
    target_lon: float,
    target_alt_m: float,
) -> bool:
    """Return whether the aircraft has crossed a waypoint without requiring a full stop."""

    return (
        has_reached_position_target(state, target_lat, target_lon)
        and has_reached_altitude_target(state, target_alt_m)
    )


def resolve_waypoint_pass_window_distance_m(state: DroneState) -> float:
    """Return a speed-aware distance window used for fly-through waypoint passage."""

    return max(
        WAYPOINT_PASS_WINDOW_MIN_DISTANCE_M,
        min(
            WAYPOINT_PASS_WINDOW_MAX_DISTANCE_M,
            calculate_horizontal_speed_mps(state) * 0.9,
        ),
    )


def has_passed_waypoint_target(
    state: DroneState,
    start_lat: float,
    start_lon: float,
    start_alt_m: float,
    target_lat: float,
    target_lon: float,
    target_alt_m: float,
) -> bool:
    """Return whether the aircraft has moved through a waypoint along its inbound leg."""

    if has_reached_waypoint_target(state, target_lat, target_lon, target_alt_m):
        return True

    leg_progress = calculate_route_segment_progress(
        state=state,
        start_point=(start_lat, start_lon, start_alt_m),
        end_point=(target_lat, target_lon, target_alt_m),
    )
    if leg_progress < 1.0:
        return False

    horizontal_distance_m = calculate_horizontal_distance_to_target_m(
        state=state,
        target_lat=target_lat,
        target_lon=target_lon,
    )
    altitude_error_m = abs(state.alt_m - target_alt_m)
    return (
        horizontal_distance_m <= resolve_waypoint_pass_window_distance_m(state)
        and altitude_error_m <= WAYPOINT_PASS_ALTITUDE_TOLERANCE_M
    )


def has_stabilized_at_target(
    state: DroneState,
    target_lat: float,
    target_lon: float,
    target_alt_m: float,
) -> bool:
    """Return whether the aircraft is settled at a target waypoint."""

    return (
        has_reached_position_target(state, target_lat, target_lon)
        and has_reached_altitude_target(state, target_alt_m)
        and calculate_horizontal_speed_mps(state) <= VELOCITY_SETTLE_TOLERANCE_MPS
        and abs(state.velocity_up_mps) <= VELOCITY_SETTLE_TOLERANCE_MPS
    )


def has_completed_landing(
    state: DroneState,
    target_lat: float,
    target_lon: float,
    target_alt_m: float,
) -> bool:
    """Return whether the aircraft has settled enough to end a landing."""

    return (
        calculate_horizontal_distance_to_target_m(state, target_lat, target_lon)
        <= LANDING_POSITION_TOLERANCE_M
        and abs(state.alt_m - target_alt_m) <= LANDING_ALTITUDE_TOLERANCE_M
        and calculate_horizontal_speed_mps(state) <= LANDING_SETTLE_TOLERANCE_MPS
        and abs(state.velocity_up_mps) <= LANDING_SETTLE_TOLERANCE_MPS
    )


def waypoint_requires_full_stop(hold_seconds: float) -> bool:
    """Return whether a waypoint should be treated as a hover point."""

    return hold_seconds > 0.0


def get_route_leg_start_point(
    scenario_definition: ScenarioDefinition,
    waypoint_index: int,
) -> tuple[float, float, float]:
    """Return the route point that starts the inbound leg to the selected waypoint."""

    if waypoint_index <= 0:
        return (
            scenario_definition.home_lat,
            scenario_definition.home_lon,
            scenario_definition.home_alt_m,
        )

    previous_waypoint = scenario_definition.waypoints[waypoint_index - 1]
    return (
        previous_waypoint.lat,
        previous_waypoint.lon,
        previous_waypoint.alt_m,
    )


def calculate_shifted_coordinate(
    start_lat: float,
    start_lon: float,
    north_offset_m: float,
    east_offset_m: float,
) -> tuple[float, float]:
    """Move a WGS84 point by a local north/east offset."""

    shifted_lat = start_lat + (north_offset_m / EARTH_METERS_PER_DEGREE_LAT)
    lon_scale = meters_per_degree_lon(start_lat)
    shifted_lon = start_lon if lon_scale == 0.0 else start_lon + (east_offset_m / lon_scale)
    return shifted_lat, shifted_lon


def is_manual_flight_phase(phase: str) -> bool:
    """Return whether the current phase should look like manual flight."""

    return phase in {"takeoff", "return_home", "landing"}


def should_apply_manual_flight_variation(phase: str, target_horizontal_speed_mps: float) -> bool:
    """Return whether target variation should be applied for the current control target."""

    if not is_manual_flight_phase(phase):
        return False
    if phase == "landing":
        return False
    if phase == "takeoff" and target_horizontal_speed_mps <= 0.0:
        return False
    return True


def calculate_manual_flight_wave_phase(
    state: DroneState,
    scenario_home_lat: float,
    scenario_home_lon: float,
    slot: int,
    phase: str,
) -> float:
    """Build a deterministic phase used to create smooth manual-like variation."""

    north_from_home_m, east_from_home_m = calculate_offset_to_target_m(
        scenario_home_lat,
        scenario_home_lon,
        state.lat,
        state.lon,
    )
    travel_distance_m = hypot(north_from_home_m, east_from_home_m)
    phase_offset = 0.0 if phase == "takeoff" else 1.7 if phase == "return_home" else 3.1
    return (travel_distance_m / 18.0) + (slot * 0.85) + phase_offset


def apply_manual_flight_variation(
    state: DroneState,
    target_lat: float,
    target_lon: float,
    target_alt_m: float,
    target_horizontal_speed_mps: float,
    max_horizontal_speed_mps: float,
    scenario_home_lat: float,
    scenario_home_lon: float,
    scenario_home_alt_m: float,
    slot: int,
    phase: str,
) -> tuple[float, float, float, float]:
    """Add small deterministic deviations so manual-flight segments feel less robotic."""

    north_offset_m, east_offset_m = calculate_offset_to_target_m(
        state.lat,
        state.lon,
        target_lat,
        target_lon,
    )
    distance_to_target_m = hypot(north_offset_m, east_offset_m)
    altitude_error_m = abs(state.alt_m - target_alt_m)
    if (
        phase == "landing"
        and distance_to_target_m <= WAYPOINT_POSITION_TOLERANCE_M
        and altitude_error_m <= WAYPOINT_ALTITUDE_TOLERANCE_M
    ):
        return target_lat, target_lon, target_alt_m, target_horizontal_speed_mps
    if (
        phase == "return_home"
        and distance_to_target_m <= WAYPOINT_PASS_WINDOW_MIN_DISTANCE_M
        and altitude_error_m <= WAYPOINT_PASS_ALTITUDE_TOLERANCE_M
    ):
        return target_lat, target_lon, target_alt_m, target_horizontal_speed_mps

    distance_fade = min(1.0, distance_to_target_m / MANUAL_FLIGHT_NOISE_FADE_DISTANCE_M)
    altitude_fade = min(1.0, altitude_error_m / MANUAL_FLIGHT_NOISE_FADE_ALTITUDE_M)
    variation_fade = max(distance_fade, altitude_fade)
    if variation_fade <= 0.0:
        return target_lat, target_lon, target_alt_m, target_horizontal_speed_mps

    wave_phase = calculate_manual_flight_wave_phase(
        state=state,
        scenario_home_lat=scenario_home_lat,
        scenario_home_lon=scenario_home_lon,
        slot=slot,
        phase=phase,
    )

    adjusted_target_lat = target_lat
    adjusted_target_lon = target_lon
    if phase != "landing" and distance_to_target_m > 0.0:
        north_unit = north_offset_m / distance_to_target_m
        east_unit = east_offset_m / distance_to_target_m
        perpendicular_north = -east_unit
        perpendicular_east = north_unit
        lateral_shift_m = (
            MANUAL_FLIGHT_LATERAL_VARIATION_M
            * distance_fade
            * sin(wave_phase)
        )
        adjusted_target_lat, adjusted_target_lon = calculate_shifted_coordinate(
            state.lat,
            state.lon,
            north_offset_m + (perpendicular_north * lateral_shift_m),
            east_offset_m + (perpendicular_east * lateral_shift_m),
        )

    altitude_variation_limit_m = (
        MANUAL_LANDING_ALTITUDE_VARIATION_M
        if phase == "landing"
        else MANUAL_FLIGHT_ALTITUDE_VARIATION_M
    )
    adjusted_target_alt_m = target_alt_m + (
        altitude_variation_limit_m
        * variation_fade
        * sin((wave_phase * 0.63) + 0.8)
    )
    adjusted_target_alt_m = max(scenario_home_alt_m, adjusted_target_alt_m)

    adjusted_target_horizontal_speed_mps = target_horizontal_speed_mps
    if target_horizontal_speed_mps > 0.0:
        speed_factor = 1.0 + (
            MANUAL_FLIGHT_SPEED_VARIATION_RATIO
            * variation_fade
            * sin((wave_phase * 0.82) - 0.45)
        )
        adjusted_target_horizontal_speed_mps = min(
            max_horizontal_speed_mps,
            max(1.2, target_horizontal_speed_mps * speed_factor),
        )

    return (
        adjusted_target_lat,
        adjusted_target_lon,
        adjusted_target_alt_m,
        adjusted_target_horizontal_speed_mps,
    )


def build_turn_anticipation_target(
    state: DroneState,
    current_waypoint: ScenarioWaypoint,
    next_waypoint: ScenarioWaypoint,
    target_horizontal_speed_mps: float,
) -> tuple[float, float, float]:
    """Shift the tracking target slightly onto the outbound leg to smooth fly-through turns."""

    north_to_current_m, east_to_current_m = calculate_offset_to_target_m(
        state.lat,
        state.lon,
        current_waypoint.lat,
        current_waypoint.lon,
    )
    distance_to_current_m = hypot(north_to_current_m, east_to_current_m)
    if distance_to_current_m <= WAYPOINT_POSITION_TOLERANCE_M:
        return current_waypoint.lat, current_waypoint.lon, current_waypoint.alt_m

    outbound_north_m, outbound_east_m = calculate_offset_to_target_m(
        current_waypoint.lat,
        current_waypoint.lon,
        next_waypoint.lat,
        next_waypoint.lon,
    )
    outbound_distance_m = hypot(outbound_north_m, outbound_east_m)
    if outbound_distance_m <= 0.0:
        return current_waypoint.lat, current_waypoint.lon, current_waypoint.alt_m

    lookahead_distance_m = min(
        TURN_LOOKAHEAD_MAX_DISTANCE_M,
        max(
            TURN_LOOKAHEAD_MIN_DISTANCE_M,
            target_horizontal_speed_mps * TURN_LOOKAHEAD_TIME_S,
        ),
    )
    if distance_to_current_m >= lookahead_distance_m:
        return current_waypoint.lat, current_waypoint.lon, current_waypoint.alt_m

    turn_progress = ((lookahead_distance_m - distance_to_current_m) / lookahead_distance_m) ** 2
    outbound_advance_m = min(
        outbound_distance_m * TURN_OUTBOUND_ADVANCE_RATIO,
        lookahead_distance_m * TURN_OUTBOUND_ADVANCE_RATIO,
    ) * turn_progress
    outbound_unit_north = outbound_north_m / outbound_distance_m
    outbound_unit_east = outbound_east_m / outbound_distance_m
    target_lat, target_lon = calculate_shifted_coordinate(
        state.lat,
        state.lon,
        north_to_current_m + (outbound_unit_north * outbound_advance_m),
        east_to_current_m + (outbound_unit_east * outbound_advance_m),
    )
    target_alt_m = current_waypoint.alt_m + (
        (next_waypoint.alt_m - current_waypoint.alt_m) * turn_progress
    )
    return target_lat, target_lon, target_alt_m


def build_target_tracking_control(
    state: DroneState,
    target_lat: float,
    target_lon: float,
    target_alt_m: float,
    target_horizontal_speed_mps: float,
    horizontal_accel_limit_mps2: float,
    vertical_accel_limit_mps2: float,
    max_horizontal_speed_mps: float,
    max_ascent_speed_mps: float,
    max_descent_speed_mps: float,
    require_horizontal_stop: bool = True,
) -> ControlInput:
    """Build acceleration commands that move the aircraft toward a target state."""

    north_offset_m, east_offset_m = calculate_offset_to_target_m(
        state.lat,
        state.lon,
        target_lat,
        target_lon,
    )
    horizontal_distance_m = hypot(north_offset_m, east_offset_m)
    if horizontal_distance_m > 0.0:
        north_unit = north_offset_m / horizontal_distance_m
        east_unit = east_offset_m / horizontal_distance_m
    else:
        north_unit = 0.0
        east_unit = 0.0

    stopping_horizontal_speed_mps = (2.0 * horizontal_accel_limit_mps2 * horizontal_distance_m) ** 0.5
    if require_horizontal_stop:
        desired_horizontal_speed_mps = min(
            target_horizontal_speed_mps,
            max_horizontal_speed_mps,
            stopping_horizontal_speed_mps,
        )
    else:
        desired_horizontal_speed_mps = min(
            target_horizontal_speed_mps,
            max_horizontal_speed_mps,
        )
    if require_horizontal_stop and horizontal_distance_m <= WAYPOINT_POSITION_TOLERANCE_M:
        desired_horizontal_speed_mps = 0.0

    desired_velocity_north_mps = north_unit * desired_horizontal_speed_mps
    desired_velocity_east_mps = east_unit * desired_horizontal_speed_mps

    altitude_error_m = target_alt_m - state.alt_m
    stopping_vertical_speed_mps = (2.0 * vertical_accel_limit_mps2 * abs(altitude_error_m)) ** 0.5
    if abs(altitude_error_m) <= WAYPOINT_ALTITUDE_TOLERANCE_M:
        desired_velocity_up_mps = 0.0
    elif altitude_error_m > 0.0:
        desired_velocity_up_mps = min(stopping_vertical_speed_mps, max_ascent_speed_mps)
    else:
        desired_velocity_up_mps = -min(stopping_vertical_speed_mps, max_descent_speed_mps)

    return ControlInput(
        accel_north_mps2=clamp_acceleration_toward_target(
            current_velocity_mps=state.velocity_north_mps,
            target_velocity_mps=desired_velocity_north_mps,
            accel_limit_mps2=horizontal_accel_limit_mps2,
        ),
        accel_east_mps2=clamp_acceleration_toward_target(
            current_velocity_mps=state.velocity_east_mps,
            target_velocity_mps=desired_velocity_east_mps,
            accel_limit_mps2=horizontal_accel_limit_mps2,
        ),
        accel_up_mps2=clamp_acceleration_toward_target(
            current_velocity_mps=state.velocity_up_mps,
            target_velocity_mps=desired_velocity_up_mps,
            accel_limit_mps2=vertical_accel_limit_mps2,
        ),
    )


def calculate_required_entry_speed_mps(
    remaining_distance_m: float,
    exit_speed_mps: float,
    accel_limit_mps2: float,
    max_horizontal_speed_mps: float,
) -> float:
    """Return the maximum admissible current speed to hit a target exit speed at a waypoint."""

    admissible_speed_mps = (
        (max(0.0, exit_speed_mps) ** 2)
        + (2.0 * max(0.1, accel_limit_mps2) * max(0.0, remaining_distance_m))
    ) ** 0.5
    return min(max_horizontal_speed_mps, admissible_speed_mps)


def resolve_rf_frequency_mhz(spec: DroneSpec) -> float:
    """Resolve a representative RF center frequency in MHz for logging."""

    rf_band_text = (spec.rf_band or "").strip().lower()
    if "900" in rf_band_text or "915" in rf_band_text:
        return 915.0
    if "5.8" in rf_band_text or "5800" in rf_band_text:
        return 5800.0
    if "433" in rf_band_text:
        return 433.0
    if "1.2" in rf_band_text or "1200" in rf_band_text:
        return 1200.0
    return 2400.0


def resolve_rf_protocol(spec: DroneSpec) -> str:
    """Resolve a representative RF protocol label for logging."""

    if spec.rf_signature:
        return spec.rf_signature

    normalized_name = spec.name.strip().lower()
    if "inspire 3" in normalized_name:
        return "DJI_O4"
    if "mavic 3" in normalized_name:
        return "DJI_O3+"
    if "mavic air 2" in normalized_name:
        return "OcuSync_2.0"
    if "phantom 4" in normalized_name or "inspire 2" in normalized_name:
        return "Lightbridge"
    return "Unknown"


def estimate_rssi_dbm(
    state: DroneState,
    reference_lat: float,
    reference_lon: float,
    reference_alt_m: float,
    slot: int,
) -> float:
    """Estimate a simple deterministic RSSI signal level for logging."""

    horizontal_distance_m = calculate_horizontal_distance_to_target_m(
        state=state,
        target_lat=reference_lat,
        target_lon=reference_lon,
    )
    altitude_delta_m = abs(state.alt_m - reference_alt_m)
    link_distance_m = max(1.0, hypot(horizontal_distance_m, altitude_delta_m))
    path_loss_db = 20.0 * log10(link_distance_m)
    deterministic_wobble_db = sin((horizontal_distance_m * 0.045) + (slot * 0.8)) * 1.4
    return max(-98.0, min(-32.0, -38.0 - path_loss_db + deterministic_wobble_db))


def transition_mission_runtime(
    runtime: MissionRuntime,
    state: DroneState,
    scenario_key: str,
    slot: int = 0,
    enable_first_waypoint_barrier: bool = False,
) -> tuple[MissionRuntime, list[str], bool]:
    """Advance mission phase based on the current settled aircraft state."""

    scenario_definition = get_formation_scenario_definition(scenario_key, slot)
    if not scenario_definition.waypoints:
        return runtime, [], False

    first_waypoint = scenario_definition.waypoints[0]
    current_runtime = runtime
    pending_logs: list[str] = []
    mission_complete = False

    while True:
        if current_runtime.phase == "takeoff":
            if current_runtime.hold_remaining_s > 0.0:
                remaining_hold_s = max(0.0, current_runtime.hold_remaining_s - SIMULATION_DT_SECONDS)
                if remaining_hold_s > 0.0:
                    current_runtime = MissionRuntime(
                        phase="takeoff",
                        waypoint_index=0,
                        hold_remaining_s=remaining_hold_s,
                        mission_recording_active=current_runtime.mission_recording_active,
                    )
                    break

                if len(scenario_definition.waypoints) == 1:
                    if current_runtime.mission_recording_active:
                        pending_logs.append(MISSION_RECORDING_STOP_MESSAGE)
                        pending_logs.append("임무 데이터 수집 종료")
                    pending_logs.append("홈포인트 복귀 시작")
                    previous_phase = current_runtime.phase
                    current_runtime = MissionRuntime(
                        phase="return_home",
                        waypoint_index=0,
                        hold_remaining_s=0.0,
                        mission_recording_active=False,
                    )
                    append_mode_change_log(pending_logs, previous_phase, current_runtime.phase)
                    continue

                pending_logs.append("자동비행 전환")
                previous_phase = current_runtime.phase
                current_runtime = MissionRuntime(
                    phase="waypoint",
                    waypoint_index=1,
                    hold_remaining_s=0.0,
                    mission_recording_active=current_runtime.mission_recording_active,
                )
                append_mode_change_log(pending_logs, previous_phase, current_runtime.phase)
                continue

            if not has_stabilized_at_target(
                state=state,
                target_lat=first_waypoint.lat,
                target_lon=first_waypoint.lon,
                target_alt_m=first_waypoint.alt_m,
            ):
                break

            pending_logs.append("1번 Waypoint 도착")
            recording_active = current_runtime.mission_recording_active
            if not recording_active:
                pending_logs.append(MISSION_RECORDING_START_MESSAGE)
                pending_logs.append("임무 데이터 수집 시작")
                recording_active = True
            pending_logs.append(f"자세 정비 {FIRST_WAYPOINT_MANUAL_HOLD_SECONDS:.0f}초 대기")

            if enable_first_waypoint_barrier:
                previous_phase = current_runtime.phase
                current_runtime = MissionRuntime(
                    phase="formation_hold",
                    waypoint_index=0,
                    hold_remaining_s=FIRST_WAYPOINT_MANUAL_HOLD_SECONDS,
                    mission_recording_active=recording_active,
                )
                append_mode_change_log(pending_logs, previous_phase, current_runtime.phase)
                break

            current_runtime = MissionRuntime(
                phase="takeoff",
                waypoint_index=0,
                hold_remaining_s=FIRST_WAYPOINT_MANUAL_HOLD_SECONDS,
                mission_recording_active=recording_active,
            )
            break

        if current_runtime.phase == "waypoint":
            current_waypoint = scenario_definition.waypoints[current_runtime.waypoint_index]
            waypoint_reached = has_stabilized_at_target(
                state,
                current_waypoint.lat,
                current_waypoint.lon,
                current_waypoint.alt_m,
            )

            if not waypoint_reached:
                break

            pending_logs.append(f"{current_runtime.waypoint_index + 1}번 Waypoint 도착")
            recording_active = current_runtime.mission_recording_active
            if current_runtime.waypoint_index == 0 and not recording_active:
                pending_logs.append(MISSION_RECORDING_START_MESSAGE)
                pending_logs.append("임무 데이터 수집 시작")
                recording_active = True

            if current_waypoint.hold_seconds > 0.0:
                previous_phase = current_runtime.phase
                current_runtime = MissionRuntime(
                    phase="formation_hold"
                    if enable_first_waypoint_barrier and current_runtime.waypoint_index == 0
                    else "hold",
                    waypoint_index=current_runtime.waypoint_index,
                    hold_remaining_s=current_waypoint.hold_seconds,
                    mission_recording_active=recording_active,
                )
                append_mode_change_log(pending_logs, previous_phase, current_runtime.phase)
                break

            if current_runtime.waypoint_index == len(scenario_definition.waypoints) - 1:
                if recording_active:
                    pending_logs.append(MISSION_RECORDING_STOP_MESSAGE)
                    pending_logs.append("임무 데이터 수집 종료")
                pending_logs.append("홈포인트 복귀 시작")
                previous_phase = current_runtime.phase
                current_runtime = MissionRuntime(
                    phase="return_home",
                    waypoint_index=current_runtime.waypoint_index,
                    hold_remaining_s=0.0,
                    mission_recording_active=False,
                )
                append_mode_change_log(pending_logs, previous_phase, current_runtime.phase)
                continue

            previous_phase = current_runtime.phase
            current_runtime = MissionRuntime(
                phase="waypoint",
                waypoint_index=current_runtime.waypoint_index + 1,
                hold_remaining_s=0.0,
                mission_recording_active=recording_active,
            )
            append_mode_change_log(pending_logs, previous_phase, current_runtime.phase)
            continue

        if current_runtime.phase == "hold":
            remaining_hold_s = max(0.0, current_runtime.hold_remaining_s - SIMULATION_DT_SECONDS)
            if remaining_hold_s > 0.0:
                current_runtime = MissionRuntime(
                    phase="hold",
                    waypoint_index=current_runtime.waypoint_index,
                    hold_remaining_s=remaining_hold_s,
                    mission_recording_active=current_runtime.mission_recording_active,
                )
                break

            if current_runtime.waypoint_index == len(scenario_definition.waypoints) - 1:
                if current_runtime.mission_recording_active:
                    pending_logs.append(MISSION_RECORDING_STOP_MESSAGE)
                    pending_logs.append("임무 데이터 수집 종료")
                pending_logs.append("홈포인트 복귀 시작")
                previous_phase = current_runtime.phase
                current_runtime = MissionRuntime(
                    phase="return_home",
                    waypoint_index=current_runtime.waypoint_index,
                    hold_remaining_s=0.0,
                    mission_recording_active=False,
                )
                append_mode_change_log(pending_logs, previous_phase, current_runtime.phase)
                continue

            previous_phase = current_runtime.phase
            current_runtime = MissionRuntime(
                phase="waypoint",
                waypoint_index=current_runtime.waypoint_index + 1,
                hold_remaining_s=0.0,
                mission_recording_active=current_runtime.mission_recording_active,
            )
            append_mode_change_log(pending_logs, previous_phase, current_runtime.phase)
            continue

        if current_runtime.phase == "formation_hold":
            break

        if current_runtime.phase == "return_home":
            final_altitude_m = scenario_definition.waypoints[-1].alt_m
            if not has_stabilized_at_target(
                state=state,
                target_lat=scenario_definition.home_lat,
                target_lon=scenario_definition.home_lon,
                target_alt_m=final_altitude_m,
            ):
                break
            pending_logs.append("착륙 시작")
            previous_phase = current_runtime.phase
            current_runtime = MissionRuntime(
                phase="landing",
                waypoint_index=current_runtime.waypoint_index,
                hold_remaining_s=0.0,
                mission_recording_active=False,
            )
            append_mode_change_log(pending_logs, previous_phase, current_runtime.phase)
            continue

        if current_runtime.phase == "landing":
            if not has_completed_landing(
                state,
                scenario_definition.home_lat,
                scenario_definition.home_lon,
                scenario_definition.home_alt_m,
            ):
                break
            pending_logs.append("비행 계획 종료")
            previous_phase = current_runtime.phase
            current_runtime = MissionRuntime(
                phase="complete",
                waypoint_index=current_runtime.waypoint_index,
                hold_remaining_s=0.0,
                mission_recording_active=False,
            )
            append_mode_change_log(pending_logs, previous_phase, current_runtime.phase)
            mission_complete = True
            break

        break

    return current_runtime, pending_logs, mission_complete


def build_mission_control(
    runtime: MissionRuntime,
    state: DroneState,
    scenario_key: str,
    max_horizontal_speed_mps: float,
    max_ascent_speed_mps: float,
    max_descent_speed_mps: float,
    slot: int = 0,
) -> ControlInput:
    """Convert mission phase and waypoint data into control inputs."""

    scenario_definition = get_formation_scenario_definition(scenario_key, slot)
    if not scenario_definition.waypoints or runtime.phase == "complete":
        return ControlInput(0.0, 0.0, 0.0)

    horizontal_accel_limit_mps2 = max(1.2, scenario_definition.vertical_accel_limit_mps2 * 1.8)
    vertical_accel_limit_mps2 = scenario_definition.vertical_accel_limit_mps2

    if runtime.phase == "takeoff":
        first_waypoint = scenario_definition.waypoints[0]
        departure_altitude_m = scenario_definition.home_alt_m + TAKEOFF_VERTICAL_DEPARTURE_ALTITUDE_M
        has_completed_initial_climb = (
            state.alt_m >= (departure_altitude_m - WAYPOINT_ALTITUDE_TOLERANCE_M)
        )

        if runtime.hold_remaining_s > 0.0:
            target_lat = first_waypoint.lat
            target_lon = first_waypoint.lon
            target_alt_m = first_waypoint.alt_m
            target_horizontal_speed_mps = 0.0
            require_horizontal_stop = True
        elif not has_completed_initial_climb:
            target_lat = scenario_definition.home_lat
            target_lon = scenario_definition.home_lon
            target_alt_m = departure_altitude_m
            target_horizontal_speed_mps = 0.0
            require_horizontal_stop = True
        else:
            target_lat = first_waypoint.lat
            target_lon = first_waypoint.lon
            target_alt_m = first_waypoint.alt_m
            target_horizontal_speed_mps = max_horizontal_speed_mps
            require_horizontal_stop = True
    elif runtime.phase == "return_home":
        target_lat = scenario_definition.home_lat
        target_lon = scenario_definition.home_lon
        target_alt_m = scenario_definition.waypoints[-1].alt_m
        target_horizontal_speed_mps = scenario_definition.waypoints[-1].target_speed_mps
        require_horizontal_stop = True
    elif runtime.phase == "landing":
        target_lat = scenario_definition.home_lat
        target_lon = scenario_definition.home_lon
        target_alt_m = scenario_definition.home_alt_m
        target_horizontal_speed_mps = 0.0
        require_horizontal_stop = True
    else:
        current_waypoint = scenario_definition.waypoints[runtime.waypoint_index]
        next_waypoint = (
            scenario_definition.waypoints[runtime.waypoint_index + 1]
            if runtime.waypoint_index < len(scenario_definition.waypoints) - 1
            else None
        )
        target_lat = current_waypoint.lat
        target_lon = current_waypoint.lon
        target_alt_m = current_waypoint.alt_m
        if runtime.phase in {"hold", "formation_hold"}:
            target_horizontal_speed_mps = 0.0
            require_horizontal_stop = True
        elif runtime.waypoint_index == 0 and not runtime.mission_recording_active:
            target_horizontal_speed_mps = max_horizontal_speed_mps
            require_horizontal_stop = True
        else:
            target_horizontal_speed_mps = current_waypoint.target_speed_mps
            require_horizontal_stop = True

        if runtime.phase == "waypoint":
            remaining_distance_m = calculate_horizontal_distance_to_target_m(
                state=state,
                target_lat=current_waypoint.lat,
                target_lon=current_waypoint.lon,
            )
            target_horizontal_speed_mps = min(
                target_horizontal_speed_mps,
                calculate_required_entry_speed_mps(
                    remaining_distance_m=remaining_distance_m,
                    exit_speed_mps=0.0,
                    accel_limit_mps2=horizontal_accel_limit_mps2,
                    max_horizontal_speed_mps=max_horizontal_speed_mps,
                ),
            )
    if runtime.phase == "return_home":
        remaining_home_distance_m = calculate_horizontal_distance_to_target_m(
            state=state,
            target_lat=scenario_definition.home_lat,
            target_lon=scenario_definition.home_lon,
        )
        target_horizontal_speed_mps = min(
            target_horizontal_speed_mps,
            calculate_required_entry_speed_mps(
                remaining_distance_m=remaining_home_distance_m,
                exit_speed_mps=0.0,
                accel_limit_mps2=horizontal_accel_limit_mps2,
                max_horizontal_speed_mps=max_horizontal_speed_mps,
            ),
        )

    if should_apply_manual_flight_variation(runtime.phase, target_horizontal_speed_mps):
        (
            target_lat,
            target_lon,
            target_alt_m,
            target_horizontal_speed_mps,
        ) = apply_manual_flight_variation(
            state=state,
            target_lat=target_lat,
            target_lon=target_lon,
            target_alt_m=target_alt_m,
            target_horizontal_speed_mps=target_horizontal_speed_mps,
            max_horizontal_speed_mps=max_horizontal_speed_mps,
            scenario_home_lat=scenario_definition.home_lat,
            scenario_home_lon=scenario_definition.home_lon,
            scenario_home_alt_m=scenario_definition.home_alt_m,
            slot=slot,
            phase=runtime.phase,
        )

    return build_target_tracking_control(
        state=state,
        target_lat=target_lat,
        target_lon=target_lon,
        target_alt_m=target_alt_m,
        target_horizontal_speed_mps=target_horizontal_speed_mps,
        horizontal_accel_limit_mps2=horizontal_accel_limit_mps2,
        vertical_accel_limit_mps2=vertical_accel_limit_mps2,
        max_horizontal_speed_mps=max_horizontal_speed_mps,
        max_ascent_speed_mps=max_ascent_speed_mps,
        max_descent_speed_mps=max_descent_speed_mps,
        require_horizontal_stop=require_horizontal_stop,
    )


def build_demo_control(
    step_index: int,
    scenario_key: str,
    current_vertical_speed_mps: float,
    max_ascent_speed_mps: float,
    max_descent_speed_mps: float,
) -> ControlInput:
    """Generate a smooth repeating control input for the selected scenario."""

    try:
        scenario = get_scenario_definition(scenario_key)
        phase_mod = max(scenario.waypoint_count * 40, 160)
        intensity = 0.5 + (scenario.waypoint_count * 0.05)
        target_climb_speed_mps = min(
            scenario.target_climb_speed_mps,
            max_ascent_speed_mps,
        )
        target_descent_speed_mps = min(
            scenario.target_descent_speed_mps,
            max_descent_speed_mps,
        )
        vertical_accel_limit_mps2 = scenario.vertical_accel_limit_mps2
    except ValueError:
        phase_mod = 240
        intensity = 0.8
        target_climb_speed_mps = min(2.4, max_ascent_speed_mps)
        target_descent_speed_mps = min(1.2, max_descent_speed_mps)
        vertical_accel_limit_mps2 = 1.0

    phase = step_index % phase_mod
    accel_north = intensity if phase < phase_mod * 0.25 else -intensity if phase < phase_mod * 0.5 else 0.0
    accel_east = (
        intensity * 0.6
        if phase_mod * 0.5 <= phase < phase_mod * 0.75
        else -intensity * 0.6 if phase >= phase_mod * 0.75 else 0.0
    )

    if phase < phase_mod * 0.35:
        target_vertical_speed_mps = target_climb_speed_mps
    elif phase > phase_mod * 0.78:
        target_vertical_speed_mps = -target_descent_speed_mps
    else:
        target_vertical_speed_mps = 0.0

    accel_up = clamp_acceleration_toward_target(
        current_velocity_mps=current_vertical_speed_mps,
        target_velocity_mps=target_vertical_speed_mps,
        accel_limit_mps2=vertical_accel_limit_mps2,
    )
    return ControlInput(
        accel_north_mps2=accel_north,
        accel_east_mps2=accel_east,
        accel_up_mps2=accel_up,
    )


def calculate_route_segment_distance_m(
    start_point: tuple[float, float, float],
    end_point: tuple[float, float, float],
) -> float:
    """Return 3D distance between two WGS84 route points."""

    north_offset_m, east_offset_m = calculate_offset_to_target_m(
        start_point[0],
        start_point[1],
        end_point[0],
        end_point[1],
    )
    up_offset_m = end_point[2] - start_point[2]
    return hypot(hypot(north_offset_m, east_offset_m), up_offset_m)


def calculate_route_segment_progress(
    state: DroneState,
    start_point: tuple[float, float, float],
    end_point: tuple[float, float, float],
) -> float:
    """Project the aircraft position onto a 3D route segment and clamp to 0..1."""

    leg_north_m, leg_east_m = calculate_offset_to_target_m(
        start_point[0],
        start_point[1],
        end_point[0],
        end_point[1],
    )
    leg_up_m = end_point[2] - start_point[2]
    leg_length_squared_m2 = (
        (leg_north_m * leg_north_m)
        + (leg_east_m * leg_east_m)
        + (leg_up_m * leg_up_m)
    )
    if leg_length_squared_m2 <= 0.0:
        return 1.0

    current_north_m, current_east_m = calculate_offset_to_target_m(
        start_point[0],
        start_point[1],
        state.lat,
        state.lon,
    )
    current_up_m = state.alt_m - start_point[2]
    progress = (
        (
            (current_north_m * leg_north_m)
            + (current_east_m * leg_east_m)
            + (current_up_m * leg_up_m)
        )
        / leg_length_squared_m2
    )
    return max(0.0, min(1.0, progress))


def calculate_home_route_progress_percent(
    state: DroneState,
    runtime: MissionRuntime,
    scenario_definition: ScenarioDefinition,
    completed: bool = False,
) -> float:
    """Calculate smooth progress along the home -> waypoints -> home route."""

    if completed or runtime.phase == "complete":
        return 100.0

    if not scenario_definition.waypoints:
        return 0.0

    route_points = [
        (scenario_definition.home_lat, scenario_definition.home_lon, scenario_definition.home_alt_m),
        *[(waypoint.lat, waypoint.lon, waypoint.alt_m) for waypoint in scenario_definition.waypoints],
        (scenario_definition.home_lat, scenario_definition.home_lon, scenario_definition.home_alt_m),
    ]
    segment_distances_m = [
        calculate_route_segment_distance_m(route_points[index], route_points[index + 1])
        for index in range(len(route_points) - 1)
    ]
    total_distance_m = sum(segment_distances_m)
    if total_distance_m <= 0.0:
        return 0.0

    waypoint_count = len(scenario_definition.waypoints)
    if runtime.phase in {"return_home", "landing"}:
        segment_index = waypoint_count
    else:
        segment_index = max(0, min(waypoint_count - 1, runtime.waypoint_index))
    segment_index = max(0, min(len(segment_distances_m) - 1, segment_index))

    segment_progress = calculate_route_segment_progress(
        state=state,
        start_point=route_points[segment_index],
        end_point=route_points[segment_index + 1],
    )
    completed_distance_m = (
        sum(segment_distances_m[:segment_index])
        + (segment_distances_m[segment_index] * segment_progress)
    )
    return max(0.0, min(100.0, (completed_distance_m / total_distance_m) * 100.0))


def get_reached_waypoint_count(
    runtime: MissionRuntime,
    total_waypoints: int,
) -> int:
    """Return the number of waypoints already reached for progress tracking."""

    if total_waypoints <= 0:
        return 0

    if runtime.phase == "takeoff":
        reached_waypoint_count = 0
    elif runtime.phase == "waypoint":
        reached_waypoint_count = runtime.waypoint_index
    else:
        reached_waypoint_count = runtime.waypoint_index + 1

    return max(0, min(total_waypoints, reached_waypoint_count))


def calculate_waypoint_progress_percent(
    runtime: MissionRuntime,
    total_waypoints: int,
) -> float:
    """Return coarse progress bounded by first and last waypoint arrival."""

    if total_waypoints <= 0:
        return 0.0

    reached_waypoint_count = get_reached_waypoint_count(runtime, total_waypoints)
    if total_waypoints == 1:
        return 100.0 if reached_waypoint_count > 0 else 0.0

    completed_intervals = max(0, reached_waypoint_count - 1)
    total_intervals = total_waypoints - 1
    return max(0.0, min(100.0, (completed_intervals / total_intervals) * 100.0))


def apply_stream_control_message(
    payload: object,
    control_state: StreamControlState,
) -> None:
    """Update websocket control state from an inbound control payload."""

    if not isinstance(payload, dict) or payload.get("type") != "control":
        return

    action = payload.get("action")
    if action == "pause":
        control_state.paused = True
    elif action == "resume":
        control_state.paused = False


async def receive_stream_control_messages(
    websocket: WebSocket,
    control_state: StreamControlState,
) -> None:
    """Consume inbound websocket control messages while streaming telemetry."""

    while True:
        payload = await websocket.receive_json()
        apply_stream_control_message(payload, control_state)


def build_live_mission_items(
    scenario_definition: ScenarioDefinition,
) -> list[MavlinkMissionItem]:
    """Translate a DSS scenario into a simple uploadable waypoint mission."""

    if not scenario_definition.waypoints:
        raise ValueError("업로드할 웨이포인트가 없습니다.")

    first_waypoint = scenario_definition.waypoints[0]
    takeoff_altitude_m = max(
        scenario_definition.home_alt_m + 5.0,
        first_waypoint.alt_m,
    )
    mission_items = [
        create_mission_item(
            0,
            command=24,
            lat=scenario_definition.home_lat,
            lon=scenario_definition.home_lon,
            alt_m=takeoff_altitude_m,
        ),
    ]
    for sequence_index, waypoint in enumerate(scenario_definition.waypoints, start=1):
        mission_items.append(
            create_mission_item(
                sequence_index,
                command=16,
                lat=waypoint.lat,
                lon=waypoint.lon,
                alt_m=waypoint.alt_m,
                param1=max(0.0, waypoint.hold_seconds),
                param2=2.0,
            ),
        )

    return mission_items


def parse_live_command_request(payload: object) -> LiveCommandRequest | None:
    """Decode a live MAVLink command from an inbound websocket payload."""

    if not isinstance(payload, dict) or payload.get("type") != "live_command":
        return None

    action = str(payload.get("action") or "").strip().lower()
    if not action:
        return None

    return LiveCommandRequest(
        action=action,
        scenario_key=str(payload.get("scenario_key") or "").strip(),
    )


async def receive_live_command_messages(
    websocket: WebSocket,
    command_queue: asyncio.Queue[LiveCommandRequest],
) -> None:
    """Consume inbound live MAVLink command requests from the browser."""

    while True:
        payload = await websocket.receive_json()
        command_request = parse_live_command_request(payload)
        if command_request is not None:
            await command_queue.put(command_request)


async def wait_for_websocket_disconnect(websocket: WebSocket) -> None:
    """Block until the client disconnects from a read-only websocket."""

    while True:
        await websocket.receive_text()


@app.websocket("/ws/live-telemetry")
async def live_telemetry_websocket(
    websocket: WebSocket,
    link_type: str = "udp",
    endpoint: str = "udp:0.0.0.0:14550",
    baudrate: int = 115200,
    system_id: int = 0,
    component_id: int = 0,
) -> None:
    """Stream live MAVLink telemetry and relay outbound vehicle commands."""

    await ws_manager.connect(websocket)
    connection = None
    snapshot = MavlinkTelemetrySnapshot()
    normalized_link_type = link_type.strip().lower()
    display_endpoint = endpoint.strip()
    last_telemetry_sent_at = 0.0
    last_attitude_sent_at = 0.0
    last_gcs_heartbeat_sent_at = 0.0
    last_stream_request_sent_at = 0.0
    heartbeat_seen = False
    heartbeat_count = 0
    heartbeat_counts: dict[tuple[int, int], int] = {}
    connection_phase = "opening"
    discovered_system_id: int | None = None
    discovered_component_id: int | None = None
    last_heartbeat_received_at: float | None = None
    live_status_snapshot = MavlinkVehicleStatusSnapshot()
    last_live_status_signature: tuple[object, ...] | None = None
    last_live_mode_log_message = ""
    command_queue: asyncio.Queue[LiveCommandRequest] = asyncio.Queue()
    command_receiver_task = asyncio.create_task(
        receive_live_command_messages(websocket, command_queue)
    )
    mission_upload_state: LiveMissionUploadState | None = None

    async def send_live_status_update(*, force: bool = False) -> None:
        nonlocal last_live_status_signature

        timestamp = datetime.now(UTC).isoformat()
        live_status_signature = build_live_status_signature(
            connection_phase=connection_phase,
            heartbeat_seen=heartbeat_seen,
            heartbeat_count=heartbeat_count,
            target_system_id=system_id if system_id > 0 else discovered_system_id,
            target_component_id=component_id if component_id > 0 else discovered_component_id,
            status_snapshot=live_status_snapshot,
        )
        if not force and live_status_signature == last_live_status_signature:
            return

        await ws_manager.send_json(
            websocket,
            build_live_status_payload(
                timestamp=timestamp,
                connection_phase=connection_phase,
                heartbeat_seen=heartbeat_seen,
                heartbeat_count=heartbeat_count,
                target_system_id=system_id if system_id > 0 else discovered_system_id,
                target_component_id=component_id if component_id > 0 else discovered_component_id,
                status_snapshot=live_status_snapshot,
            ),
        )
        last_live_status_signature = live_status_signature

    try:
        connection, display_endpoint = await asyncio.to_thread(
            create_mavlink_connection,
            normalized_link_type,
            endpoint,
            baudrate,
        )
        link_label = "Serial" if normalized_link_type == "serial" else "UDP"
        connection_phase = "waiting_heartbeat"
        await ws_manager.send_json(
            websocket,
            {
                "type": "log",
                "message": f"{link_label} MAVLink 포트 열림, Pixhawk HEARTBEAT 대기: {display_endpoint}",
                "timestamp": datetime.now(UTC).isoformat(),
            },
        )
        await send_live_status_update(force=True)

        while True:
            if command_receiver_task.done():
                command_receiver_task.result()

            loop_now_s = asyncio.get_running_loop().time()
            if loop_now_s - last_gcs_heartbeat_sent_at >= LIVE_GCS_HEARTBEAT_INTERVAL_SECONDS:
                await asyncio.to_thread(send_gcs_heartbeat, connection)
                last_gcs_heartbeat_sent_at = loop_now_s

            if (
                heartbeat_seen
                and last_heartbeat_received_at is not None
                and loop_now_s - last_heartbeat_received_at > LIVE_HEARTBEAT_LOST_SECONDS
            ):
                heartbeat_seen = False
                connection_phase = "heartbeat_lost"
                await ws_manager.send_json(
                    websocket,
                    {
                        "type": "log",
                        "message": "MAVLink heartbeat 수신이 끊겼습니다.",
                        "timestamp": datetime.now(UTC).isoformat(),
                    },
                )
                await send_live_status_update(force=True)

            if (
                heartbeat_seen
                and loop_now_s - last_stream_request_sent_at >= LIVE_STREAM_REQUEST_INTERVAL_SECONDS
            ):
                await asyncio.to_thread(request_live_data_streams, connection)
                last_stream_request_sent_at = loop_now_s

            while True:
                try:
                    command_request = command_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break

                resolved_system_id = system_id if system_id > 0 else discovered_system_id
                resolved_component_id = component_id if component_id > 0 else discovered_component_id
                if not heartbeat_seen or resolved_system_id is None or resolved_component_id is None:
                    timestamp = datetime.now(UTC).isoformat()
                    failure_message = (
                        "MAVLink heartbeat 재수신 전에는 명령을 보낼 수 없습니다."
                        if discovered_system_id is not None
                        else "MAVLink heartbeat 수신 전에는 명령을 보낼 수 없습니다."
                    )
                    await ws_manager.send_json(
                        websocket,
                        {
                            "type": "log",
                            "message": failure_message,
                            "timestamp": timestamp,
                        },
                    )
                    await ws_manager.send_json(
                        websocket,
                        build_live_alert_payload(
                            timestamp=timestamp,
                            title="명령 전송 실패",
                            message=failure_message,
                        ),
                    )
                    continue

                set_connection_target(
                    connection,
                    resolved_system_id,
                    resolved_component_id,
                )

                try:
                    if command_request.action == "arm":
                        await asyncio.to_thread(send_arm_command, connection, True)
                        await ws_manager.send_json(
                            websocket,
                            {
                                "type": "log",
                                "message": "ARM 명령 전송",
                                "timestamp": datetime.now(UTC).isoformat(),
                            },
                        )
                        continue

                    if command_request.action == "disarm":
                        await asyncio.to_thread(send_arm_command, connection, False)
                        await ws_manager.send_json(
                            websocket,
                            {
                                "type": "log",
                                "message": "DISARM 명령 전송",
                                "timestamp": datetime.now(UTC).isoformat(),
                            },
                        )
                        continue

                    if command_request.action == "guided":
                        selected_mode_name = await asyncio.to_thread(
                            send_guided_mode_command,
                            connection,
                        )
                        await ws_manager.send_json(
                            websocket,
                            {
                                "type": "log",
                                "message": f"유도 비행 모드 전환 요청: {selected_mode_name}",
                                "timestamp": datetime.now(UTC).isoformat(),
                            },
                        )
                        continue

                    if command_request.action == "takeoff":
                        takeoff_altitude_m = 5.0
                        if command_request.scenario_key:
                            scenario_definition = get_scenario_definition(command_request.scenario_key)
                            if scenario_definition.waypoints:
                                takeoff_altitude_m = max(
                                    scenario_definition.home_alt_m + 5.0,
                                    scenario_definition.waypoints[0].alt_m,
                                )
                        selected_mode_name = await asyncio.to_thread(
                            send_guided_mode_command,
                            connection,
                        )
                        await asyncio.sleep(0.15)
                        await asyncio.to_thread(send_takeoff_command, connection, takeoff_altitude_m)
                        await ws_manager.send_json(
                            websocket,
                            {
                                "type": "log",
                                "message": f"{selected_mode_name} 모드 전환 후 이륙 명령 전송: {takeoff_altitude_m:.1f}m",
                                "timestamp": datetime.now(UTC).isoformat(),
                            },
                        )
                        continue

                    if command_request.action == "land":
                        await asyncio.to_thread(send_land_command, connection)
                        await ws_manager.send_json(
                            websocket,
                            {
                                "type": "log",
                                "message": "착륙 명령 전송",
                                "timestamp": datetime.now(UTC).isoformat(),
                            },
                        )
                        continue

                    if command_request.action == "rtl":
                        await asyncio.to_thread(send_rtl_mode_command, connection)
                        await ws_manager.send_json(
                            websocket,
                            {
                                "type": "log",
                                "message": "RTH/RTL 명령 전송",
                                "timestamp": datetime.now(UTC).isoformat(),
                            },
                        )
                        continue

                    if command_request.action == "hold":
                        await asyncio.to_thread(send_hold_mode_command, connection)
                        await ws_manager.send_json(
                            websocket,
                            {
                                "type": "log",
                                "message": "HOLD/LOITER 명령 전송",
                                "timestamp": datetime.now(UTC).isoformat(),
                            },
                        )
                        continue

                    if command_request.action == "upload_mission":
                        if not command_request.scenario_key:
                            raise ValueError("업로드할 비행 계획을 먼저 선택하세요.")

                        scenario_definition = get_scenario_definition(command_request.scenario_key)
                        mission_items = build_live_mission_items(scenario_definition)
                        await asyncio.to_thread(clear_mission, connection)
                        await asyncio.sleep(0.15)
                        await asyncio.to_thread(send_mission_count, connection, len(mission_items))
                        mission_upload_state = LiveMissionUploadState(
                            scenario_name=scenario_definition.name,
                            mission_items=mission_items,
                            last_activity_s=loop_now_s,
                        )
                        await ws_manager.send_json(
                            websocket,
                            {
                                "type": "log",
                                "message": f"임무 업로드 시작: {scenario_definition.name} ({len(mission_items)}개 항목)",
                                "timestamp": datetime.now(UTC).isoformat(),
                            },
                        )
                        continue

                    if command_request.action == "start_mission":
                        await asyncio.to_thread(send_auto_mode_command, connection)
                        await asyncio.sleep(0.05)
                        await asyncio.to_thread(set_current_mission_item, connection, 0)
                        await asyncio.sleep(0.05)
                        await asyncio.to_thread(send_mission_start_command, connection)
                        await ws_manager.send_json(
                            websocket,
                            {
                                "type": "log",
                                "message": "임무 시작 명령 전송",
                                "timestamp": datetime.now(UTC).isoformat(),
                            },
                        )
                        continue

                    raise ValueError(f"지원하지 않는 실기체 명령입니다: {command_request.action}")
                except (RuntimeError, ValueError) as error:
                    timestamp = datetime.now(UTC).isoformat()
                    await ws_manager.send_json(
                        websocket,
                        {
                            "type": "log",
                            "message": str(error),
                            "timestamp": timestamp,
                        },
                    )
                    await ws_manager.send_json(
                        websocket,
                        build_live_alert_payload(
                            timestamp=timestamp,
                            title="실기체 명령 실패",
                            message=str(error),
                        ),
                    )
                    continue

            if mission_upload_state and loop_now_s - mission_upload_state.last_activity_s >= 2.0:
                if mission_upload_state.retry_count >= 3:
                    timeout_message = f"임무 업로드 시간 초과: {mission_upload_state.scenario_name}"
                    timestamp = datetime.now(UTC).isoformat()
                    await ws_manager.send_json(
                        websocket,
                        {
                            "type": "log",
                            "message": timeout_message,
                            "timestamp": timestamp,
                        },
                    )
                    await ws_manager.send_json(
                        websocket,
                        build_live_alert_payload(
                            timestamp=timestamp,
                            title="임무 업로드 실패",
                            message=timeout_message,
                        ),
                    )
                    mission_upload_state = None
                else:
                    await asyncio.to_thread(
                        send_mission_count,
                        connection,
                        len(mission_upload_state.mission_items),
                    )
                    mission_upload_state.last_activity_s = loop_now_s
                    mission_upload_state.retry_count += 1
                    await ws_manager.send_json(
                        websocket,
                        {
                            "type": "log",
                            "message": f"임무 업로드 재시도 {mission_upload_state.retry_count}/3",
                            "timestamp": datetime.now(UTC).isoformat(),
                        },
                    )

            message = await asyncio.to_thread(
                connection.recv_match,
                blocking=True,
                timeout=0.2,
            )
            if message is None:
                continue
            message_type = message.get_type()
            if message_type == "BAD_DATA":
                continue
            if message_type == "HEARTBEAT":
                if not is_vehicle_heartbeat(message):
                    continue
                source_system_id = int(message.get_srcSystem())
                source_component_id = int(message.get_srcComponent())
                if system_id > 0 and source_system_id != system_id:
                    continue
                if component_id > 0 and source_component_id != component_id:
                    continue

                heartbeat_key = (source_system_id, source_component_id)
                heartbeat_counts[heartbeat_key] = heartbeat_counts.get(heartbeat_key, 0) + 1
                selected_heartbeat_count = heartbeat_counts[heartbeat_key]
                if discovered_system_id is None:
                    heartbeat_count = selected_heartbeat_count
                elif discovered_system_id == source_system_id and discovered_component_id == source_component_id:
                    heartbeat_count = selected_heartbeat_count

                should_select_target = (
                    discovered_system_id is None
                    and (
                        (source_component_id == 1 and selected_heartbeat_count >= LIVE_REQUIRED_HEARTBEATS)
                        or selected_heartbeat_count >= 4
                    )
                )
                if should_select_target:
                    discovered_system_id = source_system_id
                    discovered_component_id = source_component_id
                    heartbeat_count = selected_heartbeat_count

                target_matches_selected = (
                    discovered_system_id == source_system_id
                    and discovered_component_id == source_component_id
                )
                if not target_matches_selected:
                    await send_live_status_update()
                    continue

                live_status_changed = update_vehicle_status_from_message(
                    live_status_snapshot,
                    message,
                )
                set_connection_target(
                    connection,
                    system_id if system_id > 0 else discovered_system_id,
                    component_id if component_id > 0 else discovered_component_id,
                )
                if not heartbeat_seen:
                    if selected_heartbeat_count < LIVE_REQUIRED_HEARTBEATS:
                        connection_phase = "waiting_heartbeat"
                        await send_live_status_update()
                        continue

                    heartbeat_seen = True
                    connection_phase = "requesting_streams"
                    last_heartbeat_received_at = loop_now_s
                    await asyncio.to_thread(request_live_data_streams, connection)
                    last_stream_request_sent_at = loop_now_s
                    timestamp = datetime.now(UTC).isoformat()
                    await ws_manager.send_json(
                        websocket,
                        {
                            "type": "log",
                            "message": (
                                f"MAVLink heartbeat 확인 완료: system {discovered_system_id}, "
                                f"component {discovered_component_id} ({selected_heartbeat_count}/{LIVE_REQUIRED_HEARTBEATS})"
                            ),
                            "timestamp": timestamp,
                        },
                    )
                    await ws_manager.send_json(
                        websocket,
                        {
                            "type": "log",
                            "message": "AUTOPILOT_VERSION 및 실시간 텔레메트리 스트림 요청",
                            "timestamp": timestamp,
                        },
                    )
                    connection_phase = "connected"
                    await send_live_status_update(force=True)
                else:
                    last_heartbeat_received_at = loop_now_s
                    if connection_phase == "heartbeat_lost":
                        connection_phase = "connected"
                        await ws_manager.send_json(
                            websocket,
                            {
                                "type": "log",
                                "message": "MAVLink heartbeat 재수신",
                                "timestamp": datetime.now(UTC).isoformat(),
                            },
                        )
                        await send_live_status_update(force=True)
            else:
                effective_system_id = system_id if system_id > 0 else discovered_system_id
                effective_component_id = component_id if component_id > 0 else discovered_component_id
                if effective_system_id is None or effective_component_id is None:
                    continue
                if not message_matches_filters(message, effective_system_id, effective_component_id):
                    continue
                live_status_changed = update_vehicle_status_from_message(
                    live_status_snapshot,
                    message,
                )

            if live_status_changed:
                timestamp = datetime.now(UTC).isoformat()
                display_mode_key, display_mode_label = resolve_live_flight_mode_presentation(
                    live_status_snapshot
                )
                if display_mode_key and display_mode_label:
                    next_live_mode_log_message = build_live_flight_mode_log_message(
                        display_mode_key,
                        display_mode_label,
                    )
                    if next_live_mode_log_message != last_live_mode_log_message:
                        await ws_manager.send_json(
                            websocket,
                            {
                                "type": "log",
                                "message": next_live_mode_log_message,
                                "timestamp": timestamp,
                            },
                        )
                        last_live_mode_log_message = next_live_mode_log_message

                await send_live_status_update()

            if message_type == "COMMAND_ACK":
                if command_ack_is_expected_stream_request_rejection(message):
                    continue

                ack_message = describe_command_ack(message)
                timestamp = datetime.now(UTC).isoformat()
                await ws_manager.send_json(
                    websocket,
                    {
                        "type": "log",
                        "message": ack_message,
                        "timestamp": timestamp,
                    },
                )
                if not command_ack_succeeded(message):
                    await ws_manager.send_json(
                        websocket,
                        build_live_alert_payload(
                            timestamp=timestamp,
                            title="실기체 명령 거부",
                            message=ack_message,
                        ),
                    )
                continue

            if message_type in {"MISSION_REQUEST", "MISSION_REQUEST_INT"}:
                if mission_upload_state is None:
                    continue

                requested_seq = int(message.seq)
                if 0 <= requested_seq < len(mission_upload_state.mission_items):
                    await asyncio.to_thread(
                        send_mission_item,
                        connection,
                        mission_upload_state.mission_items[requested_seq],
                    )
                    mission_upload_state.last_activity_s = loop_now_s
                    mission_upload_state.retry_count = 0
                    await ws_manager.send_json(
                        websocket,
                        {
                            "type": "log",
                            "message": f"임무 항목 전송: {requested_seq + 1}/{len(mission_upload_state.mission_items)}",
                            "timestamp": datetime.now(UTC).isoformat(),
                        },
                    )
                continue

            if message_type == "MISSION_ACK":
                ack_message = describe_mission_ack(message)
                timestamp = datetime.now(UTC).isoformat()
                await ws_manager.send_json(
                    websocket,
                    {
                        "type": "log",
                        "message": ack_message,
                        "timestamp": timestamp,
                    },
                )
                if not mission_ack_succeeded(message):
                    await ws_manager.send_json(
                        websocket,
                        build_live_alert_payload(
                            timestamp=timestamp,
                            title="임무 업로드 실패",
                            message=ack_message,
                        ),
                    )
                mission_upload_state = None
                continue

            if message_type == "STATUSTEXT":
                status_text = extract_statustext(message)
                if status_text:
                    await ws_manager.send_json(
                        websocket,
                        {
                            "type": "log",
                            "message": f"STATUSTEXT: {status_text}",
                            "timestamp": datetime.now(UTC).isoformat(),
                        },
                    )
                continue

            if not update_snapshot_from_message(snapshot, message):
                continue

            now = loop_now_s
            timestamp = datetime.now(UTC).isoformat()
            if (
                has_position(snapshot)
                and now - last_telemetry_sent_at >= LIVE_TELEMETRY_SEND_INTERVAL_SECONDS
            ):
                await ws_manager.send_json(
                    websocket,
                    {
                        "type": "telemetry",
                        "timestamp": timestamp,
                        "drone": "Pixhawk",
                        "scenario": "live",
                        "lat": round(snapshot.lat or 0.0, 7),
                        "lon": round(snapshot.lon or 0.0, 7),
                        "alt_m": round(snapshot.alt_m or 0.0, 2),
                        "speed_mps": round(snapshot.speed_mps, 2),
                        "accel_mps2": round(snapshot.accel_mps2, 2),
                    },
                )
                last_telemetry_sent_at = now

            if (
                snapshot.roll_deg is not None
                and snapshot.pitch_deg is not None
                and snapshot.yaw_deg is not None
                and now - last_attitude_sent_at >= LIVE_ATTITUDE_SEND_INTERVAL_SECONDS
            ):
                await ws_manager.send_json(
                    websocket,
                    {
                        "type": "attitude",
                        "timestamp": timestamp,
                        "drone": "Pixhawk",
                        "scenario": "live",
                        "roll_deg": round(snapshot.roll_deg, 2),
                        "pitch_deg": round(snapshot.pitch_deg, 2),
                        "yaw_deg": round(snapshot.yaw_deg, 2),
                    },
                )
                last_attitude_sent_at = now
    except WebSocketDisconnect:
        pass
    except (OSError, RuntimeError, ValueError) as error:
        timestamp = datetime.now(UTC).isoformat()
        await ws_manager.send_json(
            websocket,
            {
                "type": "log",
                "message": str(error),
                "timestamp": timestamp,
            },
        )
        await ws_manager.send_json(
            websocket,
            build_live_alert_payload(
                timestamp=timestamp,
                title="브리지 연결 실패",
                message=str(error),
            ),
        )
    finally:
        command_receiver_task.cancel()
        try:
            await command_receiver_task
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass
        if connection is not None:
            await asyncio.to_thread(close_mavlink_connection, connection)
        ws_manager.disconnect(websocket)


@app.websocket("/ws/telemetry")
async def telemetry_websocket(
    websocket: WebSocket,
    drone: str = "inspire_2",
    scenario: str = "scenario_1",
    slot: int = 0,
    formation_session: str = "",
    formation_member: str = "",
    formation_size: int = 1,
    formation_horizontal_cap_mps: float | None = None,
    formation_ascent_cap_mps: float | None = None,
    formation_descent_cap_mps: float | None = None,
) -> None:
    """Stream demo telemetry with a stable type field for each message."""

    await ws_manager.connect(websocket)

    try:
        scenario_definition = get_formation_scenario_definition(scenario, slot)
    except ValueError:
        scenario_definition = get_formation_scenario_definition("scenario_1", 0)

    try:
        spec = get_drone_spec(drone)
    except ValueError:
        spec = get_drone_spec("inspire_2")

    formation_max_horizontal_speed_mps = min(
        spec.max_horizontal_speed_mps,
        formation_horizontal_cap_mps if formation_horizontal_cap_mps is not None else spec.max_horizontal_speed_mps,
    )
    formation_max_ascent_speed_mps = min(
        spec.max_ascent_speed_mps,
        formation_ascent_cap_mps if formation_ascent_cap_mps is not None else spec.max_ascent_speed_mps,
    )
    formation_max_descent_speed_mps = min(
        spec.max_descent_speed_mps,
        formation_descent_cap_mps if formation_descent_cap_mps is not None else spec.max_descent_speed_mps,
    )

    await formation_sync_manager.register_member(
        session_id=formation_session,
        member_id=formation_member or f"slot-{slot}",
        expected_members=formation_size,
    )

    await ws_manager.send_json(
        websocket,
        {
            "type": "log",
            "message": f"Telemetry stream connected for {spec.name}",
            "timestamp": datetime.now(UTC).isoformat(),
        },
    )

    state = DroneState(
        lat=scenario_definition.home_lat,
        lon=scenario_definition.home_lon,
        alt_m=scenario_definition.home_alt_m,
        velocity_north_mps=0.0,
        velocity_east_mps=0.0,
        velocity_up_mps=0.0,
    )

    step_index = 0
    mission_runtime = initialize_mission_runtime()
    use_waypoint_mission = bool(scenario_definition.waypoints)
    completed_scenario_samples: list[CompletedScenarioTelemetrySample] = []
    scenario_completed = False
    rf_freq_mhz = resolve_rf_frequency_mhz(spec)
    rf_protocol = resolve_rf_protocol(spec)
    last_progress_percent_sent = -1
    control_state = StreamControlState()
    sensor_state = SensorTelemetryState()
    attitude_estimator_state = AttitudeEstimatorState()
    control_receiver_task = asyncio.create_task(
        receive_stream_control_messages(websocket, control_state)
    )

    if use_waypoint_mission:
        await ws_manager.send_json(
            websocket,
            {
                "type": "log",
                "message": build_flight_mode_log_message(mission_runtime.phase),
                "timestamp": datetime.now(UTC).isoformat(),
            },
        )

    if slot == 0 and use_waypoint_mission:
        await ws_manager.send_json(
            websocket,
            {
                "type": "progress",
                "progress_pct": 0,
                "reached_waypoint_count": 0,
                "total_waypoints": len(scenario_definition.waypoints),
                "completed": False,
            },
        )
        last_progress_percent_sent = 0

    try:
        while True:
            if control_receiver_task.done():
                control_receiver_task.result()

            if control_state.paused:
                await asyncio.sleep(SIMULATION_DT_SECONDS)
                continue

            if use_waypoint_mission:
                if mission_runtime.phase == "formation_hold":
                    released_by_wait = await formation_sync_manager.wait_for_first_waypoint_release(
                        session_id=formation_session,
                        member_id=formation_member or f"slot-{slot}",
                        expected_members=formation_size,
                    )
                    mission_runtime = release_formation_hold(mission_runtime)
                    await ws_manager.send_json(
                        websocket,
                        {
                            "type": "log",
                            "message": build_flight_mode_log_message(mission_runtime.phase),
                            "timestamp": datetime.now(UTC).isoformat(),
                        },
                    )
                    if released_by_wait:
                        await ws_manager.send_json(
                            websocket,
                            {
                                "type": "log",
                                "message": "편대 집결 완료, 동시 출발",
                                "timestamp": datetime.now(UTC).isoformat(),
                            },
                        )

                mission_runtime, pending_logs, mission_complete = transition_mission_runtime(
                    runtime=mission_runtime,
                    state=state,
                    scenario_key=scenario_definition.key,
                    slot=slot,
                    enable_first_waypoint_barrier=formation_size > 1,
                )
                for message in pending_logs:
                    await ws_manager.send_json(
                        websocket,
                        {
                            "type": "log",
                            "message": message,
                            "timestamp": datetime.now(UTC).isoformat(),
                        },
                    )
                if mission_complete:
                    scenario_completed = True
                    break

                current_speed_limits = resolve_flight_speed_limits(
                    runtime=mission_runtime,
                    individual_max_horizontal_speed_mps=spec.max_horizontal_speed_mps,
                    individual_max_ascent_speed_mps=spec.max_ascent_speed_mps,
                    individual_max_descent_speed_mps=spec.max_descent_speed_mps,
                    formation_horizontal_cap_mps=formation_max_horizontal_speed_mps,
                    formation_ascent_cap_mps=formation_max_ascent_speed_mps,
                    formation_descent_cap_mps=formation_max_descent_speed_mps,
                )
                control = build_mission_control(
                    runtime=mission_runtime,
                    state=state,
                    scenario_key=scenario_definition.key,
                    max_horizontal_speed_mps=current_speed_limits.max_horizontal_speed_mps,
                    max_ascent_speed_mps=current_speed_limits.max_ascent_speed_mps,
                    max_descent_speed_mps=current_speed_limits.max_descent_speed_mps,
                    slot=slot,
                )
            else:
                control = build_demo_control(
                    step_index=step_index,
                    scenario_key=scenario,
                    current_vertical_speed_mps=state.velocity_up_mps,
                    max_ascent_speed_mps=formation_max_ascent_speed_mps,
                    max_descent_speed_mps=formation_max_descent_speed_mps,
                )
            previous_state = state
            state = step_state(
                state=state,
                control=control,
                dt=SIMULATION_DT_SECONDS,
                max_horizontal_speed_mps=(
                    current_speed_limits.max_horizontal_speed_mps
                    if use_waypoint_mission
                    else formation_max_horizontal_speed_mps
                ),
                max_ascent_speed_mps=(
                    current_speed_limits.max_ascent_speed_mps
                    if use_waypoint_mission
                    else formation_max_ascent_speed_mps
                ),
                max_descent_speed_mps=(
                    current_speed_limits.max_descent_speed_mps
                    if use_waypoint_mission
                    else formation_max_descent_speed_mps
                ),
                max_service_ceiling_m=spec.max_service_ceiling_m,
            )
            attitude_estimate = estimate_attitude_from_acceleration(
                accel_north_mps2=(
                    (state.velocity_north_mps - previous_state.velocity_north_mps)
                    / SIMULATION_DT_SECONDS
                ),
                accel_east_mps2=(
                    (state.velocity_east_mps - previous_state.velocity_east_mps)
                    / SIMULATION_DT_SECONDS
                ),
                velocity_north_mps=state.velocity_north_mps,
                velocity_east_mps=state.velocity_east_mps,
                estimator_state=attitude_estimator_state,
                dt=SIMULATION_DT_SECONDS,
            )
            reported_attitude = add_attitude_sensor_noise(attitude_estimate)
            telemetry = render_telemetry(
                state=state,
                control=control,
                previous_state=previous_state,
                dt=SIMULATION_DT_SECONDS,
            )
            reported_alt_m, reported_speed_mps, reported_accel_mps2 = apply_sensor_telemetry_model(
                telemetry_alt_m=telemetry.alt_m,
                telemetry_speed_mps=telemetry.speed_mps,
                sensor_state=sensor_state,
                suppress_stopped_noise=(
                    use_waypoint_mission
                    and mission_runtime.phase in {"takeoff", "landing", "complete"}
                ),
            )
            telemetry_timestamp = datetime.now(UTC).isoformat()
            completed_scenario_samples.append(
                CompletedScenarioTelemetrySample(
                    timestamp=telemetry_timestamp,
                    lat=round(telemetry.lat, 7),
                    lon=round(telemetry.lon, 7),
                    alt_m=round(reported_alt_m, 2),
                    velocity_mps=round(reported_speed_mps, 2),
                    rcs_value_m2=round(spec.rcs_estimate_m2, 4),
                ),
            )

            await ws_manager.send_json(
                websocket,
                {
                    "type": "telemetry",
                    "timestamp": telemetry_timestamp,
                    "drone": spec.name,
                    "scenario": scenario,
                    "lat": round(telemetry.lat, 7),
                    "lon": round(telemetry.lon, 7),
                    "alt_m": round(reported_alt_m, 2),
                    "speed_mps": round(reported_speed_mps, 2),
                    "accel_mps2": round(reported_accel_mps2, 2),
                },
            )
            await ws_manager.send_json(
                websocket,
                {
                    "type": "attitude",
                    "timestamp": telemetry_timestamp,
                    "drone": spec.name,
                    "scenario": scenario,
                    "roll_deg": round(reported_attitude.roll_deg, 2),
                    "pitch_deg": round(reported_attitude.pitch_deg, 2),
                    "yaw_deg": round(reported_attitude.yaw_deg, 2),
                },
            )

            if slot == 0 and use_waypoint_mission:
                route_progress_percent = round(
                    calculate_home_route_progress_percent(
                        state=state,
                        runtime=mission_runtime,
                        scenario_definition=scenario_definition,
                    ),
                    2,
                )
                if abs(route_progress_percent - last_progress_percent_sent) >= 0.05:
                    await ws_manager.send_json(
                        websocket,
                        {
                            "type": "progress",
                            "progress_pct": route_progress_percent,
                            "reached_waypoint_count": get_reached_waypoint_count(
                                mission_runtime,
                                len(scenario_definition.waypoints),
                            ),
                            "total_waypoints": len(scenario_definition.waypoints),
                            "completed": False,
                        },
                    )
                    last_progress_percent_sent = route_progress_percent

            step_index += 1
            await asyncio.sleep(SIMULATION_DT_SECONDS)
        if scenario_completed and slot == 0 and use_waypoint_mission:
            await ws_manager.send_json(
                websocket,
                {
                    "type": "progress",
                    "progress_pct": 100,
                    "reached_waypoint_count": len(scenario_definition.waypoints),
                    "total_waypoints": len(scenario_definition.waypoints),
                    "completed": True,
                },
            )
        if scenario_completed and completed_scenario_samples:
            try:
                saved_log_path = await save_completed_scenario_log(
                    scenario_key=scenario_definition.key,
                    drone_name=spec.name,
                    completed_at=datetime.now(UTC),
                    samples=completed_scenario_samples,
                    rf_freq_mhz=round(rf_freq_mhz, 1),
                    rf_proto=rf_protocol,
                    reference_lat=scenario_definition.home_lat,
                    reference_lon=scenario_definition.home_lon,
                    reference_alt_m=scenario_definition.home_alt_m,
                    slot_index=slot,
                )
            except OSError:
                await ws_manager.send_json(
                    websocket,
                    {
                        "type": "log",
                            "message": "완료 비행 계획 로그 자동 저장 실패",
                        "timestamp": datetime.now(UTC).isoformat(),
                    },
                )
            else:
                await ws_manager.send_json(
                    websocket,
                    {
                        "type": "log",
                            "message": f"완료 비행 계획 로그 자동 저장: {saved_log_path.as_posix()}",
                        "timestamp": datetime.now(UTC).isoformat(),
                    },
                )
    except WebSocketDisconnect:
        await formation_sync_manager.unregister_member(
            session_id=formation_session,
            member_id=formation_member or f"slot-{slot}",
        )
        ws_manager.disconnect(websocket)
    else:
        await formation_sync_manager.unregister_member(
            session_id=formation_session,
            member_id=formation_member or f"slot-{slot}",
        )
        ws_manager.disconnect(websocket)
    finally:
        control_receiver_task.cancel()
        try:
            await control_receiver_task
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass
