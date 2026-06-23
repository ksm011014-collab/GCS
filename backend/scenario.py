from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from math import cos, hypot, radians
from pathlib import Path

from backend.drone_specs import get_drone_spec
from backend.paths import runtime_path


SIMULATION_DT_SECONDS = 0.05
EARTH_METERS_PER_DEGREE_LAT = 111_320.0
DEFAULT_HOME_LAT = 36.17169469764609
DEFAULT_HOME_LON = 128.46517715736883
DEFAULT_HOME_ALT_M = 0.0
FORMATION_LATERAL_SPACING_M = 18.0
FORMATION_LONGITUDINAL_SPACING_M = 10.0
FORMATION_ALTITUDE_STEP_M = 15.0
DEFAULT_CUSTOM_SCENARIO_DIRECTORY = runtime_path("scenarios", "custom")
CUSTOM_SCENARIO_KEY_PREFIX = "custom"
DEFAULT_FIRST_WAYPOINT_HOLD_SECONDS = 1.0


@dataclass(frozen=True)
class ScenarioWaypoint:
    """Absolute WGS84 waypoint with altitude and target inbound speed."""

    lat: float
    lon: float
    alt_m: float
    target_speed_mps: float
    hold_seconds: float = 0.0


@dataclass(frozen=True)
class ScenarioDefinition:
    """Static scenario metadata exposed to the frontend."""

    key: str
    name: str
    waypoint_count: int
    estimated_frames: int
    duration_seconds: float
    target_climb_speed_mps: float
    target_descent_speed_mps: float
    vertical_accel_limit_mps2: float
    home_lat: float = DEFAULT_HOME_LAT
    home_lon: float = DEFAULT_HOME_LON
    home_alt_m: float = DEFAULT_HOME_ALT_M
    waypoints: tuple[ScenarioWaypoint, ...] = ()


@dataclass(frozen=True)
class GeneratedScenario:
    """Scenario result bound to selected drones."""

    scenario_key: str
    scenario_name: str
    drones: list[str]
    waypoint_count: int
    estimated_frames: int
    estimated_duration_seconds: float
    recommended_primary_drone: str


def meters_per_degree_lon(lat: float) -> float:
    """Approximate longitude scale at a given latitude."""

    return EARTH_METERS_PER_DEGREE_LAT * cos(radians(lat))


def calculate_horizontal_distance_m(
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
) -> float:
    """Convert two WGS84 points into a local planar horizontal distance."""

    average_lat = (start_lat + end_lat) / 2.0
    delta_north_m = (end_lat - start_lat) * EARTH_METERS_PER_DEGREE_LAT
    delta_east_m = (end_lon - start_lon) * meters_per_degree_lon(average_lat)
    return hypot(delta_north_m, delta_east_m)


def shift_wgs84_coordinate(
    lat: float,
    lon: float,
    north_offset_m: float,
    east_offset_m: float,
) -> tuple[float, float]:
    """Shift a WGS84 coordinate by local north/east offsets in meters."""

    shifted_lat = lat + (north_offset_m / EARTH_METERS_PER_DEGREE_LAT)
    lon_scale = meters_per_degree_lon(lat)
    shifted_lon = lon if lon_scale == 0.0 else lon + (east_offset_m / lon_scale)
    return shifted_lat, shifted_lon


