const API_BASE_URL =
  window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "";

const DEFAULT_HOME = {
  lat: 36.17169469764609,
  lon: 128.46517715736883,
  alt_m: 0,
};

const DEFAULT_STREAM_VISUAL = {
  strokeColor: "#00e5ff",
  fillColor: "#00e5ff",
};
const LIVE_STREAM_ID = "live-vehicle";
const DRONE_ICON_BASE_URL =
  window.location.protocol === "file:"
    ? "./assets/drone-icons"
    : "/frontend/assets/drone-icons";
const DRONE_ICON_IMAGE_URLS = {
  inspire_3: `${DRONE_ICON_BASE_URL}/inspire-3.png`,
  inspire_2: `${DRONE_ICON_BASE_URL}/inspire-2.png`,
  mavic_3_pro: `${DRONE_ICON_BASE_URL}/mavic-3-pro.png`,
  mavic_air_2: `${DRONE_ICON_BASE_URL}/mavic-air-2.png`,
  phantom_4_rtk: `${DRONE_ICON_BASE_URL}/phantom-4-rtk.png`,
};
const AIRSPACE_STATUS_URL =
  window.location.protocol === "file:" ? "http://127.0.0.1:8000/api/airspace-zones/status" : "/api/airspace-zones/status";
const AIRSPACE_ZONES_URL =
  window.location.protocol === "file:" ? "http://127.0.0.1:8000/api/airspace-zones" : "/api/airspace-zones";
const AIRSPACE_ZONE_VISUALS = {
  prohibited: {
    color: "#ff2b2b",
    patternId: "dss-airspace-prohibited-pattern",
    fillAlpha: 0.34,
    lineAlpha: 0.95,
    dashArray: null,
  },
  restricted: {
    color: "#ffb000",
    patternId: "dss-airspace-restricted-pattern",
    fillAlpha: 0.28,
    lineAlpha: 0.85,
    dashArray: "8 5",
  },
};

const MAP_PANES = {
  route: "dss-route-pane",
  airspace: "dss-airspace-pane",
  home: "dss-home-pane",
  waypoint: "dss-waypoint-pane",
  editor: "dss-editor-pane",
  drone: "dss-drone-pane",
};

const MAP_ZOOM_LEVEL = 15;
const FIT_BOUNDS_PADDING = [32, 32];
const PLANNED_ROUTE_STYLE = {
  pane: MAP_PANES.route,
  weight: 2,
  opacity: 0.7,
  dashArray: "6 6",
};
const ACTUAL_ROUTE_STYLE = {
  pane: MAP_PANES.route,
  weight: 3,
  opacity: 0.95,
};
const DRONE_ICON_SIZE_PX = 28;
const HOME_MARKER_STYLE = {
  pane: MAP_PANES.home,
  radius: 6,
  color: "#36ff9b",
  weight: 2,
  fillColor: "#36ff9b",
  fillOpacity: 0.8,
};
const WAYPOINT_MARKER_SIZE_PX = 18;
const EDITOR_ROUTE_STYLE = {
  pane: MAP_PANES.editor,
  weight: 2,
  opacity: 0.95,
  color: "#c7bea2",
  dashArray: "4 4",
};
const DEFAULT_EDITOR_WAYPOINT_ALT_M = 120;
const DEFAULT_EDITOR_WAYPOINT_SPEED_MPS = 8;
const DEFAULT_EDITOR_WAYPOINT_HOLD_SECONDS = 0;
const ADI_ROLL_LIMIT_DEG = 70;
const ADI_PITCH_LIMIT_DEG = 35;
const ADI_PITCH_PIXEL_RANGE = 38;
const ADI_FORWARD_SPEED_PITCH_TRIM_DEG_PER_MPS = 0.55;
const ADI_FORWARD_SPEED_PITCH_TRIM_LIMIT_DEG = 8;
const MAP_PATH_APPEND_INTERVAL_MS = 160;
const MAP_RESIZE_INVALIDATE_DELAY_MS = 90;
const MAP_LAYOUT_SETTLE_HOLD_MS = 220;

let mapInstance = null;
let homeMarker = null;
let primaryStreamId = null;
let selectedAdiStreamId = null;
let initialized = false;
let mapResizeObserver = null;
let airspaceLayer = null;
let airspaceOverlayEnabled = false;
let airspaceFetchTimerId = null;
let latestAirspaceFetchKey = "";
const streamLayers = new Map();
const latestTelemetryByStream = new Map();
const latestAttitudeByStream = new Map();
let pendingTelemetryFrameId = null;
let mapInvalidateTimerId = null;
let mapLayoutSettleReleaseTimerId = null;
let mediaLayoutSettling = false;
let pendingMapHomeRecenter = false;
let scenarioEditorState = {
  enabled: false,
  mode: null,
  sequence: 0,
  home: { ...DEFAULT_HOME },
  waypoints: [],
  selectedWaypointId: null,
};
let editorHomeMarker = null;
let editorRouteLine = null;
let editorWaypointLayer = null;
let adiExpanded = false;

function configurePane(map, paneName, zIndex) {
  const existingPane = map.getPane(paneName);
  const pane = existingPane ?? map.createPane(paneName);
  pane.style.zIndex = String(zIndex);
  return pane;
}

function resolveColorWithAlpha(color, alpha) {
  if (typeof color !== "string") {
    return color;
  }

  const normalized = color.trim();
  const shortHexMatch = /^#([\da-fA-F]{3})$/.exec(normalized);
  if (shortHexMatch) {
    const [red, green, blue] = shortHexMatch[1].split("").map((channel) => channel + channel);
    return `rgba(${parseInt(red, 16)}, ${parseInt(green, 16)}, ${parseInt(blue, 16)}, ${alpha})`;
  }

  const fullHexMatch = /^#([\da-fA-F]{6})$/.exec(normalized);
  if (fullHexMatch) {
    const hex = fullHexMatch[1];
    return `rgba(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)}, ${alpha})`;
  }

  return color;
}

function createSvgElement(tagName) {
  return document.createElementNS("http://www.w3.org/2000/svg", tagName);
}

