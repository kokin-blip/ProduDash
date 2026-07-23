const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld("produdash", {
  getAppState: () => invoke("produdash:getAppState"),
  saveBusinessSettings: (businessId, settings) => invoke("produdash:saveBusinessSettings", businessId, settings),
  listConversations: (businessId) => invoke("produdash:listConversations", businessId),
  draftAiReply: (conversationId, prompt) => invoke("produdash:draftAiReply", conversationId, prompt),
  approveAiAction: (actionId) => invoke("produdash:approveAiAction", actionId),
  rejectAiAction: (actionId) => invoke("produdash:rejectAiAction", actionId),
  completeCommand: (commandId) => invoke("produdash:completeCommand", commandId),
  resetLocalData: () => invoke("produdash:resetLocalData"),
  saveIntegrationCredentials: (integrationId, values) =>
    invoke("produdash:saveIntegrationCredentials", integrationId, values),
  removeIntegrationCredentials: (integrationId) => invoke("produdash:removeIntegrationCredentials", integrationId),
  createClipJob: (payload) => invoke("produdash:createClipJob", payload),
  createPostPlan: (payload) => invoke("produdash:createPostPlan", payload),
  approvePostPlan: (planId) => invoke("produdash:approvePostPlan", planId),
  markPostExported: (planId) => invoke("produdash:markPostExported", planId),
  chooseSourceVideo: () => invoke("produdash:chooseSourceVideo"),
  shopifySnapshot: (businessId) => invoke("produdash:shopifySnapshot", businessId)
});
