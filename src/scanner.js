import { CONFIG } from "./config.js";
import { mark, measure } from "./debug.js";

let html5QrCode;
let libraryPromise;
let stream;
let video;
let detector;
let scanLoop = 0;
let lastDetectedAt = 0;
let isPaused = false;

const SCAN_COOLDOWN_MS = 1400;
const DETECT_INTERVAL_MS = 180;
const REFOCUS_SETTLE_MS = 450;
const BARCODE_FORMATS = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "code_93",
  "itf",
  "codabar",
  "qr_code"
];

const PREFERRED_VIDEO_CONSTRAINTS = {
  facingMode: "environment",
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30 }
};

const CAMERA_ATTEMPTS = [
  { video: { ...PREFERRED_VIDEO_CONSTRAINTS, facingMode: { exact: "environment" } }, audio: false },
  { video: PREFERRED_VIDEO_CONSTRAINTS, audio: false },
  { video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
  { video: { facingMode: "environment" }, audio: false },
  { video: true, audio: false }
];

const HTML5_QRCODE_CONFIG = {
  fps: 12,
  qrbox: barcodeScanRegion,
  aspectRatio: 1.333,
  disableFlip: true,
  videoConstraints: PREFERRED_VIDEO_CONSTRAINTS
};

export function preloadScannerLibrary() {
  if (window.BarcodeDetector) return Promise.resolve(window.BarcodeDetector);
  if (!libraryPromise) {
    mark("scanner-library:start");
    libraryPromise = loadHtml5QrCode().then(() => {
      measure("scanner-library:loaded", "scanner-library:start");
      return window.Html5Qrcode;
    });
  }
  return libraryPromise;
}

export async function startScanner(containerElement, onScan, onStatus) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera scanning requires a modern browser over HTTPS.");
  }

  stopScanner();
  clearScannerContainer(containerElement);
  isPaused = false;
  onStatus?.("Starting camera...");
  mark("camera:start");

  if (window.BarcodeDetector) {
    await startNativeScanner(containerElement, onScan, onStatus);
  } else {
    await startHtml5Scanner(containerElement, onScan, onStatus);
  }

  onStatus?.("Point the camera at a barcode.");
  measure("camera:ready", "camera:start");
}

export function stopScanner() {
  isPaused = false;
  if (scanLoop) {
    window.clearTimeout(scanLoop);
    scanLoop = 0;
  }

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  if (video) {
    video.pause();
    video.srcObject = null;
    video.remove();
    video = null;
  }

  const activeScanner = html5QrCode;
  html5QrCode = null;
  if (activeScanner?.isScanning) {
    activeScanner.stop().then(() => activeScanner.clear()).catch(() => {});
  } else {
    activeScanner?.clear?.();
  }
}

export function pauseScanner() {
  isPaused = true;
  if (scanLoop) {
    window.clearTimeout(scanLoop);
    scanLoop = 0;
  }
  if (video) video.pause();
  if (html5QrCode?.isScanning && typeof html5QrCode.pause === "function") {
    try {
      html5QrCode.pause(true);
    } catch {}
  }
}

export function resumeScanner(onScan, onStatus) {
  isPaused = false;
  if (video && detector) {
    video.play().catch(() => {});
    if (!scanLoop) runNativeDetection(onScan, onStatus);
  }
  if (html5QrCode && typeof html5QrCode.resume === "function") {
    try {
      html5QrCode.resume();
    } catch {}
  }
}

export async function refocusScanner() {
  const controller = activeCameraController();
  if (!controller) return false;

  const focusModes = capabilityValues(controller.capabilities.focusMode);
  try {
    if (focusModes.includes("single-shot")) {
      await controller.apply({ advanced: [{ focusMode: "single-shot" }] });
      if (focusModes.includes("continuous")) {
        await wait(REFOCUS_SETTLE_MS);
        await controller.apply({ advanced: [{ focusMode: "continuous" }] });
      }
      return true;
    }

    if (focusModes.includes("continuous")) {
      await controller.apply({ advanced: [{ focusMode: "continuous" }] });
      return true;
    }
  } catch {
    // Let the caller restart the stream when a reported focus mode fails.
  }

  return false;
}

async function startNativeScanner(containerElement, onScan, onStatus) {
  try {
    stream = await openCamera();
  } catch (error) {
    throw friendlyCameraError(error, "camera-open");
  }

  video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  video.muted = true;
  video.autoplay = true;
  video.srcObject = stream;
  containerElement.append(video);

  try {
    await video.play();
  } catch (error) {
    throw friendlyCameraError(error, "video-play");
  }

  await optimiseActiveCamera();
  detector = await createBarcodeDetector();
  onStatus?.("Camera active. Looking for barcode...");
  runNativeDetection(onScan, onStatus);
}

async function openCamera() {
  let lastError;
  for (const constraints of CAMERA_ATTEMPTS) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No camera stream returned.");
}