function ensureAirspacePattern(defs, visual) {
  if (!defs || !visual || defs.querySelector(`#${visual.patternId}`)) {
    return;
  }

  const pattern = createSvgElement("pattern");
  pattern.setAttribute("id", visual.patternId);
  pattern.setAttribute("patternUnits", "userSpaceOnUse");
  pattern.setAttribute("width", "10");
  pattern.setAttribute("height", "10");
  pattern.setAttribute("patternTransform", "rotate(45)");

  const background = createSvgElement("rect");
  background.setAttribute("width", "10");
  background.setAttribute("height", "10");
  background.setAttribute("fill", resolveColorWithAlpha(visual.color, visual.fillAlpha));

  const stripe = createSvgElement("path");
  stripe.setAttribute("d", "M 0 0 L 0 10");
  stripe.setAttribute("stroke", resolveColorWithAlpha(visual.color, visual.lineAlpha));
  stripe.setAttribute("stroke-width", "3");
  stripe.setAttribute("stroke-linecap", "square");

  pattern.appendChild(background);
  pattern.appendChild(stripe);
  defs.appendChild(pattern);
}

function ensureAirspacePatterns(map) {
  const pane = map?.getPane(MAP_PANES.airspace);
  if (!pane) {
    return;
  }

  pane.querySelectorAll("svg").forEach((svg) => {
    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = createSvgElement("defs");
      svg.insertBefore(defs, svg.firstChild);
    }

    Object.values(AIRSPACE_ZONE_VISUALS).forEach((visual) => ensureAirspacePattern(defs, visual));
  });
}

function getAirspaceZoneVisual(zoneType) {
  return AIRSPACE_ZONE_VISUALS[zoneType] ?? AIRSPACE_ZONE_VISUALS.prohibited;
}

function resolveDroneIconImageUrl(droneKey) {
  return DRONE_ICON_IMAGE_URLS[droneKey] ?? DRONE_ICON_IMAGE_URLS.inspire_3;
}

function createDroneIcon(visual, droneKey) {
  const accentColor = visual?.strokeColor ?? DEFAULT_STREAM_VISUAL.strokeColor;
  const accentGlow = resolveColorWithAlpha(accentColor, 0.36);

  return L.divIcon({
    className: "dss-drone-image-icon",
    html: `
      <span class="dss-drone-image-frame" style="--drone-accent-glow: ${accentGlow};">
        <img class="dss-drone-image" src="${resolveDroneIconImageUrl(droneKey)}" alt="" />
      </span>
    `,
    iconSize: [DRONE_ICON_SIZE_PX, DRONE_ICON_SIZE_PX],
    iconAnchor: [DRONE_ICON_SIZE_PX / 2, DRONE_ICON_SIZE_PX / 2],
  });
}

function emitScenarioEditorChange() {
  window.dispatchEvent(new CustomEvent("dss:scenario-editor-change", {
    detail: {
      enabled: scenarioEditorState.enabled,
      mode: scenarioEditorState.mode,
      home: { ...scenarioEditorState.home },
      waypoints: scenarioEditorState.waypoints.map((waypoint) => ({ ...waypoint })),
      selectedWaypointId: scenarioEditorState.selectedWaypointId,
    },
  }));
}

function createScenarioEditorWaypointId() {
  scenarioEditorState.sequence += 1;
  return `waypoint-${scenarioEditorState.sequence}`;
}

function normalizeFiniteValue(value, fallbackValue) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallbackValue;
}

function clampFiniteValue(value, minimum, maximum, fallbackValue = 0) {
  return Math.max(minimum, Math.min(maximum, normalizeFiniteValue(value, fallbackValue)));
}

function normalizeHeadingDegrees(value) {
  const numericValue = normalizeFiniteValue(value, 0);
  return ((numericValue % 360) + 360) % 360;
}

function getAdiForwardPitchTrimDeg(streamId) {
  if (streamId === LIVE_STREAM_ID) {
    return ADI_PITCH_LIMIT_DEG;
  }

  const latestTelemetry = latestTelemetryByStream.get(streamId);
  const speedMps = normalizeFiniteValue(latestTelemetry?.speed_mps, 0);
  return -Math.min(
    ADI_FORWARD_SPEED_PITCH_TRIM_LIMIT_DEG,
    Math.max(0, speedMps) * ADI_FORWARD_SPEED_PITCH_TRIM_DEG_PER_MPS,
  );
}

function getMapAttitudeIndicator() {
  const element = document.getElementById("map-attitude-indicator");
  return element instanceof HTMLElement ? element : null;
}

function getAdiCardListElement() {
  const element = document.getElementById("adi-card-list");
  return element instanceof HTMLElement ? element : null;
}

function getAdiToggleButton() {
  const element = document.getElementById("adi-toggle-button");
  return element instanceof HTMLButtonElement ? element : null;
}

function getAdiStreamSelect() {
  const element = document.getElementById("adi-stream-select");
  return element instanceof HTMLSelectElement ? element : null;
}

function getFallbackAdiStreamId() {
  return primaryStreamId ?? streamLayers.keys().next().value ?? null;
}

function getSelectedAdiStreamId() {
  return selectedAdiStreamId && streamLayers.has(selectedAdiStreamId)
    ? selectedAdiStreamId
    : getFallbackAdiStreamId();
}

function getMapAttitudeStreamLabel() {
  const selectedState = streamLayers.get(getSelectedAdiStreamId());
  return selectedState?.config.streamLabel ?? "기체";
}

function getAdiStreamConfigs() {
  return Array.from(streamLayers.values())
    .map((streamState) => streamState.config)
    .filter((streamConfig) => streamConfig.enabled);
}

function getAdiCardStatusLabel(streamId) {
  return latestAttitudeByStream.has(streamId) ? "수신 중" : "대기 중";
}

function renderAdiStreamOptions(streamConfigs, selectedStreamId) {
  const streamSelect = getAdiStreamSelect();
  if (!streamSelect) {
    return;
  }

  if (streamConfigs.length === 0) {
    streamSelect.innerHTML = '<option value="">기체 없음</option>';
    streamSelect.disabled = true;
    return;
  }

  streamSelect.disabled = false;
  streamSelect.innerHTML = streamConfigs
    .map((streamConfig) => `<option value="${streamConfig.streamId}">${streamConfig.streamLabel}</option>`)
    .join("");
  streamSelect.value = selectedStreamId ?? streamConfigs[0].streamId;
}

