const EARTH_METERS_PER_DEGREE_LAT = 111320;
const GRAPH_WIDTH = 640;
const GRAPH_HEIGHT = 144;
const GRAPH_PADDING_TOP = 8;
const GRAPH_PADDING_RIGHT = 10;
const GRAPH_PADDING_BOTTOM = 26;
const GRAPH_PADDING_LEFT = 32;
const REPLAY_STREAM_ID = "replay-log";
const GRAPH_SURFACE_COLOR = "var(--graph-surface)";
const GRAPH_FRAME_COLOR = "var(--graph-frame)";
const GRAPH_GRID_COLOR = "var(--graph-grid)";
const GRAPH_AXIS_COLOR = "var(--graph-axis)";
const GRAPH_TEXT_DIM_COLOR = "var(--graph-text-dim)";
const MODE_EVENT_LINE_COLOR = "var(--graph-event-line)";
const MODE_EVENT_TEXT_COLOR = GRAPH_TEXT_DIM_COLOR;
const MAX_GRAPH_SAMPLE_COUNT = 240;
const TELEMETRY_RENDER_INTERVAL_MS = 120;
const GRAPH_METRICS = {
  altitude: {
    label: "고도",
    axisLabel: "고도(m)",
    svgPrefix: "graph-altitude",
    valuePrefix: "metric-value-altitude",
    color: "#4d7cff",
    unit: "m",
    tickStep: 50,
    defaultMax: 200,
    accessor: (sample) => sample.alt_m,
    formatter: (value) => `${value.toFixed(1)}m`,
  },
  speed: {
    label: "속도",
    axisLabel: "속도(m/s)",
    svgPrefix: "graph-speed",
    valuePrefix: "metric-value-speed",
    color: "#c24b4b",
    unit: "m/s",
    tickStep: 5,
    defaultMax: 25,
    accessor: (sample) => sample.speed_mps,
    formatter: (value) => `${value.toFixed(1)}m/s`,
  },
};
const GRAPH_TYPES = Object.keys(GRAPH_METRICS);
const MODE_EVENT_LABELS = {
  MANUAL: "MAN",
  ATTITUDE: "ATT",
  ALTITUDE: "ALT",
  GPS: "GPS",
  AUTO: "AUTO",
  RTH: "RTH",
  LAND: "LAND",
  IDLE: "END",
  수동비행: "ATT",
  자동비행: "GPS",
  자동호버: "GPS",
  임무종료: "END",
};

const telemetryStateByStream = new Map();
let activeStreamConfigs = [];
let visibleTelemetryStreamIds = new Set();
let telemetryVisibilityInitialized = false;
let userConfiguredTelemetryVisibility = false;
let telemetryRenderTimerId = null;
const pendingMetricRenderStreamIds = new Set();
let pendingPrimaryStatsDetail = null;

function getCurrentAppMode() {
  return document.body?.dataset.appMode === "ground-control" ? "ground-control" : "simulation";
}

function getCurrentPanelTab() {
  return document.body?.dataset.panelTab ?? "simulation";
}

function isVisibleInAppMode(streamId) {
  if (getCurrentPanelTab() === "replay") {
    return streamId === REPLAY_STREAM_ID;
  }

  const isLiveStream = streamId === "live-vehicle";
  return getCurrentAppMode() === "ground-control" ? isLiveStream : !isLiveStream;
}

function setTextContent(elementId, value) {
  const element = document.getElementById(elementId);
  if (element) {
    element.textContent = value;
  }
}

