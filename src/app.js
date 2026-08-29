import { CONFIG } from "./config.js?v=24";
import { mark, measure } from "./debug.js";
import { getAllProducts, login, submitScan, updateProductRow, validateSession } from "./api.js?v=24";
import { clearSession, isExpired, loadSession, saveSession } from "./auth.js";
import { filterProducts, formatProductName, prepareProducts } from "./catalog.js?v=24";
import { clearPendingScans, loadPendingScans, migratePendingQueue, queueScan, removePendingScan } from "./queue.js";
import { pauseScanner, preloadScannerLibrary, refocusScanner, resumeScanner, startScanner, stopScanner } from "./scanner.js?v=25";
import {
  els,
  clearFlavourResults,
  renderFlavourResults,
  renderFlavourMessage,
  selectedTarget,
  setCameraOverlay,
  setCameraOpen,
  setCameraRunning,
  setLoginLoading,
  setQueueCount,
  setLoginMessage,
  setStatus,
  showLogin,
  showScanner,
  updateRecent
} from "./ui.js?v=24";

let session = null;
let lastScan = { barcode: "", at: 0 };
let isSubmitting = false;
let searchTimer = 0;
let resumeTimer = 0;
let searchGeneration = 0;
let productCatalog = [];
let productCatalogLoadedAt = 0;
let productCatalogPromise = null;
let productCatalogCacheRead = false;
let catalogSaveTimer = 0;
const productCatalogOverrides = new Map();

function readCachedProductCatalog() {
  if (productCatalogCacheRead) return productCatalog;
  productCatalogCacheRead = true;

  try {
    const cached = JSON.parse(localStorage.getItem(CONFIG.PRODUCT_CATALOG_CACHE_KEY) || "null");
    if (Array.isArray(cached?.products)) {
      productCatalog = prepareProducts(cached.products);
      productCatalogLoadedAt = Number(cached.savedAt || 0);
    }
  } catch {
    try {
      localStorage.removeItem(CONFIG.PRODUCT_CATALOG_CACHE_KEY);
    } catch {
      // Continue with memory-only search when browser storage is unavailable.
    }
  }
  return productCatalog;
}

function saveProductCatalog() {
  window.clearTimeout(catalogSaveTimer);
  catalogSaveTimer = window.setTimeout(() => {
    try {
      const products = productCatalog.map((product) => {
        const cleanProduct = { ...product };
        delete cleanProduct._searchPrimary;
        delete cleanProduct._searchBarcode;
        delete cleanProduct._searchSku;
        delete cleanProduct._searchFields;
        delete cleanProduct._searchText;
        return cleanProduct;
      });
      localStorage.setItem(CONFIG.PRODUCT_CATALOG_CACHE_KEY, JSON.stringify({
        savedAt: productCatalogLoadedAt,
        products
      }));
    } catch {
      // Memory search remains available if browser storage is full or disabled.
    }
  }, 80);
}

function catalogIsFresh() {
  return productCatalog.length > 0
    && Date.now() - productCatalogLoadedAt < CONFIG.PRODUCT_CATALOG_TTL_MS;
}

async function refreshProductCatalog({ force = false } = {}) {
  readCachedProductCatalog();
  if (!force && catalogIsFresh()) return productCatalog;
  if (productCatalogPromise) return productCatalogPromise;
  if (!navigator.onLine) {
    if (productCatalog.length) return productCatalog;
    throw new Error("Product search is unavailable offline until the catalogue has loaded once.");
  }

  mark("product-catalog:start");
  productCatalogPromise = getAllProducts(session)
    .then((result) => {
      productCatalog = prepareProducts(result.products || []);
      productCatalogOverrides.forEach((updatedProduct, row) => {
        const index = productCatalog.findIndex((product) => Number(product.row) === Number(row));
        if (index >= 0) productCatalog[index] = updatedProduct;
      });
      productCatalogLoadedAt = Date.now();
      saveProductCatalog();
      measure("product-catalog:ready", "product-catalog:start");
      return productCatalog;
    })
    .finally(() => {
      productCatalogPromise = null;
    });

  return productCatalogPromise;
}

function warmProductCatalog() {
  readCachedProductCatalog();
  if (!catalogIsFresh()) refreshProductCatalog().catch(() => {});
}