function buildAdiCardMarkup(streamConfig, { selected = false } = {}) {
  const latestAttitude = latestAttitudeByStream.get(streamConfig.streamId);
  const hasAttitude = Boolean(latestAttitude);
  const rollDeg = hasAttitude
    ? clampFiniteValue(latestAttitude.roll_deg, -ADI_ROLL_LIMIT_DEG, ADI_ROLL_LIMIT_DEG)
    : 0;
  const measuredPitchDeg = hasAttitude
    ? clampFiniteValue(latestAttitude.pitch_deg, -ADI_PITCH_LIMIT_DEG, ADI_PITCH_LIMIT_DEG)
    : 0;
  const pitchDeg = hasAttitude
    ? streamConfig.streamId === LIVE_STREAM_ID
      ? measuredPitchDeg
      : Math.min(measuredPitchDeg, getAdiForwardPitchTrimDeg(streamConfig.streamId))
    : 0;
  const yawDeg = hasAttitude ? normalizeHeadingDegrees(latestAttitude.yaw_deg) : 0;
  const pitchOffsetPx = (pitchDeg / ADI_PITCH_LIMIT_DEG) * ADI_PITCH_PIXEL_RANGE;
  const statusLabel = streamConfig.enabled ? getAdiCardStatusLabel(streamConfig.streamId) : "연결 안 됨";

  return `
    <button
      type="button"
      class="adi-card${hasAttitude ? "" : " is-muted"}${selected ? " is-selected" : ""}"
      data-adi-stream-id="${streamConfig.streamId}"
      aria-pressed="${selected}"
      style="
        --adi-horizon-roll:${(-rollDeg).toFixed(2)}deg;
        --adi-pitch-offset:${pitchOffsetPx.toFixed(2)}px;
        --adi-compass-card:${(-yawDeg).toFixed(2)}deg;
      "
    >
      <div class="adi-head">
        <span class="adi-card-title">${streamConfig.streamLabel}</span>
        <span class="adi-card-status">${statusLabel}</span>
      </div>
      <div class="adi-body">
        <div class="adi-instrument" aria-hidden="true">
          <div class="adi-compass-card">
            <span class="adi-compass-mark adi-compass-north">N</span>
            <span class="adi-compass-mark adi-compass-east">E</span>
            <span class="adi-compass-mark adi-compass-south">S</span>
            <span class="adi-compass-mark adi-compass-west">W</span>
          </div>
          <span class="adi-top-pointer"></span>
          <div class="adi-sphere">
            <div class="adi-horizon">
              <div class="adi-sky"></div>
              <div class="adi-ground"></div>
              <div class="adi-pitch-ladder">
                <span class="adi-pitch-line adi-pitch-line-high"></span>
                <span class="adi-pitch-line adi-pitch-line-mid"></span>
                <span class="adi-pitch-line adi-pitch-line-center"></span>
                <span class="adi-pitch-line adi-pitch-line-low"></span>
                <span class="adi-pitch-line adi-pitch-line-bottom"></span>
              </div>
            </div>
            <span class="adi-center-guide"></span>
            <div class="adi-aircraft">
              <span class="adi-aircraft-wing adi-aircraft-wing-left"></span>
              <span class="adi-aircraft-center"></span>
              <span class="adi-aircraft-wing adi-aircraft-wing-right"></span>
            </div>
          </div>
        </div>
      </div>
    </button>
  `;
}

function renderAdiStreamSelector() {
  const indicator = getMapAttitudeIndicator();
  const cardList = getAdiCardListElement();
  const toggleButton = getAdiToggleButton();
  const streamSelect = getAdiStreamSelect();
  if (!(indicator && cardList && toggleButton && streamSelect)) {
    return;
  }

  const streamConfigs = getAdiStreamConfigs();
  const selectedStreamId = getSelectedAdiStreamId();
  const enabledStreamCount = streamConfigs.filter((streamConfig) => streamConfig.enabled).length;
  if (enabledStreamCount <= 1) {
    adiExpanded = false;
  }
  renderAdiStreamOptions(streamConfigs, selectedStreamId);
  const visibleStreamConfigs = adiExpanded
    ? streamConfigs
    : streamConfigs.filter((streamConfig) => streamConfig.streamId === selectedStreamId).slice(0, 1);

  indicator.classList.toggle("is-expanded", adiExpanded);
  indicator.classList.toggle("is-collapsed", !adiExpanded);
  toggleButton.hidden = enabledStreamCount <= 1 || visibleStreamConfigs.length === 0;
  toggleButton.disabled = enabledStreamCount <= 1 || visibleStreamConfigs.length === 0;
  toggleButton.textContent = adiExpanded ? "접기" : "펼치기";
  toggleButton.setAttribute("aria-expanded", String(adiExpanded));

  if (streamConfigs.length === 0) {
    indicator.classList.add("is-muted");
    cardList.innerHTML = '<div class="adi-empty-state">기체 없음</div>';
    indicator.setAttribute("aria-label", "자세 방향 표시기 기체 없음");
    return;
  }

  if (visibleStreamConfigs.length === 0) {
    indicator.classList.add("is-muted");
    cardList.innerHTML = '<div class="adi-empty-state">기체 선택 대기</div>';
    indicator.setAttribute("aria-label", "자세 방향 표시기 기체 선택 대기");
    return;
  }

  cardList.innerHTML = visibleStreamConfigs
    .map((streamConfig) => buildAdiCardMarkup(streamConfig, {
      selected: streamConfig.streamId === selectedStreamId,
    }))
    .join("");

  indicator.classList.toggle(
    "is-muted",
    visibleStreamConfigs.every((streamConfig) => !latestAttitudeByStream.has(streamConfig.streamId)),
  );
  indicator.setAttribute(
    "aria-label",
    adiExpanded ? "자세 방향 표시기 전체 보기" : `${getMapAttitudeStreamLabel()} 자세 방향 표시기`,
  );

  cardList.querySelectorAll("[data-adi-stream-id]").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    button.addEventListener("click", () => {
      const streamId = button.dataset.adiStreamId ?? "";
      if (!streamId || !streamLayers.has(streamId)) {
        return;
      }

      selectedAdiStreamId = streamId;
      renderAdiStreamSelector();
    });
  });
}

