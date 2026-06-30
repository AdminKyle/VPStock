const CONFIG = {
  SPREADSHEET_ID: '1bwoE6i7RW3Ruotf5QXCePL20lJeczgaQU9CvXjc3aRc',
  USERS_SHEET: 'Users',
  STOCK_SHEET: 'MASTER_DB',
  SESSIONS_SHEET: 'Sessions',
  LOG_SHEET: 'Scan Log',

  BARCODE_COLUMN: 1,
  SKU_COLUMN: 2,
  CATEGORY_COLUMN: 3,
  BRAND_COLUMN: 4,
  PRODUCT_TYPE_COLUMN: 5,
  FLAVOUR_COLUMN: 5,
  BACKSTOCK_COLUMN: 7,
  SHELF_STOCK_COLUMN: 8,
  TOTAL_QTY_COLUMN: 9,
  LAST_SCAN_COLUMN: 10,

  // If matching headers exist in row 1, they override the fallback indexes above.
  BARCODE_HEADERS: ['barcode', 'bar code', 'sku', 'product code'],
  BACKSTOCK_HEADERS: ['backstock', 'back stock', 'backstock qty', 'back stock qty'],
  SHELF_HEADERS: ['shelf stock', 'shelf', 'shelf qty', 'shop floor', 'floor stock'],

  USERNAME_HEADERS: ['username', 'user', 'staff', 'staff name', 'name'],
  PIN_HEADERS: ['pin', 'password'],
  PIN_HASH_HEADERS: ['pin hash', 'password hash'],
  ACTIVE_HEADERS: ['active', 'enabled', 'status'],
  ROLE_HEADERS: ['role'],

  SESSION_HOURS: 12,
  SESSION_CACHE_SECONDS: 1800,
  SCAN_UPDATE_MODE: 'increment', // increment, setQuantity, setTimestamp
  ALLOW_LEGACY_UNAUTHENTICATED_SCANS: false,
  MIN_BARCODE_LENGTH: 4,
  MAX_BARCODE_LENGTH: 48
};

function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = params.action || (params.barcode || params.sku ? 'scan' : 'ping');
  const payload = Object.assign({}, params, { action: action, method: 'GET' });
  const result = routeRequest(payload);
  if (params.callback) return javascriptResponse(params.callback, result);
  return jsonResponse(result);
}

function doPost(e) {
  return handleRequest(parsePayload(e));
}

function doOptions() {
  return jsonResponse({ ok: true });
}

function handleRequest(payload) {
  return jsonResponse(routeRequest(payload));
}

