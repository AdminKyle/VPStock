import { CONFIG } from "./config.js";

export function loadPendingScans() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG.PENDING_QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function queueScan(scan) {
  const pending = loadPendingScans();
  const queued = {
    ...scan,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    queuedAt: new Date().toISOString()
  };
  pending.unshift(queued);
  localStorage.setItem(CONFIG.PENDING_QUEUE_KEY, JSON.stringify(pending.slice(0, 25)));
  return queued;
}

export function removePendingScan(id) {
  const pending = loadPendingScans().filter((scan) => scan.id !== id);
  localStorage.setItem(CONFIG.PENDING_QUEUE_KEY, JSON.stringify(pending));
  return pending;
}
