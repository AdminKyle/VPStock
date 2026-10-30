import { CONFIG } from "./config.js?v=31";
import { mark, measure } from "./debug.js";
import { addProduct, getAllProducts, getProductTaxonomy, login, previewProductAddition, submitScan, updateMissingProductDetails, updateProductRow, validateSession } from "./api.js?v=31";
import { clearSession, isExpired, loadSession, saveSession } from "./auth.js";
import { filterProducts, formatProductName, prepareProducts } from "./catalog.js?v=31";
import { clearPendingScans, loadPendingScans, migratePendingQueue, queueScan, removePendingScan } from "./queue.js";
import { pauseScanner, preloadScannerLibrary, refocusScanner, resumeScanner, startScanner, stopScanner } from "./scanner.js?v=31";
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
} from "./ui.js?v=31";

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
let pendingProductReview = null;
let isAddingProduct = false;
let productTaxonomy = { brands: [], sections: [] };
let productTaxonomyPromise = null;
let productTaxonomyServerFresh = false;
let pendingUnknownBarcode = "";
let autofilledCog = "";
let autofilledCogSection = "";
let pendingMissingDetails = null;
let isSavingMissingDetails = false;
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

function invalidateProductCatalog() {
  productCatalog = [];
  productCatalogLoadedAt = 0;
  productCatalogPromise = null;
  productCatalogCacheRead = true;
  productCatalogOverrides.clear();
  try {
    localStorage.removeItem(CONFIG.PRODUCT_CATALOG_CACHE_KEY);
  } catch {
    // The fresh in-memory catalogue is still requested below.
  }
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

function missingDetailNames(product = {}) {
  const missing = [];
  if (!cleanBarcode(product.barcode)) missing.push("barcode");
  if (!String(product.sku || "").trim()) missing.push("sku");
  if (!(Number(product.cost) > 0)) missing.push("cog");
  return missing;
}

function setMissingDetailsOpen(isOpen) {
  els.missingDetailsModal?.classList.toggle("hidden", !isOpen);
  document.body.classList.toggle("product-modal-open", isOpen || !els.addProductModal?.classList.contains("hidden"));
}

function offerMissingDetails(product, { fromScanner = false } = {}) {
  const missing = missingDetailNames(product);
  if (!product?.row || !missing.length) return false;
  if (fromScanner) closeCameraScanner();
  pendingMissingDetails = { product, missing };
  els.missingDetailsForm?.reset();
  els.missingDetailsProduct.textContent = formatProductName(product);
  els.missingBarcodeField.classList.toggle("hidden", !missing.includes("barcode"));
  els.missingSkuField.classList.toggle("hidden", !missing.includes("sku"));
  els.missingCogField.classList.toggle("hidden", !missing.includes("cog"));
  setProductMessage(els.missingDetailsMessage);
  setMissingDetailsOpen(true);
  window.setTimeout(() => {
    const firstInput = [els.missingBarcodeInput, els.missingSkuInput, els.missingCogInput]
      .find((input) => input && !input.closest(".field")?.classList.contains("hidden"));
    firstInput?.focus();
  }, 40);
  return true;
}

function closeMissingDetails() {
  if (isSavingMissingDetails) return;
  pendingMissingDetails = null;
  setMissingDetailsOpen(false);
  els.missingDetailsForm?.reset();
  els.startCameraButton?.focus();
}

async function saveMissingDetails(event) {
  event.preventDefault();
  if (isSavingMissingDetails || !pendingMissingDetails) return;
  const { product, missing } = pendingMissingDetails;
  const barcode = missing.includes("barcode") ? cleanBarcode(els.missingBarcodeInput.value) : "";
  const sku = missing.includes("sku") ? String(els.missingSkuInput.value || "").trim() : "";
  const cog = missing.includes("cog") ? String(els.missingCogInput.value || "").trim() : "";
  if (!barcode && !sku && !cog) {
    setProductMessage(els.missingDetailsMessage, "Enter at least one missing detail, or choose Not now.", "error");
    return;
  }
  if (barcode) {
    const barcodeError = validateBarcode(barcode);
    if (barcodeError) return setProductMessage(els.missingDetailsMessage, barcodeError, "error");
  }
  if (sku && !/^[A-Za-z0-9._\-/]+$/.test(sku)) return setProductMessage(els.missingDetailsMessage, "SKU contains unsupported characters.", "error");
  if (cog && (!/^\d+(?:\.\d{1,2})?$/.test(cog) || !(Number(cog) > 0))) {
    return setProductMessage(els.missingDetailsMessage, "Enter COG above 0 with up to 2 decimal places.", "error");
  }

  isSavingMissingDetails = true;
  els.saveMissingDetailsButton.disabled = true;
  els.skipMissingDetailsButton.disabled = true;
  els.saveMissingDetailsButton.textContent = "Saving details...";
  setProductMessage(els.missingDetailsMessage, "Quantity is already safe. Saving product details only...");
  try {
    const result = await updateMissingProductDetails({
      session,
      row: product.row,
      brand: product.brand,
      product: product.product || product.productType,
      flavour: product.flavour,
      barcode,
      sku,
      cog
    });
    updateProductCatalog(result.product);
    pendingMissingDetails = null;
    setMissingDetailsOpen(false);
    setStatus(result.message || "Product details updated. Quantity was unchanged.", "success");
  } catch (error) {
    setProductMessage(els.missingDetailsMessage, `${error.message} The quantity update is still saved.`, "error");
  } finally {
    isSavingMissingDetails = false;
    els.saveMissingDetailsButton.disabled = false;
    els.skipMissingDetailsButton.disabled = false;
    els.saveMissingDetailsButton.textContent = "Save details";
  }
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
  hideUnknownBarcodeReview();
  setCameraOverlay(message, "neutral", false);
}

function hideUnknownBarcodeReview() {
  pendingUnknownBarcode = "";
  els.unknownBarcodeReview?.classList.add("hidden");
}

function showUnknownBarcodeReview(barcode) {
  pendingUnknownBarcode = barcode;
  els.unknownBarcodeValue.textContent = barcode;
  els.unknownBarcodeReview.classList.remove("hidden");
  setCameraOverlay("", "warning", false);
  els.useUnknownBarcodeButton?.focus();
}

function rescanUnknownBarcode() {
  hideUnknownBarcodeReview();
  resumeCameraScanning("Point the camera at the barcode again.");
}

function useUnknownBarcode() {
  const barcode = pendingUnknownBarcode;
  if (!barcode) return;
  hideUnknownBarcodeReview();
  closeCameraScanner();
  openAddProductModal({ barcode });
}

function resumeCameraScanning(message = "Point the camera at a barcode.") {
  window.clearTimeout(resumeTimer);
  hideUnknownBarcodeReview();
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
  hideUnknownBarcodeReview();
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
    if (!offerMissingDetails(result.product, { fromScanner: true })) resumeCameraSoon();
  } catch (error) {
    if (error.retryable) {
      const message = `${error.message} This scan was not queued because the update result may be uncertain. Check stock before scanning it again.`;
      setCameraOverlay("Connection issue. Check stock before retrying.", "warning", true);
      setStatus(message, "warning");
    } else if (/barcode not found/i.test(error.message || "")) {
      showUnknownBarcodeReview(barcode);
      setStatus(`Barcode ${barcode} is not in MASTER_DB. Check it before adding a product.`, "warning");
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
    offerMissingDetails(result.product);
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    isSubmitting = false;
  }
}

function setProductModalOpen(isOpen) {
  els.addProductModal?.classList.toggle("hidden", !isOpen);
  document.body.classList.toggle("product-modal-open", isOpen);
}

function setProductMessage(element, message = "", type = "neutral") {
  if (!element) return;
  element.textContent = message;
  element.dataset.type = type;
}

function taxonomyKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function taxonomyFromCatalog(products = []) {
  const sectionMap = new Map();
  products.forEach((item) => {
    const brand = String(item.brand || "").trim();
    const product = String(item.product || item.productType || "").trim();
    const flavour = String(item.flavour || "").trim();
    if (!brand || !product || product === "__SEPARATOR__") return;
    const key = `${taxonomyKey(brand)}|${taxonomyKey(product)}`;
    if (!sectionMap.has(key)) sectionMap.set(key, { brand, product, label: `${brand} · ${product}`, flavours: [], cost: item.cost });
    const section = sectionMap.get(key);
    if (flavour && !section.flavours.includes(flavour)) section.flavours.push(flavour);
  });
  const sections = [...sectionMap.values()];
  return {
    brands: [...new Set(sections.map((section) => section.brand))].sort((a, b) => a.localeCompare(b)),
    sections
  };
}

function renderActiveCombobox() {
  const active = document.activeElement;
  if (active === els.newProductBrandInput) renderCombobox("brand", active, els.brandSuggestions);
  else if (active === els.newProductTypeInput) renderCombobox("product", active, els.productSuggestions);
  else if (active === els.newProductFlavourInput) renderCombobox("flavour", active, els.flavourSuggestions);
}

async function loadProductTaxonomy({ force = false } = {}) {
  if (!force && productTaxonomyServerFresh) return productTaxonomy;
  if (productTaxonomyPromise) return productTaxonomyPromise;
  productTaxonomyPromise = getProductTaxonomy(session)
    .then((result) => {
      const cachedCosts = new Map(productTaxonomy.sections.map((section) => [
        `${taxonomyKey(section.brand)}|${taxonomyKey(section.product)}`,
        section.cost
      ]));
      const sections = (result.sections || []).map((section) => ({
        ...section,
        cost: section.cost ?? cachedCosts.get(`${taxonomyKey(section.brand)}|${taxonomyKey(section.product)}`)
      }));
      productTaxonomy = { brands: result.brands || [], sections };
      productTaxonomyServerFresh = true;
      renderActiveCombobox();
      prefillMatchedCog();
      return productTaxonomy;
    })
    .finally(() => { productTaxonomyPromise = null; });
  return productTaxonomyPromise;
}

function matchingSection(brand, product) {
  const brandKey = taxonomyKey(brand);
  const productKey = taxonomyKey(product);
  return productTaxonomy.sections.find((section) =>
    taxonomyKey(section.brand) === brandKey && taxonomyKey(section.product) === productKey
  ) || null;
}

function prefillMatchedCog() {
  const input = els.newProductCogInput;
  if (!input) return;
  const section = matchingSection(els.newProductBrandInput?.value, els.newProductTypeInput?.value);
  const sectionKey = section ? `${taxonomyKey(section.brand)}|${taxonomyKey(section.product)}` : "";
  const currentValue = String(input.value || "").trim();
  const mayReplace = !currentValue || (autofilledCogSection && currentValue === autofilledCog);
  if (!mayReplace) return;

  const numericCost = Number(String(section?.cost ?? "").replace(/[^0-9.-]/g, ""));
  const nextValue = section && Number.isFinite(numericCost) && numericCost > 0 ? numericCost.toFixed(2) : "";
  input.value = nextValue;
  autofilledCog = nextValue;
  autofilledCogSection = nextValue ? sectionKey : "";
}

function comboboxOptions(field) {
  const brand = String(els.newProductBrandInput?.value || "").trim();
  const product = String(els.newProductTypeInput?.value || "").trim();
  if (field === "brand") return productTaxonomy.brands;
  const brandQuery = taxonomyKey(brand);
  const matchingBrandSections = productTaxonomy.sections
    .filter((section) => !brandQuery || taxonomyKey(section.brand).includes(brandQuery));
  if (field === "product") return productTaxonomy.sections
    .filter((section) => !brandQuery || taxonomyKey(section.brand).includes(brandQuery))
    .map((section) => section.product);
  const productQuery = taxonomyKey(product);
  return matchingBrandSections
    .filter((section) => !productQuery || taxonomyKey(section.product).includes(productQuery))
    .flatMap((section) => section.flavours || []);
}

function renderCombobox(field, input, menu) {
  const query = taxonomyKey(input.value);
  const values = [...new Set(comboboxOptions(field))]
    .filter((value) => !query || taxonomyKey(value).includes(query))
    .slice(0, 8);
  menu.replaceChildren();
  values.forEach((value) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "combobox-option";
    option.setAttribute("role", "option");
    option.textContent = value;
    option.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      input.value = value;
      menu.classList.add("hidden");
      input.setAttribute("aria-expanded", "false");
      if (field === "brand") {
        els.newProductTypeInput.value = "";
        els.newProductFlavourInput.value = "";
        prefillMatchedCog();
        els.newProductTypeInput.focus();
      } else if (field === "product") {
        els.newProductFlavourInput.value = "";
        prefillMatchedCog();
        els.newProductFlavourInput.focus();
      }
    });
    menu.append(option);
  });
  menu.classList.toggle("hidden", values.length === 0);
  input.setAttribute("aria-expanded", String(values.length > 0));
}

