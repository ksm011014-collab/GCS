import { loadReplayLogDetail, loadReplayLogs } from "./api_client.js?v=2";

export const REPLAY_STREAM_ID = "replay-log";
export const REPLAY_STREAM_LABEL = "리플레이";
export const REPLAY_STREAM_VISUAL = {
  strokeColor: "#8a63ff",
  fillColor: "#8a63ff",
};

let replayLogs = [];
let selectedReplayLogId = "";
let selectedReplayDetail = null;
let replayTimerId = null;
let replayCursor = 0;
let replaySelectedSampleIndex = -1;
let replayPlaying = false;
let replayLocalLogSequence = 0;
const replayLocalLogsById = new Map();
const REPLAY_LOG_VISIBLE_ENTRY_COUNT = 80;
const LEGACY_FLIGHT_MODE_LABELS = {
  수동비행: "ATTITUDE",
  자동비행: "GPS",
  자동호버: "GPS",
  임무종료: "IDLE",
};

function getElement(id) {
  return document.getElementById(id);
}

function getCurrentPanelTab() {
  return document.body?.dataset.panelTab ?? "simulation";
}

function isReplayTabActive() {
  return getCurrentPanelTab() === "replay";
}

function getReplaySpeedMultiplier() {
  const speedSelect = getElement("replay-speed-select");
  if (!(speedSelect instanceof HTMLSelectElement)) {
    return 1;
  }

  const speed = Number(speedSelect.value);
  return Number.isFinite(speed) && speed > 0 ? speed : 1;
}

