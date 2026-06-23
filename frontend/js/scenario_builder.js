import {
  clearScenarioEditorWaypoints,
  focusScenarioEditorDraft,
  getDefaultScenarioEditorDraft,
  removeScenarioEditorWaypoint,
  selectScenarioEditorWaypoint,
  setScenarioEditorDraft,
  setScenarioEditorEnabled,
  setScenarioEditorMode,
  updateScenarioEditorHome,
  updateScenarioEditorWaypoint,
} from "./map.js?v=7";

const API_BASE_URL =
  window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "";

const DEFAULT_SCENARIO_NAME = "사용자 비행 계획";
const DEFAULT_CLIMB_SPEED_MPS = 2.4;
const DEFAULT_DESCENT_SPEED_MPS = 1.8;
const DEFAULT_VERTICAL_ACCEL_MPS2 = 1.0;
const DEFAULT_APP_MODE = "simulation";
const DEFAULT_PANEL_TAB_BY_MODE = {
  simulation: "simulation",
  "ground-control": "live",
};
const PANEL_TAB_APP_MODE = {
  simulation: "simulation",
  builder: "simulation",
  "drone-builder": "simulation",
  replay: "simulation",
  live: "ground-control",
  flight: "ground-control",
};
const SIMULATION_SCENARIO_SELECT_IDS = [
  "scenario-1-select",
  "scenario-2-select",
  "scenario-3-select",
];

let builderState = createInitialBuilderState();

function createInitialBuilderState() {
  const draft = getDefaultScenarioEditorDraft();
  return {
    appMode: DEFAULT_APP_MODE,
    activeTab: "simulation",
    lastPanelTabByMode: { ...DEFAULT_PANEL_TAB_BY_MODE },
    mode: null,
    selectedScenarioKey: "",
    selectedScenarioIsCustom: false,
    name: DEFAULT_SCENARIO_NAME,
    target_climb_speed_mps: DEFAULT_CLIMB_SPEED_MPS,
    target_descent_speed_mps: DEFAULT_DESCENT_SPEED_MPS,
    vertical_accel_limit_mps2: DEFAULT_VERTICAL_ACCEL_MPS2,
    home: draft.home,
    waypoints: draft.waypoints,
    selectedWaypointId: draft.selectedWaypointId,
  };
}

function getElement(id) {
  return document.getElementById(id);
}

function createOption(value, label, selected = false) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  option.selected = selected;
  return option;
}

function parseNumericInput(inputElement, fallbackValue) {
  if (!(inputElement instanceof HTMLInputElement)) {
    return fallbackValue;
  }

  const numericValue = Number(inputElement.value);
  return Number.isFinite(numericValue) ? numericValue : fallbackValue;
}

function formatCoordinate(value) {
  return Number.isFinite(value) ? value.toFixed(6) : "-";
}

function getDefaultSaveButtonLabel() {
  return builderState.selectedScenarioIsCustom ? "비행 계획 수정 저장" : "비행 계획 저장";
}


function normalizeAppMode(appMode) {
  return appMode === "ground-control" ? "ground-control" : DEFAULT_APP_MODE;
}


function getPanelTabAppMode(tabName) {
  return PANEL_TAB_APP_MODE[tabName] ?? DEFAULT_APP_MODE;
}


function getPanelTabsForMode(appMode) {
  return Object.entries(PANEL_TAB_APP_MODE)
    .filter(([, modeName]) => modeName === appMode)
    .map(([tabName]) => tabName);
}


function renderAppModeLayout() {
  document.body.dataset.appMode = builderState.appMode;
  document.body.dataset.panelTab = builderState.activeTab;

  document.querySelectorAll("[data-app-mode-switch]").forEach((button) => {
    const isActive = button.dataset.appModeSwitch === builderState.appMode;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });

  document.querySelectorAll("[data-panel-tab]").forEach((button) => {
    const isVisible = (button.dataset.appMode ?? DEFAULT_APP_MODE) === builderState.appMode;
    button.hidden = !isVisible;
  });
}

let saveButtonResetTimer = null;

