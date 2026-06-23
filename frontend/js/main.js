import { loadDroneSpecs, loadMavlinkSerialPorts, loadScenarios, requestScenarioGeneration } from "./api_client.js?v=3";
import { initializeCameraView } from "./camera_view.js";
import { initializeCustomDroneBuilder } from "./drone_builder.js";
import { downloadFlightLog, initializeFlightLog } from "./flight_log.js?v=7";
import {
  buildTelemetryStreamConfigsWithLive,
  DRONE_SLOT_CONFIGS,
  getActiveStreamConfigs,
  getDownloadScenarioKey,
  getFormationSpeedCaps,
  getLiveStreamConfig,
  getPrimaryDroneSelection,
  getScenarioDisplayName,
  getScenarioSummaryLabel,
  getSelectedDroneKeys,
  getSelectedScenarioKeys,
  isCustomScenarioKey,
  LIVE_STREAM_ID,
  LIVE_STREAM_LABEL,
  populateDroneSelect,
  populateScenarioSelect,
  SCENARIO_SELECT_IDS,
  setDroneSpecs,
  updateScenarioDefinitionMap,
} from "./flight_selection.js?v=2";
import {
  configureLivePanel,
  getLiveConnectionRequest,
  initializeLivePanel,
  resetLiveVehicleStatus,
  updateFlightPanelStatus,
  updateLiveEndpointPlaceholder,
  updateLivePanelStatus,
} from "./live_panel.js?v=4";
import { appendLog, initializeLog, syncLogStreams } from "./log.js?v=5";
import { initializeMap, loadReplayRoutes, loadScenarioRoutes, syncMapStreams } from "./map.js?v=7";
import { initializeReplayPanel } from "./replay_panel.js?v=6";
import { initializeScenarioBuilder } from "./scenario_builder.js?v=6";
import { initializeSimulationAnalysis, syncSimulationAnalysisStreams } from "./simulation_analysis.js?v=2";
import {
  configureSimulationStatus,
  setAppMode,
  getCurrentPanelTab,
  initializeProgressTracking,
  isLivePanelActive,
  resetHeaderSimulationMode,
  setPanelTab,
  setProgress,
  setStatus,
  setStreamStatus,
  updateReplayPlaybackState,
  updateHeaderSimulationMode,
  updateSimulationButtons,
} from "./simulation_status.js?v=4";
import { createLiveTelemetrySocket, createTelemetrySocket, sendLiveCommand, sendTelemetryControl } from "./socket.js?v=2";
import { initializeTelemetry, syncTelemetryStreams } from "./telemetry.js?v=5";
import { initializeThemeSelector } from "./theme.js";

let activeSockets = new Map();
let suppressedSocketClosures = new Set();
let liveTelemetrySocket = null;
let generatedScenario = null;
let simulationPaused = false;
let simulationBatchState = null;
let simulationBatchRestartTimerId = null;
let replaySelectionState = {
  logId: "",
  replayDetail: null,
  scenarioKey: "",
  streamConfigs: [],
};

const MAX_SIMULATION_REPEAT_COUNT = 999;
const ALERT_AUTO_DISMISS_MS = 5600;
let liveSocketCloseExpected = false;
let alertSequence = 0;

function createFormationSessionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `formation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clearSimulationBatchRestartTimer() {
  if (simulationBatchRestartTimerId !== null) {
    window.clearTimeout(simulationBatchRestartTimerId);
    simulationBatchRestartTimerId = null;
  }
}

function emitUiAlert(message, { title = "경고", level = "error" } = {}) {
  window.dispatchEvent(new CustomEvent("dss:alert", {
    detail: {
      id: `alert-${Date.now()}-${alertSequence += 1}`,
      title,
      message,
      level,
    },
  }));
}

function reportLiveIssue(message, { title = "실기체 제어 실패", level = "error", writeLog = true } = {}) {
  if (writeLog) {
    appendLog(message);
  }
  emitUiAlert(message, { title, level });
}

function normalizeSimulationRepeatCount(value) {
  const parsedValue = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsedValue)) {
    return 1;
  }

  return Math.max(1, Math.min(MAX_SIMULATION_REPEAT_COUNT, parsedValue));
}

function getSimulationRepeatCount() {
  const repeatCountInput = document.getElementById("simulation-repeat-count-input");
  if (!(repeatCountInput instanceof HTMLInputElement)) {
    return 1;
  }

  const repeatCount = normalizeSimulationRepeatCount(repeatCountInput.value);
  if (repeatCountInput.value !== String(repeatCount)) {
    repeatCountInput.value = String(repeatCount);
  }
  return repeatCount;
}

function renderSimulationBatchStatus() {
  const statusElement = document.getElementById("simulation-repeat-status");
  if (!statusElement) {
    return;
  }

  const totalRuns = simulationBatchState?.totalRuns ?? getSimulationRepeatCount();
  const completedRuns = simulationBatchState?.completedRuns ?? 0;
  const currentRunNumber = Math.min(Math.max(completedRuns + 1, 1), Math.max(totalRuns, 1));

  if (simulationPaused && simulationBatchState) {
    statusElement.textContent = `일시 정지 · ${currentRunNumber} / ${totalRuns}회차`;
    return;
  }

  if (activeSockets.size > 0 && simulationBatchState) {
    statusElement.textContent = `진행 중 · ${currentRunNumber} / ${totalRuns}회차`;
    return;
  }

  if (simulationBatchState && completedRuns > 0 && completedRuns < totalRuns) {
    statusElement.textContent = `다음 실행 대기 · ${currentRunNumber} / ${totalRuns}회차`;
    return;
  }

  statusElement.textContent = `준비됨 · 1 / ${totalRuns}회차`;
}

function initializeSimulationBatch(totalRuns) {
  simulationBatchState = {
    totalRuns,
    completedRuns: 0,
  };
  clearSimulationBatchRestartTimer();
  renderSimulationBatchStatus();
}

function cancelSimulationBatch() {
  simulationBatchState = null;
  clearSimulationBatchRestartTimer();
  renderSimulationBatchStatus();
}

function scheduleNextSimulationBatchRun() {
  if (!simulationBatchState || simulationBatchState.completedRuns >= simulationBatchState.totalRuns) {
    return;
  }

  const nextRunNumber = simulationBatchState.completedRuns + 1;
  clearSimulationBatchRestartTimer();
  simulationBatchRestartTimerId = window.setTimeout(() => {
    simulationBatchRestartTimerId = null;
    if (!simulationBatchState || activeSockets.size > 0 || simulationPaused || liveTelemetrySocket instanceof WebSocket) {
      return;
    }

    startTelemetrySession({ continueBatch: true });
  }, 600);

  appendLog(`시나리오 반복 ${simulationBatchState.completedRuns}/${simulationBatchState.totalRuns}회 완료, ${nextRunNumber}회차 시작 준비`);
  renderSimulationBatchStatus();
}

async function syncGroundControlPanelViews(enableLive = liveTelemetrySocket instanceof WebSocket) {
  const telemetryStreamConfig = getLiveStreamConfig({ enabled: enableLive });
  const routeStreamConfig = getLiveStreamConfig({
    enabled: Boolean(enableLive || telemetryStreamConfig.scenarioKey),
  });

  syncTelemetryStreams([telemetryStreamConfig]);
  syncLogStreams([telemetryStreamConfig]);
  syncMapStreams(routeStreamConfig.enabled ? [routeStreamConfig] : []);
  await syncSimulationAnalysisStreams([telemetryStreamConfig]);

  try {
    await loadScenarioRoutes(routeStreamConfig.enabled ? [routeStreamConfig] : []);
  } catch (error) {
    appendLog("실기체 비행 계획 경로를 불러오지 못했습니다.");
    console.error(error);
  }
}

function syncLiveTelemetryViews() {
  void syncGroundControlPanelViews(true);
}

async function applyReplaySelectionState() {
  const replayStreamConfigs = Array.isArray(replaySelectionState.streamConfigs)
    ? replaySelectionState.streamConfigs
    : [];
  const activeReplayStreams = replayStreamConfigs.filter((streamConfig) => streamConfig.enabled);

  syncTelemetryStreams(replayStreamConfigs);
  syncLogStreams(replayStreamConfigs);

  try {
    loadReplayRoutes(replaySelectionState.replayDetail, activeReplayStreams);
  } catch (error) {
    appendLog("리플레이 경로를 불러오지 못했습니다.");
    console.error(error);
  }
}

async function restoreCurrentPanelViews() {
  if (getCurrentPanelTab() === "replay") {
    return;
  }

  if (isLivePanelActive()) {
    await syncGroundControlPanelViews();
    return;
  }

  await refreshScenarioRoutes();
}

function clearGeneratedScenarioView() {
  const durationElement = document.getElementById("stats-flight-time");
  if (durationElement) {
    durationElement.textContent = "0s";
  }
}

async function reloadDroneSelects() {
  const droneSpecs = await loadDroneSpecs();
  setDroneSpecs(droneSpecs);

  DRONE_SLOT_CONFIGS.forEach((slotConfig) => {
    const droneSelect = document.getElementById(slotConfig.droneSelectId);
    if (!(droneSelect instanceof HTMLSelectElement)) {
      return;
    }

    populateDroneSelect(droneSelect, droneSpecs, true);
  });

  updateLivePanelStatus();
}

function setActivePanelTab(tabName) {
  setPanelTab(tabName);
  setStreamStatus("", "");
  if (isLivePanelActive()) {
    void syncGroundControlPanelViews();
  }
  updateLivePanelStatus();
  updateSimulationButtons();
}

async function reloadScenarioSelects(selectedScenarioKey = "") {
  const scenarios = await loadScenarios();
  updateScenarioDefinitionMap(scenarios);

  SCENARIO_SELECT_IDS.forEach((selectId, index) => {
    const scenarioSelect = document.getElementById(selectId);
    if (!(scenarioSelect instanceof HTMLSelectElement)) {
      return;
    }

    const nextSelectedValue = index === 0 && selectedScenarioKey
      ? selectedScenarioKey
      : scenarioSelect.value;
    populateScenarioSelect(scenarioSelect, scenarios, nextSelectedValue);
  });

  const liveScenarioSelect = document.getElementById("live-scenario-select");
  if (liveScenarioSelect instanceof HTMLSelectElement) {
    populateScenarioSelect(liveScenarioSelect, scenarios, liveScenarioSelect.value || selectedScenarioKey);
  }

  updateLivePanelStatus();
}

function closeActiveSockets() {
  if (activeSockets.size === 0) {
    return;
  }

  for (const socket of activeSockets.values()) {
    suppressedSocketClosures.add(socket);
    socket.close();
  }
  activeSockets.clear();
  simulationPaused = false;
  updateSimulationButtons();
}

function updateGeneratedScenarioView(scenario) {
  const durationElement = document.getElementById("stats-flight-time");
  if (durationElement) {
    durationElement.textContent = `${scenario.estimated_duration_seconds.toFixed(1)}s`;
  }
}

async function refreshGeneratedScenario() {
  const activeStreamConfigs = getActiveStreamConfigs();
  const selectedScenarioKeys = getSelectedScenarioKeys(activeStreamConfigs);

  if (activeStreamConfigs.length === 0 || selectedScenarioKeys.length === 0) {
    generatedScenario = null;
    clearGeneratedScenarioView();
    return;
  }

  if (selectedScenarioKeys.length > 1) {
    generatedScenario = null;
    const durationElement = document.getElementById("stats-flight-time");
    if (durationElement) {
      durationElement.textContent = "개별";
    }
    return;
  }

  try {
    generatedScenario = await requestScenarioGeneration({
      scenario_key: selectedScenarioKeys[0],
      drones: getSelectedDroneKeys(activeStreamConfigs),
    });
    updateGeneratedScenarioView(generatedScenario);
  } catch (error) {
    generatedScenario = null;
    clearGeneratedScenarioView();
    appendLog("비행 계획 정보를 불러오지 못했습니다.");
    console.error(error);
  }
}

async function refreshScenarioRoutes() {
  const telemetryStreamConfigs = buildTelemetryStreamConfigsWithLive({
    includeEmptySlots: true,
    enableLive: liveTelemetrySocket instanceof WebSocket,
  });
  const activeStreamConfigs = telemetryStreamConfigs.filter((streamConfig) => streamConfig.enabled);
  syncTelemetryStreams(telemetryStreamConfigs);
  syncLogStreams(telemetryStreamConfigs);
  syncMapStreams(activeStreamConfigs);
  await syncSimulationAnalysisStreams(activeStreamConfigs);

  try {
    await loadScenarioRoutes(activeStreamConfigs);
    await syncSimulationAnalysisStreams(activeStreamConfigs);
    if (generatedScenario) {
      updateGeneratedScenarioView(generatedScenario);
    }
  } catch (error) {
    appendLog("비행 계획 경로를 불러오지 못했습니다.");
    console.error(error);
  }
}

function finalizeStreamingIfIdle({ naturalCompletion = true } = {}) {
  if (activeSockets.size > 0) {
    return;
  }

  simulationPaused = false;

  if (naturalCompletion && simulationBatchState) {
    simulationBatchState.completedRuns += 1;
    if (simulationBatchState.completedRuns < simulationBatchState.totalRuns) {
      setStatus("● READY", "--yellow");
      setStreamStatus("SIMULATION", "--yellow");
      setProgress(0);
      updateSimulationButtons();
      scheduleNextSimulationBatchRun();
      renderSimulationBatchStatus();
      return;
    }

    appendLog(`시나리오 반복 ${simulationBatchState.totalRuns}회 실행 완료`);
    cancelSimulationBatch();
  }

  setStatus("● READY", "--yellow");
  setStreamStatus("SIMULATION", "--yellow");
  updateSimulationButtons();
}

function broadcastTelemetryControl(action) {
  let sentSocketCount = 0;

  for (const socket of activeSockets.values()) {
    if (sendTelemetryControl(socket, action)) {
      sentSocketCount += 1;
    }
  }

  return sentSocketCount;
}

function closeLiveTelemetrySocket() {
  if (!(liveTelemetrySocket instanceof WebSocket)) {
    liveTelemetrySocket = null;
    liveSocketCloseExpected = false;
    resetLiveVehicleStatus();
    updateLivePanelStatus();
    return;
  }

  const socket = liveTelemetrySocket;
  liveTelemetrySocket = null;
  liveSocketCloseExpected = true;
  socket.close();
  resetLiveVehicleStatus();
  setStatus("● READY", "--yellow");
  setStreamStatus("CONNECT", "--yellow");
  void syncGroundControlPanelViews(false);
  updateLivePanelStatus();
}

function getSelectedLiveScenarioKey() {
  const liveScenarioSelect = document.getElementById("live-scenario-select");
  if (!(liveScenarioSelect instanceof HTMLSelectElement)) {
    return "";
  }

  return liveScenarioSelect.value || "";
}

function getPreferredSerialPort(serialPorts) {
  if (!Array.isArray(serialPorts) || serialPorts.length === 0) {
    return null;
  }

  return serialPorts.find((serialPort) => serialPort?.is_pixhawk_candidate) ?? serialPorts[0];
}

function shouldAutoApplySerialPort(endpointValue) {
  const normalizedValue = String(endpointValue ?? "").trim().toLowerCase();
  return (
    !normalizedValue
    || normalizedValue === "com3"
    || normalizedValue.startsWith("udp:")
    || normalizedValue.startsWith("udpin:")
  );
}

async function refreshLiveSerialPorts({ autoApply = false } = {}) {
  const linkTypeSelect = document.getElementById("live-link-type-select");
  const endpointInput = document.getElementById("live-endpoint-input");
  const serialPortOptions = document.getElementById("live-serial-port-options");
  if (!(endpointInput instanceof HTMLInputElement)) {
    return [];
  }

  const serialPorts = await loadMavlinkSerialPorts();
  if (serialPortOptions instanceof HTMLDataListElement) {
    serialPortOptions.replaceChildren();
    serialPorts.forEach((serialPort) => {
      if (!serialPort?.device) {
        return;
      }

      const option = document.createElement("option");
      option.value = serialPort.device;
      const description = typeof serialPort.description === "string" ? serialPort.description.trim() : "";
      option.label = description ? `${serialPort.device} · ${description}` : serialPort.device;
      serialPortOptions.append(option);
    });
  }

  const shouldUseSerialPort = (
    autoApply
    && linkTypeSelect instanceof HTMLSelectElement
    && linkTypeSelect.value === "serial"
    && shouldAutoApplySerialPort(endpointInput.value)
  );
  if (shouldUseSerialPort) {
    const preferredSerialPort = getPreferredSerialPort(serialPorts);
    if (preferredSerialPort?.device) {
      endpointInput.value = preferredSerialPort.device;
      updateFlightPanelStatus();
      appendLog(`MAVLink Serial 포트 자동 선택: ${preferredSerialPort.device}`);
    }
  }

  return serialPorts;
}

function dispatchLiveCommand(action, { requireScenario = false } = {}) {
  if (!(liveTelemetrySocket instanceof WebSocket)) {
    reportLiveIssue("실기체 브리지가 연결되지 않았습니다.");
    return false;
  }

  const scenarioKey = getSelectedLiveScenarioKey();
  if (requireScenario && !scenarioKey) {
    reportLiveIssue("비행 계획을 먼저 선택하세요.", { title: "임무 업로드 실패" });
    return false;
  }

  const sent = sendLiveCommand(liveTelemetrySocket, action, scenarioKey ? { scenario_key: scenarioKey } : {});
  if (!sent) {
    reportLiveIssue("실기체 명령을 전송하지 못했습니다.");
    return false;
  }

  return true;
}

async function connectLiveTelemetry() {
  if (liveTelemetrySocket instanceof WebSocket) {
    closeLiveTelemetrySocket();
    appendLog("실기체 텔레메트리 연결 해제");
    return;
  }

  if (activeSockets.size > 0) {
    reportLiveIssue("시뮬레이션 중에는 실기체 브리지를 연결할 수 없습니다.", {
      title: "브리지 연결 실패",
    });
    return;
  }

  const linkTypeSelect = document.getElementById("live-link-type-select");
  if (linkTypeSelect instanceof HTMLSelectElement && linkTypeSelect.value === "serial") {
    try {
      await refreshLiveSerialPorts({ autoApply: true });
    } catch (error) {
      appendLog("MAVLink Serial 포트 자동 감지를 실패했습니다.");
      console.error(error);
    }
  }

  const connectionRequest = getLiveConnectionRequest();
  const endpoint = connectionRequest.endpoint || connectionRequest.fallbackEndpoint;

  resetLiveVehicleStatus();
  syncLiveTelemetryViews();
  window.dispatchEvent(new CustomEvent("dss:telemetry-reset"));
  liveSocketCloseExpected = false;
  setStatus("● LIVE CONNECTING", "--cyan");
  setStreamStatus("LIVE", "--cyan");
  updateLivePanelStatus();
  appendLog(`실기체 ${connectionRequest.displayLinkType} MAVLink 연결 시도: ${endpoint}`);

  const socket = createLiveTelemetrySocket({
    linkType: connectionRequest.linkType,
    endpoint,
    baudrate: connectionRequest.baudrate,
    systemId: connectionRequest.systemId,
    componentId: connectionRequest.componentId,
    streamId: LIVE_STREAM_ID,
    streamLabel: LIVE_STREAM_LABEL,
    onOpen: () => {
      liveTelemetrySocket = socket;
      liveSocketCloseExpected = false;
      setStatus("● WAITING HB", "--cyan");
      setStreamStatus("WAIT HB", "--cyan");
      updateLivePanelStatus();
      appendLog("MAVLink 브리지 WebSocket 열림 · Pixhawk HEARTBEAT 대기");
    },
    onClose: () => {
      const expectedClose = liveSocketCloseExpected;
      liveSocketCloseExpected = false;
      if (liveTelemetrySocket === socket) {
        liveTelemetrySocket = null;
      }
      resetLiveVehicleStatus();
      setStatus("● READY", "--yellow");
      setStreamStatus("CONNECT", "--yellow");
      void syncGroundControlPanelViews(false);
      updateLivePanelStatus();
      appendLog("실기체 텔레메트리 연결 종료");
      if (!expectedClose) {
        emitUiAlert("실기체 텔레메트리 연결이 종료되었습니다.", {
          title: "브리지 연결 종료",
          level: "warning",
        });
      }
    },
    onError: () => {
      liveSocketCloseExpected = true;
      if (liveTelemetrySocket === socket) {
        liveTelemetrySocket = null;
      }
      resetLiveVehicleStatus();
      setStatus("● LIVE ERROR", "--red");
      setStreamStatus("ERROR", "--red");
      void syncGroundControlPanelViews(false);
      updateLivePanelStatus();
      reportLiveIssue("실기체 텔레메트리 연결 오류", {
        title: "브리지 연결 실패",
        writeLog: true,
      });
    },
  });
  liveTelemetrySocket = socket;
  updateLivePanelStatus();
}

function initializeAlerts() {
  const alertStack = document.getElementById("alert-stack");
  if (!(alertStack instanceof HTMLElement)) {
    return;
  }

  const dismissAlert = (alertId) => {
    const alertElement = alertStack.querySelector(`[data-alert-id="${alertId}"]`);
    if (alertElement instanceof HTMLElement) {
      alertElement.remove();
    }
  };

  window.addEventListener("dss:alert", (event) => {
    const message = typeof event.detail?.message === "string" ? event.detail.message.trim() : "";
    if (!message) {
      return;
    }

    const alertId = event.detail?.id || `alert-${Date.now()}-${alertSequence += 1}`;
    const alertElement = document.createElement("article");
    alertElement.className = "alert-toast";
    alertElement.dataset.alertId = alertId;
    alertElement.dataset.level = event.detail?.level || "error";
    const headElement = document.createElement("div");
    headElement.className = "alert-toast-head";

    const titleElement = document.createElement("div");
    titleElement.className = "alert-toast-title";
    titleElement.textContent = event.detail?.title || "경고";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "alert-toast-close";
    closeButton.setAttribute("aria-label", "알림 닫기");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", () => dismissAlert(alertId));

    const bodyElement = document.createElement("div");
    bodyElement.className = "alert-toast-body";
    bodyElement.textContent = message;

    headElement.append(titleElement, closeButton);
    alertElement.append(headElement, bodyElement);

    alertStack.prepend(alertElement);
    window.setTimeout(() => dismissAlert(alertId), ALERT_AUTO_DISMISS_MS);
  });
}

function startTelemetrySession({ continueBatch = false } = {}) {
  if (liveTelemetrySocket instanceof WebSocket) {
    appendLog("실기체 브리지 연결 중에는 시뮬레이션을 시작할 수 없습니다.");
    return;
  }

  const streamConfigs = getActiveStreamConfigs();
  if (streamConfigs.length === 0) {
    appendLog("선택된 기체가 없습니다.");
    return;
  }
  if (streamConfigs.some((streamConfig) => !streamConfig.scenarioKey)) {
    appendLog("비행 계획이 선택되지 않은 기체가 있습니다.");
    return;
  }

  if (!continueBatch) {
    initializeSimulationBatch(getSimulationRepeatCount());
  } else if (!simulationBatchState) {
    initializeSimulationBatch(1);
  }

  const currentRunNumber = (simulationBatchState?.completedRuns ?? 0) + 1;
  const totalRunCount = simulationBatchState?.totalRuns ?? 1;

  const formationGroupStates = new Map();
  getSelectedScenarioKeys(streamConfigs).forEach((scenarioKey) => {
    const groupStreamConfigs = streamConfigs.filter((streamConfig) => streamConfig.scenarioKey === scenarioKey);
    formationGroupStates.set(scenarioKey, {
      sessionId: groupStreamConfigs.length > 1 ? createFormationSessionId() : "",
      formationSize: groupStreamConfigs.length,
      speedCaps: groupStreamConfigs.length > 1
        ? getFormationSpeedCaps(groupStreamConfigs)
        : {
          horizontalCapMps: null,
          ascentCapMps: null,
          descentCapMps: null,
        },
    });
  });

  closeActiveSockets();
  syncMapStreams(streamConfigs);
  void syncSimulationAnalysisStreams(streamConfigs);
  window.dispatchEvent(new CustomEvent("dss:telemetry-reset"));
  simulationPaused = false;
  setStatus("● CONNECTING", "--cyan");
  setStreamStatus("CONNECTING", "--cyan");
  setProgress(0);
  updateSimulationButtons();
  appendLog(
    `${getSelectedScenarioKeys(streamConfigs).length > 1 ? "개별" : "편대"} 텔레메트리 연결 시작: ${getScenarioSummaryLabel(streamConfigs)} / ${streamConfigs.length}기체 / ${currentRunNumber}/${totalRunCount}회차`,
  );

  streamConfigs.forEach((streamConfig) => {
    const formationGroupState = formationGroupStates.get(streamConfig.scenarioKey) ?? {
      sessionId: "",
      formationSize: 1,
      speedCaps: {
        horizontalCapMps: null,
        ascentCapMps: null,
        descentCapMps: null,
      },
    };
    const socket = createTelemetrySocket({
      droneName: streamConfig.droneKey,
      scenarioKey: streamConfig.scenarioKey,
      slotIndex: streamConfig.slotIndex,
      formationSession: formationGroupState.sessionId,
      formationMember: formationGroupState.formationSize > 1 ? streamConfig.streamId : "",
      formationSize: formationGroupState.formationSize,
      formationHorizontalCapMps: formationGroupState.speedCaps.horizontalCapMps,
      formationAscentCapMps: formationGroupState.speedCaps.ascentCapMps,
      formationDescentCapMps: formationGroupState.speedCaps.descentCapMps,
      streamId: streamConfig.streamId,
      streamLabel: streamConfig.streamLabel,
      droneKey: streamConfig.droneKey,
      isPrimary: streamConfig.isPrimary,
      onOpen: () => {
        if (streamConfig.isPrimary) {
          setStatus("● STREAMING", "--green");
          setStreamStatus("LIVE", "--green");
        }
        updateSimulationButtons();
        appendLog(
          `[${streamConfig.streamLabel}] ${streamConfig.displayName} 연결 완료 (${streamConfig.scenarioName || streamConfig.scenarioKey})`,
        );
      },
      onClose: () => {
        if (activeSockets.get(streamConfig.streamId) === socket) {
          activeSockets.delete(streamConfig.streamId);
        }
        if (suppressedSocketClosures.has(socket)) {
          suppressedSocketClosures.delete(socket);
          finalizeStreamingIfIdle({ naturalCompletion: false });
          return;
        }

        appendLog(`[${streamConfig.streamLabel}] 텔레메트리 연결 종료`);
        finalizeStreamingIfIdle();
      },
      onError: () => {
        cancelSimulationBatch();
        simulationPaused = false;
        setStatus("● ERROR", "--red");
        setStreamStatus("ERROR", "--red");
        updateSimulationButtons();
        appendLog(`[${streamConfig.streamLabel}] 텔레메트리 연결 오류`);
        renderSimulationBatchStatus();
      },
    });
    activeSockets.set(streamConfig.streamId, socket);
  });

  renderSimulationBatchStatus();
  updateSimulationButtons();
}

function connectTelemetry() {
  if (activeSockets.size > 0) {
    if (!simulationPaused) {
      appendLog("이미 시뮬레이션이 진행 중입니다.");
      return;
    }

    const resumedSocketCount = broadcastTelemetryControl("resume");
    if (resumedSocketCount === 0) {
      appendLog("재개 가능한 텔레메트리 연결이 없습니다.");
      return;
    }

    simulationPaused = false;
    setStatus("● STREAMING", "--green");
    setStreamStatus("LIVE", "--green");
    updateSimulationButtons();
    appendLog("시뮬레이션 재개");
    renderSimulationBatchStatus();
    return;
  }

  startTelemetrySession();
}

function pauseTelemetry() {
  if (activeSockets.size === 0) {
    appendLog("일시 정지할 시뮬레이션이 없습니다.");
    return;
  }

  if (simulationPaused) {
    appendLog("이미 일시 정지 상태입니다.");
    return;
  }

  const pausedSocketCount = broadcastTelemetryControl("pause");
  if (pausedSocketCount === 0) {
    appendLog("일시 정지 신호를 보낼 수 없습니다.");
    return;
  }

  simulationPaused = true;
  setStatus("● PAUSED", "--yellow");
  setStreamStatus("PAUSED", "--yellow");
  updateSimulationButtons();
  appendLog("시뮬레이션 일시 정지");
  renderSimulationBatchStatus();
}

function restartTelemetryIfActive() {
  if (activeSockets.size === 0) {
    return;
  }

  startTelemetrySession();
}

function dispatchReplayCommand(action) {
  window.dispatchEvent(new CustomEvent("dss:replay-command", {
    detail: { action },
  }));
}

function initializeControls() {
  const startButton = document.getElementById("start-button");
  if (startButton) {
    startButton.addEventListener("click", () => {
      if (getCurrentPanelTab() === "replay") {
        dispatchReplayCommand("play");
        return;
      }

      connectTelemetry();
    });
  }

  const pauseButton = document.getElementById("pause-button");
  if (pauseButton) {
    pauseButton.addEventListener("click", () => {
      if (getCurrentPanelTab() === "replay") {
        dispatchReplayCommand("pause");
        return;
      }

      pauseTelemetry();
    });
  }

  const saveButton = document.getElementById("save-button");
  if (saveButton) {
    saveButton.addEventListener("click", () => {
      const activeStreamConfigs = getActiveStreamConfigs();
      const saved = downloadFlightLog({
        droneKey: getPrimaryDroneSelection(activeStreamConfigs),
        scenarioKey: generatedScenario?.scenario_key || getDownloadScenarioKey(activeStreamConfigs),
      });
      if (!saved) {
        appendLog("저장할 비행 데이터가 없습니다.");
        return;
      }

      window.dispatchEvent(new CustomEvent("dss:flight-log-saved", {
        detail: {
          filename: saved.filename,
          csvText: saved.csvText,
        },
      }));
      appendLog("비행 데이터 CSV 저장 완료");
    });
  }

  const resetButton = document.getElementById("reset-button");
  if (resetButton) {
    resetButton.addEventListener("click", async () => {
      if (getCurrentPanelTab() === "replay") {
        dispatchReplayCommand("reset");
        return;
      }

      cancelSimulationBatch();
      closeActiveSockets();
      window.dispatchEvent(new CustomEvent("dss:telemetry-reset"));
      setStatus("● READY", "--yellow");
      setStreamStatus("SIMULATION", "--yellow");
      setProgress(0);
      await refreshGeneratedScenario();
      await refreshScenarioRoutes();
      updateSimulationButtons();
      appendLog("시뮬레이션 상태 초기화");
    });
  }

  const liveScenarioSelect = document.getElementById("live-scenario-select");
  if (liveScenarioSelect instanceof HTMLSelectElement) {
    liveScenarioSelect.addEventListener("change", () => {
      updateLivePanelStatus();
      if (isLivePanelActive()) {
        void syncGroundControlPanelViews();
      }
    });
  }

  const liveLinkTypeSelect = document.getElementById("live-link-type-select");
  if (liveLinkTypeSelect instanceof HTMLSelectElement) {
    liveLinkTypeSelect.addEventListener("change", () => {
      updateLiveEndpointPlaceholder();
      if (liveLinkTypeSelect.value === "serial") {
        void refreshLiveSerialPorts({ autoApply: true });
      }
    });
    updateLiveEndpointPlaceholder();
    if (liveLinkTypeSelect.value === "serial") {
      void refreshLiveSerialPorts({ autoApply: true });
    }
  }

  const liveEndpointInput = document.getElementById("live-endpoint-input");
  if (liveEndpointInput instanceof HTMLInputElement) {
    liveEndpointInput.addEventListener("input", updateFlightPanelStatus);
  }

  const simulationRepeatCountInput = document.getElementById("simulation-repeat-count-input");
  if (simulationRepeatCountInput instanceof HTMLInputElement) {
    const syncRepeatCountInput = () => {
      simulationRepeatCountInput.value = String(getSimulationRepeatCount());
      renderSimulationBatchStatus();
    };
    simulationRepeatCountInput.addEventListener("change", syncRepeatCountInput);
    simulationRepeatCountInput.addEventListener("blur", syncRepeatCountInput);
    syncRepeatCountInput();
  }

  const liveConnectButton = document.getElementById("live-connect-button");
  if (liveConnectButton instanceof HTMLButtonElement) {
    liveConnectButton.addEventListener("click", connectLiveTelemetry);
  }

  const liveUploadButton = document.getElementById("live-upload-button");
  if (liveUploadButton instanceof HTMLButtonElement) {
    liveUploadButton.addEventListener("click", () => {
      if (dispatchLiveCommand("upload_mission", { requireScenario: true })) {
        appendLog("실기체 임무 업로드 요청");
      }
    });
  }

  const liveStartButton = document.getElementById("live-start-button");
  if (liveStartButton instanceof HTMLButtonElement) {
    liveStartButton.addEventListener("click", () => {
      if (dispatchLiveCommand("start_mission")) {
        appendLog("실기체 임무 시작 요청");
      }
    });
  }

  const liveArmButton = document.getElementById("live-arm-button");
  if (liveArmButton instanceof HTMLButtonElement) {
    liveArmButton.addEventListener("click", () => {
      if (dispatchLiveCommand("arm")) {
        appendLog("실기체 ARM 요청");
      }
    });
  }

  const liveDisarmButton = document.getElementById("live-disarm-button");
  if (liveDisarmButton instanceof HTMLButtonElement) {
    liveDisarmButton.addEventListener("click", () => {
      if (dispatchLiveCommand("disarm")) {
        appendLog("실기체 DISARM 요청");
      }
    });
  }

  const liveTakeoffButton = document.getElementById("live-takeoff-button");
  if (liveTakeoffButton instanceof HTMLButtonElement) {
    liveTakeoffButton.addEventListener("click", () => {
      if (dispatchLiveCommand("takeoff")) {
        appendLog("실기체 이륙 요청");
      }
    });
  }

  const liveLandButton = document.getElementById("live-land-button");
  if (liveLandButton instanceof HTMLButtonElement) {
    liveLandButton.addEventListener("click", () => {
      if (dispatchLiveCommand("land")) {
        appendLog("실기체 착륙 요청");
      }
    });
  }

  const liveRthButton = document.getElementById("live-rth-button");
  if (liveRthButton instanceof HTMLButtonElement) {
    liveRthButton.addEventListener("click", () => {
      if (dispatchLiveCommand("rtl")) {
        appendLog("실기체 RTH 요청");
      }
    });
  }

  const liveHoldButton = document.getElementById("live-hold-button");
  if (liveHoldButton instanceof HTMLButtonElement) {
    liveHoldButton.addEventListener("click", () => {
      if (dispatchLiveCommand("hold")) {
        appendLog("실기체 HOLD 요청");
      }
    });
  }

  window.addEventListener("dss:panel-tab-change", async (event) => {
    const nextTabName = event.detail?.tabName ?? "simulation";
    setActivePanelTab(nextTabName);

    if (nextTabName === "replay") {
      await applyReplaySelectionState();
      return;
    }

    await restoreCurrentPanelViews();
  });

  window.addEventListener("dss:app-mode-change", (event) => {
    setAppMode(event.detail?.appMode);
    updateLivePanelStatus();
    updateSimulationButtons();
    void restoreCurrentPanelViews();
  });

  window.addEventListener("dss:live-status", (event) => {
    if (!(liveTelemetrySocket instanceof WebSocket)) {
      return;
    }

    const connectionPhase = event.detail?.connection_phase ?? "";
    const heartbeatSeen = Boolean(event.detail?.heartbeat_seen);
    if (heartbeatSeen) {
      setStatus("● LIVE STREAMING", "--green");
      setStreamStatus("LIVE", "--green");
    } else if (connectionPhase === "heartbeat_lost") {
      setStatus("● HEARTBEAT LOST", "--red");
      setStreamStatus("LOST", "--red");
    } else {
      setStatus("● WAITING HB", "--cyan");
      setStreamStatus("WAIT HB", "--cyan");
    }
  });

  window.addEventListener("dss:flight-mode-change", (event) => {
    if (event.detail?.streamId === LIVE_STREAM_ID) {
      return;
    }

    updateHeaderSimulationMode(event.detail?.modeLabel ?? "");
  });

  window.addEventListener("dss:telemetry-reset", () => {
    resetHeaderSimulationMode();
  });

  window.addEventListener("dss:replay-selection-change", async (event) => {
    replaySelectionState = {
      logId: event.detail?.logId ?? "",
      replayDetail: event.detail?.replayDetail ?? null,
      scenarioKey: event.detail?.scenarioKey ?? "",
      streamConfigs: Array.isArray(event.detail?.streamConfigs) ? event.detail.streamConfigs : [],
    };

    if (getCurrentPanelTab() === "replay") {
      await applyReplaySelectionState();
    }
  });

  window.addEventListener("dss:replay-playback-state", (event) => {
    const {
      loaded = false,
      playing = false,
      cursor = 0,
      sampleCount = 0,
      progressPercent = 0,
    } = event.detail ?? {};
    updateReplayPlaybackState(event.detail ?? {});
    updateSimulationButtons();

    if (getCurrentPanelTab() !== "replay") {
      return;
    }

    setProgress(progressPercent);

    if (playing) {
      setStatus("● REPLAY", "--cyan");
      setStreamStatus("REPLAY", "--cyan");
      return;
    }

    if (loaded && cursor >= sampleCount && sampleCount > 0) {
      setStatus("● READY", "--yellow");
      setStreamStatus("REPLAY", "--yellow");
      setProgress(100);
      return;
    }

    if (loaded) {
      setStatus("● READY", "--yellow");
      setStreamStatus("REPLAY", "--yellow");
      return;
    }

    setStatus("● READY", "--yellow");
    setStreamStatus("REPLAY", "--yellow");
    setProgress(0);
  });
}

function initializeCustomScenarioEvents() {
  window.addEventListener("dss:custom-scenario-saved", async (event) => {
    const savedScenario = event.detail;
    if (!savedScenario?.key) {
      return;
    }

    try {
      if (activeSockets.size > 0) {
        await reloadScenarioSelects();
        appendLog(`사용자 비행 계획 ${savedScenario.updated ? "수정" : "저장"}: ${savedScenario.name}`);
        return;
      }

      await reloadScenarioSelects(savedScenario.key);
      await refreshGeneratedScenario();
      await refreshScenarioRoutes();
      appendLog(`사용자 비행 계획 ${savedScenario.updated ? "수정" : "저장"}: ${savedScenario.name}`);
    } catch (error) {
      appendLog("저장된 비행 계획 목록을 갱신하지 못했습니다.");
      console.error(error);
    }
  });

  window.addEventListener("dss:custom-scenario-deleted", async (event) => {
    const deletedScenario = event.detail;
    if (!deletedScenario?.key) {
      return;
    }

    try {
      await reloadScenarioSelects();
      await refreshGeneratedScenario();
      await refreshScenarioRoutes();
      appendLog(`사용자 비행 계획 삭제: ${deletedScenario.name}`);
    } catch (error) {
      appendLog("삭제된 비행 계획 목록을 갱신하지 못했습니다.");
      console.error(error);
    }
  });
}

function initializeCustomDroneEvents() {
  window.addEventListener("dss:custom-drone-saved", async () => {
    try {
      await reloadDroneSelects();
      appendLog("사용자 정의 드론 목록 갱신 완료");
    } catch (error) {
      appendLog("사용자 정의 드론 목록을 갱신하지 못했습니다.");
      console.error(error);
    }
  });

  window.addEventListener("dss:custom-drone-deleted", async (event) => {
    try {
      await reloadDroneSelects();
      const deletedName = event.detail?.name ?? "기체";
      appendLog(`드론 목록 갱신 완료: ${deletedName}`);
    } catch (error) {
      appendLog("삭제된 드론 목록을 갱신하지 못했습니다.");
      console.error(error);
    }
  });
}

async function initializeSelectors() {
  try {
    const [droneSpecs, scenarios] = await Promise.all([
      loadDroneSpecs(),
      loadScenarios(),
    ]);
    setDroneSpecs(droneSpecs);
    updateScenarioDefinitionMap(scenarios);

    DRONE_SLOT_CONFIGS.forEach((slotConfig, index) => {
      const droneSelect = document.getElementById(slotConfig.droneSelectId);
      const scenarioSelect = document.getElementById(slotConfig.scenarioSelectId);
      if (!(droneSelect instanceof HTMLSelectElement)) {
        return;
      }

      populateDroneSelect(droneSelect, droneSpecs, true);
      droneSelect.addEventListener("change", async () => {
        await refreshGeneratedScenario();
        await refreshScenarioRoutes();
        restartTelemetryIfActive();
      });

      if (scenarioSelect instanceof HTMLSelectElement) {
        populateScenarioSelect(scenarioSelect, scenarios);
        scenarioSelect.addEventListener("change", async () => {
          await refreshGeneratedScenario();
          await refreshScenarioRoutes();
          restartTelemetryIfActive();
        });
      }
    });

    const liveScenarioSelect = document.getElementById("live-scenario-select");
    if (liveScenarioSelect instanceof HTMLSelectElement) {
      populateScenarioSelect(liveScenarioSelect, scenarios);
    }

    updateLivePanelStatus();
    await refreshGeneratedScenario();
    await refreshScenarioRoutes();
  } catch (error) {
    appendLog("초기 데이터를 불러오지 못했습니다. 백엔드 연결을 확인하세요.");
    console.error(error);
  }
}

async function initializeApp() {
  configureSimulationStatus({
    getActiveSocketCount: () => activeSockets.size,
    getSimulationPaused: () => simulationPaused,
  });
  configureLivePanel({
    isLivePanelActive,
    isLiveConnected: () => liveTelemetrySocket instanceof WebSocket,
    getScenarioDisplayName,
  });
  initializeCameraView();
  initializeCustomDroneBuilder();
  initializeLivePanel();
  initializeThemeSelector();
  initializeFlightLog();
  initializeMap();
  initializeScenarioBuilder();
  await initializeReplayPanel();
  initializeAlerts();
  setAppMode(document.body?.dataset.appMode);
  initializeTelemetry();
  initializeLog();
  initializeSimulationAnalysis();
  initializeProgressTracking();
  initializeControls();
  initializeCustomScenarioEvents();
  initializeCustomDroneEvents();
  await initializeSelectors();
  setActivePanelTab(getCurrentPanelTab());
  setStatus("● READY", "--yellow");
  setProgress(0);
  updateSimulationButtons();
  renderSimulationBatchStatus();
}

initializeApp();
