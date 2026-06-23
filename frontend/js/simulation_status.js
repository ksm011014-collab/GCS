const PANEL_STATUS_LABELS = {
  simulation: "SIMULATION",
  replay: "REPLAY",
  live: "CONNECT",
  builder: "PLAN",
  "drone-builder": "DRONE",
  flight: "FLIGHT",
};
const APP_MODE_LABELS = {
  simulation: "SIMULATION",
  "ground-control": "GROUND CTRL",
};
const APP_MODE_SUBTITLE_LABELS = {
  simulation: "DECISION SUPPORT SYSTEM",
  "ground-control": "GROUND CONTROL SYSTEM",
};
const BRAND_TITLE = "K-DP";

let currentPanelTab = "simulation";
let currentAppMode = "simulation";
let currentProgressPercent = 0;
let getActiveSocketCount = () => 0;
let getSimulationPaused = () => false;
let progressTrackingInitialized = false;
let simulationHeaderModeLabel = "";
const liveHeaderStatus = {
  connected: false,
  heartbeatSeen: false,
  modeLabel: "",
  armed: null,
  gpsFixLabel: "",
  satellitesVisible: null,
  batteryPct: null,
};
const replayControlState = {
  loaded: false,
  playing: false,
  cursor: 0,
  sampleCount: 0,
  selectedSampleIndex: -1,
  progressPercent: 0,
};
let replayScrubInitialized = false;
let replayScrubPointerId = null;


export function configureSimulationStatus(options = {}) {
  getActiveSocketCount = typeof options.getActiveSocketCount === "function"
    ? options.getActiveSocketCount
    : getActiveSocketCount;
  getSimulationPaused = typeof options.getSimulationPaused === "function"
    ? options.getSimulationPaused
    : getSimulationPaused;
}


export function getCurrentPanelTab() {
  return currentPanelTab;
}


export function getCurrentAppMode() {
  return currentAppMode;
}


export function setPanelTab(tabName) {
  currentPanelTab = tabName || "simulation";
  renderHeaderIndicators();
}


export function setAppMode(appMode) {
  currentAppMode = appMode === "ground-control" ? "ground-control" : "simulation";
  renderHeaderBranding();
  renderHeaderIndicators();
}


export function isLivePanelActive() {
  return currentAppMode === "ground-control";
}


function shouldDisableSimulationControls() {
  return currentAppMode === "ground-control";
}


function getPanelStatusLabel() {
  if (currentPanelTab === "replay") {
    return PANEL_STATUS_LABELS.replay;
  }

  return APP_MODE_LABELS[currentAppMode] ?? APP_MODE_LABELS.simulation;
}


function setTextContent(elementId, value) {
  const element = document.getElementById(elementId);
  if (element) {
    element.textContent = value;
  }
}


function renderHeaderBranding() {
  setTextContent("header-brand-title", BRAND_TITLE);
  setTextContent(
    "header-brand-subtitle",
    APP_MODE_SUBTITLE_LABELS[currentAppMode] ?? APP_MODE_SUBTITLE_LABELS.simulation,
  );
  document.title = BRAND_TITLE;
}


function setIndicatorState(elementId, state) {
  const element = document.getElementById(elementId);
  if (element) {
    element.dataset.state = state;
  }
}


function setBatteryFill(percent) {
  const fillElement = document.getElementById("header-battery-fill");
  if (!fillElement) {
    return;
  }

  const clampedPercent = Number.isFinite(percent)
    ? Math.max(0, Math.min(100, percent))
    : 8;
  fillElement.style.width = `${Math.max(8, clampedPercent)}%`;
}


function getHeaderLinkPresentation() {
  if (liveHeaderStatus.connected) {
    if (liveHeaderStatus.heartbeatSeen) {
      return {
        state: "online",
        value: "MAVLINK",
      };
    }

    return {
      state: "pending",
      value: "WAIT HB",
    };
  }

  if (getActiveSocketCount() > 0) {
    return {
      state: getSimulationPaused() ? "paused" : "sim",
      value: getSimulationPaused() ? "SIM PAUSE" : "SIM LIVE",
    };
  }

  return {
    state: "offline",
    value: currentAppMode === "ground-control" ? "DISCONNECTED" : "IDLE",
  };
}


