# Stock Scanner PWA

This project now contains a mobile-first Progressive Web App that replaces the starter Android APK approach. It runs as a static site, talks to Google Apps Script, and keeps Google Sheets as the source of truth.

## Existing Flow Found In The Upload

The uploaded Android folder did not include the working scanner logic or any Apps Script files. A later pasted Apps Script showed the live backend shape:

- Spreadsheet ID: `1bwoE6i7RW3Ruotf5QXCePL20lJeczgaQU9CvXjc3aRc`
- Stock tab: `MASTER_DB`
- Barcode: column A
- SKU: column B
- Flavour: column E
- Backstock: column F
- Shelf stock: column G
- Total quantity: column H
- Last user: column I
- Last scan: column J

The replacement `apps-script/Code.gs` uses those values.

Confirm these constants at the top of `apps-script/Code.gs` before deploying:

```js
SPREADSHEET_ID: '1bwoE6i7RW3Ruotf5QXCePL20lJeczgaQU9CvXjc3aRc'
USERS_SHEET: 'Users'
STOCK_SHEET: 'MASTER_DB'
BARCODE_COLUMN: 1
BACKSTOCK_COLUMN: 6
SHELF_STOCK_COLUMN: 7
TOTAL_QTY_COLUMN: 8
SCAN_UPDATE_MODE: 'increment'
```

If row 1 contains matching headers such as `Barcode`, `Backstock`, `Shelf Stock`, or `Total Qty`, the script uses those headers for the main scan columns. Backstock, shelf stock, total quantity, last user, and last scan are written to F, G, H, I, and J.

## Code.gs And Index.html In Apps Script

Your current Apps Script setup has two files:

- `Code.gs`: backend functions and sheet updates.
- `Index.html`: an Apps Script-served frontend that uses `google.script.run`.

The new PWA does not need the Apps Script `Index.html`. For the PWA deployment, Apps Script should act as the JSON backend only, and the PWA's root `index.html` is hosted separately on GitHub Pages, Cloudflare Pages, or another static host.

If you want to keep the old Apps Script-hosted page temporarily, leave its `Index.html` in Apps Script. The replacement backend still includes compatibility routes for `getAllProducts`, `searchProducts`, `scanBarcode`, and `updateByRow`, but scan and update calls require a valid session unless `ALLOW_LEGACY_UNAUTHENTICATED_SCANS` is changed to `true`.

## What The PWA Does

- Login controlled by the Google Sheet `Users` tab.
- Server-side session token validation in Apps Script.
- Fast returning-session restore with background validation.
- Rear-camera barcode scanning using Chrome `BarcodeDetector`, with `html5-qrcode` fallback.
- Manual barcode/SKU fallback.
- Flavour search against `MASTER_DB` column E, with row-based stock update.
- Backstock / Shelf stock selector before submitting.
- Duplicate rapid scan prevention.
- Manual pending-scan retry queue for offline or timed-out submissions.
- Optional debug/performance mode with `?debug=1`.
- Clear success, failure, loading, offline, and camera states.
- Installable PWA shell with `manifest.webmanifest` and service worker.
- Static hosting compatible with GitHub Pages, Cloudflare Pages, Netlify, or any HTTPS host.

## Project Structure

```txt
/
  apps-script/Code.gs
  public/
    icons/icon.svg
    manifest.webmanifest
  src/
    api.js
    app.js
    auth.js
    config.js
    debug.js
    queue.js
    scanner.js
    styles.css
    ui.js
  index.html
  sw.js
  package.json
```

The scanner app is now the static PWA at the repository root.

## Configure The Apps Script URL

After deploying the Apps Script web app, copy its `/exec` URL into `src/config.js`:

```js
export const CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
  SESSION_STORAGE_KEY: "stock-scanner-session",
  DUPLICATE_WINDOW_MS: 2500
};
```

Do not put private secrets in the frontend. The frontend stores only the returned session token and user display information.

## Users Tab

Create or keep a `Users` sheet with a header row. Supported header names are flexible:

- Username: `Username`, `User`, `Staff`, `Staff Name`, or `Name`
- PIN/password: `PIN` or `Password`
- Hashed PIN/password: `PIN Hash` or `Password Hash`
- Active flag: `Active`, `Enabled`, or `Status`
- Role: `Role`

Plain PINs are supported for compatibility. For stronger storage, put a lowercase SHA-256 hash in `PIN Hash` or `Password Hash` and leave the plain PIN/password cell blank.

An active user value may be `TRUE`, `Yes`, `Y`, `Active`, or `1`.

## Stock Column Mapping

The script updates the configured stock sheet:

