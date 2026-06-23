import { resetHeaderLiveStatus, updateHeaderLiveStatus } from "./simulation_status.js?v=4";

let isLivePanelActive = () => false;
let isLiveConnected = () => false;
let getScenarioDisplayName = (scenarioKey) => scenarioKey ?? "";
let livePanelInitialized = false;
let latestLiveStatus = createDefaultLiveStatus();


function createDefaultLiveStatus() {
  return {
    heartbeatSeen: false,
    connectionPhase: "idle",
    heartbeatCount: 0,
    targetSystemId: null,
    targetComponentId: null,
    modeLabel: "",
    armed: null,
    autopilotLabel: "",
    vehicleTypeLabel: "",
    systemStatusLabel: "",
    batteryRemainingPct: null,
    batteryVoltageV: null,
    batteryCurrentA: null,
    gpsFixLabel: "",
    satellitesVisible: null,
    firmwareVersionLabel: "",
    autopilotCapabilities: null,
  };
}


function normalizeLiveStatus(detail = {}) {
  return {
    heartbeatSeen: Boolean(detail.heartbeat_seen),
    connectionPhase: typeof detail.connection_phase === "string" ? detail.connection_phase.trim() : "idle",
    heartbeatCount: Number.isFinite(detail.heartbeat_count) ? Number(detail.heartbeat_count) : 0,
    targetSystemId: Number.isFinite(detail.target_system_id) ? Number(detail.target_system_id) : null,
    targetComponentId: Number.isFinite(detail.target_component_id) ? Number(detail.target_component_id) : null,
    modeLabel: typeof detail.mode_label === "string" ? detail.mode_label.trim() : "",
    armed: typeof detail.armed === "boolean" ? detail.armed : null,
    autopilotLabel: typeof detail.autopilot_label === "string" ? detail.autopilot_label.trim() : "",
    vehicleTypeLabel: typeof detail.vehicle_type_label === "string" ? detail.vehicle_type_label.trim() : "",
    systemStatusLabel: typeof detail.system_status_label === "string" ? detail.system_status_label.trim() : "",
    batteryRemainingPct: Number.isFinite(detail.battery_remaining_pct) ? Number(detail.battery_remaining_pct) : null,
    batteryVoltageV: Number.isFinite(detail.battery_voltage_v) ? Number(detail.battery_voltage_v) : null,
    batteryCurrentA: Number.isFinite(detail.battery_current_a) ? Number(detail.battery_current_a) : null,
    gpsFixLabel: typeof detail.gps_fix_label === "string" ? detail.gps_fix_label.trim() : "",
    satellitesVisible: Number.isFinite(detail.satellites_visible) ? Number(detail.satellites_visible) : null,
    firmwareVersionLabel: typeof detail.firmware_version_label === "string" ? detail.firmware_version_label.trim() : "",
    autopilotCapabilities: Number.isFinite(detail.autopilot_capabilities) ? Number(detail.autopilot_capabilities) : null,
  };
}


function setLiveSummaryValue(elementId, value) {
  const element = document.getElementById(elementId);
  if (element) {
    element.textContent = value;
  }
}


function formatEnumLabel(value, prefix) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  const normalized = value.trim();
  if (!normalized.startsWith(prefix)) {
    return normalized;
  }

  return normalized.slice(prefix.length);
}


function isLiveReady() {
  return isLiveConnected() && latestLiveStatus.heartbeatSeen;
}


function formatTargetLabel() {
  if (!latestLiveStatus.heartbeatSeen) {
    const heartbeatCount = Math.max(0, Math.min(2, latestLiveStatus.heartbeatCount));
    return heartbeatCount > 0 ? `HEARTBEAT ${heartbeatCount}/2` : "HEARTBEAT 대기";
  }

  const systemLabel = latestLiveStatus.targetSystemId ?? "-";
  const componentLabel = latestLiveStatus.targetComponentId ?? "-";
  return `SYS ${systemLabel} / COMP ${componentLabel}`;
}


function formatArmStatusLabel() {
  if (!latestLiveStatus.heartbeatSeen) {
    return "대기";
  }

  if (latestLiveStatus.armed === true) {
    return "ARMED";
  }

  if (latestLiveStatus.armed === false) {
    return "DISARMED";
  }

  return "-";
}


