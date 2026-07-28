const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createInitialState } = require("./initial-state.cjs");
const { AppError } = require("./errors.cjs");
const { clone, loadRecoverableState } = require("./state-schema.cjs");
const { writeJsonAtomic } = require("./atomic-json.cjs");
const { buildAnalyticsReport } = require("./analytics-report.cjs");
const { getPlatform } = require("./platforms/registry.cjs");
const { buildPlatformCatalog } = require("./platforms/catalog.cjs");
const { DISPATCHABLE_STATUSES, POST_PLAN_STATUSES, assertTransition } = require("./publishing/post-status.cjs");
const { isAlreadyPublished, normalizeReceipt } = require("./publishing/receipt.cjs");
const { TOKEN_VAULT_KEYS, createAuthorizationRecord, normalizeAuthorizationRecord } = require("./platforms/authorization.cjs");
const {
  assertPublishingOptionsComplete,
  boundedString,
  normalizePublicCredentialValue,
  requireId,
  requireKnownIntegration,
  validateClipPayload,
  validateMediaJobPayload,
  validatePostPlanDraft,
  validatePostPayload
} = require("./validation.cjs");

const AUDIT_LIMIT = 500;

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function integrationById(state, integrationId) {
  const integration = state.integrations.find((item) => item.id === integrationId);
  if (!integration) throw new AppError("INTEGRATION_NOT_FOUND", "Integration not found.");
  return integration;
}

function publishingMediaSnapshot(state, mediaJobId) {
  if (!mediaJobId) return null;
  const job = state.mediaJobs.find((item) => item.id === mediaJobId);
  if (!job || job.status !== "completed") {
    throw new AppError("MEDIA_JOB_NOT_READY", "The rendered media selected for this post plan is unavailable.");
  }
  const videos = job.artifacts
    .filter((artifact) => artifact.kind === "video")
    .map((artifact) => ({ name: path.basename(artifact.name) }))
    .slice(0, 20);
  if (!videos.length) throw new AppError("MEDIA_JOB_NOT_READY", "The selected media job has no completed video artifact.");
  const thumbnails = (job.thumbnailSelections || [])
    .map((selection) => job.artifacts.find((artifact) => artifact.kind === "thumbnail" && artifact.id === selection.artifactId))
    .filter(Boolean)
    .map((artifact) => ({ name: path.basename(artifact.name), source: artifact.source }))
    .slice(0, 20);
  return {
    mediaJobId: job.id,
    title: job.title,
    outputFolderName: job.outputFolderName,
    videos,
    preferredThumbnails: thumbnails,
    completedAt: job.completedAt || job.updatedAt
  };
}

function publishingApprovalSnapshot(plan, mode, mediaSnapshot) {
  const approvedAt = new Date().toISOString();
  const payload = {
    planId: plan.id,
    title: plan.title,
    caption: plan.caption,
    platformPackages: plan.platformPackages,
    schedule: plan.schedule,
    media: mediaSnapshot
  };
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return {
    // v2 adds per-destination publishing options to the payload. v1 snapshots
    // remain valid and are verified against their own shape.
    version: 2,
    hash,
    mode,
    approvedAt,
    payload,
    destinations: plan.platforms.map((platformId) => ({
      platformId,
      idempotencyKey: crypto.createHash("sha256").update(`${plan.id}:${platformId}:${hash}`).digest("hex")
    }))
  };
}

function publishingContentHash(plan) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        clipJobId: plan.clipJobId,
        mediaJobId: plan.mediaJobId,
        title: plan.title,
        caption: plan.caption,
        scheduledFor: plan.scheduledFor,
        timeZone: plan.timeZone,
        platforms: plan.platforms,
        platformPackages: plan.platformPackages
      })
    )
    .digest("hex");
}

class ProduDashStore {
  constructor(userDataPath, options = {}) {
    this.userDataPath = userDataPath;
    this.filePath = path.join(userDataPath, "produdash-state.json");
    this.credentialVault = options.credentialVault;
    const loaded = loadRecoverableState(this.filePath);
    this.state = loaded.state;
    this.notices = loaded.notices;
    this.mutationQueue = Promise.resolve();
  }

  async initialize() {
    if (!this.credentialVault) return;
    const notices = await this.credentialVault.initialize();
    this.notices.push(...notices);
    await this.syncCredentialStatus();
  }

  getAppState() {
    const state = clone(this.state);
    return { ...state, systemNotices: clone(this.notices), platformCatalog: buildPlatformCatalog(state) };
  }

  getBusiness(businessId) {
    const business = this.state.businesses.find((item) => item.id === businessId);
    if (!business) throw new AppError("BUSINESS_NOT_FOUND", "Business not found.");
    return business;
  }

  getAnalyticsReport(businessId, rangeDays) {
    return buildAnalyticsReport(this.state, businessId, { rangeDays });
  }

