from __future__ import annotations

import asyncio
import csv
from dataclasses import dataclass
from datetime import UTC, datetime
from math import cos
from math import hypot
from math import log10
from math import pi
from math import sin
from pathlib import Path

from backend.drone_specs import list_drone_spec_entries
from backend.paths import runtime_path


DEFAULT_COMPLETED_LOG_DIRECTORY = runtime_path("logs", "completed_scenarios")
EARTH_METERS_PER_DEGREE_LAT = 111320.0


@dataclass(frozen=True)
class CompletedScenarioTelemetrySample:
    """Single telemetry sample persisted for a completed scenario."""

    timestamp: str
    lat: float
    lon: float
    alt_m: float
    velocity_mps: float
    rcs_value_m2: float
    rssi_dbm: float | None = None


@dataclass(frozen=True)
class CompletedScenarioReplaySample:
    """Replay-ready telemetry sample parsed from a saved CSV log."""

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


def infer_replay_metadata_from_filename(path: Path) -> tuple[str, str]:
    """Best-effort replay metadata inference from a saved CSV filename."""

    stem = path.stem
    if stem.startswith("flight_log_"):
        payload = stem.removeprefix("flight_log_")
        payload_parts = payload.split("_")
        if len(payload_parts) >= 3:
            scenario_key = "_".join(payload_parts[1:-2]) or payload_parts[1]
            drone_name = payload_parts[0]
            return drone_name, scenario_key

    if len(stem) > 16 and stem[8] == "_" and stem[15] == "_":
        payload = stem[16:]
        known_drone_labels = sorted(
            (sanitize_filename_part(spec.name), spec.name)
            for _, spec in list_drone_spec_entries()
        )
        for sanitized_drone_name, display_drone_name in known_drone_labels:
            prefix = f"{sanitized_drone_name}_"
            if payload.startswith(prefix):
                return display_drone_name, payload.removeprefix(prefix)

    return "", ""


@dataclass(frozen=True)
class CompletedScenarioReplayLog:
    """Metadata and samples loaded from a completed scenario CSV log."""

    log_id: str
    filename: str
    drone_name: str
    scenario_key: str
    sample_count: int
    started_at_utc: str | None
    ended_at_utc: str | None
    duration_seconds: float
    samples: list[CompletedScenarioReplaySample]


def sanitize_filename_part(value: str) -> str:
    """Convert a display label into a filesystem-safe filename segment."""

    sanitized = "".join(
        character if character.isalnum() or character in {"-", "_"} else "_"
        for character in value.strip()
    )
    collapsed = sanitized.strip("_")
    return collapsed or "unknown"


def build_completed_log_path(
    scenario_key: str,
    drone_name: str,
    completed_at: datetime,
    slot_index: int = 0,
    directory: Path = DEFAULT_COMPLETED_LOG_DIRECTORY,
) -> Path:
    """Build the destination CSV path for a completed scenario log."""

    timestamp = completed_at.strftime("%Y%m%d_%H%M%S")
    filename = (
        f"{timestamp}_{sanitize_filename_part(drone_name)}_"
        f"{sanitize_filename_part(scenario_key)}.csv"
    )
    return directory / filename


def _meters_per_degree_lon(lat: float) -> float:
    return EARTH_METERS_PER_DEGREE_LAT * max(cos((lat * pi) / 180.0), 1e-6)


def _calculate_horizontal_distance_m(
    lat_a: float,
    lon_a: float,
    lat_b: float,
    lon_b: float,
) -> float:
    average_lat = (lat_a + lat_b) / 2.0
    north_offset_m = (lat_b - lat_a) * EARTH_METERS_PER_DEGREE_LAT
    east_offset_m = (lon_b - lon_a) * _meters_per_degree_lon(average_lat)
    return hypot(north_offset_m, east_offset_m)


def _estimate_log_rssi_dbm(
    sample: CompletedScenarioTelemetrySample,
    reference_lat: float,
    reference_lon: float,
    reference_alt_m: float,
    slot_index: int,
) -> float:
    horizontal_distance_m = _calculate_horizontal_distance_m(
        sample.lat,
        sample.lon,
        reference_lat,
        reference_lon,
    )
    altitude_delta_m = abs(sample.alt_m - reference_alt_m)
    link_distance_m = max(1.0, hypot(horizontal_distance_m, altitude_delta_m))
    path_loss_db = 20.0 * log10(link_distance_m)
    deterministic_wobble_db = sin((horizontal_distance_m * 0.045) + (slot_index * 0.8)) * 1.4
    return max(-98.0, min(-32.0, -38.0 - path_loss_db + deterministic_wobble_db))