function routeRequest(payload) {
  try {
    const action = String(payload.action || '').trim();
    if (action === 'ping') return { ok: true, message: 'Stock Scanner backend is running.' };
    if (action === 'login') return login(payload);
    if (action === 'validateSession') return validateSession(payload);
    if (action === 'scan') return recordScan(payload);
    if (action === 'getAllProducts') return getAllProducts();
    if (action === 'searchProducts') return searchProducts(payload.query || '');
    if (action === 'scanBarcode') return scanBarcodeLegacy(payload);
    if (action === 'updateByRow') return updateByRowLegacy(payload);
    return { ok: false, error: 'Unknown action.' };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function parsePayload(e) {
  const raw = e && e.postData && e.postData.contents;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    return {};
  }
}

function getSpreadsheet() {
  if (CONFIG.SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  return SpreadsheetApp.getActive();
}

function getStockSheet() {
  const sheet = getSpreadsheet().getSheetByName(CONFIG.STOCK_SHEET);
  if (!sheet) throw new Error('Stock sheet not found: ' + CONFIG.STOCK_SHEET);
  return sheet;
}

function login(payload) {
  const username = clean(payload.username);
  const pin = String(payload.pin || '');
  if (!username) throw new Error('Enter a staff name.');

  const user = findUser(username);
  if (!user) throw new Error('User not found.');
  if (!isUserActive(user)) throw new Error('User is not active.');
  if (!pinMatches(user, pin)) throw new Error('PIN or password is incorrect.');

  const session = createSession(user);
  return {
    ok: true,
    message: 'Logged in.',
    session: session
  };
}

function validateSession(payload) {
  const session = getValidSession(clean(payload.token), clean(payload.username));
  return {
    ok: true,
    message: 'Session valid.',
    session: {
      token: session.token,
      username: session.username,
      displayName: session.displayName,
      role: session.role,
      expiresAt: session.expiresAt
    }
  };
}

function recordScan(payload) {
  const barcode = cleanBarcode(payload.barcode || payload.sku);
  const target = clean(payload.target || payload.mode || 'backstock').toLowerCase();
  const quantity = Math.max(1, Math.floor(Number(payload.quantity || 1)));

  validateBarcode(barcode);
  if (target !== 'backstock' && target !== 'shelf') throw new Error('Invalid scan target.');

  const session = authorizeScan(payload);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getStockSheet();
    const columns = getStockColumns(sheet);
    const row = findProductRow(sheet, columns, barcode);
    if (!row) {
      logScan(session, barcode, target, quantity, false, 'Barcode not found');
      throw new Error('Barcode not found.');
    }

    const update = performStockUpdate(sheet, row, target, quantity, columns);
    const product = getProductFromRow(sheet, row);

    const message = (target === 'backstock' ? 'Backstock' : 'Shelf stock') + ' updated.';
    logScan(session, barcode, target, quantity, true, message);
    return {
      ok: true,
      success: true,
      message: message,
      barcode: barcode,
      target: target,
      quantity: quantity,
      row: row,
      product: product,
      update: update
    };
  } finally {
    lock.releaseLock();
  }
}

function authorizeScan(payload) {
  const token = clean(payload.token);
  const username = clean(payload.username);
  if (token) return getValidSession(token, username);

  if (CONFIG.ALLOW_LEGACY_UNAUTHENTICATED_SCANS && username) {
    const user = findUser(username);
    if (user && isUserActive(user)) return { username: user.username, displayName: user.displayName, role: user.role };
  }

  throw new Error('Please log in again.');
}

function findUser(username) {
  const sheet = getSpreadsheet().getSheetByName(CONFIG.USERS_SHEET);
  if (!sheet) throw new Error('Users sheet not found: ' + CONFIG.USERS_SHEET);

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;

  const headers = normalizeHeaders(data[0]);
  const usernameCol = findHeader(headers, CONFIG.USERNAME_HEADERS, 1) - 1;
  const pinCol = findHeader(headers, CONFIG.PIN_HEADERS, 2) - 1;
  const pinHashCol = findHeader(headers, CONFIG.PIN_HASH_HEADERS, 0) - 1;
  const activeCol = findHeader(headers, CONFIG.ACTIVE_HEADERS, 0) - 1;
  const roleCol = findHeader(headers, CONFIG.ROLE_HEADERS, 0) - 1;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (clean(row[usernameCol]).toLowerCase() === username.toLowerCase()) {
      return {
        username: clean(row[usernameCol]),
        displayName: clean(row[usernameCol]),
        pin: pinCol >= 0 ? String(row[pinCol] || '') : '',
        pinHash: pinHashCol >= 0 ? String(row[pinHashCol] || '') : '',
        active: activeCol >= 0 ? row[activeCol] : true,
        role: roleCol >= 0 ? clean(row[roleCol]) : ''
      };
    }
  }
  return null;
}

function isUserActive(user) {
  const value = String(user.active).trim().toLowerCase();
  return value === '' || value === 'true' || value === 'yes' || value === 'y' || value === 'active' || value === '1';
}

function pinMatches(user, pin) {
  if (!user.pin && !user.pinHash) return true;
  if (user.pinHash) return sha256(pin) === user.pinHash.toLowerCase();
  return String(user.pin) === pin;
}