function applyLatestAdiAttitudeForSelectedStream() {
  renderAdiStreamSelector();
}

function resetMapAttitudeIndicator(statusLabel = "대기 중") {
  const indicator = getMapAttitudeIndicator();
  if (!indicator) {
    return;
  }

  indicator.classList.add("is-muted");
  if (statusLabel === "기체 없음") {
    latestAttitudeByStream.clear();
  }
  renderAdiStreamSelector();
  indicator.setAttribute("aria-label", `자세 방향 표시기 ${statusLabel}`);
}

function updateMapAttitudeIndicator(detail) {
  if (!detail?.streamId) {
    return;
  }

  if (streamLayers.has(detail.streamId)) {
    latestAttitudeByStream.set(detail.streamId, detail);
  }
  renderAdiStreamSelector();
}

function normalizeScenarioEditorHome(home) {
  return {
    lat: normalizeFiniteValue(home?.lat, DEFAULT_HOME.lat),
    lon: normalizeFiniteValue(home?.lon, DEFAULT_HOME.lon),
    alt_m: normalizeFiniteValue(home?.alt_m, DEFAULT_HOME.alt_m),
  };
}

function normalizeScenarioEditorWaypoint(waypoint) {
  return {
    id: waypoint?.id ?? createScenarioEditorWaypointId(),
    lat: normalizeFiniteValue(waypoint?.lat, DEFAULT_HOME.lat),
    lon: normalizeFiniteValue(waypoint?.lon, DEFAULT_HOME.lon),
    alt_m: normalizeFiniteValue(waypoint?.alt_m, DEFAULT_EDITOR_WAYPOINT_ALT_M),
    target_speed_mps: normalizeFiniteValue(
      waypoint?.target_speed_mps,
      DEFAULT_EDITOR_WAYPOINT_SPEED_MPS,
    ),
    hold_seconds: normalizeFiniteValue(
      waypoint?.hold_seconds,
      DEFAULT_EDITOR_WAYPOINT_HOLD_SECONDS,
    ),
  };
}

function createEditorHomeIcon() {
  return L.divIcon({
    className: "dss-editor-icon",
    html: '<span class="dss-editor-home-point" aria-label="HOME"></span>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function createEditorWaypointIcon(index, selected) {
  return L.divIcon({
    className: "dss-editor-icon",
    html: `<span class="dss-editor-waypoint-badge${selected ? " is-selected" : ""}">W${index}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

async function initializeAirspaceOverlay() {
  const map = ensureMap();
  if (!map || airspaceOverlayEnabled) {
    return;
  }

  try {
    const response = await fetch(AIRSPACE_STATUS_URL);
    if (!response.ok) {
      return;
    }

    const status = await response.json();
    if (!status?.enabled) {
      return;
    }

    airspaceOverlayEnabled = true;
    airspaceLayer = L.geoJSON(null, {
      pane: MAP_PANES.airspace,
      interactive: false,
      style: (feature) => {
        const zoneType = feature?.properties?.zone_type;
        const visual = getAirspaceZoneVisual(zoneType);
        return {
          color: visual.color,
          weight: 3,
          opacity: 0.95,
          fillColor: `url(#${visual.patternId})`,
          fillOpacity: 1,
          dashArray: visual.dashArray,
        };
      },
    }).addTo(map);
    airspaceLayer.on("layeradd", () => ensureAirspacePatterns(map));
    map.on("moveend zoomend", scheduleAirspaceRefresh);
    scheduleAirspaceRefresh();
  } catch (error) {
    airspaceOverlayEnabled = false;
    airspaceLayer = null;
  }
}

function scheduleAirspaceRefresh() {
  if (!airspaceOverlayEnabled || !airspaceLayer) {
    return;
  }

  window.clearTimeout(airspaceFetchTimerId);
  airspaceFetchTimerId = window.setTimeout(() => {
    void refreshAirspaceOverlay();
  }, 250);
}

async function refreshAirspaceOverlay() {
  const map = ensureMap();
  if (!map || !airspaceOverlayEnabled || !airspaceLayer) {
    return;
  }

  const bounds = map.getBounds();
  const bbox = [
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth(),
  ].map((value) => value.toFixed(7)).join(",");
  if (bbox === latestAirspaceFetchKey) {
    return;
  }

  latestAirspaceFetchKey = bbox;
  const url = new URL(AIRSPACE_ZONES_URL, window.location.href);
  url.searchParams.set("bbox", bbox);
  url.searchParams.set("zone_types", "prohibited,restricted");

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return;
    }

    const featureCollection = await response.json();
    airspaceLayer.clearLayers();
    airspaceLayer.addData(featureCollection);
    ensureAirspacePatterns(map);
  } catch (error) {
    latestAirspaceFetchKey = "";
  }
}

function ensureScenarioEditorLayers() {
  const map = ensureMap();
  if (!map) {
    return;
  }

  if (!editorWaypointLayer) {
    editorWaypointLayer = L.layerGroup();
  }

  if (!editorRouteLine) {
    editorRouteLine = L.polyline([], EDITOR_ROUTE_STYLE);
  }

  if (!editorHomeMarker) {
    editorHomeMarker = L.marker(
      [scenarioEditorState.home.lat, scenarioEditorState.home.lon],
      {
        pane: MAP_PANES.editor,
        draggable: true,
        icon: createEditorHomeIcon(),
      },
    );
    editorHomeMarker.on("dragend", () => {
      const latlng = editorHomeMarker.getLatLng();
      scenarioEditorState.home = {
        ...scenarioEditorState.home,
        lat: latlng.lat,
        lon: latlng.lng,
      };
      renderScenarioEditor();
      emitScenarioEditorChange();
    });
  }
}

function setBaseHomeMarkerVisibility(visible) {
  if (!homeMarker) {
    return;
  }

  homeMarker.setStyle({
    opacity: visible ? 1 : 0,
    fillOpacity: visible ? HOME_MARKER_STYLE.fillOpacity : 0,
  });
}

