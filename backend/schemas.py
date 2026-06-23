from __future__ import annotations

from pydantic import BaseModel


class DroneSpecResponse(BaseModel):
    """Public drone specification payload exposed by the API."""

    key: str
    is_custom: bool = False
    is_overridden: bool = False
    name: str
    category: str
    max_horizontal_speed_mps: float
    max_ascent_speed_mps: float
    max_descent_speed_mps: float
    max_service_ceiling_m: float
    max_flight_time_min: float
    weight_g: float
    rcs_estimate_m2: float
    rf_signature: str | None = None
    rf_band: str | None = None
    acoustic_signature_hz: float | None = None
    thermal_signature_level: str | None = None
    payload_capacity_g: float | None = None
    sensor_notes: str | None = None


class CustomDroneSpecCreateRequest(BaseModel):
    """User-defined drone specification payload persisted to the runtime store."""

    name: str
    category: str = "사용자 정의 기체"
    max_horizontal_speed_mps: float
    max_ascent_speed_mps: float
    max_descent_speed_mps: float
    max_service_ceiling_m: float
    max_flight_time_min: float
    weight_g: float
    rcs_estimate_m2: float
    rf_signature: str | None = None
    rf_band: str | None = None
    acoustic_signature_hz: float | None = None
    thermal_signature_level: str | None = None
    payload_capacity_g: float | None = None
    sensor_notes: str | None = None


class DroneSpecDeleteResponse(BaseModel):
    """Result payload returned after deleting a custom drone or restoring a built-in."""

    key: str
    name: str
    is_custom: bool = False
    restored_builtin: bool = False


class HealthResponse(BaseModel):
    """Basic service health response."""

    status: str
    service: str


class AirspaceStatusResponse(BaseModel):
    """Availability of official airspace data overlays."""

    enabled: bool
    source: str
    zone_types: list[str]
    message: str


class SerialPortResponse(BaseModel):
    """Detected local serial port exposed for MAVLink connection setup."""

    device: str
    description: str
    hwid: str
    is_pixhawk_candidate: bool = False


class ScenarioResponse(BaseModel):
    """Scenario metadata returned to the frontend."""

    key: str
    name: str
    waypoint_count: int
    estimated_frames: int
    duration_seconds: float


class ScenarioGenerateRequest(BaseModel):
    """Scenario generation request payload."""

    scenario_key: str
    drones: list[str]


class ScenarioGenerateResponse(BaseModel):
    """Generated scenario payload returned to the frontend."""

    scenario_key: str
    scenario_name: str
    drones: list[str]
    waypoint_count: int
    estimated_frames: int
    estimated_duration_seconds: float
    recommended_primary_drone: str


class ScenarioRoutePointResponse(BaseModel):
    """Single WGS84 point exposed to the frontend route view."""

    lat: float
    lon: float
    alt_m: float


class ScenarioWaypointRouteResponse(ScenarioRoutePointResponse):
    """Waypoint detail rendered on the map overlay."""

    index: int
    target_speed_mps: float
    hold_seconds: float


class ScenarioRouteResponse(BaseModel):
    """Scenario route payload for map visualization."""

    scenario_key: str
    scenario_name: str
    home: ScenarioRoutePointResponse
    waypoints: list[ScenarioWaypointRouteResponse]


class CustomScenarioHomeRequest(BaseModel):
    """Editable home point payload received from the scenario builder."""

    lat: float
    lon: float
    alt_m: float


class CustomScenarioWaypointRequest(BaseModel):
    """Editable waypoint payload received from the scenario builder."""

    lat: float
    lon: float
    alt_m: float
    target_speed_mps: float
    hold_seconds: float = 0.0


class CustomScenarioCreateRequest(BaseModel):
    """User-defined scenario payload persisted to the custom scenario store."""

    name: str
    home: CustomScenarioHomeRequest
    target_climb_speed_mps: float = 2.4
    target_descent_speed_mps: float = 1.8
    vertical_accel_limit_mps2: float = 1.0
    waypoints: list[CustomScenarioWaypointRequest]


class ScenarioDetailResponse(BaseModel):
    """Editable scenario detail payload used by the scenario builder."""

    key: str
    name: str
    is_custom: bool
    home: ScenarioRoutePointResponse
    target_climb_speed_mps: float
    target_descent_speed_mps: float
    vertical_accel_limit_mps2: float
    waypoints: list[CustomScenarioWaypointRequest]


class ReplayLogSummaryResponse(BaseModel):
    """Metadata returned for a saved replayable scenario log."""

    log_id: str
    filename: str
    drone_name: str
    scenario_key: str
    scenario_name: str
    sample_count: int
    started_at_utc: str | None = None
    ended_at_utc: str | None = None
    duration_seconds: float


class ReplayLogSampleResponse(BaseModel):
    """Single replay telemetry sample returned to the frontend."""

    sample_index: int
    timestamp_utc: str
    elapsed_ms: int
    drone: str
    scenario: str
    flight_mode: str
    lat_deg: float
    lon_deg: float
    alt_m: float
    speed_mps: float
    accel_mps2: float


class ReplayLogDetailResponse(ReplayLogSummaryResponse):
    """Saved replay log payload including sample sequence."""

    samples: list[ReplayLogSampleResponse]