function createSession(user) {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const expiresAtDate = new Date(Date.now() + CONFIG.SESSION_HOURS * 60 * 60 * 1000);
  const expiresAt = expiresAtDate.toISOString();
  const sheet = getOrCreateSheet(CONFIG.SESSIONS_SHEET, ['Token', 'Username', 'Display Name', 'Role', 'Expires At', 'Created At']);
  sheet.appendRow([token, user.username, user.displayName, user.role, expiresAtDate, new Date()]);
  const session = {
    token: token,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    expiresAt: expiresAt
  };
  cacheSession(session);
  return session;
}

function getValidSession(token, username) {
  if (!token) throw new Error('Missing session token.');
  const cached = getCachedSession(token);
  if (cached) {
    if (Date.now() > Date.parse(cached.expiresAt)) throw new Error('Session expired. Please log in again.');
    if (username && cached.username.toLowerCase() !== username.toLowerCase()) throw new Error('Session user mismatch.');
    return cached;
  }

  const sheet = getSpreadsheet().getSheetByName(CONFIG.SESSIONS_SHEET);
  if (!sheet) throw new Error('Session expired. Please log in again.');

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === token) {
      const expiresAt = new Date(data[i][4]);
      if (Date.now() > expiresAt.getTime()) throw new Error('Session expired. Please log in again.');
      const storedUsername = clean(data[i][1]);
      if (username && storedUsername.toLowerCase() !== username.toLowerCase()) throw new Error('Session user mismatch.');
      const session = {
        token: token,
        username: storedUsername,
        displayName: clean(data[i][2]) || storedUsername,
        role: clean(data[i][3]),
        expiresAt: expiresAt.toISOString()
      };
      cacheSession(session);
      return session;
    }
  }
  throw new Error('Session expired. Please log in again.');
}

function getStockColumns(sheet) {
  const headers = normalizeHeaders(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
  return {
    barcode: findHeader(headers, CONFIG.BARCODE_HEADERS, CONFIG.BARCODE_COLUMN),
    sku: CONFIG.SKU_COLUMN,
    backstock: findHeader(headers, CONFIG.BACKSTOCK_HEADERS, CONFIG.BACKSTOCK_COLUMN),
    shelf: findHeader(headers, CONFIG.SHELF_HEADERS, CONFIG.SHELF_STOCK_COLUMN),
    totalQty: CONFIG.TOTAL_QTY_COLUMN,
    lastScan: CONFIG.LAST_SCAN_COLUMN
  };
}

function findBarcodeRow(sheet, barcodeColumn, barcode) {
  return findValueRow(sheet, barcodeColumn, barcode);
}

function findProductRow(sheet, columns, barcode) {
  return findValueRow(sheet, columns.barcode, barcode) || findValueRow(sheet, columns.sku, barcode);
}

function findValueRow(sheet, column, value) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const range = sheet.getRange(2, column, lastRow - 1, 1);
  const found = range
    .createTextFinder(String(value))
    .matchEntireCell(true)
    .matchCase(false)
    .findNext();
  return found ? found.getRow() : 0;
}

function performStockUpdate(sheet, row, target, quantity, columns) {
  const currentBackstock = Number(sheet.getRange(row, columns.backstock).getValue()) || 0;
  const currentShelf = Number(sheet.getRange(row, columns.shelf).getValue()) || 0;
  let nextBackstock = currentBackstock;
  let nextShelf = currentShelf;

  if (target === 'backstock') {
    nextBackstock = nextStockValue(currentBackstock, quantity);
  } else {
    nextShelf = nextStockValue(currentShelf, quantity);
  }

  sheet.getRange(row, columns.backstock).setValue(nextBackstock);
  sheet.getRange(row, columns.shelf).setValue(nextShelf);
  sheet.getRange(row, columns.totalQty).setValue(nextBackstock + nextShelf);
  sheet.getRange(row, columns.lastScan).setValue(new Date());
  SpreadsheetApp.flush();

  return {
    mode: target,
    qty: quantity,
    previousBackstock: currentBackstock,
    previousShelfStock: currentShelf,
    backstock: nextBackstock,
    shelfStock: nextShelf,
    totalQty: nextBackstock + nextShelf
  };
}

