const EARTH_METERS_PER_DEGREE_LAT = 111320;
const DEFAULT_MAX_FLIGHT_TIME_MIN = 28;
const DEFAULT_MAX_HORIZONTAL_SPEED_MPS = 26;
const ANALYSIS_RENDER_INTERVAL_MS = 180;
const LIVE_STREAM_ID = "live-vehicle";

let activeStreamConfigs = [];
let primaryStreamId = null;
const analysisStateByStream = new Map();
let analysisRenderTimerId = null;

function getElement(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = getElement(id);
  if (element) {
    element.textContent = value;
  }
}

function formatSeconds(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) {
    return "-";
  }
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)}km` : `${meters.toFixed(1)}m`;
}

function metersPerDegreeLon(lat) {
  return EARTH_METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
}

function calculateHorizontalDistanceM(startPoint, endPoint) {
  const averageLat = (startPoint.lat + endPoint.lat) / 2;
  const northM = (endPoint.lat - startPoint.lat) * EARTH_METERS_PER_DEGREE_LAT;
  const eastM = (endPoint.lon - startPoint.lon) * metersPerDegreeLon(averageLat);
  return Math.hypot(northM, eastM);
}

function createAnalysisState(streamConfig) {
  return {
    streamConfig,
    startTimestampMs: null,
    lastTimestampMs: null,
    lastPoint: null,
    lastAltM: null,
    elapsedSeconds: 0,
    totalDistanceM: 0,
    altitudeTimeMSeconds: 0,
    altitudeSampleSeconds: 0,
    batteryEnergySeconds: 0,
    batteryPct: 100,
    actualBatteryPct: null,
    liveHeartbeatSeen: false,
    modeLabel: streamConfig.enabled ? "대기" : "연결 안 됨",
  };
}

function isLiveStreamState(state) {
  return state?.streamConfig?.streamId === LIVE_STREAM_ID;
}

function getStreamState(streamId) {
  const streamConfig = activeStreamConfigs.find((candidate) => candidate.streamId === streamId);
  if (!analysisStateByStream.has(streamId)) {
    analysisStateByStream.set(streamId, createAnalysisState(streamConfig ?? {
      streamId,
      streamLabel: streamId,
      enabled: true,
    }));
  }

  return analysisStateByStream.get(streamId);
}

function getPrimaryState() {
  const fallbackStreamId = primaryStreamId ?? activeStreamConfigs.find((config) => config.enabled)?.streamId ?? null;
  return fallbackStreamId ? analysisStateByStream.get(fallbackStreamId) ?? null : null;
}

function updateBatteryState(state, detail, deltaSeconds) {
  if (isLiveStreamState(state)) {
    return;
  }

  const maxFlightSeconds = Math.max(
    60,
    Number(state.streamConfig.maxFlightTimeMin ?? DEFAULT_MAX_FLIGHT_TIME_MIN) * 60,
  );
  const maxHorizontalSpeedMps = Math.max(
    1,
    Number(state.streamConfig.maxHorizontalSpeedMps ?? DEFAULT_MAX_HORIZONTAL_SPEED_MPS),
  );
  const speedRatio = Math.max(0, Number(detail.speed_mps) || 0) / maxHorizontalSpeedMps;
  const verticalSpeedMps = (
    state.lastAltM === null || deltaSeconds <= 0
      ? 0
      : Math.abs((Number(detail.alt_m) - state.lastAltM) / deltaSeconds)
  );
  const accelMps2 = Math.abs(Number(detail.accel_mps2) || 0);
  const loadFactor = 1 + (speedRatio * 0.55) + (verticalSpeedMps * 0.08) + (accelMps2 * 0.035);

  state.batteryEnergySeconds += deltaSeconds * Math.max(0.5, loadFactor);
  state.batteryPct = Math.max(0, 100 - ((state.batteryEnergySeconds / maxFlightSeconds) * 100));
}

function updateAnalysisFromTelemetry(detail) {
  if (!detail?.streamId) {
    return;
  }

  const state = getStreamState(detail.streamId);
  const effectiveTimestampMs = Number.isFinite(detail.timestampMs)
    ? detail.timestampMs
    : (() => {
      const parsedTimestampMs = Date.parse(detail.timestamp);
      return Number.isNaN(parsedTimestampMs) ? Date.now() : parsedTimestampMs;
    })();

  if (state.startTimestampMs === null) {
    state.startTimestampMs = effectiveTimestampMs;
  }

  const deltaSeconds = state.lastTimestampMs === null
    ? 0
    : Math.max(0, (effectiveTimestampMs - state.lastTimestampMs) / 1000);
  state.elapsedSeconds = Math.max(0, (effectiveTimestampMs - state.startTimestampMs) / 1000);
  state.lastTimestampMs = effectiveTimestampMs;

  const currentPoint = {
    lat: detail.lat,
    lon: detail.lon,
  };
  if (state.lastPoint !== null) {
    state.totalDistanceM += calculateHorizontalDistanceM(state.lastPoint, currentPoint);
  }
  state.lastPoint = currentPoint;

  const currentAltM = Number(detail.alt_m) || 0;
  if (state.lastAltM !== null && deltaSeconds > 0) {
    state.altitudeTimeMSeconds += ((state.lastAltM + currentAltM) / 2) * deltaSeconds;
    state.altitudeSampleSeconds += deltaSeconds;
  }

  updateBatteryState(state, detail, deltaSeconds);
  state.lastAltM = currentAltM;

  if (detail.streamId === primaryStreamId || detail.isPrimary) {
    scheduleAnalysisRender();
  }
}

function updateFlightMode(detail) {
  if (!detail?.streamId || !detail?.modeLabel) {
    return;
  }

  const state = getStreamState(detail.streamId);
  state.modeLabel = detail.modeLabel;
  if (detail.streamId === primaryStreamId) {
    scheduleAnalysisRender();
  }
}

function updateAnalysisFromLiveStatus(detail) {
  if (!detail?.streamId) {
    return;
  }

  const state = getStreamState(detail.streamId);
  state.liveHeartbeatSeen = Boolean(detail.heartbeat_seen);
  if (Number.isFinite(detail.battery_remaining_pct)) {
    state.actualBatteryPct = Number(detail.battery_remaining_pct);
  }

  if (typeof detail.mode_label === "string" && detail.mode_label.trim()) {
    state.modeLabel = detail.mode_label.trim();
  }

  if (detail.streamId === primaryStreamId) {
    scheduleAnalysisRender();
  }
}

function resetAnalysisState() {
  if (analysisRenderTimerId !== null) {
    window.clearTimeout(analysisRenderTimerId);
    analysisRenderTimerId = null;
  }
  for (const streamConfig of activeStreamConfigs) {
    analysisStateByStream.set(streamConfig.streamId, createAnalysisState(streamConfig));
  }
  renderAnalysisPanel();
}

function scheduleAnalysisRender() {
  if (analysisRenderTimerId !== null) {
    return;
  }

  analysisRenderTimerId = window.setTimeout(() => {
    analysisRenderTimerId = null;
    renderAnalysisPanel();
  }, ANALYSIS_RENDER_INTERVAL_MS);
}

function renderAnalysisPanel() {
  const state = getPrimaryState();
  if (!state || !state.streamConfig.enabled) {
    setText("flight-mode-status", "대기");
    setText("flight-battery-status", "-");
    setText("flight-summary-duration", "0s");
    setText("flight-summary-distance", "0.0m");
    setText("flight-summary-avg-alt", "0.0m");
    setText("flight-summary-avg-speed", "0.0m/s");
    return;
  }

  const averageAltM = state.altitudeSampleSeconds > 0
    ? state.altitudeTimeMSeconds / state.altitudeSampleSeconds
    : state.lastAltM ?? 0;
  const averageSpeedMps = state.elapsedSeconds > 0
    ? state.totalDistanceM / state.elapsedSeconds
    : 0;
  const liveStream = isLiveStreamState(state);
  const modeLabel = liveStream
    ? state.modeLabel || (state.liveHeartbeatSeen ? "-" : "대기")
    : state.modeLabel;
  const batteryLabel = liveStream
    ? Number.isFinite(state.actualBatteryPct)
      ? `${state.actualBatteryPct.toFixed(1)}%`
      : "-"
    : `${(state.actualBatteryPct ?? state.batteryPct).toFixed(1)}%`;

  setText("flight-mode-status", modeLabel);
  setText("flight-battery-status", batteryLabel);
  setText("flight-summary-duration", formatSeconds(state.elapsedSeconds));
  setText("flight-summary-distance", formatDistance(state.totalDistanceM));
  setText("flight-summary-avg-alt", `${averageAltM.toFixed(1)}m`);
  setText("flight-summary-avg-speed", `${averageSpeedMps.toFixed(1)}m/s`);
}

export function initializeSimulationAnalysis() {
  window.addEventListener("dss:telemetry", (event) => {
    updateAnalysisFromTelemetry(event.detail);
  });

  window.addEventListener("dss:flight-mode-change", (event) => {
    updateFlightMode(event.detail);
  });

  window.addEventListener("dss:live-status", (event) => {
    updateAnalysisFromLiveStatus(event.detail);
  });

  window.addEventListener("dss:live-status-reset", () => {
    const liveState = analysisStateByStream.get(LIVE_STREAM_ID);
    if (!liveState) {
      renderAnalysisPanel();
      return;
    }

    liveState.actualBatteryPct = null;
    liveState.liveHeartbeatSeen = false;
    liveState.modeLabel = liveState.streamConfig.enabled ? "대기" : "연결 안 됨";
    renderAnalysisPanel();
  });

  window.addEventListener("dss:telemetry-reset", () => {
    resetAnalysisState();
  });

  renderAnalysisPanel();
}

export async function syncSimulationAnalysisStreams(streamConfigs) {
  activeStreamConfigs = streamConfigs;
  primaryStreamId = streamConfigs.find((streamConfig) => streamConfig.isPrimary)?.streamId
    ?? streamConfigs.find((streamConfig) => streamConfig.enabled)?.streamId
    ?? null;

  const nextStreamIds = new Set(streamConfigs.map((streamConfig) => streamConfig.streamId));
  for (const streamId of Array.from(analysisStateByStream.keys())) {
    if (!nextStreamIds.has(streamId)) {
      analysisStateByStream.delete(streamId);
    }
  }

  streamConfigs.forEach((streamConfig) => {
    const previousState = analysisStateByStream.get(streamConfig.streamId);
    analysisStateByStream.set(streamConfig.streamId, {
      ...(previousState ?? createAnalysisState(streamConfig)),
      streamConfig,
    });
    if (!streamConfig.enabled) {
      analysisStateByStream.set(streamConfig.streamId, createAnalysisState(streamConfig));
    }
  });

  renderAnalysisPanel();
}
