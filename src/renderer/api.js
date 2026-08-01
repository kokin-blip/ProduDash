const missingApiMessage = "ProduDash must be opened with Electron so the secure preload API can provide local persistence.";

export class ProduDashClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProduDashClientError";
    this.code = code;
  }
}

function client() {
  if (!window.produdash) throw new ProduDashClientError("ELECTRON_REQUIRED", missingApiMessage);
  return window.produdash;
}

async function unwrap(request) {
  const response = await request;
  if (!response || typeof response !== "object") {
    throw new ProduDashClientError("INVALID_IPC_RESPONSE", "ProduDash received an invalid response from the desktop process.");
  }
  if (!response.ok)
    throw new ProduDashClientError(response.error?.code || "REQUEST_FAILED", response.error?.message || "The request failed.");
  return response.data;
}

export const api = {
  getAppState: () => unwrap(client().getAppState()),
  getAnalyticsReport: (businessId, rangeDays) => unwrap(client().getAnalyticsReport(businessId, rangeDays)),
  exportAnalyticsReport: (businessId, rangeDays) => unwrap(client().exportAnalyticsReport(businessId, rangeDays)),
  getAdvisorHistory: () => unwrap(client().getAdvisorHistory()),
  grantAdvisorConsent: (profileId, dataCategories) => unwrap(client().grantAdvisorConsent(profileId, dataCategories)),
  sendAdvisorTurn: (payload) => unwrap(client().sendAdvisorTurn(payload)),
  cancelAdvisorTurn: (requestId) => unwrap(client().cancelAdvisorTurn(requestId)),
  clearAdvisorHistory: () => unwrap(client().clearAdvisorHistory()),
  updateAdvisorSettings: (values) => unwrap(client().updateAdvisorSettings(values)),
  onAdvisorEvent: (callback) => client().onAdvisorEvent(callback),
  draftAiReply: (conversationId, prompt) => unwrap(client().draftAiReply(conversationId, prompt)),
  approveAiAction: (actionId) => unwrap(client().approveAiAction(actionId)),
  rejectAiAction: (actionId) => unwrap(client().rejectAiAction(actionId)),
  completeCommand: (commandId) => unwrap(client().completeCommand(commandId)),
  resetDashboardData: () => unwrap(client().resetDashboardData()),
  deleteAllLocalData: () => unwrap(client().deleteAllLocalData()),
  saveIntegrationCredentials: (integrationId, values) => unwrap(client().saveIntegrationCredentials(integrationId, values)),
  removeIntegrationCredentials: (integrationId) => unwrap(client().removeIntegrationCredentials(integrationId)),
  refreshIntegration: (integrationId) => unwrap(client().refreshIntegration(integrationId)),
  refreshConnections: () => unwrap(client().refreshConnections()),
  authorizeIntegration: (integrationId) => unwrap(client().authorizeIntegration(integrationId)),
  disconnectIntegration: (integrationId) => unwrap(client().disconnectIntegration(integrationId)),
  getAuthorizationInstructions: (integrationId) => unwrap(client().getAuthorizationInstructions(integrationId)),
  getAiProviderCatalog: () => unwrap(client().getAiProviderCatalog()),
  scanLocalVoiceCompatibility: () => unwrap(client().scanLocalVoiceCompatibility()),
  saveAiProviderCredentials: (profileId, values) => unwrap(client().saveAiProviderCredentials(profileId, values)),
  testAiProvider: (profileId) => unwrap(client().testAiProvider(profileId)),
  removeAiProviderCredentials: (profileId) => unwrap(client().removeAiProviderCredentials(profileId)),
  setAiWorkload: (workloadId, selection) => unwrap(client().setAiWorkload(workloadId, selection)),
  createCustomVoice: (payload) => unwrap(client().createCustomVoice(payload)),
  authorizeConfiguredLocalVoice: (payload) => unwrap(client().authorizeConfiguredLocalVoice(payload)),
  removeCustomVoice: (payload) => unwrap(client().removeCustomVoice(payload)),
  chooseLocalProviderFile: (profileId, fieldKey) => unwrap(client().chooseLocalProviderFile(profileId, fieldKey)),
  getClipLibrary: (options = {}) => unwrap(client().getClipLibrary(options)),
  rebuildClipSearchIndex: () => unwrap(client().rebuildClipSearchIndex()),
  cancelClipSearchIndex: () => unwrap(client().cancelClipSearchIndex()),
  getProjects: (options = {}) => unwrap(client().getProjects(options)),
  getBrandTemplates: () => unwrap(client().getBrandTemplates()),
  getBrandAssets: () => unwrap(client().getBrandAssets()),
  importBrandAsset: (kind) => unwrap(client().importBrandAsset(kind)),
  deleteBrandAsset: (assetId) => unwrap(client().deleteBrandAsset(assetId)),
  createBrandTemplate: (values) => unwrap(client().createBrandTemplate(values)),
  updateBrandTemplate: (templateId, values) => unwrap(client().updateBrandTemplate(templateId, values)),
  deleteBrandTemplate: (templateId) => unwrap(client().deleteBrandTemplate(templateId)),
  applyBrandTemplate: (projectId, templateId) => unwrap(client().applyBrandTemplate(projectId, templateId)),
  importBrandTemplate: () => unwrap(client().importBrandTemplate()),
  exportBrandTemplate: (templateId) => unwrap(client().exportBrandTemplate(templateId)),
  getProject: (projectId) => unwrap(client().getProject(projectId)),
  createProject: (payload) => unwrap(client().createProject(payload)),
  importProjectDocument: () => unwrap(client().importProjectDocument()),
  exportProjectDocument: (projectId) => unwrap(client().exportProjectDocument(projectId)),
  updateProject: (projectId, values) => unwrap(client().updateProject(projectId, values)),
  duplicateProject: (projectId) => unwrap(client().duplicateProject(projectId)),
  archiveProject: (projectId) => unwrap(client().archiveProject(projectId)),
  restoreProject: (projectId) => unwrap(client().restoreProject(projectId)),
  deleteProject: (projectId) => unwrap(client().deleteProject(projectId)),
  createProjectCollection: (name) => unwrap(client().createProjectCollection(name)),
  relinkProject: (projectId, sourceMediaId) => unwrap(client().relinkProject(projectId, sourceMediaId)),
  createProjectFromCandidate: (jobId, candidateId) => unwrap(client().createProjectFromCandidate(jobId, candidateId)),
  saveProjectDraft: (projectId, renderPlan, expectedRevision) => unwrap(client().saveProjectDraft(projectId, renderPlan, expectedRevision)),
  translateProjectTranscript: (payload) => unwrap(client().translateProjectTranscript(payload)),
  generateProjectVoiceover: (payload) => unwrap(client().generateProjectVoiceover(payload)),
  generateProjectSpeakerVoiceovers: (payload) => unwrap(client().generateProjectSpeakerVoiceovers(payload)),
  convertProjectVoiceover: (payload) => unwrap(client().convertProjectVoiceover(payload)),
  deleteProjectVoiceover: (payload) => unwrap(client().deleteProjectVoiceover(payload)),
  saveProjectVersion: (projectId, label) => unwrap(client().saveProjectVersion(projectId, label)),
  restoreProjectVersion: (projectId, versionId) => unwrap(client().restoreProjectVersion(projectId, versionId)),
  importProjectTranscript: (projectId) => unwrap(client().importProjectTranscript(projectId)),
  prepareProject: (projectId) => unwrap(client().prepareProject(projectId)),
  renderProject: (projectId, outputSelectionId) => unwrap(client().renderProject(projectId, outputSelectionId)),
  chooseClipFolders: () => unwrap(client().chooseClipFolders()),
  chooseClipFiles: () => unwrap(client().chooseClipFiles()),
  rescanClipFolder: (folderId) => unwrap(client().rescanClipFolder(folderId)),
  relocateClipFolder: (folderId) => unwrap(client().relocateClipFolder(folderId)),
  removeClipFolder: (folderId) => unwrap(client().removeClipFolder(folderId)),
  removeClip: (clipId) => unwrap(client().removeClip(clipId)),
  updateClipTags: (clipId, tags) => unwrap(client().updateClipTags(clipId, tags)),
  openClipInFolder: (clipId) => unwrap(client().openClipInFolder(clipId)),
  chooseMediaOutputFolder: () => unwrap(client().chooseMediaOutputFolder()),
  createMediaJob: (payload) => unwrap(client().createMediaJob(payload)),
  updateMediaCandidate: (jobId, candidateId, values) => unwrap(client().updateMediaCandidate(jobId, candidateId, values)),
  approveMediaCandidates: (jobId, candidateIds) => unwrap(client().approveMediaCandidates(jobId, candidateIds)),
  cancelMediaJob: (jobId) => unwrap(client().cancelMediaJob(jobId)),
  retryMediaJob: (jobId) => unwrap(client().retryMediaJob(jobId)),
  selectMediaJobThumbnail: (jobId, thumbnailId) => unwrap(client().selectMediaJobThumbnail(jobId, thumbnailId)),
  addMediaJobThumbnail: (jobId, groupId) => unwrap(client().addMediaJobThumbnail(jobId, groupId)),
  openMediaJobOutput: (jobId) => unwrap(client().openMediaJobOutput(jobId)),
  onMediaJobEvent: (callback) => client().onMediaJobEvent(callback),
  createPostPlan: (payload) => unwrap(client().createPostPlan(payload)),
  updatePostPlanDraft: (planId, values) => unwrap(client().updatePostPlanDraft(planId, values)),
  approvePostPlan: (planId, mode) => unwrap(client().approvePostPlan(planId, mode)),
  exportPostPackage: (planId) => unwrap(client().exportPostPackage(planId)),
  cancelPostPlan: (planId) => unwrap(client().cancelPostPlan(planId)),
  dispatchPostPlan: (planId) => unwrap(client().dispatchPostPlan(planId)),
  refreshPublicationStatus: (planId, platformId) => unwrap(client().refreshPublicationStatus(planId, platformId)),
  discardUploadSession: (planId, platformId) => unwrap(client().discardUploadSession(planId, platformId))
};