function formatDuration(totalSeconds) {
  return `${Math.max(0, Math.floor(totalSeconds))}s`;
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

function metersPerDegreeLon(lat) {
  return EARTH_METERS_PER_DEGREE_LAT * Math.cos(degreesToRadians(lat));
}

function calculateHorizontalDistanceMeters(previousPoint, nextPoint) {
  const averageLat = (previousPoint.lat + nextPoint.lat) / 2;
  const deltaNorthMeters = (nextPoint.lat - previousPoint.lat) * EARTH_METERS_PER_DEGREE_LAT;
  const deltaEastMeters = (nextPoint.lon - previousPoint.lon) * metersPerDegreeLon(averageLat);
  return Math.hypot(deltaNorthMeters, deltaEastMeters);
}

function getTelemetryTimestampMs(detail) {
  if (Number.isFinite(detail?.timestampMs)) {
    return detail.timestampMs;
  }
  const parsedTimestamp = Date.parse(detail.timestamp);
  return Number.isNaN(parsedTimestamp) ? Date.now() : parsedTimestamp;
}

function formatDistance(totalMeters) {
  if (totalMeters >= 1000) {
    return `${(totalMeters / 1000).toFixed(2)}km`;
  }

  return `${totalMeters.toFixed(1)}m`;
}

function getStreamElementId(prefix, streamId) {
  return `${prefix}-${streamId}`;
}

function getMetricConfig(metricType) {
  return GRAPH_METRICS[metricType];
}

function getMetricSvgElementId(metricType, streamId) {
  return getStreamElementId(getMetricConfig(metricType).svgPrefix, streamId);
}

function getMetricValueElementId(metricType, streamId) {
  return getStreamElementId(getMetricConfig(metricType).valuePrefix, streamId);
}

function createTelemetryState() {
  return {
    startTimestampMs: null,
    totalDistanceMeters: 0,
    lastTelemetryPoint: null,
    lastDetail: null,
    graphSamples: [],
    modeEvents: [],
  };
}

function getStreamState(streamId) {
  if (!telemetryStateByStream.has(streamId)) {
    telemetryStateByStream.set(streamId, createTelemetryState());
  }

  return telemetryStateByStream.get(streamId);
}

function getStreamBadgeValue(streamConfig) {
  const labelMatch = /\d+/.exec(streamConfig.streamLabel ?? "");
  return labelMatch ? labelMatch[0] : String(Math.max(1, (streamConfig.slotIndex ?? 0) + 1));
}

function buildMetricSection(streamConfig, metricType) {
  const config = getMetricConfig(metricType);
  return `
    <section class="drone-metric-section">
      <div class="drone-metric-head">
        <span class="drone-metric-title">${config.label}</span>
        <span id="${getMetricValueElementId(metricType, streamConfig.streamId)}" class="drone-metric-head-value">
          ${config.formatter(0)}
        </span>
      </div>
      <div class="drone-metric-body">
        <svg
          id="${getMetricSvgElementId(metricType, streamConfig.streamId)}"
          class="drone-graph-svg"
          viewBox="0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}"
          preserveAspectRatio="none"
          role="img"
          aria-label="${streamConfig.streamLabel} ${config.label} 그래프"
        ></svg>
      </div>
    </section>
  `;
}

function buildDroneTelemetryCard(streamConfig) {
  return `
    <div class="drone-telem-card${streamConfig.enabled ? "" : " is-disconnected"}" style="--stream-stroke:${streamConfig.visual.strokeColor};">
      <div class="drone-telem-head">
        <div class="drone-telem-title">
          <span class="drone-telem-name">${streamConfig.displayName}</span>
        </div>
        <span class="drone-telem-badge">${getStreamBadgeValue(streamConfig)}</span>
      </div>
      <div class="drone-metric-stack">
        ${buildMetricSection(streamConfig, "altitude")}
        ${buildMetricSection(streamConfig, "speed")}
      </div>
    </div>
  `;
}

function syncVisibleTelemetryStreams(streamConfigs) {
  const enabledStreamIds = new Set(
    streamConfigs
      .filter((streamConfig) => streamConfig.enabled && isVisibleInAppMode(streamConfig.streamId))
      .map((streamConfig) => streamConfig.streamId),
  );

  visibleTelemetryStreamIds = new Set(
    Array.from(visibleTelemetryStreamIds).filter((streamId) => enabledStreamIds.has(streamId)),
  );

  if (!telemetryVisibilityInitialized && visibleTelemetryStreamIds.size === 0) {
    const firstEnabledStreamId = streamConfigs.find(
      (streamConfig) => streamConfig.enabled && isVisibleInAppMode(streamConfig.streamId),
    )?.streamId;
    if (firstEnabledStreamId) {
      visibleTelemetryStreamIds.add(firstEnabledStreamId);
    }
    telemetryVisibilityInitialized = true;
    return;
  }

  if (
    !userConfiguredTelemetryVisibility
    && visibleTelemetryStreamIds.size === 0
  ) {
    const firstEnabledStreamId = streamConfigs.find(
      (streamConfig) => streamConfig.enabled && isVisibleInAppMode(streamConfig.streamId),
    )?.streamId;
    if (firstEnabledStreamId) {
      visibleTelemetryStreamIds.add(firstEnabledStreamId);
    }
  }
}

function renderTelemetryStreamSelector(streamConfigs) {
  const selector = document.getElementById("telemetry-stream-selector");
  if (!selector) {
    return;
  }

  const visibleSelectorStreamConfigs = streamConfigs.filter((streamConfig) => isVisibleInAppMode(streamConfig.streamId));
  selector.innerHTML = visibleSelectorStreamConfigs
    .map((streamConfig) => `
      <button
        type="button"
        class="telemetry-stream-button${visibleTelemetryStreamIds.has(streamConfig.streamId) ? " is-active" : ""}${streamConfig.enabled ? "" : " is-disabled"}"
        data-telemetry-stream-id="${streamConfig.streamId}"
        aria-pressed="${visibleTelemetryStreamIds.has(streamConfig.streamId)}"
        ${streamConfig.enabled ? "" : "disabled"}
      >${streamConfig.streamLabel}</button>
    `)
    .join("");

  selector.querySelectorAll("[data-telemetry-stream-id]").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    button.addEventListener("click", () => {
      const streamId = button.dataset.telemetryStreamId ?? "";
      if (!streamId || button.disabled) {
        return;
      }

      userConfiguredTelemetryVisibility = true;
      if (visibleTelemetryStreamIds.has(streamId)) {
        visibleTelemetryStreamIds.delete(streamId);
      } else {
        visibleTelemetryStreamIds.add(streamId);
      }
      renderTelemetryStreamSelector(activeStreamConfigs);
      renderTelemetryCards();
    });
  });
}

