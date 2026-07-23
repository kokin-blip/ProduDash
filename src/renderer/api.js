const missingApiMessage =
  "ProduDash must be opened with Electron so the secure preload API can provide local persistence.";

function client() {
  if (!window.produdash) {
    throw new Error(missingApiMessage);
  }
  return window.produdash;
}

export const api = {
  getAppState: () => client().getAppState(),
  saveBusinessSettings: (businessId, settings) => client().saveBusinessSettings(businessId, settings),
  listConversations: (businessId) => client().listConversations(businessId),
  draftAiReply: (conversationId, prompt) => client().draftAiReply(conversationId, prompt),
  approveAiAction: (actionId) => client().approveAiAction(actionId),
  rejectAiAction: (actionId) => client().rejectAiAction(actionId),
  completeCommand: (commandId) => client().completeCommand(commandId),
  resetLocalData: () => client().resetLocalData(),
  saveIntegrationCredentials: (integrationId, values) => client().saveIntegrationCredentials(integrationId, values),
  removeIntegrationCredentials: (integrationId) => client().removeIntegrationCredentials(integrationId),
  createClipJob: (payload) => client().createClipJob(payload),
  createPostPlan: (payload) => client().createPostPlan(payload),
  approvePostPlan: (planId) => client().approvePostPlan(planId),
  markPostExported: (planId) => client().markPostExported(planId),
  chooseSourceVideo: () => client().chooseSourceVideo(),
  shopifySnapshot: (businessId) => client().shopifySnapshot(businessId)
};
