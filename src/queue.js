import { CONFIG } from "./config.js";

export function loadPendingScans() {
  try {
    const pending = JSON.parse(localStorage.getItem(CONFIG.PENDING_QUEUE_KEY) || "[]");
    return Array.isArray(pending) ? pending : [];
  } catch {
    return [];
  }
}

export function migratePendingQueue() {
  const versionKey = `${CONFIG.PENDING_QUEUE_KEY}-version`;
  const currentVersion = Number(localStorage.getItem(versionKey) || 0);
  if (currentVersion >= CONFIG.PENDING_QUEUE_VERSION) return 0;

  const clearedCount = loadPendingScans().length;
  localStorage.removeItem(CONFIG.PENDING_QUEUE_KEY);
  localStorage.setItem(versionKey, String(CONFIG.PENDING_QUEUE_VERSION));
  return clearedCount;
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

export function clearPendingScans() {
  const clearedCount = loadPendingScans().length;
  localStorage.removeItem(CONFIG.PENDING_QUEUE_KEY);
  return clearedCount;
}