function nextStockValue(currentValue, quantity) {
  if (CONFIG.SCAN_UPDATE_MODE === 'setQuantity') return quantity;
  const currentNumber = Number(currentValue || 0);
  return (isNaN(currentNumber) ? 0 : currentNumber) + quantity;
}

function getProductFromRow(sheet, row) {
  const data = sheet.getRange(row, 1, 1, Math.max(sheet.getLastColumn(), CONFIG.LAST_SCAN_COLUMN)).getValues()[0];
  return {
    row: row,
    barcode: clean(data[CONFIG.BARCODE_COLUMN - 1]),
    sku: clean(data[CONFIG.SKU_COLUMN - 1]),
    category: clean(data[CONFIG.CATEGORY_COLUMN - 1]),
    brand: clean(data[CONFIG.BRAND_COLUMN - 1]),
    productType: clean(data[CONFIG.PRODUCT_TYPE_COLUMN - 1]),
    flavour: clean(data[CONFIG.FLAVOUR_COLUMN - 1]),
    backstock: Number(data[CONFIG.BACKSTOCK_COLUMN - 1]) || 0,
    shelfStock: Number(data[CONFIG.SHELF_STOCK_COLUMN - 1]) || 0,
    totalQty: Number(data[CONFIG.TOTAL_QTY_COLUMN - 1]) || 0,
    lastScan: dateToIso(data[CONFIG.LAST_SCAN_COLUMN - 1])
  };
}

function getAllProducts() {
  const sheet = getStockSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, success: true, products: [], count: 0 };

  const rows = sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), CONFIG.LAST_SCAN_COLUMN)).getValues();
  const products = rows
    .map(function (_, index) {
      return getProductFromValues(rows[index], index + 2);
    })
    .filter(function (product) {
      return product.barcode || product.sku || product.productType;
    });

  return { ok: true, success: true, products: products, count: products.length };
}

function getProductFromValues(data, row) {
  return {
    row: row,
    barcode: clean(data[CONFIG.BARCODE_COLUMN - 1]),
    sku: clean(data[CONFIG.SKU_COLUMN - 1]),
    category: clean(data[CONFIG.CATEGORY_COLUMN - 1]),
    brand: clean(data[CONFIG.BRAND_COLUMN - 1]),
    productType: clean(data[CONFIG.PRODUCT_TYPE_COLUMN - 1]),
    flavour: clean(data[CONFIG.FLAVOUR_COLUMN - 1]),
    backstock: Number(data[CONFIG.BACKSTOCK_COLUMN - 1]) || 0,
    shelfStock: Number(data[CONFIG.SHELF_STOCK_COLUMN - 1]) || 0,
    totalQty: Number(data[CONFIG.TOTAL_QTY_COLUMN - 1]) || 0,
    lastScan: dateToIso(data[CONFIG.LAST_SCAN_COLUMN - 1])
  };
}

function searchProducts(query) {
  const q = clean(query);
  if (!q) return { ok: true, success: true, products: [], count: 0 };

  const all = getAllProducts();
  const scored = all.products
    .map(function (product) {
      return { product: product, score: flavourMatchScore(product.flavour, q) };
    })
    .filter(function (entry) {
      return entry.score < 999;
    })
    .sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      return a.product.flavour.localeCompare(b.product.flavour);
    })
    .slice(0, 20);
  const products = scored.map(function (entry) {
    return entry.product;
  });

  return { ok: true, success: true, products: products, count: products.length };
}

function flavourMatchScore(flavour, query) {
  const value = clean(flavour);
  const directValue = value.toLowerCase();
  const directQuery = clean(query).toLowerCase();
  const compactValue = normalizeSearchText(value);
  const compactQuery = normalizeSearchText(query);
  if (!compactValue || !compactQuery) return 999;
  if (directValue === directQuery) return 0;
  if (directValue.indexOf(directQuery) === 0) return 1;
  if (compactValue.indexOf(compactQuery) === 0) return 2;
  if (directValue.indexOf(directQuery) >= 0) return 3;
  if (compactValue.indexOf(compactQuery) >= 0) return 4;

  const tokens = compactQuery.split(' ').filter(Boolean);
  if (tokens.length && tokens.every(function (token) { return compactValue.indexOf(token) >= 0; })) return 5;
  if (isLooseSubsequence(compactValue.replace(/\s+/g, ''), compactQuery.replace(/\s+/g, ''))) return 8;
  return 999;
}