function closeCombobox(input, menu) {
  if (document.activeElement === input || menu?.contains(document.activeElement)) return;
  menu?.classList.add("hidden");
  input?.setAttribute("aria-expanded", "false");
}

function resetProductForm() {
  pendingProductReview = null;
  autofilledCog = "";
  autofilledCogSection = "";
  els.addProductForm?.reset();
  els.addProductFields?.classList.remove("hidden");
  els.addProductReview?.classList.add("hidden");
  els.newSectionConfirmation?.classList.add("hidden");
  els.matchedSectionSummary?.classList.remove("warning");
  setProductMessage(els.addProductMessage);
  setProductMessage(els.addProductReviewMessage);
  if (els.reviewProductButton) {
    els.reviewProductButton.disabled = false;
    els.reviewProductButton.textContent = "Review product";
  }
  if (els.confirmAddProductButton) {
    els.confirmAddProductButton.disabled = false;
    els.confirmAddProductButton.textContent = "Confirm and add";
  }
}

function openAddProductModal({ barcode = "" } = {}) {
  if (!session) {
    showLogin("Please log in before adding a product.");
    return;
  }
  if (!navigator.onLine) {
    setStatus("Product additions require an internet connection.", "warning");
    return;
  }
  resetProductForm();
  if (barcode) els.newProductBarcodeInput.value = barcode;
  setProductModalOpen(true);
  readCachedProductCatalog();
  if (productCatalog.length) {
    productTaxonomy = taxonomyFromCatalog(productCatalog);
    setProductMessage(els.addProductMessage, "Saved product ranges are ready. Refreshing…");
  } else {
    setProductMessage(els.addProductMessage, "Loading product ranges…");
  }
  loadProductTaxonomy()
    .then(() => {
      setProductMessage(els.addProductMessage);
      renderActiveCombobox();
    })
    .catch((error) => {
      if (productTaxonomy.sections.length) {
        setProductMessage(els.addProductMessage, "Using saved product ranges. Live refresh will retry next time.");
        renderActiveCombobox();
      } else {
        setProductMessage(els.addProductMessage, error.message, "error");
      }
    });
  window.setTimeout(() => els.newProductBrandInput?.focus(), 40);
}

