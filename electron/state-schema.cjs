const fs = require("node:fs");
const { AppError } = require("./errors.cjs");
const { createInitialState } = require("./initial-state.cjs");
const { preserveFile, readJson, writeJsonAtomic } = require("./atomic-json.cjs");

const CURRENT_SCHEMA_VERSION = 3;

function clone(value) {
  return structuredClone(value);
}

function mergeCatalog(initialItems, persistedItems) {
  return initialItems.map((initial) => {
    const existing = Array.isArray(persistedItems) ? persistedItems.find((item) => item?.id === initial.id) : null;
    return existing ? { ...initial, ...existing } : initial;
  });
}

function withDefaults(state) {
  const initial = createInitialState();
  return {
    ...initial,
    ...state,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    integrations: mergeCatalog(initial.integrations, state.integrations),
    credentialSettings: mergeCatalog(initial.credentialSettings, state.credentialSettings).map((setting) => ({
      ...setting,
      fields: initial.credentialSettings.find((item) => item.id === setting.id)?.fields || [],
      configuredFields: Array.isArray(setting.configuredFields) ? setting.configuredFields : [],
      publicValues: setting.publicValues && typeof setting.publicValues === "object" ? setting.publicValues : {}
    })),
    creatorPlatforms: mergeCatalog(initial.creatorPlatforms, state.creatorPlatforms),
    analyticsSources: mergeCatalog(initial.analyticsSources, state.analyticsSources),
    businesses: Array.isArray(state.businesses) ? state.businesses : [],
    conversations: Array.isArray(state.conversations) ? state.conversations : [],
    approvals: Array.isArray(state.approvals) ? state.approvals : [],
    auditLog: Array.isArray(state.auditLog) ? state.auditLog.slice(0, 500) : [],
    clipperJobs: Array.isArray(state.clipperJobs) ? state.clipperJobs : [],
    postQueue: Array.isArray(state.postQueue) ? state.postQueue : []
  };
}

function migrateState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("INVALID_STATE", "The saved ProduDash state is invalid.");
  }
  const version = Number(input.schemaVersion);
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new AppError("FUTURE_SCHEMA", "This ProduDash data was created by a newer app version. Update ProduDash before continuing.");
  }
  if (version < 2 || !Number.isInteger(version)) {
    throw new AppError("UNSUPPORTED_SCHEMA", "This legacy ProduDash state cannot be migrated automatically.");
  }
  let state = clone(input);
  if (version === 2) {
    state = {
      ...state,
      schemaVersion: 3,
      credentialSettings: Array.isArray(state.credentialSettings)
        ? state.credentialSettings.map((setting) => ({ ...setting, publicValues: setting.publicValues || {} }))
        : []
    };
  }
  return withDefaults(state);
}

function validateState(state) {
  const requiredArrays = [
    "integrations",
    "credentialSettings",
    "creatorPlatforms",
    "analyticsSources",
    "businesses",
    "conversations",
    "approvals",
    "auditLog",
    "clipperJobs",
    "postQueue"
  ];
  if (state.schemaVersion !== CURRENT_SCHEMA_VERSION || requiredArrays.some((key) => !Array.isArray(state[key]))) {
    throw new AppError("INVALID_STATE", "The saved ProduDash state does not match the supported schema.");
  }
  for (const collection of requiredArrays) {
    if (state[collection].some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new AppError("INVALID_STATE", `The saved ${collection} collection is invalid.`);
    }
  }
  return state;
}

function loadRecoverableState(filePath) {
  const backupPath = `${filePath}.bak`;
  const notices = [];
  if (!fs.existsSync(filePath)) {
    if (fs.existsSync(backupPath)) {
      try {
        const state = validateState(migrateState(readJson(backupPath)));
        writeJsonAtomic(filePath, state, { backup: false });
        notices.push({ code: "STATE_RECOVERED", message: "ProduDash recovered missing local data from the last known-good backup." });
        return { state, notices };
      } catch {
        preserveFile(backupPath, "recovery");
      }
    }
    const initial = createInitialState();
    writeJsonAtomic(filePath, initial, { backup: false });
    return { state: initial, notices };
  }

  try {
    const original = readJson(filePath);
    const state = validateState(migrateState(original));
    if (original.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      writeJsonAtomic(filePath, state);
      notices.push({ code: "STATE_MIGRATED", message: "Local ProduDash data was upgraded safely." });
    }
    return { state, notices };
  } catch (error) {
    if (error instanceof AppError && error.code === "FUTURE_SCHEMA") throw error;
    preserveFile(filePath, "recovery");
    if (fs.existsSync(backupPath)) {
      try {
        const state = validateState(migrateState(readJson(backupPath)));
        writeJsonAtomic(filePath, state, { backup: false });
        notices.push({ code: "STATE_RECOVERED", message: "ProduDash recovered local data from the last known-good backup." });
        return { state, notices };
      } catch {
        preserveFile(backupPath, "recovery");
      }
    }
    const initial = createInitialState();
    writeJsonAtomic(filePath, initial, { backup: false });
    notices.push({
      code: "STATE_RESET_AFTER_RECOVERY_FAILURE",
      message: "Saved data could not be recovered. The damaged files were preserved and a clean workspace was opened."
    });
    return { state: initial, notices };
  }
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  clone,
  loadRecoverableState,
  migrateState,
  validateState,
  withDefaults
};
