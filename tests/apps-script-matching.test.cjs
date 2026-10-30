const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("apps-script/Code.gs", "utf8");
const context = vm.createContext({ console });
vm.runInContext(source, context);

function section(startRow, brand, product, flavours) {
  const products = flavours.map((flavour, index) => ({
    row: startRow + index,
    brand,
    product,
    flavour,
    name: `${brand} | ${product} | ${flavour}`,
    cost: 3.7,
    category: "Pre-Filled Vape Kits & Pods"
  }));
  context.__testSection = { startRow, endRow: startRow + products.length - 1, products };
  return vm.runInContext("finalizeProductSection(__testSection)", context);
}

const kitSection = section(2, "PIXL", "8000 Kit", ["Blue Magic", "Black Cherry"]);
const podSection = section(43, "PIXL", "8000 Pods", ["Blue Magic", "Black Cherry"]);
context.__sections = [kitSection, podSection];

context.__brand = "pixl";
context.__product = "8000 kit";
let match = vm.runInContext("findExactProductSection(__brand, __product, __sections)", context);
assert.equal(match.startRow, 2, "matching is case-insensitive and exact by Brand + Product");
context.__match = match;
const publicMatch = vm.runInContext("publicSectionMatch(__match)", context);
assert.equal(publicMatch.exemplarName, "Blue Magic", "preview uses the exact section representative flavour");
assert.equal(publicMatch.inheritedBrand, "PIXL", "preview inherits the representative brand");

context.__product = "8000 pods";
match = vm.runInContext("findExactProductSection(__brand, __product, __sections)", context);
assert.equal(match.startRow, 43, "pods must not be grouped into the kit section");

context.__product = "9000 kit";
match = vm.runInContext("findExactProductSection(__brand, __product, __sections)", context);
assert.equal(match, null, "a new product range requires explicit new-section confirmation");

context.__flavour = "Blue Magic";
const key = vm.runInContext("structuredProductKey(__brand, '8000 kit', __flavour)", context);
assert.equal(key, "pixl|8000 kit|blue magic");

assert.equal(vm.runInContext("columnToLetter(9)", context), "I");
assert.equal(vm.runInContext("columnToLetter(19)", context), "S");

console.log("Apps Script structured product matching tests passed.");
