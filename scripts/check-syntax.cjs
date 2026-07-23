const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const roots = ["electron", "src", "test"];
const extensions = new Set([".cjs", ".js"]);

function collectFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(fullPath);
    return extensions.has(path.extname(entry.name)) ? [fullPath] : [];
  });
}

const files = roots.flatMap((root) => collectFiles(path.join(process.cwd(), root)));

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);