function getHeaderModePresentation() {
  if (liveHeaderStatus.connected && liveHeaderStatus.heartbeatSeen && liveHeaderStatus.modeLabel) {
    return {
      state: "online",
      value: liveHeaderStatus.modeLabel,
    };
  }

  if (currentAppMode === "ground-control") {
    return {
      state: liveHeaderStatus.connected ? "pending" : "idle",
      value: liveHeaderStatus.connected ? "대기" : "--",
    };
  }

  if (getActiveSocketCount() > 0) {
    return {
      state: getSimulationPaused() ? "paused" : "sim",
      value: simulationHeaderModeLabel || "대기",
    };
  }

  return {
    state: "idle",
    value: "--",
  };
}


function normalizeGpsFixLabel(gpsFixLabel = "") {
  const normalizedLabel = typeof gpsFixLabel === "string" ? gpsFixLabel.trim() : "";
  return normalizedLabel.startsWith("GPS_FIX_TYPE_")
    ? normalizedLabel.slice("GPS_FIX_TYPE_".length)
    : normalizedLabel;
}


function getHeaderArmPresentation() {
  if (liveHeaderStatus.connected && liveHeaderStatus.heartbeatSeen) {
    if (liveHeaderStatus.armed === true) {
      return {
        state: "online",
        value: "ARMED",
      };
    }

    if (liveHeaderStatus.armed === false) {
      return {
        state: "warning",
        value: "SAFE",
      };
    }

    return {
      state: "pending",
      value: "WAIT",
    };
  }

  if (currentAppMode === "ground-control") {
    return {
      state: liveHeaderStatus.connected ? "pending" : "idle",
      value: liveHeaderStatus.connected ? "WAIT" : "--",
    };
  }

  if (getActiveSocketCount() > 0) {
    return {
      state: getSimulationPaused() ? "paused" : "sim",
      value: "SIM",
    };
  }

  return {
    state: "idle",
    value: "--",
  };
}


function getHeaderGpsPresentation() {
  if (liveHeaderStatus.connected && liveHeaderStatus.heartbeatSeen) {
    const gpsFixLabel = normalizeGpsFixLabel(liveHeaderStatus.gpsFixLabel);
    const satellitesVisible = Number.isFinite(liveHeaderStatus.satellitesVisible)
      ? Number(liveHeaderStatus.satellitesVisible)
      : null;
    const gpsValue = gpsFixLabel
      ? satellitesVisible === null
        ? gpsFixLabel
        : `${gpsFixLabel}/${satellitesVisible}`
      : satellitesVisible === null
        ? "-"
        : `SAT/${satellitesVisible}`;

    const normalizedGpsValue = gpsValue.toUpperCase();
    let state = "pending";
    if (normalizedGpsValue.includes("3D") || normalizedGpsValue.includes("RTK")) {
      state = "online";
    } else if (
      normalizedGpsValue.includes("NO_FIX")
      || normalizedGpsValue.includes("NO GPS")
      || normalizedGpsValue.includes("NO_GPS")
      || normalizedGpsValue.includes("GPS 미수신".toUpperCase())
    ) {
      state = "critical";
    } else if (normalizedGpsValue.includes("2D")) {
      state = "warning";
    }

    return {
      state,
      value: gpsValue,
    };
  }

  if (currentAppMode === "ground-control") {
    return {
      state: liveHeaderStatus.connected ? "pending" : "idle",
      value: liveHeaderStatus.connected ? "WAIT" : "--",
    };
  }

  if (getActiveSocketCount() > 0) {
    return {
      state: getSimulationPaused() ? "paused" : "sim",
      value: "SIM",
    };
  }

  return {
    state: "idle",
    value: "--",
  };
}


function getHeaderBatteryPresentation() {
  if (Number.isFinite(liveHeaderStatus.batteryPct)) {
    const batteryPct = Math.max(0, Math.min(100, Number(liveHeaderStatus.batteryPct)));
    return {
      state: batteryPct <= 20 ? "critical" : batteryPct <= 45 ? "warning" : "healthy",
      value: `${Math.round(batteryPct)}%`,
      percent: batteryPct,
    };
  }

  if (getActiveSocketCount() > 0) {
    return {
      state: "sim",
      value: "SIM",
      percent: 100,
    };
  }

  return {
    state: "idle",
    value: "--",
    percent: null,
  };
}


