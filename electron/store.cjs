const fs = require("node:fs");
const path = require("node:path");
const { createInitialState } = require("./initial-state.cjs");
const { AppError } = require("./errors.cjs");
const { clone, loadRecoverableState } = require("./state-schema.cjs");
const { writeJsonAtomic } = require("./atomic-json.cjs");
const {
  boundedString,
  normalizeShopifyDomain,
  requireId,
  requireKnownIntegration,
  validateClipPayload,
  validateMediaJobPayload,
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
    return { ...clone(this.state), systemNotices: clone(this.notices) };
  }

  getBusiness(businessId) {
    const business = this.state.businesses.find((item) => item.id === businessId);
    if (!business) throw new AppError("BUSINESS_NOT_FOUND", "Business not found.");
    return business;
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
              publicValues[field.key] =
                setting.id === "shopify" && field.key === "storeDomain"
                  ? normalizeShopifyDomain(vaultValues[field.key])
                  : vaultValues[field.key];
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
    if (integrationId !== "shopify") {
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
        if (integrationId === "shopify" && field.key === "storeDomain") {
          publicValues[field.key] = normalizeShopifyDomain(value);
        } else if (field.sensitive) {
          secrets[field.key] = value;
        } else {
          publicValues[field.key] = value;
        }
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
      fallback: "Advisor"
    });
    return this.enqueueMutation(async () => {
      this.state.advisorSettings = { displayName };
      this.audit("advisor", "Updated the local Advisor display name.");
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
      const integration = integrationById(this.state, integrationId);
      integration.status = integration.id === "stripe" ? "planned" : "disconnected";
      integration.lastSync = "Not connected";
      integration.error = null;
      if (integrationId === "shopify") {
        for (const business of this.state.businesses.filter((item) => item.source === "shopify"))
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
      this.state = createInitialState();
      this.state.credentialSettings = credentialSettings;
      this.state.aiProviders = aiProviders;
      this.state.aiWorkloads = aiWorkloads;
      this.state.advisorSettings = advisorSettings;
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
      this.audit("connection", result.auditDetail || `${integration.name} connection updated to ${result.status}.`);
      this.persist();
      return this.getAppState();
    });
  }

  async applyShopifySync(snapshot) {
    return this.enqueueMutation(async () => {
      const integration = integrationById(this.state, "shopify");
      const existing = this.state.businesses.find((business) => business.shopifyShopId === snapshot.business.shopifyShopId);
      if (existing) Object.assign(existing, snapshot.business);
      else this.state.businesses.unshift(snapshot.business);
      integration.status = snapshot.status;
      integration.lastSync = snapshot.syncedAt;
      integration.error = snapshot.error || null;
      this.state.selectedBusinessId = snapshot.business.id;
      this.audit("shopify_sync", `Synchronized ${snapshot.business.name} through the official Shopify Admin API.`);
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
    validateMediaJobPayload({
      ...summary?.settings,
      sourceMediaId: summary?.sourceMediaId,
      outputSelectionId: "validated-selection",
      title: summary?.title,
      goal: summary?.goal,
      platforms: summary?.settings?.platforms
    });
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
      "error",
      "retryable",
      "startedAt",
      "updatedAt",
      "completedAt"
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
    const input = validatePostPayload(payload, this.state.clipperJobs);
    return this.enqueueMutation(async () => {
      this.state.postQueue.unshift({
        id: createId("post"),
        ...input,
        status: "needs_approval",
        policyGate: "Human approval is required before manual export or any future official API publishing path.",
        createdAt: new Date().toISOString()
      });
      this.audit("publisher", `Created approval-gated post plan: ${input.title}.`);
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
      if (mode === "official_api") {
        if (!plan.platforms.length) throw new AppError("INVALID_INPUT", "Select at least one publishing destination.");
        const ready = plan.platforms.every((platformId) =>
          this.state.integrations.some((item) => item.id === platformId && item.status === "connected")
        );
        if (!ready) throw new AppError("INTEGRATION_NOT_READY", "Every publishing destination must be genuinely connected.");
      }
      plan.status = targetStatus;
      plan.approvedAt = new Date().toISOString();
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
      this.audit("publisher", `Marked approved post plan export-ready: ${plan.title}.`);
      this.persist();
      return this.getAppState();
    });
  }
}

module.exports = { AUDIT_LIMIT, ProduDashStore };
