function emitEvent(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function parseSocketPayload(data) {
  try {
    const payload = JSON.parse(data);
    return payload && typeof payload === "object" ? payload : null;
  } catch (error) {
    return null;
  }
}

function resolveTimestampMs(timestamp) {
  const parsedTimestamp = Date.parse(timestamp);
  return Number.isNaN(parsedTimestamp) ? null : parsedTimestamp;
}

function buildEventDetail(payload, streamMetadata) {
  const timestampMs = typeof payload?.timestamp === "string"
    ? resolveTimestampMs(payload.timestamp)
    : null;
  return timestampMs === null
    ? {
        ...payload,
        ...streamMetadata,
      }
    : {
        ...payload,
        ...streamMetadata,
        timestampMs,
      };
}

export function createTelemetrySocket({
  droneName,
  scenarioKey,
  slotIndex = 0,
  formationSession = "",
  formationMember = "",
  formationSize = 1,
  formationHorizontalCapMps = null,
  formationAscentCapMps = null,
  formationDescentCapMps = null,
  streamId = "",
  streamLabel = "",
  droneKey = "",
  isPrimary = false,
  onOpen,
  onClose,
  onError,
}) {
  const isFileProtocol = window.location.protocol === "file:";
  const protocol = isFileProtocol
    ? "ws:"
    : window.location.protocol === "https:"
      ? "wss:"
      : "ws:";
  const host = isFileProtocol ? "127.0.0.1:8000" : window.location.host;
  const url = new URL(`${protocol}//${host}/ws/telemetry`);
  if (droneName) {
    url.searchParams.set("drone", droneName);
  }
  if (scenarioKey) {
    url.searchParams.set("scenario", scenarioKey);
  }
  url.searchParams.set("slot", String(slotIndex));
  if (formationSession) {
    url.searchParams.set("formation_session", formationSession);
  }
  if (formationMember) {
    url.searchParams.set("formation_member", formationMember);
  }
  url.searchParams.set("formation_size", String(formationSize));
  if (formationHorizontalCapMps !== null) {
    url.searchParams.set("formation_horizontal_cap_mps", String(formationHorizontalCapMps));
  }
  if (formationAscentCapMps !== null) {
    url.searchParams.set("formation_ascent_cap_mps", String(formationAscentCapMps));
  }
  if (formationDescentCapMps !== null) {
    url.searchParams.set("formation_descent_cap_mps", String(formationDescentCapMps));
  }

  const socket = new WebSocket(url);
  const streamMetadata = {
    streamId,
    streamLabel,
    droneKey,
    isPrimary,
    slotIndex,
  };

  socket.addEventListener("open", () => {
    if (onOpen) {
      onOpen(streamMetadata);
    }
  });

  socket.addEventListener("message", (event) => {
    const payload = parseSocketPayload(event.data);
    if (!payload) {
      return;
    }

    if (payload.type === "telemetry") {
      emitEvent("dss:telemetry", buildEventDetail(payload, streamMetadata));
      return;
    }

    if (payload.type === "progress") {
      emitEvent("dss:progress", {
        ...payload,
        ...streamMetadata,
      });
      return;
    }

    if (payload.type === "attitude") {
      emitEvent("dss:attitude", buildEventDetail(payload, streamMetadata));
      return;
    }

    if (payload.type === "log") {
      emitEvent("dss:log", buildEventDetail(payload, streamMetadata));
      return;
    }

    if (payload.type === "alert") {
      emitEvent("dss:alert", buildEventDetail(payload, streamMetadata));
      return;
    }

    if (payload.type === "live_status") {
      emitEvent("dss:live-status", buildEventDetail(payload, streamMetadata));
    }
  });

  socket.addEventListener("close", () => {
    if (onClose) {
      onClose(streamMetadata);
    }
  });

  socket.addEventListener("error", () => {
    if (onError) {
      onError(streamMetadata);
    }
  });

  return socket;
}

export function createLiveTelemetrySocket({
  linkType = "udp",
  endpoint = "udp:0.0.0.0:14550",
  baudrate = 115200,
  systemId = 0,
  componentId = 0,
  streamId = "drone-1-select",
  streamLabel = "실기체",
  droneKey = "inspire_3",
  isPrimary = true,
  onOpen,
  onClose,
  onError,
}) {
  const isFileProtocol = window.location.protocol === "file:";
  const protocol = isFileProtocol
    ? "ws:"
    : window.location.protocol === "https:"
      ? "wss:"
      : "ws:";
  const host = isFileProtocol ? "127.0.0.1:8000" : window.location.host;
  const url = new URL(`${protocol}//${host}/ws/live-telemetry`);
  url.searchParams.set("link_type", linkType);
  url.searchParams.set("endpoint", endpoint);
  url.searchParams.set("baudrate", String(baudrate));
  url.searchParams.set("system_id", String(systemId));
  url.searchParams.set("component_id", String(componentId));

  const socket = new WebSocket(url);
  const streamMetadata = {
    streamId,
    streamLabel,
    droneKey,
    isPrimary,
    slotIndex: 0,
  };

  socket.addEventListener("open", () => {
    if (onOpen) {
      onOpen(streamMetadata);
    }
  });

  socket.addEventListener("message", (event) => {
    const payload = parseSocketPayload(event.data);
    if (!payload) {
      return;
    }

    if (payload.type === "telemetry") {
      emitEvent("dss:telemetry", buildEventDetail(payload, streamMetadata));
      return;
    }

    if (payload.type === "attitude") {
      emitEvent("dss:attitude", buildEventDetail(payload, streamMetadata));
      return;
    }

    if (payload.type === "log") {
      emitEvent("dss:log", buildEventDetail(payload, streamMetadata));
      return;
    }

    if (payload.type === "alert") {
      emitEvent("dss:alert", buildEventDetail(payload, streamMetadata));
      return;
    }

    if (payload.type === "live_status") {
      emitEvent("dss:live-status", buildEventDetail(payload, streamMetadata));
    }
  });

  socket.addEventListener("close", () => {
    if (onClose) {
      onClose(streamMetadata);
    }
  });

  socket.addEventListener("error", () => {
    if (onError) {
      onError(streamMetadata);
    }
  });

  return socket;
}

export function sendTelemetryControl(socket, action) {
  if (!(socket instanceof WebSocket) || socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  socket.send(JSON.stringify({
    type: "control",
    action,
  }));
  return true;
}

export function sendLiveCommand(socket, action, payload = {}) {
  if (!(socket instanceof WebSocket) || socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  socket.send(JSON.stringify({
    type: "live_command",
    action,
    ...payload,
  }));
  return true;
}
