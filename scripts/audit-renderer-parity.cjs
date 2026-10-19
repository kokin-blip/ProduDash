// Record the original public renderer contracts, not the much larger IPC surface.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const revision = "a2c599352ef2d864f4161656b03a684e9c76a86b";
const files = execFileSync("git", ["ls-tree", "-r", "--name-only", revision], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((file) => file === "index.html" || /^src\/renderer\/.*\.js$/.test(file));
const read = (file) => execFileSync("git", ["show", `${revision}:${file}`], { encoding: "utf8" });
const handlers = read("src/renderer/handlers.js");
const attributes = new Map();
for (const file of files.filter((name) => !name.endsWith("handlers.js") && !name.endsWith("api.js"))) {
  const source = read(file);
  for (const match of source.matchAll(/\bdata-[a-z][a-z-]+(?=[=\s>])/g)) {
    const attribute = match[0];
    const lines = source.slice(0, match.index).split("\n");
    const owner = [...source.slice(0, match.index).matchAll(/(?:export )?function (\w+)/g)].at(-1)?.[1] || "shell";
    const entry = attributes.get(attribute) || { attribute, source: [], handlerSelectors: [], apiCalls: [] };
    if (!entry.source.some((item) => item.file === file && item.owner === owner)) entry.source.push({ file, line: lines.length, owner });
    attributes.set(attribute, entry);
  }
}
for (const entry of attributes.values()) {
  const matches = [...handlers.matchAll(/(?:event\.target\.closest|form\.matches)\((?:"([^"]+)"|'([^']+)')\)/g)];
  for (const match of matches) {
    const selector = match[1] || match[2];
    if (!selector.includes(`[${entry.attribute}`)) continue;
    const tail = handlers.slice(match.index);
    const end = tail.slice(1).search(/\n  (?:const \w+ = event\.target\.closest|if \(form\.matches)/);
    const block = end < 0 ? tail : tail.slice(0, end + 1);
    entry.handlerSelectors.push({ selector, line: handlers.slice(0, match.index).split("\n").length });
    entry.apiCalls.push(...[...block.matchAll(/api\.(\w+)\(/g)].map((item) => item[1]));
  }
  entry.apiCalls = [...new Set(entry.apiCalls)];
}
const result = {
  baselineRevision: revision,
  note: "Static selector inventory. Availability/consent gates remain in the named renderer functions and main-process services. API lists are direct calls in matching handler blocks; helper calls and presentation-only attributes are not new features.",
  attributes: [...attributes.values()].sort((a, b) => a.attribute.localeCompare(b.attribute)),
  globalActions: ["#syncButton", "#trainButton"],
  bridgeOnly: ["completeCommand", "getAuthorizationInstructions", "cancelClipSearchIndex", "updateBrandTemplate"]
};
fs.writeFileSync(path.join("docs", "renderer-parity.json"), JSON.stringify(result, null, 2) + "\n");
console.log(`Recorded ${result.attributes.length} original renderer attributes.`);
