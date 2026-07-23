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
  createClipJob: (payload) => unwrap(client().createClipJob(payload)),
  createPostPlan: (payload) => unwrap(client().createPostPlan(payload)),
  approvePostPlan: (planId, mode) => unwrap(client().approvePostPlan(planId, mode)),
  markPostExported: (planId) => unwrap(client().markPostExported(planId)),
  chooseSourceVideo: () => unwrap(client().chooseSourceVideo())
};