function closeAddProductModal() {
  if (isAddingProduct) return;
  setProductModalOpen(false);
  resetProductForm();
  els.addProductButton?.focus();
}

function newProductInput() {
  return {
    brand: String(els.newProductBrandInput?.value || "").trim().replace(/\s+/g, " "),
    product: String(els.newProductTypeInput?.value || "").trim().replace(/\s+/g, " "),
    flavour: String(els.newProductFlavourInput?.value || "").trim().replace(/\s+/g, " "),
    barcode: cleanBarcode(els.newProductBarcodeInput?.value),
    sku: String(els.newProductSkuInput?.value || "").trim(),
    cog: String(els.newProductCogInput?.value || "").trim()
  };
}

function validateNewProductClient(input) {
  if (!input.brand) return "Choose or enter a brand.";
  if (!input.product) return "Choose or enter a product.";
  if (!input.flavour) return "Enter a flavour or colour.";
  const barcodeError = validateBarcode(input.barcode);
  if (barcodeError) return barcodeError;
  if (input.sku && !/^[A-Za-z0-9._\-/]+$/.test(input.sku)) return "SKU contains unsupported characters.";
  if (input.cog && !/^\d+(?:\.\d{1,2})?$/.test(input.cog)) return "Enter COG as a non-negative amount with up to 2 decimal places.";
  return "";
}

