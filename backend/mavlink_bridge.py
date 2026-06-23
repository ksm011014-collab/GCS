from __future__ import annotations

from dataclasses import dataclass
from math import degrees
from math import hypot
from time import monotonic
from typing import Any

try:
    from pymavlink import mavutil
except ImportError:  # pragma: no cover - exercised only when dependency is missing
    mavutil = None  # type: ignore[assignment]


@dataclass
class MavlinkTelemetrySnapshot:
    """Latest read-only telemetry decoded from a MAVLink stream."""

    lat: float | None = None
    lon: float | None = None
    alt_m: float | None = None
    speed_mps: float = 0.0
    accel_mps2: float = 0.0
    roll_deg: float | None = None
    pitch_deg: float | None = None
    yaw_deg: float | None = None
    last_speed_mps: float = 0.0
    last_speed_time_s: float | None = None


@dataclass
class MavlinkVehicleStatusSnapshot:
    """Latest high-level vehicle status decoded from MAVLink system messages."""

    mode_key: str | None = None
    mode_label: str | None = None
    armed: bool | None = None
    autopilot_label: str | None = None
    vehicle_type_label: str | None = None
    system_status_label: str | None = None
    battery_remaining_pct: float | None = None
    battery_voltage_v: float | None = None
    battery_current_a: float | None = None
    gps_fix_label: str | None = None
    satellites_visible: int | None = None
    firmware_version_label: str | None = None
    autopilot_capabilities: int | None = None


@dataclass(frozen=True)
class MavlinkMissionItem:
    """Single mission item serialized through MISSION_ITEM_INT."""

    seq: int
    frame: int
    command: int
    current: int = 0
    autocontinue: int = 1
    param1: float = 0.0
    param2: float = 0.0
    param3: float = 0.0
    param4: float = 0.0
    lat_int: int = 0
    lon_int: int = 0
    alt_m: float = 0.0


@dataclass(frozen=True)
class MavlinkSerialPort:
    """Serial port candidate that can be used for a MAVLink connection."""

    device: str
    description: str
    hwid: str
    is_pixhawk_candidate: bool = False


def ensure_mavlink_runtime() -> None:
    """Raise a stable error if pymavlink is unavailable."""

    if mavutil is None:
        raise RuntimeError("pymavlink is not installed")


def list_serial_ports() -> list[MavlinkSerialPort]:
    """Return detected local serial ports, prioritizing likely autopilot USB ports."""

    try:
        from serial.tools import list_ports
    except ImportError as exc:  # pragma: no cover - dependency is provided by pymavlink
        raise RuntimeError("pyserial is not installed") from exc

    autopilot_keywords = (
        "pixhawk",
        "cube",
        "ardupilot",
        "px4",
        "legacy fmu",
        "fmuv",
        "fmu(",
        "holybro",
        "mavlink",
        "silicon labs",
        "cp210",
        "ch340",
        "usb serial",
        "usb-serial",
        "26ac",
    )
    ports: list[MavlinkSerialPort] = []
    for port in list_ports.comports():
        device = str(port.device or "").strip()
        if not device:
            continue

        description = str(port.description or "").strip()
        hwid = str(port.hwid or "").strip()
        searchable_text = f"{device} {description} {hwid}".lower()
        is_candidate = any(keyword in searchable_text for keyword in autopilot_keywords)
        ports.append(
            MavlinkSerialPort(
                device=device,
                description=description,
                hwid=hwid,
                is_pixhawk_candidate=is_candidate,
            )
        )

    return sorted(
        ports,
        key=lambda port: (
            not port.is_pixhawk_candidate,
            port.device.upper(),
        ),
    )


def create_mission_item(
    seq: int,
    command: int,
    lat: float,
    lon: float,
    alt_m: float,
    *,
    frame: int | None = None,
    current: int = 0,
    autocontinue: int = 1,
    param1: float = 0.0,
    param2: float = 0.0,
    param3: float = 0.0,
    param4: float = 0.0,
) -> MavlinkMissionItem:
    """Build an integer mission item for upload."""

    ensure_mavlink_runtime()
    resolved_frame = (
        frame
        if frame is not None
        else mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT
    )
    return MavlinkMissionItem(
        seq=seq,
        frame=resolved_frame,
        command=command,
        current=current,
        autocontinue=autocontinue,
        param1=param1,
        param2=param2,
        param3=param3,
        param4=param4,
        lat_int=int(round(lat * 10_000_000.0)),
        lon_int=int(round(lon * 10_000_000.0)),
        alt_m=float(alt_m),
    )


