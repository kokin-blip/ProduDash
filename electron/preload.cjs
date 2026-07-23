const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld("produdash", {
  getAppState: () => invoke("produdash:getAppState"),
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
  createClipJob: (payload) => invoke("produdash:createClipJob", payload),
  createPostPlan: (payload) => invoke("produdash:createPostPlan", payload),
  approvePostPlan: (planId, mode) => invoke("produdash:approvePostPlan", { planId, mode }),
  markPostExported: (planId) => invoke("produdash:markPostExported", { planId }),
  chooseSourceVideo: () => invoke("produdash:chooseSourceVideo")
});