function renderTelemetryCards() {
  const telemetryRow = document.getElementById("telemetry-row");
  if (!telemetryRow) {
    return;
  }

  const visibleStreamConfigs = activeStreamConfigs.filter(
    (streamConfig) => streamConfig.enabled
      && isVisibleInAppMode(streamConfig.streamId)
      && visibleTelemetryStreamIds.has(streamConfig.streamId),
  );

  telemetryRow.innerHTML = `
    <div id="telemetry-stream-selector" class="telemetry-inline-selector telemetry-stream-toolbar"></div>
    <div class="telemetry-card-list">
      ${
        visibleStreamConfigs.length > 0
          ? visibleStreamConfigs.map((streamConfig) => buildDroneTelemetryCard(streamConfig)).join("")
          : '<div class="telemetry-empty">표시할 기체를 선택하세요.</div>'
      }
    </div>
  `;
  renderTelemetryStreamSelector(activeStreamConfigs);
  visibleStreamConfigs.forEach((streamConfig) => {
    hydrateTelemetryCard(streamConfig);
  });
}

function resetOverallStats() {
  setTextContent("stats-flight-time", "0s");
  setTextContent("stats-max-alt", "0.0m");
  setTextContent("stats-max-speed", "0.0 m/s");
  setTextContent("pos-lat", "-");
  setTextContent("pos-lon", "-");
}

function updateMetricValue(metricType, streamId, value) {
  const config = getMetricConfig(metricType);
  setTextContent(getMetricValueElementId(metricType, streamId), config.formatter(value));
}

function applyTelemetryToStreamCard(streamId, detail) {
  updateMetricValue("altitude", streamId, detail.alt_m);
  updateMetricValue("speed", streamId, detail.speed_mps);
}

function resetStreamTelemetryCard(streamId) {
  updateMetricValue("altitude", streamId, 0);
  updateMetricValue("speed", streamId, 0);
  GRAPH_TYPES.forEach((metricType) => {
    renderMetricGraph(metricType, streamId, []);
  });
}

function setDisconnectedMetricValues(streamId) {
  GRAPH_TYPES.forEach((metricType) => {
    setTextContent(getMetricValueElementId(metricType, streamId), "연결 안 됨");
  });
}

