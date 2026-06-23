from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from backend.paths import runtime_path


@dataclass(frozen=True)
class DroneSpec:
    """Static airframe limits used by the simulator."""

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


KMH_TO_MPS = 1.0 / 3.6
MPH_TO_MPS = 0.44704
CUSTOM_DRONE_SPEC_KEY_PREFIX = "custom_drone"
DEFAULT_CUSTOM_DRONE_SPEC_DIRECTORY = runtime_path("drone_specs", "custom")

# RCS values below are simulation placeholders, not official DJI specifications.
DRONE_SPECS: dict[str, DroneSpec] = {
    "inspire_3": DroneSpec(
        name="Inspire 3",
        category="상용 멀티콥터",
        max_horizontal_speed_mps=94.0 * KMH_TO_MPS,
        max_ascent_speed_mps=8.0,
        max_descent_speed_mps=8.0,
        max_service_ceiling_m=3800.0,
        max_flight_time_min=28.0,
        weight_g=3995.0,
        rcs_estimate_m2=0.08,
    ),
    "inspire_2": DroneSpec(
        name="Inspire 2",
        category="상용 멀티콥터",
        max_horizontal_speed_mps=58.0 * MPH_TO_MPS,
        max_ascent_speed_mps=6.0,
        max_descent_speed_mps=9.0,
        max_service_ceiling_m=2500.0,
        max_flight_time_min=27.0,
        weight_g=3440.0,
        rcs_estimate_m2=0.07,
    ),
    "mavic_3_pro": DroneSpec(
        name="Mavic 3 Pro",
        category="상용 멀티콥터",
        max_horizontal_speed_mps=21.0,
        max_ascent_speed_mps=8.0,
        max_descent_speed_mps=6.0,
        max_service_ceiling_m=6000.0,
        max_flight_time_min=43.0,
        weight_g=958.0,
        rcs_estimate_m2=0.03,
    ),
    "mavic_air_2": DroneSpec(
        name="Mavic Air 2",
        category="상용 멀티콥터",
        max_horizontal_speed_mps=19.0,
        max_ascent_speed_mps=4.0,
        max_descent_speed_mps=3.0,
        max_service_ceiling_m=5000.0,
        max_flight_time_min=34.0,
        weight_g=570.0,
        rcs_estimate_m2=0.02,
    ),
    "phantom_4_rtk": DroneSpec(
        name="Phantom 4 RTK",
        category="상용 멀티콥터",
        max_horizontal_speed_mps=58.0 * KMH_TO_MPS,
        max_ascent_speed_mps=6.0,
        max_descent_speed_mps=3.0,
        max_service_ceiling_m=6000.0,
        max_flight_time_min=30.0,
        weight_g=1391.0,
        rcs_estimate_m2=0.04,
    ),
}


def sanitize_custom_drone_name_fragment(value: str) -> str:
    """Build a filesystem-safe name fragment for a custom drone key."""

    sanitized = "".join(
        character.lower() if character.isalnum() else "_"
        for character in value.strip()
    )
    collapsed = "_".join(fragment for fragment in sanitized.split("_") if fragment)
    return collapsed or "drone"


