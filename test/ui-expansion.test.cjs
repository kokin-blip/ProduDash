const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const patterns = import("../src/renderer/ui-patterns.js");
function markup(html) {
  return new JSDOM(html).window.document;
}

test("property groups preserve native form names, constraints and values", async () => {
  const { renderPropertyGroup } = await patterns;
  const doc = markup(
    `<form>${renderPropertyGroup(
      "Canvas <settings>",
      `
    <label><span>Scale</span><input name="scale" type="number" min="0.5" max="2.5" step="0.1" value="1.2"></label>
    <label><input type="checkbox" name="reviewed" checked><span>Reviewed</span></label>
    <label><span>Mode</span><select name="mode"><option value="fit" selected>Fit</option></select></label>
  `
    )}</form>`
  );
  assert.equal(doc.querySelector("h4").textContent, "Canvas <settings>");
  assert.equal(doc.querySelector("settings"), null);
  const data = new doc.defaultView.FormData(doc.querySelector("form"));
  assert.deepEqual(
    [...data],
    [
      ["scale", "1.2"],
      ["reviewed", "on"],
      ["mode", "fit"]
    ]
  );
  const input = doc.querySelector('[name="scale"]');
  assert.equal(input.min, "0.5");
  assert.equal(input.max, "2.5");
  assert.equal(input.step, "0.1");
});

test("revenue bars preserve zero, negative and unavailable values and escape report labels", async () => {
  const { renderRevenueBars } = await patterns;
  const doc = markup(
    renderRevenueBars([
      { period: "<img src=x onerror=alert(1)>", revenue: 100 },
      { period: "Zero", revenue: 0 },
      { period: "Adjustment", revenue: -25 },
      { period: "Missing", revenue: null }
    ])
  );
  assert.equal(doc.querySelector("img, script"), null);
  assert.equal(doc.querySelectorAll(".revenue-bar").length, 3);
  assert.equal(doc.querySelectorAll(".revenue-bar")[1].getAttribute("height"), "0");
  const baseline = Number(doc.querySelector(".revenue-baseline").getAttribute("y1"));
  assert.equal(Number(doc.querySelectorAll(".revenue-bar")[2].getAttribute("y")), baseline);
  assert.match(doc.querySelector("svg").textContent, /Missing: Unavailable/);
  assert.doesNotMatch(doc.body.innerHTML, /NaN|Infinity/);
});

test("empty, zero-only and extreme finite revenue series never create invented bars or invalid SVG", async () => {
  const { renderRevenueBars } = await patterns;
  assert.equal(markup(renderRevenueBars([])).querySelector("svg"), null);
  for (const revenue of [0, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    const html = renderRevenueBars([{ period: "Snapshot", revenue }]);
    assert.doesNotMatch(html, /NaN|Infinity/);
    assert.equal(markup(html).querySelectorAll(".revenue-bar").length, 1);
  }
});

test("long revenue series reserve readable space per period and keep exact values in their data table", async () => {
  const { renderRevenueBars } = await patterns;
  const points = Array.from({ length: 60 }, (_, index) => ({ period: `2026-W${index + 1}`, revenue: 123_456_789 + index }));
  const doc = markup(renderRevenueBars(points));
  const plot = doc.querySelector("svg");
  assert.ok(plot.classList.contains("is-dense"));
  assert.equal(Number(plot.getAttribute("width")), 60 * 96 + 120);
  assert.equal(doc.querySelector(".revenue-chart-scroll").tabIndex, 0);
  assert.equal(doc.querySelectorAll("table tbody tr").length, 60);
  assert.match(doc.querySelector("tbody td").textContent, /123,456,789/);
  assert.match(doc.querySelector(".revenue-value").textContent, /M/);
});

test("the expansion retains the current renderer action and form contracts, including newer connector work", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "docs/ui-expansion-parity.json")));
  for (const [file, { attributes, fields }] of Object.entries(manifest)) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const attribute of attributes) assert.ok(source.includes(attribute), `${file}: ${attribute}`);
    for (const field of fields) assert.ok(source.includes(`name="${field}"`), `${file}: ${field}`);
  }
});
