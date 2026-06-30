import { CONFIG } from "./config.js";

export function loadSession() {
  try {
    const raw = localStorage.getItem(CONFIG.SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  const safeSession = {
    token: session.token,
    username: session.username,
    displayName: session.displayName || session.username,
    role: session.role || "",
    expiresAt: session.expiresAt || "",
    lastValidatedAt: session.lastValidatedAt || 0
  };
  localStorage.setItem(CONFIG.SESSION_STORAGE_KEY, JSON.stringify(safeSession));
  return safeSession;
}

export function clearSession() {
  localStorage.removeItem(CONFIG.SESSION_STORAGE_KEY);
}

export function isExpired(session) {
  return Boolean(session?.expiresAt && Date.now() > Date.parse(session.expiresAt));
}