function renderHeaderIndicators() {
  const linkPresentation = getHeaderLinkPresentation();
  const armPresentation = getHeaderArmPresentation();
  const gpsPresentation = getHeaderGpsPresentation();
  const modePresentation = getHeaderModePresentation();
  const batteryPresentation = getHeaderBatteryPresentation();

  setIndicatorState("header-link-indicator", linkPresentation.state);
  setIndicatorState("header-arm-indicator", armPresentation.state);
  setIndicatorState("header-gps-indicator", gpsPresentation.state);
  setIndicatorState("header-mode-indicator", modePresentation.state);
  setIndicatorState("header-battery-indicator", batteryPresentation.state);
  setTextContent("header-link-value", linkPresentation.value);
  setTextContent("header-arm-value", armPresentation.value);
  setTextContent("header-gps-value", gpsPresentation.value);
  setTextContent("header-mode-value", modePresentation.value);
  setTextContent("header-battery-value", batteryPresentation.value);
  setBatteryFill(batteryPresentation.percent);
}


export function updateHeaderLiveStatus({
  connected = false,
  heartbeatSeen = false,
  modeLabel = "",
  armed = null,
  gpsFixLabel = "",
  satellitesVisible = null,
  batteryPct = null,
} = {}) {
  liveHeaderStatus.connected = Boolean(connected);
  liveHeaderStatus.heartbeatSeen = Boolean(heartbeatSeen);
  liveHeaderStatus.modeLabel = typeof modeLabel === "string" ? modeLabel.trim() : "";
  liveHeaderStatus.armed = typeof armed === "boolean" ? armed : null;
  liveHeaderStatus.gpsFixLabel = typeof gpsFixLabel === "string" ? gpsFixLabel.trim() : "";
  liveHeaderStatus.satellitesVisible = Number.isFinite(satellitesVisible)
    ? Number(satellitesVisible)
    : null;
  liveHeaderStatus.batteryPct = Number.isFinite(batteryPct) ? Number(batteryPct) : null;
  renderHeaderIndicators();
}


export function updateHeaderSimulationMode(modeLabel = "") {
  simulationHeaderModeLabel = typeof modeLabel === "string" ? modeLabel.trim() : "";
  renderHeaderIndicators();
}


export function resetHeaderLiveStatus() {
  liveHeaderStatus.connected = false;
  liveHeaderStatus.heartbeatSeen = false;
  liveHeaderStatus.modeLabel = "";
  liveHeaderStatus.armed = null;
  liveHeaderStatus.gpsFixLabel = "";
  liveHeaderStatus.satellitesVisible = null;
  liveHeaderStatus.batteryPct = null;
  renderHeaderIndicators();
}


export function resetHeaderSimulationMode() {
  simulationHeaderModeLabel = "";
  renderHeaderIndicators();
}


export function setStatus(text, colorVar) {
  const statusElement = document.getElementById("map-status");
  if (!statusElement) {
    return;
  }

  statusElement.textContent = text;
  statusElement.style.color = "";
}


export function setStreamStatus(text, colorVar) {
  const statusElement = document.getElementById("stream-status");
  if (!statusElement) {
    renderHeaderIndicators();
    return;
  }

  statusElement.textContent = getPanelStatusLabel();
  statusElement.style.color = "";
  renderHeaderIndicators();
}


export function setProgress(percent) {
  const numericPercent = Number(percent);
  if (!Number.isFinite(numericPercent)) {
    return;
  }

  const clampedPercent = Math.max(0, Math.min(100, numericPercent));
  currentProgressPercent = clampedPercent;
  const fillElement = document.getElementById("progress-fill");
  const handleElement = document.getElementById("progress-handle");
  const labelElement = document.getElementById("progress-pct");
  const progressWrap = document.getElementById("progress-wrap");

  if (fillElement) {
    fillElement.style.width = `${clampedPercent}%`;
  }

  if (handleElement) {
    handleElement.style.left = `${clampedPercent}%`;
  }

  if (labelElement) {
    labelElement.textContent = `${Math.round(clampedPercent)}%`;
  }

  if (progressWrap) {
    progressWrap.setAttribute("aria-valuenow", String(Math.round(clampedPercent)));
    progressWrap.setAttribute("aria-valuetext", `${Math.round(clampedPercent)}%`);
  }
}

function isReplayProgressInteractive() {
  return currentPanelTab === "replay" && replayControlState.loaded && replayControlState.sampleCount > 0;
}

function renderProgressInteractivity() {
  const progressWrap = document.getElementById("progress-wrap");
  if (!progressWrap) {
    return;
  }

  const interactive = isReplayProgressInteractive();
  progressWrap.dataset.interactive = interactive ? "true" : "false";
  progressWrap.setAttribute("aria-disabled", interactive ? "false" : "true");
  progressWrap.tabIndex = interactive ? 0 : -1;
}

function dispatchReplayCommand(action) {
  window.dispatchEvent(new CustomEvent("dss:replay-command", {
    detail: { action },
  }));
}

