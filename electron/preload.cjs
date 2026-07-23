const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
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
  createClipJob: (payload) => invoke("produdash:createClipJob", payload),
  createPostPlan: (payload) => invoke("produdash:createPostPlan", payload),
  approvePostPlan: (planId, mode) => invoke("produdash:approvePostPlan", { planId, mode }),
  markPostExported: (planId) => invoke("produdash:markPostExported", { planId }),
  chooseSourceVideo: () => invoke("produdash:chooseSourceVideo")
});
