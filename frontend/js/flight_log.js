let telemetrySamples = [];
const displaySamplesByStream = new Map();
const firstTelemetryTimestampByStream = new Map();
const signalOriginByStream = new Map();
const signalProfileByStream = new Map();
const currentFlightModeByStream = new Map();
const MISSION_RECORDING_START_MESSAGE = "__mission_recording_start__";
const MISSION_RECORDING_STOP_MESSAGE = "__mission_recording_stop__";
export const FLIGHT_MODE_MESSAGE_PREFIX = "__flight_mode__|";
export const CSV_HEADER_COLUMNS = [
  "timestamp_utc",
  "lat",
  "lon",
  "alt_m",
  "velocity",
  "RCS_value",
  "RSSI",
];

const EARTH_METERS_PER_DEGREE_LAT = 111320;
const SIGNAL_PROFILE_BY_DRONE_KEY = {
  inspire_3: { rcsValue: 0.08, rfFreqMhz: 2400, rfProto: "DJI_O4" },
  inspire_2: { rcsValue: 0.07, rfFreqMhz: 2400, rfProto: "Lightbridge" },
  mavic_3_pro: { rcsValue: 0.03, rfFreqMhz: 2400, rfProto: "DJI_O3+" },
  mavic_air_2: { rcsValue: 0.02, rfFreqMhz: 2400, rfProto: "OcuSync_2.0" },
  phantom_4_rtk: { rcsValue: 0.04, rfFreqMhz: 2400, rfProto: "Lightbridge" },
};

const missionPhaseByStream = new Map();

function emitFlightLogEvent(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function sanitizeFilenamePart(value) {
  return String(value || "unknown")
    .trim()
    .replace(/[^\w\-가-힣]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function formatCoordinate(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "";
  }

  return `="${value.toFixed(7)}"`;
}

function metersPerDegreeLon(lat) {
  return EARTH_METERS_PER_DEGREE_LAT * Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
}

function calculateHorizontalDistanceMeters(latA, lonA, latB, lonB) {
  const averageLat = (Number(latA) + Number(latB)) / 2;
  const northOffsetM = (Number(latB) - Number(latA)) * EARTH_METERS_PER_DEGREE_LAT;
  const eastOffsetM = (Number(lonB) - Number(lonA)) * metersPerDegreeLon(averageLat);
  return Math.hypot(northOffsetM, eastOffsetM);
}

function resolveSignalProfile(droneKey = "") {
  return SIGNAL_PROFILE_BY_DRONE_KEY[droneKey] ?? {
    rcsValue: 0.05,
    rfFreqMhz: 2400,
    rfProto: "Unknown",
  };
}

function getSignalOrigin(streamId, sample) {
  if (!signalOriginByStream.has(streamId)) {
    signalOriginByStream.set(streamId, {
      lat: sample.lat,
      lon: sample.lon,
      alt_m: sample.alt_m,
    });
  }

  return signalOriginByStream.get(streamId);
}

function getSignalProfile(streamId, droneKey) {
  if (!signalProfileByStream.has(streamId)) {
    signalProfileByStream.set(streamId, resolveSignalProfile(droneKey));
  }

  return signalProfileByStream.get(streamId);
}

function calculateEstimatedRssiDbm(streamId, sample) {
  const origin = getSignalOrigin(streamId, sample);
  const horizontalDistanceM = calculateHorizontalDistanceMeters(
    origin.lat,
    origin.lon,
    sample.lat,
    sample.lon,
  );
  const altitudeDeltaM = Math.abs(Number(sample.alt_m) - Number(origin.alt_m));
  const linkDistanceM = Math.max(1, Math.hypot(horizontalDistanceM, altitudeDeltaM));
  const pathLossDb = 20 * Math.log10(linkDistanceM);
  const wobbleDb = Math.sin((sample.elapsed_ms / 1000) * 0.7) * 1.4;
  return clamp(-38 - pathLossDb + wobbleDb, -98, -32);
}

function formatDisplayCoordinate(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "-";
  }

  return value.toFixed(6);
}

function formatDisplayMetric(value, unit) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return `-${unit}`;
  }

  return `${value.toFixed(1)}${unit}`;
}

function buildDisplayLogText(sample) {
  return `위도 ${formatDisplayCoordinate(sample.lat)} | `
    + `경도 ${formatDisplayCoordinate(sample.lon)} | `
    + `고도 ${formatDisplayMetric(sample.alt_m, "m")} | `
    + `속도 ${formatDisplayMetric(sample.speed_mps, "m/s")} | `
    + `RSSI ${formatDisplayMetric(sample.rssi_dbm, "dBm")}`;
}

function buildCsvRowValues(sample) {
  return [
    sample.timestamp,
    formatCoordinate(sample.lat),
    formatCoordinate(sample.lon),
    sample.alt_m,
    sample.speed_mps,
    sample.rcs_value,
    sample.rssi_dbm,
  ];
}

function buildCsvRowText(values) {
  return values.map(escapeCsv).join(",");
}

function buildCsvContent(samples, signalProfile = null) {
  const rows = samples.map((sample) => buildCsvRowValues(sample));
  const metadataRows = [];
  if (signalProfile && Number.isFinite(signalProfile.rfFreqMhz)) {
    metadataRows.push(`# RF_Freq: ${Number(signalProfile.rfFreqMhz).toFixed(1)}`);
  }
  if (signalProfile?.rfProto) {
    metadataRows.push(`# RF_proto: ${signalProfile.rfProto}`);
  }

  const csvRows = [CSV_HEADER_COLUMNS, ...rows]
    .map((row) => buildCsvRowText(row));

  return [
    ...metadataRows,
    ...(metadataRows.length > 0 ? [""] : []),
    ...csvRows,
  ].join("\n");
}

