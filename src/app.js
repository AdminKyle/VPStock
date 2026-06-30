import { CONFIG } from "./config.js";
import { mark, measure } from "./debug.js";
import { login, searchProducts, submitScan, updateProductRow, validateSession } from "./api.js";
import { clearSession, isExpired, loadSession, saveSession } from "./auth.js";
import { loadPendingScans, queueScan, removePendingScan } from "./queue.js";
import { preloadScannerLibrary, startScanner, stopScanner } from "./scanner.js";
import {
  els,
  clearFlavourResults,
  renderFlavourResults,
  renderFlavourMessage,
  selectedTarget,
  setCameraRunning,
  setLoginLoading,
  setQueueCount,
  setLoginMessage,
  setStatus,
  showLogin,
  showScanner,
  updateRecent
} from "./ui.js";

let session = null;
let lastScan = { barcode: "", at: 0 };
let isSubmitting = false;
let searchTimer = 0;

function cleanBarcode(value) {
  return String(value || "").trim().replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function targetLabel(target) {
  return target === "shelf" ? "Shelf stock" : "Backstock";
}

function isDuplicate(barcode) {
  const now = Date.now();
  const duplicate = lastScan.barcode === barcode && now - lastScan.at < CONFIG.DUPLICATE_WINDOW_MS;
  lastScan = { barcode, at: now };
  return duplicate;
}

function validateBarcode(barcode) {
  if (!barcode) return "Scan a barcode first.";
  if (barcode.length < CONFIG.MIN_BARCODE_LENGTH) return "Barcode is too short.";
  if (barcode.length > CONFIG.MAX_BARCODE_LENGTH) return "Barcode is too long.";
  if (!/^[A-Za-z0-9._-]+$/.test(barcode)) return "Barcode contains unsupported characters.";
  return "";
}

function refreshQueueCount() {
  setQueueCount(loadPendingScans().length);
}

async function restoreSession() {
  mark("app:restore-session:start");
  const stored = loadSession();
  if (!stored || isExpired(stored)) {
    clearSession();
    showLogin();
    return;
  }

  session = stored;
  showScanner(session);
  setStatus("Ready to scan. Checking saved session in the background...", "success");
  preloadScannerLibrary().catch(() => {});
  measure("app:scanner-visible", "app:restore-session:start");

  const lastValidated = Number(stored.lastValidatedAt || 0);
  if (Date.now() - lastValidated < CONFIG.SESSION_REVALIDATE_MS) return;

  validateSession(stored)
    .then((validated) => {
      session = saveSession({ ...stored, ...validated.session, lastValidatedAt: Date.now() });
      showScanner(session);
      setStatus("Ready to scan.", "success");
    })
    .catch((error) => {
      clearSession();
      session = null;
      stopScanner();
      showLogin(error.message || "Please log in again.");
    });
}

async function handleLogin(event) {
  event.preventDefault();
  const username = els.usernameInput.value.trim();
  const pin = els.pinInput.value;

  if (!username) {
    setLoginMessage("Enter your staff name.", "error");
    return;
  }

  setLoginLoading(true);
  setLoginMessage("Checking credentials...");
  mark("login:start");
  try {
    const result = await login(username, pin);
    session = saveSession({ ...result.session, lastValidatedAt: Date.now() });
    els.pinInput.value = "";
    showScanner(session);
    setStatus("Ready to scan.", "success");
    preloadScannerLibrary().catch(() => {});
    measure("login:complete", "login:start");
  } catch (error) {
    setLoginMessage(error.message, "error");
  } finally {
    setLoginLoading(false);
  }
}

async function handleSubmit(barcodeFromScanner = "") {
  const barcode = cleanBarcode(barcodeFromScanner);
  const target = selectedTarget();
  const quantity = Math.max(1, Number.parseInt(els.quantityInput.value || "1", 10));

  if (isSubmitting) return;

  if (!session) {
    showLogin("Please log in before scanning.");
    return;
  }

  const barcodeError = validateBarcode(barcode);
  if (barcodeError) {
    setStatus(barcodeError, "error");
    return;
  }

  if (isDuplicate(barcode)) {
    updateRecent({ barcode, target });
    setStatus("Duplicate scan ignored. Wait a moment before scanning it again.", "warning");
    return;
  }

  if (!navigator.onLine) {
    const queued = queueScan({ barcode, target, quantity, username: session.username });
    updateRecent({ barcode, target });
    refreshQueueCount();
    setStatus(`Offline. Scan queued for manual retry (${queued.barcode}).`, "warning");
    return;
  }

  updateRecent({ barcode, target });
  isSubmitting = true;
  setStatus(`Submitting ${barcode} to ${targetLabel(target)}...`);
  mark("scan-submit:start");

  try {
    const result = await submitScan({ session, barcode, target, quantity });
    setStatus(result.message || `${targetLabel(target)} updated.`, "success");
    measure("scan-submit:confirmed", "scan-submit:start");
  } catch (error) {
    if (!navigator.onLine || /timed out|failed/i.test(error.message)) {
      queueScan({ barcode, target, quantity, username: session.username });
      refreshQueueCount();
      setStatus(`${error.message} Scan queued for manual retry.`, "warning");
    } else {
      setStatus(error.message, "error");
    }
  } finally {
    isSubmitting = false;
  }
}

async function retryPendingScans() {
  if (!session) {
    showLogin("Please log in before retrying scans.");
    return;
  }
  if (!navigator.onLine) {
    setStatus("Still offline. Retry when the connection is back.", "warning");
    return;
  }

  const pending = loadPendingScans().slice().reverse();
  if (!pending.length) return;

  els.retryQueueButton.disabled = true;
  setStatus(`Retrying ${pending.length} pending scan(s)...`);
  for (const scan of pending) {
    try {
      await submitScan({ session, barcode: scan.barcode, target: scan.target, quantity: scan.quantity });
      removePendingScan(scan.id);
    } catch (error) {
      setStatus(`Retry stopped: ${error.message}`, "error");
      break;
    }
  }
  refreshQueueCount();
  if (loadPendingScans().length === 0) setStatus("Pending scans submitted.", "success");
}

async function handleFlavourSearch() {
  const query = els.flavourSearchInput.value.trim();
  window.clearTimeout(searchTimer);

  if (!query) {
    clearFlavourResults();
    return;
  }

  renderFlavourMessage("Searching...");

  searchTimer = window.setTimeout(async () => {
    if (!session) {
      showLogin("Please log in before searching flavours.");
      return;
    }
    if (!navigator.onLine) {
      setStatus("Offline. Flavour search needs an internet connection.", "warning");
      return;
    }

    mark("flavour-search:start");
    try {
      const result = await searchProducts(session, query);
      renderFlavourResults(result.products || [], handleProductSelect);
      measure("flavour-search:results", "flavour-search:start");
    } catch (error) {
      renderFlavourMessage(error.message);
      setStatus(error.message, "error");
    }
  }, 180);
}

async function handleProductSelect(product) {
  const target = selectedTarget();
  const quantity = Math.max(1, Number.parseInt(els.quantityInput.value || "1", 10));
  if (isSubmitting) return;
  if (!session) {
    showLogin("Please log in before updating stock.");
    return;
  }
  if (!navigator.onLine) {
    setStatus("Offline. Row updates cannot be queued safely; retry when online.", "warning");
    return;
  }

  isSubmitting = true;
  updateRecent({ barcode: product.flavour || product.sku || `Row ${product.row}`, target });
  setStatus(`Updating ${product.flavour || "selected product"} to ${targetLabel(target)}...`);
  mark("row-update:start");

  try {
    const result = await updateProductRow({ session, row: product.row, target, quantity });
    setStatus(result.message || `${targetLabel(target)} updated.`, "success");
    els.flavourSearchInput.value = "";
    clearFlavourResults();
    measure("row-update:confirmed", "row-update:start");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    isSubmitting = false;
  }
}

function bindEvents() {
  els.loginForm.addEventListener("submit", handleLogin);

  els.startCameraButton.addEventListener("click", async () => {
    try {
      await startScanner(
        els.cameraPreview,
        (barcode) => handleSubmit(barcode),
        (message) => {
          els.cameraOverlay.textContent = message;
        }
      );
      setCameraRunning(true);
    } catch (error) {
      setCameraRunning(false);
      const message = error.message || "Camera unavailable. Chrome did not provide an error reason.";
      els.cameraOverlay.textContent = message;
      setStatus(message, "error");
    }
  });

  els.stopCameraButton.addEventListener("click", () => {
    stopScanner();
    setCameraRunning(false);
    els.cameraOverlay.textContent = "Camera stopped";
  });

  els.logoutButton.addEventListener("click", () => {
    stopScanner();
    clearSession();
    session = null;
    setCameraRunning(false);
    showLogin("Logged out.");
  });

  document.querySelectorAll("input[name='targetMode']").forEach((input) => {
    input.addEventListener("change", () => updateRecent({ target: selectedTarget() }));
  });

  els.retryQueueButton?.addEventListener("click", retryPendingScans);
  els.flavourSearchInput?.addEventListener("input", handleFlavourSearch);

  window.addEventListener("online", () => setStatus("Back online. Ready to submit scans.", "success"));
  window.addEventListener("offline", () => setStatus("Offline. The app opens, but scans cannot be submitted.", "warning"));
}

async function registerServiceWorker() {
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if ("caches" in window) {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    }
    return;
  }

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch {
      setStatus("Offline caching could not be enabled.", "warning");
    }
  }
}

bindEvents();
registerServiceWorker();
refreshQueueCount();
mark("app:load");
restoreSession();
