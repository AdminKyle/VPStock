function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isLooseSubsequence(value, query) {
  if (query.length < 3) return false;
  let queryIndex = 0;
  for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex += 1) {
    if (value[valueIndex] === query[queryIndex]) queryIndex += 1;
  }
  return queryIndex === query.length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keepFirstMatch(text, expression, keyForMatch = (match) => match.toLowerCase()) {
  const seen = new Set();
  return text.replace(expression, (match) => {
    const key = keyForMatch(match);
    if (seen.has(key)) return "";
    seen.add(key);
    return match;
  });
}

export function formatProductName(product = {}) {
  let name = String(product.flavour || product.productType || product.sku || "Unnamed product").trim();
  const brand = String(product.brand || "").trim();

  if (brand) {
    const brandPattern = escapeRegExp(brand).replace(/\s+/g, "\\s+");
    name = keepFirstMatch(name, new RegExp(`\\b${brandPattern}\\b`, "gi"));
  }

  name = keepFirstMatch(
    name,
    /\b\d+(?:\.\d+)?\s*mg\b/gi,
    (match) => match.toLowerCase().replace(/\s+/g, "")
  );

  return name
    .replace(/\s{2,}/g, " ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+([,;:)])/g, "$1")
    .trim();
}

export function prepareProducts(products = []) {
  return products.map((product) => {
    const displayName = formatProductName(product);
    const primary = normalizeSearchText(product.flavour || product.productType || displayName);
    const barcode = normalizeSearchText(product.barcode);
    const sku = normalizeSearchText(product.sku);
    const fields = [
      primary,
      normalizeSearchText(product.brand),
      sku,
      barcode,
      normalizeSearchText(product.category)
    ].filter(Boolean);

    return {
      ...product,
      displayName,
      _searchPrimary: primary,
      _searchBarcode: barcode,
      _searchSku: sku,
      _searchFields: fields,
      _searchText: fields.join(" ")
    };
  });
}

function matchScore(product, normalizedQuery) {
  if (product._searchBarcode === normalizedQuery || product._searchSku === normalizedQuery) return 0;
  if (product._searchPrimary === normalizedQuery) return 1;
  if (product._searchPrimary.startsWith(normalizedQuery)) return 2;
  if (product._searchFields.some((field) => field.startsWith(normalizedQuery))) return 3;
  if (product._searchPrimary.includes(normalizedQuery)) return 4;
  if (product._searchText.includes(normalizedQuery)) return 5;

  const tokens = normalizedQuery.split(" ").filter(Boolean);
  if (tokens.length && tokens.every((token) => product._searchText.includes(token))) return 6;

  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  const compactPrimary = product._searchPrimary.replace(/\s+/g, "");
  if (isLooseSubsequence(compactPrimary, compactQuery)) return 8;
  return Number.POSITIVE_INFINITY;
}

export function filterProducts(products, query, limit = 20) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  return products
    .map((product) => ({ product, score: matchScore(product, normalizedQuery) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score;
      const leftName = left.product.flavour || left.product.productType || left.product.sku || "";
      const rightName = right.product.flavour || right.product.productType || right.product.sku || "";
      return leftName.localeCompare(rightName);
    })
    .slice(0, limit)
    .map((entry) => entry.product);
}
