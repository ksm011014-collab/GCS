import {
  createCustomDroneSpec,
  deleteDroneSpec,
  loadDroneSpecs,
  updateDroneSpec,
} from "./api_client.js";

const DEFAULT_CATEGORY = "사용자 정의 기체";
const DEFAULT_MAX_HORIZONTAL_SPEED_MPS = 18.0;
const DEFAULT_MAX_ASCENT_SPEED_MPS = 5.0;
const DEFAULT_MAX_DESCENT_SPEED_MPS = 4.0;
const DEFAULT_MAX_SERVICE_CEILING_M = 3000.0;
const DEFAULT_MAX_FLIGHT_TIME_MIN = 25.0;
const DEFAULT_WEIGHT_G = 900.0;
const DEFAULT_RCS_ESTIMATE_M2 = 0.03;
const NEW_DRONE_OPTION_VALUE = "__new__";

let managedDroneSpecs = [];
let selectedManagedDroneKey = NEW_DRONE_OPTION_VALUE;

function getElement(id) {
  return document.getElementById(id);
}

function getSelectedManagedDroneSpec() {
  return managedDroneSpecs.find((droneSpec) => droneSpec.key === selectedManagedDroneKey) ?? null;
}

function isSelectedBuiltinDroneSpec(droneSpec = getSelectedManagedDroneSpec()) {
  return Boolean(droneSpec && !droneSpec.is_custom);
}

function parseRequiredNumber(inputId, fallbackValue) {
  const inputElement = getElement(inputId);
  if (!(inputElement instanceof HTMLInputElement)) {
    return fallbackValue;
  }

  const numericValue = Number(inputElement.value);
  return Number.isFinite(numericValue) ? numericValue : fallbackValue;
}

