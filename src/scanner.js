import { CONFIG } from "./config.js";
import { mark, measure } from "./debug.js";

let codeReader;
let controls;
let libraryPromise;

const CAMERA_CONSTRAINTS = [
  {
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  },
  {
    video: {
      facingMode: "environment"
    },
    audio: false
  },
  {
    video: true,
    audio: false
  }
];

export function preloadScannerLibrary() {
  if (!libraryPromise) {
    mark("scanner-library:start");
    libraryPromise = import(CONFIG.ZXING_CDN).then((module) => {
      measure("scanner-library:loaded", "scanner-library:start");
      return module;
    });
  }
  return libraryPromise;
}

export async function startScanner(videoElement, onScan, onStatus) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera scanning requires a modern browser over HTTPS.");
  }

  if (!codeReader) {
    const { BrowserMultiFormatReader } = await preloadScannerLibrary();
    codeReader = new BrowserMultiFormatReader();
  }

  stopScanner();
  onStatus?.("Starting camera...");
  mark("camera:start");

  controls = await startWithFallbackConstraints(videoElement, onScan, onStatus);

  onStatus?.("Point the camera at a barcode.");
  measure("camera:ready", "camera:start");
}

export function stopScanner() {
  if (controls) {
    controls.stop();
    controls = null;
  }
}

async function startWithFallbackConstraints(videoElement, onScan, onStatus) {
  let lastError;
  for (const constraints of CAMERA_CONSTRAINTS) {
    try {
      return await codeReader.decodeFromConstraints(
        constraints,
        videoElement,
        (result, error) => {
          if (result) {
            mark("scan:detected");
            onScan(result.getText());
          } else if (error?.name && error.name !== "NotFoundException") {
            onStatus?.("Camera is searching...");
          }
        }
      );
    } catch (error) {
      lastError = error;
      stopScanner();
    }
  }
  throw friendlyCameraError(lastError);
}

function friendlyCameraError(error) {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return new Error("Camera permission was blocked. Allow camera access in your browser settings, then try again.");
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return new Error("No camera was found on this device.");
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return new Error("The camera is already in use by another app. Close other camera apps and try again.");
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return new Error("This device rejected the camera settings. Refresh the page and try again.");
  }
  return new Error(error?.message || "Camera unavailable.");
}
