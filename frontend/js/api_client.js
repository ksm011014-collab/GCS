const API_BASE_URL =
  window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "";


export async function loadDroneSpecs() {
  const response = await fetch(`${API_BASE_URL}/api/drone-specs`);
  if (!response.ok) {
    throw new Error(`Failed to load drone specs: ${response.status}`);
  }

  return response.json();
}


export async function createCustomDroneSpec(payload) {
  const response = await fetch(`${API_BASE_URL}/api/custom-drone-specs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Failed to save drone spec: ${response.status}`);
  }

  return response.json();
}


export async function updateDroneSpec(droneKey, payload) {
  const response = await fetch(`${API_BASE_URL}/api/drone-specs/${encodeURIComponent(droneKey)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Failed to update drone spec: ${response.status}`);
  }

  return response.json();
}


export async function deleteDroneSpec(droneKey) {
  const response = await fetch(`${API_BASE_URL}/api/drone-specs/${encodeURIComponent(droneKey)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(`Failed to delete drone spec: ${response.status}`);
  }

  return response.json();
}


export async function loadScenarios() {
  const response = await fetch(`${API_BASE_URL}/api/scenarios`);
  if (!response.ok) {
    throw new Error(`Failed to load scenarios: ${response.status}`);
  }

  return response.json();
}


export async function loadMavlinkSerialPorts() {
  const response = await fetch(`${API_BASE_URL}/api/mavlink/serial-ports`);
  if (!response.ok) {
    throw new Error(`Failed to load MAVLink serial ports: ${response.status}`);
  }

  return response.json();
}


export async function requestScenarioGeneration(payload) {
  const response = await fetch(`${API_BASE_URL}/api/scenarios/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Failed to generate scenario: ${response.status}`);
  }

  return response.json();
}


export async function loadReplayLogs() {
  const response = await fetch(`${API_BASE_URL}/api/replay/logs`);
  if (!response.ok) {
    throw new Error(`Failed to load replay logs: ${response.status}`);
  }

  return response.json();
}


export async function loadReplayLogDetail(logId) {
  const response = await fetch(`${API_BASE_URL}/api/replay/logs/${encodeURIComponent(logId)}`);
  if (!response.ok) {
    throw new Error(`Failed to load replay log detail: ${response.status}`);
  }

  return response.json();
}
