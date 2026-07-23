const fs = require("node:fs");
const path = require("node:path");

function temporaryPath(filePath) {
  return `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function flushDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Directory fsync is not available on every supported filesystem.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeBufferWithoutBackup(filePath, buffer, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = temporaryPath(filePath);
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, "wx", mode);
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tempPath, filePath);
    try {
      fs.chmodSync(filePath, mode);
    } catch {
      // Best effort for filesystems without POSIX permissions.
    }
    flushDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function writeBufferAtomic(filePath, buffer, options = {}) {
  const mode = options.mode ?? 0o600;
  const backupPath = options.backupPath || `${filePath}.bak`;
  if (options.backup !== false && fs.existsSync(filePath)) {
    writeBufferWithoutBackup(backupPath, fs.readFileSync(filePath), mode);
  }
  writeBufferWithoutBackup(filePath, buffer, mode);
}

function writeJsonAtomic(filePath, value, options = {}) {
  writeBufferAtomic(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), options);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function preserveFile(filePath, label = "recovery") {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const recoveryPath = `${filePath}.${label}-${stamp}`;
  fs.renameSync(filePath, recoveryPath);
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.${label}-`;
  const recoveryFiles = fs
    .readdirSync(directory)
    .filter((entry) => entry.startsWith(prefix))
    .sort()
    .reverse();
  for (const oldFile of recoveryFiles.slice(3)) fs.unlinkSync(path.join(directory, oldFile));
  return recoveryPath;
}

module.exports = { preserveFile, readJson, writeBufferAtomic, writeJsonAtomic };
