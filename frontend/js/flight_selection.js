export const DRONE_SLOT_CONFIGS = [
  {
    droneSelectId: "drone-1-select",
    scenarioSelectId: "scenario-1-select",
    streamLabel: "기체 1",
  },
  {
    droneSelectId: "drone-2-select",
    scenarioSelectId: "scenario-2-select",
    streamLabel: "기체 2",
  },
  {
    droneSelectId: "drone-3-select",
    scenarioSelectId: "scenario-3-select",
    streamLabel: "기체 3",
  },
];
export const DRONE_SELECT_IDS = DRONE_SLOT_CONFIGS.map((slotConfig) => slotConfig.droneSelectId);
export const SCENARIO_SELECT_IDS = DRONE_SLOT_CONFIGS.map((slotConfig) => slotConfig.scenarioSelectId);
export const LIVE_STREAM_ID = "live-vehicle";
export const LIVE_STREAM_LABEL = "연결된 기체";

const DEFAULT_EMPTY_LABEL = "선택 안함";
const DEFAULT_DRONE_VISUAL = {
  strokeColor: "#00e5ff",
  fillColor: "#00e5ff",
};
const SLOT_STREAM_VISUALS = [
  {
    strokeColor: "#00e5ff",
    fillColor: "#00e5ff",
  },
  {
    strokeColor: "#ffbe0b",
    fillColor: "#ffbe0b",
  },
  {
    strokeColor: "#ff5ea8",
    fillColor: "#ff5ea8",
  },
];

let droneSpecMap = new Map();
let scenarioDefinitionMap = new Map();


function createOption(value, label, selected = false) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  option.selected = selected;
  return option;
}


function getDroneOptionLabel(spec) {
  return spec.is_custom ? `${spec.name} (사용자)` : spec.name;
}


function getDroneDisplayName(droneKey) {
  return droneSpecMap.get(droneKey)?.name ?? droneKey ?? DEFAULT_EMPTY_LABEL;
}


function getSlotStreamVisual(slotOrder) {
  return SLOT_STREAM_VISUALS[Math.max(0, slotOrder)] ?? DEFAULT_DRONE_VISUAL;
}


export function setDroneSpecs(droneSpecs) {
  droneSpecMap = new Map(droneSpecs.map((spec) => [spec.key, spec]));
}


export function updateScenarioDefinitionMap(scenarios) {
  scenarioDefinitionMap = new Map(
    scenarios.map((scenario) => [scenario.key, scenario]),
  );
}


export function getScenarioDisplayName(scenarioKey) {
  return scenarioDefinitionMap.get(scenarioKey)?.name ?? scenarioKey ?? "";
}


export function isCustomScenarioKey(scenarioKey) {
  return typeof scenarioKey === "string" && scenarioKey.startsWith("custom_");
}


export function getFormationSpeedCaps(streamConfigs) {
  const selectedSpecs = streamConfigs
    .map((streamConfig) => droneSpecMap.get(streamConfig.droneKey) ?? null)
    .filter(Boolean);

  if (selectedSpecs.length === 0) {
    return {
      horizontalCapMps: null,
      ascentCapMps: null,
      descentCapMps: null,
    };
  }

  return {
    horizontalCapMps: Math.min(...selectedSpecs.map((spec) => spec.max_horizontal_speed_mps)),
    ascentCapMps: Math.min(...selectedSpecs.map((spec) => spec.max_ascent_speed_mps)),
    descentCapMps: Math.min(...selectedSpecs.map((spec) => spec.max_descent_speed_mps)),
  };
}


export function buildTelemetryStreamConfigs({ includeEmptySlots = false } = {}) {
  let activeStreamIndex = 0;
  const streamConfigs = [];

  DRONE_SLOT_CONFIGS.forEach((slotConfig, slotOrder) => {
    const droneSelectElement = document.getElementById(slotConfig.droneSelectId);
    const scenarioSelectElement = document.getElementById(slotConfig.scenarioSelectId);
    if (!(droneSelectElement instanceof HTMLSelectElement)) {
      return;
    }

    const droneKey = droneSelectElement.value;
    const scenarioKey = scenarioSelectElement instanceof HTMLSelectElement
      ? scenarioSelectElement.value
      : "";
    const enabled = Boolean(droneKey);
    if (!enabled && !includeEmptySlots) {
      return;
    }

    let visual = DEFAULT_DRONE_VISUAL;
    let slotIndex = -1;
    let isPrimary = false;

    if (enabled) {
      visual = getSlotStreamVisual(slotOrder);
      isPrimary = activeStreamIndex === 0;
      activeStreamIndex += 1;
    } else {
      visual = {
        strokeColor: "#3f4531",
        fillColor: "#3f4531",
      };
    }

    streamConfigs.push({
      streamId: slotConfig.droneSelectId,
      streamLabel: slotConfig.streamLabel,
      droneKey,
      scenarioKey,
      scenarioName: getScenarioDisplayName(scenarioKey),
      displayName: enabled ? getDroneDisplayName(droneKey) : "연결 안 됨",
      slotIndex,
      isPrimary,
      enabled,
      visual,
      maxHorizontalSpeedMps: droneSpecMap.get(droneKey)?.max_horizontal_speed_mps ?? null,
      maxFlightTimeMin: droneSpecMap.get(droneKey)?.max_flight_time_min ?? null,
    });
  });

  const scenarioGroupCounts = new Map();
  streamConfigs
    .filter((streamConfig) => streamConfig.enabled)
    .forEach((streamConfig) => {
      const nextCount = (scenarioGroupCounts.get(streamConfig.scenarioKey) ?? 0) + 1;
      scenarioGroupCounts.set(streamConfig.scenarioKey, nextCount);
    });

  const nextScenarioSlotIndexes = new Map();
  streamConfigs.forEach((streamConfig) => {
    if (!streamConfig.enabled) {
      return;
    }

    const nextScenarioSlotIndex = nextScenarioSlotIndexes.get(streamConfig.scenarioKey) ?? 0;
    streamConfig.slotIndex = nextScenarioSlotIndex;
    streamConfig.formationGroupSize = scenarioGroupCounts.get(streamConfig.scenarioKey) ?? 1;
    nextScenarioSlotIndexes.set(streamConfig.scenarioKey, nextScenarioSlotIndex + 1);
  });

  return streamConfigs;
}