function dispatchReplaySeekRequest(ratio) {
  const numericRatio = Number(ratio);
  if (!isReplayProgressInteractive() || !Number.isFinite(numericRatio)) {
    return;
  }

  const clampedRatio = Math.max(0, Math.min(1, numericRatio));
  window.dispatchEvent(new CustomEvent("dss:replay-seek-request", {
    detail: { ratio: clampedRatio },
  }));
}

function resolveReplaySeekRatioFromClientX(clientX) {
  const progressWrap = document.getElementById("progress-wrap");
  if (!progressWrap) {
    return null;
  }

  const bounds = progressWrap.getBoundingClientRect();
  if (!(bounds.width > 0)) {
    return null;
  }

  return (clientX - bounds.left) / bounds.width;
}

function initializeReplayScrubber() {
  if (replayScrubInitialized) {
    return;
  }

  replayScrubInitialized = true;
  const progressWrap = document.getElementById("progress-wrap");
  if (!(progressWrap instanceof HTMLElement)) {
    return;
  }

  progressWrap.addEventListener("pointerdown", (event) => {
    if (!isReplayProgressInteractive()) {
      return;
    }

    const nextRatio = resolveReplaySeekRatioFromClientX(event.clientX);
    if (nextRatio === null) {
      return;
    }

    replayScrubPointerId = event.pointerId;
    progressWrap.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    dispatchReplaySeekRequest(nextRatio);
  });

  progressWrap.addEventListener("pointermove", (event) => {
    if (
      replayScrubPointerId === null
      || replayScrubPointerId !== event.pointerId
      || !isReplayProgressInteractive()
    ) {
      return;
    }

    const nextRatio = resolveReplaySeekRatioFromClientX(event.clientX);
    if (nextRatio === null) {
      return;
    }

    dispatchReplaySeekRequest(nextRatio);
  });

  const clearReplayScrubPointer = (event) => {
    if (replayScrubPointerId === null || replayScrubPointerId !== event.pointerId) {
      return;
    }

    progressWrap.releasePointerCapture?.(event.pointerId);
    replayScrubPointerId = null;
  };

  progressWrap.addEventListener("pointerup", clearReplayScrubPointer);
  progressWrap.addEventListener("pointercancel", clearReplayScrubPointer);

  progressWrap.addEventListener("keydown", (event) => {
    if (!isReplayProgressInteractive()) {
      return;
    }

    const sampleCount = Math.max(replayControlState.sampleCount, 1);
    const maximumSampleIndex = Math.max(sampleCount - 1, 0);
    const currentSampleIndex = Math.max(
      0,
      Math.min(
        maximumSampleIndex,
        replayControlState.selectedSampleIndex >= 0
          ? replayControlState.selectedSampleIndex
          : Math.max(0, replayControlState.cursor - 1),
      ),
    );

    let nextSampleIndex = currentSampleIndex;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        nextSampleIndex = Math.max(0, currentSampleIndex - 1);
        break;
      case "ArrowRight":
      case "ArrowUp":
        nextSampleIndex = Math.min(maximumSampleIndex, currentSampleIndex + 1);
        break;
      case "PageDown":
        nextSampleIndex = Math.max(0, currentSampleIndex - 10);
        break;
      case "PageUp":
        nextSampleIndex = Math.min(maximumSampleIndex, currentSampleIndex + 10);
        break;
      case "Home":
        nextSampleIndex = 0;
        break;
      case "End":
        nextSampleIndex = maximumSampleIndex;
        break;
      case " ":
      case "Enter":
        dispatchReplayCommand(replayControlState.playing ? "pause" : "play");
        event.preventDefault();
        return;
      default:
        return;
    }

    event.preventDefault();
    dispatchReplaySeekRequest(maximumSampleIndex > 0 ? nextSampleIndex / maximumSampleIndex : 0);
  });
}

export function updateReplayPlaybackState({
  loaded = false,
  playing = false,
  cursor = 0,
  sampleCount = 0,
  selectedSampleIndex = -1,
  progressPercent = 0,
} = {}) {
  replayControlState.loaded = Boolean(loaded);
  replayControlState.playing = Boolean(playing);
  replayControlState.cursor = Number.isFinite(cursor) ? Number(cursor) : 0;
  replayControlState.sampleCount = Number.isFinite(sampleCount) ? Number(sampleCount) : 0;
  replayControlState.selectedSampleIndex = Number.isFinite(selectedSampleIndex)
    ? Number(selectedSampleIndex)
    : -1;
  replayControlState.progressPercent = Number.isFinite(progressPercent)
    ? Math.max(0, Math.min(100, Number(progressPercent)))
    : 0;
  renderProgressInteractivity();
}