def normalize_udp_endpoint(endpoint: str) -> str:
    """Convert user-facing UDP endpoint text into a pymavlink udpin device string."""

    normalized_endpoint = endpoint.strip() or "udp:0.0.0.0:14550"
    if normalized_endpoint.startswith("udpin:"):
        return normalized_endpoint
    if normalized_endpoint.startswith("udp:"):
        return f"udpin:{normalized_endpoint.removeprefix('udp:')}"
    if normalized_endpoint.isdigit():
        return f"udpin:0.0.0.0:{normalized_endpoint}"
    return f"udpin:{normalized_endpoint}"


def create_udp_mavlink_connection(endpoint: str) -> Any:
    """Open a blocking pymavlink UDP input connection."""

    ensure_mavlink_runtime()

    return mavutil.mavlink_connection(
        normalize_udp_endpoint(endpoint),
        autoreconnect=True,
        source_system=255,
    )


def normalize_serial_endpoint(endpoint: str) -> str:
    """Return a user-facing serial endpoint, defaulting to COM3 on Windows."""

    return endpoint.strip() or "COM3"


def create_serial_mavlink_connection(endpoint: str, baudrate: int) -> Any:
    """Open a blocking pymavlink serial connection."""

    ensure_mavlink_runtime()

    return mavutil.mavlink_connection(
        normalize_serial_endpoint(endpoint),
        baud=max(1200, baudrate),
        autoreconnect=True,
        source_system=255,
    )


def create_mavlink_connection(
    link_type: str,
    endpoint: str,
    baudrate: int,
) -> tuple[Any, str]:
    """Open a MAVLink connection and return the connection plus display endpoint."""

    normalized_link_type = link_type.strip().lower()
    if normalized_link_type == "udp":
        normalized_endpoint = normalize_udp_endpoint(endpoint)
        return create_udp_mavlink_connection(endpoint), normalized_endpoint
    if normalized_link_type == "serial":
        normalized_endpoint = normalize_serial_endpoint(endpoint)
        return create_serial_mavlink_connection(endpoint, baudrate), normalized_endpoint
    raise ValueError("지원하지 않는 MAVLink 입력 방식입니다.")


def send_gcs_heartbeat(connection: Any) -> None:
    """Advertise this backend as an active GCS on the MAVLink network."""

    ensure_mavlink_runtime()
    connection.mav.heartbeat_send(
        mavutil.mavlink.MAV_TYPE_GCS,
        mavutil.mavlink.MAV_AUTOPILOT_INVALID,
        0,
        0,
        mavutil.mavlink.MAV_STATE_ACTIVE,
    )


def request_message(connection: Any, message_id: int) -> None:
    """Request a single MAVLink message from the current target."""

    send_command_long(
        connection,
        mavutil.mavlink.MAV_CMD_REQUEST_MESSAGE,
        param1=float(message_id),
    )


def request_live_data_streams(connection: Any) -> None:
    """Request the core telemetry streams needed by the live-control UI."""

    ensure_mavlink_runtime()
    target_system = int(connection.target_system)
    target_component = int(connection.target_component)
    stream_requests = (
        (mavutil.mavlink.MAV_DATA_STREAM_ALL, 4),
        (mavutil.mavlink.MAV_DATA_STREAM_EXTENDED_STATUS, 2),
        (mavutil.mavlink.MAV_DATA_STREAM_POSITION, 5),
        (mavutil.mavlink.MAV_DATA_STREAM_EXTRA1, 10),
        (mavutil.mavlink.MAV_DATA_STREAM_EXTRA2, 2),
    )
    for stream_id, rate_hz in stream_requests:
        connection.mav.request_data_stream_send(
            target_system,
            target_component,
            stream_id,
            rate_hz,
            1,
        )

    request_message(connection, mavutil.mavlink.MAVLINK_MSG_ID_AUTOPILOT_VERSION)


def close_mavlink_connection(connection: Any) -> None:
    """Close a pymavlink connection if the object exposes a close method."""

    close = getattr(connection, "close", None)
    if callable(close):
        close()