function setSaveButtonMessage(message, { disabled = false, resetAfterMs = 0 } = {}) {
  const saveButton = getElement("builder-save-button");
  if (!(saveButton instanceof HTMLButtonElement)) {
    return;
  }

  saveButton.textContent = message;
  saveButton.disabled = disabled;

  if (saveButtonResetTimer) {
    window.clearTimeout(saveButtonResetTimer);
    saveButtonResetTimer = null;
  }

  if (resetAfterMs > 0) {
    saveButtonResetTimer = window.setTimeout(() => {
      saveButton.textContent = getDefaultSaveButtonLabel();
      saveButton.disabled = false;
      saveButtonResetTimer = null;
    }, resetAfterMs);
  }
}

function getSelectedWaypoint() {
  return builderState.waypoints.find(
    (waypoint) => waypoint.id === builderState.selectedWaypointId,
  ) ?? null;
}

function updateBuilderScenarioDeleteButton() {
  const deleteButton = getElement("builder-scenario-delete-button");
  if (!(deleteButton instanceof HTMLButtonElement)) {
    return;
  }

  deleteButton.disabled = !builderState.selectedScenarioIsCustom || !builderState.selectedScenarioKey;
}

function syncBuilderActionLabels() {
  const saveButton = getElement("builder-save-button");
  if (saveButton instanceof HTMLButtonElement && !saveButton.disabled && !saveButtonResetTimer) {
    saveButton.textContent = getDefaultSaveButtonLabel();
  }

  updateBuilderScenarioDeleteButton();
}

function setActiveBuilderTab(tabName, { syncAppMode = true } = {}) {
  const normalizedTabName = PANEL_TAB_APP_MODE[tabName] ? tabName : DEFAULT_PANEL_TAB_BY_MODE[DEFAULT_APP_MODE];
  const targetAppMode = getPanelTabAppMode(normalizedTabName);

  if (syncAppMode) {
    builderState.appMode = targetAppMode;
    renderAppModeLayout();
    window.dispatchEvent(new CustomEvent("dss:app-mode-change", {
      detail: {
        appMode: builderState.appMode,
        activeTab: normalizedTabName,
      },
    }));
  }

  builderState.lastPanelTabByMode[targetAppMode] = normalizedTabName;
  builderState.activeTab = normalizedTabName;

  document.querySelectorAll("[data-panel-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.panelTab === normalizedTabName);
  });

  getElement("simulation-panel")?.classList.toggle("is-active", normalizedTabName === "simulation");
  getElement("live-panel")?.classList.toggle("is-active", normalizedTabName === "live");
  getElement("builder-panel")?.classList.toggle("is-active", normalizedTabName === "builder");
  getElement("drone-builder-panel")?.classList.toggle("is-active", normalizedTabName === "drone-builder");
  getElement("replay-panel")?.classList.toggle("is-active", normalizedTabName === "replay");
  getElement("flight-panel")?.classList.toggle("is-active", normalizedTabName === "flight");
  document.body.dataset.panelTab = normalizedTabName;

  if (normalizedTabName === "builder") {
    setScenarioEditorDraft({
      home: builderState.home,
      waypoints: builderState.waypoints,
      selectedWaypointId: builderState.selectedWaypointId,
    });
    setScenarioEditorEnabled(true);
    void hydrateBuilderScenarioOnOpen();
  } else {
    setScenarioEditorEnabled(false);
  }

  window.dispatchEvent(new CustomEvent("dss:panel-tab-change", {
    detail: {
      tabName: normalizedTabName,
    },
  }));
}


function setActiveAppMode(appMode) {
  const normalizedMode = normalizeAppMode(appMode);
  if (builderState.appMode === normalizedMode) {
    renderAppModeLayout();
    return;
  }

  builderState.appMode = normalizedMode;
  renderAppModeLayout();

  const availableTabs = getPanelTabsForMode(normalizedMode);
  let nextTab = builderState.lastPanelTabByMode[normalizedMode] ?? DEFAULT_PANEL_TAB_BY_MODE[normalizedMode];
  if (!availableTabs.includes(nextTab)) {
    nextTab = DEFAULT_PANEL_TAB_BY_MODE[normalizedMode];
  }

  window.dispatchEvent(new CustomEvent("dss:app-mode-change", {
    detail: {
      appMode: builderState.appMode,
      activeTab: nextTab,
    },
  }));
  setActiveBuilderTab(nextTab, { syncAppMode: false });
}

