from __future__ import annotations

from dataclasses import dataclass
from math import atan2
from math import cos
from math import degrees
from math import hypot
from math import pi
from math import sin

import numpy as np

from backend.physics import SIMULATION_DT_SECONDS


SENSOR_STOPPED_SPEED_TOLERANCE_MPS = 0.25
SENSOR_SPEED_LAG_ALPHA = 0.1
SENSOR_WIND_RANDOM_WALK_STD_MPS = 0.02
SENSOR_WIND_BIAS_LIMIT_MPS = 1.2
GRAVITY_MPS2 = 9.80665
ATTITUDE_FILTER_TAU_SECONDS = 0.65
ATTITUDE_YAW_FILTER_TAU_SECONDS = 0.9
ATTITUDE_MIN_HEADING_SPEED_MPS = 0.1
ATTITUDE_ROLL_NOISE_STD_DEG = 0.06
ATTITUDE_PITCH_NOISE_STD_DEG = 0.06
ATTITUDE_YAW_NOISE_STD_DEG = 0.08


@dataclass
class SensorTelemetryState:
    """Mutable per-stream sensor model state for delayed and low-frequency telemetry noise."""

    delayed_speed_mps: float = 0.0
    wind_speed_bias_mps: float = 0.0
    previous_reported_speed_mps: float = 0.0


@dataclass
class AttitudeEstimatorState:
    """Mutable low-pass attitude estimate state for one telemetry stream."""

    roll_rad: float = 0.0
    pitch_rad: float = 0.0
    yaw_rad: float = 0.0


@dataclass(frozen=True)
class AttitudeEstimate:
    """Estimated body attitude exposed as degrees for UI consumers."""

    roll_deg: float
    pitch_deg: float
    yaw_deg: float


def apply_sensor_telemetry_model(
    telemetry_alt_m: float,
    telemetry_speed_mps: float,
    sensor_state: SensorTelemetryState,
    suppress_stopped_noise: bool = False,
) -> tuple[float, float, float]:
    """Apply low-frequency wind drift and sensor lag to rendered telemetry."""

    if suppress_stopped_noise and telemetry_speed_mps <= SENSOR_STOPPED_SPEED_TOLERANCE_MPS:
        sensor_state.delayed_speed_mps = 0.0
        sensor_state.wind_speed_bias_mps = 0.0
        sensor_state.previous_reported_speed_mps = 0.0
        return telemetry_alt_m, 0.0, 0.0

    sensor_state.delayed_speed_mps += (
        SENSOR_SPEED_LAG_ALPHA
        * (telemetry_speed_mps - sensor_state.delayed_speed_mps)
    )
    sensor_state.wind_speed_bias_mps = max(
        -SENSOR_WIND_BIAS_LIMIT_MPS,
        min(
            SENSOR_WIND_BIAS_LIMIT_MPS,
            sensor_state.wind_speed_bias_mps
            + float(np.random.normal(0.0, SENSOR_WIND_RANDOM_WALK_STD_MPS)),
        ),
    )

    reported_speed_mps = max(
        0.0,
        sensor_state.delayed_speed_mps + sensor_state.wind_speed_bias_mps,
    )
    reported_accel_mps2 = (
        (reported_speed_mps - sensor_state.previous_reported_speed_mps)
        / SIMULATION_DT_SECONDS
    )
    sensor_state.previous_reported_speed_mps = reported_speed_mps

    return telemetry_alt_m, reported_speed_mps, reported_accel_mps2


def normalize_angle_rad(angle_rad: float) -> float:
    """Normalize an angle to the [-pi, pi] range."""

    return ((angle_rad + pi) % (2.0 * pi)) - pi


def estimate_attitude_from_acceleration(
    accel_north_mps2: float,
    accel_east_mps2: float,
    velocity_north_mps: float,
    velocity_east_mps: float,
    estimator_state: AttitudeEstimatorState,
    dt: float = SIMULATION_DT_SECONDS,
) -> AttitudeEstimate:
    """Estimate RPY from NE acceleration and velocity heading without changing flight physics."""

    horizontal_speed_mps = hypot(velocity_north_mps, velocity_east_mps)
    if horizontal_speed_mps > ATTITUDE_MIN_HEADING_SPEED_MPS:
        target_yaw_rad = atan2(velocity_east_mps, velocity_north_mps)
        yaw_delta_rad = normalize_angle_rad(target_yaw_rad - estimator_state.yaw_rad)
        yaw_alpha = max(0.0, min(1.0, dt / (ATTITUDE_YAW_FILTER_TAU_SECONDS + dt)))
        estimator_state.yaw_rad = normalize_angle_rad(
            estimator_state.yaw_rad + (yaw_alpha * yaw_delta_rad)
        )

    acc_forward_mps2 = (
        (accel_north_mps2 * cos(estimator_state.yaw_rad))
        + (accel_east_mps2 * sin(estimator_state.yaw_rad))
    )
    acc_lateral_mps2 = (
        (-accel_north_mps2 * sin(estimator_state.yaw_rad))
        + (accel_east_mps2 * cos(estimator_state.yaw_rad))
    )
    target_pitch_rad = atan2(-acc_forward_mps2, GRAVITY_MPS2)
    target_roll_rad = atan2(acc_lateral_mps2, GRAVITY_MPS2)
    alpha = max(0.0, min(1.0, dt / (ATTITUDE_FILTER_TAU_SECONDS + dt)))

    estimator_state.pitch_rad += alpha * (target_pitch_rad - estimator_state.pitch_rad)
    estimator_state.roll_rad += alpha * (target_roll_rad - estimator_state.roll_rad)

    return AttitudeEstimate(
        roll_deg=degrees(estimator_state.roll_rad),
        pitch_deg=degrees(estimator_state.pitch_rad),
        yaw_deg=degrees(estimator_state.yaw_rad),
    )


def add_attitude_sensor_noise(estimate: AttitudeEstimate) -> AttitudeEstimate:
    """Apply small display-level Gaussian noise to attitude readouts."""

    return AttitudeEstimate(
        roll_deg=estimate.roll_deg + float(np.random.normal(0.0, ATTITUDE_ROLL_NOISE_STD_DEG)),
        pitch_deg=estimate.pitch_deg + float(np.random.normal(0.0, ATTITUDE_PITCH_NOISE_STD_DEG)),
        yaw_deg=estimate.yaw_deg + float(np.random.normal(0.0, ATTITUDE_YAW_NOISE_STD_DEG)),
    )
