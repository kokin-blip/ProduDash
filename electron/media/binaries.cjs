const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("../errors.cjs");

let approvedCache;

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isLfsPointer(filePath) {
  const handle = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(128);
    const length = fs.readSync(handle, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, length).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1");
  } finally {
    fs.closeSync(handle);
  }
}

function validateFileName(value, label) {
  if (typeof value !== "string" || !value || path.basename(value) !== value || value.includes("..")) {
    throw new AppError("MEDIA_TOOLS_UNAVAILABLE", `${label} metadata is invalid.`);
  }
  return value;
}

function validSource(value) {
  try {
    const source = new URL(value);
    return (
      source.protocol === "https:" &&
      !source.username &&
      !source.password &&
      !source.search &&
      !source.hash &&
      source.hostname.includes(".")
    );
  } catch {
    return false;
  }
}

function loadApprovedMediaManifest(directory, expected = {}) {
  const manifestPath = path.join(directory, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new AppError("MEDIA_TOOLS_UNAVAILABLE", "Approved media-tool metadata is unavailable.");
  }
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.approvedForDistribution !== true ||
    manifest.nonfreeBuild !== false ||
    typeof manifest.approvalReference !== "string" ||
    !manifest.approvalReference.trim() ||
    typeof manifest.source !== "string" ||
    !validSource(manifest.source) ||
    typeof manifest.version !== "string" ||
    !manifest.version.trim() ||
    typeof manifest.license?.spdx !== "string" ||
    !manifest.license.spdx.trim()
  ) {
    throw new AppError("MEDIA_TOOLS_UNAVAILABLE", "Approved media-tool metadata is incomplete.");
  }
  if (expected.platform && manifest.platform !== expected.platform) {
    throw new AppError("MEDIA_TOOLS_UNAVAILABLE", "Approved media tools target a different platform.");
  }
  if (expected.architecture && manifest.architecture !== expected.architecture) {
    throw new AppError("MEDIA_TOOLS_UNAVAILABLE", "Approved media tools target a different architecture.");
  }

  const noticeFile = validateFileName(manifest.license.noticeFile, "License notice");
  const noticePath = path.join(directory, noticeFile);
  if (!fs.statSync(noticePath, { throwIfNoEntry: false })?.isFile() || isLfsPointer(noticePath)) {
    throw new AppError("MEDIA_TOOLS_UNAVAILABLE", "The approved media-tool license notice is unavailable.");
  }

  const resolved = {};
  for (const name of ["ffmpeg", "ffprobe"]) {
    const descriptor = manifest.binaries?.[name];
    const fileName = validateFileName(descriptor?.file, name);
    const expectedHash = String(descriptor?.sha256 || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new AppError("MEDIA_TOOLS_UNAVAILABLE", `${name} approval metadata is invalid.`);
    }
    const binaryPath = path.join(directory, fileName);
    if (!fs.statSync(binaryPath, { throwIfNoEntry: false })?.isFile() || isLfsPointer(binaryPath)) {
      throw new AppError("MEDIA_TOOLS_UNAVAILABLE", `The approved ${name} binary is unavailable.`);
    }
    if (sha256(binaryPath) !== expectedHash) {
      throw new AppError("MEDIA_TOOLS_UNAVAILABLE", `The approved ${name} binary failed integrity validation.`);
    }
    resolved[`${name}Path`] = binaryPath;
  }
  return { manifest, ...resolved, noticePath };
}

function getDevelopmentMediaBinaries() {
  const ffmpegPath = require("ffmpeg-static");
  const ffprobePath = require("@derhuerst/ffprobe-static");
  if (typeof ffmpegPath !== "string" || typeof ffprobePath !== "string") {
    throw new AppError("MEDIA_TOOLS_UNAVAILABLE", "Bundled FFmpeg tools are unavailable.");
  }
  return { ffmpegPath, ffprobePath };
}

function getMediaBinaries(options = {}) {
  const packaged = options.packaged ?? process.env.PRODUDASH_PACKAGED === "1";
  if (!packaged) return getDevelopmentMediaBinaries();
  const resourcesPath = options.resourcesPath || process.env.PRODUDASH_RESOURCES_PATH || process.resourcesPath;
  if (!resourcesPath) throw new AppError("MEDIA_TOOLS_UNAVAILABLE", "Packaged media resources are unavailable.");
  const directory = path.join(resourcesPath, "media");
  const cacheKey = `${directory}:${options.platform || process.platform}:${options.architecture || process.arch}`;
  if (approvedCache?.key === cacheKey) return approvedCache.value;
  const approved = loadApprovedMediaManifest(directory, {
    platform: options.platform || process.platform,
    architecture: options.architecture || process.arch
  });
  const value = { ffmpegPath: approved.ffmpegPath, ffprobePath: approved.ffprobePath };
  approvedCache = { key: cacheKey, value };
  return value;
}

module.exports = { getMediaBinaries, loadApprovedMediaManifest, sha256 };