function getGraphAxisY() {
  return GRAPH_HEIGHT - GRAPH_PADDING_BOTTOM;
}

function getGraphPlotHeight() {
  return getGraphAxisY() - GRAPH_PADDING_TOP;
}

function buildGraphAxesMarkup(config) {
  const axisY = getGraphAxisY();
  return `
    <rect x="0.5" y="0.5" width="${GRAPH_WIDTH - 1}" height="${GRAPH_HEIGHT - 1}" fill="${GRAPH_SURFACE_COLOR}" stroke="none" />
    <line
      x1="${GRAPH_PADDING_LEFT}"
      y1="${GRAPH_PADDING_TOP}"
      x2="${GRAPH_PADDING_LEFT}"
      y2="${axisY}"
      stroke="${GRAPH_AXIS_COLOR}"
    />
    <line
      x1="${GRAPH_PADDING_LEFT}"
      y1="${axisY}"
      x2="${GRAPH_WIDTH - GRAPH_PADDING_RIGHT}"
      y2="${axisY}"
      stroke="${GRAPH_AXIS_COLOR}"
    />
    <text x="${GRAPH_PADDING_LEFT + 2}" y="${GRAPH_PADDING_TOP + 9}" fill="${GRAPH_TEXT_DIM_COLOR}" font-size="9">
      ${config.axisLabel}
    </text>
    <text x="${GRAPH_WIDTH - GRAPH_PADDING_RIGHT}" y="${axisY - 3}" fill="${GRAPH_TEXT_DIM_COLOR}" font-size="9" text-anchor="end">
      시간(sec)
    </text>
  `;
}

function resolveGraphMaximum(config, samples) {
  const values = samples.map((sample) => config.accessor(sample));
  const actualMaximum = values.length > 0 ? Math.max(...values, 0) : 0;
  const step = Math.max(1, config.tickStep ?? 1);
  return Math.max(
    config.defaultMax ?? step,
    Math.ceil(actualMaximum / step) * step,
    step,
  );
}

function buildGraphGridLinesMarkup(config, graphMaximum) {
  const step = Math.max(1, config.tickStep ?? 1);
  const axisY = getGraphAxisY();
  const plotHeight = getGraphPlotHeight();
  const ticks = [];

  for (let tickValue = step; tickValue <= graphMaximum; tickValue += step) {
    const y = axisY - ((tickValue / graphMaximum) * plotHeight);
    ticks.push(`
      <line
        x1="${GRAPH_PADDING_LEFT}"
        y1="${y.toFixed(2)}"
        x2="${GRAPH_WIDTH - GRAPH_PADDING_RIGHT}"
        y2="${y.toFixed(2)}"
        stroke="${GRAPH_GRID_COLOR}"
      />
      <text
        x="${GRAPH_PADDING_LEFT - 4}"
        y="${y.toFixed(2)}"
        fill="${GRAPH_TEXT_DIM_COLOR}"
        font-size="8"
        text-anchor="end"
        dominant-baseline="middle"
      >${tickValue}</text>
    `);
  }

  ticks.push(`
    <text
      x="${GRAPH_PADDING_LEFT - 4}"
      y="${axisY.toFixed(2)}"
      fill="${GRAPH_TEXT_DIM_COLOR}"
      font-size="8"
      text-anchor="end"
      dominant-baseline="ideographic"
    >0</text>
  `);

  return ticks.join("");
}

function buildGraphPoints(samples, maximum, accessor) {
  const sampleCount = samples.length;
  const axisY = getGraphAxisY();
  const plotHeight = getGraphPlotHeight();

  return samples.map((sample, index) => {
    const x = calculateGraphX(index, sampleCount);
    const y = axisY - ((accessor(sample) / maximum) * plotHeight);
    return {
      x,
      y,
      command: `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`,
    };
  });
}

function calculateGraphX(index, sampleCount) {
  const plotWidth = GRAPH_WIDTH - GRAPH_PADDING_LEFT - GRAPH_PADDING_RIGHT;
  return GRAPH_PADDING_LEFT + (
    plotWidth * (
      sampleCount === 1
        ? 0.5
        : index / (sampleCount - 1)
    )
  );
}

