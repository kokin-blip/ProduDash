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

contextBridge.exposeInMainWorld("produdash", {
  getAppState: () => invoke("produdash:getAppState"),
  getAiProviderCatalog: () => invoke("produdash:getAiProviderCatalog"),
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
  getClipLibrary: (options) => invoke("produdash:getClipLibrary", options),
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
  approveMediaCandidates: (jobId, candidateIds) => invoke("produdash:approveMediaCandidates", { jobId, candidateIds }),
  cancelMediaJob: (jobId) => invoke("produdash:cancelMediaJob", { jobId }),
  retryMediaJob: (jobId) => invoke("produdash:retryMediaJob", { jobId }),
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
  approvePostPlan: (planId, mode) => invoke("produdash:approvePostPlan", { planId, mode }),
  markPostExported: (planId) => invoke("produdash:markPostExported", { planId })
});