function updateProductCatalog(updatedProduct) {
  if (!updatedProduct?.row) return;
  readCachedProductCatalog();
  const prepared = prepareProducts([updatedProduct])[0];
  productCatalogOverrides.set(Number(updatedProduct.row), prepared);
  if (!productCatalog.length) return;
  const index = productCatalog.findIndex((product) => Number(product.row) === Number(updatedProduct.row));
  if (index >= 0) productCatalog[index] = prepared;
  saveProductCatalog();
}

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

function readQuantity() {
  const rawValue = String(els.quantityInput.value || "").trim();
  if (!/^-?\d+$/.test(rawValue)) {
    throw new Error("Enter a whole quantity, for example 1 or -1.");
  }

  const quantity = Number.parseInt(rawValue, 10);
  if (!Number.isSafeInteger(quantity) || quantity === 0) {
    throw new Error("Quantity cannot be 0.");
  }
  return quantity;
}

function syncQuantitySignButton() {
  const isDeduct = String(els.quantityInput.value || "").trim().startsWith("-");
  els.quantitySignButton.dataset.mode = isDeduct ? "deduct" : "add";
  els.quantitySignButton.textContent = isDeduct ? "−" : "+";
}

function toggleQuantitySign() {
  const rawValue = String(els.quantityInput.value || "").trim();
  if (!rawValue || rawValue === "0") {
    els.quantityInput.value = "-1";
  } else if (rawValue.startsWith("-")) {
    els.quantityInput.value = rawValue.slice(1) || "1";
  } else {
    els.quantityInput.value = `-${rawValue}`;
  }
  syncQuantitySignButton();
  els.quantityInput.focus();
}

function refreshQueueCount() {
  setQueueCount(loadPendingScans().length);
}

function clearRetryQueue() {
  const clearedCount = clearPendingScans();
  refreshQueueCount();
  setStatus(clearedCount
    ? `${clearedCount} pending retries cleared. Stock totals were not changed.`
    : "The retry queue is already empty.", clearedCount ? "warning" : "neutral");
}

function handleDetectedBarcode(barcode) {
  handleSubmit(barcode);
}

function handleCameraStatus(message) {
  setCameraOverlay(message, "neutral", false);
}

function resumeCameraScanning(message = "Point the camera at a barcode.") {
  window.clearTimeout(resumeTimer);
  resumeScanner(handleDetectedBarcode, handleCameraStatus);
  setCameraOverlay(message, "neutral", false);
}

function resumeCameraSoon(message = "Point the camera at a barcode.", delay = 1400) {
  window.clearTimeout(resumeTimer);
  resumeTimer = window.setTimeout(() => resumeCameraScanning(message), delay);
}

function isPermanentScanRejection(error) {
  return /barcode not found|invalid barcode|barcode is too|unsupported characters|invalid scan target|quantity cannot|whole quantity/i.test(error?.message || "");
}

async function openCameraScanner() {
  setCameraOpen(true);
  setCameraOverlay("Starting camera…", "working", false);
  try {
    await startScanner(
      els.cameraPreview,
      handleDetectedBarcode,
      handleCameraStatus
    );
    setCameraRunning(true);
    setCameraOverlay("Point the camera at a barcode.", "neutral", false);
  } catch (error) {
    setCameraRunning(false);
    const message = error.message || "Camera unavailable. The browser did not provide an error reason.";
    setCameraOverlay(message, "error", true);
    setStatus(message, "error");
  }
}

async function handleCameraRefocus() {
  if (els.refocusCameraButton?.disabled) return;
  els.refocusCameraButton.disabled = true;
  setCameraOverlay("Refocusing camera…", "working", false);
  let cameraReady = true;

  try {
    const focused = await refocusScanner();
    if (focused) {
      setCameraOverlay("Focus refreshed. Point at a barcode.", "neutral", false);
      return;
    }

    setCameraOverlay("Restarting camera to refresh focus…", "working", false);
    await startScanner(els.cameraPreview, handleDetectedBarcode, handleCameraStatus);
    setCameraOverlay("Focus refreshed. Point at a barcode.", "neutral", false);
  } catch (error) {
    cameraReady = false;
    setCameraRunning(false);
    const message = error.message || "Could not refresh camera focus.";
    setCameraOverlay(message, "error", true);
    setStatus(message, "error");
  } finally {
    if (!els.cameraModal.classList.contains("hidden")) {
      els.refocusCameraButton.disabled = !cameraReady;
    }
  }
}