def is_vehicle_heartbeat(message: Any) -> bool:
    """Return whether a heartbeat is a flight-controller candidate."""

    ensure_mavlink_runtime()
    if message.get_type() != "HEARTBEAT":
        return False
    if int(message.get_srcComponent()) == 0:
        return False
    if int(getattr(message, "type", mavutil.mavlink.MAV_TYPE_GCS)) == mavutil.mavlink.MAV_TYPE_GCS:
        return False
    return int(getattr(message, "autopilot", mavutil.mavlink.MAV_AUTOPILOT_INVALID)) != (
        mavutil.mavlink.MAV_AUTOPILOT_INVALID
    )


def set_connection_target(
    connection: Any,
    system_id: int | None,
    component_id: int | None,
) -> None:
    """Persist the target ids used by outbound commands on the pymavlink connection."""

    if system_id is not None and system_id > 0:
        connection.target_system = int(system_id)
    if component_id is not None and component_id > 0:
        connection.target_component = int(component_id)


def send_command_long(
    connection: Any,
    command: int,
    *,
    confirmation: int = 0,
    param1: float = 0.0,
    param2: float = 0.0,
    param3: float = 0.0,
    param4: float = 0.0,
    param5: float = 0.0,
    param6: float = 0.0,
    param7: float = 0.0,
) -> None:
    """Send a MAV_CMD through COMMAND_LONG using the active target ids."""

    connection.mav.command_long_send(
        connection.target_system,
        connection.target_component,
        command,
        confirmation,
        param1,
        param2,
        param3,
        param4,
        param5,
        param6,
        param7,
    )


def send_arm_command(connection: Any, arm: bool) -> None:
    """Send an arm or disarm command."""

    if arm:
        connection.arducopter_arm()
        return

    connection.arducopter_disarm()


def send_takeoff_command(connection: Any, altitude_m: float) -> None:
    """Request a guided takeoff to the provided relative altitude."""

    send_command_long(
        connection,
        mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
        param7=max(0.0, float(altitude_m)),
    )


def send_guided_mode_command(connection: Any) -> str:
    """Switch into a guided/offboard-style mode suitable for takeoff commands."""

    preferred_modes = ("GUIDED", "OFFBOARD", "POSCTL")
    mode_mapping = connection.mode_mapping() or {}
    for mode_name in preferred_modes:
        if mode_name in mode_mapping:
            connection.set_mode(mode_name)
            return mode_name

    raise RuntimeError("이륙 전환에 필요한 GUIDED/OFFBOARD/POSCTL 모드를 찾지 못했습니다.")


def send_land_command(connection: Any) -> None:
    """Request landing at the current location."""

    send_command_long(
        connection,
        mavutil.mavlink.MAV_CMD_NAV_LAND,
    )


def send_auto_mode_command(connection: Any) -> None:
    """Switch the autopilot into AUTO mode."""

    connection.set_mode_auto()


def send_hold_mode_command(connection: Any) -> None:
    """Switch the autopilot into a hold/loiter mode."""

    connection.set_mode_loiter()


def send_rtl_mode_command(connection: Any) -> None:
    """Switch the autopilot into RTL mode."""

    connection.set_mode_rtl()


def send_mission_start_command(connection: Any) -> None:
    """Start the uploaded mission from the first item."""

    send_command_long(
        connection,
        mavutil.mavlink.MAV_CMD_MISSION_START,
        param1=0,
        param2=0,
    )


def clear_mission(connection: Any) -> None:
    """Clear the vehicle mission list."""

    connection.waypoint_clear_all_send()


def send_mission_count(connection: Any, count: int) -> None:
    """Announce the number of mission items that will be uploaded."""

    connection.waypoint_count_send(int(count))


def send_mission_item(connection: Any, mission_item: MavlinkMissionItem) -> None:
    """Send one MISSION_ITEM_INT payload."""

    connection.mav.mission_item_int_send(
        connection.target_system,
        connection.target_component,
        mission_item.seq,
        mission_item.frame,
        mission_item.command,
        mission_item.current,
        mission_item.autocontinue,
        mission_item.param1,
        mission_item.param2,
        mission_item.param3,
        mission_item.param4,
        mission_item.lat_int,
        mission_item.lon_int,
        mission_item.alt_m,
    )


def set_current_mission_item(connection: Any, seq: int) -> None:
    """Set the active mission item index on the vehicle."""

    connection.waypoint_set_current_send(int(seq))


