const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
function rendererSource(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? rendererSource(file) : entry.name.endsWith(".js") ? fs.readFileSync(file, "utf8") : "";
    })
    .join("\n");
}

test("the redesign retains every recorded original renderer attribute and both global action IDs", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "docs/renderer-parity.json"), "utf8"));
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const source = html + rendererSource(path.join(root, "src/renderer"));
  const missing = manifest.attributes.filter(({ attribute }) => !source.includes(attribute)).map(({ attribute }) => attribute);
  assert.deepEqual(missing, []);
  for (const id of manifest.globalActions) assert.ok(html.includes(`id="${id.slice(1)}"`));
});

test("the shared stylesheet has no unresolved semantic token references or temporary asset dependencies", () => {
  const css = ["src/styles.css", "src/appearance.css"].map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  const defined = new Set([...css.matchAll(/(--[\w-]+):/g)].map((match) => match[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]));
  assert.deepEqual(
    [...used].filter((token) => !defined.has(token)),
    []
  );
  const source = css + rendererSource(path.join(root, "src/renderer"));
  assert.doesNotMatch(source, /https:\/\/www\.figma\.com\/api\/mcp\/asset\//);
});
