const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const { loadApprovedMediaManifest } = require("../electron/media/binaries.cjs");

const FORBIDDEN_PATH =
  /(^|\/)(?:test|tests|__tests__|smoke|scripts|docs|coverage|playwright-report|test-results)(?:\/|$)|(^|\/)\.env(?:\.|$)|\.map$/i;
const FORBIDDEN_EXECUTABLE = /\.(?:exe|dll|dylib|so|node)$/i;
const ABSOLUTE_USER_PATH = /(?:\/Users\/[^/\s"']+|\/home\/[^/\s"']+|[A-Za-z]:\\Users\\[^\\\s"']+)/;
const SECRET_VALUE = /(?:shpat_[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/;
const TEXT_FILE = /\.(?:cjs|mjs|js|json|html|css|py|txt|md|xml|plist)$/i;

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function assertSafeText(label, content) {
  if (ABSOLUTE_USER_PATH.test(content)) throw new Error(`${label} contains a raw user path.`);
  if (SECRET_VALUE.test(content)) throw new Error(`${label} contains a credential-shaped value.`);
}

function resolveResourcesDirectory(appOutDir) {
  const direct = path.join(appOutDir, "resources");
  if (fs.statSync(direct, { throwIfNoEntry: false })?.isDirectory()) return direct;
  const applications = fs
    .readdirSync(appOutDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (applications.length === 1) {
    return path.join(appOutDir, applications[0].name, "Contents", "Resources");
  }
  throw new Error("Packaged application resources directory is unavailable.");
}

function auditPackage(appOutDir, expectedMedia = {}) {
  const resourcesDirectory = resolveResourcesDirectory(appOutDir);
  const asarPath = path.join(resourcesDirectory, "app.asar");
  if (!fs.statSync(asarPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Packaged application is missing resources/app.asar.");
  }
  asar.uncache(asarPath);
  const entries = asar.listPackage(asarPath).map((entry) => entry.replace(/^[/\\]+/, "").replaceAll("\\", "/"));
  const forbidden = entries.filter((entry) => FORBIDDEN_PATH.test(entry));
  if (forbidden.length) throw new Error(`Packaged application contains forbidden files: ${forbidden.slice(0, 5).join(", ")}`);
  const developmentMedia = entries.filter(
    (entry) => entry.startsWith("node_modules/ffmpeg-static/") || entry.startsWith("node_modules/@derhuerst/ffprobe-static/")
  );
  if (developmentMedia.length) throw new Error("Packaged application contains development-only media binaries.");

  for (const entry of entries) {
    if (!TEXT_FILE.test(entry)) continue;
    if (asar.statFile(asarPath, entry).files) continue;
    const content = asar.extractFile(asarPath, entry).toString("utf8");
    assertSafeText(entry, content);
  }
  for (const filePath of listFiles(resourcesDirectory)) {
    if (filePath === asarPath || filePath.startsWith(`${path.join(resourcesDirectory, "media")}${path.sep}`)) continue;
    const relative = path.relative(resourcesDirectory, filePath).replaceAll("\\", "/");
    if (FORBIDDEN_PATH.test(relative)) throw new Error(`Packaged resources contain a forbidden file: ${relative}`);
    if (TEXT_FILE.test(relative)) assertSafeText(relative, fs.readFileSync(filePath, "utf8"));
  }

  const mediaDirectory = path.join(resourcesDirectory, "media");
  const approved = loadApprovedMediaManifest(mediaDirectory, expectedMedia);
  const allowedResourceExecutables = new Set([path.resolve(approved.ffmpegPath), path.resolve(approved.ffprobePath)]);
  const unexpectedExecutables = listFiles(resourcesDirectory).filter(
    (filePath) => filePath !== asarPath && FORBIDDEN_EXECUTABLE.test(filePath) && !allowedResourceExecutables.has(path.resolve(filePath))
  );
  if (unexpectedExecutables.length) {
    throw new Error(`Packaged resources contain unexpected executables: ${unexpectedExecutables.map(path.basename).join(", ")}`);
  }

  return {
    appOutDir: path.basename(appOutDir),
    asarEntries: entries.length,
    mediaVersion: approved.manifest.version,
    mediaLicense: approved.manifest.license.spdx,
    signingMode: process.env.PRODUDASH_SIGNING_MODE || "unsigned"
  };
}

module.exports = { auditPackage, resolveResourcesDirectory };