def build_custom_drone_spec_key(
    name: str,
    existing_keys: set[str] | None = None,
) -> str:
    """Create a unique key for a saved custom drone specification."""

    existing = existing_keys or set()
    base_key = (
        f"{CUSTOM_DRONE_SPEC_KEY_PREFIX}_"
        f"{sanitize_custom_drone_name_fragment(name)}_"
        f"{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    )
    candidate_key = base_key
    suffix_index = 2
    while candidate_key in existing:
        candidate_key = f"{base_key}_{suffix_index}"
        suffix_index += 1
    return candidate_key


def build_custom_drone_spec_path(
    drone_key: str,
    directory: Path = DEFAULT_CUSTOM_DRONE_SPEC_DIRECTORY,
) -> Path:
    """Resolve the JSON path for a custom drone specification."""

    return directory / f"{drone_key}.json"


def build_custom_drone_spec_payload(
    *,
    key: str,
    spec: DroneSpec,
) -> dict[str, object]:
    """Serialize a user-defined drone specification into the stored JSON payload."""

    return {
        "key": key,
        "name": spec.name,
        "category": spec.category,
        "max_horizontal_speed_mps": spec.max_horizontal_speed_mps,
        "max_ascent_speed_mps": spec.max_ascent_speed_mps,
        "max_descent_speed_mps": spec.max_descent_speed_mps,
        "max_service_ceiling_m": spec.max_service_ceiling_m,
        "max_flight_time_min": spec.max_flight_time_min,
        "weight_g": spec.weight_g,
        "rcs_estimate_m2": spec.rcs_estimate_m2,
        "rf_signature": spec.rf_signature,
        "rf_band": spec.rf_band,
        "acoustic_signature_hz": spec.acoustic_signature_hz,
        "thermal_signature_level": spec.thermal_signature_level,
        "payload_capacity_g": spec.payload_capacity_g,
        "sensor_notes": spec.sensor_notes,
    }


def parse_custom_drone_spec_payload(payload: dict[str, object]) -> tuple[str, DroneSpec]:
    """Convert a saved custom drone JSON payload into a runtime drone spec."""

    key = str(payload["key"])
    spec = DroneSpec(
        name=str(payload["name"]),
        category=str(payload.get("category", "사용자 정의 기체")),
        max_horizontal_speed_mps=float(payload["max_horizontal_speed_mps"]),
        max_ascent_speed_mps=float(payload["max_ascent_speed_mps"]),
        max_descent_speed_mps=float(payload["max_descent_speed_mps"]),
        max_service_ceiling_m=float(payload["max_service_ceiling_m"]),
        max_flight_time_min=float(payload["max_flight_time_min"]),
        weight_g=float(payload["weight_g"]),
        rcs_estimate_m2=float(payload["rcs_estimate_m2"]),
        rf_signature=_normalize_optional_string(payload.get("rf_signature")),
        rf_band=_normalize_optional_string(payload.get("rf_band")),
        acoustic_signature_hz=_normalize_optional_float(payload.get("acoustic_signature_hz")),
        thermal_signature_level=_normalize_optional_string(payload.get("thermal_signature_level")),
        payload_capacity_g=_normalize_optional_float(payload.get("payload_capacity_g")),
        sensor_notes=_normalize_optional_string(payload.get("sensor_notes")),
    )
    return key, spec


def _normalize_optional_string(value: object) -> str | None:
    """Return a stripped string value or None for empty inputs."""

    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _normalize_optional_float(value: object) -> float | None:
    """Return a numeric value when present, otherwise None."""

    if value in {None, ""}:
        return None
    return float(value)


def load_custom_drone_spec_entries(
    directory: Path = DEFAULT_CUSTOM_DRONE_SPEC_DIRECTORY,
) -> dict[str, DroneSpec]:
    """Load all persisted custom drone specifications from disk."""

    if not directory.exists():
        return {}

    entries: dict[str, DroneSpec] = {}
    for path in sorted(directory.glob("*.json")):
        with path.open("r", encoding="utf-8") as input_file:
            key, spec = parse_custom_drone_spec_payload(json.load(input_file))
        entries[key] = spec
    return entries


_custom_drone_specs_cache: dict[str, DroneSpec] | None = None


def get_custom_drone_spec_entries() -> dict[str, DroneSpec]:
    """Return cached custom drone specifications, loading them on first use."""

    global _custom_drone_specs_cache
    if _custom_drone_specs_cache is None:
        _custom_drone_specs_cache = load_custom_drone_spec_entries()
    return _custom_drone_specs_cache


def is_builtin_drone_spec_key(drone_key: str) -> bool:
    """Return whether a key belongs to the built-in airframe catalog."""

    return drone_key in DRONE_SPECS


def has_custom_drone_spec_override(drone_key: str) -> bool:
    """Return whether a built-in key currently has a persisted override."""

    return drone_key in get_custom_drone_spec_entries()


def refresh_custom_drone_spec_entries() -> dict[str, DroneSpec]:
    """Reload custom drone specifications from disk into memory."""

    global _custom_drone_specs_cache
    _custom_drone_specs_cache = load_custom_drone_spec_entries()
    return _custom_drone_specs_cache


def save_custom_drone_spec(
    *,
    name: str,
    category: str,
    max_horizontal_speed_mps: float,
    max_ascent_speed_mps: float,
    max_descent_speed_mps: float,
    max_service_ceiling_m: float,
    max_flight_time_min: float,
    weight_g: float,
    rcs_estimate_m2: float,
    rf_signature: str | None = None,
    rf_band: str | None = None,
    acoustic_signature_hz: float | None = None,
    thermal_signature_level: str | None = None,
    payload_capacity_g: float | None = None,
    sensor_notes: str | None = None,
    directory: Path = DEFAULT_CUSTOM_DRONE_SPEC_DIRECTORY,
) -> tuple[str, DroneSpec]:
    """Persist a user-defined drone specification and return its key and value."""

    existing_keys = set(DRONE_SPECS.keys()) | set(get_custom_drone_spec_entries().keys())
    drone_key = build_custom_drone_spec_key(name, existing_keys)
    spec = DroneSpec(
        name=name.strip(),
        category=category.strip() or "사용자 정의 기체",
        max_horizontal_speed_mps=max_horizontal_speed_mps,
        max_ascent_speed_mps=max_ascent_speed_mps,
        max_descent_speed_mps=max_descent_speed_mps,
        max_service_ceiling_m=max_service_ceiling_m,
        max_flight_time_min=max_flight_time_min,
        weight_g=weight_g,
        rcs_estimate_m2=rcs_estimate_m2,
        rf_signature=_normalize_optional_string(rf_signature),
        rf_band=_normalize_optional_string(rf_band),
        acoustic_signature_hz=acoustic_signature_hz,
        thermal_signature_level=_normalize_optional_string(thermal_signature_level),
        payload_capacity_g=payload_capacity_g,
        sensor_notes=_normalize_optional_string(sensor_notes),
    )
    payload = build_custom_drone_spec_payload(key=drone_key, spec=spec)
    path = build_custom_drone_spec_path(drone_key, directory)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as output_file:
        json.dump(payload, output_file, ensure_ascii=False, indent=2)

    if directory == DEFAULT_CUSTOM_DRONE_SPEC_DIRECTORY:
        get_custom_drone_spec_entries()[drone_key] = spec
    return drone_key, spec


def update_drone_spec(
    drone_key: str,
    *,
    name: str,
    category: str,
    max_horizontal_speed_mps: float,
    max_ascent_speed_mps: float,
    max_descent_speed_mps: float,
    max_service_ceiling_m: float,
    max_flight_time_min: float,
    weight_g: float,
    rcs_estimate_m2: float,
    rf_signature: str | None = None,
    rf_band: str | None = None,
    acoustic_signature_hz: float | None = None,
    thermal_signature_level: str | None = None,
    payload_capacity_g: float | None = None,
    sensor_notes: str | None = None,
    directory: Path = DEFAULT_CUSTOM_DRONE_SPEC_DIRECTORY,
) -> DroneSpec:
    """Persist changes for an existing built-in or custom drone key."""

    if drone_key not in dict(list_drone_spec_entries()):
        raise ValueError(f"Unknown drone type: {drone_key}")

    spec = DroneSpec(
        name=name.strip(),
        category=category.strip() or "사용자 정의 기체",
        max_horizontal_speed_mps=max_horizontal_speed_mps,
        max_ascent_speed_mps=max_ascent_speed_mps,
        max_descent_speed_mps=max_descent_speed_mps,
        max_service_ceiling_m=max_service_ceiling_m,
        max_flight_time_min=max_flight_time_min,
        weight_g=weight_g,
        rcs_estimate_m2=rcs_estimate_m2,
        rf_signature=_normalize_optional_string(rf_signature),
        rf_band=_normalize_optional_string(rf_band),
        acoustic_signature_hz=acoustic_signature_hz,
        thermal_signature_level=_normalize_optional_string(thermal_signature_level),
        payload_capacity_g=payload_capacity_g,
        sensor_notes=_normalize_optional_string(sensor_notes),
    )
    payload = build_custom_drone_spec_payload(key=drone_key, spec=spec)
    path = build_custom_drone_spec_path(drone_key, directory)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as output_file:
        json.dump(payload, output_file, ensure_ascii=False, indent=2)

    if directory == DEFAULT_CUSTOM_DRONE_SPEC_DIRECTORY:
        get_custom_drone_spec_entries()[drone_key] = spec
    return spec


def delete_drone_spec(
    drone_key: str,
    directory: Path = DEFAULT_CUSTOM_DRONE_SPEC_DIRECTORY,
) -> tuple[DroneSpec, bool]:
    """Delete a custom drone or remove a built-in override.

    Returns the removed spec and whether the operation restored a built-in default.
    """

    if drone_key not in dict(list_drone_spec_entries()):
        raise ValueError(f"Unknown drone type: {drone_key}")

    path = build_custom_drone_spec_path(drone_key, directory)
    if not path.exists():
        if is_builtin_drone_spec_key(drone_key):
            raise ValueError("기본 기체 원본은 삭제할 수 없습니다.")
        raise ValueError("삭제할 사용자 기체를 찾지 못했습니다.")

    removed_spec = get_custom_drone_spec_entries().get(drone_key)
    if removed_spec is None:
        removed_spec = get_drone_spec(drone_key)

    path.unlink()
    if directory == DEFAULT_CUSTOM_DRONE_SPEC_DIRECTORY:
        get_custom_drone_spec_entries().pop(drone_key, None)

    return removed_spec, is_builtin_drone_spec_key(drone_key)


def get_drone_spec(drone_key: str) -> DroneSpec:
    """Return a drone spec by internal key."""

    custom_spec = get_custom_drone_spec_entries().get(drone_key)
    if custom_spec is not None:
        return custom_spec

    builtin_spec = DRONE_SPECS.get(drone_key)
    if builtin_spec is not None:
        return builtin_spec

    raise ValueError(f"Unknown drone type: {drone_key}")


def list_drone_specs() -> list[DroneSpec]:
    """Return all supported drone specs."""

    return [spec for _key, spec in list_drone_spec_entries()]


def list_drone_spec_entries() -> list[tuple[str, DroneSpec]]:
    """Return supported drone specs with their stable API keys."""

    custom_entries = get_custom_drone_spec_entries()
    builtin_entries = [
        (key, custom_entries.get(key, spec))
        for key, spec in DRONE_SPECS.items()
    ]
    custom_entries = sorted(
        (
            (key, spec)
            for key, spec in custom_entries.items()
            if key not in DRONE_SPECS
        ),
        key=lambda entry: entry[1].name,
    )
    return [*builtin_entries, *custom_entries]