def get_enum_name(enum_name: str, value: int, fallback_prefix: str) -> str:
    """Resolve a MAVLink enum entry to a readable constant name."""

    ensure_mavlink_runtime()
    enum_entries = mavutil.mavlink.enums.get(enum_name, {})
    enum_entry = enum_entries.get(int(value))
    if enum_entry is None:
        return f"{fallback_prefix}_{value}"
    return str(enum_entry.name)


def describe_command_ack(message: Any) -> str:
    """Build a readable log line for a COMMAND_ACK message."""

    command_name = get_enum_name("MAV_CMD", int(message.command), "MAV_CMD")
    result_name = get_enum_name("MAV_RESULT", int(message.result), "MAV_RESULT")
    return f"COMMAND_ACK {command_name}: {result_name}"


def command_ack_succeeded(message: Any) -> bool:
    """Return whether a COMMAND_ACK should be treated as a success."""

    result = int(getattr(message, "result", -1))
    return result in {
        mavutil.mavlink.MAV_RESULT_ACCEPTED,
        mavutil.mavlink.MAV_RESULT_IN_PROGRESS,
    }


def command_ack_is_expected_stream_request_rejection(message: Any) -> bool:
    """Return whether an ACK rejection is safe to suppress for stream setup."""

    command = int(getattr(message, "command", -1))
    result = int(getattr(message, "result", -1))
    return (
        command
        in {
            mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL,
            mavutil.mavlink.MAV_CMD_REQUEST_MESSAGE,
        }
        and result in {
            mavutil.mavlink.MAV_RESULT_UNSUPPORTED,
            mavutil.mavlink.MAV_RESULT_DENIED,
            mavutil.mavlink.MAV_RESULT_FAILED,
        }
    )


def describe_mission_ack(message: Any) -> str:
    """Build a readable log line for a MISSION_ACK message."""

    result_name = get_enum_name("MAV_MISSION_RESULT", int(message.type), "MAV_MISSION")
    return f"MISSION_ACK: {result_name}"


def mission_ack_succeeded(message: Any) -> bool:
    """Return whether a MISSION_ACK should be treated as a success."""

    return int(getattr(message, "type", -1)) == mavutil.mavlink.MAV_MISSION_ACCEPTED


def extract_statustext(message: Any) -> str:
    """Return a readable STATUSTEXT payload."""

    text = getattr(message, "text", "")
    if isinstance(text, bytes):
        return text.decode("utf-8", errors="ignore").strip("\x00 ").strip()
    return str(text).strip("\x00 ").strip()


def normalize_mode_key(mode_label: str | None) -> str | None:
    """Convert a displayed mode label into a stable event key."""

    if not mode_label:
        return None

    normalized = "".join(
        character.lower() if character.isalnum() else "_"
        for character in str(mode_label).strip()
    )
    normalized = normalized.strip("_")
    return normalized or None


def message_matches_filters(
    message: Any,
    system_id: int,
    component_id: int,
) -> bool:
    """Return whether a MAVLink message should be accepted for this live stream."""

    source_system = int(message.get_srcSystem())
    source_component = int(message.get_srcComponent())
    if system_id > 0 and source_system != system_id:
        return False
    if component_id > 0 and source_component != component_id:
        return False
    return True


def update_snapshot_from_message(
    snapshot: MavlinkTelemetrySnapshot,
    message: Any,
) -> bool:
    """Apply supported MAVLink messages and return whether the snapshot changed."""

    message_type = message.get_type()
    if message_type == "GLOBAL_POSITION_INT":
        snapshot.lat = float(message.lat) / 10_000_000.0
        snapshot.lon = float(message.lon) / 10_000_000.0
        snapshot.alt_m = float(message.relative_alt) / 1000.0
        update_speed(
            snapshot,
            hypot(
                float(message.vx) / 100.0,
                float(message.vy) / 100.0,
            ),
        )
        return True

    if message_type == "VFR_HUD":
        snapshot.alt_m = float(message.alt)
        update_speed(snapshot, float(message.groundspeed))
        return True

    if message_type == "ATTITUDE":
        snapshot.roll_deg = degrees(float(message.roll))
        snapshot.pitch_deg = degrees(float(message.pitch))
        snapshot.yaw_deg = (degrees(float(message.yaw)) + 360.0) % 360.0
        return True

    return False


