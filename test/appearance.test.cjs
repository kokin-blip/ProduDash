const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
function setup({ saved, dark = false, blocked = false } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "index.html"), "utf8"), {
    url: "https://produdash.test",
    runScripts: "outside-only"
  });
  const { window } = dom;
  const media = new window.EventTarget();
  media.matches = dark;
  window.matchMedia = () => media;
  if (saved) window.localStorage.setItem("produdash.appearance", saved);
  if (blocked)
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("Unavailable");
      }
    });
  window.eval(fs.readFileSync(path.join(root, "src/renderer/appearance.js"), "utf8"));
  const control = window.document.querySelector("[data-appearance-select]");
  function select(value) {
    control.value = value;
    control.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  return { dom, window, media, control, select, dataset: window.document.documentElement.dataset };
}

test("the existing solid system appearance follows OS changes until explicitly overridden", () => {
  const { dom, media, select, dataset } = setup();
  assert.equal(dataset.theme, "system");
  assert.equal(dataset.material, "solid");
  assert.equal(dataset.appearance, "light");
  media.matches = true;
  media.dispatchEvent(new dom.window.Event("change"));
  assert.equal(dataset.appearance, "dark");
  select("light");
  media.dispatchEvent(new dom.window.Event("change"));
  assert.equal(dataset.appearance, "light");
  select("system");
  assert.equal(dataset.appearance, "dark");
  dom.window.close();
});

test("all four explicit appearances persist without remounting workspace drafts or focus", () => {
  const { dom, window, control, select, dataset } = setup();
  const field = window.document.createElement("textarea");
  window.document.querySelector("#viewRoot").append(field);
  field.value = "Unsubmitted edit";
  field.focus();
  field.setSelectionRange(2, 7);
  for (const value of ["light", "dark", "glass-light", "glass-dark"]) {
    select(value);
    assert.equal(dataset.appearance, value.endsWith("dark") ? "dark" : "light");
    assert.equal(dataset.material, value.startsWith("glass-") ? "glass" : "solid");
    assert.equal(window.localStorage.getItem("produdash.appearance"), value);
    assert.equal(control.value, value);
    assert.equal(window.document.activeElement, field);
    assert.equal(field.value, "Unsubmitted edit");
    assert.equal(field.selectionStart, 2);
  }
  dom.window.close();
});

test("saved glass preference is restored before stylesheet loading; invalid values fall back to system", () => {
  for (const saved of ["glass-light", "glass-dark", "untrusted-value"]) {
    const { dom, dataset, control } = setup({ saved, dark: true });
    assert.equal(dataset.theme, saved === "untrusted-value" ? "system" : saved);
    assert.equal(control.value, dataset.theme);
    dom.window.close();
  }
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(html.indexOf('src="./src/renderer/appearance.js"') < html.indexOf('href="./src/styles.css"'));
});

test("unavailable local storage does not block appearance selection or startup", () => {
  const { dom, select, dataset } = setup({ blocked: true });
  select("glass-dark");
  assert.equal(dataset.material, "glass");
  assert.equal(dataset.appearance, "dark");
  dom.window.close();
});
