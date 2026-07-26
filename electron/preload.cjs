const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

function normalizeMediaJobEvent(value) {
  if (!value || typeof value !== "object" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.jobId)) return null;
  if (value.terminal === true) return { jobId: value.jobId, terminal: true };
  if (
    typeof value.stage !== "string" ||
    !/^[a-z_]{1,40}$/.test(value.stage) ||
    !Number.isFinite(value.progress) ||
    typeof value.detail !== "string"
  )
    return null;
  return {
    jobId: value.jobId,
    stage: value.stage,
    progress: Math.max(0, Math.min(100, value.progress)),
    detail: value.detail.slice(0, 200)
  };
}

function normalizeAdvisorEvent(value) {
  if (!value || typeof value !== "object" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.requestId)) return null;
  const type = String(value.type || "");
  if (!["started", "tool", "message", "completed", "canceled", "error"].includes(type)) return null;
  if (type === "started") {
    return {
      requestId: value.requestId,
      type,
      providerId: String(value.providerId || "").slice(0, 128),
      providerName: String(value.providerName || "").slice(0, 200),
      modelId: String(value.modelId || "").slice(0, 200)
    };
  }
  if (type === "tool") {
    return { requestId: value.requestId, type, name: String(value.name || "").slice(0, 128) };
  }
  if (type === "message") {
    const turn = value.turn;
    if (!turn || turn.role !== "assistant" || typeof turn.text !== "string" || turn.text.length > 12000) return null;
    return {
      requestId: value.requestId,
      type,
      turn: {
        id: String(turn.id || "").slice(0, 128),
        role: "assistant",
        text: turn.text,
        at: String(turn.at || "").slice(0, 40),
        providerId: String(turn.providerId || "").slice(0, 128),
        modelId: String(turn.modelId || "").slice(0, 200),
        usage: turn.usage && typeof turn.usage === "object" ? turn.usage : null,
        tools: Array.isArray(turn.tools) ? turn.tools.map((item) => String(item).slice(0, 128)).slice(0, 5) : []
      }
    };
  }
  if (type === "error") {
    return {
      requestId: value.requestId,
      type,
      error: {
        code: String(value.error?.code || "ADVISOR_FAILED").slice(0, 100),
        message: String(value.error?.message || "Advisor could not complete that request.").slice(0, 500)
      }
    };
  }
  return { requestId: value.requestId, type };
}