- Barcode/SKU lookup column: `CONFIG.BARCODE_COLUMN`
- Backstock update column: `CONFIG.BACKSTOCK_COLUMN`
- Shelf stock update column: `CONFIG.SHELF_STOCK_COLUMN`
- Total quantity column: `CONFIG.TOTAL_QTY_COLUMN`
- Last user column: `CONFIG.LAST_USER_COLUMN`

If headers are found in row 1, they take priority over these fallback numbers. Supported default header matches are listed in `CONFIG.BARCODE_HEADERS`, `CONFIG.BACKSTOCK_HEADERS`, `CONFIG.SHELF_HEADERS`, and `CONFIG.TOTAL_QTY_HEADERS`.

After either Backstock or Shelf stock changes, the script writes Total Qty as Backstock + Shelf stock.

`CONFIG.SCAN_UPDATE_MODE` controls how a scan changes the cell:

- `increment`: add the submitted quantity to the current value.
- `setQuantity`: replace the cell with the submitted quantity.
- `setTimestamp`: write the scan time.

Use the mode that matches the behaviour of your existing live Apps Script.

## Deploy Or Update Apps Script

1. Open the Google Sheet.
2. Go to **Extensions > Apps Script**.
3. Paste `apps-script/Code.gs` into the script editor.
4. Update the `CONFIG` constants at the top to match the live sheet.
5. Click **Deploy > New deployment**.
6. Choose **Web app**.
7. Execute as: **Me**.
8. Who has access: choose the appropriate setting for your organisation. For many sheet-backed scanners this is **Anyone with the link**, with app login enforced by the `Users` tab.
9. Copy the deployment `/exec` URL into `src/config.js`.

When updating later, use **Deploy > Manage deployments > Edit** and create a new version.

## Deploy The PWA

The PWA is static. Upload these root files and folders to your static host:

- `index.html`
- `sw.js`
- `src/`
- `public/`

For local testing:

```bash
npm run start
```

Camera scanning requires HTTPS, except on `localhost`.

## Testing And Debug Mode

Open the app with:

```txt
http://127.0.0.1:4173/?debug=1
```

Debug mode shows a small timing panel and logs performance markers to the browser console. It records app load, login request/response, session validation, scanner library loading, camera ready, scan detection, and scan submission confirmation.

To test login speed, log in once, refresh, and confirm the scanner screen appears immediately for a valid saved session. To test scan speed, press **Start camera** and compare `scanner-library:loaded`, `camera:ready`, and `scan:detected` timings.

To test accuracy, scan EAN-8, EAN-13, UPC-A, UPC-E, Code 128, Code 39, and any ITF codes used in the warehouse. Also manually type barcodes with leading zeros; barcode/SKU values are treated as strings and should not lose leading zeros.

To test flavour search, log in, type at least two characters from a known flavour in column E of `MASTER_DB`, tap the matching result, and confirm the selected Backstock/Shelf stock mode updates the same row.

To test update reliability, scan the same item from two devices and confirm `MASTER_DB` updates backstock column G, shelf stock column H, total column I, and last scan column J correctly.

## Install On A Phone

Android Chrome:

1. Open the deployed HTTPS URL.
2. Sign in and allow camera permission.
3. Use **Install app** or **Add to Home screen** from the browser menu.

iPhone Safari:

1. Open the deployed HTTPS URL.
2. Tap **Share**.
3. Tap **Add to Home Screen**.

## Troubleshooting

- **Camera does not start:** confirm the page is served over HTTPS and camera permission is allowed.
- **Login fails:** verify the `Users` sheet headers and that the user is active.
- **Scans say barcode not found:** confirm `STOCK_SHEET`, barcode column/header, and barcode formatting.
- **Wrong stock column updates:** confirm the backstock and shelf stock column constants or headers.
- **PWA does not install:** confirm `manifest.webmanifest`, `sw.js`, and icons are reachable from the deployed URL.
- **CORS or network errors:** deploy Apps Script as a web app, use the `/exec` URL, and make sure the deployment access setting permits requests from the PWA.
- **Apps Script request failed:** open the `/exec?action=ping` URL. It should return `{"ok":true,...}` from the updated backend. If it returns old `success:false` JSON or Google sign-in HTML, redeploy Apps Script as a new version and check access settings.
- **Pending scans:** if a scan times out or the device is offline, use **Retry pending scans** after the connection returns. Pending scans are stored only on that device.

## Notes And Limitations

- The uploaded Android project did not contain a working native scanner implementation. The audit compares the PWA against the available old Apps Script/HTML scanner evidence.
- Google Apps Script cannot provide the same hardened session model as a dedicated backend, but scans are still validated server-side against tokens stored in the spreadsheet.
- The scanner library is loaded from a CDN when the camera starts. The app shell works offline, but scans cannot be submitted while offline.
