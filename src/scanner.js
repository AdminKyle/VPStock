import { CONFIG } from "./config.js";
import { mark, measure } from "./debug.js";

let html5QrCode;
let libraryPromise;
let lastDetectedAt = 0;

const SCAN_COOLDOWN_MS = 1400;
const SCANNER_CONFIG = {
  fps: 10,
  qrbox: { width: 250, height: 250 },
  aspectRatio: 1.333,
  disableFlip: true
};

export function preloadScannerLibrary() {
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
    throw new Error("Camera scanning requires Chrome over HTTPS.");
  }

  const Html5Qrcode = await preloadScannerLibrary();
  stopScanner();
  clearScannerContainer(containerElement);

  html5QrCode = new Html5Qrcode(containerElement.id, { verbose: false });
  onStatus?.("Starting camera...");
  mark("camera:start");

  try {
    await html5QrCode.start(
      { facingMode: "environment" },
      SCANNER_CONFIG,
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
  } catch (error) {
    stopScanner();
    throw friendlyCameraError(error);
  }

  onStatus?.("Point the camera at a barcode.");
  measure("camera:ready", "camera:start");
}

export function stopScanner() {
  const activeScanner = html5QrCode;
  html5QrCode = null;
  if (activeScanner?.isScanning) {
    activeScanner.stop().then(() => activeScanner.clear()).catch(() => {});
  } else {
    activeScanner?.clear?.();
  }
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
}

function friendlyCameraError(error) {
  const text = String(error?.message || error || "");
  if (/notallowed|permission|denied/i.test(text)) {
    return new Error("Camera permission was blocked. In Chrome, allow camera access for this installed app/site and try again.");
  }
  if (/notfound|no camera|requested device not found/i.test(text)) {
    return new Error("No camera was found on this device.");
  }
  if (/notreadable|trackstart|in use/i.test(text)) {
    return new Error("The camera is already in use by another app. Close other camera apps and try again.");
  }
  return new Error(text || "Camera unavailable.");
}
