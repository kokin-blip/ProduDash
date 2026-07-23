const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("./errors.cjs");
const { createInitialState } = require("./initial-state.cjs");
const { preserveFile, readJson, writeJsonAtomic } = require("./atomic-json.cjs");

const CURRENT_SCHEMA_VERSION = 4;

function clone(value) {
  return structuredClone(value);
}

function mergeCatalog(initialItems, persistedItems) {
  return initialItems.map((initial) => {
    const existing = Array.isArray(persistedItems) ? persistedItems.find((item) => item?.id === initial.id) : null;
    return existing ? { ...initial, ...existing } : initial;
  });
}

function mergeExtensibleCatalog(initialItems, persistedItems) {
  const merged = mergeCatalog(initialItems, persistedItems);
  const known = new Set(initialItems.map((item) => item.id));
  return merged.concat(
    (Array.isArray(persistedItems) ? persistedItems : []).filter(
      (item) => item && typeof item === "object" && !Array.isArray(item) && !known.has(item.id)
    )
  );
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
    aiProviders: mergeExtensibleCatalog(initial.aiProviders, state.aiProviders).map((profile) => ({
      ...profile,
      models: Array.isArray(profile.models) ? profile.models : [],
      credentialStatus: profile.credentialStatus === "stored" ? "stored" : "missing"
    })),
    aiWorkloads:
      state.aiWorkloads && typeof state.aiWorkloads === "object" && !Array.isArray(state.aiWorkloads)
        ? { ...initial.aiWorkloads, ...state.aiWorkloads }
        : initial.aiWorkloads,
    advisorSettings:
      state.advisorSettings && typeof state.advisorSettings === "object" && !Array.isArray(state.advisorSettings)
        ? { ...initial.advisorSettings, ...state.advisorSettings }
        : initial.advisorSettings,
    businesses: Array.isArray(state.businesses) ? state.businesses : [],
    conversations: Array.isArray(state.conversations) ? state.conversations : [],
    approvals: Array.isArray(state.approvals) ? state.approvals : [],
    auditLog: Array.isArray(state.auditLog) ? state.auditLog.slice(0, 500) : [],
    mediaJobs: Array.isArray(state.mediaJobs) ? state.mediaJobs : [],
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
  if (state.schemaVersion === 3) {
    const initial = createInitialState();
    const legacyGemini = Array.isArray(state.integrations) ? state.integrations.find((integration) => integration?.id === "gemini") : null;
    const legacyCredentials = Array.isArray(state.credentialSettings)
      ? state.credentialSettings.find((setting) => setting?.id === "gemini")
      : null;
    const defaultProvider = clone(initial.aiProviders[0]);
    defaultProvider.status = legacyGemini?.status || defaultProvider.status;
    defaultProvider.credentialStatus = legacyCredentials?.status === "stored" ? "stored" : "missing";
    defaultProvider.lastValidatedAt = legacyGemini?.lastSync && legacyGemini.lastSync !== "Not connected" ? legacyGemini.lastSync : null;
    defaultProvider.error = legacyGemini?.error || null;
    state = {
      ...state,
      schemaVersion: 4,
      integrations: Array.isArray(state.integrations) ? state.integrations.filter((integration) => integration?.id !== "gemini") : [],
      credentialSettings: Array.isArray(state.credentialSettings)
        ? state.credentialSettings.filter((setting) => setting?.id !== "gemini")
        : [],
      aiProviders: [defaultProvider],
      aiWorkloads: clone(initial.aiWorkloads),
      advisorSettings: clone(initial.advisorSettings),
      clipperJobs: Array.isArray(state.clipperJobs)
        ? state.clipperJobs.map((job) => ({
            ...job,
            status: "legacy_plan",
            legacy: true
          }))
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
    "mediaJobs",
    "clipperJobs",
    "postQueue",
    "aiProviders"
  ];
  if (state.schemaVersion !== CURRENT_SCHEMA_VERSION || requiredArrays.some((key) => !Array.isArray(state[key]))) {
    throw new AppError("INVALID_STATE", "The saved ProduDash state does not match the supported schema.");
  }
  for (const collection of requiredArrays) {
    if (state[collection].some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new AppError("INVALID_STATE", `The saved ${collection} collection is invalid.`);
    }
  }
  if (!state.aiWorkloads || typeof state.aiWorkloads !== "object" || Array.isArray(state.aiWorkloads)) {
    throw new AppError("INVALID_STATE", "The saved AI workload assignments are invalid.");
  }
  if (!state.advisorSettings || typeof state.advisorSettings !== "object" || Array.isArray(state.advisorSettings)) {
    throw new AppError("INVALID_STATE", "The saved advisor settings are invalid.");
  }
  const providerIds = new Set();
  for (const profile of state.aiProviders) {
    if (
      typeof profile.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(profile.id) ||
      providerIds.has(profile.id) ||
      typeof profile.providerType !== "string" ||
      typeof profile.name !== "string" ||
      !Array.isArray(profile.models)
    ) {
      throw new AppError("INVALID_STATE", "The saved AI provider profiles are invalid.");
    }
    providerIds.add(profile.id);
    const modelIds = new Set();
    for (const model of profile.models) {
      if (
        !model ||
        typeof model.id !== "string" ||
        !model.id ||
        modelIds.has(model.id) ||
        typeof model.name !== "string" ||
        !Array.isArray(model.capabilities) ||
        model.capabilities.some((capability) => typeof capability !== "string")
      ) {
        throw new AppError("INVALID_STATE", "The saved AI model metadata is invalid.");
      }
      modelIds.add(model.id);
    }
    if (profile.selectedModelId !== null && !modelIds.has(profile.selectedModelId)) {
      throw new AppError("INVALID_STATE", "The selected AI model is not present in its provider profile.");
    }
  }
  for (const workloadId of ["advisor", "inboxDrafting", "clipAnalysis", "transcription"]) {
    const assignment = state.aiWorkloads[workloadId];
    if (
      !assignment ||
      typeof assignment !== "object" ||
      Array.isArray(assignment) ||
      !["provider", "same_as_advisor", "unassigned"].includes(assignment.mode)
    ) {
      throw new AppError("INVALID_STATE", "The saved AI workload assignments are invalid.");
    }
    if (
      assignment.mode === "provider" &&
      (typeof assignment.profileId !== "string" ||
        !providerIds.has(assignment.profileId) ||
        typeof assignment.modelId !== "string" ||
        !state.aiProviders.find((profile) => profile.id === assignment.profileId)?.models.some((model) => model.id === assignment.modelId))
    ) {
      throw new AppError("INVALID_STATE", "An AI workload references an unavailable provider profile.");
    }
    if (
      (assignment.mode === "same_as_advisor" && workloadId !== "clipAnalysis") ||
      (assignment.mode === "unassigned" && workloadId !== "transcription")
    ) {
      throw new AppError("INVALID_STATE", "The saved AI workload mode is not valid for this workload.");
    }
  }
  const mediaJobIds = new Set();
  const mediaJobStatuses = new Set([
    "queued",
    "render_queued",
    "processing",
    "awaiting_review",
    "canceling",
    "canceled",
    "interrupted",
    "failed",
    "completed"
  ]);
  for (const job of state.mediaJobs) {
    if (
      typeof job.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(job.id) ||
      mediaJobIds.has(job.id) ||
      typeof job.title !== "string" ||
      typeof job.sourceMediaId !== "string" ||
      typeof job.outputFolderName !== "string" ||
      !mediaJobStatuses.has(job.status) ||
      typeof job.stage !== "string" ||
      !Number.isFinite(job.progress) ||
      job.progress < 0 ||
      job.progress > 100 ||
      !job.settings ||
      typeof job.settings !== "object" ||
      Array.isArray(job.settings) ||
      Object.hasOwn(job, "sourcePath") ||
      Object.hasOwn(job, "outputPath") ||
      Object.hasOwn(job, "tempPath") ||
      Object.hasOwn(job, "outputBookmark")
    ) {
      throw new AppError("INVALID_STATE", "The saved media job summaries are invalid.");
    }
    mediaJobIds.add(job.id);
    if (
      !Array.isArray(job.candidates) ||
      !Array.isArray(job.selectedCandidateIds) ||
      !Array.isArray(job.warnings) ||
      !Array.isArray(job.artifacts)
    ) {
      throw new AppError("INVALID_STATE", "The saved media job collections are invalid.");
    }
    const candidateIds = new Set();
    for (const candidate of job.candidates) {
      if (
        !candidate ||
        typeof candidate.id !== "string" ||
        candidateIds.has(candidate.id) ||
        typeof candidate.title !== "string" ||
        !Number.isFinite(candidate.start) ||
        !Number.isFinite(candidate.end) ||
        candidate.start < 0 ||
        candidate.end <= candidate.start ||
        !Number.isFinite(candidate.confidence) ||
        candidate.confidence < 0 ||
        candidate.confidence > 1
      ) {
        throw new AppError("INVALID_STATE", "The saved media job candidates are invalid.");
      }
      candidateIds.add(candidate.id);
    }
    if (job.selectedCandidateIds.some((candidateId) => !candidateIds.has(candidateId))) {
      throw new AppError("INVALID_STATE", "A media job selection references an unavailable candidate.");
    }
    if (
      job.artifacts.some(
        (artifact) =>
          !artifact ||
          !["video", "caption", "thumbnail", "manifest"].includes(artifact.kind) ||
          typeof artifact.name !== "string" ||
          artifact.name !== path.basename(artifact.name) ||
          Object.hasOwn(artifact, "path")
      )
    ) {
      throw new AppError("INVALID_STATE", "The saved media job artifacts are invalid.");
    }
  }
  if (
    typeof state.advisorSettings.displayName !== "string" ||
    state.advisorSettings.displayName.length < 1 ||
    state.advisorSettings.displayName.length > 80
  ) {
    throw new AppError("INVALID_STATE", "The saved advisor settings are invalid.");
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
