const HIDDEN_LOG_MESSAGES = new Set([
  "__mission_recording_start__",
  "__mission_recording_stop__",
]);
const FLIGHT_MODE_MESSAGE_PREFIX = "__flight_mode__|";
const MAX_VISIBLE_CSV_ROWS = 240;
const REPLAY_STREAM_ID = "replay-log";
const STREAM_IDS = [
  "drone-1-select",
  "drone-2-select",
  "drone-3-select",
  "live-vehicle",
  REPLAY_STREAM_ID,
];
const DEFAULT_STREAM_LABELS = new Map([
  ["drone-1-select", "기체 1"],
  ["drone-2-select", "기체 2"],
  ["drone-3-select", "기체 3"],
  ["live-vehicle", "연결된 기체"],
  [REPLAY_STREAM_ID, "리플레이"],
]);
const streamEntriesById = new Map();
const streamPhaseById = new Map();
const streamConfigsById = new Map(
  STREAM_IDS.map((streamId, index) => [
    streamId,
    {
      streamId,
      streamLabel: DEFAULT_STREAM_LABELS.get(streamId) ?? `기체 ${index + 1}`,
      enabled: index === 0,
    },
  ]),
);
let selectedStreamId = STREAM_IDS[0];
let latestStatusMessage = "";
let cachedLogListElements = null;

function getCurrentAppMode() {
  return document.body?.dataset.appMode === "ground-control" ? "ground-control" : "simulation";
}

function getCurrentPanelTab() {
  return document.body?.dataset.panelTab ?? "simulation";
}

function isVisibleStreamId(streamId) {
  if (getCurrentPanelTab() === "replay") {
    return streamId === REPLAY_STREAM_ID;
  }

  return getCurrentAppMode() === "ground-control"
    ? streamId === "live-vehicle"
    : streamId !== "live-vehicle";
}

function getFirstVisibleStreamId() {
  return STREAM_IDS.find((streamId) => isVisibleStreamId(streamId)) ?? STREAM_IDS[0];
}

function isHiddenLogMessage(message) {
  return HIDDEN_LOG_MESSAGES.has(message) || String(message ?? "").startsWith(FLIGHT_MODE_MESSAGE_PREFIX);
}

function setText(elementId, value) {
  const element = document.getElementById(elementId);
  if (element) {
    element.textContent = value;
  }
}

function getLogListElements() {
  if (cachedLogListElements === null) {
    cachedLogListElements = ["log-list", "flight-log-list"]
      .map((elementId) => document.getElementById(elementId))
      .filter(Boolean);
  }
  return cachedLogListElements;
}

function setLogStatus(value) {
  setText("log-status", value);
  setText("flight-log-status", value);
}

function getSelectedStreamConfig() {
  return streamConfigsById.get(selectedStreamId) ?? null;
}

function getSelectedStreamEntries() {
  return streamEntriesById.get(selectedStreamId) ?? [];
}

function getSelectedStreamPhase() {
  return streamPhaseById.get(selectedStreamId) ?? "idle";
}

function setStatusMessage(message = "") {
  latestStatusMessage = message;
  renderStatus();
}

function renderStatus() {
  const selectedStream = getSelectedStreamConfig();
  if (!selectedStream?.enabled) {
    setLogStatus("연결 안 됨");
    return;
  }

  if (getSelectedStreamPhase() === "departing") {
    setLogStatus("시작지점 이동중");
    return;
  }

  if (latestStatusMessage) {
    setLogStatus(latestStatusMessage);
    return;
  }

  setLogStatus(`${selectedStream.streamLabel} 로그`);
}

function renderEmptyState() {
  getLogListElements().forEach((logList) => {
    logList.innerHTML = "";
  });
}

function renderSelectedStreamEntries() {
  const entries = getSelectedStreamEntries();
  if (entries.length === 0) {
    renderEmptyState();
    return;
  }

  getLogListElements().forEach((logList) => {
    const fragment = document.createDocumentFragment();
    entries.forEach((displayText) => {
      const entry = document.createElement("div");
      entry.className = "csv-log-entry";
      entry.textContent = displayText;
      fragment.append(entry);
    });
    logList.replaceChildren(fragment);
    logList.scrollTop = logList.scrollHeight;
  });
}