function setNavigationMenuOpen(isOpen) {
  const mapHud = getElement("map-hud");
  const menuButton = getElement("map-menu-button");
  const mobilePanelButton = getElement("mobile-panel-button");
  const navigation = getElement("right-tabs");

  mapHud?.classList.toggle("is-open", isOpen);
  document.body.classList.toggle("mobile-panel-open", isOpen);

  [menuButton, mobilePanelButton].forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    button.setAttribute("aria-expanded", String(isOpen));
    button.setAttribute(
      "aria-label",
      isOpen ? "모바일 메뉴 닫기" : "모바일 메뉴 열기",
    );
  });

  navigation?.setAttribute("aria-hidden", String(!isOpen));
}

function isNavigationMenuOpen() {
  return getElement("map-hud")?.classList.contains("is-open") ?? false;
}

function initializeNavigationMenu() {
  const menuButton = getElement("map-menu-button");
  const mobilePanelButton = getElement("mobile-panel-button");

  syncNavigationPlacement();
  setNavigationMenuOpen(false);
  [menuButton, mobilePanelButton].forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    button.addEventListener("click", () => {
      setNavigationMenuOpen(!isNavigationMenuOpen());
    });
  });
  window.addEventListener("resize", syncNavigationPlacement);
}

function syncNavigationPlacement() {
  const mapHud = getElement("map-hud");
  const rightPanel = getElement("right-panel");
  const navigation = getElement("right-tabs");
  const mobilePanelButton = getElement("mobile-panel-button");
  if (!mapHud || !rightPanel || !navigation) {
    return;
  }

  const shouldUseMobilePanel = window.matchMedia("(max-width: 820px)").matches;
  if (mobilePanelButton instanceof HTMLButtonElement) {
    mobilePanelButton.style.display = "";
    mobilePanelButton.style.position = "";
    mobilePanelButton.style.top = "";
    mobilePanelButton.style.left = "";
    mobilePanelButton.style.right = "";
    mobilePanelButton.style.zIndex = "";
  }

  if (shouldUseMobilePanel && navigation.parentElement !== rightPanel) {
    rightPanel.prepend(navigation);
    return;
  }

  if (!shouldUseMobilePanel && navigation.parentElement !== mapHud) {
    mapHud.appendChild(navigation);
  }
}

function renderWaypointList() {
  const listElement = getElement("builder-waypoint-list");
  if (!listElement) {
    return;
  }

  if (builderState.waypoints.length === 0) {
    listElement.innerHTML = '<div class="builder-empty">추가된 웨이포인트가 없습니다.</div>';
    return;
  }

  listElement.innerHTML = builderState.waypoints
    .map((waypoint, index) => `
      <button
        type="button"
        class="builder-waypoint-item${waypoint.id === builderState.selectedWaypointId ? " is-active" : ""}"
        data-builder-waypoint-id="${waypoint.id}"
      >
        <span class="builder-waypoint-title">WP ${index + 1}</span>
        <span>고도 ${waypoint.alt_m.toFixed(1)}m | 속도 ${waypoint.target_speed_mps.toFixed(1)}m/s</span><br />
        <span>대기 ${waypoint.hold_seconds.toFixed(1)}s</span>
      </button>
    `)
    .join("");

  listElement.querySelectorAll("[data-builder-waypoint-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const waypointId = button.dataset.builderWaypointId ?? "";
      selectScenarioEditorWaypoint(waypointId);
    });
  });
}

