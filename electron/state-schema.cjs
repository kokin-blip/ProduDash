const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AppError } = require("./errors.cjs");
const { createInitialState } = require("./initial-state.cjs");
const { CREATOR_PLATFORM_IDS } = require("./platforms/registry.cjs");
const { normalizeAuthorizationRecord, validateAuthorizationRecord } = require("./platforms/authorization.cjs");
const { STATUS_VALUES: POST_PLAN_STATUS_VALUES } = require("./publishing/post-status.cjs");
const { normalizeReceipt, validateReceipt } = require("./publishing/receipt.cjs");
const { seedPublishingOptions } = require("./validation.cjs");
const { preserveFile, readJson, writeJsonAtomic } = require("./atomic-json.cjs");

const { CURRENT_SCHEMA_VERSION, MINIMUM_SUPPORTED_SCHEMA_VERSION } = require("./schema-version.cjs");

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
  const advisorSettings =
    state.advisorSettings && typeof state.advisorSettings === "object" && !Array.isArray(state.advisorSettings)
      ? { ...initial.advisorSettings, ...state.advisorSettings }
      : initial.advisorSettings;
  return {
    ...initial,
    ...state,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    // mergeCatalog spreads the persisted entry over the initial one, so a record
    // saved before the authorization field existed would keep no authorization
    // at all. Backfill it here as well as in the migration.
    integrations: mergeCatalog(initial.integrations, state.integrations).map((integration) => ({
      ...integration,
      authorization: normalizeAuthorizationRecord(integration.authorization)
    })),
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
    advisorSettings,
    voiceLikeness:
      state.voiceLikeness && typeof state.voiceLikeness === "object" && !Array.isArray(state.voiceLikeness)
        ? {
            acceptance:
              state.voiceLikeness.acceptance &&
              typeof state.voiceLikeness.acceptance === "object" &&
              !Array.isArray(state.voiceLikeness.acceptance)
                ? state.voiceLikeness.acceptance
                : null,
            voices: Array.isArray(state.voiceLikeness.voices) ? state.voiceLikeness.voices : []
          }
        : initial.voiceLikeness,
    businesses: Array.isArray(state.businesses) ? state.businesses : [],
    conversations: Array.isArray(state.conversations) ? state.conversations : [],
    approvals: Array.isArray(state.approvals) ? state.approvals : [],
    auditLog: Array.isArray(state.auditLog) ? state.auditLog.slice(0, 500) : [],
    mediaJobs: Array.isArray(state.mediaJobs)
      ? state.mediaJobs.map((job) => ({
          jobType: "clip_generation",
          projectId: null,
          renderPlanVersion: null,
          renderPlanHash: null,
          thumbnailSelections: [],
          ...job
        }))
      : [],
    clipperJobs: Array.isArray(state.clipperJobs) ? state.clipperJobs : [],
    postQueue: Array.isArray(state.postQueue)
      ? state.postQueue.map((plan) => {
          const platforms = Array.isArray(plan.platforms) ? plan.platforms : [];
          const scheduledFor = typeof plan.scheduledFor === "string" && plan.scheduledFor ? plan.scheduledFor : null;
          return {
            ...plan,
            mediaJobId: typeof plan.mediaJobId === "string" ? plan.mediaJobId : null,
            contentHash: typeof plan.contentHash === "string" && /^[a-f0-9]{64}$/.test(plan.contentHash) ? plan.contentHash : null,
            platformPackages: (Array.isArray(plan.platformPackages)
              ? plan.platformPackages
              : platforms.map((platformId) => ({
                  platformId,
                  title: typeof plan.title === "string" ? plan.title : "",
                  caption: typeof plan.caption === "string" ? plan.caption : ""
                }))
            ).map((item) => ({
              ...item,
              // Backfilled here as well as in the migration, because
              // mergeCatalog-style defaults never reach nested packages.
              options: item?.options === undefined ? seedPublishingOptions(item?.platformId) : item.options
            })),
            schedule:
              plan.schedule && typeof plan.schedule === "object" && !Array.isArray(plan.schedule)
                ? plan.schedule
                : {
                    mode: scheduledFor ? "planned_local_only" : "unscheduled",
                    scheduledFor,
                    timeZone: scheduledFor ? "UTC" : null
                  },
            mediaSnapshot: plan.mediaSnapshot && typeof plan.mediaSnapshot === "object" ? plan.mediaSnapshot : null,
            approvalSnapshot: plan.approvalSnapshot && typeof plan.approvalSnapshot === "object" ? plan.approvalSnapshot : null,
            exportReceipt: plan.exportReceipt && typeof plan.exportReceipt === "object" ? plan.exportReceipt : null,
            publicationReceipts: Array.isArray(plan.publicationReceipts)
              ? plan.publicationReceipts.map(normalizeReceipt).filter(Boolean)
              : [],
            canceledAt: typeof plan.canceledAt === "string" ? plan.canceledAt : null
          };
        })
      : []
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
  if (version < MINIMUM_SUPPORTED_SCHEMA_VERSION || !Number.isInteger(version)) {
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
      advisorSettings: { displayName: "Advisor" },
      clipperJobs: Array.isArray(state.clipperJobs)
        ? state.clipperJobs.map((job) => ({
            ...job,
            status: "legacy_plan",
            legacy: true
          }))
        : []
    };
  }
  if (state.schemaVersion === 4) {
    const advisorSettings =
      state.advisorSettings && typeof state.advisorSettings === "object" && !Array.isArray(state.advisorSettings)
        ? clone(state.advisorSettings)
        : { displayName: "Advisor" };
    if (advisorSettings.displayName === "Advisor") advisorSettings.displayName = "Juanito";
    state = {
      ...state,
      schemaVersion: 5,
      advisorSettings
    };
  }
  if (state.schemaVersion === 5) {
    state = {
      ...state,
      schemaVersion: 6,
      mediaJobs: Array.isArray(state.mediaJobs)
        ? state.mediaJobs.map((job) => ({
            ...job,
            jobType: "clip_generation",
            projectId: null,
            renderPlanVersion: null,
            renderPlanHash: null
          }))
        : []
    };
  }
  if (state.schemaVersion === 6) {
    state = {
      ...state,
      schemaVersion: 7,
      voiceLikeness: { acceptance: null, voices: [] }
    };
  }
  if (state.schemaVersion === 7) {
    // Give every integration a public authorization record. Defaults come
    // first so an existing record is preserved rather than reset -- unlike the
    // v5->v6 and v6->v7 steps above, which are safe only because their version
    // gates prevent re-entry.
    state = {
      ...state,
      schemaVersion: 8,
      integrations: Array.isArray(state.integrations)
        ? state.integrations.map((integration) => ({
            ...integration,
            authorization: normalizeAuthorizationRecord(integration?.authorization)
          }))
        : []
    };
  }
  if (state.schemaVersion === 8) {
    // Give every post plan a publication receipt list. Defaults first, so an
    // existing list survives.
    state = {
      ...state,
      schemaVersion: 9,
      postQueue: Array.isArray(state.postQueue)
        ? state.postQueue.map((plan) => ({
            ...plan,
            publicationReceipts: Array.isArray(plan?.publicationReceipts)
              ? plan.publicationReceipts.map(normalizeReceipt).filter(Boolean)
              : []
          }))
        : []
    };
  }
  if (state.schemaVersion === 9) {
    // Seed per-destination publishing options. Options with no safe default
    // stay null, so an existing plan is visibly incomplete rather than being
    // given an invented audience declaration. Its approval snapshot keeps
    // version 1 and is still verified against the v1 payload shape.
    state = {
      ...state,
      schemaVersion: 10,
      postQueue: Array.isArray(state.postQueue)
        ? state.postQueue.map((plan) => ({
            ...plan,
            platformPackages: Array.isArray(plan?.platformPackages)
              ? plan.platformPackages.map((item) => ({
                  ...item,
                  options: item?.options === undefined ? seedPublishingOptions(item?.platformId) : item.options
                }))
              : []
          }))
        : []
    };
  }
  return withDefaults(state);
}

