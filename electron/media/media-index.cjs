const fs = require("node:fs");
const { AppError } = require("../errors.cjs");
const { preserveFile, readJson, writeJsonAtomic } = require("../atomic-json.cjs");

const MEDIA_INDEX_VERSION = 1;

function createEmptyMediaIndex() {
  return {
    schemaVersion: MEDIA_INDEX_VERSION,
    folders: [],
    clips: [],
    updatedAt: new Date().toISOString()
  };
}

function validateMediaIndex(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== MEDIA_INDEX_VERSION ||
    !Array.isArray(value.folders) ||
    !Array.isArray(value.clips)
  ) {
    throw new AppError("INVALID_MEDIA_INDEX", "The saved Clip Library index is invalid.");
  }
  for (const collection of [value.folders, value.clips]) {
    if (collection.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new AppError("INVALID_MEDIA_INDEX", "The saved Clip Library index contains invalid records.");
    }
  }
  return value;
}

function loadMediaIndex(filePath) {
  const backupPath = `${filePath}.bak`;
  const notices = [];
  if (!fs.existsSync(filePath)) {
    const index = createEmptyMediaIndex();
    writeJsonAtomic(filePath, index, { backup: false });
    return { index, notices };
  }
  try {
    const raw = readJson(filePath);
    if (Number(raw?.schemaVersion) > MEDIA_INDEX_VERSION) {
      throw new AppError("FUTURE_MEDIA_INDEX", "This Clip Library was created by a newer ProduDash version.");
    }
    return { index: validateMediaIndex(raw), notices };
  } catch (error) {
    if (error instanceof AppError && error.code === "FUTURE_MEDIA_INDEX") throw error;
    preserveFile(filePath, "recovery");
    if (fs.existsSync(backupPath)) {
      try {
        const index = validateMediaIndex(readJson(backupPath));
        writeJsonAtomic(filePath, index, { backup: false });
        notices.push({
          code: "MEDIA_INDEX_RECOVERED",
          message: "ProduDash recovered the Clip Library from its last known-good backup."
        });
        return { index, notices };
      } catch {
        preserveFile(backupPath, "recovery");
      }
    }
    const index = createEmptyMediaIndex();
    writeJsonAtomic(filePath, index, { backup: false });
    notices.push({
      code: "MEDIA_INDEX_RESET",
      message: "The damaged Clip Library index was preserved and a clean index was opened."
    });
    return { index, notices };
  }
}

module.exports = { MEDIA_INDEX_VERSION, createEmptyMediaIndex, loadMediaIndex, validateMediaIndex };