function triggerDownload(filename, content) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function emitFlightLogStatus(streamId, phase) {
  emitFlightLogEvent("dss:flight-log-status", {
    streamId,
    phase,
  });
}

function getDefaultFlightModeLabel() {
  return "MANUAL";
}

function getStreamSamples(streamId) {
  if (!displaySamplesByStream.has(streamId)) {
    displaySamplesByStream.set(streamId, []);
  }

  return displaySamplesByStream.get(streamId);
}

function getStreamPhase(streamId) {
  return missionPhaseByStream.get(streamId) ?? "idle";
}

function setStreamPhase(streamId, phase) {
  if (!streamId || getStreamPhase(streamId) === phase) {
    return;
  }

  missionPhaseByStream.set(streamId, phase);
  emitFlightLogStatus(streamId, phase);
}

function parseFlightModeMessage(message) {
  if (typeof message !== "string" || !message.startsWith(FLIGHT_MODE_MESSAGE_PREFIX)) {
    return null;
  }

  const payload = message.slice(FLIGHT_MODE_MESSAGE_PREFIX.length);
  const [modeKey = "", modeLabel = ""] = payload.split("|");
  if (!modeKey || !modeLabel) {
    return null;
  }

  return {
    modeKey,
    modeLabel,
  };
}

function resolveStreamPhase(modeKey) {
  if (modeKey === "takeoff") {
    return "departing";
  }

  if (modeKey === "complete") {
    return "complete";
  }

  return "recording";
}

function setCurrentFlightMode(streamId, modeKey, modeLabel, timestamp) {
  const currentMode = currentFlightModeByStream.get(streamId);
  currentFlightModeByStream.set(streamId, {
    modeKey,
    modeLabel,
  });
  setStreamPhase(streamId, resolveStreamPhase(modeKey));
  if (currentMode?.modeLabel === modeLabel) {
    return;
  }

  emitFlightLogEvent("dss:flight-mode-change", {
    streamId,
    modeKey,
    modeLabel,
    timestamp,
  });
}

function getCurrentFlightModeLabel(streamId) {
  return currentFlightModeByStream.get(streamId)?.modeLabel ?? getDefaultFlightModeLabel();
}

function resolveElapsedMilliseconds(streamId, detail) {
  const sampleTime = Number.isFinite(detail?.timestampMs)
    ? detail.timestampMs
    : Date.parse(detail?.timestamp);
  const effectiveSampleTime = Number.isNaN(sampleTime) ? Date.now() : sampleTime;
  if (!firstTelemetryTimestampByStream.has(streamId)) {
    firstTelemetryTimestampByStream.set(streamId, effectiveSampleTime);
  }

  return effectiveSampleTime - firstTelemetryTimestampByStream.get(streamId);
}

function trackTelemetrySample(detail) {
  if (!detail?.streamId) {
    return;
  }

  const signalProfile = getSignalProfile(detail.streamId, detail.droneKey);
  const sample = {
    timestamp: detail.timestamp,
    elapsed_ms: resolveElapsedMilliseconds(detail.streamId, detail),
    drone: detail.drone,
    scenario: detail.scenario ?? "",
    flight_mode: getCurrentFlightModeLabel(detail.streamId),
    lat: detail.lat,
    lon: detail.lon,
    alt_m: detail.alt_m,
    speed_mps: detail.speed_mps,
    accel_mps2: detail.accel_mps2,
    rcs_value: signalProfile.rcsValue,
    rssi_dbm: 0,
  };
  sample.rssi_dbm = Number(calculateEstimatedRssiDbm(detail.streamId, sample).toFixed(1));
  const streamSamples = getStreamSamples(detail.streamId);
  streamSamples.push(sample);
  if (detail.isPrimary) {
    telemetrySamples.push(sample);
  }

  emitFlightLogEvent("dss:flight-log-row", {
    streamId: detail.streamId,
    displayText: buildDisplayLogText(sample),
    rowCount: streamSamples.length,
  });
}

export function initializeFlightLog() {
  window.addEventListener("dss:telemetry", (event) => {
    trackTelemetrySample(event.detail);
  });

  window.addEventListener("dss:log", (event) => {
    if (!event.detail?.streamId) {
      return;
    }

    const modeChange = parseFlightModeMessage(event.detail.message);
    if (modeChange) {
      setCurrentFlightMode(
        event.detail.streamId,
        modeChange.modeKey,
        modeChange.modeLabel,
        event.detail.timestamp,
      );
      return;
    }

    if (event.detail.message === MISSION_RECORDING_START_MESSAGE || event.detail.message === MISSION_RECORDING_STOP_MESSAGE) {
      return;
    }
  });

  window.addEventListener("dss:telemetry-reset", () => {
    telemetrySamples = [];
    displaySamplesByStream.clear();
    firstTelemetryTimestampByStream.clear();
    signalOriginByStream.clear();
    signalProfileByStream.clear();
    currentFlightModeByStream.clear();
    missionPhaseByStream.clear();
    emitFlightLogEvent("dss:flight-log-reset", {});
  });
}

export function downloadFlightLog({ droneKey, scenarioKey }) {
  if (telemetrySamples.length === 0) {
    return false;
  }

  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const filename = `flight_log_${sanitizeFilenamePart(droneKey)}_${sanitizeFilenamePart(scenarioKey)}_${timestamp}.csv`;
  const csvContent = buildCsvContent(telemetrySamples, resolveSignalProfile(droneKey));
  triggerDownload(filename, csvContent);
  return {
    filename,
    csvText: csvContent,
  };
}