function formatGpsStatusLabel() {
  if (!latestLiveStatus.heartbeatSeen) {
    return "대기";
  }

  const gpsFixLabel = formatEnumLabel(latestLiveStatus.gpsFixLabel, "GPS_FIX_TYPE_") || "GPS 미수신";
  if (latestLiveStatus.satellitesVisible === null) {
    return gpsFixLabel;
  }

  return `${gpsFixLabel} / ${latestLiveStatus.satellitesVisible} SAT`;
}


function formatBatteryStatusLabel() {
  if (latestLiveStatus.batteryRemainingPct !== null) {
    const voltageSuffix = latestLiveStatus.batteryVoltageV !== null
      ? ` / ${latestLiveStatus.batteryVoltageV.toFixed(1)}V`
      : "";
    return `${latestLiveStatus.batteryRemainingPct.toFixed(0)}%${voltageSuffix}`;
  }

  if (!latestLiveStatus.heartbeatSeen) {
    return "대기";
  }

  return "-";
}


function formatFlightLinkStatusLabel() {
  if (isLiveReady()) {
    return `MAVLink 연결됨 · ${formatTargetLabel()}`;
  }

  if (isLiveConnected()) {
    if (latestLiveStatus.connectionPhase === "heartbeat_lost") {
      return "MAVLink heartbeat 끊김";
    }

    return `Pixhawk 탐색 중 · ${formatTargetLabel()}`;
  }

  return "브리지 미연결";
}


function renderLiveVehicleSummary() {
  const autopilotLabel = formatEnumLabel(latestLiveStatus.autopilotLabel, "MAV_AUTOPILOT_");
  const vehicleTypeLabel = formatEnumLabel(latestLiveStatus.vehicleTypeLabel, "MAV_TYPE_");
  const systemStatusLabel = formatEnumLabel(latestLiveStatus.systemStatusLabel, "MAV_STATE_");

  setLiveSummaryValue("live-autopilot-value", autopilotLabel || "Pixhawk");
  setLiveSummaryValue("live-airframe-value", vehicleTypeLabel || "자작 드론");
  setLiveSummaryValue(
    "live-link-value",
    systemStatusLabel ? `MAVLink Bridge / ${systemStatusLabel}` : "MAVLink Bridge",
  );
  setLiveSummaryValue("live-target-value", formatTargetLabel());
  setLiveSummaryValue("live-firmware-value", latestLiveStatus.firmwareVersionLabel || "대기");
  setLiveSummaryValue("live-arm-status-value", formatArmStatusLabel());
  setLiveSummaryValue("live-gps-status-value", formatGpsStatusLabel());
  setLiveSummaryValue("live-battery-value", formatBatteryStatusLabel());
}


export function initializeLivePanel() {
  if (livePanelInitialized) {
    return;
  }

  livePanelInitialized = true;
  window.addEventListener("dss:live-status", (event) => {
    latestLiveStatus = normalizeLiveStatus(event.detail);
    updateHeaderLiveStatus({
      connected: isLiveConnected(),
      heartbeatSeen: latestLiveStatus.heartbeatSeen,
      modeLabel: latestLiveStatus.modeLabel,
      armed: latestLiveStatus.armed,
      gpsFixLabel: latestLiveStatus.gpsFixLabel,
      satellitesVisible: latestLiveStatus.satellitesVisible,
      batteryPct: latestLiveStatus.batteryRemainingPct,
    });
    updateLivePanelStatus();
  });
}


export function resetLiveVehicleStatus() {
  latestLiveStatus = createDefaultLiveStatus();
  resetHeaderLiveStatus();
  window.dispatchEvent(new CustomEvent("dss:live-status-reset"));
  updateLivePanelStatus();
}


export function configureLivePanel(options = {}) {
  isLivePanelActive = typeof options.isLivePanelActive === "function"
    ? options.isLivePanelActive
    : isLivePanelActive;
  isLiveConnected = typeof options.isLiveConnected === "function"
    ? options.isLiveConnected
    : isLiveConnected;
  getScenarioDisplayName = typeof options.getScenarioDisplayName === "function"
    ? options.getScenarioDisplayName
    : getScenarioDisplayName;
}


function parseLiveNumberInput(elementId, fallbackValue) {
  const element = document.getElementById(elementId);
  const value = element instanceof HTMLInputElement || element instanceof HTMLSelectElement
    ? Number.parseInt(element.value, 10)
    : NaN;
  return Number.isFinite(value) ? value : fallbackValue;
}


