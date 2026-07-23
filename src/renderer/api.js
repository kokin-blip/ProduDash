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
  getAiProviderCatalog: () => unwrap(client().getAiProviderCatalog()),
  saveAiProviderCredentials: (profileId, values) => unwrap(client().saveAiProviderCredentials(profileId, values)),
  testAiProvider: (profileId) => unwrap(client().testAiProvider(profileId)),
  removeAiProviderCredentials: (profileId) => unwrap(client().removeAiProviderCredentials(profileId)),
  setAiWorkload: (workloadId, selection) => unwrap(client().setAiWorkload(workloadId, selection)),
  chooseLocalWhisperFile: (kind) => unwrap(client().chooseLocalWhisperFile(kind)),
  getClipLibrary: (options = {}) => unwrap(client().getClipLibrary(options)),
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
  approveMediaCandidates: (jobId, candidateIds) => unwrap(client().approveMediaCandidates(jobId, candidateIds)),
  cancelMediaJob: (jobId) => unwrap(client().cancelMediaJob(jobId)),
  retryMediaJob: (jobId) => unwrap(client().retryMediaJob(jobId)),
  openMediaJobOutput: (jobId) => unwrap(client().openMediaJobOutput(jobId)),
  onMediaJobEvent: (callback) => client().onMediaJobEvent(callback),
  createPostPlan: (payload) => unwrap(client().createPostPlan(payload)),
  approvePostPlan: (planId, mode) => unwrap(client().approvePostPlan(planId, mode)),
  markPostExported: (planId) => unwrap(client().markPostExported(planId))
};
