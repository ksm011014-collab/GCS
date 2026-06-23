from __future__ import annotations

from dataclasses import dataclass
from math import cos, radians
from math import hypot


SIMULATION_DT_SECONDS = 0.05
EARTH_METERS_PER_DEGREE_LAT = 111_320.0


@dataclass(frozen=True)
class DroneState:
    """Physical state for a single simulated aircraft."""

    lat: float
    lon: float
    alt_m: float
    velocity_north_mps: float
    velocity_east_mps: float
    velocity_up_mps: float


@dataclass(frozen=True)
class ControlInput:
    """Desired accelerations applied during a single integration step."""

    accel_north_mps2: float
    accel_east_mps2: float
    accel_up_mps2: float


@dataclass(frozen=True)
class TelemetrySnapshot:
    """Rendered telemetry values sent to downstream consumers."""

    lat: float
    lon: float
    alt_m: float
    speed_mps: float
    accel_mps2: float


def clamp(value: float, minimum: float, maximum: float) -> float:
    """Clamp a value to a closed interval."""

    return max(minimum, min(maximum, value))


def meters_per_degree_lon(lat: float) -> float:
    """Approximate longitude scale at a given latitude using WGS84-style local scaling."""

    return EARTH_METERS_PER_DEGREE_LAT * cos(radians(lat))


def integrate_velocity(value: float, derivative: float, dt: float) -> float:
    """Integrate a scalar using RK4 with constant derivative across the step."""

    k1 = derivative
    k2 = derivative
    k3 = derivative
    k4 = derivative
    return value + (dt / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4)


def integrate_displacement(start_velocity: float, end_velocity: float, dt: float) -> float:
    """Integrate displacement using RK4 across a linearly changing velocity step."""

    midpoint_velocity = (start_velocity + end_velocity) / 2.0
    k1 = start_velocity
    k2 = midpoint_velocity
    k3 = midpoint_velocity
    k4 = end_velocity
    return (dt / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4)


def step_state(
    state: DroneState,
    control: ControlInput,
    dt: float,
    max_horizontal_speed_mps: float,
    max_ascent_speed_mps: float,
    max_descent_speed_mps: float,
    max_service_ceiling_m: float,
) -> DroneState:
    """Advance state by one RK4 step while enforcing spec limits."""

    next_velocity_north = integrate_velocity(
        state.velocity_north_mps,
        control.accel_north_mps2,
        dt,
    )
    next_velocity_east = integrate_velocity(
        state.velocity_east_mps,
        control.accel_east_mps2,
        dt,
    )
    next_velocity_up = integrate_velocity(
        state.velocity_up_mps,
        control.accel_up_mps2,
        dt,
    )

    horizontal_speed = (next_velocity_north**2 + next_velocity_east**2) ** 0.5
    if horizontal_speed > max_horizontal_speed_mps and horizontal_speed > 0.0:
        scale = max_horizontal_speed_mps / horizontal_speed
        next_velocity_north *= scale
        next_velocity_east *= scale

    next_velocity_up = clamp(
        next_velocity_up,
        -max_descent_speed_mps,
        max_ascent_speed_mps,
    )

    delta_north_m = integrate_displacement(
        state.velocity_north_mps,
        next_velocity_north,
        dt,
    )
    delta_east_m = integrate_displacement(
        state.velocity_east_mps,
        next_velocity_east,
        dt,
    )
    delta_up_m = integrate_displacement(
        state.velocity_up_mps,
        next_velocity_up,
        dt,
    )

    lon_scale = meters_per_degree_lon(state.lat)
    next_lat = state.lat + (delta_north_m / EARTH_METERS_PER_DEGREE_LAT)
    next_lon = state.lon if lon_scale == 0.0 else state.lon + (delta_east_m / lon_scale)
    next_alt = clamp(state.alt_m + delta_up_m, 0.0, max_service_ceiling_m)

    return DroneState(
        lat=next_lat,
        lon=next_lon,
        alt_m=next_alt,
        velocity_north_mps=next_velocity_north,
        velocity_east_mps=next_velocity_east,
        velocity_up_mps=next_velocity_up,
    )


def calculate_horizontal_speed_mps(state: DroneState) -> float:
    """Return horizontal speed magnitude from north/east velocity components."""

    return hypot(state.velocity_north_mps, state.velocity_east_mps)


def calculate_directional_acceleration_mps2(
    current_state: DroneState,
    control: ControlInput,
    previous_state: DroneState | None,
    dt: float,
) -> float:
    """Return acceleration along the current horizontal travel direction."""

    if previous_state is not None and dt > 0.0:
        previous_horizontal_speed_mps = calculate_horizontal_speed_mps(previous_state)
        current_horizontal_speed_mps = calculate_horizontal_speed_mps(current_state)
        return (current_horizontal_speed_mps - previous_horizontal_speed_mps) / dt

    current_horizontal_speed_mps = calculate_horizontal_speed_mps(current_state)
    if current_horizontal_speed_mps <= 0.0:
        return hypot(control.accel_north_mps2, control.accel_east_mps2)

    direction_north = current_state.velocity_north_mps / current_horizontal_speed_mps
    direction_east = current_state.velocity_east_mps / current_horizontal_speed_mps
    return (
        (control.accel_north_mps2 * direction_north)
        + (control.accel_east_mps2 * direction_east)
    )


def render_telemetry(
    state: DroneState,
    control: ControlInput,
    previous_state: DroneState | None = None,
    dt: float = SIMULATION_DT_SECONDS,
) -> TelemetrySnapshot:
    """Convert state into a compact telemetry payload."""

    horizontal_speed = calculate_horizontal_speed_mps(state)
    return TelemetrySnapshot(
        lat=state.lat,
        lon=state.lon,
        alt_m=state.alt_m,
        speed_mps=horizontal_speed,
        accel_mps2=calculate_directional_acceleration_mps2(
            current_state=state,
            control=control,
            previous_state=previous_state,
            dt=dt,
        ),
    )