function renderWaypointEditor() {
  const selectedWaypoint = getSelectedWaypoint();
  const emptyElement = getElement("builder-waypoint-empty");
  const fieldsElement = getElement("builder-waypoint-fields");

  if (!selectedWaypoint) {
    emptyElement?.classList.remove("is-hidden");
    fieldsElement?.classList.add("is-hidden");
    return;
  }

  emptyElement?.classList.add("is-hidden");
  fieldsElement?.classList.remove("is-hidden");

  const waypointCoords = getElement("builder-waypoint-coords");
  const waypointAlt = getElement("builder-waypoint-alt");
  const waypointSpeed = getElement("builder-waypoint-speed");
  const waypointHold = getElement("builder-waypoint-hold");

  if (waypointCoords) {
    waypointCoords.textContent = `위도 ${formatCoordinate(selectedWaypoint.lat)}\n경도 ${formatCoordinate(selectedWaypoint.lon)}`;
  }
  if (waypointAlt instanceof HTMLInputElement) {
    waypointAlt.value = selectedWaypoint.alt_m.toFixed(1);
  }
  if (waypointSpeed instanceof HTMLInputElement) {
    waypointSpeed.value = selectedWaypoint.target_speed_mps.toFixed(1);
  }
  if (waypointHold instanceof HTMLInputElement) {
    waypointHold.value = selectedWaypoint.hold_seconds.toFixed(1);
  }
}

function renderBuilderPanel() {
  const builderScenarioSelect = getElement("builder-scenario-select");
  if (builderScenarioSelect instanceof HTMLSelectElement) {
    builderScenarioSelect.value = builderState.selectedScenarioKey;
  }

  const scenarioNameInput = getElement("builder-scenario-name");
  if (scenarioNameInput instanceof HTMLInputElement) {
    scenarioNameInput.value = builderState.name;
  }

  const climbSpeedInput = getElement("builder-climb-speed");
  if (climbSpeedInput instanceof HTMLInputElement) {
    climbSpeedInput.value = builderState.target_climb_speed_mps.toFixed(1);
  }

  const descentSpeedInput = getElement("builder-descent-speed");
  if (descentSpeedInput instanceof HTMLInputElement) {
    descentSpeedInput.value = builderState.target_descent_speed_mps.toFixed(1);
  }

  const homeCoords = getElement("builder-home-coords");
  if (homeCoords) {
    homeCoords.textContent = `위도 ${formatCoordinate(builderState.home.lat)}\n경도 ${formatCoordinate(builderState.home.lon)}`;
  }

  getElement("builder-set-home-button")?.classList.toggle("is-active", builderState.mode === "home");
  getElement("builder-add-waypoint-button")?.classList.toggle("is-active", builderState.mode === "waypoint");

  syncBuilderActionLabels();
  renderWaypointList();
  renderWaypointEditor();
}

function handleScenarioEditorChange(event) {
  builderState = {
    ...builderState,
    mode: event.detail?.mode ?? null,
    home: event.detail?.home ?? builderState.home,
    waypoints: event.detail?.waypoints ?? builderState.waypoints,
    selectedWaypointId: event.detail?.selectedWaypointId ?? null,
  };
  renderBuilderPanel();
}

async function loadScenarioCatalog() {
  const response = await fetch(`${API_BASE_URL}/api/scenarios`);
  if (!response.ok) {
    throw new Error(`Failed to load scenarios: ${response.status}`);
  }

  return response.json();
}

async function loadScenarioDetail(scenarioKey) {
  const response = await fetch(`${API_BASE_URL}/api/scenarios/${encodeURIComponent(scenarioKey)}`);
  if (!response.ok) {
    throw new Error(`Failed to load scenario detail: ${response.status}`);
  }

  return response.json();
}

function populateBuilderScenarioSelect(scenarios, selectedValue = "") {
  const selectElement = getElement("builder-scenario-select");
  if (!(selectElement instanceof HTMLSelectElement)) {
    return;
  }

  selectElement.innerHTML = "";
  selectElement.appendChild(createOption("", "비행 계획 추가", selectedValue === ""));
  scenarios.forEach((scenario) => {
    selectElement.appendChild(createOption(
      scenario.key,
      scenario.name,
      selectedValue === scenario.key,
    ));
  });

  if (!selectedValue) {
    selectElement.value = "";
  }
}

async function reloadBuilderScenarioSelect(selectedScenarioKey = builderState.selectedScenarioKey) {
  const scenarios = await loadScenarioCatalog();
  populateBuilderScenarioSelect(scenarios, selectedScenarioKey);
  renderBuilderPanel();
}