export function getActiveStreamConfigs() {
  return buildTelemetryStreamConfigs().filter((streamConfig) => streamConfig.enabled);
}


export function getPrimaryStreamConfig(streamConfigs = getActiveStreamConfigs()) {
  return streamConfigs.find((streamConfig) => streamConfig.isPrimary) ?? streamConfigs[0] ?? null;
}


export function getSelectedDroneKeys(streamConfigs = getActiveStreamConfigs()) {
  return streamConfigs
    .map((streamConfig) => streamConfig.droneKey)
    .filter(Boolean);
}


export function getSelectedScenarioKeys(streamConfigs = getActiveStreamConfigs()) {
  return Array.from(new Set(
    streamConfigs
      .map((streamConfig) => streamConfig.scenarioKey)
      .filter(Boolean),
  ));
}


export function getScenarioSummaryLabel(streamConfigs = getActiveStreamConfigs()) {
  const selectedScenarioKeys = getSelectedScenarioKeys(streamConfigs);
  if (selectedScenarioKeys.length === 0) {
    return "데모";
  }
  if (selectedScenarioKeys.length === 1) {
    return getScenarioDisplayName(selectedScenarioKeys[0]);
  }
  return "개별 비행 계획";
}


export function getLiveStreamConfig({ enabled = false } = {}) {
  const liveScenarioSelect = document.getElementById("live-scenario-select");
  const scenarioKey = liveScenarioSelect instanceof HTMLSelectElement
    ? liveScenarioSelect.value
    : "";
  return {
    streamId: LIVE_STREAM_ID,
    streamLabel: LIVE_STREAM_LABEL,
    droneKey: "inspire_3",
    scenarioKey,
    scenarioName: getScenarioDisplayName(scenarioKey),
    displayName: "Pixhawk",
    slotIndex: 0,
    isPrimary: true,
    enabled,
    visual: DEFAULT_DRONE_VISUAL,
    maxHorizontalSpeedMps: droneSpecMap.get("inspire_3")?.max_horizontal_speed_mps ?? null,
    maxFlightTimeMin: droneSpecMap.get("inspire_3")?.max_flight_time_min ?? null,
  };
}


export function isLiveStreamId(streamId) {
  return streamId === LIVE_STREAM_ID;
}


export function buildTelemetryStreamConfigsWithLive({
  includeEmptySlots = false,
  enableLive = false,
} = {}) {
  return [
    ...buildTelemetryStreamConfigs({ includeEmptySlots }),
    getLiveStreamConfig({ enabled: enableLive }),
  ];
}


export function getDownloadScenarioKey(streamConfigs = getActiveStreamConfigs()) {
  const selectedScenarioKeys = getSelectedScenarioKeys(streamConfigs);
  return selectedScenarioKeys.length === 1 ? selectedScenarioKeys[0] : "mixed";
}


export function getPrimaryDroneSelection(streamConfigs = getActiveStreamConfigs()) {
  return getPrimaryStreamConfig(streamConfigs)?.droneKey ?? "";
}


export function populateDroneSelect(selectElement, droneSpecs, includeEmptyOption) {
  const previousValue = selectElement.value;
  selectElement.innerHTML = "";

  if (includeEmptyOption) {
    selectElement.appendChild(createOption("", DEFAULT_EMPTY_LABEL, previousValue === ""));
  }

  droneSpecs.forEach((spec, index) => {
    const shouldSelect =
      previousValue === spec.key || (!previousValue && !includeEmptyOption && index === 0);
    selectElement.appendChild(createOption(spec.key, getDroneOptionLabel(spec), shouldSelect));
  });
}


export function populateScenarioSelect(selectElement, scenarios, selectedValue = "") {
  const previousValue = selectedValue || selectElement.value;
  selectElement.innerHTML = "";

  scenarios.forEach((scenario, index) => {
    const shouldSelect = previousValue === scenario.key || (!previousValue && index === 0);
    selectElement.appendChild(createOption(scenario.key, scenario.name, shouldSelect));
  });
}
