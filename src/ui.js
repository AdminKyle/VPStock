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
  cameraPreview: document.querySelector("#cameraPreview"),
  cameraOverlay: document.querySelector("#cameraOverlay"),
  startCameraButton: document.querySelector("#startCameraButton"),
  stopCameraButton: document.querySelector("#stopCameraButton"),
  quantityInput: document.querySelector("#quantityInput"),
  flavourSearchInput: document.querySelector("#flavourSearchInput"),
  flavourResults: document.querySelector("#flavourResults"),
  statusBanner: document.querySelector("#statusBanner"),
  lastBarcode: document.querySelector("#lastBarcode"),
  lastTarget: document.querySelector("#lastTarget"),
  activeTarget: document.querySelector("#activeTarget"),
  retryQueueButton: document.querySelector("#retryQueueButton"),
  queueCount: document.querySelector("#queueCount")
};

export function showLogin(message = "") {
  els.loginView.classList.remove("hidden");
  els.scannerView.classList.add("hidden");
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
  els.stopCameraButton.disabled = !isRunning;
}

export function setLoginMessage(message, type = "neutral") {
  els.loginMessage.textContent = message;
  els.loginMessage.dataset.type = type;
}

export function setStatus(message, type = "neutral") {
  els.statusBanner.textContent = message;
  els.statusBanner.className = `status-banner ${type}`;
}

export function updateRecent({ barcode, target }) {
  if (barcode) els.lastBarcode.textContent = barcode;
  if (target) {
    const label = target === "shelf" ? "Shelf stock" : "Backstock";
    els.lastTarget.textContent = label;
    if (els.activeTarget) els.activeTarget.textContent = label;
  }
}

export function setQueueCount(count) {
  if (!els.queueCount || !els.retryQueueButton) return;
  els.queueCount.textContent = String(count);
  els.retryQueueButton.disabled = count === 0;
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
      <span class="result-title">${escapeHtml(product.flavour || product.productType || "Unnamed product")}</span>
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
  els.flavourResults.innerHTML = "";
  els.flavourResults.classList.add("hidden");
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
