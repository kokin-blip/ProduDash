const fs = require("fs");
const path = require("path");
const { createInitialState } = require("./initial-state.cjs");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function withInitialDefaults(state) {
  const initial = createInitialState();
  return {
    ...initial,
    ...state,
    integrations: initial.integrations.map((integration) => {
      const existing = state.integrations?.find((item) => item.id === integration.id);
      return existing ? { ...integration, ...existing } : integration;
    }),
    credentialSettings: initial.credentialSettings.map((setting) => {
      const existing = state.credentialSettings?.find((item) => item.id === setting.id);
      return existing ? { ...setting, ...existing, fields: setting.fields } : setting;
    }),
    creatorPlatforms: initial.creatorPlatforms.map((platform) => {
      const existing = state.creatorPlatforms?.find((item) => item.id === platform.id);
      return existing ? { ...platform, ...existing } : platform;
    }),
    analyticsSources: initial.analyticsSources.map((source) => {
      const existing = state.analyticsSources?.find((item) => item.id === source.id);
      return existing ? { ...source, ...existing } : source;
    }),
    clipperJobs: state.clipperJobs || [],
    postQueue: state.postQueue || []
  };
}

class ProduDashStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "produdash-state.json");
    this.credentialsPath = path.join(userDataPath, "produdash-credentials.json");
    this.state = this.load();
    this.syncCredentialStatus();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const persisted = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        if (persisted.schemaVersion === 2) return withInitialDefaults(persisted);
      }
    } catch {
      // Fall through to a clean initial state if local data is corrupt.
    }
    const initial = createInitialState();
    this.write(initial);
    return initial;
  }

  write(nextState = this.state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(nextState, null, 2));
  }

  resetLocalData() {
    const credentialSettings = clone(this.state.credentialSettings || []);
    this.state = createInitialState();
    this.state.credentialSettings = credentialSettings;
    this.audit("system", "Local connection state cleared.");
    this.write();
    return this.getAppState();
  }

  getAppState() {
    return clone(this.state);
  }

  getBusiness(businessId) {
    const business = this.state.businesses.find((item) => item.id === businessId);
    if (!business) throw new Error(`Business not found: ${businessId}`);
    return business;
  }

  saveBusinessSettings(businessId, settings) {
    const business = this.getBusiness(businessId);
    if (Array.isArray(settings.aiPolicy)) business.aiPolicy = settings.aiPolicy;
    if (Array.isArray(settings.automations)) business.automations = settings.automations;
    if (typeof settings.aiMode === "string") business.aiMode = settings.aiMode;
    this.audit("settings", `Updated settings for ${business.name}.`);
    this.write();
    return this.getAppState();
  }

  listConversations(businessId) {
    return clone(this.state.conversations.filter((item) => item.businessId === businessId));
  }

  draftAiReply(conversationId, prompt, geminiConnector) {
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);
    const business = this.getBusiness(conversation.businessId);
    const result = geminiConnector.draftReply(conversation, prompt, business);
    const approval = {
      id: createId("approval"),
      businessId: business.id,
      conversationId,
      type: "reply",
      status: "pending",
      draft: result.draft,
      riskFlags: ["human_approval_required", conversation.risk],
      createdAt: new Date().toISOString(),
      aiSummary: result.summary,
      nextAction: result.nextAction
    };
    this.state.approvals.unshift(approval);
    conversation.status = "needs_approval";
    this.audit("ai_draft", `Created draft for ${conversation.customer} in ${business.name}.`);
    this.write();
    return { state: this.getAppState(), approval: clone(approval) };
  }

  approveAiAction(actionId) {
    const approval = this.state.approvals.find((item) => item.id === actionId);
    if (!approval) throw new Error(`Approval not found: ${actionId}`);
    approval.status = "approved";
    approval.resolvedAt = new Date().toISOString();
    const conversation = this.state.conversations.find((item) => item.id === approval.conversationId);
    if (conversation) {
      conversation.status = "approved";
      conversation.messages.push({ role: "ai", text: approval.draft });
    }
    this.audit("approval", `Approved AI ${approval.type} action ${actionId}.`);
    this.write();
    return this.getAppState();
  }

  rejectAiAction(actionId) {
    const approval = this.state.approvals.find((item) => item.id === actionId);
    if (!approval) throw new Error(`Approval not found: ${actionId}`);
    approval.status = "rejected";
    approval.resolvedAt = new Date().toISOString();
    const conversation = this.state.conversations.find((item) => item.id === approval.conversationId);
    if (conversation) conversation.status = "human_review";
    this.audit("rejection", `Rejected AI ${approval.type} action ${actionId}.`);
    this.write();
    return this.getAppState();
  }

  completeCommand(commandId) {
    for (const business of this.state.businesses) {
      const command = business.commands.find((item) => item.id === commandId);
      if (command) {
        command.status = "completed";
        command.completedAt = new Date().toISOString();
        this.audit("command", `Completed command: ${command.title}.`);
        this.write();
        return this.getAppState();
      }
    }
    throw new Error(`Command not found: ${commandId}`);
  }

  createClipJob(payload) {
    const title = typeof payload?.title === "string" && payload.title.trim() ? payload.title.trim() : "Untitled clip job";
    const platforms = Array.isArray(payload?.platforms) ? payload.platforms.filter(Boolean) : [];
    const job = {
      id: createId("clip"),
      title,
      source: typeof payload?.source === "string" ? payload.source.trim() : "",
      goal: typeof payload?.goal === "string" ? payload.goal.trim() : "",
      targetLength: typeof payload?.targetLength === "string" ? payload.targetLength.trim() : "30-45 seconds",
      platforms,
      status: "queued",
      outputs: [],
      createdAt: new Date().toISOString()
    };
    this.state.clipperJobs.unshift(job);
    this.audit("clipper", `Queued auto-clip plan: ${job.title}.`);
    this.write();
    return this.getAppState();
  }

  createPostPlan(payload) {
    const platforms = Array.isArray(payload?.platforms) ? payload.platforms.filter(Boolean) : [];
    const plan = {
      id: createId("post"),
      clipJobId: payload?.clipJobId || null,
      title: typeof payload?.title === "string" && payload.title.trim() ? payload.title.trim() : "Untitled post plan",
      caption: typeof payload?.caption === "string" ? payload.caption.trim() : "",
      scheduledFor: typeof payload?.scheduledFor === "string" ? payload.scheduledFor.trim() : "",
      platforms,
      status: "needs_approval",
      policyGate: "Use only official publishing APIs or manual export. No browser bots, emulators, or scraped sessions.",
      createdAt: new Date().toISOString()
    };
    this.state.postQueue.unshift(plan);
    this.audit("publisher", `Created approval-gated post plan: ${plan.title}.`);
    this.write();
    return this.getAppState();
  }

  approvePostPlan(planId) {
    const plan = this.state.postQueue.find((item) => item.id === planId);
    if (!plan) throw new Error(`Post plan not found: ${planId}`);
    plan.status = "approved_for_official_api";
    plan.approvedAt = new Date().toISOString();
    this.audit("publisher", `Approved post plan for official API/manual export: ${plan.title}.`);
    this.write();
    return this.getAppState();
  }

  markPostExported(planId) {
    const plan = this.state.postQueue.find((item) => item.id === planId);
    if (!plan) throw new Error(`Post plan not found: ${planId}`);
    plan.status = "export_ready";
    plan.exportedAt = new Date().toISOString();
    this.audit("publisher", `Marked post plan export-ready: ${plan.title}.`);
    this.write();
    return this.getAppState();
  }

  readCredentials() {
    try {
      if (!fs.existsSync(this.credentialsPath)) return {};
      return JSON.parse(fs.readFileSync(this.credentialsPath, "utf8"));
    } catch {
      return {};
    }
  }

  writeCredentials(credentials) {
    fs.mkdirSync(path.dirname(this.credentialsPath), { recursive: true });
    fs.writeFileSync(this.credentialsPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(this.credentialsPath, 0o600);
    } catch {
      // Best effort only; some filesystems ignore POSIX permissions.
    }
  }

  syncCredentialStatus() {
    const credentials = this.readCredentials();
    this.state.credentialSettings = (this.state.credentialSettings || createInitialState().credentialSettings).map((setting) => {
      const saved = credentials[setting.id] || {};
      const configuredFields = setting.fields
        .filter((field) => typeof saved[field.key] === "string" && saved[field.key].trim())
        .map((field) => field.key);
      return {
        ...setting,
        status: configuredFields.length === setting.fields.length ? "configured" : "missing",
        configuredFields,
        updatedAt: saved.updatedAt || null
      };
    });
  }

  saveIntegrationCredentials(integrationId, values) {
    const setting = this.state.credentialSettings.find((item) => item.id === integrationId);
    if (!setting) throw new Error(`Credential setting not found: ${integrationId}`);

    const allowedKeys = new Set(setting.fields.map((field) => field.key));
    const sanitizedValues = {};
    for (const [key, value] of Object.entries(values || {})) {
      if (!allowedKeys.has(key)) continue;
      if (typeof value === "string" && value.trim()) sanitizedValues[key] = value.trim();
    }

    const credentials = this.readCredentials();
    credentials[integrationId] = {
      ...(credentials[integrationId] || {}),
      ...sanitizedValues,
      updatedAt: new Date().toISOString()
    };
    this.writeCredentials(credentials);
    this.syncCredentialStatus();
    this.audit("credentials", `Updated local credentials for ${setting.name}.`);
    this.write();
    return this.getAppState();
  }

  removeIntegrationCredentials(integrationId) {
    const setting = this.state.credentialSettings.find((item) => item.id === integrationId);
    if (!setting) throw new Error(`Credential setting not found: ${integrationId}`);
    const credentials = this.readCredentials();
    delete credentials[integrationId];
    this.writeCredentials(credentials);
    this.syncCredentialStatus();
    this.audit("credentials", `Removed local credentials for ${setting.name}.`);
    this.write();
    return this.getAppState();
  }

  audit(type, detail) {
    this.state.auditLog.unshift({ id: createId("audit"), at: new Date().toISOString(), type, detail });
  }
}

module.exports = { ProduDashStore, clone };