function buildAreaPath(points) {
  if (points.length === 0) {
    return "";
  }

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const axisY = getGraphAxisY();
  return [
    ...points.map((point) => point.command),
    `L ${lastPoint.x.toFixed(2)} ${axisY}`,
    `L ${firstPoint.x.toFixed(2)} ${axisY}`,
    "Z",
  ].join(" ");
}

function renderGraphPlaceholder(metricType, streamId) {
  renderGraphPlaceholderWithMessage(metricType, streamId, "");
}

function renderGraphPlaceholderWithMessage(metricType, streamId, message = "") {
  const config = getMetricConfig(metricType);
  const svgElement = document.getElementById(getMetricSvgElementId(metricType, streamId));
  if (!(svgElement instanceof SVGElement)) {
    return;
  }
  const graphMaximum = resolveGraphMaximum(config, []);

  const textMarkup = message
    ? `
      <text x="${GRAPH_WIDTH / 2}" y="${GRAPH_HEIGHT / 2}" fill="${GRAPH_TEXT_DIM_COLOR}" font-size="12" text-anchor="middle">
        ${message}
      </text>
    `
    : "";

  svgElement.innerHTML = `
    ${buildGraphAxesMarkup(config)}
    ${buildGraphGridLinesMarkup(config, graphMaximum)}
    ${textMarkup}
  `;
}

function getModeEventSampleIndex(samples, timestampMs) {
  const matchIndex = samples.findIndex((sample) => sample.timestampMs >= timestampMs);
  return matchIndex === -1 ? samples.length - 1 : matchIndex;
}

function getModeEventShortLabel(modeLabel) {
  return MODE_EVENT_LABELS[modeLabel] ?? modeLabel;
}

function buildModeEventMarkerMarkup(samples, modeEvents) {
  if (samples.length === 0 || modeEvents.length === 0) {
    return {
      linesMarkup: "",
      labelsMarkup: "",
    };
  }

  const axisY = getGraphAxisY();
  const labelY = axisY + 12;
  let lastLabeledX = -Infinity;
  const lines = [];
  const labels = [];

  modeEvents.forEach((modeEvent, index) => {
    const sampleIndex = getModeEventSampleIndex(samples, modeEvent.timestampMs);
    const x = calculateGraphX(sampleIndex, samples.length);
    const shortLabel = getModeEventShortLabel(modeEvent.modeLabel);
    const estimatedHalfWidth = Math.max(10, shortLabel.length * 6.5);

    lines.push(`
      <line
        x1="${x.toFixed(2)}"
        y1="${GRAPH_PADDING_TOP}"
        x2="${x.toFixed(2)}"
        y2="${axisY}"
        stroke="${MODE_EVENT_LINE_COLOR}"
        stroke-dasharray="3 2"
        stroke-width="1"
      />
    `);

    if (x - lastLabeledX < 24 && index !== modeEvents.length - 1) {
      return;
    }

    lastLabeledX = x;
    let labelX = x;
    let textAnchor = "middle";
    if ((x - estimatedHalfWidth) < GRAPH_PADDING_LEFT) {
      labelX = GRAPH_PADDING_LEFT;
      textAnchor = "start";
    } else if ((x + estimatedHalfWidth) > (GRAPH_WIDTH - GRAPH_PADDING_RIGHT)) {
      labelX = GRAPH_WIDTH - GRAPH_PADDING_RIGHT;
      textAnchor = "end";
    }

    labels.push(`
      <line
        x1="${x.toFixed(2)}"
        y1="${axisY}"
        x2="${x.toFixed(2)}"
        y2="${(labelY - 10).toFixed(2)}"
        stroke="${MODE_EVENT_LINE_COLOR}"
        stroke-width="1"
      />
      <text
        x="${labelX.toFixed(2)}"
        y="${labelY}"
        fill="${MODE_EVENT_TEXT_COLOR}"
        font-size="13"
        text-anchor="${textAnchor}"
        dominant-baseline="hanging"
        style="font-family: var(--font); font-weight: 700;"
      >${shortLabel}</text>
    `);
  });

  return {
    linesMarkup: lines.join(""),
    labelsMarkup: labels.join(""),
  };
}

