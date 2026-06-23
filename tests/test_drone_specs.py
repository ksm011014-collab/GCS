from __future__ import annotations

import shutil
import unittest
from pathlib import Path

from backend.drone_specs import build_custom_drone_spec_path
from backend.drone_specs import load_custom_drone_spec_entries
from backend.drone_specs import save_custom_drone_spec


class DroneSpecDefinitionTests(unittest.TestCase):
    def test_save_custom_drone_spec_persists_definition_to_json(self) -> None:
        test_directory = Path("drone_specs") / "__unit_test_custom__"
        if test_directory.exists():
            shutil.rmtree(test_directory)

        try:
            drone_key, spec = save_custom_drone_spec(
                name="사용자 테스트 기체",
                category="고정익",
                max_horizontal_speed_mps=30.0,
                max_ascent_speed_mps=5.0,
                max_descent_speed_mps=4.0,
                max_service_ceiling_m=3500.0,
                max_flight_time_min=42.0,
                weight_g=1400.0,
                rcs_estimate_m2=0.06,
                rf_signature="LTE",
                rf_band="LTE",
                acoustic_signature_hz=210.0,
                thermal_signature_level="중열",
                payload_capacity_g=350.0,
                sensor_notes="고정익 장거리",
                directory=test_directory,
            )

            saved_path = build_custom_drone_spec_path(drone_key, test_directory)
            loaded_entries = load_custom_drone_spec_entries(test_directory)

            self.assertTrue(saved_path.exists())
            self.assertEqual(spec.name, "사용자 테스트 기체")
            self.assertIn(drone_key, loaded_entries)
            self.assertEqual(loaded_entries[drone_key].category, "고정익")
            self.assertEqual(loaded_entries[drone_key].rf_signature, "LTE")
            self.assertEqual(loaded_entries[drone_key].payload_capacity_g, 350.0)
        finally:
            if test_directory.exists():
                shutil.rmtree(test_directory)


if __name__ == "__main__":
    unittest.main()
