from __future__ import annotations

import unittest

from backend.physics import ControlInput
from backend.physics import DroneState
from backend.physics import render_telemetry
from backend.physics import SIMULATION_DT_SECONDS
from backend.physics import step_state


class PhysicsStepStateTests(unittest.TestCase):
    def test_render_telemetry_reports_horizontal_speed_only(self) -> None:
        telemetry = render_telemetry(
            state=DroneState(
                lat=0.0,
                lon=0.0,
                alt_m=10.0,
                velocity_north_mps=3.0,
                velocity_east_mps=4.0,
                velocity_up_mps=12.0,
            ),
            control=ControlInput(
                accel_north_mps2=0.0,
                accel_east_mps2=0.0,
                accel_up_mps2=0.0,
            ),
        )

        self.assertAlmostEqual(telemetry.speed_mps, 5.0)

    def test_render_telemetry_uses_realized_acceleration_when_previous_state_is_provided(self) -> None:
        telemetry = render_telemetry(
            state=DroneState(
                lat=0.0,
                lon=0.0,
                alt_m=1.0,
                velocity_north_mps=2.0,
                velocity_east_mps=0.0,
                velocity_up_mps=0.0,
            ),
            control=ControlInput(
                accel_north_mps2=9.9,
                accel_east_mps2=0.0,
                accel_up_mps2=0.0,
            ),
            previous_state=DroneState(
                lat=0.0,
                lon=0.0,
                alt_m=0.0,
                velocity_north_mps=1.0,
                velocity_east_mps=0.0,
                velocity_up_mps=0.0,
            ),
            dt=0.5,
        )

        self.assertAlmostEqual(telemetry.accel_mps2, 2.0)

    def test_render_telemetry_reports_zero_directional_acceleration_during_constant_speed_turn(self) -> None:
        telemetry = render_telemetry(
            state=DroneState(
                lat=0.0,
                lon=0.0,
                alt_m=10.0,
                velocity_north_mps=0.0,
                velocity_east_mps=5.0,
                velocity_up_mps=0.0,
            ),
            control=ControlInput(
                accel_north_mps2=-10.0,
                accel_east_mps2=10.0,
                accel_up_mps2=0.0,
            ),
            previous_state=DroneState(
                lat=0.0,
                lon=0.0,
                alt_m=10.0,
                velocity_north_mps=5.0,
                velocity_east_mps=0.0,
                velocity_up_mps=0.0,
            ),
            dt=0.5,
        )

        self.assertAlmostEqual(telemetry.accel_mps2, 0.0)

    def test_render_telemetry_projects_commanded_acceleration_onto_travel_direction_without_history(self) -> None:
        telemetry = render_telemetry(
            state=DroneState(
                lat=0.0,
                lon=0.0,
                alt_m=2.0,
                velocity_north_mps=3.0,
                velocity_east_mps=4.0,
                velocity_up_mps=0.0,
            ),
            control=ControlInput(
                accel_north_mps2=1.5,
                accel_east_mps2=2.0,
                accel_up_mps2=9.0,
            ),
        )

        self.assertAlmostEqual(telemetry.accel_mps2, 2.5)

    def test_step_state_integrates_altitude_from_velocity_profile(self) -> None:
        state = DroneState(
            lat=0.0,
            lon=0.0,
            alt_m=0.0,
            velocity_north_mps=0.0,
            velocity_east_mps=0.0,
            velocity_up_mps=0.0,
        )
        control = ControlInput(
            accel_north_mps2=0.0,
            accel_east_mps2=0.0,
            accel_up_mps2=0.4,
        )

        for _ in range(40):
            state = step_state(
                state=state,
                control=control,
                dt=SIMULATION_DT_SECONDS,
                max_horizontal_speed_mps=25.0,
                max_ascent_speed_mps=6.0,
                max_descent_speed_mps=6.0,
                max_service_ceiling_m=3800.0,
            )

        self.assertAlmostEqual(state.velocity_up_mps, 0.8)
        self.assertAlmostEqual(state.alt_m, 0.8)

    def test_step_state_respects_ascent_speed_limit_over_time(self) -> None:
        state = DroneState(
            lat=0.0,
            lon=0.0,
            alt_m=0.0,
            velocity_north_mps=0.0,
            velocity_east_mps=0.0,
            velocity_up_mps=0.0,
        )
        control = ControlInput(
            accel_north_mps2=0.0,
            accel_east_mps2=0.0,
            accel_up_mps2=0.4,
        )

        for _ in range(400):
            state = step_state(
                state=state,
                control=control,
                dt=SIMULATION_DT_SECONDS,
                max_horizontal_speed_mps=25.0,
                max_ascent_speed_mps=6.0,
                max_descent_speed_mps=6.0,
                max_service_ceiling_m=3800.0,
            )

        self.assertAlmostEqual(state.velocity_up_mps, 6.0)
        self.assertAlmostEqual(state.alt_m, 75.0)


if __name__ == "__main__":
    unittest.main()
