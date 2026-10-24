const CONFIG = {
  SPREADSHEET_ID: '1bwoE6i7RW3Ruotf5QXCePL20lJeczgaQU9CvXjc3aRc',
  USERS_SHEET: 'Users',
  STOCK_SHEET: 'MASTER_DB',
  SESSIONS_SHEET: 'Sessions',
  LOG_SHEET: 'Scan Log',

  BARCODE_COLUMN: 1,
  SKU_COLUMN: 2,
  COG_COLUMN: 3,
  BRAND_COLUMN: 4,
  PRODUCT_TYPE_COLUMN: 5,
  FLAVOUR_COLUMN: 5,
  BACKSTOCK_COLUMN: 6,
  SHELF_STOCK_COLUMN: 7,
  TOTAL_QTY_COLUMN: 8,
  LAST_USER_COLUMN: 9,
  LAST_SCAN_COLUMN: 10,
  CATEGORY_COLUMN: 13,

  // If matching headers exist in row 1, they override the fallback indexes above.
  BARCODE_HEADERS: ['barcode', 'bar code', 'sku', 'product code'],
  BACKSTOCK_HEADERS: ['backstock', 'back stock', 'backstock qty', 'back stock qty'],
  SHELF_HEADERS: ['shelf stock', 'shelf', 'shelf qty', 'shop floor', 'floor stock'],
  TOTAL_QTY_HEADERS: ['total qty', 'total quantity', 'total stock', 'qty', 'quantity'],

  USERNAME_HEADERS: ['username', 'user', 'staff', 'staff name', 'name'],
  PIN_HEADERS: ['pin', 'password'],
  PIN_HASH_HEADERS: ['pin hash', 'password hash'],
  ACTIVE_HEADERS: ['active', 'enabled', 'status'],
  ROLE_HEADERS: ['role'],

  SESSION_HOURS: 12,
  SESSION_CACHE_SECONDS: 1800,
  PRODUCT_CONFIRMATION_SECONDS: 600,
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
    if (action === 'previewProductAddition') return previewProductAddition(payload);
    if (action === 'addProduct') return addProduct(payload);
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
  const quantity = parseQuantity(payload.quantity);

  validateBarcode(barcode);
  if (target !== 'backstock' && target !== 'shelf') throw new Error('Invalid scan target.');

  const session = authorizeScan(payload);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const sheet = getStockSheet();
    const columns = getStockColumns(sheet);
    const row = findProductRow(sheet, columns, barcode);
    if (!row) {
      logScan(session, barcode, target, quantity, false, 'Barcode not found');
      throw new Error('Barcode not found.');
    }

    const rowValues = getProductRowValues(sheet, row);
    const update = performStockUpdate(sheet, row, target, quantity, columns, session, rowValues);
    const product = getProductFromValues(update.rowValues, row);
    delete update.rowValues;

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
    SpreadsheetApp.flush();
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
    totalQty: findHeader(headers, CONFIG.TOTAL_QTY_HEADERS, CONFIG.TOTAL_QTY_COLUMN),
    lastUser: CONFIG.LAST_USER_COLUMN,
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

function performStockUpdate(sheet, row, target, quantity, columns, session, rowValues) {
  const values = rowValues || getProductRowValues(sheet, row);
  const currentBackstock = Number(values[columns.backstock - 1]) || 0;
  const currentShelf = Number(values[columns.shelf - 1]) || 0;
  const lastUser = session.displayName || session.username || '';
  const lastScan = new Date();
  let nextBackstock = currentBackstock;
  let nextShelf = currentShelf;

  if (target === 'backstock') {
    nextBackstock = nextStockValue(currentBackstock, quantity);
  } else {
    nextShelf = nextStockValue(currentShelf, quantity);
  }
  const nextTotalQty = nextBackstock + nextShelf;

  values[columns.backstock - 1] = nextBackstock;
  values[columns.shelf - 1] = nextShelf;
  values[columns.totalQty - 1] = nextTotalQty;
  values[columns.lastUser - 1] = lastUser;
  values[columns.lastScan - 1] = lastScan;

  writeStockUpdate(sheet, row, columns, values);

  return {
    mode: target,
    qty: quantity,
    previousBackstock: currentBackstock,
    previousShelfStock: currentShelf,
    backstock: nextBackstock,
    shelfStock: nextShelf,
    totalQty: nextTotalQty,
    lastUser: lastUser,
    rowValues: values
  };
}

function writeStockUpdate(sheet, row, columns, values) {
  if (
    columns.shelf === columns.backstock + 1 &&
    columns.totalQty === columns.backstock + 2 &&
    columns.lastUser === columns.backstock + 3 &&
    columns.lastScan === columns.backstock + 4
  ) {
    sheet
      .getRange(row, columns.backstock, 1, 5)
      .setValues([values.slice(columns.backstock - 1, columns.lastScan)]);
    return;
  }

  sheet.getRange(row, columns.backstock).setValue(values[columns.backstock - 1]);
  sheet.getRange(row, columns.shelf).setValue(values[columns.shelf - 1]);
  sheet.getRange(row, columns.totalQty).setValue(values[columns.totalQty - 1]);
  sheet.getRange(row, columns.lastUser).setValue(values[columns.lastUser - 1]);
  sheet.getRange(row, columns.lastScan).setValue(values[columns.lastScan - 1]);
}

function nextStockValue(currentValue, quantity) {
  if (CONFIG.SCAN_UPDATE_MODE === 'setQuantity') return quantity;
  const currentNumber = Number(currentValue || 0);
  return (isNaN(currentNumber) ? 0 : currentNumber) + quantity;
}

function getProductFromRow(sheet, row) {
  const data = getProductRowValues(sheet, row);
  const backstock = Number(data[CONFIG.BACKSTOCK_COLUMN - 1]) || 0;
  const shelfStock = Number(data[CONFIG.SHELF_STOCK_COLUMN - 1]) || 0;
  const totalQty = Number(data[CONFIG.TOTAL_QTY_COLUMN - 1]) || 0;
  return {
    row: row,
    barcode: clean(data[CONFIG.BARCODE_COLUMN - 1]),
    sku: clean(data[CONFIG.SKU_COLUMN - 1]),
    cost: Number(data[CONFIG.COG_COLUMN - 1]) || 0,
    category: clean(data[CONFIG.CATEGORY_COLUMN - 1]),
    brand: clean(data[CONFIG.BRAND_COLUMN - 1]),
    productType: clean(data[CONFIG.PRODUCT_TYPE_COLUMN - 1]),
    flavour: clean(data[CONFIG.FLAVOUR_COLUMN - 1]),
    backstock: backstock,
    shelfStock: shelfStock,
    totalQty: totalQty,
    lastUser: clean(data[CONFIG.LAST_USER_COLUMN - 1]),
    lastScan: dateToIso(data[CONFIG.LAST_SCAN_COLUMN - 1])
  };
}

function getProductRowValues(sheet, row) {
  return sheet.getRange(row, 1, 1, Math.max(sheet.getLastColumn(), CONFIG.LAST_SCAN_COLUMN)).getValues()[0];
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
  const backstock = Number(data[CONFIG.BACKSTOCK_COLUMN - 1]) || 0;
  const shelfStock = Number(data[CONFIG.SHELF_STOCK_COLUMN - 1]) || 0;
  const totalQty = Number(data[CONFIG.TOTAL_QTY_COLUMN - 1]) || 0;
  return {
    row: row,
    barcode: clean(data[CONFIG.BARCODE_COLUMN - 1]),
    sku: clean(data[CONFIG.SKU_COLUMN - 1]),
    cost: Number(data[CONFIG.COG_COLUMN - 1]) || 0,
    category: clean(data[CONFIG.CATEGORY_COLUMN - 1]),
    brand: clean(data[CONFIG.BRAND_COLUMN - 1]),
    productType: clean(data[CONFIG.PRODUCT_TYPE_COLUMN - 1]),
    flavour: clean(data[CONFIG.FLAVOUR_COLUMN - 1]),
    backstock: backstock,
    shelfStock: shelfStock,
    totalQty: totalQty,
    lastUser: clean(data[CONFIG.LAST_USER_COLUMN - 1]),
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

function previewProductAddition(payload) {
  const session = authorizeScan(payload);
  const input = validateNewProductInput(payload);
  const sheet = getStockSheet();
  assertNewProductIsUnique(sheet, input);

  const sections = buildProductSections(sheet);
  const match = findBestProductSection(input.productName, sections);
  const confirmationToken = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const confirmation = {
    username: session.username,
    productName: input.productName,
    barcode: input.barcode,
    sku: input.sku,
    matchMode: match ? 'existing' : 'new',
    sectionFingerprint: match ? match.fingerprint : ''
  };
  CacheService.getScriptCache().put(
    'product-confirmation:' + confirmationToken,
    JSON.stringify(confirmation),
    CONFIG.PRODUCT_CONFIRMATION_SECONDS
  );

  return {
    ok: true,
    success: true,
    confirmationToken: confirmationToken,
    expiresInSeconds: CONFIG.PRODUCT_CONFIRMATION_SECONDS,
    product: input,
    match: match ? publicSectionMatch(match) : null,
    requiresNewSectionConfirmation: !match
  };
}

function addProduct(payload) {
  const session = authorizeScan(payload);
  const input = validateNewProductInput(payload);
  const confirmationToken = clean(payload.confirmationToken);
  if (!confirmationToken) throw new Error('Review the product before adding it.');

  const cache = CacheService.getScriptCache();
  const cacheKey = 'product-confirmation:' + confirmationToken;
  const rawConfirmation = cache.get(cacheKey);
  if (!rawConfirmation) throw new Error('This product review expired. Review the details again.');

  const confirmation = JSON.parse(rawConfirmation);
  if (
    clean(confirmation.username).toLowerCase() !== clean(session.username).toLowerCase() ||
    confirmation.productName !== input.productName ||
    confirmation.barcode !== input.barcode ||
    confirmation.sku !== input.sku
  ) {
    throw new Error('Product details changed after review. Review them again before adding.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getStockSheet();
    assertNewProductIsUnique(sheet, input);
    const match = findBestProductSection(input.productName, buildProductSections(sheet));
    const currentMode = match ? 'existing' : 'new';
    if (currentMode !== confirmation.matchMode) {
      throw new Error('The matching section changed. Review the product again before adding.');
    }
    if (match && confirmation.sectionFingerprint !== match.fingerprint) {
      throw new Error('The matching section changed. Review the product again before adding.');
    }
    if (!match && !isTrue(payload.confirmNewSection)) {
      throw new Error('Confirm that this product should create a new section.');
    }

    const result = match
      ? insertProductIntoSection(sheet, input, match, session)
      : insertProductInNewSection(sheet, input, session);
    cache.remove(cacheKey);
    SpreadsheetApp.flush();
    logProductAddition(session, result.product, result.mode, result.sectionLabel, result.row);
    return {
      ok: true,
      success: true,
      message: result.mode === 'existing'
        ? 'Product added to ' + result.sectionLabel + '.'
        : 'New section created and product added.',
      product: result.product,
      row: result.row,
      mode: result.mode,
      sectionLabel: result.sectionLabel
    };
  } finally {
    lock.releaseLock();
  }
}

function validateNewProductInput(payload) {
  const productName = clean(payload.productName).replace(/\s+/g, ' ');
  const barcode = cleanBarcode(payload.barcode);
  const sku = clean(payload.sku).replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (!productName) throw new Error('Enter a product name.');
  if (productName.length < 3) throw new Error('Product name is too short.');
  if (productName.length > 160) throw new Error('Product name is too long.');
  validateBarcode(barcode);
  if (sku.length > 80) throw new Error('SKU is too long.');
  if (sku && !/^[A-Za-z0-9._\-/]+$/.test(sku)) throw new Error('SKU contains unsupported characters.');
  return { productName: productName, barcode: barcode, sku: sku };
}

function assertNewProductIsUnique(sheet, input) {
  if (findValueRow(sheet, CONFIG.BARCODE_COLUMN, input.barcode)) {
    throw new Error('That barcode already exists in MASTER_DB.');
  }
  if (input.sku && findValueRow(sheet, CONFIG.SKU_COLUMN, input.sku)) {
    throw new Error('That SKU already exists in MASTER_DB.');
  }

  const lastDataRow = findLastProductDataRow(sheet);
  if (lastDataRow < 2) return;
  const names = sheet.getRange(2, CONFIG.PRODUCT_TYPE_COLUMN, lastDataRow - 1, 1).getDisplayValues();
  const normalizedName = normalizeProductTitle(input.productName);
  for (let i = 0; i < names.length; i++) {
    if (normalizeProductTitle(names[i][0]) === normalizedName) {
      throw new Error('That product name already exists in MASTER_DB.');
    }
  }
}

function buildProductSections(sheet) {
  const lastDataRow = findLastProductDataRow(sheet);
  if (lastDataRow < 2) return [];
  const width = Math.max(CONFIG.CATEGORY_COLUMN, CONFIG.PRODUCT_TYPE_COLUMN);
  const rows = sheet.getRange(2, 1, lastDataRow - 1, width).getDisplayValues();
  const sections = [];
  let current = null;

  rows.forEach(function (values, index) {
    const row = index + 2;
    const name = clean(values[CONFIG.PRODUCT_TYPE_COLUMN - 1]);
    if (name === '__SEPARATOR__') {
      if (current && current.products.length) sections.push(finalizeProductSection(current));
      current = null;
      return;
    }
    if (!name) return;
    if (!current) current = { startRow: row, endRow: row, products: [] };
    current.endRow = row;
    current.products.push({
      row: row,
      barcode: clean(values[CONFIG.BARCODE_COLUMN - 1]),
      sku: clean(values[CONFIG.SKU_COLUMN - 1]),
      cost: values[CONFIG.COG_COLUMN - 1],
      brand: clean(values[CONFIG.BRAND_COLUMN - 1]),
      name: name,
      category: clean(values[12])
    });
  });
  if (current && current.products.length) sections.push(finalizeProductSection(current));
  return sections;
}

function finalizeProductSection(section) {
  const representative = section.products[0];
  const fingerprint = normalizeProductTitle(representative.name) + '|' + normalizeProductTitle(section.products[section.products.length - 1].name);
  return Object.assign(section, {
    representative: representative,
    label: deriveSectionLabel(section.products),
    fingerprint: fingerprint
  });
}

function findBestProductSection(productName, sections) {
  const target = productTitleParts(productName);
  let best = null;

  sections.forEach(function (section) {
    let sectionBest = null;
    section.products.forEach(function (product) {
      const score = productTitleSimilarity(target, productTitleParts(product.name));
      if (!sectionBest || score.total > sectionBest.score.total) {
        sectionBest = { product: product, score: score };
      }
    });
    if (!sectionBest) return;
    const candidate = Object.assign({}, section, {
      exemplar: sectionBest.product,
      matchScore: sectionBest.score.total,
      sharedPrefixTokens: sectionBest.score.sharedPrefixTokens,
      sharedType: sectionBest.score.sharedType
    });
    if (!best || candidate.matchScore > best.matchScore) best = candidate;
  });

  if (!best) return null;
  return best.sharedPrefixTokens >= 2 ? best : null;
}

function productTitleParts(value) {
  const normalized = normalizeProductTitle(value);
  const tokens = normalized ? normalized.split(' ') : [];
  const typeTokens = ['kit', 'kits', 'pod', 'pods', 'liquid', 'liquids', 'pouch', 'pouches', 'device', 'devices', 'coil', 'coils'];
  const type = tokens.slice().reverse().find(function (token) { return typeTokens.indexOf(token) >= 0; }) || '';
  return { normalized: normalized, tokens: tokens, type: type };
}

function productTitleSimilarity(target, candidate) {
  let sharedPrefixTokens = 0;
  const prefixLength = Math.min(target.tokens.length, candidate.tokens.length);
  while (sharedPrefixTokens < prefixLength && target.tokens[sharedPrefixTokens] === candidate.tokens[sharedPrefixTokens]) {
    sharedPrefixTokens++;
  }
  const candidateSet = {};
  candidate.tokens.forEach(function (token) { candidateSet[token] = true; });
  const sharedTokens = target.tokens.filter(function (token) { return candidateSet[token]; }).length;
  const sharedType = !!target.type && target.type === candidate.type;
  let total = sharedPrefixTokens * 12 + sharedTokens * 2 + (sharedType ? 10 : 0);
  if (target.normalized === candidate.normalized) total += 100;
  return { total: total, sharedPrefixTokens: sharedPrefixTokens, sharedType: sharedType };
}

function deriveSectionLabel(products) {
  if (!products.length) return 'matched section';
  const tokenLists = products.map(function (product) { return productTitleParts(product.name).tokens; });
  const common = [];
  const shortest = Math.min.apply(null, tokenLists.map(function (tokens) { return tokens.length; }));
  for (let i = 0; i < shortest; i++) {
    const token = tokenLists[0][i];
    if (tokenLists.every(function (tokens) { return tokens[i] === token; })) common.push(token);
    else break;
  }
  const commonType = tokenLists.map(function (tokens) { return productTitleParts(tokens.join(' ')).type; })
    .filter(Boolean)
    .filter(function (type, index, all) { return all.indexOf(type) === index; });
  const labelTokens = common.slice();
  if (commonType.length === 1 && labelTokens.indexOf(commonType[0]) < 0) labelTokens.push(commonType[0]);
  if (!labelTokens.length) return products[0].brand || 'matched section';
  return labelTokens.map(titleCaseToken).join(' ');
}

function titleCaseToken(token) {
  return token.length <= 4 && /\d/.test(token)
    ? token.toUpperCase()
    : token.charAt(0).toUpperCase() + token.slice(1);
}

function normalizeProductTitle(value) {
  return clean(value).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function publicSectionMatch(match) {
  return {
    label: match.label,
    exemplarName: match.exemplar.name,
    inheritedBrand: match.exemplar.brand,
    inheritedCost: match.exemplar.cost,
    inheritedCategory: match.exemplar.category,
    insertAfterRow: match.endRow
  };
}

function insertProductIntoSection(sheet, input, match, session) {
  const row = match.endRow + 1;
  sheet.insertRowsAfter(match.endRow, 1);
  copyProductRowStructure(sheet, match.exemplar.row, row);
  writeNewProductValues(sheet, row, input, match.exemplar, session);
  return {
    row: row,
    mode: 'existing',
    sectionLabel: match.label,
    product: getProductFromRow(sheet, row)
  };
}

function insertProductInNewSection(sheet, input, session) {
  const lastDataRow = findLastProductDataRow(sheet);
  const separatorRow = Math.max(lastDataRow, 1) + 1;
  const productRow = separatorRow + 1;
  sheet.insertRowsAfter(Math.max(lastDataRow, 1), 2);

  const lastProductRow = findPreviousProductRow(sheet, separatorRow - 1);
  if (lastProductRow) copyProductRowStructure(sheet, lastProductRow, productRow);
  sheet.getRange(separatorRow, 1, 1, Math.max(sheet.getLastColumn(), 18))
    .setBackground('#000000')
    .setFontColor('#ffffff')
    .setFontWeight('bold');
  sheet.getRange(separatorRow, CONFIG.PRODUCT_TYPE_COLUMN).setValue('__SEPARATOR__');

  const blankExemplar = { cost: '', brand: '', category: 'Uncategorised' };
  writeNewProductValues(sheet, productRow, input, blankExemplar, session);
  return {
    row: productRow,
    mode: 'new',
    sectionLabel: 'New section',
    product: getProductFromRow(sheet, productRow)
  };
}

function copyProductRowStructure(sheet, sourceRow, targetRow) {
  if (!sourceRow || sourceRow === targetRow) return;
  const width = Math.max(sheet.getLastColumn(), 18);
  const source = sheet.getRange(sourceRow, 1, 1, width);
  const target = sheet.getRange(targetRow, 1, 1, width);
  source.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  source.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
}

function writeNewProductValues(sheet, row, input, exemplar, session) {
  const now = new Date();
  const values = [[
    input.barcode,
    input.sku,
    parseCost(exemplar.cost),
    exemplar.brand || '',
    input.productName,
    0,
    0,
    0,
    session.displayName || session.username || '',
    now
  ]];
  sheet.getRange(row, 1, 1, 10).setValues(values);
  sheet.getRange(row, CONFIG.BARCODE_COLUMN, 1, 2).setNumberFormat('@');
  sheet.getRange(row, 13).setValue(exemplar.category || 'Uncategorised');
}

function parseCost(value) {
  if (typeof value === 'number') return value;
  const numeric = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return isFinite(numeric) ? numeric : '';
}

function findLastProductDataRow(sheet) {
  const maxRows = sheet.getMaxRows();
  if (maxRows < 2) return 1;
  const values = sheet.getRange(2, CONFIG.PRODUCT_TYPE_COLUMN, maxRows - 1, 1).getDisplayValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (clean(values[i][0])) return i + 2;
  }
  return 1;
}

function findPreviousProductRow(sheet, fromRow) {
  if (fromRow < 2) return 0;
  const values = sheet.getRange(2, CONFIG.PRODUCT_TYPE_COLUMN, fromRow - 1, 1).getDisplayValues();
  for (let i = values.length - 1; i >= 0; i--) {
    const name = clean(values[i][0]);
    if (name && name !== '__SEPARATOR__') return i + 2;
  }
  return 0;
}

function logProductAddition(session, product, mode, sectionLabel, row) {
  const sheet = getOrCreateSheet('Product Add Log', [
    'Timestamp', 'Username', 'Barcode', 'SKU', 'Product Name', 'Mode', 'Section', 'MASTER_DB Row'
  ]);
  sheet.appendRow([
    new Date(),
    session.displayName || session.username || '',
    product.barcode,
    product.sku,
    product.productType,
    mode,
    sectionLabel,
    row
  ]);
  if (!sheet.isSheetHidden()) sheet.hideSheet();
}

function isTrue(value) {
  return ['true', '1', 'yes', 'y'].indexOf(clean(value).toLowerCase()) >= 0;
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
    quantity: payload.qty,
    token: payload.token,
    username: payload.username
  });
}

function updateByRowLegacy(payload) {
  const target = clean(payload.mode || payload.target || 'shelf').toLowerCase();
  const quantity = parseQuantity(payload.qty || payload.quantity);
  const row = Number(payload.row || 0);
  const session = authorizeScan(payload);

  if (!row || row < 2) throw new Error('Invalid row number.');
  if (target !== 'backstock' && target !== 'shelf') throw new Error('Invalid scan target.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getStockSheet();
    const columns = getStockColumns(sheet);
    const rowValues = getProductRowValues(sheet, row);
    const update = performStockUpdate(sheet, row, target, quantity, columns, session, rowValues);
    const product = getProductFromValues(update.rowValues, row);
    delete update.rowValues;
    const message = (target === 'backstock' ? 'Backstock' : 'Shelf stock') + ' updated.';
    logScan(session, product.barcode, target, quantity, true, message);
    return { ok: true, success: true, message: message, product: product, update: update };
  } finally {
    SpreadsheetApp.flush();
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

function parseQuantity(value) {
  const rawValue = clean(value == null || value === '' ? 1 : value);
  if (!/^-?\d+$/.test(rawValue)) throw new Error('Quantity must be a whole number.');
  const quantity = Number(rawValue);
  if (!isFinite(quantity) || quantity === 0) throw new Error('Quantity cannot be 0.');
  return quantity;
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