function formatDuration(durationSeconds) {
  const totalSeconds = Math.max(0, Math.round(Number(durationSeconds) || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function formatUtcTimestamp(timestamp) {
  if (!timestamp) {
    return "-";
  }

  const parsedTimestamp = Date.parse(timestamp);
  if (Number.isNaN(parsedTimestamp)) {
    return timestamp;
  }

  const date = new Date(parsedTimestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
}

function formatReplaySampleTimestamp(timestamp) {
  if (!timestamp) {
    return "-";
  }

  const parsedTimestamp = Date.parse(timestamp);
  if (Number.isNaN(parsedTimestamp)) {
    return timestamp;
  }

  const date = new Date(parsedTimestamp);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function normalizeModeToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeFlightModeLabel(modeLabel) {
  const rawLabel = String(modeLabel ?? "").trim();
  if (!rawLabel) {
    return "MANUAL";
  }

  if (LEGACY_FLIGHT_MODE_LABELS[rawLabel]) {
    return LEGACY_FLIGHT_MODE_LABELS[rawLabel];
  }

  const normalizedKey = normalizeModeToken(rawLabel);
  if (!normalizedKey) {
    return "MANUAL";
  }

  if (
    ["rth", "rtl", "return_home", "smart_rtl", "return", "return_to_launch"].includes(normalizedKey)
    || normalizedKey.includes("rtl")
    || normalizedKey.includes("return")
  ) {
    return "RTH";
  }

  if (normalizedKey.includes("land")) {
    return "LAND";
  }

  if (
    ["gps", "loiter", "poshold", "position", "posctl", "hold", "brake"].includes(normalizedKey)
    || normalizedKey.startsWith("pos")
    || normalizedKey.includes("loiter")
    || normalizedKey.includes("guided")
  ) {
    return "GPS";
  }

  if (
    ["auto", "mission", "takeoff", "take_off"].includes(normalizedKey)
    || normalizedKey.startsWith("auto")
    || normalizedKey.startsWith("mission")
    || normalizedKey.includes("takeoff")
  ) {
    return "AUTO";
  }

  if (
    ["manual", "acro"].includes(normalizedKey)
    || normalizedKey.startsWith("manual")
    || normalizedKey.startsWith("acro")
  ) {
    return "MANUAL";
  }

  if (
    ["attitude", "stabilize", "stabilized", "stabilise", "sport"].includes(normalizedKey)
    || normalizedKey.startsWith("stabil")
    || normalizedKey.includes("attitude")
  ) {
    return "ATTITUDE";
  }

  if (
    ["altitude", "alt_hold", "althold", "altctl", "altitude_hold"].includes(normalizedKey)
    || normalizedKey.startsWith("alt")
  ) {
    return "ALTITUDE";
  }

  if (["idle", "complete", "mission_end"].includes(normalizedKey)) {
    return "IDLE";
  }

  return rawLabel.toUpperCase();
}

function normalizeReplaySample(sample) {
  return {
    ...sample,
    flight_mode: normalizeFlightModeLabel(sample.flight_mode),
  };
}

function normalizeReplayDetail(replayDetail) {
  if (!replayDetail || !Array.isArray(replayDetail.samples)) {
    return replayDetail;
  }

  return {
    ...replayDetail,
    samples: replayDetail.samples.map((sample) => normalizeReplaySample(sample)),
  };
}

function createReplaySummaryFromDetail(replayDetail) {
  return {
    log_id: replayDetail.log_id,
    filename: replayDetail.filename,
    drone_name: replayDetail.drone_name,
    scenario_key: replayDetail.scenario_key,
    scenario_name: replayDetail.scenario_name,
    sample_count: replayDetail.sample_count,
    started_at_utc: replayDetail.started_at_utc,
    ended_at_utc: replayDetail.ended_at_utc,
    duration_seconds: replayDetail.duration_seconds,
  };
}

function parseCsvLine(line) {
  const values = [];
  let currentValue = "";
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const currentCharacter = line[index];
    const nextCharacter = line[index + 1] ?? "";

    if (insideQuotes && currentCharacter === '"' && nextCharacter === '"') {
      currentValue += '"';
      index += 1;
      continue;
    }

    if (currentCharacter === '"') {
      insideQuotes = !insideQuotes;
      continue;
    }

    if (currentCharacter === "," && !insideQuotes) {
      values.push(currentValue);
      currentValue = "";
      continue;
    }

    currentValue += currentCharacter;
  }

  values.push(currentValue);
  return values;
}

function normalizeCsvNumericValue(value) {
  return String(value ?? "")
    .trim()
    .replace(/^="/, "")
    .replace(/"$/, "");
}

function normalizeReplayTimestamp(timestampText) {
  const parsedTimestamp = Date.parse(timestampText);
  return Number.isNaN(parsedTimestamp) ? timestampText : new Date(parsedTimestamp).toISOString();
}

function buildReplayDetailFromCsvText(filename, csvText) {
  const lines = csvText
    .split(/\r?\n/u)
    .map((line) => line.trim());
  const csvLines = lines.filter((line) => line && !line.startsWith("#"));
  if (csvLines.length <= 1) {
    throw new Error("CSV에 재생 가능한 데이터가 없습니다.");
  }

  const headerColumns = parseCsvLine(csvLines[0]).map((column) => column.trim());
  const replaySamples = csvLines.slice(1).map((line, index) => {
    const rowValues = parseCsvLine(line);
    const row = Object.fromEntries(
      headerColumns.map((column, columnIndex) => [column, rowValues[columnIndex] ?? ""]),
    );
    const timestampText = row.timestamp_utc || row.timestamp_kst || "";

    return {
      sample_index: Number(row.sample_index || index),
      timestamp_utc: normalizeReplayTimestamp(timestampText || row.timestamp || row.time_stamp || ""),
      elapsed_ms: Number(row.elapsed_ms || index * 50),
      drone: row.drone || "",
      scenario: row.scenario || "",
      flight_mode: normalizeFlightModeLabel(row.flight_mode || "MANUAL"),
      lat_deg: Number(normalizeCsvNumericValue(row.lat_deg || row.lat)),
      lon_deg: Number(normalizeCsvNumericValue(row.lon_deg || row.lon)),
      alt_m: Number(normalizeCsvNumericValue(row.alt_m)),
      speed_mps: Number(normalizeCsvNumericValue(row.speed_mps || row.velocity)),
      accel_mps2: Number(normalizeCsvNumericValue(row.accel_mps2)),
    };
  }).filter((sample) => Number.isFinite(sample.lat_deg) && Number.isFinite(sample.lon_deg));

  if (replaySamples.length === 0) {
    throw new Error("CSV에서 유효한 텔레메트리 샘플을 찾지 못했습니다.");
  }

  replayLocalLogSequence += 1;
  const firstSample = replaySamples[0];
  const lastSample = replaySamples[replaySamples.length - 1];
  return {
    log_id: `local-${Date.now()}-${replayLocalLogSequence}`,
    filename,
    drone_name: firstSample.drone || "기록된 기체",
    scenario_key: firstSample.scenario || "",
    scenario_name: firstSample.scenario || "가져온 CSV",
    sample_count: replaySamples.length,
    started_at_utc: firstSample.timestamp_utc,
    ended_at_utc: lastSample.timestamp_utc,
    duration_seconds: Math.max(0, (lastSample.elapsed_ms - firstSample.elapsed_ms) / 1000),
    samples: replaySamples,
  };
}

function getLocalReplaySummaries() {
  return Array.from(replayLocalLogsById.values())
    .map((replayDetail) => createReplaySummaryFromDetail(replayDetail))
    .sort((leftLog, rightLog) => String(rightLog.started_at_utc || "").localeCompare(String(leftLog.started_at_utc || "")));
}

function updateReplayLogCollection(remoteReplayLogs = []) {
  replayLogs = [
    ...getLocalReplaySummaries(),
    ...remoteReplayLogs.filter((remoteReplayLog) => !replayLocalLogsById.has(remoteReplayLog.log_id)),
  ];
}

function storeLocalReplayDetail(replayDetail) {
  replayLocalLogsById.set(replayDetail.log_id, normalizeReplayDetail(replayDetail));
  updateReplayLogCollection(replayLogs.filter((replayLog) => !replayLocalLogsById.has(replayLog.log_id)));
}

function buildReplayStreamConfig(replayDetail) {
  if (!replayDetail) {
    return [];
  }

  return [{
    streamId: REPLAY_STREAM_ID,
    streamLabel: REPLAY_STREAM_LABEL,
    droneKey: "inspire_3",
    scenarioKey: replayDetail.scenario_key,
    scenarioName: replayDetail.scenario_name,
    displayName: replayDetail.drone_name || "기록된 기체",
    slotIndex: 0,
    isPrimary: true,
    enabled: true,
    visual: REPLAY_STREAM_VISUAL,
    maxHorizontalSpeedMps: null,
    maxFlightTimeMin: null,
  }];
}

function getReplaySampleCount() {
  return selectedReplayDetail?.samples?.length ?? 0;
}

function getReplayProgressPercent() {
  const sampleCount = getReplaySampleCount();
  if (sampleCount <= 0 || replaySelectedSampleIndex < 0) {
    return 0;
  }

  return ((replaySelectedSampleIndex + 1) / sampleCount) * 100;
}

function emitReplaySelectionChange() {
  window.dispatchEvent(new CustomEvent("dss:replay-selection-change", {
    detail: {
      logId: selectedReplayLogId,
      replayDetail: selectedReplayDetail,
      streamConfigs: buildReplayStreamConfig(selectedReplayDetail),
      scenarioKey: selectedReplayDetail?.scenario_key ?? "",
    },
  }));
}

function emitReplayStateChange() {
  window.dispatchEvent(new CustomEvent("dss:replay-playback-state", {
    detail: {
      logId: selectedReplayLogId,
      loaded: Boolean(selectedReplayDetail),
      playing: replayPlaying,
      cursor: replayCursor,
      sampleCount: getReplaySampleCount(),
      selectedSampleIndex: replaySelectedSampleIndex,
      progressPercent: getReplayProgressPercent(),
    },
  }));
}

function renderReplayStatus(message) {
  const statusElement = getElement("replay-status");
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function renderReplayMeta() {
  const metaElement = getElement("replay-meta");
  if (!metaElement) {
    return;
  }

  if (!selectedReplayDetail) {
    metaElement.innerHTML = `
      <div class="live-summary-row"><span class="live-summary-key">상태</span><span class="live-summary-value">로그 미선택</span></div>
      <div class="live-summary-row"><span class="live-summary-key">재생 시간</span><span class="live-summary-value">-</span></div>
      <div class="live-summary-row"><span class="live-summary-key">샘플 수</span><span class="live-summary-value">-</span></div>
      <div class="live-summary-row"><span class="live-summary-key">시나리오</span><span class="live-summary-value">-</span></div>
    `;
    return;
  }

  metaElement.innerHTML = `
    <div class="live-summary-row"><span class="live-summary-key">기체</span><span class="live-summary-value">${selectedReplayDetail.drone_name || "-"}</span></div>
    <div class="live-summary-row"><span class="live-summary-key">시나리오</span><span class="live-summary-value">${selectedReplayDetail.scenario_name || selectedReplayDetail.scenario_key || "-"}</span></div>
    <div class="live-summary-row"><span class="live-summary-key">샘플 수</span><span class="live-summary-value">${selectedReplayDetail.sample_count}</span></div>
    <div class="live-summary-row"><span class="live-summary-key">재생 시간</span><span class="live-summary-value">${formatDuration(selectedReplayDetail.duration_seconds)}</span></div>
    <div class="live-summary-row"><span class="live-summary-key">시작 시각</span><span class="live-summary-value">${formatUtcTimestamp(selectedReplayDetail.started_at_utc)}</span></div>
  `;
}

function buildReplayLogEntryMarkup(sample, isCurrentFrame = false) {
  return `
    <div class="csv-log-entry${isCurrentFrame ? " is-current" : ""}">
      ${formatReplaySampleTimestamp(sample.timestamp_utc)} | ${sample.flight_mode} | 위도 ${sample.lat_deg.toFixed(6)} | 경도 ${sample.lon_deg.toFixed(6)} | 고도 ${sample.alt_m.toFixed(1)}m | 속도 ${sample.speed_mps.toFixed(1)}m/s
    </div>
  `;
}

function renderReplayLiveLog() {
  const logElement = getElement("replay-live-log");
  if (!logElement) {
    return;
  }

  if (!selectedReplayDetail?.samples?.length) {
    logElement.innerHTML = '<div class="csv-log-empty">선택된 로그가 없습니다.</div>';
    return;
  }

  if (replaySelectedSampleIndex < 0) {
    logElement.innerHTML = '<div class="csv-log-empty">재생을 시작하면 현재 리플레이 로그가 실시간으로 표시됩니다.</div>';
    return;
  }

  const lastRenderedIndex = Math.min(replaySelectedSampleIndex, selectedReplayDetail.samples.length - 1);
  const firstRenderedIndex = Math.max(0, lastRenderedIndex - REPLAY_LOG_VISIBLE_ENTRY_COUNT + 1);
  const visibleSamples = selectedReplayDetail.samples.slice(firstRenderedIndex, lastRenderedIndex + 1);
  logElement.innerHTML = visibleSamples
    .map((sample, visibleIndex) => buildReplayLogEntryMarkup(
      sample,
      firstRenderedIndex + visibleIndex === lastRenderedIndex,
    ))
    .join("");
  logElement.scrollTop = logElement.scrollHeight;
}

function renderReplayLogSelect() {
  const selectElement = getElement("replay-log-select");
  if (!(selectElement instanceof HTMLSelectElement)) {
    return;
  }

  const previousValue = selectedReplayLogId;
  selectElement.innerHTML = "";
  selectElement.append(new Option("저장된 로그 선택", ""));

  replayLogs.forEach((replayLog) => {
    const optionLabel = `${replayLog.scenario_name || replayLog.scenario_key || "시나리오"} · ${replayLog.drone_name || "기체"} · ${formatUtcTimestamp(replayLog.started_at_utc)}`;
    selectElement.append(new Option(optionLabel, replayLog.log_id, false, replayLog.log_id === previousValue));
  });

  selectElement.value = replayLogs.some((replayLog) => replayLog.log_id === previousValue)
    ? previousValue
    : "";
}

function renderReplayButtons() {
  const playButton = getElement("replay-play-button");
  const pauseButton = getElement("replay-pause-button");
  const resetButton = getElement("replay-reset-button");
  const fileButton = getElement("replay-open-file-button");
  const hasSamples = Boolean(selectedReplayDetail?.samples?.length);

  if (playButton instanceof HTMLButtonElement) {
    playButton.disabled = !hasSamples || replayPlaying;
  }
  if (pauseButton instanceof HTMLButtonElement) {
    pauseButton.disabled = !replayPlaying;
  }
  if (resetButton instanceof HTMLButtonElement) {
    resetButton.disabled = !hasSamples;
  }
  if (fileButton instanceof HTMLButtonElement) {
    fileButton.disabled = false;
  }
}

function syncReplayUi() {
  renderReplayLogSelect();
  renderReplayMeta();
  renderReplayLiveLog();
  renderReplayButtons();
  emitReplayStateChange();
}

function stopReplayTimer() {
  if (replayTimerId !== null) {
    window.clearTimeout(replayTimerId);
    replayTimerId = null;
  }
}

function emitReplayModeChange(sample) {
  const modeLabel = normalizeFlightModeLabel(sample.flight_mode || "MANUAL");
  const modeKey = modeLabel
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "manual";

  window.dispatchEvent(new CustomEvent("dss:flight-mode-change", {
    detail: {
      streamId: REPLAY_STREAM_ID,
      streamLabel: REPLAY_STREAM_LABEL,
      modeKey,
      modeLabel,
      timestamp: sample.timestamp_utc,
    },
  }));
}

function emitReplayTelemetrySample(sample, { includeProgress = true } = {}) {
  window.dispatchEvent(new CustomEvent("dss:telemetry", {
    detail: {
      streamId: REPLAY_STREAM_ID,
      streamLabel: REPLAY_STREAM_LABEL,
      isPrimary: true,
      slotIndex: 0,
      drone: sample.drone,
      scenario: sample.scenario,
      timestamp: sample.timestamp_utc,
      lat: sample.lat_deg,
      lon: sample.lon_deg,
      alt_m: sample.alt_m,
      speed_mps: sample.speed_mps,
      accel_mps2: sample.accel_mps2,
    },
  }));

  if (includeProgress) {
    emitReplayProgressForSampleIndex(replaySelectedSampleIndex);
  }
}

function emitReplayProgressForSampleIndex(sampleIndex, { completed = false } = {}) {
  const sampleCount = Math.max(getReplaySampleCount(), 1);
  const normalizedSampleIndex = Number.isFinite(sampleIndex) ? Number(sampleIndex) : -1;
  const progressPercent = completed
    ? 100
    : normalizedSampleIndex < 0
      ? 0
      : ((normalizedSampleIndex + 1) / sampleCount) * 100;

  window.dispatchEvent(new CustomEvent("dss:progress", {
    detail: {
      streamId: REPLAY_STREAM_ID,
      streamLabel: REPLAY_STREAM_LABEL,
      isPrimary: true,
      progress_pct: progressPercent,
      completed,
    },
  }));
}

function rebuildReplayViewport(targetSampleIndex, { emitResetEvent = true } = {}) {
  const samples = selectedReplayDetail?.samples ?? [];
  if (emitResetEvent && isReplayTabActive()) {
    window.dispatchEvent(new CustomEvent("dss:telemetry-reset"));
  }

  if (samples.length === 0 || targetSampleIndex < 0) {
    replayCursor = 0;
    replaySelectedSampleIndex = -1;
    emitReplayProgressForSampleIndex(-1);
    renderReplayLiveLog();
    renderReplayButtons();
    emitReplayStateChange();
    return;
  }

  const lastSampleIndex = Math.min(targetSampleIndex, samples.length - 1);
  for (let sampleIndex = 0; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
    const sample = samples[sampleIndex];
    const previousSample = sampleIndex > 0 ? samples[sampleIndex - 1] : null;
    if (!previousSample || previousSample.flight_mode !== sample.flight_mode) {
      emitReplayModeChange(sample);
    }

    replaySelectedSampleIndex = sampleIndex;
    emitReplayTelemetrySample(sample, { includeProgress: false });
  }

  replayCursor = Math.min(lastSampleIndex + 1, samples.length);
  emitReplayProgressForSampleIndex(lastSampleIndex);
  renderReplayLiveLog();
  renderReplayButtons();
  emitReplayStateChange();
}

function completeReplayPlayback() {
  stopReplayTimer();
  replayPlaying = false;
  if (selectedReplayDetail?.samples?.length) {
    replayCursor = selectedReplayDetail.samples.length;
    replaySelectedSampleIndex = selectedReplayDetail.samples.length - 1;
  }
  emitReplayProgressForSampleIndex(replaySelectedSampleIndex, { completed: true });
  window.dispatchEvent(new CustomEvent("dss:log", {
    detail: {
      streamId: REPLAY_STREAM_ID,
      streamLabel: REPLAY_STREAM_LABEL,
      message: "리플레이 재생 완료",
      timestamp: new Date().toISOString(),
    },
  }));
  renderReplayStatus("리플레이 완료");
  renderReplayLiveLog();
  renderReplayButtons();
  emitReplayStateChange();
}

function playReplayFrame() {
  if (!replayPlaying || !selectedReplayDetail?.samples?.length) {
    return;
  }

  const samples = selectedReplayDetail.samples;
  if (replayCursor >= samples.length) {
    completeReplayPlayback();
    return;
  }

  const currentSample = samples[replayCursor];
  const previousSample = replayCursor > 0 ? samples[replayCursor - 1] : null;
  if (!previousSample || previousSample.flight_mode !== currentSample.flight_mode) {
    emitReplayModeChange(currentSample);
  }
  replaySelectedSampleIndex = replayCursor;
  emitReplayTelemetrySample(currentSample);

  replayCursor += 1;
  renderReplayStatus(`재생 중 · ${replaySelectedSampleIndex + 1} / ${samples.length}`);
  renderReplayLiveLog();
  emitReplayStateChange();

  if (replayCursor >= samples.length) {
    completeReplayPlayback();
    return;
  }

  const nextSample = samples[replayCursor];
  const baseDelayMs = Math.max(40, nextSample.elapsed_ms - currentSample.elapsed_ms);
  const delayMs = Math.min(1200, Math.max(30, baseDelayMs / getReplaySpeedMultiplier()));
  replayTimerId = window.setTimeout(playReplayFrame, delayMs);
}

function resetReplayPlayback({
  clearPlaybackData = true,
  preserveSelection = true,
  emitResetEvent = true,
} = {}) {
  stopReplayTimer();
  replayPlaying = false;
  replayCursor = 0;
  replaySelectedSampleIndex = -1;
  if (!preserveSelection) {
    selectedReplayLogId = "";
    selectedReplayDetail = null;
  } else if (clearPlaybackData && selectedReplayDetail) {
    renderReplayStatus("리플레이 준비됨");
  }

  if (emitResetEvent && isReplayTabActive()) {
    window.dispatchEvent(new CustomEvent("dss:telemetry-reset"));
  }

  renderReplayLiveLog();
  renderReplayButtons();
  emitReplayStateChange();
}

async function handleReplayLogSelection(logId) {
  selectedReplayLogId = logId;
  if (!logId) {
    selectedReplayDetail = null;
    resetReplayPlayback({ preserveSelection: true, emitResetEvent: isReplayTabActive() });
    renderReplayStatus("저장된 로그를 선택하세요.");
    emitReplaySelectionChange();
    syncReplayUi();
    return;
  }

  resetReplayPlayback({ preserveSelection: true, emitResetEvent: false });
  renderReplayStatus("로그 불러오는 중...");

  try {
    if (replayLocalLogsById.has(logId)) {
      selectedReplayDetail = replayLocalLogsById.get(logId) ?? null;
    } else {
      selectedReplayDetail = normalizeReplayDetail(await loadReplayLogDetail(logId));
    }
    replayCursor = 0;
    replaySelectedSampleIndex = -1;
    renderReplayStatus("리플레이 준비됨");
    emitReplaySelectionChange();
    if (isReplayTabActive()) {
      window.dispatchEvent(new CustomEvent("dss:telemetry-reset"));
    }
    syncReplayUi();
  } catch (error) {
    selectedReplayDetail = null;
    renderReplayStatus("리플레이 로그를 불러오지 못했습니다.");
    emitReplaySelectionChange();
    syncReplayUi();
    console.error(error);
  }
}

async function refreshReplayLogs({ restoreSelection = true } = {}) {
  const previousLogId = restoreSelection ? selectedReplayLogId : "";
  renderReplayStatus("저장 로그 목록 불러오는 중...");

  try {
    const remoteReplayLogs = await loadReplayLogs();
    updateReplayLogCollection(remoteReplayLogs);
    renderReplayLogSelect();

    if (previousLogId && replayLogs.some((replayLog) => replayLog.log_id === previousLogId)) {
      await handleReplayLogSelection(previousLogId);
      return;
    }

    if (replayLogs.length === 0) {
      selectedReplayLogId = "";
      selectedReplayDetail = null;
      renderReplayStatus("저장된 완료 로그가 없습니다.");
      emitReplaySelectionChange();
      syncReplayUi();
      return;
    }

    renderReplayStatus("저장된 로그를 선택하세요.");
    syncReplayUi();
  } catch (error) {
    updateReplayLogCollection([]);
    selectedReplayLogId = "";
    selectedReplayDetail = null;
    renderReplayStatus("리플레이 로그 목록을 불러오지 못했습니다.");
    emitReplaySelectionChange();
    syncReplayUi();
    console.error(error);
  }
}

async function importReplayCsvFile(file) {
  if (!(file instanceof File)) {
    return;
  }

  renderReplayStatus("CSV 파일 불러오는 중...");
  try {
    const csvText = await file.text();
    const replayDetail = normalizeReplayDetail(buildReplayDetailFromCsvText(file.name, csvText));
    storeLocalReplayDetail(replayDetail);
    selectedReplayLogId = replayDetail.log_id;
    selectedReplayDetail = replayDetail;
    replayCursor = 0;
    replaySelectedSampleIndex = -1;
    resetReplayPlayback({ preserveSelection: true, emitResetEvent: false });
    renderReplayStatus(`CSV 불러오기 완료: ${file.name}`);
    emitReplaySelectionChange();
    if (isReplayTabActive()) {
      window.dispatchEvent(new CustomEvent("dss:telemetry-reset"));
    }
    syncReplayUi();
  } catch (error) {
    renderReplayStatus("CSV 파일을 불러오지 못했습니다.");
    console.error(error);
  }
}

function importReplayCsvContent({ filename = "가져온_비행로그.csv", csvText = "" } = {}) {
  if (!csvText) {
    return;
  }

  try {
    const replayDetail = normalizeReplayDetail(buildReplayDetailFromCsvText(filename, csvText));
    storeLocalReplayDetail(replayDetail);
    selectedReplayLogId = replayDetail.log_id;
    selectedReplayDetail = replayDetail;
    replayCursor = 0;
    replaySelectedSampleIndex = -1;
    resetReplayPlayback({ preserveSelection: true, emitResetEvent: false });
    renderReplayStatus(`저장 로그 불러오기 완료: ${filename}`);
    emitReplaySelectionChange();
    if (isReplayTabActive()) {
      window.dispatchEvent(new CustomEvent("dss:telemetry-reset"));
    }
    syncReplayUi();
  } catch (error) {
    renderReplayStatus("저장 로그를 리플레이 형식으로 불러오지 못했습니다.");
    console.error(error);
  }
}

function startReplayPlayback() {
  if (!selectedReplayDetail?.samples?.length) {
    renderReplayStatus("재생할 로그가 없습니다.");
    return;
  }

  if (replayCursor >= getReplaySampleCount()) {
    resetReplayPlayback({ preserveSelection: true, emitResetEvent: true });
  }

  if (replaySelectedSampleIndex < 0) {
    window.dispatchEvent(new CustomEvent("dss:telemetry-reset"));
    window.dispatchEvent(new CustomEvent("dss:log", {
      detail: {
        streamId: REPLAY_STREAM_ID,
        streamLabel: REPLAY_STREAM_LABEL,
        message: `리플레이 시작: ${selectedReplayDetail.filename}`,
        timestamp: new Date().toISOString(),
      },
    }));
  }

  replayPlaying = true;
  renderReplayLiveLog();
  renderReplayButtons();
  emitReplayStateChange();
  playReplayFrame();
}

function pauseReplayPlayback() {
  if (!replayPlaying) {
    return;
  }

  stopReplayTimer();
  replayPlaying = false;
  renderReplayStatus(`일시 정지 · ${Math.max(replaySelectedSampleIndex + 1, 0)} / ${selectedReplayDetail?.samples?.length ?? 0}`);
  renderReplayLiveLog();
  renderReplayButtons();
  emitReplayStateChange();
}

function seekReplayPlaybackByRatio(ratio) {
  if (!selectedReplayDetail?.samples?.length) {
    return;
  }

  const clampedRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
  stopReplayTimer();
  replayPlaying = false;

  const sampleCount = getReplaySampleCount();
  const targetSampleIndex = clampedRatio <= 0
    ? -1
    : Math.min(
      sampleCount - 1,
      Math.max(0, Math.round(clampedRatio * (sampleCount - 1))),
    );

  rebuildReplayViewport(targetSampleIndex, { emitResetEvent: true });
  renderReplayStatus(
    targetSampleIndex < 0
      ? "리플레이 준비됨"
      : `선택 지점 · ${targetSampleIndex + 1} / ${sampleCount}`,
  );
}

function initializeReplayButtons() {
  getElement("replay-refresh-button")?.addEventListener("click", () => {
    void refreshReplayLogs();
  });

  getElement("replay-log-select")?.addEventListener("change", (event) => {
    const logId = event.currentTarget instanceof HTMLSelectElement
      ? event.currentTarget.value
      : "";
    void handleReplayLogSelection(logId);
  });

  getElement("replay-play-button")?.addEventListener("click", startReplayPlayback);
  getElement("replay-pause-button")?.addEventListener("click", pauseReplayPlayback);
  getElement("replay-reset-button")?.addEventListener("click", () => {
    resetReplayPlayback({ preserveSelection: true, emitResetEvent: true });
    renderReplayStatus("리플레이 초기화");
  });
  getElement("replay-open-file-button")?.addEventListener("click", () => {
    getElement("replay-file-input")?.click();
  });
  getElement("replay-file-input")?.addEventListener("change", (event) => {
    const file = event.currentTarget instanceof HTMLInputElement
      ? event.currentTarget.files?.[0]
      : null;
    if (!file) {
      return;
    }

    void importReplayCsvFile(file);
    if (event.currentTarget instanceof HTMLInputElement) {
      event.currentTarget.value = "";
    }
  });

  window.addEventListener("dss:replay-command", (event) => {
    const action = event.detail?.action ?? "";
    if (action === "play") {
      startReplayPlayback();
      return;
    }
    if (action === "pause") {
      pauseReplayPlayback();
      return;
    }
    if (action === "reset") {
      resetReplayPlayback({ preserveSelection: true, emitResetEvent: true });
      renderReplayStatus("리플레이 초기화");
    }
  });

  window.addEventListener("dss:replay-seek-request", (event) => {
    seekReplayPlaybackByRatio(event.detail?.ratio ?? 0);
  });

  window.addEventListener("dss:panel-tab-change", (event) => {
    if (event.detail?.tabName === "replay") {
      void refreshReplayLogs();
      emitReplaySelectionChange();
      if (!selectedReplayDetail) {
        renderReplayStatus(replayLogs.length === 0 ? "저장된 완료 로그가 없습니다." : "저장된 로그를 선택하세요.");
      }
      return;
    }

    if (replayPlaying || replayCursor > 0) {
      resetReplayPlayback({ preserveSelection: true, emitResetEvent: false });
      renderReplayStatus(selectedReplayDetail ? "리플레이 준비됨" : "저장된 로그를 선택하세요.");
    }
  });

  window.addEventListener("dss:flight-log-saved", (event) => {
    importReplayCsvContent({
      filename: event.detail?.filename ?? "비행로그.csv",
      csvText: event.detail?.csvText ?? "",
    });
  });
}

export async function initializeReplayPanel() {
  initializeReplayButtons();
  renderReplayStatus("저장 로그 목록 불러오는 중...");
  syncReplayUi();
  await refreshReplayLogs({ restoreSelection: false });
}