def _write_completed_scenario_log(
    path: Path,
    samples: list[CompletedScenarioTelemetrySample],
    rf_freq_mhz: float | None = None,
    rf_proto: str = "",
    reference_lat: float | None = None,
    reference_lon: float | None = None,
    reference_alt_m: float | None = None,
    slot_index: int = 0,
) -> Path:
    """Write completed telemetry samples to disk as UTF-8 CSV."""

    path.parent.mkdir(parents=True, exist_ok=True)
    candidate_path = path
    suffix_index = 2

    while True:
        try:
            with candidate_path.open("x", encoding="utf-8-sig", newline="") as output_file:
                if rf_freq_mhz is not None:
                    output_file.write(f"# RF_Freq: {rf_freq_mhz:.1f}\n")
                if rf_proto.strip():
                    output_file.write(f"# RF_proto: {rf_proto.strip()}\n")
                if rf_freq_mhz is not None or rf_proto.strip():
                    output_file.write("\n")

                writer = csv.writer(output_file)
                writer.writerow([
                    "timestamp_utc",
                    "lat",
                    "lon",
                    "alt_m",
                    "velocity",
                    "RCS_value",
                    "RSSI",
                ])
                for sample in samples:
                    rssi_dbm = sample.rssi_dbm
                    if (
                        rssi_dbm is None
                        and reference_lat is not None
                        and reference_lon is not None
                        and reference_alt_m is not None
                    ):
                        rssi_dbm = _estimate_log_rssi_dbm(
                            sample=sample,
                            reference_lat=reference_lat,
                            reference_lon=reference_lon,
                            reference_alt_m=reference_alt_m,
                            slot_index=slot_index,
                        )
                    writer.writerow([
                        sample.timestamp,
                        f"{sample.lat:.7f}",
                        f"{sample.lon:.7f}",
                        f"{sample.alt_m:.2f}",
                        f"{sample.velocity_mps:.2f}",
                        f"{sample.rcs_value_m2:.4f}",
                        f"{float(rssi_dbm or 0.0):.1f}",
                    ])
            return candidate_path
        except FileExistsError:
            candidate_path = path.with_name(f"{path.stem}_{suffix_index}{path.suffix}")
            suffix_index += 1


async def save_completed_scenario_log(
    scenario_key: str,
    drone_name: str,
    completed_at: datetime,
    samples: list[CompletedScenarioTelemetrySample],
    rf_freq_mhz: float | None = None,
    rf_proto: str = "",
    reference_lat: float | None = None,
    reference_lon: float | None = None,
    reference_alt_m: float | None = None,
    slot_index: int = 0,
    directory: Path = DEFAULT_COMPLETED_LOG_DIRECTORY,
) -> Path:
    """Persist a completed scenario log behind an async API boundary."""

    path = build_completed_log_path(
        scenario_key=scenario_key,
        drone_name=drone_name,
        completed_at=completed_at,
        slot_index=slot_index,
        directory=directory,
    )
    return await asyncio.to_thread(
        _write_completed_scenario_log,
        path,
        samples,
        rf_freq_mhz,
        rf_proto,
        reference_lat,
        reference_lon,
        reference_alt_m,
        slot_index,
    )


def _parse_utc_timestamp(value: str) -> datetime | None:
    """Parse an ISO-like timestamp string into a UTC datetime."""

    text = value.strip()
    if not text:
        return None

    if text.endswith(" KST"):
        text = text.removesuffix(" KST").strip().replace(" ", "T") + "+09:00"

    try:
        parsed_datetime = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None

    if parsed_datetime.tzinfo is None:
        return parsed_datetime.replace(tzinfo=UTC)
    return parsed_datetime.astimezone(UTC)


def _parse_float(value: str | None) -> float:
    """Convert a CSV numeric cell into float."""

    try:
        return float(value or 0)
    except ValueError:
        return 0.0


