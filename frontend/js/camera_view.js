let cameraViewInitialized = false;
let isCameraPrimary = false;
let hasCameraFeed = false;
let vehicleConnected = false;
let cameraFeatureEnabled = false;
let mapStageLayoutFrameId = 0;
let mediaLayoutSettlingTimerId = 0;

const MEDIA_LAYOUT_SETTLE_DURATION_MS = 180;


function getMapViewportElement() {
  const element = document.getElementById("map-viewport");
  return element instanceof HTMLElement ? element : null;
}


function getMapStageElement() {
  const element = document.getElementById("map-stage");
  return element instanceof HTMLElement ? element : null;
}


function getCameraStageElement() {
  const element = document.getElementById("camera-stage");
  return element instanceof HTMLElement ? element : null;
}

function getSwapButtonElement() {
  const element = document.getElementById("media-swap-button");
  return element instanceof HTMLButtonElement ? element : null;
}


function getCameraFeedElement() {
  const element = document.getElementById("camera-feed");
  return element instanceof HTMLVideoElement ? element : null;
}


function setTextContent(elementId, value) {
  const element = document.getElementById(elementId);
  if (element) {
    element.textContent = value;
  }
}


function updateCameraPlaceholder() {
  setTextContent(
    "camera-empty-text",
    vehicleConnected ? "카메라 연결 안 됨" : "기체 연결 안 됨",
  );
}


function notifyMediaLayoutSettling(active) {
  window.dispatchEvent(
    new CustomEvent("dss:media-layout-settling", {
      detail: {
        active,
        camera_primary: isCameraPrimary,
      },
    }),
  );
}


function dispatchMapLayoutChange() {
  window.dispatchEvent(new CustomEvent("dss:map-layout-change"));
}


function scheduleMapStageLayoutSync() {
  if (mapStageLayoutFrameId !== 0) {
    window.cancelAnimationFrame(mapStageLayoutFrameId);
  }

  mapStageLayoutFrameId = window.requestAnimationFrame(() => {
    mapStageLayoutFrameId = 0;
    dispatchMapLayoutChange();
  });
}


function renderCameraLayout() {
  const mapViewport = getMapViewportElement();
  const mapStage = getMapStageElement();
  const cameraStage = getCameraStageElement();
  if (!(mapViewport && mapStage && cameraStage)) {
    return;
  }

  mapViewport.classList.toggle("is-camera-primary", isCameraPrimary);
  mapViewport.classList.toggle("is-map-primary", !isCameraPrimary);
  mapStage.setAttribute("aria-label", isCameraPrimary ? "맵 화면" : "맵 화면");
  cameraStage.classList.toggle("has-feed", hasCameraFeed);
  cameraStage.setAttribute("aria-label", isCameraPrimary ? "카메라 화면" : "카메라 화면");
  setTextContent("media-swap-button-label", isCameraPrimary ? "맵 확대" : "카메라 확대");
  const swapButton = getSwapButtonElement();
  if (swapButton) {
    swapButton.setAttribute("aria-label", isCameraPrimary ? "맵 확대" : "카메라 확대");
  }
  updateCameraPlaceholder();
  scheduleMapStageLayoutSync();
}


function setCameraFeatureEnabled(enabled) {
  const nextEnabled = Boolean(enabled);
  if (cameraFeatureEnabled === nextEnabled) {
    renderCameraLayout();
    return;
  }

  cameraFeatureEnabled = nextEnabled;
  if (!cameraFeatureEnabled && isCameraPrimary) {
    setCameraPrimary(false);
    return;
  }

  renderCameraLayout();
}


function setCameraPrimary(nextPrimary) {
  if (isCameraPrimary === nextPrimary) {
    return;
  }

  if (mediaLayoutSettlingTimerId !== 0) {
    window.clearTimeout(mediaLayoutSettlingTimerId);
    mediaLayoutSettlingTimerId = 0;
  }

  notifyMediaLayoutSettling(true);
  isCameraPrimary = nextPrimary;
  renderCameraLayout();
  mediaLayoutSettlingTimerId = window.setTimeout(() => {
    mediaLayoutSettlingTimerId = 0;
    notifyMediaLayoutSettling(false);
  }, MEDIA_LAYOUT_SETTLE_DURATION_MS);
}


function attachVideoSource({ mediaStream = null, objectUrl = "" } = {}) {
  const cameraFeedElement = getCameraFeedElement();
  if (!cameraFeedElement) {
    return;
  }

  cameraFeedElement.pause();
  cameraFeedElement.removeAttribute("src");
  cameraFeedElement.srcObject = null;

  if (mediaStream instanceof MediaStream) {
    cameraFeedElement.srcObject = mediaStream;
    void cameraFeedElement.play().catch(() => {});
    hasCameraFeed = true;
    renderCameraLayout();
    return;
  }

  if (typeof objectUrl === "string" && objectUrl.trim()) {
    cameraFeedElement.src = objectUrl.trim();
    void cameraFeedElement.play().catch(() => {});
    hasCameraFeed = true;
    renderCameraLayout();
    return;
  }

  hasCameraFeed = false;
  renderCameraLayout();
}


export function initializeCameraView() {
  if (cameraViewInitialized) {
    renderCameraLayout();
    return;
  }

  cameraViewInitialized = true;
  renderCameraLayout();

  const swapButton = getSwapButtonElement();
  if (swapButton) {
    swapButton.addEventListener("click", () => {
      setCameraPrimary(!isCameraPrimary);
    });
  }

  window.addEventListener("dss:live-status", (event) => {
    vehicleConnected = Boolean(event.detail?.heartbeat_seen);
    updateCameraPlaceholder();
  });

  window.addEventListener("dss:live-status-reset", () => {
    vehicleConnected = false;
    updateCameraPlaceholder();
  });

  window.addEventListener("dss:camera-feed-change", (event) => {
    attachVideoSource(event.detail ?? {});
  });
  window.addEventListener("dss:app-mode-change", (event) => {
    setCameraFeatureEnabled(event.detail?.appMode === "ground-control");
  });
  setCameraFeatureEnabled(document.body?.dataset.appMode === "ground-control");
  updateCameraPlaceholder();
}


export function setCameraFeedUnavailable() {
  attachVideoSource();
}
