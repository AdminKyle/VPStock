# Stock Scanner Audit

## Evidence Used

The original Android project folder inspected during conversion contained only a default Jetpack Compose `Hello Android` app, not a working scanner implementation. The practical baseline available for comparison is the original Apps Script-hosted scanner that was later pasted into the thread:

- Apps Script `Code.gs` serving an `Index.html` frontend with `google.script.run`.
- Stock tab `MASTER_DB`.
- Barcode column A, SKU column B, flavour column E, backstock column G, shelf stock column H, total quantity column I, last scan column J.
- Scanner library in the old HTML frontend: `html5-qrcode`.
- Sheet update actions: `getAllProducts`, `searchProducts`, `scanBarcode`, and `updateByRow`.

Where this audit says "old APK", read it as "the uploaded Android project plus the old working Apps Script/HTML scanner evidence available." No native APK scanner code was present to benchmark.

## APK / Old Flow vs PWA

| Area | Old uploaded Android / Apps Script evidence | New PWA after audit |
| --- | --- | --- |
| Login | No login flow was present in the uploaded Android code. Old Apps Script HTML did not show a sheet-controlled login. | Login is server-validated through the `Users` sheet and returns a session token. |
| Returning session | Not evidenced in old code. | Stored session opens scanner immediately, then validates in the background if stale. |
| Camera/scanner | Old HTML used `html5-qrcode`; Android scaffold had no scanner code. | PWA uses `@zxing/browser`, rear-camera constraints, lazy/preloaded scanner module. |
| Barcode formats | `html5-qrcode` generally supports QR and common 1D formats through ZXing. | `@zxing/browser` supports common retail 1D formats including EAN/UPC/Code 128/Code 39/ITF depending on browser camera quality. |
| Barcode values | Old Apps Script converted scanned input to `String(...)` before matching. | PWA and Apps Script keep barcode/SKU values as strings and preserve leading zeros. |
| Sheet update | Old backend incremented G or H, recalculated I, wrote J. | Same columns are preserved: G/H/I/J. |
| Flavour lookup | Old pasted HTML searched several product fields. | PWA now searches flavour specifically in `MASTER_DB` column E and updates the selected row. |
| Concurrency | Old backend used `LockService` around update. | Backend keeps `LockService` and improves lookup/session paths. |
| Offline behavior | Old Apps Script HTML depended on live `google.script.run`. | PWA shell can open offline, blocks live submission, queues failed/offline scans for manual retry. |
| Duplicate prevention | Old frontend paused scanner after scan. | PWA has duplicate cooldown, submit lock, disabled buttons, and queue safeguards. |

## Findings

1. **Original APK comparison is limited.** The uploaded Android code had no scanner/login implementation. The old working behavior came from Apps Script/HTML, not native Android code.
2. **Login was slower than necessary for returning users.** The PWA waited for session validation before settling. It now shows the scanner immediately for locally valid sessions and validates in the background on a configurable interval.
3. **Normal `fetch()` was unreliable with Apps Script.** Apps Script web apps often redirect or block CORS from static PWAs. The client now uses JSONP-style script requests and the backend supports `callback=...`.
4. **Scanner startup could be improved.** The scanner library is now preloaded asynchronously after app load/login, while still not blocking initial UI.
5. **Barcode validation was too loose.** The app now trims hidden characters, preserves leading zeros, keeps values as strings, and rejects only obviously invalid values.
6. **Offline scans could be lost.** Failed/offline scan submissions are now added to a small local pending queue for manual retry.
7. **Session validation in Apps Script was inefficient.** Created sessions are cached with `CacheService`, so repeated validation usually avoids scanning the `Sessions` sheet.
8. **Barcode row lookup read the whole column.** Backend now uses `TextFinder` with exact-cell matching and falls back from barcode to SKU.

## Optimisations Made

- Added debug mode via `?debug=1`.
- Added timing marks for app load, login, session validation, scanner library load, camera ready, scan detection, and scan submission.
- Added pending scan queue with manual retry.
- Disabled stale service-worker caching on localhost and bumped production cache.
- Reduced duplicate cooldown from 2500ms to 1400ms.
- Added visible "Next update: Backstock/Shelf stock" near the submit control.
- Added flavour search by `MASTER_DB` column E with row-based updates.
- Added frontend and backend barcode validation.
- Added backend session cache.
- Replaced whole-column row scan with Apps Script `TextFinder`.
- Preserved `MASTER_DB` column mapping.

## Not Changed

- The PWA still uses Apps Script as the backend. A dedicated backend would offer stronger auth, CORS control, and faster indexed lookups, but that would violate the project requirement to keep Google Sheets/Apps Script.
- JSONP is used because Apps Script + static hosting is awkward with browser CORS. This means login parameters are sent in the query string over HTTPS. Avoid sharing URLs/logs containing test credentials. A native app or dedicated backend would avoid that tradeoff.
- Scanner accuracy cannot be proven against the APK because no native scanner implementation was present. Real-world phone testing is required.

## Testing

### Login Speed

1. Open `http://127.0.0.1:4173/?debug=1`.
2. Log in as a valid `Users` row.
3. Watch the debug panel for `login:response` and `login:complete`.
4. Refresh the page after login. The scanner should appear immediately, with background validation only if the stored validation is older than `SESSION_REVALIDATE_MS`.

### Scanner Speed

1. Open `?debug=1`.
2. Press **Start camera**.
3. Watch `scanner-library:loaded` and `camera:ready`.
4. Present a known retail barcode and watch `scan:detected`.

### Accuracy

Test known barcodes/SKUs including:

- EAN-13 with leading zeros where applicable.
- UPC-A / UPC-E.
- EAN-8.
- Code 128.
- Code 39.
- ITF if used in your workflow.
- Manual entry with leading zeros.

Confirm the exact string sent exists in `MASTER_DB` column A or B.

### Sheet Update Reliability

1. Have two users log in.
2. Scan the same product into different targets.
3. Confirm column G increments for Backstock, H increments for Shelf stock, I recalculates total, and J updates timestamp.
4. Try an unknown barcode and confirm a clear error appears without changing sheet values.

## Remaining Risks

- Browser camera APIs vary by device and browser; some phones may focus slower than a native scanner.
- PWA camera access requires HTTPS except on localhost.
- Apps Script latency can vary, especially on first invocation.
- If the web app deployment is not set to an accessible mode, the PWA receives sign-in HTML instead of script output.
- Local pending scans are stored on the device only and are not synced across devices.