function addSummaryLine(container, label, value) {
  const line = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = label;
  line.append(strong, document.createTextNode(value));
  container.append(line);
}

function renderProductReview(result, input) {
  pendingProductReview = { result, input };
  els.reviewBrand.textContent = input.brand;
  els.reviewProductName.textContent = input.product;
  els.reviewFlavour.textContent = input.flavour;
  els.reviewBarcode.textContent = input.barcode;
  els.reviewSku.textContent = input.sku || "Not supplied";
  els.reviewCog.textContent = input.cog
    ? `£${Number(input.cog).toFixed(2)}`
    : (result.match ? "Use matched section" : "Not supplied");
  els.matchedSectionSummary.replaceChildren();

  if (result.match) {
    const inheritedCost = Number(String(result.match.inheritedCost ?? "").replace(/[^0-9.-]/g, ""));
    const inheritedCostLabel = Number.isFinite(inheritedCost) ? `£${inheritedCost.toFixed(2)}` : "No C.O.G.";
    els.matchedSectionSummary.classList.remove("warning");
    addSummaryLine(els.matchedSectionSummary, `Matched section: ${result.match.label}`, "");
    addSummaryLine(els.matchedSectionSummary, "Existing flavour example: ", result.match.exemplarName);
    addSummaryLine(els.matchedSectionSummary, "Inherited: ", `${result.match.inheritedBrand || "No brand"} · ${inheritedCostLabel} · ${result.match.inheritedCategory || "Uncategorised"}`);
    els.newSectionConfirmation.classList.add("hidden");
    els.confirmAddProductButton.textContent = "Confirm and add";
  } else {
    els.matchedSectionSummary.classList.add("warning");
    addSummaryLine(els.matchedSectionSummary, "No existing section matched", "");
    const detail = document.createElement("span");
    detail.textContent = "Check Brand and Product carefully. Continuing will create a black separator at the bottom of MASTER_DB, then start this new range beneath it.";
    els.matchedSectionSummary.append(detail);
    els.newSectionConfirmation.classList.remove("hidden");
    els.confirmAddProductButton.textContent = "Create section and add";
  }

  els.addProductFields.classList.add("hidden");
  els.addProductReview.classList.remove("hidden");
  els.confirmAddProductButton.focus();
}