function appendCsvRow(streamId, displayText) {
  if (!streamEntriesById.has(streamId)) {
    streamEntriesById.set(streamId, []);
  }

  const entries = streamEntriesById.get(streamId);
  entries.push(displayText);
  while (entries.length > MAX_VISIBLE_CSV_ROWS) {
    entries.shift();
  }

  if (streamId !== selectedStreamId) {
    return;
  }

  getLogListElements().forEach((logList) => {
    const emptyState = logList.querySelector(".csv-log-empty");
    if (emptyState) {
      emptyState.remove();
    }

    const entry = document.createElement("div");
    entry.className = "csv-log-entry";
    entry.textContent = displayText;
    logList.append(entry);

    while (logList.children.length > MAX_VISIBLE_CSV_ROWS) {
      logList.firstElementChild?.remove();
    }

    logList.scrollTop = logList.scrollHeight;
  });
}

function renderStreamSelector() {
  const buttons = document.querySelectorAll("[data-log-stream-id]");
  if (!isVisibleStreamId(selectedStreamId)) {
    selectedStreamId = getFirstVisibleStreamId();
  }

  buttons.forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    const streamId = button.dataset.logStreamId;
    const streamConfig = streamConfigsById.get(streamId);
    button.hidden = !isVisibleStreamId(streamId);
    if (streamConfig?.streamLabel) {
      button.textContent = streamConfig.streamLabel;
    }
    button.classList.toggle("is-active", streamId === selectedStreamId);
    button.classList.toggle("is-disabled", streamConfig?.enabled === false);
  });
}

function selectLogStream(streamId) {
  if (!STREAM_IDS.includes(streamId) || !isVisibleStreamId(streamId)) {
    return;
  }

  selectedStreamId = streamId;
  renderStreamSelector();
  renderStatus();
  renderSelectedStreamEntries();
}

export function syncLogStreams(streamConfigs) {
  STREAM_IDS.forEach((streamId, index) => {
    const nextConfig = streamConfigs.find((streamConfig) => streamConfig.streamId === streamId);
    streamConfigsById.set(streamId, {
      streamId,
      streamLabel: nextConfig?.streamLabel ?? DEFAULT_STREAM_LABELS.get(streamId) ?? `기체 ${index + 1}`,
      enabled: nextConfig?.enabled ?? false,
    });

    if (nextConfig?.enabled === false) {
      streamEntriesById.delete(streamId);
      streamPhaseById.delete(streamId);
    }
  });

  renderStreamSelector();
  renderStatus();
  renderSelectedStreamEntries();
}

export function appendLog(message) {
  if (isHiddenLogMessage(message)) {
    return;
  }

  setStatusMessage(message);
}

export function initializeLog() {
  document.querySelectorAll("[data-log-stream-id]").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    button.addEventListener("click", () => {
      selectLogStream(button.dataset.logStreamId ?? "");
    });
  });

  renderStreamSelector();
  renderStatus();
  renderEmptyState();

  window.addEventListener("dss:log", (event) => {
    if (isHiddenLogMessage(event.detail.message)) {
      return;
    }

    const prefix = event.detail.streamLabel ? `[${event.detail.streamLabel}] ` : "";
    appendLog(`${prefix}${event.detail.message}`);
  });

  window.addEventListener("dss:flight-log-row", (event) => {
    appendCsvRow(
      event.detail.streamId,
      event.detail.displayText,
    );
  });

  window.addEventListener("dss:flight-log-status", (event) => {
    if (!event.detail?.streamId) {
      return;
    }

    if (event.detail.phase === "recording") {
      latestStatusMessage = "";
    }

    streamPhaseById.set(event.detail.streamId, event.detail.phase ?? "idle");
    renderStatus();
    if (getSelectedStreamEntries().length === 0) {
      renderEmptyState();
    }
  });

  window.addEventListener("dss:flight-log-reset", () => {
    streamEntriesById.clear();
    streamPhaseById.clear();
    latestStatusMessage = "";
    renderStatus();
    renderEmptyState();
  });

  window.addEventListener("dss:app-mode-change", () => {
    if (!isVisibleStreamId(selectedStreamId)) {
      selectedStreamId = getFirstVisibleStreamId();
    }
    renderStreamSelector();
    renderStatus();
    renderSelectedStreamEntries();
  });
}
