export const els = {
  loginView: document.querySelector("#loginView"),
  scannerView: document.querySelector("#scannerView"),
  loginForm: document.querySelector("#loginForm"),
  usernameInput: document.querySelector("#usernameInput"),
  pinInput: document.querySelector("#pinInput"),
  loginButton: document.querySelector("#loginButton"),
  loginMessage: document.querySelector("#loginMessage"),
  currentUser: document.querySelector("#currentUser"),
  logoutButton: document.querySelector("#logoutButton"),
  cameraModal: document.querySelector("#cameraModal"),
  cameraPreview: document.querySelector("#cameraPreview"),
  cameraOverlay: document.querySelector("#cameraOverlay"),
  cameraOverlayText: document.querySelector("#cameraOverlayText"),
  cameraRetryButton: document.querySelector("#cameraRetryButton"),
  startCameraButton: document.querySelector("#startCameraButton"),
  stopCameraButton: document.querySelector("#stopCameraButton"),
  quantityInput: document.querySelector("#quantityInput"),
  quantitySignButton: document.querySelector("#quantitySignButton"),
  flavourSearchInput: document.querySelector("#flavourSearchInput"),
  flavourResults: document.querySelector("#flavourResults"),
  statusBanner: document.querySelector("#statusBanner"),
  statusPanel: document.querySelector("#statusPanel"),
  statusGlyph: document.querySelector("#statusGlyph"),
  lastBarcode: document.querySelector("#lastBarcode"),
  lastTarget: document.querySelector("#lastTarget"),
  lastQuantity: document.querySelector("#lastQuantity"),
  activeTarget: document.querySelector("#activeTarget"),
  queueActions: document.querySelector("#queueActions"),
  retryQueueButton: document.querySelector("#retryQueueButton"),
  clearQueueButton: document.querySelector("#clearQueueButton"),
  queueCount: document.querySelector("#queueCount")
};

export function showLogin(message = "") {
  els.loginView.classList.remove("hidden");
  els.scannerView.classList.add("hidden");
  els.cameraModal?.classList.add("hidden");
  document.body.classList.remove("camera-open");
  setLoginMessage(message);
}

export function showScanner(session) {
  els.loginView.classList.add("hidden");
  els.scannerView.classList.remove("hidden");
  els.currentUser.textContent = session.displayName || session.username;
}

export function setLoginLoading(isLoading) {
  els.loginButton.disabled = isLoading;
  els.loginButton.textContent = isLoading ? "Checking..." : "Log in";
}

export function setCameraRunning(isRunning) {
  els.startCameraButton.disabled = isRunning;
  els.stopCameraButton.disabled = false;
}

export function setCameraOpen(isOpen) {
  els.cameraModal.classList.toggle("hidden", !isOpen);
  document.body.classList.toggle("camera-open", isOpen);
}

export function setCameraOverlay(message, type = "neutral", showRetry = false) {
  els.cameraOverlay.dataset.type = type;
  els.cameraOverlayText.textContent = message;
  els.cameraRetryButton.classList.toggle("hidden", !showRetry);
}

export function setLoginMessage(message, type = "neutral") {
  els.loginMessage.textContent = message;
  els.loginMessage.dataset.type = type;
}

export function setStatus(message, type = "neutral") {
  els.statusBanner.textContent = message;
  els.statusBanner.className = `status-banner ${type}`;
  els.statusPanel.dataset.type = type;
  els.statusGlyph.textContent = ({ success: "✓", error: "×", warning: "!", working: "…" })[type] || "•";
}

export function updateRecent({ barcode, flavour, target, quantity }) {
  if (flavour || barcode) els.lastBarcode.textContent = flavour || barcode;
  if (target) {
    const label = target === "shelf" ? "Shelf stock" : "Backstock";
    els.lastTarget.textContent = label;
    if (els.activeTarget) els.activeTarget.textContent = label;
  }
  if (quantity) els.lastQuantity.textContent = `Qty ${quantity > 0 ? "+" : ""}${quantity}`;
}

export function setQueueCount(count) {
  if (!els.queueCount || !els.retryQueueButton || !els.clearQueueButton || !els.queueActions) return;
  els.queueCount.textContent = String(count);
  els.retryQueueButton.disabled = count === 0;
  els.clearQueueButton.disabled = count === 0;
  els.queueActions.classList.toggle("hidden", count === 0);
}

export function selectedTarget() {
  return document.querySelector("input[name='targetMode']:checked")?.value || "backstock";
}

export function renderFlavourResults(products, onSelect) {
  if (!els.flavourResults) return;
  els.flavourResults.innerHTML = "";
  if (!products.length) {
    renderFlavourMessage("No matching flavours found.");
    return;
  }

  const fragment = document.createDocumentFragment();
  const list = document.createElement("div");
  list.className = "result-list";
  list.setAttribute("role", "listbox");
  products.forEach((product) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-item";
    button.setAttribute("role", "option");
    button.innerHTML = `
      <span class="result-title">${escapeHtml(product.displayName || product.flavour || product.productType || "Unnamed product")}</span>
      <span class="result-meta">${escapeHtml(product.brand || "")} ${escapeHtml(product.sku ? `SKU ${product.sku}` : "")}</span>
      <span class="result-stock">Shelf ${Number(product.shelfStock) || 0} / Back ${Number(product.backstock) || 0} / Total ${Number(product.totalQty) || 0}</span>
    `;
    button.addEventListener("click", () => onSelect(product));
    list.append(button);
  });
  fragment.append(list);
  els.flavourResults.append(fragment);
  els.flavourResults.classList.remove("hidden");
}

export function renderFlavourMessage(message) {
  if (!els.flavourResults) return;
  els.flavourResults.innerHTML = `<div class="result-empty">${escapeHtml(message)}</div>`;
  els.flavourResults.classList.remove("hidden");
}

export function clearFlavourResults() {
  if (!els.flavourResults) return;
  els.flavourResults.innerHTML = `
    <div class="results-empty-state">
      <span class="empty-mark" aria-hidden="true">⌕</span>
      <strong>Quick product lookup</strong>
      <span>Type above to loosely filter by product or flavour.</span>
    </div>
  `;
  els.flavourResults.classList.remove("hidden");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}