function renderScenarioEditor() {
  const map = ensureMap();
  if (!map) {
    return;
  }

  ensureScenarioEditorLayers();

  if (!scenarioEditorState.enabled) {
    setBaseHomeMarkerVisibility(true);
    if (editorHomeMarker && map.hasLayer(editorHomeMarker)) {
      map.removeLayer(editorHomeMarker);
    }
    if (editorWaypointLayer && map.hasLayer(editorWaypointLayer)) {
      map.removeLayer(editorWaypointLayer);
      editorWaypointLayer.clearLayers();
    }
    if (editorRouteLine && map.hasLayer(editorRouteLine)) {
      map.removeLayer(editorRouteLine);
      editorRouteLine.setLatLngs([]);
    }
    return;
  }

  setBaseHomeMarkerVisibility(false);

  if (editorHomeMarker && !map.hasLayer(editorHomeMarker)) {
    editorHomeMarker.addTo(map);
  }
  if (editorWaypointLayer && !map.hasLayer(editorWaypointLayer)) {
    editorWaypointLayer.addTo(map);
  }
  if (editorRouteLine && !map.hasLayer(editorRouteLine)) {
    editorRouteLine.addTo(map);
  }

  editorHomeMarker.setLatLng([scenarioEditorState.home.lat, scenarioEditorState.home.lon]);
  editorHomeMarker.setIcon(createEditorHomeIcon());

  editorWaypointLayer.clearLayers();
  scenarioEditorState.waypoints.forEach((waypoint, index) => {
    const marker = L.marker([waypoint.lat, waypoint.lon], {
      pane: MAP_PANES.editor,
      draggable: true,
      icon: createEditorWaypointIcon(index + 1, waypoint.id === scenarioEditorState.selectedWaypointId),
    });
    marker.on("click", () => {
      scenarioEditorState.selectedWaypointId = waypoint.id;
      renderScenarioEditor();
      emitScenarioEditorChange();
    });
    marker.on("dragend", () => {
      const latlng = marker.getLatLng();
      scenarioEditorState.waypoints = scenarioEditorState.waypoints.map((candidate) => (
        candidate.id === waypoint.id
          ? {
              ...candidate,
              lat: latlng.lat,
              lon: latlng.lng,
            }
          : candidate
      ));
      renderScenarioEditor();
      emitScenarioEditorChange();
    });
    marker.addTo(editorWaypointLayer);
  });

  editorRouteLine.setLatLngs([
    [scenarioEditorState.home.lat, scenarioEditorState.home.lon],
    ...scenarioEditorState.waypoints.map((waypoint) => [waypoint.lat, waypoint.lon]),
  ]);
}

function handleScenarioEditorMapClick(latlng) {
  if (!scenarioEditorState.enabled || !latlng) {
    return;
  }

  if (scenarioEditorState.mode === "home") {
    scenarioEditorState.home = {
      ...scenarioEditorState.home,
      lat: latlng.lat,
      lon: latlng.lng,
    };
    scenarioEditorState.mode = null;
    renderScenarioEditor();
    emitScenarioEditorChange();
    return;
  }

  if (scenarioEditorState.mode === "waypoint") {
    const nextWaypoint = normalizeScenarioEditorWaypoint({
      lat: latlng.lat,
      lon: latlng.lng,
    });
    scenarioEditorState.waypoints = [...scenarioEditorState.waypoints, nextWaypoint];
    scenarioEditorState.selectedWaypointId = nextWaypoint.id;
    renderScenarioEditor();
    emitScenarioEditorChange();
  }
}

function ensureMap() {
  if (mapInstance) {
    return mapInstance;
  }

  const mapElement = document.getElementById("leaflet-map");
  if (!mapElement || typeof window.L === "undefined") {
    return null;
  }

  mapInstance = L.map(mapElement, {
    zoomControl: false,
    attributionControl: false,
  }).setView([DEFAULT_HOME.lat, DEFAULT_HOME.lon], MAP_ZOOM_LEVEL);

  configurePane(mapInstance, MAP_PANES.route, 430);
  configurePane(mapInstance, MAP_PANES.airspace, 435);
  configurePane(mapInstance, MAP_PANES.home, 640);
  configurePane(mapInstance, MAP_PANES.waypoint, 650);
  configurePane(mapInstance, MAP_PANES.editor, 680);
  configurePane(mapInstance, MAP_PANES.drone, 700);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19 },
  ).addTo(mapInstance);

  homeMarker = L.circleMarker([DEFAULT_HOME.lat, DEFAULT_HOME.lon], HOME_MARKER_STYLE).addTo(mapInstance);

  mapInstance.on("click", (event) => {
    handleScenarioEditorMapClick(event.latlng);
  });
  observeMapContainerSize(mapElement);

  return mapInstance;
}

function getPrimaryHomeCoordinates() {
  const primaryStream = primaryStreamId ? streamLayers.get(primaryStreamId) : null;
  const home = primaryStream?.home ?? DEFAULT_HOME;
  return [home.lat, home.lon];
}

function centerMapOnPrimaryHome() {
  if (!mapInstance) {
    return;
  }

  mapInstance.setView(getPrimaryHomeCoordinates(), mapInstance.getZoom(), {
    animate: false,
  });
}

function invalidateMapSize(recenterOnHome = false) {
  if (!mapInstance) {
    return;
  }

  pendingMapHomeRecenter = pendingMapHomeRecenter || recenterOnHome;

  if (mapInvalidateTimerId !== null) {
    window.clearTimeout(mapInvalidateTimerId);
  }

  mapInvalidateTimerId = window.setTimeout(() => {
    mapInvalidateTimerId = null;
    const shouldRecenterOnHome = pendingMapHomeRecenter;
    pendingMapHomeRecenter = false;
    window.requestAnimationFrame(() => {
      mapInstance?.invalidateSize({ animate: false, pan: false });
      if (shouldRecenterOnHome) {
        centerMapOnPrimaryHome();
      }
    });
  }, MAP_RESIZE_INVALIDATE_DELAY_MS);
}

function observeMapContainerSize(mapElement) {
  if (!mapElement || mapResizeObserver !== null) {
    return;
  }

  if (typeof window.ResizeObserver === "function") {
    mapResizeObserver = new ResizeObserver(() => {
      invalidateMapSize();
    });
    mapResizeObserver.observe(mapElement);
  }

  window.addEventListener("resize", invalidateMapSize);
  window.addEventListener("dss:map-layout-change", () => {
    pendingMapHomeRecenter = true;
  });
}