  getConversation(conversationId) {
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "Conversation not found.");
    return conversation;
  }

  enqueueMutation(callback) {
    const run = this.mutationQueue.then(callback, callback);
    this.mutationQueue = run.catch(() => {});
    return run;
  }

  persist() {
    this.state.auditLog = this.state.auditLog.slice(0, AUDIT_LIMIT);
    writeJsonAtomic(this.filePath, this.state);
  }

  audit(type, detail) {
    this.state.auditLog.unshift({ id: createId("audit"), at: new Date().toISOString(), type, detail });
    this.state.auditLog = this.state.auditLog.slice(0, AUDIT_LIMIT);
  }

  async syncCredentialStatus() {
    if (!this.credentialVault) return this.getAppState();
    return this.enqueueMutation(async () => {
      const settings = [];
      for (const setting of this.state.credentialSettings) {
        const vaultValues = this.credentialVault.get(setting.id);
        const secretValues = { ...vaultValues };
        const publicValues = setting.publicValues || {};
        let publicMetadataMoved = false;
        for (const field of setting.fields.filter((item) => !item.sensitive)) {
          if (!publicValues[field.key] && typeof vaultValues[field.key] === "string" && vaultValues[field.key]) {
            try {
              publicValues[field.key] = normalizePublicCredentialValue(setting.id, field.key, vaultValues[field.key]);
              publicMetadataMoved = true;
            } catch {
              continue;
            }
          }
          if (publicValues[field.key]) delete secretValues[field.key];
        }
        if (publicMetadataMoved) await this.credentialVault.replace(setting.id, secretValues);
        const secretKeys = new Set(this.credentialVault.keys(setting.id));
        const configuredFields = setting.fields
          .filter((field) => (field.sensitive ? secretKeys.has(field.key) : Boolean(publicValues[field.key])))
          .map((field) => field.key);
        settings.push({
          ...setting,
          publicValues,
          configuredFields,
          status: configuredFields.length === setting.fields.length ? "stored" : "missing"
        });
      }
      this.state.credentialSettings = settings;
      // Token presence is derived from the vault, never stored twice. The
      // record says only whether a token exists, not what it is.
      for (const integration of this.state.integrations) {
        const secretKeys = new Set(this.credentialVault.keys(integration.id));
        const authorization = normalizeAuthorizationRecord(integration.authorization);
        authorization.hasAccessToken = secretKeys.has(TOKEN_VAULT_KEYS.ACCESS);
        authorization.hasRefreshToken = secretKeys.has(TOKEN_VAULT_KEYS.REFRESH);
        integration.authorization = authorization;
      }
      for (const profile of this.state.aiProviders) {
        const keys = this.credentialVault.keys(profile.id);
        profile.credentialStatus = keys.length ? "stored" : "missing";
        if (!keys.length && profile.status === "connected") profile.status = "disconnected";
      }
      this.persist();
      return this.getAppState();
    });
  }

  async saveIntegrationCredentials(integrationId, values) {
    requireKnownIntegration(integrationId);
    // Accepting credentials for a platform with no connector behind it would
    // leave the user with secrets on disk that nothing can ever verify.
    if (!getPlatform(integrationId).capabilities.hasLiveConnector) {
      throw new AppError("INTEGRATION_UNAVAILABLE", "This provider connector is planned and does not accept credentials yet.");
    }
    if (!this.credentialVault) throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure credential storage is unavailable.");
    return this.enqueueMutation(async () => {
      const setting = this.state.credentialSettings.find((item) => item.id === integrationId);
      if (!setting) throw new AppError("INTEGRATION_NOT_FOUND", "Credential settings were not found.");
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw new AppError("INVALID_INPUT", "Credential values must be an object.");
      }

      const secrets = {};
      const publicValues = { ...(setting.publicValues || {}) };
      for (const field of setting.fields) {
        const submitted = values[field.key];
        if (submitted === undefined || submitted === "") continue;
        const value = boundedString(submitted, { label: field.label, min: 1, max: field.sensitive ? 4096 : 253 });
        if (field.sensitive) secrets[field.key] = value;
        else publicValues[field.key] = normalizePublicCredentialValue(integrationId, field.key, value);
      }

      if (Object.keys(secrets).length) await this.credentialVault.save(integrationId, secrets);
      setting.publicValues = publicValues;
      setting.updatedAt = new Date().toISOString();
      const secretKeys = new Set(this.credentialVault.keys(integrationId));
      setting.configuredFields = setting.fields
        .filter((field) => (field.sensitive ? secretKeys.has(field.key) : Boolean(publicValues[field.key])))
        .map((field) => field.key);
      setting.status = setting.configuredFields.length === setting.fields.length ? "stored" : "missing";
      this.audit("credentials", `Updated secure credentials for ${setting.name}.`);
      this.persist();
      return this.getAppState();
    });
  }

  getIntegrationCredentials(integrationId) {
    requireKnownIntegration(integrationId);
    if (!this.credentialVault) throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure credential storage is unavailable.");
    const setting = this.state.credentialSettings.find((item) => item.id === integrationId);
    if (!setting) throw new AppError("INTEGRATION_NOT_FOUND", "Credential settings were not found.");
    return { ...(setting.publicValues || {}), ...this.credentialVault.get(integrationId) };
  }

  getAiProvider(profileId) {
    requireId(profileId, "AI provider");
    const profile = this.state.aiProviders.find((item) => item.id === profileId);
    if (!profile) throw new AppError("AI_PROVIDER_NOT_FOUND", "AI provider profile not found.");
    return clone(profile);
  }

  getAiWorkload(workloadId) {
    return clone(this.state.aiWorkloads[workloadId] || null);
  }

  async syncAiProviderCredentialStatus(resolveFields) {
    return this.enqueueMutation(async () => {
      for (const profile of this.state.aiProviders) {
        const resolved = resolveFields(profile.providerType, clone(profile));
        if (!resolved) continue;
        const fields = Array.isArray(resolved) ? resolved : resolved.credentialFields;
        if (!Array.isArray(resolved)) {
          profile.name = resolved.name;
          profile.models = clone(resolved.models);
          if (!profile.models.some((model) => model.id === profile.selectedModelId)) {
            profile.selectedModelId = profile.models[0]?.id || null;
          }
        }
        const secretKeys = new Set(this.credentialVault ? this.credentialVault.keys(profile.id) : []);
        const publicValues = profile.publicValues || {};
        const configured = fields.filter((field) => (field.sensitive ? secretKeys.has(field.key) : Boolean(publicValues[field.key])));
        profile.credentialStatus = fields
          .filter((field) => field.required !== false)
          .every((field) => configured.some((item) => item.key === field.key))
          ? "stored"
          : "missing";
        if (profile.credentialStatus === "missing" && profile.status === "connected") profile.status = "disconnected";
      }
      this.persist();
      return this.getAppState();
    });
  }

  async saveAiProviderCredentials(profileId, values, fields) {
    const profile = this.getAiProvider(profileId);
    if (!this.credentialVault) throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure credential storage is unavailable.");
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new AppError("INVALID_INPUT", "AI provider credentials must be an object.");
    }
    return this.enqueueMutation(async () => {
      const secrets = {};
      const publicValues = { ...(profile.publicValues || {}) };
      for (const field of fields) {
        const submitted = values[field.key];
        if (submitted === undefined || submitted === "") continue;
        const value = boundedString(submitted, {
          label: field.label,
          min: 1,
          max: field.sensitive ? 4096 : 2048
        });
        if (field.sensitive) secrets[field.key] = value;
        else publicValues[field.key] = value;
      }
      if (Object.keys(secrets).length) await this.credentialVault.save(profileId, secrets);
      const current = this.state.aiProviders.find((item) => item.id === profileId);
      current.publicValues = publicValues;
      const secretKeys = new Set(this.credentialVault.keys(profileId));
      const ready = fields
        .filter((field) => field.required !== false)
        .every((field) => (field.sensitive ? secretKeys.has(field.key) : Boolean(publicValues[field.key])));
      current.credentialStatus = ready ? "stored" : "missing";
      current.status = "disconnected";
      current.error = null;
      this.audit("ai_provider", `Updated secure credentials for ${current.name}.`);
      this.persist();
      return this.getAppState();
    });
  }

  getAiProviderCredentials(profileId) {
    const profile = this.getAiProvider(profileId);
    if (!this.credentialVault) throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure credential storage is unavailable.");
    return { ...(profile.publicValues || {}), ...this.credentialVault.get(profileId) };
  }

  async removeAiProviderCredentials(profileId) {
    const profile = this.getAiProvider(profileId);
    if (!this.credentialVault) throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure credential storage is unavailable.");
    return this.enqueueMutation(async () => {
      await this.credentialVault.remove(profileId);
      const current = this.state.aiProviders.find((item) => item.id === profileId);
      current.publicValues = {};
      current.credentialStatus = "missing";
      current.status = "disconnected";
      current.error = null;
      current.lastValidatedAt = null;
      this.audit("ai_provider", `Removed secure credentials for ${profile.name}.`);
      this.persist();
      return this.getAppState();
    });
  }

  async setAiProviderResult(profileId, result) {
    this.getAiProvider(profileId);
    return this.enqueueMutation(async () => {
      const profile = this.state.aiProviders.find((item) => item.id === profileId);
      profile.status = result.status;
      profile.error = result.error || null;
      profile.lastValidatedAt = result.lastValidatedAt || new Date().toISOString();
      this.audit("ai_provider", `${profile.name} connection updated to ${profile.status}.`);
      this.persist();
      return this.getAppState();
    });
  }

  async updateAiProviderModels(profileId, models, selectedModelId) {
    this.getAiProvider(profileId);
    return this.enqueueMutation(async () => {
      const profile = this.state.aiProviders.find((item) => item.id === profileId);
      profile.models = clone(Array.isArray(models) ? models : []);
      profile.selectedModelId =
        selectedModelId && profile.models.some((model) => model.id === selectedModelId) ? selectedModelId : profile.models[0]?.id || null;
      this.persist();
      return this.getAppState();
    });
  }

  async setAiWorkload(workloadId, selection) {
    return this.enqueueMutation(async () => {
      this.state.aiWorkloads[workloadId] = clone(selection);
      this.audit("ai_workload", `Updated the ${workloadId} AI workload assignment.`);
      this.persist();
      return this.getAppState();
    });
  }

  async updateAdvisorSettings(values) {
    const displayName = boundedString(values?.displayName, {
      label: "Advisor display name",
      min: 1,
      max: 40,
      fallback: "Juanito"
    });
    return this.enqueueMutation(async () => {
      this.state.advisorSettings = { displayName };
      this.audit("advisor", "Updated the local Advisor display name.");
      this.persist();
      return this.getAppState();
    });
  }

  hasCurrentVoiceLikenessAcceptance(termsVersion) {
    return this.state.voiceLikeness?.acceptance?.termsVersion === termsVersion;
  }

  async acceptVoiceLikenessTerms(acceptance) {
    return this.enqueueMutation(async () => {
      this.state.voiceLikeness = this.state.voiceLikeness || { acceptance: null, voices: [] };
      this.state.voiceLikeness.acceptance = {
        termsVersion: acceptance.termsVersion,
        acceptedAt: new Date().toISOString(),
        relationship: acceptance.relationship,
        legalNameHash: crypto.createHash("sha256").update(acceptance.legalName).digest("hex")
      };
      this.audit("voice_likeness", "Accepted the custom voice and likeness terms.");
      this.persist();
      return this.getAppState();
    });
  }

  async addCustomVoice(voice) {
    return this.enqueueMutation(async () => {
      this.state.voiceLikeness = this.state.voiceLikeness || { acceptance: null, voices: [] };
      this.state.voiceLikeness.voices = this.state.voiceLikeness.voices.filter(
        (item) => !(item.providerProfileId === voice.providerProfileId && item.id === voice.id)
      );
      this.state.voiceLikeness.voices.push(clone(voice));
      this.audit("voice_likeness", `Added the custom voice “${voice.name}”.`);
      this.persist();
      return this.getAppState();
    });
  }

  async removeCustomVoice(providerProfileId, voiceId) {
    const profileId = requireId(providerProfileId, "Voice provider");
    const id = requireId(voiceId, "Custom voice");
    return this.enqueueMutation(async () => {
      this.state.voiceLikeness = this.state.voiceLikeness || { acceptance: null, voices: [] };
      const voice = this.state.voiceLikeness.voices.find((item) => item.providerProfileId === profileId && item.id === id);
      if (!voice) throw new AppError("CUSTOM_VOICE_NOT_FOUND", "The selected custom voice is unavailable.");
      this.state.voiceLikeness.voices = this.state.voiceLikeness.voices.filter(
        (item) => !(item.providerProfileId === profileId && item.id === id)
      );
      this.audit("voice_likeness", `Removed the custom voice “${voice.name}” from ProduDash.`);
      this.persist();
      return this.getAppState();
    });
  }

  async removeIntegrationCredentials(integrationId) {
    requireKnownIntegration(integrationId);
    if (!this.credentialVault) throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure credential storage is unavailable.");
    return this.enqueueMutation(async () => {
      const setting = this.state.credentialSettings.find((item) => item.id === integrationId);
      if (!setting) throw new AppError("INTEGRATION_NOT_FOUND", "Credential settings were not found.");
      await this.credentialVault.remove(integrationId);
      setting.publicValues = {};
      setting.configuredFields = [];
      setting.status = "missing";
      setting.updatedAt = new Date().toISOString();
      const platform = getPlatform(integrationId);
      const integration = integrationById(this.state, integrationId);
      integration.status = platform.defaultStatus;
      integration.lastSync = "Not connected";
      integration.error = null;
      // Removing credentials removes the tokens too, so nothing about the old
      // authorization remains true.
      integration.authorization = createAuthorizationRecord();
      if (platform.capabilities.ownsBusinessRecords) {
        for (const business of this.state.businesses.filter((item) => item.source === integrationId))
          business.connectionStatus = "disconnected";
      }
      this.audit("credentials", `Removed secure credentials for ${setting.name}; imported snapshots were retained.`);
      this.persist();
      return this.getAppState();
    });
  }

  async resetDashboardData() {
    return this.enqueueMutation(async () => {
      const credentialSettings = clone(this.state.credentialSettings);
      const aiProviders = clone(this.state.aiProviders).map((profile) => ({
        ...profile,
        status: "disconnected",
        error: null,
        lastValidatedAt: null
      }));
      const aiWorkloads = clone(this.state.aiWorkloads);
      const advisorSettings = clone(this.state.advisorSettings);
      const voiceLikeness = clone(this.state.voiceLikeness);
      this.state = createInitialState();
      this.state.credentialSettings = credentialSettings;
      this.state.aiProviders = aiProviders;
      this.state.aiWorkloads = aiWorkloads;
      this.state.advisorSettings = advisorSettings;
      this.state.voiceLikeness = voiceLikeness;
      this.audit("system", "Dashboard data reset. Secure credentials were retained.");
      this.persist();
      return this.getAppState();
    });
  }

  async deleteAllLocalData() {
    return this.enqueueMutation(async () => {
      if (this.credentialVault) await this.credentialVault.clearAll();
      const baseName = path.basename(this.filePath);
      if (fs.existsSync(this.userDataPath)) {
        for (const entry of fs.readdirSync(this.userDataPath)) {
          if (entry === baseName || entry === `${baseName}.bak` || entry.startsWith(`${baseName}.recovery-`)) {
            fs.unlinkSync(path.join(this.userDataPath, entry));
          }
        }
      }
      this.state = createInitialState();
      this.notices = [{ code: "ALL_DATA_DELETED", message: "All ProduDash dashboard data and credentials were deleted." }];
      this.persist();
      return this.getAppState();
    });
  }

  async setIntegrationResult(integrationId, result) {
    requireKnownIntegration(integrationId);
    return this.enqueueMutation(async () => {
      const integration = integrationById(this.state, integrationId);
      integration.status = result.status;
      integration.lastSync = result.lastSync || new Date().toISOString();
      integration.error = result.error || null;
      if (result.detail) integration.detail = result.detail;
      integration.authorization = this.stampVerification(integration, result.status);
      this.audit("connection", result.auditDetail || `${integration.name} connection updated to ${result.status}.`);
      this.persist();
      return this.getAppState();
    });
  }

  // Records when a provider request last actually succeeded. Only a real
  // connected or degraded result counts -- an error must not refresh it.
  stampVerification(integration, status) {
    const authorization = normalizeAuthorizationRecord(integration.authorization);
    if (status === "connected" || status === "degraded") authorization.lastVerifiedAt = new Date().toISOString();
    return authorization;
  }

  // Persists tokens to the vault and the matching public metadata to state.
  // Storing an authorization is deliberately NOT the same as verifying a
  // connection: the integration status is untouched here and only moves after
  // a real provider request succeeds.
  async saveIntegrationAuthorization(integrationId, { accessToken, refreshToken, ...metadata } = {}) {
    requireKnownIntegration(integrationId);
    if (!this.credentialVault) throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure credential storage is unavailable.");
    if (!getPlatform(integrationId).capabilities.hasLiveConnector) {
      throw new AppError("INTEGRATION_UNAVAILABLE", "This provider connector is planned and cannot be authorized yet.");
    }
    const secrets = {};
    if (accessToken) secrets[TOKEN_VAULT_KEYS.ACCESS] = boundedString(accessToken, { label: "Access token", min: 1, max: 4096 });
    if (refreshToken) secrets[TOKEN_VAULT_KEYS.REFRESH] = boundedString(refreshToken, { label: "Refresh token", min: 1, max: 4096 });
    if (Object.keys(secrets).length) await this.credentialVault.save(integrationId, secrets);

    return this.enqueueMutation(async () => {
      const integration = integrationById(this.state, integrationId);
      const secretKeys = new Set(this.credentialVault.keys(integrationId));
      const authorization = normalizeAuthorizationRecord({
        ...normalizeAuthorizationRecord(integration.authorization),
        ...metadata
      });
      authorization.hasAccessToken = secretKeys.has(TOKEN_VAULT_KEYS.ACCESS);
      authorization.hasRefreshToken = secretKeys.has(TOKEN_VAULT_KEYS.REFRESH);
      integration.authorization = authorization;
      this.audit("authorization", `Stored authorization metadata for ${integration.name}.`);
      this.persist();
      return this.getAppState();
    });
  }

  // Clears the tokens and the authorization record without discarding the
  // user's own application configuration, so they can reauthorize without
  // re-entering their client id and secret.
  async clearIntegrationAuthorization(integrationId) {
    requireKnownIntegration(integrationId);
    if (!this.credentialVault) throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure credential storage is unavailable.");
    const remaining = { ...this.credentialVault.get(integrationId) };
    delete remaining[TOKEN_VAULT_KEYS.ACCESS];
    delete remaining[TOKEN_VAULT_KEYS.REFRESH];
    await this.credentialVault.replace(integrationId, remaining);
    return this.enqueueMutation(async () => {
      const platform = getPlatform(integrationId);
      const integration = integrationById(this.state, integrationId);
      integration.authorization = createAuthorizationRecord();
      integration.status = platform.defaultStatus;
      integration.lastSync = "Not connected";
      integration.error = null;
      this.audit("authorization", `Removed stored authorization for ${integration.name}.`);
      this.persist();
      return this.getAppState();
    });
  }

  // Applies a connection result that carried a business snapshot. Only platforms
  // declaring ownsBusinessRecords produce one; everything else goes through
  // setIntegrationResult instead.
  async applyConnectorSnapshot(integrationId, snapshot) {
    const platform = getPlatform(integrationId);
    if (!platform.capabilities.ownsBusinessRecords) {
      throw new AppError("INTEGRATION_UNAVAILABLE", `${platform.displayName} does not import business records.`);
    }
    return this.enqueueMutation(async () => {
      const integration = integrationById(this.state, integrationId);
      // Business ids are derived deterministically from the provider's own
      // account id, so matching on id is equivalent to matching the raw
      // provider key while staying platform-neutral.
      const existing = this.state.businesses.find((business) => business.source === integrationId && business.id === snapshot.business.id);
      if (existing) Object.assign(existing, snapshot.business);
      else this.state.businesses.unshift(snapshot.business);
      integration.status = snapshot.status;
      integration.lastSync = snapshot.syncedAt;
      integration.error = snapshot.error || null;
      integration.authorization = this.stampVerification(integration, snapshot.status);
      this.state.selectedBusinessId = snapshot.business.id;
      this.audit(
        `${integrationId}_sync`,
        snapshot.auditDetail || `Synchronized ${snapshot.business.name} through the official ${platform.displayName} API.`
      );
      this.persist();
      return this.getAppState();
    });
  }

  async draftAiReply(conversationId, prompt, providerConnector) {
    requireId(conversationId, "Conversation");
    const instruction = boundedString(prompt, { label: "Draft instruction", min: 1, max: 2000 });
    const conversation = clone(this.getConversation(conversationId));
    const business = clone(this.getBusiness(conversation.businessId));
    if (this.state.approvals.some((item) => item.conversationId === conversationId && item.type === "reply" && item.status === "pending")) {
      throw new AppError("PENDING_APPROVAL_EXISTS", "Resolve the existing reply draft before creating another.");
    }
    const result = await providerConnector.draftReply(conversation, instruction, business);
    return this.enqueueMutation(async () => {
      if (
        this.state.approvals.some((item) => item.conversationId === conversationId && item.type === "reply" && item.status === "pending")
      ) {
        throw new AppError("PENDING_APPROVAL_EXISTS", "Resolve the existing reply draft before creating another.");
      }
      const currentConversation = this.getConversation(conversationId);
      const approval = {
        id: createId("approval"),
        businessId: business.id,
        conversationId,
        type: "reply",
        status: "pending",
        draft: result.draft,
        riskFlags: result.riskFlags,
        createdAt: new Date().toISOString(),
        aiSummary: result.summary,
        intent: result.intent,
        orderDetails: result.orderDetails,
        nextAction: result.recommendedAction
      };
      this.state.approvals.unshift(approval);
      currentConversation.status = "needs_approval";
      this.audit("ai_draft", `Created an approval-only draft for ${currentConversation.customer || "a customer"}.`);
      this.persist();
      return { state: this.getAppState(), approval: clone(approval) };
    });
  }

  async resolveAiAction(actionId, targetStatus) {
    requireId(actionId, "Approval");
    if (!["approved", "rejected"].includes(targetStatus)) throw new AppError("INVALID_INPUT", "Approval status is invalid.");
    return this.enqueueMutation(async () => {
      const approval = this.state.approvals.find((item) => item.id === actionId);
      if (!approval) throw new AppError("APPROVAL_NOT_FOUND", "Approval not found.");
      if (approval.status === targetStatus) return this.getAppState();
      if (approval.status !== "pending") throw new AppError("INVALID_TRANSITION", "This approval has already been resolved.");
      approval.status = targetStatus;
      approval.resolvedAt = new Date().toISOString();
      const conversation = this.state.conversations.find((item) => item.id === approval.conversationId);
      if (conversation) {
        conversation.status = targetStatus === "approved" ? "draft_approved" : "human_review";
        if (targetStatus === "approved" && !conversation.messages.some((message) => message.approvalId === approval.id)) {
          conversation.messages.push({ role: "ai_draft", text: approval.draft, approvalId: approval.id });
        }
      }
      this.audit(
        targetStatus === "approved" ? "approval" : "rejection",
        `${targetStatus === "approved" ? "Approved" : "Rejected"} AI draft ${actionId}.`
      );
      this.persist();
      return this.getAppState();
    });
  }

  approveAiAction(actionId) {
    return this.resolveAiAction(actionId, "approved");
  }

  rejectAiAction(actionId) {
    return this.resolveAiAction(actionId, "rejected");
  }

  async completeCommand(commandId) {
    requireId(commandId, "Command");
    return this.enqueueMutation(async () => {
      for (const business of this.state.businesses) {
        const command = (business.commands || []).find((item) => item.id === commandId);
        if (!command) continue;
        if (command.status === "completed") return this.getAppState();
        command.status = "completed";
        command.completedAt = new Date().toISOString();
        this.audit("command", `Completed command: ${command.title}.`);
        this.persist();
        return this.getAppState();
      }
      throw new AppError("COMMAND_NOT_FOUND", "Command not found.");
    });
  }

  async createClipJob(payload) {
    const input = validateClipPayload(payload);
    return this.enqueueMutation(async () => {
      this.state.clipperJobs.unshift({
        id: createId("clip"),
        ...input,
        status: "planned_local_only",
        outputs: [],
        createdAt: new Date().toISOString()
      });
      this.audit("clipper", `Created local-only clip plan: ${input.title}.`);
      this.persist();
      return this.getAppState();
    });
  }

  getMediaJob(jobId) {
    requireId(jobId, "Media job");
    const job = this.state.mediaJobs.find((item) => item.id === jobId);
    if (!job) throw new AppError("MEDIA_JOB_NOT_FOUND", "Media job not found.");
    return clone(job);
  }

  async createMediaJobSummary(summary) {
    requireId(summary?.id, "Media job");
    if ((summary?.jobType || "clip_generation") === "clip_generation") {
      validateMediaJobPayload({
        ...summary?.settings,
        sourceMediaId: summary?.sourceMediaId,
        outputSelectionId: "validated-selection",
        title: summary?.title,
        goal: summary?.goal,
        platforms: summary?.settings?.platforms
      });
    }
    return this.enqueueMutation(async () => {
      if (this.state.mediaJobs.some((job) => job.id === summary.id)) {
        throw new AppError("MEDIA_JOB_EXISTS", "A media job with this identifier already exists.");
      }
      this.state.mediaJobs.unshift(clone(summary));
      this.audit("media_job", `Queued deterministic media job: ${summary.title}.`);
      this.persist();
      return this.getAppState();
    });
  }

  async detachProjectMediaJobs(projectId) {
    requireId(projectId, "Project");
    return this.enqueueMutation(async () => {
      let changed = false;
      for (const job of this.state.mediaJobs) {
        if (job.projectId !== projectId) continue;
        job.projectId = null;
        job.updatedAt = new Date().toISOString();
        changed = true;
      }
      if (changed) {
        this.audit("project", `Detached retained media jobs from deleted project ${projectId}.`);
        this.persist();
      }
      return this.getAppState();
    });
  }

  async updateMediaJobSummary(jobId, patch, auditDetail = "") {
    requireId(jobId, "Media job");
    const allowed = new Set([
      "status",
      "stage",
      "progress",
      "candidates",
      "selectedCandidateIds",
      "warnings",
      "artifacts",
      "thumbnailSelections",
      "error",
      "retryable",
      "startedAt",
      "updatedAt",
      "completedAt",
      "sourceDuration"
    ]);
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some((key) => !allowed.has(key))) {
      throw new AppError("INVALID_INPUT", "Media job update is invalid.");
    }
    return this.enqueueMutation(async () => {
      const job = this.state.mediaJobs.find((item) => item.id === jobId);
      if (!job) throw new AppError("MEDIA_JOB_NOT_FOUND", "Media job not found.");
      Object.assign(job, clone(patch), { updatedAt: patch.updatedAt || new Date().toISOString() });
      if (auditDetail) this.audit("media_job", auditDetail);
      this.persist();
      return this.getAppState();
    });
  }

  async interruptActiveMediaJobs() {
    return this.enqueueMutation(async () => {
      let changed = false;
      for (const job of this.state.mediaJobs) {
        if (!["processing", "canceling"].includes(job.status)) continue;
        job.status = "interrupted";
        job.stage = "interrupted";
        job.error = "ProduDash closed before this media job finished. Retry to continue from validated local artifacts.";
        job.retryable = true;
        job.updatedAt = new Date().toISOString();
        changed = true;
      }
      if (changed) {
        this.audit("media_job", "Marked unfinished media work as interrupted after restart.");
        this.persist();
      }
      return this.getAppState();
    });
  }

  async createPostPlan(payload) {
    const input = validatePostPayload(payload, this.state.clipperJobs, this.state.mediaJobs);
    return this.enqueueMutation(async () => {
      const mediaSnapshot = publishingMediaSnapshot(this.state, input.mediaJobId);
      const contentHash = publishingContentHash(input);
      if (this.state.postQueue.some((plan) => plan.contentHash === contentHash && plan.status !== "canceled")) {
        return this.getAppState();
      }
      this.state.postQueue.unshift({
        id: createId("post"),
        ...input,
        contentHash,
        mediaSnapshot,
        schedule: {
          mode: input.scheduledFor ? "planned_local_only" : "unscheduled",
          scheduledFor: input.scheduledFor || null,
          timeZone: input.scheduledFor ? input.timeZone : null
        },
        approvalSnapshot: null,
        exportReceipt: null,
        publicationReceipts: [],
        canceledAt: null,
        status: "needs_approval",
        policyGate: "Human approval is required before manual export or any future official API publishing path.",
        createdAt: new Date().toISOString()
      });
      this.audit("publisher", `Created approval-gated post plan: ${input.title}.`);
      this.persist();
      return this.getAppState();
    });
  }

  async updatePostPlanDraft(planId, payload) {
    requireId(planId, "Post plan");
    return this.enqueueMutation(async () => {
      const plan = this.state.postQueue.find((item) => item.id === planId);
      if (!plan) throw new AppError("POST_PLAN_NOT_FOUND", "Post plan not found.");
      if (plan.status !== "needs_approval") {
        throw new AppError("POST_PLAN_LOCKED", "Approved, exported, and canceled publishing plans cannot be edited.");
      }
      const input = validatePostPlanDraft(payload, plan.platforms);
      if (
        JSON.stringify(plan.platformPackages) === JSON.stringify(input.platformPackages) &&
        JSON.stringify(plan.schedule) === JSON.stringify(input.schedule)
      ) {
        return this.getAppState();
      }
      const contentHash = publishingContentHash({ ...plan, ...input });
      if (this.state.postQueue.some((item) => item.id !== plan.id && item.contentHash === contentHash && item.status !== "canceled")) {
        throw new AppError("POST_PLAN_DUPLICATE", "An identical active publishing plan already exists.");
      }
      plan.platformPackages = input.platformPackages;
      plan.scheduledFor = input.scheduledFor;
      plan.timeZone = input.timeZone;
      plan.schedule = input.schedule;
      plan.contentHash = contentHash;
      plan.updatedAt = new Date().toISOString();
      this.audit("publisher", `Updated destination copy and local schedule for ${plan.title}.`);
      this.persist();
      return this.getAppState();
    });
  }

  async approvePostPlan(planId, mode = "manual_export") {
    requireId(planId, "Post plan");
    if (!["manual_export", "official_api"].includes(mode)) throw new AppError("INVALID_INPUT", "Approval mode is invalid.");
    return this.enqueueMutation(async () => {
      const plan = this.state.postQueue.find((item) => item.id === planId);
      if (!plan) throw new AppError("POST_PLAN_NOT_FOUND", "Post plan not found.");
      const targetStatus = mode === "manual_export" ? "approved_for_manual_export" : "approved_for_official_api";
      if (plan.status === targetStatus) return this.getAppState();
      if (plan.status !== "needs_approval") throw new AppError("INVALID_TRANSITION", "This post plan cannot enter that approval path.");
      // Plan completeness is checked before connection readiness so someone
      // with an unfinished plan is told that first, rather than connecting an
      // account and only then discovering a second problem.
      assertPublishingOptionsComplete(plan.platformPackages);
      if (mode === "official_api") {
        if (!plan.platforms.length) throw new AppError("INVALID_INPUT", "Select at least one publishing destination.");
        const ready = plan.platforms.every((platformId) =>
          this.state.integrations.some((item) => item.id === platformId && item.status === "connected")
        );
        if (!ready) throw new AppError("INTEGRATION_NOT_READY", "Every publishing destination must be genuinely connected.");
      }
      const mediaSnapshot = publishingMediaSnapshot(this.state, plan.mediaJobId);
      plan.mediaSnapshot = mediaSnapshot;
      plan.approvalSnapshot = publishingApprovalSnapshot(plan, mode, mediaSnapshot);
      plan.status = targetStatus;
      plan.approvedAt = plan.approvalSnapshot.approvedAt;
      this.audit("publisher", `Approved ${plan.title} for ${mode === "manual_export" ? "manual export" : "official API publishing"}.`);
      this.persist();
      return this.getAppState();
    });
  }

  async markPostExported(planId) {
    requireId(planId, "Post plan");
    return this.enqueueMutation(async () => {
      const plan = this.state.postQueue.find((item) => item.id === planId);
      if (!plan) throw new AppError("POST_PLAN_NOT_FOUND", "Post plan not found.");
      if (plan.status === "export_ready") return this.getAppState();
      if (plan.status !== "approved_for_manual_export") {
        throw new AppError("INVALID_TRANSITION", "Approve this plan for manual export first.");
      }
      plan.status = "export_ready";
      plan.exportedAt = new Date().toISOString();
      plan.exportReceipt = {
        exportedAt: plan.exportedAt,
        snapshotHash: plan.approvalSnapshot?.hash || null
      };
      this.audit("publisher", `Marked approved post plan export-ready: ${plan.title}.`);
      this.persist();
      return this.getAppState();
    });
  }

  requirePostPlan(planId) {
    const plan = this.state.postQueue.find((item) => item.id === planId);
    if (!plan) throw new AppError("POST_PLAN_NOT_FOUND", "Post plan not found.");
    return plan;
  }

  // Moves an approved plan into dispatch. Retrying a failed dispatch is allowed
  // and safe: the idempotency keys in the approval snapshot are what prevent a
  // second upload of the same approved content.
  async beginPostPlanDispatch(planId) {
    requireId(planId, "Post plan");
    return this.enqueueMutation(async () => {
      const plan = this.requirePostPlan(planId);
      if (!DISPATCHABLE_STATUSES.has(plan.status)) {
        throw new AppError("INVALID_TRANSITION", "Approve this plan for official API publishing first.");
      }
      if (!plan.approvalSnapshot) throw new AppError("INVALID_TRANSITION", "This plan has no approval snapshot.");
      assertTransition(plan.status, POST_PLAN_STATUSES.DISPATCHING);
      plan.status = POST_PLAN_STATUSES.DISPATCHING;
      this.audit("publisher", `Started official API publishing for ${plan.title}.`);
      this.persist();
      return this.getAppState();
    });
  }

  // Receipts are keyed by idempotency key, so re-recording an attempt updates
  // the existing receipt rather than accumulating duplicates.
  async recordPublicationReceipt(planId, receipt) {
    requireId(planId, "Post plan");
    const normalized = normalizeReceipt(receipt);
    if (!normalized || normalized.planId !== planId) {
      throw new AppError("INVALID_INPUT", "The publication receipt is invalid.");
    }
    return this.enqueueMutation(async () => {
      const plan = this.requirePostPlan(planId);
      const index = plan.publicationReceipts.findIndex((item) => item.idempotencyKey === normalized.idempotencyKey);
      if (index >= 0) plan.publicationReceipts[index] = normalized;
      else plan.publicationReceipts.push(normalized);
      this.persist();
      return this.getAppState();
    });
  }

  // A plan is published only when every approved destination produced a
  // publication; anything else is a truthful dispatch failure.
  async completePostPlanDispatch(planId) {
    requireId(planId, "Post plan");
    return this.enqueueMutation(async () => {
      const plan = this.requirePostPlan(planId);
      if (plan.status !== POST_PLAN_STATUSES.DISPATCHING) return this.getAppState();
      const expected = plan.approvalSnapshot?.destinations || [];
      const published = expected.every((destination) =>
        plan.publicationReceipts.some((receipt) => receipt.idempotencyKey === destination.idempotencyKey && isAlreadyPublished(receipt))
      );
      const target = published ? POST_PLAN_STATUSES.PUBLISHED : POST_PLAN_STATUSES.DISPATCH_FAILED;
      assertTransition(plan.status, target);
      plan.status = target;
      if (published) plan.publishedAt = new Date().toISOString();
      this.audit(
        "publisher",
        published ? `Published ${plan.title} to every approved destination.` : `Official API publishing did not complete for ${plan.title}.`
      );
      this.persist();
      return this.getAppState();
    });
  }

  getPostExportPackage(planId) {
    requireId(planId, "Post plan");
    const plan = this.state.postQueue.find((item) => item.id === planId);
    if (!plan) throw new AppError("POST_PLAN_NOT_FOUND", "Post plan not found.");
    if (!["approved_for_manual_export", "export_ready"].includes(plan.status) || !plan.approvalSnapshot) {
      throw new AppError("INVALID_TRANSITION", "Approve this plan for manual export before creating an export package.");
    }
    return {
      format: "produdash-publishing-package",
      version: 1,
      exportedAt: new Date().toISOString(),
      approval: clone(plan.approvalSnapshot),
      instructions:
        "This package contains approved copy and safe generated filenames only. It does not publish media or grant access to any account."
    };
  }

  async cancelPostPlan(planId) {
    requireId(planId, "Post plan");
    return this.enqueueMutation(async () => {
      const plan = this.state.postQueue.find((item) => item.id === planId);
      if (!plan) throw new AppError("POST_PLAN_NOT_FOUND", "Post plan not found.");
      if (plan.status === "canceled") return this.getAppState();
      if (!["needs_approval", "approved_for_manual_export", "approved_for_official_api"].includes(plan.status)) {
        throw new AppError("INVALID_TRANSITION", "This post plan can no longer be canceled.");
      }
      plan.status = "canceled";
      plan.canceledAt = new Date().toISOString();
      this.audit("publisher", `Canceled local post plan: ${plan.title}.`);
      this.persist();
      return this.getAppState();
    });
  }
}

module.exports = { AUDIT_LIMIT, ProduDashStore };
