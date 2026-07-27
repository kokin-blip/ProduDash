const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const buildDirectory = path.join(root, "build");
const sourcePath = path.join(buildDirectory, "icon.svg");
const pngPath = path.join(buildDirectory, "icon.png");
const iconsetPath = path.join(buildDirectory, "icon.iconset");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout || `${command} failed.`);
}

function createIco(pngFiles, outputPath) {
  const images = pngFiles.map(({ size, filePath }) => ({ size, data: fs.readFileSync(filePath) }));
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  fs.writeFileSync(outputPath, Buffer.concat([header, ...images.map(({ data }) => data)]));
}

if (process.platform !== "darwin") {
  throw new Error("Icon generation must run on macOS because it uses iconutil and sips.");
}

fs.rmSync(iconsetPath, { recursive: true, force: true });
fs.mkdirSync(iconsetPath, { recursive: true });
run("sips", ["-s", "format", "png", sourcePath, "--out", pngPath]);

const iconset = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"]
];
for (const [size, name] of iconset) {
  run("sips", ["-z", String(size), String(size), pngPath, "--out", path.join(iconsetPath, name)]);
}
run("iconutil", ["-c", "icns", iconsetPath, "-o", path.join(buildDirectory, "icon.icns")]);

const icoSizes = [16, 32, 48, 64, 128, 256].map((size) => {
  const filePath = path.join(iconsetPath, `ico-${size}.png`);
  run("sips", ["-z", String(size), String(size), pngPath, "--out", filePath]);
  return { size, filePath };
});
createIco(icoSizes, path.join(buildDirectory, "icon.ico"));
fs.rmSync(iconsetPath, { recursive: true, force: true });