function getStreamVisual(streamConfig) {
  return streamConfig.visual ?? DEFAULT_STREAM_VISUAL;
}

function createWaypointIcon(index, visual) {
  return createEditorWaypointIcon(index, false);
}

function createStreamLayer(streamConfig) {
  ensureMap();
  const visual = getStreamVisual(streamConfig);
  return {
    config: {
      ...streamConfig,
      visual,
    },
    home: { ...DEFAULT_HOME },
    route: null,
    routePoints: [],
    lastActualPoint: null,
    lastActualPointTimestampMs: 0,
    waypointLayer: L.layerGroup().addTo(mapInstance),
    plannedRouteLine: L.polyline([], {
      ...PLANNED_ROUTE_STYLE,
      color: visual.strokeColor,
    }).addTo(mapInstance),
      actualRouteLine: L.polyline([], {
        ...ACTUAL_ROUTE_STYLE,
        color: visual.strokeColor,
      }).addTo(mapInstance),
      droneMarker: L.marker([DEFAULT_HOME.lat, DEFAULT_HOME.lon], {
        pane: MAP_PANES.drone,
        icon: createDroneIcon(visual, streamConfig.droneKey),
        interactive: false,
        keyboard: false,
      }).addTo(mapInstance),
    };
  }

function clearStreamRoute(streamState) {
  streamState.route = null;
  streamState.routePoints = [];
  streamState.home = { ...DEFAULT_HOME };
  streamState.waypointLayer.clearLayers();
  streamState.plannedRouteLine.setLatLngs([]);
}

function updateStreamVisual(streamState) {
  const visual = getStreamVisual(streamState.config);
  streamState.config.visual = visual;
  streamState.droneMarker.setIcon(createDroneIcon(visual, streamState.config.droneKey));
  streamState.actualRouteLine.setStyle({
    color: visual.strokeColor,
  });
  streamState.plannedRouteLine.setStyle({
    color: visual.strokeColor,
  });

  if (streamState.route) {
    drawWaypointMarkers(streamState);
  }
}

function removeStreamLayer(streamId) {
  const streamState = streamLayers.get(streamId);
  if (!streamState) {
    return;
  }

  mapInstance?.removeLayer(streamState.waypointLayer);
  mapInstance?.removeLayer(streamState.plannedRouteLine);
  mapInstance?.removeLayer(streamState.actualRouteLine);
  mapInstance?.removeLayer(streamState.droneMarker);
  streamLayers.delete(streamId);
  latestTelemetryByStream.delete(streamId);
  latestAttitudeByStream.delete(streamId);
}

function drawWaypointMarkers(streamState) {
  if (!streamState.route) {
    return;
  }

  streamState.waypointLayer.clearLayers();
  streamState.route.waypoints.forEach((waypoint) => {
    L.marker([waypoint.lat, waypoint.lon], {
      icon: createWaypointIcon(waypoint.index, streamState.config.visual),
      pane: MAP_PANES.waypoint,
      interactive: false,
      keyboard: false,
    }).addTo(streamState.waypointLayer);
  });
}

function updatePrimaryHomeMarker() {
  if (!homeMarker) {
    return;
  }

  const [homeLat, homeLon] = getPrimaryHomeCoordinates();
  const home = { lat: homeLat, lon: homeLon };
  homeMarker.setLatLng([home.lat, home.lon]);
}

function collectBoundsPoints() {
  const points = [];
  for (const streamState of streamLayers.values()) {
    if (streamState.routePoints.length) {
      streamState.routePoints.forEach((point) => {
        points.push(point);
      });
      points.push([streamState.home.lat, streamState.home.lon]);
      continue;
    }

    points.push([streamState.home.lat, streamState.home.lon]);
  }

  return points;
}

function fitMapToRoutes() {
  const map = ensureMap();
  if (!map) {
    return;
  }

  const points = collectBoundsPoints();
  if (points.length === 0) {
    map.setView([DEFAULT_HOME.lat, DEFAULT_HOME.lon], MAP_ZOOM_LEVEL, { animate: false });
    return;
  }

  const bounds = L.latLngBounds(points);
  if (!bounds.isValid()) {
    map.setView([DEFAULT_HOME.lat, DEFAULT_HOME.lon], MAP_ZOOM_LEVEL, { animate: false });
    return;
  }

  map.fitBounds(bounds, {
    padding: FIT_BOUNDS_PADDING,
    animate: false,
  });
}

function fitMapToScenarioEditorDraft() {
  const map = ensureMap();
  if (!map) {
    return;
  }

  const points = [
    [scenarioEditorState.home.lat, scenarioEditorState.home.lon],
    ...scenarioEditorState.waypoints.map((waypoint) => [waypoint.lat, waypoint.lon]),
  ];
  const bounds = L.latLngBounds(points);
  if (!bounds.isValid()) {
    map.setView([scenarioEditorState.home.lat, scenarioEditorState.home.lon], MAP_ZOOM_LEVEL, {
      animate: false,
    });
    return;
  }

  if (points.length <= 1) {
    map.setView([scenarioEditorState.home.lat, scenarioEditorState.home.lon], MAP_ZOOM_LEVEL, {
      animate: false,
    });
    return;
  }

  map.fitBounds(bounds, {
    padding: FIT_BOUNDS_PADDING,
    animate: false,
  });
}

function renderStreamRoute(streamId, route) {
  const streamState = streamLayers.get(streamId);
  if (!streamState) {
    return;
  }

  const routePoints = route.waypoints.map((waypoint) => [waypoint.lat, waypoint.lon]);
  streamState.route = route;
  streamState.routePoints = routePoints;
  streamState.home = { ...route.home };
  drawWaypointMarkers(streamState);
  streamState.plannedRouteLine.setLatLngs(routePoints);

  if (streamState.lastActualPoint === null) {
    streamState.droneMarker.setLatLng([streamState.home.lat, streamState.home.lon]);
  }

  updatePrimaryHomeMarker();
  fitMapToRoutes();
}