function resetBuilderToNewScenario() {
  const nextState = createInitialBuilderState();
  builderState = {
    ...nextState,
    activeTab: builderState.activeTab,
  };
  setScenarioEditorDraft({
    home: builderState.home,
    waypoints: builderState.waypoints,
    selectedWaypointId: builderState.selectedWaypointId,
  });
  focusScenarioEditorDraft();
  renderBuilderPanel();
}

function applyScenarioDetailToBuilder(detail) {
  builderState = {
    ...builderState,
    mode: null,
    selectedScenarioKey: detail.key,
    selectedScenarioIsCustom: Boolean(detail.is_custom),
    name: detail.name || DEFAULT_SCENARIO_NAME,
    target_climb_speed_mps: Number(detail.target_climb_speed_mps) || DEFAULT_CLIMB_SPEED_MPS,
    target_descent_speed_mps: Number(detail.target_descent_speed_mps) || DEFAULT_DESCENT_SPEED_MPS,
    vertical_accel_limit_mps2: Number(detail.vertical_accel_limit_mps2) || DEFAULT_VERTICAL_ACCEL_MPS2,
    home: detail.home ?? getDefaultScenarioEditorDraft().home,
    waypoints: Array.isArray(detail.waypoints) ? detail.waypoints : [],
    selectedWaypointId: null,
  };
  setScenarioEditorDraft({
    home: builderState.home,
    waypoints: builderState.waypoints,
    selectedWaypointId: null,
  });
  focusScenarioEditorDraft();
  renderBuilderPanel();
}

async function handleBuilderScenarioSelectionChange() {
  const selectElement = getElement("builder-scenario-select");
  if (!(selectElement instanceof HTMLSelectElement)) {
    return;
  }

  const nextScenarioKey = selectElement.value;
  if (!nextScenarioKey) {
    resetBuilderToNewScenario();
    return;
  }

  try {
    await loadScenarioIntoBuilder(nextScenarioKey);
  } catch (error) {
    resetBuilderToNewScenario();
    setSaveButtonMessage("불러오기 실패", { resetAfterMs: 1600 });
    console.error(error);
  }
}

async function loadScenarioIntoBuilder(scenarioKey) {
  if (!scenarioKey) {
    resetBuilderToNewScenario();
    return;
  }

  const detail = await loadScenarioDetail(scenarioKey);
  applyScenarioDetailToBuilder(detail);
}

function getPreferredScenarioKeyFromSimulationSelectors() {
  for (const selectId of SIMULATION_SCENARIO_SELECT_IDS) {
    const selectElement = getElement(selectId);
    if (!(selectElement instanceof HTMLSelectElement)) {
      continue;
    }

    const scenarioKey = String(selectElement.value || "").trim();
    if (scenarioKey) {
      return scenarioKey;
    }
  }

  return "";
}

function shouldHydrateBuilderFromSimulationSelection() {
  return !builderState.selectedScenarioKey
    && builderState.waypoints.length === 0
    && builderState.name === DEFAULT_SCENARIO_NAME;
}

async function hydrateBuilderScenarioOnOpen() {
  const scenarioKeyToLoad = builderState.selectedScenarioKey || (
    shouldHydrateBuilderFromSimulationSelection()
      ? getPreferredScenarioKeyFromSimulationSelectors()
      : ""
  );

  if (!scenarioKeyToLoad) {
    renderBuilderPanel();
    return;
  }

  try {
    await loadScenarioIntoBuilder(scenarioKeyToLoad);
  } catch (error) {
    setSaveButtonMessage("불러오기 실패", { resetAfterMs: 1600 });
    console.error(error);
  }
}

function buildScenarioPayload() {
  return {
    name: builderState.name.trim(),
    home: builderState.home,
    target_climb_speed_mps: builderState.target_climb_speed_mps,
    target_descent_speed_mps: builderState.target_descent_speed_mps,
    vertical_accel_limit_mps2: builderState.vertical_accel_limit_mps2,
    waypoints: builderState.waypoints.map((waypoint) => ({
      lat: waypoint.lat,
      lon: waypoint.lon,
      alt_m: waypoint.alt_m,
      target_speed_mps: waypoint.target_speed_mps,
      hold_seconds: waypoint.hold_seconds,
    })),
  };
}