function renderMetricGraph(metricType, streamId, samples, modeEvents = []) {
  const config = getMetricConfig(metricType);
  const svgElement = document.getElementById(getMetricSvgElementId(metricType, streamId));
  if (!(svgElement instanceof SVGElement)) {
    return;
  }

  if (samples.length === 0) {
    renderGraphPlaceholder(metricType, streamId);
    return;
  }

  const graphMaximum = resolveGraphMaximum(config, samples);
  const points = buildGraphPoints(samples, graphMaximum, config.accessor);
  const lastPoint = points[points.length - 1];
  const { linesMarkup, labelsMarkup } = buildModeEventMarkerMarkup(samples, modeEvents);

  svgElement.innerHTML = `
    ${buildGraphAxesMarkup(config)}
    ${buildGraphGridLinesMarkup(config, graphMaximum)}
    <path
      d="${points.map((point) => point.command).join(" ")}"
      fill="none"
      stroke="${config.color}"
      stroke-width="1.8"
      stroke-linecap="square"
      stroke-linejoin="miter"
    />
    ${linesMarkup}
    ${labelsMarkup}
    <rect x="${(lastPoint.x - 2).toFixed(2)}" y="${(lastPoint.y - 2).toFixed(2)}" width="4" height="4" fill="${config.color}" />
  `;
}

function renderStreamMetrics(streamId, samples, modeEvents = []) {
  GRAPH_TYPES.forEach((metricType) => {
    renderMetricGraph(metricType, streamId, samples, modeEvents);
  });
}

function renderDisconnectedStream(streamId) {
  setDisconnectedMetricValues(streamId);
  GRAPH_TYPES.forEach((metricType) => {
    renderGraphPlaceholderWithMessage(metricType, streamId, "연결 안 됨");
  });
}

function scheduleTelemetryRender() {
  if (telemetryRenderTimerId !== null) {
    return;
  }

  telemetryRenderTimerId = window.setTimeout(() => {
    telemetryRenderTimerId = null;
    flushTelemetryRender();
  }, TELEMETRY_RENDER_INTERVAL_MS);
}

function flushTelemetryRender() {
  pendingMetricRenderStreamIds.forEach((streamId) => {
    const streamState = telemetryStateByStream.get(streamId);
    if (!streamState?.lastDetail) {
      return;
    }

    applyTelemetryToStreamCard(streamId, streamState.lastDetail);
    renderStreamMetrics(streamId, streamState.graphSamples, streamState.modeEvents);
  });
  pendingMetricRenderStreamIds.clear();

  if (!pendingPrimaryStatsDetail) {
    return;
  }

  const detail = pendingPrimaryStatsDetail;
  pendingPrimaryStatsDetail = null;
  const streamState = telemetryStateByStream.get(detail.streamId);
  if (!streamState || streamState.startTimestampMs === null) {
    return;
  }

  const telemetryTimestampMs = getTelemetryTimestampMs(detail);
  const elapsedSeconds = Math.max(0, (telemetryTimestampMs - streamState.startTimestampMs) / 1000);
  const averageSpeed = elapsedSeconds > 0 ? streamState.totalDistanceMeters / elapsedSeconds : 0;

  setTextContent("stats-flight-time", formatDuration(elapsedSeconds));
  setTextContent("stats-max-alt", formatDistance(streamState.totalDistanceMeters));
  setTextContent("stats-max-speed", `${averageSpeed.toFixed(1)} m/s`);
  setTextContent("pos-lat", detail.lat.toFixed(6));
  setTextContent("pos-lon", detail.lon.toFixed(6));
}

function hydrateTelemetryCard(streamConfig) {
  if (!streamConfig.enabled) {
    renderDisconnectedStream(streamConfig.streamId);
    return;
  }

  const streamState = telemetryStateByStream.get(streamConfig.streamId);
  if (!streamState?.lastDetail) {
    resetStreamTelemetryCard(streamConfig.streamId);
    return;
  }

  applyTelemetryToStreamCard(streamConfig.streamId, streamState.lastDetail);
  renderStreamMetrics(streamConfig.streamId, streamState.graphSamples, streamState.modeEvents);
}