function buildReplayRoutePoints(replayDetail) {
  if (!Array.isArray(replayDetail?.samples)) {
    return [];
  }

  const routePoints = [];
  replayDetail.samples.forEach((sample) => {
    const lat = Number(sample?.lat_deg);
    const lon = Number(sample?.lon_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return;
    }

    const previousPoint = routePoints[routePoints.length - 1] ?? null;
    if (previousPoint && previousPoint[0] === lat && previousPoint[1] === lon) {
      return;
    }

    routePoints.push([lat, lon]);
  });
  return routePoints;
}

function renderReplayRoute(streamId, replayDetail) {
  const streamState = streamLayers.get(streamId);
  if (!streamState) {
    return;
  }

  const routePoints = buildReplayRoutePoints(replayDetail);
  const firstSample = replayDetail?.samples?.[0] ?? null;
  const firstPoint = routePoints[0] ?? null;

  streamState.route = null;
  streamState.routePoints = routePoints;
  streamState.waypointLayer.clearLayers();
  streamState.home = firstPoint
    ? {
        lat: firstPoint[0],
        lon: firstPoint[1],
        alt_m: Number(firstSample?.alt_m) || 0,
      }
    : { ...DEFAULT_HOME };
  streamState.plannedRouteLine.setLatLngs(routePoints);

  if (streamState.lastActualPoint === null) {
    streamState.droneMarker.setLatLng([streamState.home.lat, streamState.home.lon]);
  }

  updatePrimaryHomeMarker();
  fitMapToRoutes();
}

function updateFlightPath(detail) {
  latestTelemetryByStream.set(detail.streamId, detail);
  if (mediaLayoutSettling) {
    return;
  }

  if (pendingTelemetryFrameId !== null || typeof window.requestAnimationFrame !== "function") {
    if (pendingTelemetryFrameId === null) {
      flushPendingFlightPathUpdates();
    }
    return;
  }

  pendingTelemetryFrameId = window.requestAnimationFrame(() => {
    pendingTelemetryFrameId = null;
    flushPendingFlightPathUpdates();
  });
}

function flushPendingFlightPathUpdates() {
  for (const [streamId, detail] of latestTelemetryByStream.entries()) {
    const streamState = streamLayers.get(streamId);
    if (!streamState) {
      continue;
    }

    const nextPoint = [detail.lat, detail.lon];
    streamState.droneMarker.setLatLng(nextPoint);

    if (
      streamState.lastActualPoint !== null &&
      streamState.lastActualPoint[0] === nextPoint[0] &&
      streamState.lastActualPoint[1] === nextPoint[1]
    ) {
      continue;
    }

    const effectiveTimestampMs = Number.isFinite(detail.timestampMs)
      ? detail.timestampMs
      : (() => {
        const parsedTimestampMs = Date.parse(detail.timestamp);
        return Number.isNaN(parsedTimestampMs) ? Date.now() : parsedTimestampMs;
      })();
    const appendDue = (
      streamState.lastActualPoint === null
      || effectiveTimestampMs - streamState.lastActualPointTimestampMs >= MAP_PATH_APPEND_INTERVAL_MS
    );
    if (!appendDue) {
      continue;
    }

    streamState.actualRouteLine.addLatLng(nextPoint);
    streamState.lastActualPoint = nextPoint;
    streamState.lastActualPointTimestampMs = effectiveTimestampMs;
  }
}

function resetFlightPaths() {
  if (pendingTelemetryFrameId !== null) {
    window.cancelAnimationFrame?.(pendingTelemetryFrameId);
    pendingTelemetryFrameId = null;
  }

  for (const streamState of streamLayers.values()) {
    streamState.actualRouteLine.setLatLngs([]);
    streamState.lastActualPoint = null;
    streamState.lastActualPointTimestampMs = 0;
    latestTelemetryByStream.delete(streamState.config.streamId);
    latestAttitudeByStream.delete(streamState.config.streamId);
    const home = streamState.home ?? DEFAULT_HOME;
    streamState.droneMarker.setLatLng([home.lat, home.lon]);
  }

  updatePrimaryHomeMarker();
  fitMapToRoutes();
}

function setMediaLayoutSettling(active) {
  mediaLayoutSettling = active;
  if (mapLayoutSettleReleaseTimerId !== null) {
    window.clearTimeout(mapLayoutSettleReleaseTimerId);
    mapLayoutSettleReleaseTimerId = null;
  }

  if (active) {
    if (pendingTelemetryFrameId !== null) {
      window.cancelAnimationFrame?.(pendingTelemetryFrameId);
      pendingTelemetryFrameId = null;
    }
    return;
  }

  mapLayoutSettleReleaseTimerId = window.setTimeout(() => {
    mapLayoutSettleReleaseTimerId = null;
    if (latestTelemetryByStream.size > 0) {
      updateFlightPath(latestTelemetryByStream.values().next().value);
    }
  }, MAP_LAYOUT_SETTLE_HOLD_MS);
}

export function initializeMap() {
  if (initialized) {
    return;
  }

  ensureMap();
  void initializeAirspaceOverlay();
  resetMapAttitudeIndicator();
  renderAdiStreamSelector();
  getAdiToggleButton()?.addEventListener("click", () => {
    adiExpanded = !adiExpanded;
    renderAdiStreamSelector();
  });
  getAdiStreamSelect()?.addEventListener("change", (event) => {
    const nextStreamId = event.currentTarget instanceof HTMLSelectElement
      ? event.currentTarget.value
      : "";
    if (!nextStreamId || !streamLayers.has(nextStreamId)) {
      return;
    }

    selectedAdiStreamId = nextStreamId;
    renderAdiStreamSelector();
  });

  window.addEventListener("dss:telemetry", (event) => {
    updateFlightPath(event.detail);
  });

  window.addEventListener("dss:attitude", (event) => {
    updateMapAttitudeIndicator(event.detail);
  });

  window.addEventListener("dss:telemetry-reset", () => {
    resetFlightPaths();
    latestAttitudeByStream.clear();
    resetMapAttitudeIndicator();
  });

  window.addEventListener("dss:media-layout-settling", (event) => {
    setMediaLayoutSettling(Boolean(event.detail?.active));
  });

  initialized = true;
}