def _load_completed_scenario_log(path: Path) -> CompletedScenarioReplayLog:
    """Read a completed scenario CSV file into structured replay data."""

    with path.open("r", encoding="utf-8-sig", newline="") as input_file:
        csv_lines = [
            line
            for line in input_file
            if line.strip() and not line.lstrip().startswith("#")
        ]
        reader = csv.DictReader(csv_lines)
        rows = list(reader)

    replay_samples: list[CompletedScenarioReplaySample] = []
    first_timestamp: datetime | None = None
    inferred_drone_name, inferred_scenario_key = infer_replay_metadata_from_filename(path)

    for fallback_index, row in enumerate(rows):
        sample_index = int(row.get("sample_index") or fallback_index)
        timestamp_text = str(
            row.get("timestamp_utc")
            or row.get("timestamp_kst")
            or row.get("timestamp")
            or row.get("time_stamp")
            or ""
        ).strip()
        timestamp_utc = _parse_utc_timestamp(timestamp_text)
        if first_timestamp is None and timestamp_utc is not None:
            first_timestamp = timestamp_utc

        elapsed_ms_text = str(row.get("elapsed_ms") or "").strip()
        if elapsed_ms_text.isdigit():
            elapsed_ms = int(elapsed_ms_text)
        elif timestamp_utc is not None and first_timestamp is not None:
            elapsed_ms = max(0, int((timestamp_utc - first_timestamp).total_seconds() * 1000))
        else:
            elapsed_ms = fallback_index * 50

        replay_samples.append(
            CompletedScenarioReplaySample(
                sample_index=sample_index,
                timestamp_utc=timestamp_text,
                elapsed_ms=elapsed_ms,
                drone=str(row.get("drone") or inferred_drone_name).strip(),
                scenario=str(row.get("scenario") or inferred_scenario_key).strip(),
                flight_mode=str(row.get("flight_mode") or "").strip() or "MANUAL",
                lat_deg=_parse_float(row.get("lat_deg") or row.get("lat")),
                lon_deg=_parse_float(row.get("lon_deg") or row.get("lon")),
                alt_m=_parse_float(row.get("alt_m")),
                speed_mps=_parse_float(row.get("speed_mps") or row.get("velocity")),
                accel_mps2=_parse_float(row.get("accel_mps2")),
            ),
        )

    first_sample = replay_samples[0] if replay_samples else None
    last_sample = replay_samples[-1] if replay_samples else None
    duration_seconds = (
        max(0.0, (last_sample.elapsed_ms - first_sample.elapsed_ms) / 1000)
        if first_sample and last_sample
        else 0.0
    )

    return CompletedScenarioReplayLog(
        log_id=path.name,
        filename=path.name,
        drone_name=first_sample.drone if first_sample else inferred_drone_name,
        scenario_key=first_sample.scenario if first_sample else inferred_scenario_key,
        sample_count=len(replay_samples),
        started_at_utc=first_sample.timestamp_utc if first_sample else None,
        ended_at_utc=last_sample.timestamp_utc if last_sample else None,
        duration_seconds=duration_seconds,
        samples=replay_samples,
    )


def list_completed_scenario_logs(
    directory: Path = DEFAULT_COMPLETED_LOG_DIRECTORY,
) -> list[CompletedScenarioReplayLog]:
    """Return completed scenario logs sorted from newest to oldest."""

    if not directory.exists():
        return []

    replay_logs: list[CompletedScenarioReplayLog] = []
    for path in sorted(directory.glob("*.csv"), key=lambda candidate: candidate.stat().st_mtime, reverse=True):
        try:
            replay_logs.append(_load_completed_scenario_log(path))
        except (OSError, ValueError, csv.Error):
            continue

    return replay_logs


def read_completed_scenario_log(
    log_id: str,
    directory: Path = DEFAULT_COMPLETED_LOG_DIRECTORY,
) -> CompletedScenarioReplayLog:
    """Load a single completed scenario log by filename-like identifier."""

    normalized_log_id = Path(log_id).name
    if normalized_log_id != log_id:
        raise ValueError("Invalid replay log identifier.")

    path = directory / normalized_log_id
    if not path.is_file():
        raise FileNotFoundError(f"Replay log not found: {log_id}")

    return _load_completed_scenario_log(path)