async function saveScenario() {
  if (!builderState.name.trim()) {
    setSaveButtonMessage("이름 입력 필요", { resetAfterMs: 1600 });
    getElement("builder-scenario-name")?.focus();
    return;
  }

  if (builderState.waypoints.length === 0) {
    setSaveButtonMessage("웨이포인트 필요", { resetAfterMs: 1600 });
    return;
  }

  const isUpdatingCustom = builderState.selectedScenarioIsCustom && Boolean(builderState.selectedScenarioKey);
  const requestUrl = isUpdatingCustom
    ? `${API_BASE_URL}/api/custom-scenarios/${encodeURIComponent(builderState.selectedScenarioKey)}`
    : `${API_BASE_URL}/api/custom-scenarios`;
  const requestMethod = isUpdatingCustom ? "PUT" : "POST";

  setSaveButtonMessage(isUpdatingCustom ? "수정 중..." : "저장 중...", { disabled: true });

  try {
    const response = await fetch(requestUrl, {
      method: requestMethod,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildScenarioPayload()),
    });

    if (!response.ok) {
      throw new Error(`Failed to save scenario: ${response.status}`);
    }

    const savedScenario = await response.json();
    builderState = {
      ...builderState,
      selectedScenarioKey: savedScenario.key,
      selectedScenarioIsCustom: true,
    };
    await reloadBuilderScenarioSelect(savedScenario.key);
    setSaveButtonMessage(isUpdatingCustom ? "수정 완료" : "저장 완료", { resetAfterMs: 1800 });

    window.dispatchEvent(new CustomEvent("dss:custom-scenario-saved", {
      detail: {
        ...savedScenario,
        updated: isUpdatingCustom,
      },
    }));
  } catch (error) {
    setSaveButtonMessage("저장 실패", { resetAfterMs: 1800 });
    console.error(error);
  }
}

async function deleteSelectedScenario() {
  if (!builderState.selectedScenarioIsCustom || !builderState.selectedScenarioKey) {
    return;
  }

  const scenarioName = builderState.name || builderState.selectedScenarioKey;
  if (!window.confirm(`'${scenarioName}' 비행 계획을 삭제하시겠습니까?`)) {
    return;
  }

  const deleteButton = getElement("builder-scenario-delete-button");
  if (deleteButton instanceof HTMLButtonElement) {
    deleteButton.disabled = true;
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/api/custom-scenarios/${encodeURIComponent(builderState.selectedScenarioKey)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      throw new Error(`Failed to delete scenario: ${response.status}`);
    }

    const deletedScenario = await response.json();
    resetBuilderToNewScenario();
    await reloadBuilderScenarioSelect("");
    window.dispatchEvent(new CustomEvent("dss:custom-scenario-deleted", {
      detail: deletedScenario,
    }));
  } catch (error) {
    setSaveButtonMessage("삭제 실패", { resetAfterMs: 1800 });
    console.error(error);
  } finally {
    renderBuilderPanel();
  }
}

