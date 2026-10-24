const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("apps-script/Code.gs", "utf8");
const context = vm.createContext({ console });
vm.runInContext(source, context);

function section(startRow, names, brand, cost, category) {
  const products = names.map((name, index) => ({
    row: startRow + index,
    name,
    brand,
    cost,
    category
  }));
  context.__testSection = { startRow, endRow: startRow + names.length - 1, products };
  return vm.runInContext("finalizeProductSection(__testSection)", context);
}

const kitSection = section(2, [
  "PIXL 8000 Blue Magic Kit",
  "PIXL 8000 Black Cherry Kit",
  "PIXL 8000 Blueberry Sour Razz Kit"
], "PIXL", "£3.70", "Pre-Filled Vape Kits & Pods");

const podSection = section(43, [
  "PIXL 8000 Blue Magic Pods",
  "PIXL 8000 Black Cherry Pods",
  "PIXL 8000 Blueberry Sour Razz Pods"
], "PIXL", "£1.83", "Pre-Filled Vape Kits & Pods");

context.__testSections = [kitSection, podSection];
context.__testName = "PIXL 8000 Blueberry Kit";
const match = vm.runInContext("findBestProductSection(__testName, __testSections)", context);

assert.equal(match.startRow, 2, "new kit should match the PIXL 8000 kit section");
assert.equal(match.exemplar.name, "PIXL 8000 Blueberry Sour Razz Kit");
assert.equal(match.exemplar.cost, "£3.70");

context.__testName = "Completely New Range Mango";
const unmatched = vm.runInContext("findBestProductSection(__testName, __testSections)", context);
assert.equal(unmatched, null, "unrelated titles should require a new-section confirmation");

context.__testName = "PIXL 9000 Blueberry Kit";
const differentModel = vm.runInContext("findBestProductSection(__testName, __testSections)", context);
assert.equal(differentModel, null, "a different model number should not be placed in the PIXL 8000 section");

context.__testName = "PIXL 8000 Blueberry Pods";
const podMatch = vm.runInContext("findBestProductSection(__testName, __testSections)", context);
assert.equal(podMatch.startRow, 43, "new pods should match the pods section, not kits");

console.log("Apps Script product-section matching tests passed.");