async function createBarcodeDetector() {
  const supported = typeof window.BarcodeDetector.getSupportedFormats === "function"
    ? await window.BarcodeDetector.getSupportedFormats().catch(() => [])
    : [];
  const formats = Array.isArray(supported) && supported.length
    ? BARCODE_FORMATS.filter((format) => supported.includes(format))
    : [];
  return formats.length ? new window.BarcodeDetector({ formats }) : new window.BarcodeDetector();
}

function runNativeDetection(onScan, onStatus) {
  scanLoop = window.setTimeout(async () => {
    try {
      if (isPaused) {
        scanLoop = 0;
        return;
      }
      if (!video || !detector) return;
      const codes = await detector.detect(video);
      const firstCode = codes && codes[0];
      if (firstCode?.rawValue) {
        const now = Date.now();
        if (now - lastDetectedAt >= SCAN_COOLDOWN_MS) {
          lastDetectedAt = now;
          mark("scan:detected");
          if (navigator.vibrate) navigator.vibrate(80);
          onScan(firstCode.rawValue);
        }
      }
    } catch (error) {
      onStatus?.(`Camera active. Scanner warming up... ${error?.name || ""}`.trim());
    }
    runNativeDetection(onScan, onStatus);
  }, DETECT_INTERVAL_MS);
}

async function startHtml5Scanner(containerElement, onScan, onStatus) {
  const Html5Qrcode = await preloadScannerLibrary().catch((error) => {
    throw friendlyCameraError(error, "library-load");
  });

  html5QrCode = new Html5Qrcode(containerElement.id, { verbose: false });
  try {
    await html5QrCode.start(
      { facingMode: "environment" },
      HTML5_QRCODE_CONFIG,
      (decodedText) => {
        const now = Date.now();
        if (now - lastDetectedAt < SCAN_COOLDOWN_MS) return;
        lastDetectedAt = now;
        mark("scan:detected");
        if (navigator.vibrate) navigator.vibrate(80);
        onScan(decodedText);
      },
      () => {}
    );
    await optimiseActiveCamera();
  } catch (error) {
    stopScanner();
    throw friendlyCameraError(error, "html5-start");
  }
}

function barcodeScanRegion(viewfinderWidth, viewfinderHeight) {
  const width = Math.max(50, Math.floor(Math.min(viewfinderWidth * 0.88, 640)));
  const height = Math.max(50, Math.floor(Math.min(viewfinderHeight * 0.38, width / 1.8)));
  return { width, height };
}

async function optimiseActiveCamera() {
  const controller = activeCameraController();
  if (!controller) return;

  const focusModes = capabilityValues(controller.capabilities.focusMode);
  if (!focusModes.includes("continuous")) return;

  try {
    await controller.apply({ advanced: [{ focusMode: "continuous" }] });
  } catch {
    // Camera controls are best-effort and must never prevent scanning.
  }
}

function activeCameraController() {
  const track = stream?.getVideoTracks?.()[0];
  if (track?.applyConstraints) {
    return {
      capabilities: safeCapabilities(() => track.getCapabilities?.()),
      apply: (constraints) => track.applyConstraints(constraints)
    };
  }

  if (html5QrCode?.isScanning && typeof html5QrCode.applyVideoConstraints === "function") {
    return {
      capabilities: safeCapabilities(() => html5QrCode.getRunningTrackCapabilities?.()),
      apply: (constraints) => html5QrCode.applyVideoConstraints(constraints)
    };
  }

  return null;
}

function safeCapabilities(readCapabilities) {
  try {
    return readCapabilities() || {};
  } catch {
    return {};
  }
}

function capabilityValues(capability) {
  if (Array.isArray(capability)) return capability;
  return capability == null ? [] : [capability];
}

function wait(delay) {
  return new Promise((resolve) => window.setTimeout(resolve, delay));
}

function loadHtml5QrCode() {
  if (window.Html5Qrcode) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${CONFIG.HTML5_QRCODE_CDN}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Scanner library failed to load.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = CONFIG.HTML5_QRCODE_CDN;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Scanner library failed to load."));
    document.head.append(script);
  });
}

function clearScannerContainer(containerElement) {
  containerElement.innerHTML = "";
  lastDetectedAt = 0;
  isPaused = false;
}

function friendlyCameraError(error, step) {
  const name = error?.name || "";
  const message = String(error?.message || error || "").trim();
  const detail = [step, name, message].filter(Boolean).join(": ");

  if (/notallowed|permission|denied/i.test(`${name} ${message}`)) {
    return new Error(`Camera permission is blocked. Allow camera for this installed app/site in browser settings. ${detail}`);
  }
  if (/notfound|no camera|requested device not found/i.test(`${name} ${message}`)) {
    return new Error(`No camera was found on this device. ${detail}`);
  }
  if (/notreadable|trackstart|in use/i.test(`${name} ${message}`)) {
    return new Error(`Camera is already in use by another app. Close other camera apps and retry. ${detail}`);
  }
  if (/overconstrained|constraint/i.test(`${name} ${message}`)) {
    return new Error(`The browser rejected the camera setting. Retrying with fallback failed. ${detail}`);
  }
  return new Error(detail || "Camera unavailable. The browser did not provide an error reason.");
}