export function updateSimulationButtons() {
  const startButton = document.getElementById("start-button");
  const pauseButton = document.getElementById("pause-button");
  const resetButton = document.getElementById("reset-button");
  const saveButton = document.getElementById("save-button");
  const progressWrap = document.getElementById("progress-wrap");
  const progressLabel = document.getElementById("progress-pct");
  const activeSocketCount = getActiveSocketCount();
  const simulationPaused = getSimulationPaused();

  if (shouldDisableSimulationControls()) {
    if (startButton instanceof HTMLButtonElement) {
      startButton.textContent = "▶ 시작";
      startButton.disabled = true;
    }

    if (pauseButton instanceof HTMLButtonElement) {
      pauseButton.textContent = "❚❚ 정지";
      pauseButton.disabled = true;
    }

    if (resetButton instanceof HTMLButtonElement) {
      resetButton.disabled = true;
    }

    if (saveButton instanceof HTMLButtonElement) {
      saveButton.textContent = "⊞ 저장";
      saveButton.disabled = true;
    }

    if (progressWrap) {
      progressWrap.style.opacity = "0.35";
    }

    if (progressLabel) {
      progressLabel.textContent = "--";
      progressLabel.style.opacity = "0.55";
    }

    renderProgressInteractivity();
    renderHeaderIndicators();
    return;
  }

  if (currentPanelTab === "replay") {
    const replayLoaded = replayControlState.loaded && replayControlState.sampleCount > 0;
    const replayComplete = replayLoaded && replayControlState.cursor >= replayControlState.sampleCount;

    if (startButton instanceof HTMLButtonElement) {
      startButton.textContent = replayComplete
        ? "▶ 다시"
        : replayControlState.selectedSampleIndex >= 0
          ? "▶ 재개"
          : "▶ 재생";
      startButton.disabled = !replayLoaded || replayControlState.playing;
    }

    if (pauseButton instanceof HTMLButtonElement) {
      pauseButton.textContent = "❚❚ 정지";
      pauseButton.disabled = !replayControlState.playing;
    }

    if (resetButton instanceof HTMLButtonElement) {
      resetButton.disabled = !replayLoaded;
    }

    if (saveButton instanceof HTMLButtonElement) {
      saveButton.textContent = "⊞ 저장";
      saveButton.disabled = true;
    }

    if (progressWrap) {
      progressWrap.style.opacity = replayLoaded ? "" : "0.35";
    }

    if (progressLabel) {
      progressLabel.textContent = replayLoaded ? `${Math.round(currentProgressPercent)}%` : "--";
      progressLabel.style.opacity = replayLoaded ? "" : "0.55";
    }

    renderProgressInteractivity();
    renderHeaderIndicators();
    return;
  }

  if (startButton instanceof HTMLButtonElement) {
    startButton.textContent = simulationPaused ? "▶ 재개" : "▶ 시작";
    startButton.disabled = activeSocketCount > 0 && !simulationPaused;
  }

  if (pauseButton instanceof HTMLButtonElement) {
    pauseButton.textContent = "❚❚ 정지";
    pauseButton.disabled = activeSocketCount === 0 || simulationPaused;
  }

  if (resetButton instanceof HTMLButtonElement) {
    resetButton.disabled = false;
  }

  if (saveButton instanceof HTMLButtonElement) {
    saveButton.textContent = "⊞ 저장";
    saveButton.disabled = false;
  }

  if (progressWrap) {
    progressWrap.style.opacity = "";
  }

  if (progressLabel) {
    progressLabel.textContent = `${Math.round(currentProgressPercent)}%`;
    progressLabel.style.opacity = "";
  }

  renderProgressInteractivity();
  renderHeaderIndicators();
}


export function initializeProgressTracking() {
  renderHeaderBranding();
  renderHeaderIndicators();
  if (progressTrackingInitialized) {
    return;
  }

  progressTrackingInitialized = true;
  initializeReplayScrubber();
  renderProgressInteractivity();
  window.addEventListener("dss:progress", (event) => {
    const { detail } = event;
    if (!detail?.isPrimary) {
      return;
    }

    const progressPercent = Number(detail.progress_pct);
    if (Number.isNaN(progressPercent)) {
      return;
    }

    setProgress(getActiveSocketCount() > 0
      ? Math.max(currentProgressPercent, progressPercent)
      : progressPercent);
  });
}
