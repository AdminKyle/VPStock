export const DEBUG = new URLSearchParams(location.search).get("debug") === "1";

const marks = new Map();
let panel;

export function mark(name) {
  if (!DEBUG) return;
  marks.set(name, performance.now());
  log(`${name}`);
}

export function measure(name, startName) {
  if (!DEBUG) return;
  const start = marks.get(startName);
  if (!start) return;
  log(`${name}: ${Math.round(performance.now() - start)}ms`);
}

export function log(message, data) {
  if (!DEBUG) return;
  console.log(`[StockScanner] ${message}`, data || "");
  ensurePanel();
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString()} ${message}`;
  panel.append(line);
  while (panel.children.length > 12) panel.firstElementChild.remove();
}

function ensurePanel() {
  if (panel) return;
  panel = document.createElement("aside");
  panel.className = "debug-panel";
  panel.setAttribute("aria-label", "Debug timing");
  document.body.append(panel);
}