async function handleProductReview(event) {
  event.preventDefault();
  if (isAddingProduct) return;
  if (!session) {
    closeAddProductModal();
    showLogin("Please log in before adding a product.");
    return;
  }
  if (!navigator.onLine) {
    setProductMessage(els.addProductMessage, "Product additions require an internet connection.", "error");
    return;
  }

  const input = newProductInput();
  const inputError = validateNewProductClient(input);
  if (inputError) {
    setProductMessage(els.addProductMessage, inputError, "error");
    return;
  }

  isAddingProduct = true;
  els.reviewProductButton.disabled = true;
  els.reviewProductButton.textContent = "Checking MASTER_DB...";
  const createNewSection = !matchingSection(input.brand, input.product);
  setProductMessage(els.addProductMessage, createNewSection ? "Checking the new section and duplicates…" : "Confirming the exact product section…");
  try {
    const result = await previewProductAddition({ session, ...input, createNewSection });
    renderProductReview(result, input);
  } catch (error) {
    setProductMessage(els.addProductMessage, error.message, "error");
  } finally {
    isAddingProduct = false;
    els.reviewProductButton.disabled = false;
    els.reviewProductButton.textContent = "Review product";
  }
}

function editProductDetails() {
  pendingProductReview = null;
  els.addProductReview.classList.add("hidden");
  els.addProductFields.classList.remove("hidden");
  els.confirmNewSectionInput.checked = false;
  setProductMessage(els.addProductReviewMessage);
  els.newProductBrandInput.focus();
}