function updateTelemetryPanel(detail) {
  const streamState = getStreamState(detail.streamId);
  const telemetryTimestampMs = getTelemetryTimestampMs(detail);
  if (streamState.startTimestampMs === null) {
    streamState.startTimestampMs = telemetryTimestampMs;
  }

  if (streamState.lastTelemetryPoint !== null) {
    streamState.totalDistanceMeters += calculateHorizontalDistanceMeters(streamState.lastTelemetryPoint, detail);
  }

  streamState.lastTelemetryPoint = {
    lat: detail.lat,
    lon: detail.lon,
  };
  streamState.lastDetail = detail;
  streamState.graphSamples.push({
    timestampMs: telemetryTimestampMs,
    alt_m: detail.alt_m,
    speed_mps: detail.speed_mps,
  });
  while (streamState.graphSamples.length > MAX_GRAPH_SAMPLE_COUNT) {
    streamState.graphSamples.shift();
  }

  if (visibleTelemetryStreamIds.has(detail.streamId)) {
    applyTelemetryToStreamCard(detail.streamId, detail);
    pendingMetricRenderStreamIds.add(detail.streamId);
    scheduleTelemetryRender();
  }

  if (!detail.isPrimary) {
    return;
  }
  pendingPrimaryStatsDetail = detail;
  scheduleTelemetryRender();
}

function pruneTelemetryStates(streamConfigs) {
  const activeStreamIds = new Set(streamConfigs.map((streamConfig) => streamConfig.streamId));
  const disabledStreamIds = new Set(
    streamConfigs
      .filter((streamConfig) => !streamConfig.enabled)
      .map((streamConfig) => streamConfig.streamId),
  );

  for (const streamId of Array.from(telemetryStateByStream.keys())) {
    if (!activeStreamIds.has(streamId) || disabledStreamIds.has(streamId)) {
      telemetryStateByStream.delete(streamId);
    }
  }
}

function recordFlightModeChange(detail) {
  if (!detail?.streamId || !detail?.modeKey || !detail?.modeLabel) {
    return;
  }

  const streamState = getStreamState(detail.streamId);
  const lastModeEvent = streamState.modeEvents[streamState.modeEvents.length - 1] ?? null;
  if (lastModeEvent?.modeKey === detail.modeKey) {
    return;
  }

  streamState.modeEvents.push({
    timestampMs: getTelemetryTimestampMs(detail),
    modeKey: detail.modeKey,
    modeLabel: detail.modeLabel,
  });
  while (streamState.modeEvents.length > MAX_GRAPH_SAMPLE_COUNT) {
    streamState.modeEvents.shift();
  }

  if (visibleTelemetryStreamIds.has(detail.streamId) && streamState.graphSamples.length > 0) {
    pendingMetricRenderStreamIds.add(detail.streamId);
    scheduleTelemetryRender();
  }
}

function resetStats() {
  if (telemetryRenderTimerId !== null) {
    window.clearTimeout(telemetryRenderTimerId);
    telemetryRenderTimerId = null;
  }
  pendingMetricRenderStreamIds.clear();
  pendingPrimaryStatsDetail = null;
  telemetryStateByStream.clear();
  resetOverallStats();
  renderTelemetryCards();
}

export function initializeTelemetry() {
  window.addEventListener("dss:telemetry", (event) => {
    updateTelemetryPanel(event.detail);
  });

  window.addEventListener("dss:flight-mode-change", (event) => {
    recordFlightModeChange(event.detail);
  });

  window.addEventListener("dss:telemetry-reset", () => {
    resetStats();
  });

  window.addEventListener("dss:app-mode-change", () => {
    userConfiguredTelemetryVisibility = false;
    syncVisibleTelemetryStreams(activeStreamConfigs);
    renderTelemetryCards();
  });
}

export function syncTelemetryStreams(streamConfigs) {
  activeStreamConfigs = streamConfigs;
  pruneTelemetryStates(streamConfigs);
  syncVisibleTelemetryStreams(streamConfigs);
  resetOverallStats();
  renderTelemetryCards();
}

export { resetStats };