contextBridge.exposeInMainWorld("produdash", {
  getAppState: () => invoke("produdash:getAppState"),
  getAnalyticsReport: (businessId, rangeDays) => invoke("produdash:getAnalyticsReport", { businessId, rangeDays }),
  exportAnalyticsReport: (businessId, rangeDays) => invoke("produdash:exportAnalyticsReport", { businessId, rangeDays }),
  getAdvisorHistory: () => invoke("produdash:getAdvisorHistory"),
  grantAdvisorConsent: (profileId, dataCategories) => invoke("produdash:grantAdvisorConsent", { profileId, dataCategories }),
  sendAdvisorTurn: (payload) => invoke("produdash:sendAdvisorTurn", payload),
  cancelAdvisorTurn: (requestId) => invoke("produdash:cancelAdvisorTurn", { requestId }),
  clearAdvisorHistory: () => invoke("produdash:clearAdvisorHistory"),
  updateAdvisorSettings: (values) => invoke("produdash:updateAdvisorSettings", values),
  onAdvisorEvent: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => {
      const normalized = normalizeAdvisorEvent(value);
      if (normalized) callback(normalized);
    };
    ipcRenderer.on("produdash:advisorEvent", listener);
    return () => ipcRenderer.removeListener("produdash:advisorEvent", listener);
  },
  getAiProviderCatalog: () => invoke("produdash:getAiProviderCatalog"),
  scanLocalVoiceCompatibility: () => invoke("produdash:scanLocalVoiceCompatibility"),
  draftAiReply: (conversationId, prompt) => invoke("produdash:draftAiReply", { conversationId, prompt }),
  approveAiAction: (actionId) => invoke("produdash:approveAiAction", { actionId }),
  rejectAiAction: (actionId) => invoke("produdash:rejectAiAction", { actionId }),
  completeCommand: (commandId) => invoke("produdash:completeCommand", { commandId }),
  resetDashboardData: () => invoke("produdash:resetDashboardData"),
  deleteAllLocalData: () => invoke("produdash:deleteAllLocalData"),
  saveIntegrationCredentials: (integrationId, values) => invoke("produdash:saveIntegrationCredentials", { integrationId, values }),
  removeIntegrationCredentials: (integrationId) => invoke("produdash:removeIntegrationCredentials", { integrationId }),
  refreshIntegration: (integrationId) => invoke("produdash:refreshIntegration", { integrationId }),
  refreshConnections: () => invoke("produdash:refreshConnections"),
  saveAiProviderCredentials: (profileId, values) => invoke("produdash:saveAiProviderCredentials", { profileId, values }),
  testAiProvider: (profileId) => invoke("produdash:testAiProvider", { profileId }),
  removeAiProviderCredentials: (profileId) => invoke("produdash:removeAiProviderCredentials", { profileId }),
  setAiWorkload: (workloadId, selection) => invoke("produdash:setAiWorkload", { workloadId, selection }),
  createCustomVoice: (payload) => invoke("produdash:createCustomVoice", payload),
  removeCustomVoice: (payload) => invoke("produdash:removeCustomVoice", payload),
  chooseLocalProviderFile: (profileId, fieldKey) => invoke("produdash:chooseLocalProviderFile", { profileId, fieldKey }),
  getClipLibrary: (options) => invoke("produdash:getClipLibrary", options),
  rebuildClipSearchIndex: () => invoke("produdash:rebuildClipSearchIndex", {}),
  cancelClipSearchIndex: () => invoke("produdash:cancelClipSearchIndex", {}),
  getProjects: (options) => invoke("produdash:getProjects", options),
  getBrandTemplates: () => invoke("produdash:getBrandTemplates"),
  getBrandAssets: () => invoke("produdash:getBrandAssets"),
  importBrandAsset: (kind) => invoke("produdash:importBrandAsset", { kind }),
  deleteBrandAsset: (assetId) => invoke("produdash:deleteBrandAsset", { assetId }),
  createBrandTemplate: (values) => invoke("produdash:createBrandTemplate", values),
  updateBrandTemplate: (templateId, values) => invoke("produdash:updateBrandTemplate", { templateId, values }),
  deleteBrandTemplate: (templateId) => invoke("produdash:deleteBrandTemplate", { templateId }),
  applyBrandTemplate: (projectId, templateId) => invoke("produdash:applyBrandTemplate", { projectId, templateId }),
  importBrandTemplate: () => invoke("produdash:importBrandTemplate"),
  exportBrandTemplate: (templateId) => invoke("produdash:exportBrandTemplate", { templateId }),
  getProject: (projectId) => invoke("produdash:getProject", { projectId }),
  createProject: (payload) => invoke("produdash:createProject", payload),
  importProjectDocument: () => invoke("produdash:importProjectDocument"),
  exportProjectDocument: (projectId) => invoke("produdash:exportProjectDocument", { projectId }),
  updateProject: (projectId, values) => invoke("produdash:updateProject", { projectId, values }),
  duplicateProject: (projectId) => invoke("produdash:duplicateProject", { projectId }),
  archiveProject: (projectId) => invoke("produdash:archiveProject", { projectId }),
  restoreProject: (projectId) => invoke("produdash:restoreProject", { projectId }),
  deleteProject: (projectId) => invoke("produdash:deleteProject", { projectId }),
  createProjectCollection: (name) => invoke("produdash:createProjectCollection", { name }),
  relinkProject: (projectId, sourceMediaId) => invoke("produdash:relinkProject", { projectId, sourceMediaId }),
  createProjectFromCandidate: (jobId, candidateId) => invoke("produdash:createProjectFromCandidate", { jobId, candidateId }),
  saveProjectDraft: (projectId, renderPlan, expectedRevision) =>
    invoke("produdash:saveProjectDraft", { projectId, renderPlan, expectedRevision }),
  translateProjectTranscript: (payload) => invoke("produdash:translateProjectTranscript", payload),
  generateProjectVoiceover: (payload) => invoke("produdash:generateProjectVoiceover", payload),
  generateProjectSpeakerVoiceovers: (payload) => invoke("produdash:generateProjectSpeakerVoiceovers", payload),
  convertProjectVoiceover: (payload) => invoke("produdash:convertProjectVoiceover", payload),
  deleteProjectVoiceover: (payload) => invoke("produdash:deleteProjectVoiceover", payload),
  saveProjectVersion: (projectId, label) => invoke("produdash:saveProjectVersion", { projectId, label }),
  restoreProjectVersion: (projectId, versionId) => invoke("produdash:restoreProjectVersion", { projectId, versionId }),
  importProjectTranscript: (projectId) => invoke("produdash:importProjectTranscript", { projectId }),
  prepareProject: (projectId) => invoke("produdash:prepareProject", { projectId }),
  renderProject: (projectId, outputSelectionId) => invoke("produdash:renderProject", { projectId, outputSelectionId }),
  chooseClipFolders: () => invoke("produdash:chooseClipFolders"),
  chooseClipFiles: () => invoke("produdash:chooseClipFiles"),
  rescanClipFolder: (folderId) => invoke("produdash:rescanClipFolder", { folderId }),
  relocateClipFolder: (folderId) => invoke("produdash:relocateClipFolder", { folderId }),
  removeClipFolder: (folderId) => invoke("produdash:removeClipFolder", { folderId }),
  removeClip: (clipId) => invoke("produdash:removeClip", { clipId }),
  updateClipTags: (clipId, tags) => invoke("produdash:updateClipTags", { clipId, tags }),
  openClipInFolder: (clipId) => invoke("produdash:openClipInFolder", { clipId }),
  chooseMediaOutputFolder: () => invoke("produdash:chooseMediaOutputFolder"),
  createMediaJob: (payload) => invoke("produdash:createMediaJob", payload),
  updateMediaCandidate: (jobId, candidateId, values) => invoke("produdash:updateMediaCandidate", { jobId, candidateId, values }),
  approveMediaCandidates: (jobId, candidateIds) => invoke("produdash:approveMediaCandidates", { jobId, candidateIds }),
  cancelMediaJob: (jobId) => invoke("produdash:cancelMediaJob", { jobId }),
  retryMediaJob: (jobId) => invoke("produdash:retryMediaJob", { jobId }),
  selectMediaJobThumbnail: (jobId, thumbnailId) => invoke("produdash:selectMediaJobThumbnail", { jobId, thumbnailId }),
  addMediaJobThumbnail: (jobId, groupId) => invoke("produdash:addMediaJobThumbnail", { jobId, groupId }),
  openMediaJobOutput: (jobId) => invoke("produdash:openMediaJobOutput", { jobId }),
  onMediaJobEvent: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => {
      const normalized = normalizeMediaJobEvent(value);
      if (normalized) callback(normalized);
    };
    ipcRenderer.on("produdash:mediaJobEvent", listener);
    return () => ipcRenderer.removeListener("produdash:mediaJobEvent", listener);
  },
  createPostPlan: (payload) => invoke("produdash:createPostPlan", payload),
  updatePostPlanDraft: (planId, values) => invoke("produdash:updatePostPlanDraft", { planId, values }),
  approvePostPlan: (planId, mode) => invoke("produdash:approvePostPlan", { planId, mode }),
  exportPostPackage: (planId) => invoke("produdash:exportPostPackage", { planId }),
  cancelPostPlan: (planId) => invoke("produdash:cancelPostPlan", { planId })
});