def update_vehicle_status_from_message(
    snapshot: MavlinkVehicleStatusSnapshot,
    message: Any,
) -> bool:
    """Apply supported MAVLink system-status messages and return whether status changed."""

    previous_state = snapshot.__dict__.copy()
    message_type = message.get_type()

    if message_type == "HEARTBEAT":
        snapshot.autopilot_label = get_enum_name(
            "MAV_AUTOPILOT",
            int(message.autopilot),
            "MAV_AUTOPILOT",
        )
        snapshot.vehicle_type_label = get_enum_name(
            "MAV_TYPE",
            int(message.type),
            "MAV_TYPE",
        )
        snapshot.system_status_label = get_enum_name(
            "MAV_STATE",
            int(message.system_status),
            "MAV_STATE",
        )
        mode_label = str(mavutil.mode_string_v10(message)).strip()
        snapshot.mode_label = mode_label
        snapshot.mode_key = normalize_mode_key(mode_label)
        snapshot.armed = bool(
            int(message.base_mode) & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED,
        )

    elif message_type == "SYS_STATUS":
        battery_remaining = int(getattr(message, "battery_remaining", -1))
        if battery_remaining >= 0:
            snapshot.battery_remaining_pct = float(battery_remaining)

        voltage_battery_mv = int(getattr(message, "voltage_battery", -1))
        if voltage_battery_mv > 0:
            snapshot.battery_voltage_v = voltage_battery_mv / 1000.0

        current_battery_ca = int(getattr(message, "current_battery", -1))
        if current_battery_ca >= 0:
            snapshot.battery_current_a = current_battery_ca / 100.0

    elif message_type == "BATTERY_STATUS":
        battery_remaining = int(getattr(message, "battery_remaining", -1))
        if battery_remaining >= 0:
            snapshot.battery_remaining_pct = float(battery_remaining)

        voltages = list(getattr(message, "voltages", []) or [])
        valid_cell_voltages_mv = [
            int(voltage_mv)
            for voltage_mv in voltages
            if int(voltage_mv) > 0 and int(voltage_mv) < 65535
        ]
        if valid_cell_voltages_mv:
            snapshot.battery_voltage_v = sum(valid_cell_voltages_mv) / 1000.0

        current_battery_ca = int(getattr(message, "current_battery", -1))
        if current_battery_ca >= 0:
            snapshot.battery_current_a = current_battery_ca / 100.0

    elif message_type == "GPS_RAW_INT":
        snapshot.gps_fix_label = get_enum_name(
            "GPS_FIX_TYPE",
            int(message.fix_type),
            "GPS_FIX_TYPE",
        )
        satellites_visible = int(getattr(message, "satellites_visible", 255))
        if 0 <= satellites_visible < 255:
            snapshot.satellites_visible = satellites_visible

    elif message_type == "AUTOPILOT_VERSION":
        flight_sw_version = int(getattr(message, "flight_sw_version", 0))
        if flight_sw_version > 0:
            major = (flight_sw_version >> 24) & 0xFF
            minor = (flight_sw_version >> 16) & 0xFF
            patch = (flight_sw_version >> 8) & 0xFF
            snapshot.firmware_version_label = f"{major}.{minor}.{patch}"

        capabilities = int(getattr(message, "capabilities", 0))
        if capabilities > 0:
            snapshot.autopilot_capabilities = capabilities

    return snapshot.__dict__ != previous_state


def update_speed(
    snapshot: MavlinkTelemetrySnapshot,
    speed_mps: float,
) -> None:
    """Update speed and derive a coarse acceleration value for the existing UI schema."""

    now_s = monotonic()
    if snapshot.last_speed_time_s is not None:
        elapsed_s = max(0.001, now_s - snapshot.last_speed_time_s)
        snapshot.accel_mps2 = (speed_mps - snapshot.last_speed_mps) / elapsed_s

    snapshot.speed_mps = max(0.0, speed_mps)
    snapshot.last_speed_mps = snapshot.speed_mps
    snapshot.last_speed_time_s = now_s


def has_position(snapshot: MavlinkTelemetrySnapshot) -> bool:
    """Return whether the snapshot has enough position data for the frontend."""

    return snapshot.lat is not None and snapshot.lon is not None and snapshot.alt_m is not None