function parseOptionalNumber(inputId) {
  const inputElement = getElement(inputId);
  if (!(inputElement instanceof HTMLInputElement)) {
    return null;
  }

  const normalizedValue = inputElement.value.trim();
  if (!normalizedValue) {
    return null;
  }

  const numericValue = Number(normalizedValue);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function parseOptionalText(inputId) {
  const inputElement = getElement(inputId);
  if (!(inputElement instanceof HTMLInputElement)) {
    return null;
  }

  const normalizedValue = inputElement.value.trim();
  return normalizedValue || null;
}

function setCustomDroneStatus(message, isError = false) {
  const statusElement = getElement("custom-drone-status");
  if (!statusElement) {
    return;
  }

  statusElement.textContent = message;
  statusElement.dataset.state = isError ? "error" : "idle";
}

function setInputValue(id, value) {
  const inputElement = getElement(id);
  if (inputElement instanceof HTMLInputElement) {
    inputElement.value = value;
  }
}

function resetCustomDroneForm() {
  setInputValue("custom-drone-name", "");
  setInputValue("custom-drone-category", DEFAULT_CATEGORY);
  setInputValue("custom-drone-max-horizontal-speed", DEFAULT_MAX_HORIZONTAL_SPEED_MPS.toFixed(1));
  setInputValue("custom-drone-max-ascent-speed", DEFAULT_MAX_ASCENT_SPEED_MPS.toFixed(1));
  setInputValue("custom-drone-max-descent-speed", DEFAULT_MAX_DESCENT_SPEED_MPS.toFixed(1));
  setInputValue("custom-drone-max-service-ceiling", DEFAULT_MAX_SERVICE_CEILING_M.toFixed(1));
  setInputValue("custom-drone-max-flight-time", DEFAULT_MAX_FLIGHT_TIME_MIN.toFixed(1));
  setInputValue("custom-drone-weight", DEFAULT_WEIGHT_G.toFixed(1));
  setInputValue("custom-drone-rcs", DEFAULT_RCS_ESTIMATE_M2.toFixed(2));
  setInputValue("custom-drone-rf-signature", "");
  setInputValue("custom-drone-rf-band", "");
  setInputValue("custom-drone-acoustic-signature", "");
  setInputValue("custom-drone-thermal-signature", "");
  setInputValue("custom-drone-payload-capacity", "");
  setInputValue("custom-drone-sensor-notes", "");
}

function applyDroneSpecToForm(droneSpec) {
  if (!droneSpec) {
    resetCustomDroneForm();
    return;
  }

  setInputValue("custom-drone-name", droneSpec.name ?? "");
  setInputValue("custom-drone-category", droneSpec.category ?? DEFAULT_CATEGORY);
  setInputValue("custom-drone-max-horizontal-speed", Number(droneSpec.max_horizontal_speed_mps).toFixed(1));
  setInputValue("custom-drone-max-ascent-speed", Number(droneSpec.max_ascent_speed_mps).toFixed(1));
  setInputValue("custom-drone-max-descent-speed", Number(droneSpec.max_descent_speed_mps).toFixed(1));
  setInputValue("custom-drone-max-service-ceiling", Number(droneSpec.max_service_ceiling_m).toFixed(1));
  setInputValue("custom-drone-max-flight-time", Number(droneSpec.max_flight_time_min).toFixed(1));
  setInputValue("custom-drone-weight", Number(droneSpec.weight_g).toFixed(1));
  setInputValue("custom-drone-rcs", Number(droneSpec.rcs_estimate_m2).toFixed(2));
  setInputValue("custom-drone-rf-signature", droneSpec.rf_signature ?? "");
  setInputValue("custom-drone-rf-band", droneSpec.rf_band ?? "");
  setInputValue("custom-drone-acoustic-signature", droneSpec.acoustic_signature_hz ?? "");
  setInputValue("custom-drone-thermal-signature", droneSpec.thermal_signature_level ?? "");
  setInputValue("custom-drone-payload-capacity", droneSpec.payload_capacity_g ?? "");
  setInputValue("custom-drone-sensor-notes", droneSpec.sensor_notes ?? "");
}

function buildCustomDronePayload() {
  return {
    name: parseOptionalText("custom-drone-name") ?? "",
    category: parseOptionalText("custom-drone-category") ?? DEFAULT_CATEGORY,
    max_horizontal_speed_mps: parseRequiredNumber(
      "custom-drone-max-horizontal-speed",
      DEFAULT_MAX_HORIZONTAL_SPEED_MPS,
    ),
    max_ascent_speed_mps: parseRequiredNumber(
      "custom-drone-max-ascent-speed",
      DEFAULT_MAX_ASCENT_SPEED_MPS,
    ),
    max_descent_speed_mps: parseRequiredNumber(
      "custom-drone-max-descent-speed",
      DEFAULT_MAX_DESCENT_SPEED_MPS,
    ),
    max_service_ceiling_m: parseRequiredNumber(
      "custom-drone-max-service-ceiling",
      DEFAULT_MAX_SERVICE_CEILING_M,
    ),
    max_flight_time_min: parseRequiredNumber(
      "custom-drone-max-flight-time",
      DEFAULT_MAX_FLIGHT_TIME_MIN,
    ),
    weight_g: parseRequiredNumber("custom-drone-weight", DEFAULT_WEIGHT_G),
    rcs_estimate_m2: parseRequiredNumber("custom-drone-rcs", DEFAULT_RCS_ESTIMATE_M2),
    rf_signature: parseOptionalText("custom-drone-rf-signature"),
    rf_band: parseOptionalText("custom-drone-rf-band"),
    acoustic_signature_hz: parseOptionalNumber("custom-drone-acoustic-signature"),
    thermal_signature_level: parseOptionalText("custom-drone-thermal-signature"),
    payload_capacity_g: parseOptionalNumber("custom-drone-payload-capacity"),
    sensor_notes: parseOptionalText("custom-drone-sensor-notes"),
  };
}

function buildManagedDroneOptionLabel(droneSpec) {
  const sourceLabel = droneSpec.is_custom ? "사용자" : "기본";
  const overrideLabel = droneSpec.is_overridden ? " · 수정됨" : "";
  return `[${sourceLabel}] ${droneSpec.name}${overrideLabel}`;
}

function renderManagedDroneSelect() {
  const selectElement = getElement("custom-drone-select");
  if (!(selectElement instanceof HTMLSelectElement)) {
    return;
  }

  const availableDroneKeys = new Set(managedDroneSpecs.map((droneSpec) => droneSpec.key));
  if (selectedManagedDroneKey !== NEW_DRONE_OPTION_VALUE && !availableDroneKeys.has(selectedManagedDroneKey)) {
    selectedManagedDroneKey = NEW_DRONE_OPTION_VALUE;
  }

  selectElement.innerHTML = "";
  selectElement.append(new Option("새 사용자 기체", NEW_DRONE_OPTION_VALUE));
  managedDroneSpecs.forEach((droneSpec) => {
    selectElement.append(new Option(
      buildManagedDroneOptionLabel(droneSpec),
      droneSpec.key,
      false,
      droneSpec.key === selectedManagedDroneKey,
    ));
  });
  selectElement.value = selectedManagedDroneKey;
}

function renderManagedDroneActions() {
  const saveButton = getElement("custom-drone-save-button");
  const deleteButton = getElement("custom-drone-delete-button");
  const selectedDroneSpec = getSelectedManagedDroneSpec();

  if (saveButton instanceof HTMLButtonElement) {
    if (!selectedDroneSpec) {
      saveButton.textContent = "사용자 기체 저장";
    } else if (selectedDroneSpec.is_custom) {
      saveButton.textContent = "사용자 기체 수정";
    } else {
      saveButton.textContent = "기본 기체 수정";
    }
  }

  if (deleteButton instanceof HTMLButtonElement) {
    if (!selectedDroneSpec) {
      deleteButton.textContent = "삭제";
      deleteButton.disabled = true;
      return;
    }

    if (selectedDroneSpec.is_custom) {
      deleteButton.textContent = "삭제";
      deleteButton.disabled = false;
      return;
    }

    deleteButton.textContent = "기본값 복원";
    deleteButton.disabled = !selectedDroneSpec.is_overridden;
  }
}

function syncManagedDroneForm() {
  renderManagedDroneSelect();
  applyDroneSpecToForm(getSelectedManagedDroneSpec());
  renderManagedDroneActions();

  const selectedDroneSpec = getSelectedManagedDroneSpec();
  if (!selectedDroneSpec) {
    setCustomDroneStatus("기체 정보를 입력해 사용자 정의 드론을 추가하세요.");
    return;
  }

  if (selectedDroneSpec.is_custom) {
    setCustomDroneStatus(`사용자 기체 편집 중: ${selectedDroneSpec.name}`);
    return;
  }

  if (selectedDroneSpec.is_overridden) {
    setCustomDroneStatus(`기본 기체 오버라이드 편집 중: ${selectedDroneSpec.name}`);
    return;
  }

  setCustomDroneStatus(`기본 기체 편집 중: ${selectedDroneSpec.name}`);
}

async function loadManagedDroneSpecs({ selectedKey = selectedManagedDroneKey } = {}) {
  managedDroneSpecs = await loadDroneSpecs();
  selectedManagedDroneKey = selectedKey;
  syncManagedDroneForm();
}

function selectManagedDrone(droneKey) {
  selectedManagedDroneKey = droneKey || NEW_DRONE_OPTION_VALUE;
  syncManagedDroneForm();
}

async function saveManagedDroneSpec() {
  const saveButton = getElement("custom-drone-save-button");
  const payload = buildCustomDronePayload();
  const selectedDroneSpec = getSelectedManagedDroneSpec();

  if (!payload.name) {
    setCustomDroneStatus("기체 이름을 입력하세요.", true);
    getElement("custom-drone-name")?.focus();
    return;
  }

  if (saveButton instanceof HTMLButtonElement) {
    saveButton.disabled = true;
  }

  try {
    let savedSpec;
    if (!selectedDroneSpec) {
      setCustomDroneStatus("사용자 기체 저장 중...");
      savedSpec = await createCustomDroneSpec(payload);
      selectedManagedDroneKey = savedSpec.key;
    } else {
      setCustomDroneStatus(`${selectedDroneSpec.name} 수정 저장 중...`);
      savedSpec = await updateDroneSpec(selectedDroneSpec.key, payload);
      selectedManagedDroneKey = savedSpec.key;
    }

    await loadManagedDroneSpecs({ selectedKey: selectedManagedDroneKey });
    setCustomDroneStatus(
      selectedDroneSpec
        ? `기체 정보 저장 완료: ${savedSpec.name}`
        : `사용자 기체 저장 완료: ${savedSpec.name}`,
    );
    window.dispatchEvent(new CustomEvent("dss:custom-drone-saved", {
      detail: savedSpec,
    }));
  } catch (error) {
    setCustomDroneStatus("기체 정보 저장 실패", true);
    console.error(error);
  } finally {
    renderManagedDroneActions();
    if (saveButton instanceof HTMLButtonElement) {
      saveButton.disabled = false;
    }
  }
}

async function deleteManagedDroneSpec() {
  const selectedDroneSpec = getSelectedManagedDroneSpec();
  const deleteButton = getElement("custom-drone-delete-button");
  if (!selectedDroneSpec) {
    setCustomDroneStatus("삭제할 기체를 먼저 선택하세요.", true);
    return;
  }

  if (deleteButton instanceof HTMLButtonElement) {
    deleteButton.disabled = true;
  }

  const deletingBuiltinOverride = isSelectedBuiltinDroneSpec(selectedDroneSpec);
  setCustomDroneStatus(
    deletingBuiltinOverride
      ? `기본 기체 복원 중: ${selectedDroneSpec.name}`
      : `사용자 기체 삭제 중: ${selectedDroneSpec.name}`,
  );

  try {
    const deletedSpec = await deleteDroneSpec(selectedDroneSpec.key);
    selectedManagedDroneKey = deletingBuiltinOverride ? selectedDroneSpec.key : NEW_DRONE_OPTION_VALUE;
    await loadManagedDroneSpecs({ selectedKey: selectedManagedDroneKey });
    setCustomDroneStatus(
      deletedSpec.restored_builtin
        ? `기본 기체 복원 완료: ${deletedSpec.name}`
        : `사용자 기체 삭제 완료: ${deletedSpec.name}`,
    );
    window.dispatchEvent(new CustomEvent("dss:custom-drone-deleted", {
      detail: deletedSpec,
    }));
  } catch (error) {
    setCustomDroneStatus("기체 삭제 실패", true);
    console.error(error);
  } finally {
    renderManagedDroneActions();
    if (deleteButton instanceof HTMLButtonElement) {
      deleteButton.disabled = false;
    }
  }
}

export function initializeCustomDroneBuilder() {
  const selectElement = getElement("custom-drone-select");
  if (selectElement instanceof HTMLSelectElement) {
    selectElement.addEventListener("change", () => {
      selectManagedDrone(selectElement.value);
    });
  }

  getElement("custom-drone-new-button")?.addEventListener("click", () => {
    selectManagedDrone(NEW_DRONE_OPTION_VALUE);
  });
  getElement("custom-drone-save-button")?.addEventListener("click", () => {
    void saveManagedDroneSpec();
  });
  getElement("custom-drone-delete-button")?.addEventListener("click", () => {
    void deleteManagedDroneSpec();
  });

  resetCustomDroneForm();
  renderManagedDroneActions();
  setCustomDroneStatus("기체 목록 불러오는 중...");
  void loadManagedDroneSpecs();
}
