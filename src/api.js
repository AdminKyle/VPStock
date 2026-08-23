import { CONFIG } from "./config.js";
import { mark, measure } from "./debug.js";

function requireEndpoint() {
  if (!CONFIG.APPS_SCRIPT_URL || CONFIG.APPS_SCRIPT_URL.includes("PASTE")) {
    throw new Error("Apps Script URL is not configured in src/config.js.");
  }
}

function requestError(message, retryable = false) {
  const error = new Error(message);
  error.retryable = retryable;
  return error;
}

function requestJsonp(action, payload = {}) {
  requireEndpoint();
  return new Promise((resolve, reject) => {
    mark(`${action}:request:start`);
    const callbackName = `stockScanner_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const url = new URL(CONFIG.APPS_SCRIPT_URL);
    url.searchParams.set("action", action);
    url.searchParams.set("callback", callbackName);

    Object.entries(payload).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    });

    const script = document.createElement("script");
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(requestError("Apps Script request timed out.", true));
    }, CONFIG.REQUEST_TIMEOUT_MS);

    function cleanup() {
      window.clearTimeout(timeoutId);
      delete window[callbackName];
      script.remove();
    }

    window[callbackName] = (data) => {
      cleanup();
      measure(`${action}:response`, `${action}:request:start`);
      if (data?.ok === false || data?.success === false) {
        reject(requestError(data.error || data.message || "Request rejected."));
        return;
      }
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      measure(`${action}:failed`, `${action}:request:start`);
      reject(requestError("Apps Script request failed. Check the deployment URL and access settings.", true));
    };

    script.src = url.toString();
    document.head.append(script);
  });
}

export function login(username, pin) {
  return requestJsonp("login", { username, pin });
}

export function validateSession(session) {
  return requestJsonp("validateSession", {
    token: session?.token,
    username: session?.username
  });
}

export function submitScan({ session, barcode, target, quantity }) {
  return requestJsonp("scan", {
    token: session?.token,
    username: session?.username,
    barcode,
    target,
    quantity,
    timestamp: new Date().toISOString()
  });
}

export function searchProducts(session, query) {
  return requestJsonp("searchProducts", {
    token: session?.token,
    username: session?.username,
    query
  });
}

export function updateProductRow({ session, row, target, quantity }) {
  return requestJsonp("updateByRow", {
    token: session?.token,
    username: session?.username,
    row,
    target,
    mode: target,
    quantity,
    qty: quantity,
    timestamp: new Date().toISOString()
  });
}