function closeCameraScanner() {
  window.clearTimeout(resumeTimer);
  stopScanner();
  setCameraRunning(false);
  setCameraOverlay("Camera stopped", "neutral", false);
  setCameraOpen(false);
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
  setStatus("Ready to scan. Checking saved session in the background...");
  preloadScannerLibrary().catch(() => {});
  warmProductCatalog();
  measure("app:scanner-visible", "app:restore-session:start");

  const lastValidated = Number(stored.lastValidatedAt || 0);
  if (Date.now() - lastValidated < CONFIG.SESSION_REVALIDATE_MS) return;

  validateSession(stored)
    .then((validated) => {
      session = saveSession({ ...stored, ...validated.session, lastValidatedAt: Date.now() });
      showScanner(session);
      setStatus("Ready for the next scan.");
    })
    .catch((error) => {
      clearSession();
      session = null;
      stopScanner();
      setCameraRunning(false);
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
    setStatus("Ready for the next scan.");
    preloadScannerLibrary().catch(() => {});
    warmProductCatalog();
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
  let quantity;

  if (isSubmitting) return;
  if (barcode) {
    pauseScanner();
    setCameraOverlay(`Found ${barcode}. Preparing...`, "working", false);
  }

  if (!session) {
    setCameraOverlay("Please log in before scanning.", "error", true);
    showLogin("Please log in before scanning.");
    return;
  }

  const barcodeError = validateBarcode(barcode);
  if (barcodeError) {
    setCameraOverlay(barcodeError, "error", true);
    setStatus(barcodeError, "error");
    return;
  }

  try {
    quantity = readQuantity();
  } catch (error) {
    setCameraOverlay(error.message, "error", true);
    setStatus(error.message, "error");
    return;
  }

  if (isDuplicate(barcode)) {
    updateRecent({ barcode, target, quantity });
    setCameraOverlay("Duplicate scan ignored.", "warning", false);
    setStatus("Duplicate scan ignored. Wait a moment before scanning it again.", "warning");
    resumeCameraSoon();
    return;
  }

  if (!navigator.onLine) {
    const queued = queueScan({ barcode, target, quantity, username: session.username });
    updateRecent({ barcode, target, quantity });
    refreshQueueCount();
    setCameraOverlay(`Queued ${queued.barcode}.`, "warning", false);
    setStatus(`Offline. Scan queued for manual retry (${queued.barcode}).`, "warning");
    resumeCameraSoon();
    return;
  }

  updateRecent({ target, quantity });
  isSubmitting = true;
  setCameraOverlay(`Submitting ${barcode}...`, "working", false);
  setStatus(`Submitting ${barcode} to ${targetLabel(target)}...`, "working");
  mark("scan-submit:start");

  try {
    const result = await submitScan({ session, barcode, target, quantity });
    updateProductCatalog(result.product);
    const flavour = result.product ? formatProductName(result.product) : barcode;
    const action = quantity < 0 ? "Deducted" : "Successfully Added";
    updateRecent({ flavour, barcode, target, quantity });
    setCameraOverlay(`${action} ${Math.abs(quantity)} to ${targetLabel(target)}.`, "success", false);
    setStatus(result.message || `${targetLabel(target)} updated.`, "success");
    measure("scan-submit:confirmed", "scan-submit:start");
    resumeCameraSoon();
  } catch (error) {
    if (error.retryable) {
      const message = `${error.message} This scan was not queued because the update result may be uncertain. Check stock before scanning it again.`;
      setCameraOverlay("Connection issue. Check stock before retrying.", "warning", true);
      setStatus(message, "warning");
    } else {
      setCameraOverlay(error.message, "error", true);
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
  setStatus(`Retrying ${pending.length} pending scan(s)...`, "working");
  let discardedCount = 0;
  for (const scan of pending) {
    try {
      await submitScan({ session, barcode: scan.barcode, target: scan.target, quantity: scan.quantity });
      removePendingScan(scan.id);
    } catch (error) {
      if (isPermanentScanRejection(error)) {
        removePendingScan(scan.id);
        discardedCount += 1;
        continue;
      }
      setStatus(`Retry stopped: ${error.message}`, "error");
      break;
    }
  }
  refreshQueueCount();
  if (loadPendingScans().length === 0) {
    setStatus(discardedCount
      ? `Retry queue cleared. ${discardedCount} rejected scan(s) were discarded without changing stock.`
      : "Pending scans submitted.", discardedCount ? "warning" : "success");
  }
}

async function handleFlavourSearch() {
  const query = els.flavourSearchInput.value.trim();
  window.clearTimeout(searchTimer);
  const generation = ++searchGeneration;

  if (!query) {
    clearFlavourResults();
    return;
  }

  readCachedProductCatalog();
  if (!productCatalog.length) renderFlavourMessage("Preparing product catalogue...");

  searchTimer = window.setTimeout(async () => {
    if (!session) {
      showLogin("Please log in before searching flavours.");
      return;
    }
    mark("flavour-search:start");
    try {
      const products = productCatalog.length ? productCatalog : await refreshProductCatalog();
      if (generation !== searchGeneration || els.flavourSearchInput.value.trim() !== query) return;
      renderFlavourResults(filterProducts(products, query), handleProductSelect);
      measure("flavour-search:results", "flavour-search:start");

      if (!catalogIsFresh() && navigator.onLine) {
        refreshProductCatalog()
          .then((freshProducts) => {
            if (generation !== searchGeneration || els.flavourSearchInput.value.trim() !== query) return;
            renderFlavourResults(filterProducts(freshProducts, query), handleProductSelect);
          })
          .catch(() => {});
      }
    } catch (error) {
      if (generation !== searchGeneration) return;
      renderFlavourMessage(error.message);
      setStatus(error.message, "error");
    }
  }, 35);
}

async function handleProductSelect(product) {
  const target = selectedTarget();
  let quantity;
  if (isSubmitting) return;
  if (!session) {
    showLogin("Please log in before updating stock.");
    return;
  }
  if (!navigator.onLine) {
    setStatus("Offline. Row updates cannot be queued safely; retry when online.", "warning");
    return;
  }
  try {
    quantity = readQuantity();
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }

  isSubmitting = true;
  const productName = product.displayName || formatProductName(product);
  updateRecent({ flavour: productName || product.sku || `Row ${product.row}`, target, quantity });
  setStatus(`Updating ${productName || "selected product"} to ${targetLabel(target)}...`, "working");
  mark("row-update:start");

  try {
    const result = await updateProductRow({ session, row: product.row, target, quantity });
    updateProductCatalog(result.product);
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

  els.startCameraButton.addEventListener("click", openCameraScanner);

  els.stopCameraButton.addEventListener("click", closeCameraScanner);
  els.refocusCameraButton?.addEventListener("click", handleCameraRefocus);

  els.logoutButton.addEventListener("click", () => {
    window.clearTimeout(resumeTimer);
    stopScanner();
    clearSession();
    session = null;
    searchGeneration += 1;
    setCameraRunning(false);
    setCameraOpen(false);
    showLogin("Logged out.");
  });

  document.querySelectorAll("input[name='targetMode']").forEach((input) => {
    input.addEventListener("change", () => updateRecent({ target: selectedTarget() }));
  });

  els.retryQueueButton?.addEventListener("click", retryPendingScans);
  els.clearQueueButton?.addEventListener("click", clearRetryQueue);
  els.cameraRetryButton?.addEventListener("click", openCameraScanner);
  els.flavourSearchInput?.addEventListener("input", handleFlavourSearch);
  els.quantitySignButton?.addEventListener("click", toggleQuantitySign);
  els.quantityInput?.addEventListener("input", syncQuantitySignButton);

  window.addEventListener("online", () => setStatus("Back online. Ready to submit scans.", "success"));
  window.addEventListener("offline", () => setStatus("Offline. The app opens, but scans cannot be submitted.", "warning"));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.cameraModal.classList.contains("hidden")) closeCameraScanner();
  });
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
syncQuantitySignButton();
registerServiceWorker();
migratePendingQueue();
refreshQueueCount();
mark("app:load");
restoreSession();