// v1 predates per-destination publishing options; v2 includes them. Both must
// keep validating, so the payload used to recompute a snapshot's hash is
// reconstructed in the shape that snapshot was created with.
const SUPPORTED_APPROVAL_VERSIONS = new Set([1, 2]);

function approvalPayloadForVersion(plan, version) {
  const platformPackages =
    version === 1
      ? // Key order matters: JSON.stringify feeds the hash.
        plan.platformPackages.map((item) => ({ platformId: item.platformId, title: item.title, caption: item.caption }))
      : plan.platformPackages;
  return {
    planId: plan.id,
    title: plan.title,
    caption: plan.caption,
    platformPackages,
    schedule: plan.schedule,
    media: plan.mediaSnapshot
  };
}

// Structure only, deliberately.
//
// This used to require a saved plan's option keys to exactly equal the live
// registry's, and to reject any value outside the registry's current choices.
// The registry is code; a saved plan is data the user already has, and it
// outlives any particular set of definitions. So a purely additive release --
// one new YouTube option, one retired enum value -- made every existing plan
// fail validateState. That is not a contained failure: loadRecoverableState
// preserves the file, tries the backup, fails there identically because it has
// the same shape, and falls back to createInitialState(). The user opens an
// empty app, having lost the visible history of every business, media job and
// post plan to a change that only added a field.
//
// The option values are still checked where checking is safe: on write by
// validatePostPlanDraft, at approval by assertPublishingOptionsComplete, and at
// dispatch by the connector. Refusing there is recoverable. Refusing here is
// not, so here only asks whether this is a plausible options record at all.
//
// Approved plans are the reason this is validation rather than normalization:
// their platformPackages are hashed into the approval snapshot, so rewriting
// them on load would break the hash and cause exactly the reset it prevents.
function validatePublishingOptions(platformId, options) {
  if (options === null || options === undefined) return true;
  return typeof options === "object" && !Array.isArray(options);
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
  // Public authorization metadata must stay public: validateAuthorizationRecord
  // rejects any string field whose name ends in "token", so an edited state file
  // cannot park a real token in renderer-visible state.
  if (state.integrations.some((integration) => !validateAuthorizationRecord(integration.authorization))) {
    throw new AppError("INVALID_STATE", "The saved integration authorization data is invalid.");
  }
  if (!state.aiWorkloads || typeof state.aiWorkloads !== "object" || Array.isArray(state.aiWorkloads)) {
    throw new AppError("INVALID_STATE", "The saved AI workload assignments are invalid.");
  }
  if (!state.advisorSettings || typeof state.advisorSettings !== "object" || Array.isArray(state.advisorSettings)) {
    throw new AppError("INVALID_STATE", "The saved advisor settings are invalid.");
  }
  if (
    !state.voiceLikeness ||
    typeof state.voiceLikeness !== "object" ||
    Array.isArray(state.voiceLikeness) ||
    !Array.isArray(state.voiceLikeness.voices)
  ) {
    throw new AppError("INVALID_STATE", "The saved custom voice metadata is invalid.");
  }
  if (
    state.voiceLikeness.acceptance !== null &&
    (typeof state.voiceLikeness.acceptance !== "object" ||
      typeof state.voiceLikeness.acceptance.termsVersion !== "string" ||
      typeof state.voiceLikeness.acceptance.acceptedAt !== "string" ||
      typeof state.voiceLikeness.acceptance.legalNameHash !== "string")
  ) {
    throw new AppError("INVALID_STATE", "The saved voice-likeness acceptance is invalid.");
  }
  const customVoiceIds = new Set();
  for (const voice of state.voiceLikeness.voices) {
    if (
      !voice ||
      typeof voice !== "object" ||
      typeof voice.id !== "string" ||
      !voice.id ||
      customVoiceIds.has(voice.id) ||
      typeof voice.name !== "string" ||
      typeof voice.providerProfileId !== "string" ||
      typeof voice.createdAt !== "string"
    ) {
      throw new AppError("INVALID_STATE", "The saved custom voice metadata is invalid.");
    }
    customVoiceIds.add(voice.id);
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
      !["clip_generation", "project_prepare", "project_render"].includes(job.jobType) ||
      (job.projectId !== null && (typeof job.projectId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(job.projectId))) ||
      (job.renderPlanVersion !== null && ![1, 2].includes(job.renderPlanVersion)) ||
      (job.renderPlanHash !== null && (typeof job.renderPlanHash !== "string" || !/^[a-f0-9]{64}$/.test(job.renderPlanHash))) ||
      (job.sourcePreviewUrl !== null &&
        job.sourcePreviewUrl !== undefined &&
        (typeof job.sourcePreviewUrl !== "string" ||
          !/^produdash-media:\/\/clip\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(job.sourcePreviewUrl))) ||
      (job.sourceDuration !== null &&
        job.sourceDuration !== undefined &&
        (!Number.isFinite(job.sourceDuration) || job.sourceDuration < 0)) ||
      typeof job.outputFolderName !== "string" ||
      job.outputFolderName !== path.basename(job.outputFolderName) ||
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
      !Array.isArray(job.artifacts) ||
      !Array.isArray(job.thumbnailSelections)
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
      if (candidate.original !== undefined) {
        const original = candidate.original;
        if (
          !original ||
          typeof original.title !== "string" ||
          !Number.isFinite(original.start) ||
          !Number.isFinite(original.end) ||
          original.end <= original.start
        ) {
          throw new AppError("INVALID_STATE", "The saved original media candidate values are invalid.");
        }
      }
      if (candidate.edit !== undefined) {
        const edit = candidate.edit;
        if (
          !edit ||
          typeof edit.title !== "string" ||
          !Number.isFinite(edit.start) ||
          !Number.isFinite(edit.end) ||
          !Number.isFinite(edit.duration) ||
          edit.end <= edit.start ||
          edit.duration < 5 ||
          edit.duration > (job.jobType === "project_render" ? 21_600 : 180) ||
          (job.jobType === "project_render" &&
            (!Array.isArray(edit.segments) ||
              !edit.segments.length ||
              edit.segments.length > 100 ||
              edit.segments.some(
                (segment) =>
                  !segment ||
                  typeof segment.id !== "string" ||
                  !Number.isFinite(segment.sourceStart) ||
                  !Number.isFinite(segment.sourceEnd) ||
                  !Number.isFinite(segment.timelineStart) ||
                  !Number.isFinite(segment.duration) ||
                  segment.sourceStart < 0 ||
                  segment.sourceEnd <= segment.sourceStart
              ))) ||
          !Array.isArray(edit.captionSegments) ||
          edit.captionSegments.length > 100 ||
          edit.captionSegments.some(
            (segment) =>
              !segment ||
              typeof segment.id !== "string" ||
              typeof segment.text !== "string" ||
              !Number.isFinite(segment.start) ||
              !Number.isFinite(segment.end) ||
              segment.start < 0 ||
              segment.end <= segment.start ||
              segment.end > edit.duration
          ) ||
          !["clean", "contrast", "notebook"].includes(edit.captionStyle) ||
          !["lower", "middle", "upper"].includes(edit.captionPosition) ||
          !["standard", "social"].includes(edit.captionSafeArea) ||
          !["original", "fit_pad", "center_crop"].includes(edit.aspectTreatment) ||
          !["original", "vertical", "square", "landscape"].includes(edit.targetAspect)
        ) {
          throw new AppError("INVALID_STATE", "The saved media candidate edits are invalid.");
        }
      }
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
          (artifact.kind === "thumbnail" &&
            artifact.id !== undefined &&
            (typeof artifact.id !== "string" ||
              !/^artifact-[a-f0-9]{24}$/.test(artifact.id) ||
              typeof artifact.groupId !== "string" ||
              !/^thumbgroup-[a-f0-9]{20}$/.test(artifact.groupId) ||
              !["local_render", "user_import"].includes(artifact.source) ||
              (artifact.positionRatio !== null &&
                (!Number.isFinite(artifact.positionRatio) || artifact.positionRatio < 0 || artifact.positionRatio > 1)) ||
              (artifact.source === "user_import" && artifact.positionRatio !== null) ||
              artifact.previewUrl !== `produdash-media://job-thumbnail/${artifact.id}`)) ||
          Object.hasOwn(artifact, "path")
      )
    ) {
      throw new AppError("INVALID_STATE", "The saved media job artifacts are invalid.");
    }
    const thumbnailArtifacts = new Map(
      job.artifacts.filter((artifact) => artifact.kind === "thumbnail" && artifact.id).map((artifact) => [artifact.id, artifact])
    );
    const selectedGroups = new Set();
    if (
      job.thumbnailSelections.some((selection) => {
        const artifact = thumbnailArtifacts.get(selection?.artifactId);
        if (
          !selection ||
          typeof selection.groupId !== "string" ||
          !/^thumbgroup-[a-f0-9]{20}$/.test(selection.groupId) ||
          typeof selection.artifactId !== "string" ||
          typeof selection.selectedAt !== "string" ||
          !artifact ||
          artifact.groupId !== selection.groupId ||
          selectedGroups.has(selection.groupId)
        ) {
          return true;
        }
        selectedGroups.add(selection.groupId);
        return false;
      })
    ) {
      throw new AppError("INVALID_STATE", "The saved preferred thumbnail selections are invalid.");
    }
  }
  const postPlanIds = new Set();
  const postStatuses = POST_PLAN_STATUS_VALUES;
  for (const plan of state.postQueue) {
    if (
      typeof plan.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(plan.id) ||
      postPlanIds.has(plan.id) ||
      typeof plan.title !== "string" ||
      plan.title.length < 1 ||
      plan.title.length > 120 ||
      typeof plan.caption !== "string" ||
      plan.caption.length > 2200 ||
      !Array.isArray(plan.platforms) ||
      plan.platforms.some((platformId) => !CREATOR_PLATFORM_IDS.has(platformId)) ||
      !postStatuses.has(plan.status) ||
      (plan.contentHash !== null && !/^[a-f0-9]{64}$/.test(plan.contentHash)) ||
      (plan.mediaJobId !== null && (typeof plan.mediaJobId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(plan.mediaJobId))) ||
      !Array.isArray(plan.platformPackages) ||
      plan.platformPackages.length !== plan.platforms.length ||
      !plan.schedule ||
      typeof plan.schedule !== "object" ||
      !["unscheduled", "planned_local_only"].includes(plan.schedule.mode) ||
      (plan.schedule.mode === "unscheduled"
        ? plan.schedule.scheduledFor !== null || plan.schedule.timeZone !== null
        : typeof plan.schedule.scheduledFor !== "string" || typeof plan.schedule.timeZone !== "string")
    ) {
      throw new AppError("INVALID_STATE", "The saved publishing plans are invalid.");
    }
    postPlanIds.add(plan.id);
    const packagePlatforms = new Set();
    for (const item of plan.platformPackages) {
      if (
        !item ||
        typeof item.platformId !== "string" ||
        !plan.platforms.includes(item.platformId) ||
        packagePlatforms.has(item.platformId) ||
        typeof item.title !== "string" ||
        item.title.length < 1 ||
        item.title.length > 120 ||
        typeof item.caption !== "string" ||
        item.caption.length > 2200 ||
        !validatePublishingOptions(item.platformId, item.options)
      ) {
        throw new AppError("INVALID_STATE", "The saved platform publishing packages are invalid.");
      }
      packagePlatforms.add(item.platformId);
    }
    if (plan.schedule.mode === "planned_local_only") {
      try {
        if (!Number.isFinite(Date.parse(plan.schedule.scheduledFor))) throw new Error("Invalid schedule");
        new Intl.DateTimeFormat("en-US", { timeZone: plan.schedule.timeZone }).format(new Date(0));
      } catch {
        throw new AppError("INVALID_STATE", "The saved publishing schedule is invalid.");
      }
    }
    if (
      plan.mediaSnapshot !== null &&
      (!plan.mediaSnapshot ||
        typeof plan.mediaSnapshot !== "object" ||
        typeof plan.mediaSnapshot.mediaJobId !== "string" ||
        typeof plan.mediaSnapshot.title !== "string" ||
        typeof plan.mediaSnapshot.outputFolderName !== "string" ||
        plan.mediaSnapshot.outputFolderName !== path.basename(plan.mediaSnapshot.outputFolderName) ||
        !Array.isArray(plan.mediaSnapshot.videos) ||
        plan.mediaSnapshot.videos.length > 20 ||
        !Array.isArray(plan.mediaSnapshot.preferredThumbnails) ||
        plan.mediaSnapshot.preferredThumbnails.length > 20 ||
        plan.mediaSnapshot.videos.some(
          (artifact) => !artifact || typeof artifact.name !== "string" || artifact.name !== path.basename(artifact.name)
        ) ||
        plan.mediaSnapshot.preferredThumbnails.some(
          (artifact) =>
            !artifact ||
            typeof artifact.name !== "string" ||
            artifact.name !== path.basename(artifact.name) ||
            !["local_render", "user_import"].includes(artifact.source)
        ))
    ) {
      throw new AppError("INVALID_STATE", "The saved publishing media snapshot is invalid.");
    }
    if (plan.approvalSnapshot !== null) {
      // Snapshots are versioned because the payload shape grew. A v1 snapshot
      // predates per-destination publishing options, so its hash must be
      // recomputed from the v1 shape -- otherwise every already-approved plan
      // would fail INVALID_STATE and the app would refuse to boot.
      const version = plan.approvalSnapshot?.version;
      const expectedPayload = approvalPayloadForVersion(plan, version);
      const expectedHash = crypto.createHash("sha256").update(JSON.stringify(expectedPayload)).digest("hex");
      if (
        !plan.approvalSnapshot ||
        !SUPPORTED_APPROVAL_VERSIONS.has(version) ||
        plan.approvalSnapshot.hash !== expectedHash ||
        !["manual_export", "official_api"].includes(plan.approvalSnapshot.mode) ||
        typeof plan.approvalSnapshot.approvedAt !== "string" ||
        JSON.stringify(plan.approvalSnapshot.payload) !== JSON.stringify(expectedPayload) ||
        !Array.isArray(plan.approvalSnapshot.destinations) ||
        plan.approvalSnapshot.destinations.length !== plan.platforms.length ||
        plan.approvalSnapshot.destinations.some((destination) => {
          const expectedKey = crypto.createHash("sha256").update(`${plan.id}:${destination?.platformId}:${expectedHash}`).digest("hex");
          return !destination || !plan.platforms.includes(destination.platformId) || destination.idempotencyKey !== expectedKey;
        })
      ) {
        throw new AppError("INVALID_STATE", "The saved publishing approval snapshot is invalid.");
      }
    }
    if (
      plan.exportReceipt !== null &&
      (!plan.exportReceipt ||
        typeof plan.exportReceipt.exportedAt !== "string" ||
        (plan.exportReceipt.snapshotHash !== null && !/^[a-f0-9]{64}$/.test(plan.exportReceipt.snapshotHash)))
    ) {
      throw new AppError("INVALID_STATE", "The saved publishing export receipt is invalid.");
    }
    // Publication receipts must stay free of tokens, secrets, and absolute
    // paths, and must belong to this plan.
    if (
      !Array.isArray(plan.publicationReceipts) ||
      plan.publicationReceipts.some((receipt) => !validateReceipt(receipt) || receipt.planId !== plan.id)
    ) {
      throw new AppError("INVALID_STATE", "The saved publication receipts are invalid.");
    }
  }
  if (
    typeof state.advisorSettings.displayName !== "string" ||
    state.advisorSettings.displayName.length < 1 ||
    state.advisorSettings.displayName.length > 40
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