export function syncMapStreams(streamConfigs) {
  ensureMap();

  const nextStreamIds = new Set(streamConfigs.map((streamConfig) => streamConfig.streamId));
  for (const existingStreamId of Array.from(streamLayers.keys())) {
    if (!nextStreamIds.has(existingStreamId)) {
      removeStreamLayer(existingStreamId);
    }
  }

  streamConfigs.forEach((streamConfig) => {
    const existingState = streamLayers.get(streamConfig.streamId);
    if (!existingState) {
      streamLayers.set(streamConfig.streamId, createStreamLayer(streamConfig));
      return;
    }

    existingState.config = {
      ...streamConfig,
      visual: getStreamVisual(streamConfig),
    };
    updateStreamVisual(existingState);
  });

  primaryStreamId = streamConfigs.find((streamConfig) => streamConfig.isPrimary)?.streamId ?? null;
  selectedAdiStreamId = getSelectedAdiStreamId();
  updatePrimaryHomeMarker();
  renderAdiStreamSelector();
  applyLatestAdiAttitudeForSelectedStream(streamConfigs.length > 0 ? "대기 중" : "기체 없음");
  renderScenarioEditor();
}

export async function loadScenarioRoutes(scenarioKeyOrStreamConfigs, nextStreamConfigs = []) {
  ensureMap();
  const streamConfigs = Array.isArray(scenarioKeyOrStreamConfigs)
    ? scenarioKeyOrStreamConfigs
    : nextStreamConfigs;
  const fallbackScenarioKey = Array.isArray(scenarioKeyOrStreamConfigs)
    ? ""
    : scenarioKeyOrStreamConfigs;
  syncMapStreams(streamConfigs);

  for (const streamState of streamLayers.values()) {
    clearStreamRoute(streamState);
  }

  if (streamConfigs.length === 0) {
    updatePrimaryHomeMarker();
    fitMapToRoutes();
    return;
  }

  const routes = await Promise.all(
    streamConfigs.map(async (streamConfig) => {
      const scenarioKey = streamConfig.scenarioKey || fallbackScenarioKey;
      if (!scenarioKey) {
        return {
          streamId: streamConfig.streamId,
          route: null,
        };
      }

      const response = await fetch(
        `${API_BASE_URL}/api/scenarios/${encodeURIComponent(scenarioKey)}/route?slot=${streamConfig.slotIndex}`,
      );
      if (!response.ok) {
        throw new Error(`Failed to load scenario route: ${response.status}`);
      }

      return {
        streamId: streamConfig.streamId,
        route: await response.json(),
      };
    }),
  );

  routes.forEach(({ streamId, route }) => {
    if (route) {
      renderStreamRoute(streamId, route);
    }
  });
  renderScenarioEditor();
}

export function loadReplayRoutes(replayDetail, streamConfigs = []) {
  ensureMap();
  syncMapStreams(streamConfigs);

  for (const streamState of streamLayers.values()) {
    clearStreamRoute(streamState);
  }

  if (streamConfigs.length === 0 || !replayDetail) {
    updatePrimaryHomeMarker();
    fitMapToRoutes();
    return;
  }

  streamConfigs.forEach((streamConfig) => {
    renderReplayRoute(streamConfig.streamId, replayDetail);
  });
  renderScenarioEditor();
}

export function getDefaultScenarioEditorDraft() {
  return {
    home: { ...DEFAULT_HOME },
    waypoints: [],
    selectedWaypointId: null,
  };
}

export function setScenarioEditorEnabled(enabled) {
  scenarioEditorState.enabled = Boolean(enabled);
  if (!scenarioEditorState.enabled) {
    scenarioEditorState.mode = null;
  }
  renderScenarioEditor();
  emitScenarioEditorChange();
}

export function setScenarioEditorMode(mode) {
  scenarioEditorState.mode = mode;
  emitScenarioEditorChange();
}

export function setScenarioEditorDraft(draft) {
  scenarioEditorState.mode = null;
  scenarioEditorState.home = normalizeScenarioEditorHome(draft?.home ?? DEFAULT_HOME);
  scenarioEditorState.waypoints = Array.isArray(draft?.waypoints)
    ? draft.waypoints.map((waypoint) => normalizeScenarioEditorWaypoint(waypoint))
    : [];
  const selectedWaypointExists = scenarioEditorState.waypoints.some(
    (waypoint) => waypoint.id === draft?.selectedWaypointId,
  );
  scenarioEditorState.selectedWaypointId = selectedWaypointExists
    ? draft.selectedWaypointId
    : scenarioEditorState.waypoints[0]?.id ?? null;
  renderScenarioEditor();
  emitScenarioEditorChange();
}

export function focusScenarioEditorDraft() {
  fitMapToScenarioEditorDraft();
}

export function updateScenarioEditorHome(homePatch) {
  scenarioEditorState.home = normalizeScenarioEditorHome({
    ...scenarioEditorState.home,
    ...homePatch,
  });
  renderScenarioEditor();
  emitScenarioEditorChange();
}

export function updateScenarioEditorWaypoint(waypointId, waypointPatch) {
  if (!waypointId) {
    return;
  }

  scenarioEditorState.waypoints = scenarioEditorState.waypoints.map((waypoint) => (
    waypoint.id === waypointId
      ? normalizeScenarioEditorWaypoint({
          ...waypoint,
          ...waypointPatch,
          id: waypoint.id,
        })
      : waypoint
  ));
  renderScenarioEditor();
  emitScenarioEditorChange();
}

export function selectScenarioEditorWaypoint(waypointId) {
  scenarioEditorState.selectedWaypointId = waypointId;
  renderScenarioEditor();
  emitScenarioEditorChange();
}

export function removeScenarioEditorWaypoint(waypointId) {
  if (!waypointId) {
    return;
  }

  scenarioEditorState.waypoints = scenarioEditorState.waypoints.filter(
    (waypoint) => waypoint.id !== waypointId,
  );
  if (scenarioEditorState.selectedWaypointId === waypointId) {
    scenarioEditorState.selectedWaypointId = scenarioEditorState.waypoints[0]?.id ?? null;
  }
  renderScenarioEditor();
  emitScenarioEditorChange();
}

export function clearScenarioEditorWaypoints() {
  scenarioEditorState.waypoints = [];
  scenarioEditorState.selectedWaypointId = null;
  renderScenarioEditor();
  emitScenarioEditorChange();
}