function initializeBuilderInputs() {
  const builderScenarioSelect = getElement("builder-scenario-select");
  if (builderScenarioSelect instanceof HTMLSelectElement) {
    builderScenarioSelect.addEventListener("change", () => {
      void handleBuilderScenarioSelectionChange();
    });
  }

  const scenarioNameInput = getElement("builder-scenario-name");
  if (scenarioNameInput instanceof HTMLInputElement) {
    scenarioNameInput.addEventListener("input", () => {
      builderState.name = scenarioNameInput.value;
    });
  }

  const climbSpeedInput = getElement("builder-climb-speed");
  if (climbSpeedInput instanceof HTMLInputElement) {
    climbSpeedInput.addEventListener("change", () => {
      builderState.target_climb_speed_mps = parseNumericInput(
        climbSpeedInput,
        DEFAULT_CLIMB_SPEED_MPS,
      );
      renderBuilderPanel();
    });
  }

  const descentSpeedInput = getElement("builder-descent-speed");
  if (descentSpeedInput instanceof HTMLInputElement) {
    descentSpeedInput.addEventListener("change", () => {
      builderState.target_descent_speed_mps = parseNumericInput(
        descentSpeedInput,
        DEFAULT_DESCENT_SPEED_MPS,
      );
      renderBuilderPanel();
    });
  }

  const waypointAltInput = getElement("builder-waypoint-alt");
  if (waypointAltInput instanceof HTMLInputElement) {
    waypointAltInput.addEventListener("change", () => {
      updateScenarioEditorWaypoint(builderState.selectedWaypointId, {
        alt_m: parseNumericInput(waypointAltInput, getSelectedWaypoint()?.alt_m ?? 0),
      });
    });
  }

  const waypointSpeedInput = getElement("builder-waypoint-speed");
  if (waypointSpeedInput instanceof HTMLInputElement) {
    waypointSpeedInput.addEventListener("change", () => {
      updateScenarioEditorWaypoint(builderState.selectedWaypointId, {
        target_speed_mps: parseNumericInput(
          waypointSpeedInput,
          getSelectedWaypoint()?.target_speed_mps ?? DEFAULT_CLIMB_SPEED_MPS,
        ),
      });
    });
  }

  const waypointHoldInput = getElement("builder-waypoint-hold");
  if (waypointHoldInput instanceof HTMLInputElement) {
    waypointHoldInput.addEventListener("change", () => {
      updateScenarioEditorWaypoint(builderState.selectedWaypointId, {
        hold_seconds: parseNumericInput(
          waypointHoldInput,
          getSelectedWaypoint()?.hold_seconds ?? 0,
        ),
      });
    });
  }
}

function initializeBuilderButtons() {
  initializeNavigationMenu();

  document.querySelectorAll("[data-app-mode-switch]").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveAppMode(button.dataset.appModeSwitch ?? DEFAULT_APP_MODE);
    });
  });

  document.querySelectorAll("[data-panel-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveBuilderTab(button.dataset.panelTab ?? "simulation");
    });
  });

  getElement("builder-set-home-button")?.addEventListener("click", () => {
    setScenarioEditorMode(builderState.mode === "home" ? null : "home");
  });

  getElement("builder-reset-home-button")?.addEventListener("click", () => {
    updateScenarioEditorHome(getDefaultScenarioEditorDraft().home);
    setScenarioEditorMode(null);
  });

  getElement("builder-add-waypoint-button")?.addEventListener("click", () => {
    setScenarioEditorMode(builderState.mode === "waypoint" ? null : "waypoint");
  });

  getElement("builder-delete-waypoint-button")?.addEventListener("click", () => {
    removeScenarioEditorWaypoint(builderState.selectedWaypointId);
  });

  getElement("builder-clear-waypoints-button")?.addEventListener("click", () => {
    clearScenarioEditorWaypoints();
  });

  getElement("builder-save-button")?.addEventListener("click", () => {
    void saveScenario();
  });

  getElement("builder-scenario-delete-button")?.addEventListener("click", () => {
    void deleteSelectedScenario();
  });
}

export function initializeScenarioBuilder() {
  setScenarioEditorDraft({
    home: builderState.home,
    waypoints: builderState.waypoints,
    selectedWaypointId: builderState.selectedWaypointId,
  });
  focusScenarioEditorDraft();
  setScenarioEditorEnabled(false);
  setSaveButtonMessage(getDefaultSaveButtonLabel());
  initializeBuilderInputs();
  initializeBuilderButtons();
  window.addEventListener("dss:scenario-editor-change", handleScenarioEditorChange);
  renderBuilderPanel();
  renderAppModeLayout();
  setActiveBuilderTab("simulation", { syncAppMode: false });
  window.dispatchEvent(new CustomEvent("dss:app-mode-change", {
    detail: {
      appMode: builderState.appMode,
      activeTab: builderState.activeTab,
    },
  }));
  void reloadBuilderScenarioSelect("");
}