async function confirmProductAddition() {
  if (isAddingProduct || !pendingProductReview) return;
  const { result, input } = pendingProductReview;
  const confirmNewSection = !result.match;
  if (confirmNewSection && !els.confirmNewSectionInput.checked) {
    setProductMessage(els.addProductReviewMessage, "Tick the new-section confirmation before continuing.", "error");
    return;
  }

  isAddingProduct = true;
  els.confirmAddProductButton.disabled = true;
  els.editProductButton.disabled = true;
  els.confirmAddProductButton.textContent = "Adding safely...";
  setProductMessage(els.addProductReviewMessage, "Adding the product without changing existing product rows...");
  try {
    const added = await addProduct({
      session,
      ...input,
      confirmationToken: result.confirmationToken,
      confirmNewSection
    });
    invalidateProductCatalog();
    await refreshProductCatalog({ force: true });
    setProductModalOpen(false);
    resetProductForm();
    productTaxonomy = { brands: [], sections: [] };
    productTaxonomyServerFresh = false;
    setStatus(added.message || `${input.brand} ${input.product} ${input.flavour} was added.`, "success");
    updateRecent({ flavour: `${input.brand} ${input.product} ${input.flavour}` });
  } catch (error) {
    setProductMessage(els.addProductReviewMessage, error.message, "error");
  } finally {
    isAddingProduct = false;
    els.confirmAddProductButton.disabled = false;
    els.editProductButton.disabled = false;
    els.confirmAddProductButton.textContent = result.match ? "Confirm and add" : "Create section and add";
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
    setProductModalOpen(false);
    setMissingDetailsOpen(false);
    pendingMissingDetails = null;
    resetProductForm();
    showLogin("Logged out.");
  });

  document.querySelectorAll("input[name='targetMode']").forEach((input) => {
    input.addEventListener("change", () => updateRecent({ target: selectedTarget() }));
  });

  els.retryQueueButton?.addEventListener("click", retryPendingScans);
  els.clearQueueButton?.addEventListener("click", clearRetryQueue);
  els.cameraRetryButton?.addEventListener("click", openCameraScanner);
  els.rescanUnknownBarcodeButton?.addEventListener("click", rescanUnknownBarcode);
  els.useUnknownBarcodeButton?.addEventListener("click", useUnknownBarcode);
  els.flavourSearchInput?.addEventListener("input", handleFlavourSearch);
  els.quantitySignButton?.addEventListener("click", toggleQuantitySign);
  els.quantityInput?.addEventListener("input", syncQuantitySignButton);
  els.addProductButton?.addEventListener("click", openAddProductModal);
  els.closeAddProductButton?.addEventListener("click", closeAddProductModal);
  els.addProductForm?.addEventListener("submit", handleProductReview);
  els.editProductButton?.addEventListener("click", editProductDetails);
  els.confirmAddProductButton?.addEventListener("click", confirmProductAddition);
  els.missingDetailsForm?.addEventListener("submit", saveMissingDetails);
  els.closeMissingDetailsButton?.addEventListener("click", closeMissingDetails);
  els.skipMissingDetailsButton?.addEventListener("click", closeMissingDetails);
  [
    ["brand", els.newProductBrandInput, els.brandSuggestions],
    ["product", els.newProductTypeInput, els.productSuggestions],
    ["flavour", els.newProductFlavourInput, els.flavourSuggestions]
  ].forEach(([field, input, menu]) => {
    input?.addEventListener("focus", () => renderCombobox(field, input, menu));
    input?.addEventListener("input", () => {
      renderCombobox(field, input, menu);
      if (field === "brand" || field === "product") prefillMatchedCog();
    });
    input?.addEventListener("blur", () => window.setTimeout(() => closeCombobox(input, menu), 100));
  });

  window.addEventListener("online", () => setStatus("Back online. Ready to submit scans.", "success"));
  window.addEventListener("offline", () => setStatus("Offline. The app opens, but scans cannot be submitted.", "warning"));
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!els.missingDetailsModal.classList.contains("hidden")) closeMissingDetails();
    else if (!els.addProductModal.classList.contains("hidden")) closeAddProductModal();
    else if (!els.cameraModal.classList.contains("hidden")) closeCameraScanner();
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
      const registration = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });
      await registration.update();
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
