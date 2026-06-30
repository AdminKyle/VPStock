import { CONFIG } from "./config.js";
import { mark, measure } from "./debug.js";

let codeReader;
let controls;
let libraryPromise;

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

  controls = await codeReader.decodeFromConstraints(
    {
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 960 },
        height: { ideal: 540 },
        focusMode: { ideal: "continuous" }
      },
      audio: false
    },
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

  onStatus?.("Point the camera at a barcode.");
  measure("camera:ready", "camera:start");
}

export function stopScanner() {
  if (controls) {
    controls.stop();
    controls = null;
  }
}