export function getLiveConnectionRequest() {
  const linkTypeSelect = document.getElementById("live-link-type-select");
  const endpointInput = document.getElementById("live-endpoint-input");
  const linkType = linkTypeSelect instanceof HTMLSelectElement ? linkTypeSelect.value : "udp";
  const endpoint = endpointInput instanceof HTMLInputElement
    ? endpointInput.value.trim()
    : "udp:0.0.0.0:14550";
  const fallbackEndpoint = linkType === "serial" ? "COM3" : "udp:0.0.0.0:14550";

  return {
    linkType,
    endpoint,
    fallbackEndpoint,
    displayLinkType: linkType === "serial" ? "Serial" : "UDP",
    baudrate: parseLiveNumberInput("live-baudrate-select", 115200),
    systemId: parseLiveNumberInput("live-system-id-input", 0),
    componentId: parseLiveNumberInput("live-component-id-input", 0),
  };
}


export function updateLiveConnectionControls() {
  const connectButton = document.getElementById("live-connect-button");
  if (connectButton instanceof HTMLButtonElement) {
    connectButton.textContent = isLiveConnected() ? "브리지 해제" : "브리지 연결";
  }
}


function updateLiveActionButtons() {
  const liveScenarioSelect = document.getElementById("live-scenario-select");
  const hasScenario = liveScenarioSelect instanceof HTMLSelectElement && Boolean(liveScenarioSelect.value);
  const commandButtonIds = [
    "live-arm-button",
    "live-disarm-button",
    "live-takeoff-button",
    "live-land-button",
    "live-rth-button",
    "live-hold-button",
    "live-start-button",
  ];

  commandButtonIds.forEach((buttonId) => {
    const button = document.getElementById(buttonId);
    if (button instanceof HTMLButtonElement) {
      button.disabled = !isLiveReady();
    }
  });

  const uploadButton = document.getElementById("live-upload-button");
  if (uploadButton instanceof HTMLButtonElement) {
    uploadButton.disabled = !isLiveReady() || !hasScenario;
  }
}


export function updateFlightPanelStatus() {
  const liveScenarioSelect = document.getElementById("live-scenario-select");
  const scenarioName = liveScenarioSelect instanceof HTMLSelectElement && liveScenarioSelect.value
    ? getScenarioDisplayName(liveScenarioSelect.value)
    : "미선택";

  const linkStatus = document.getElementById("flight-link-status");
  if (linkStatus) {
    linkStatus.textContent = formatFlightLinkStatusLabel();
  }

  const scenarioStatus = document.getElementById("flight-scenario-status");
  if (scenarioStatus) {
    scenarioStatus.textContent = scenarioName;
  }

  updateLiveConnectionControls();
}


export function updateLiveEndpointPlaceholder() {
  const linkTypeSelect = document.getElementById("live-link-type-select");
  const endpointInput = document.getElementById("live-endpoint-input");
  if (!(linkTypeSelect instanceof HTMLSelectElement) || !(endpointInput instanceof HTMLInputElement)) {
    return;
  }

  endpointInput.placeholder = linkTypeSelect.value === "serial"
    ? "COM3"
    : "udp:0.0.0.0:14550";
  updateFlightPanelStatus();
}


export function updateLivePanelStatus() {
  updateHeaderLiveStatus({
    connected: isLiveConnected(),
    heartbeatSeen: latestLiveStatus.heartbeatSeen,
    modeLabel: latestLiveStatus.modeLabel,
    armed: latestLiveStatus.armed,
    gpsFixLabel: latestLiveStatus.gpsFixLabel,
    satellitesVisible: latestLiveStatus.satellitesVisible,
    batteryPct: latestLiveStatus.batteryRemainingPct,
  });

  const connectionStatus = document.getElementById("live-connection-status");
  if (connectionStatus) {
    connectionStatus.textContent = isLivePanelActive()
      ? isLiveReady()
        ? `Pixhawk MAVLink 브리지 연결됨 · ${formatTargetLabel()}`
        : isLiveConnected()
          ? latestLiveStatus.connectionPhase === "heartbeat_lost"
            ? "Pixhawk MAVLink heartbeat 끊김 · 재수신 대기 중"
            : `Pixhawk MAVLink 탐색 중 · ${formatTargetLabel()}`
          : "Pixhawk MAVLink 브리지 연결 대기 중"
      : "실기체 모드를 선택하면 Pixhawk 브리지 연결 UI가 활성화됩니다.";
  }

  renderLiveVehicleSummary();
  updateFlightPanelStatus();
  updateLiveConnectionControls();
  updateLiveActionButtons();
}