function normalizeSearchText(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isLooseSubsequence(value, query) {
  if (query.length < 2) return false;
  let index = 0;
  for (let i = 0; i < value.length && index < query.length; i++) {
    if (value[i] === query[index]) index++;
  }
  return index === query.length;
}

function scanBarcodeLegacy(payload) {
  return recordScan({
    barcode: payload.barcode,
    target: payload.mode || 'shelf',
    quantity: payload.qty || 1,
    token: payload.token,
    username: payload.username
  });
}

function updateByRowLegacy(payload) {
  const target = clean(payload.mode || payload.target || 'shelf').toLowerCase();
  const quantity = Math.max(1, Number(payload.qty || payload.quantity || 1));
  const row = Number(payload.row || 0);
  const session = authorizeScan(payload);

  if (!row || row < 2) throw new Error('Invalid row number.');
  if (target !== 'backstock' && target !== 'shelf') throw new Error('Invalid scan target.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getStockSheet();
    const columns = getStockColumns(sheet);
    const update = performStockUpdate(sheet, row, target, quantity, columns);
    const product = getProductFromRow(sheet, row);
    const message = (target === 'backstock' ? 'Backstock' : 'Shelf stock') + ' updated.';
    logScan(session, product.barcode, target, quantity, true, message);
    return { ok: true, success: true, message: message, product: product, update: update };
  } finally {
    lock.releaseLock();
  }
}

function logScan(session, barcode, target, quantity, ok, message) {
  const sheet = getOrCreateSheet(CONFIG.LOG_SHEET, ['Timestamp', 'Username', 'Barcode', 'Target', 'Quantity', 'OK', 'Message']);
  sheet.appendRow([new Date(), session.displayName || session.username || '', barcode, target, quantity, ok, message]);
}

function getOrCreateSheet(name, headers) {
  const spreadsheet = getSpreadsheet();
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

function normalizeHeaders(row) {
  return row.map(function (value) {
    return clean(value).toLowerCase();
  });
}

function findHeader(headers, candidates, fallback) {
  for (let i = 0; i < candidates.length; i++) {
    const index = headers.indexOf(candidates[i]);
    if (index >= 0) return index + 1;
  }
  if (typeof fallback === 'number') return fallback;
  return fallback;
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function dateToIso(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? '' : date.toISOString();
}

function cleanBarcode(value) {
  return clean(value).replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function validateBarcode(barcode) {
  if (!barcode) throw new Error('Barcode not supplied.');
  if (barcode.length < CONFIG.MIN_BARCODE_LENGTH) throw new Error('Barcode is too short.');
  if (barcode.length > CONFIG.MAX_BARCODE_LENGTH) throw new Error('Barcode is too long.');
  if (!/^[A-Za-z0-9._-]+$/.test(barcode)) throw new Error('Barcode contains unsupported characters.');
}

function cacheSession(session) {
  CacheService.getScriptCache().put('session:' + session.token, JSON.stringify(session), CONFIG.SESSION_CACHE_SECONDS);
}

function getCachedSession(token) {
  const raw = CacheService.getScriptCache().get('session:' + token);
  return raw ? JSON.parse(raw) : null;
}

function sha256(value) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  return digest
    .map(function (byte) {
      const value = byte < 0 ? byte + 256 : byte;
      return ('0' + value.toString(16)).slice(-2);
    })
    .join('');
}

function jsonResponse(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function javascriptResponse(callback, payload) {
  const safeCallback = String(callback || '').replace(/[^\w.$]/g, '');
  if (!safeCallback) return jsonResponse({ ok: false, error: 'Invalid callback.' });
  return ContentService
    .createTextOutput(safeCallback + '(' + JSON.stringify(payload) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}
