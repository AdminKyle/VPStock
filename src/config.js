export const CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxZ1z7z6ansSH8-oNQhPTCzhfPu1pYr4WI-o3Xuo8RQjN_Jm3Jlcmx9xttSaYrxq5OxUA/exec",
  SESSION_STORAGE_KEY: "stock-scanner-session",
  PENDING_QUEUE_KEY: "stock-scanner-pending-scans",
  DUPLICATE_WINDOW_MS: 1400,
  REQUEST_TIMEOUT_MS: 18000,
  SESSION_REVALIDATE_MS: 5 * 60 * 1000,
  MIN_BARCODE_LENGTH: 4,
  MAX_BARCODE_LENGTH: 48,
  HTML5_QRCODE_CDN: "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"
};