def get_formation_slot_offset_m(slot_index: int) -> tuple[float, float]:
    """Return deterministic formation offsets for a stream slot."""

    if slot_index <= 0:
        return 0.0, 0.0

    wing_index = slot_index - 1
    row = (wing_index // 2) + 1
    side = -1.0 if wing_index % 2 == 0 else 1.0
    north_offset_m = -FORMATION_LONGITUDINAL_SPACING_M * row
    east_offset_m = FORMATION_LATERAL_SPACING_M * row * side
    return north_offset_m, east_offset_m


def apply_formation_offset(
    definition: ScenarioDefinition,
    slot_index: int,
) -> ScenarioDefinition:
    """Return a scenario definition shifted into a formation slot."""

    north_offset_m, east_offset_m = get_formation_slot_offset_m(slot_index)
    altitude_offset_m = max(0, slot_index) * FORMATION_ALTITUDE_STEP_M
    if north_offset_m == 0.0 and east_offset_m == 0.0 and altitude_offset_m == 0.0:
        return definition

    shifted_home_lat, shifted_home_lon = shift_wgs84_coordinate(
        definition.home_lat,
        definition.home_lon,
        north_offset_m,
        east_offset_m,
    )
    shifted_waypoints_list: list[ScenarioWaypoint] = []
    for waypoint in definition.waypoints:
        shifted_waypoint_lat, shifted_waypoint_lon = shift_wgs84_coordinate(
            waypoint.lat,
            waypoint.lon,
            north_offset_m,
            east_offset_m,
        )
        shifted_waypoints_list.append(
            ScenarioWaypoint(
                lat=shifted_waypoint_lat,
                lon=shifted_waypoint_lon,
                alt_m=waypoint.alt_m + altitude_offset_m,
                target_speed_mps=waypoint.target_speed_mps,
                hold_seconds=waypoint.hold_seconds,
            )
        )
    shifted_waypoints = tuple(shifted_waypoints_list)
    return ScenarioDefinition(
        key=definition.key,
        name=definition.name,
        waypoint_count=definition.waypoint_count,
        estimated_frames=definition.estimated_frames,
        duration_seconds=definition.duration_seconds,
        target_climb_speed_mps=definition.target_climb_speed_mps,
        target_descent_speed_mps=definition.target_descent_speed_mps,
        vertical_accel_limit_mps2=definition.vertical_accel_limit_mps2,
        home_lat=shifted_home_lat,
        home_lon=shifted_home_lon,
        home_alt_m=definition.home_alt_m,
        waypoints=shifted_waypoints,
    )


def estimate_scenario_duration_seconds(
    definition: ScenarioDefinition,
    max_horizontal_speed_mps: float | None = None,
    max_ascent_speed_mps: float | None = None,
    max_descent_speed_mps: float | None = None,
) -> float:
    """Estimate total scenario duration from waypoint geometry and speed constraints."""

    if not definition.waypoints:
        return definition.duration_seconds

    resolved_max_horizontal_speed = (
        max_horizontal_speed_mps if max_horizontal_speed_mps is not None else float("inf")
    )
    resolved_max_ascent_speed = (
        min(definition.target_climb_speed_mps, max_ascent_speed_mps)
        if max_ascent_speed_mps is not None
        else definition.target_climb_speed_mps
    )
    resolved_max_descent_speed = (
        min(definition.target_descent_speed_mps, max_descent_speed_mps)
        if max_descent_speed_mps is not None
        else definition.target_descent_speed_mps
    )

    total_duration_seconds = 0.0
    first_waypoint = definition.waypoints[0]
    initial_climb_speed_mps = (
        max(0.1, max_ascent_speed_mps)
        if max_ascent_speed_mps is not None and first_waypoint.alt_m >= definition.home_alt_m
        else max(0.1, max_descent_speed_mps)
        if max_descent_speed_mps is not None and first_waypoint.alt_m < definition.home_alt_m
        else max(0.1, resolved_max_ascent_speed)
        if first_waypoint.alt_m >= definition.home_alt_m
        else max(0.1, resolved_max_descent_speed)
    )
    total_duration_seconds += abs(first_waypoint.alt_m - definition.home_alt_m) / initial_climb_speed_mps

    initial_departure_speed_mps = (
        max(0.1, max_horizontal_speed_mps)
        if max_horizontal_speed_mps is not None
        else max(
            0.1,
            min(first_waypoint.target_speed_mps, resolved_max_horizontal_speed),
        )
    )
    total_duration_seconds += calculate_horizontal_distance_m(
        definition.home_lat,
        definition.home_lon,
        first_waypoint.lat,
        first_waypoint.lon,
    ) / initial_departure_speed_mps
    total_duration_seconds += max(0.0, first_waypoint.hold_seconds)

    previous_lat = first_waypoint.lat
    previous_lon = first_waypoint.lon
    previous_alt_m = first_waypoint.alt_m

    for waypoint in definition.waypoints[1:]:
        horizontal_distance_m = calculate_horizontal_distance_m(
            previous_lat,
            previous_lon,
            waypoint.lat,
            waypoint.lon,
        )
        horizontal_speed_mps = max(
            0.1,
            min(waypoint.target_speed_mps, resolved_max_horizontal_speed),
        )
        horizontal_duration_seconds = horizontal_distance_m / horizontal_speed_mps

        altitude_delta_m = waypoint.alt_m - previous_alt_m
        if altitude_delta_m >= 0.0:
            vertical_speed_mps = max(0.1, resolved_max_ascent_speed)
        else:
            vertical_speed_mps = max(0.1, resolved_max_descent_speed)
        vertical_duration_seconds = abs(altitude_delta_m) / vertical_speed_mps

        total_duration_seconds += max(horizontal_duration_seconds, vertical_duration_seconds)
        total_duration_seconds += max(0.0, waypoint.hold_seconds)

        previous_lat = waypoint.lat
        previous_lon = waypoint.lon
        previous_alt_m = waypoint.alt_m

    final_return_speed_mps = max(
        0.1,
        min(definition.waypoints[-1].target_speed_mps, resolved_max_horizontal_speed),
    )
    total_duration_seconds += calculate_horizontal_distance_m(
        previous_lat,
        previous_lon,
        definition.home_lat,
        definition.home_lon,
    ) / final_return_speed_mps

    final_descent_speed_mps = (
        max(0.1, resolved_max_ascent_speed)
        if definition.home_alt_m >= previous_alt_m
        else max(0.1, resolved_max_descent_speed)
    )
    total_duration_seconds += abs(definition.home_alt_m - previous_alt_m) / final_descent_speed_mps

    return round(total_duration_seconds, 1)


def normalize_waypoint_holds(
    waypoints: list[ScenarioWaypoint] | tuple[ScenarioWaypoint, ...],
) -> tuple[ScenarioWaypoint, ...]:
    """Ensure the first waypoint has a positive hold used by mission startup."""

    normalized_waypoints = tuple(waypoints)
    if not normalized_waypoints or normalized_waypoints[0].hold_seconds > 0.0:
        return normalized_waypoints

    first_waypoint = normalized_waypoints[0]
    return (
        ScenarioWaypoint(
            lat=first_waypoint.lat,
            lon=first_waypoint.lon,
            alt_m=first_waypoint.alt_m,
            target_speed_mps=first_waypoint.target_speed_mps,
            hold_seconds=DEFAULT_FIRST_WAYPOINT_HOLD_SECONDS,
        ),
        *normalized_waypoints[1:],
    )


def create_waypoint_scenario(
    key: str,
    name: str,
    target_climb_speed_mps: float,
    target_descent_speed_mps: float,
    vertical_accel_limit_mps2: float,
    waypoints: tuple[ScenarioWaypoint, ...],
    home_lat: float = DEFAULT_HOME_LAT,
    home_lon: float = DEFAULT_HOME_LON,
    home_alt_m: float = DEFAULT_HOME_ALT_M,
) -> ScenarioDefinition:
    """Build a scenario definition with metadata derived from waypoint data."""

    normalized_waypoints = normalize_waypoint_holds(waypoints)
    definition = ScenarioDefinition(
        key=key,
        name=name,
        waypoint_count=len(normalized_waypoints),
        estimated_frames=0,
        duration_seconds=0.0,
        target_climb_speed_mps=target_climb_speed_mps,
        target_descent_speed_mps=target_descent_speed_mps,
        vertical_accel_limit_mps2=vertical_accel_limit_mps2,
        home_lat=home_lat,
        home_lon=home_lon,
        home_alt_m=home_alt_m,
        waypoints=normalized_waypoints,
    )
    duration_seconds = estimate_scenario_duration_seconds(definition)
    estimated_frames = int(round(duration_seconds / SIMULATION_DT_SECONDS))
    return ScenarioDefinition(
        key=key,
        name=name,
        waypoint_count=len(normalized_waypoints),
        estimated_frames=estimated_frames,
        duration_seconds=duration_seconds,
        target_climb_speed_mps=target_climb_speed_mps,
        target_descent_speed_mps=target_descent_speed_mps,
        vertical_accel_limit_mps2=vertical_accel_limit_mps2,
        home_lat=home_lat,
        home_lon=home_lon,
        home_alt_m=home_alt_m,
        waypoints=normalized_waypoints,
    )


def sanitize_custom_scenario_name_fragment(value: str) -> str:
    """Build a filesystem-safe name fragment for a custom scenario key."""

    sanitized = "".join(
        character.lower() if character.isalnum() else "_"
        for character in value.strip()
    )
    collapsed = "_".join(fragment for fragment in sanitized.split("_") if fragment)
    return collapsed or "scenario"


def build_custom_scenario_key(
    name: str,
    existing_keys: set[str] | None = None,
) -> str:
    """Create a unique key for a saved custom scenario."""

    existing = existing_keys or set()
    base_key = (
        f"{CUSTOM_SCENARIO_KEY_PREFIX}_"
        f"{sanitize_custom_scenario_name_fragment(name)}_"
        f"{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    )
    candidate_key = base_key
    suffix_index = 2
    while candidate_key in existing:
        candidate_key = f"{base_key}_{suffix_index}"
        suffix_index += 1
    return candidate_key


def build_custom_scenario_path(
    scenario_key: str,
    directory: Path = DEFAULT_CUSTOM_SCENARIO_DIRECTORY,
) -> Path:
    """Resolve the destination JSON path for a custom scenario."""

    return directory / f"{scenario_key}.json"


def is_custom_scenario_key(scenario_key: str) -> bool:
    """Return whether the key belongs to a saved custom scenario."""

    return (
        scenario_key.startswith(f"{CUSTOM_SCENARIO_KEY_PREFIX}_")
        or (
            scenario_key not in SCENARIO_DEFINITIONS
            and build_custom_scenario_path(scenario_key).exists()
        )
    )


def build_custom_scenario_payload(
    *,
    key: str,
    name: str,
    home_lat: float,
    home_lon: float,
    home_alt_m: float,
    target_climb_speed_mps: float,
    target_descent_speed_mps: float,
    vertical_accel_limit_mps2: float,
    waypoints: list[ScenarioWaypoint] | tuple[ScenarioWaypoint, ...],
) -> dict[str, object]:
    """Serialize scenario inputs into the JSON payload stored on disk."""

    normalized_waypoints = normalize_waypoint_holds(waypoints)
    return {
        "key": key,
        "name": name,
        "home": {
            "lat": home_lat,
            "lon": home_lon,
            "alt_m": home_alt_m,
        },
        "target_climb_speed_mps": target_climb_speed_mps,
        "target_descent_speed_mps": target_descent_speed_mps,
        "vertical_accel_limit_mps2": vertical_accel_limit_mps2,
        "waypoints": [
            {
                "lat": waypoint.lat,
                "lon": waypoint.lon,
                "alt_m": waypoint.alt_m,
                "target_speed_mps": waypoint.target_speed_mps,
                "hold_seconds": waypoint.hold_seconds,
            }
            for waypoint in normalized_waypoints
        ],
    }


def parse_custom_scenario_payload(payload: dict[str, object]) -> ScenarioDefinition:
    """Convert a saved custom-scenario JSON payload into a scenario definition."""

    home = payload.get("home")
    if not isinstance(home, dict):
        raise ValueError("Custom scenario home is missing.")

    waypoint_payloads = payload.get("waypoints")
    if not isinstance(waypoint_payloads, list):
        raise ValueError("Custom scenario waypoints are missing.")

    waypoints = tuple(
        ScenarioWaypoint(
            lat=float(waypoint["lat"]),
            lon=float(waypoint["lon"]),
            alt_m=float(waypoint["alt_m"]),
            target_speed_mps=float(waypoint["target_speed_mps"]),
            hold_seconds=float(waypoint.get("hold_seconds", 0.0)),
        )
        for waypoint in waypoint_payloads
    )
    return create_waypoint_scenario(
        key=str(payload["key"]),
        name=str(payload["name"]),
        target_climb_speed_mps=float(payload.get("target_climb_speed_mps", 2.4)),
        target_descent_speed_mps=float(payload.get("target_descent_speed_mps", 1.8)),
        vertical_accel_limit_mps2=float(payload.get("vertical_accel_limit_mps2", 1.0)),
        home_lat=float(home["lat"]),
        home_lon=float(home["lon"]),
        home_alt_m=float(home.get("alt_m", 0.0)),
        waypoints=waypoints,
    )


def load_custom_scenario_definitions(
    directory: Path = DEFAULT_CUSTOM_SCENARIO_DIRECTORY,
) -> dict[str, ScenarioDefinition]:
    """Load all saved custom scenarios from disk."""

    if not directory.exists():
        return {}

    definitions: dict[str, ScenarioDefinition] = {}
    for path in sorted(directory.glob("*.json")):
        with path.open("r", encoding="utf-8") as input_file:
            payload = json.load(input_file)
        definition = parse_custom_scenario_payload(payload)
        definitions[definition.key] = definition
    return definitions


_custom_scenario_definitions_cache: dict[str, ScenarioDefinition] | None = None


def get_custom_scenario_definitions() -> dict[str, ScenarioDefinition]:
    """Return cached custom scenario definitions, loading them on first use."""

    global _custom_scenario_definitions_cache
    if _custom_scenario_definitions_cache is None:
        _custom_scenario_definitions_cache = load_custom_scenario_definitions()
    return _custom_scenario_definitions_cache


def refresh_custom_scenario_definitions() -> dict[str, ScenarioDefinition]:
    """Reload custom scenario definitions from disk into memory."""

    global _custom_scenario_definitions_cache
    _custom_scenario_definitions_cache = load_custom_scenario_definitions()
    return _custom_scenario_definitions_cache


def save_custom_scenario(
    *,
    name: str,
    home_lat: float,
    home_lon: float,
    home_alt_m: float,
    target_climb_speed_mps: float,
    target_descent_speed_mps: float,
    vertical_accel_limit_mps2: float,
    waypoints: list[ScenarioWaypoint] | tuple[ScenarioWaypoint, ...],
    directory: Path = DEFAULT_CUSTOM_SCENARIO_DIRECTORY,
) -> ScenarioDefinition:
    """Persist a user-defined scenario and return its scenario definition."""

    existing_keys = set(SCENARIO_DEFINITIONS.keys()) | set(get_custom_scenario_definitions().keys())
    scenario_key = build_custom_scenario_key(name, existing_keys)
    payload = build_custom_scenario_payload(
        key=scenario_key,
        name=name,
        home_lat=home_lat,
        home_lon=home_lon,
        home_alt_m=home_alt_m,
        target_climb_speed_mps=target_climb_speed_mps,
        target_descent_speed_mps=target_descent_speed_mps,
        vertical_accel_limit_mps2=vertical_accel_limit_mps2,
        waypoints=waypoints,
    )
    path = build_custom_scenario_path(scenario_key, directory)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as output_file:
        json.dump(payload, output_file, ensure_ascii=False, indent=2)
    definition = parse_custom_scenario_payload(payload)
    get_custom_scenario_definitions()[definition.key] = definition
    return definition


def update_custom_scenario(
    *,
    scenario_key: str,
    name: str,
    home_lat: float,
    home_lon: float,
    home_alt_m: float,
    target_climb_speed_mps: float,
    target_descent_speed_mps: float,
    vertical_accel_limit_mps2: float,
    waypoints: list[ScenarioWaypoint] | tuple[ScenarioWaypoint, ...],
    directory: Path = DEFAULT_CUSTOM_SCENARIO_DIRECTORY,
) -> ScenarioDefinition:
    """Overwrite a saved custom scenario while preserving its key."""

    if not is_custom_scenario_key(scenario_key):
        raise ValueError("Only custom scenarios can be updated.")

    path = build_custom_scenario_path(scenario_key, directory)
    if not path.exists():
        raise ValueError(f"Unknown custom scenario: {scenario_key}")

    payload = build_custom_scenario_payload(
        key=scenario_key,
        name=name,
        home_lat=home_lat,
        home_lon=home_lon,
        home_alt_m=home_alt_m,
        target_climb_speed_mps=target_climb_speed_mps,
        target_descent_speed_mps=target_descent_speed_mps,
        vertical_accel_limit_mps2=vertical_accel_limit_mps2,
        waypoints=waypoints,
    )
    with path.open("w", encoding="utf-8") as output_file:
        json.dump(payload, output_file, ensure_ascii=False, indent=2)
    definition = parse_custom_scenario_payload(payload)
    get_custom_scenario_definitions()[definition.key] = definition
    return definition


def delete_custom_scenario(
    scenario_key: str,
    directory: Path = DEFAULT_CUSTOM_SCENARIO_DIRECTORY,
) -> ScenarioDefinition:
    """Delete a saved custom scenario and return its definition."""

    if not is_custom_scenario_key(scenario_key):
        raise ValueError("Only custom scenarios can be deleted.")

    path = build_custom_scenario_path(scenario_key, directory)
    cached_definitions = get_custom_scenario_definitions()
    if not path.exists():
        cached_definitions.pop(scenario_key, None)
        raise ValueError(f"Unknown custom scenario: {scenario_key}")

    deleted_definition = cached_definitions.get(scenario_key)
    if deleted_definition is None:
        with path.open("r", encoding="utf-8") as input_file:
            deleted_definition = parse_custom_scenario_payload(json.load(input_file))

    path.unlink()
    cached_definitions.pop(scenario_key, None)
    return deleted_definition


SCENARIO_1_WAYPOINTS: tuple[ScenarioWaypoint, ...] = (
    ScenarioWaypoint(lat=36.161409, lon=128.463070, alt_m=150.0, target_speed_mps=8.0, hold_seconds=1.0),
    ScenarioWaypoint(lat=36.166717, lon=128.467156, alt_m=150.0, target_speed_mps=8.0),
    
    ScenarioWaypoint(lat=36.169143, lon=128.466457, alt_m=150.0, target_speed_mps=10.0),
    ScenarioWaypoint(lat=36.166784, lon=128.466274, alt_m=150.0, target_speed_mps=12.0, hold_seconds=0.5),
    ScenarioWaypoint(lat=36.169143, lon=128.465475, alt_m=150.0, target_speed_mps=13.5),
    
    ScenarioWaypoint(lat=36.166876, lon=128.465567, alt_m=150.0, target_speed_mps=10.0),
    ScenarioWaypoint(lat=36.170433, lon=128.465133, alt_m=150.0, target_speed_mps=10.0, hold_seconds=1.0),
    ScenarioWaypoint(lat=36.168498, lon=128.462508, alt_m=150.0, target_speed_mps=10.0), 
    
    ScenarioWaypoint(lat=36.166139, lon=128.462827, alt_m=150.0, target_speed_mps=12.0),
    ScenarioWaypoint(lat=36.164499, lon=128.464380, alt_m=150.0, target_speed_mps=9.0),
    
    ScenarioWaypoint(lat=36.168350, lon=128.466115, alt_m=150.0, target_speed_mps=12.0, hold_seconds=1.0),
    ScenarioWaypoint(lat=36.171704, lon=128.465224, alt_m=150.0, target_speed_mps=15.0, hold_seconds=2.0)

)

SCENARIO_DEFINITIONS: dict[str, ScenarioDefinition] = {
    "scenario_1": create_waypoint_scenario(
        key="scenario_1",
        name="비행 계획 1",
        target_climb_speed_mps=2.4,
        target_descent_speed_mps=1.8,
        vertical_accel_limit_mps2=1.0,
        waypoints=SCENARIO_1_WAYPOINTS,
    ),
}


def list_scenarios() -> list[ScenarioDefinition]:
    """Return all supported scenario definitions."""

    custom_scenarios = sorted(
        (
            definition
            for definition in get_custom_scenario_definitions().values()
            if definition.key not in SCENARIO_DEFINITIONS
        ),
        key=lambda definition: definition.name,
    )
    return [*SCENARIO_DEFINITIONS.values(), *custom_scenarios]


def get_scenario_definition(scenario_key: str) -> ScenarioDefinition:
    """Return a scenario definition by key."""

    builtin_definition = SCENARIO_DEFINITIONS.get(scenario_key)
    if builtin_definition is not None:
        return builtin_definition

    custom_definition = get_custom_scenario_definitions().get(scenario_key)
    if custom_definition is not None:
        return custom_definition

    raise ValueError(f"Unknown scenario: {scenario_key}")


def get_formation_scenario_definition(
    scenario_key: str,
    slot_index: int = 0,
) -> ScenarioDefinition:
    """Return a scenario definition shifted for a formation slot."""

    return apply_formation_offset(get_scenario_definition(scenario_key), slot_index)


def get_scenario_waypoints(scenario_key: str) -> tuple[ScenarioWaypoint, ...]:
    """Return WGS84 waypoints for the selected scenario."""

    return get_scenario_definition(scenario_key).waypoints


def generate_scenario(scenario_key: str, drones: list[str]) -> GeneratedScenario:
    """Generate a lightweight scenario summary for the selected drones."""

    definition = get_scenario_definition(scenario_key)
    selected_drones = [drone for drone in drones if drone]
    if not selected_drones:
        selected_drones = ["inspire_2"]

    primary_spec = get_drone_spec(selected_drones[0])
    adjusted_duration = estimate_scenario_duration_seconds(
        definition=definition,
        max_horizontal_speed_mps=primary_spec.max_horizontal_speed_mps,
        max_ascent_speed_mps=primary_spec.max_ascent_speed_mps,
        max_descent_speed_mps=primary_spec.max_descent_speed_mps,
    )
    adjusted_frames = int(round(adjusted_duration / SIMULATION_DT_SECONDS))

    return GeneratedScenario(
        scenario_key=definition.key,
        scenario_name=definition.name,
        drones=selected_drones,
        waypoint_count=definition.waypoint_count,
        estimated_frames=adjusted_frames,
        estimated_duration_seconds=adjusted_duration,
        recommended_primary_drone=primary_spec.name,
    )
