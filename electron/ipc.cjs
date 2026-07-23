const { BrowserWindow, dialog, ipcMain } = require("electron");
const { AppError, errorResponse } = require("./errors.cjs");

function createTrustedSender(appUrl) {
  return (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return Boolean(window && event.senderFrame && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === appUrl);
  };
}

function createHandlers({ store, connections, isTrustedSender, chooseSourceVideo }) {
  const trusted = isTrustedSender || (() => false);
  const handlers = {
    "produdash:getAppState": async () => store.getAppState(),
    "produdash:draftAiReply": async (_event, payload) => connections.draftAiReply(payload?.conversationId, payload?.prompt),
    "produdash:approveAiAction": async (_event, payload) => store.approveAiAction(payload?.actionId),
    "produdash:rejectAiAction": async (_event, payload) => store.rejectAiAction(payload?.actionId),
    "produdash:completeCommand": async (_event, payload) => store.completeCommand(payload?.commandId),
    "produdash:resetDashboardData": async () => store.resetDashboardData(),
    "produdash:deleteAllLocalData": async () => store.deleteAllLocalData(),
    "produdash:saveIntegrationCredentials": async (_event, payload) => {
      const state = await store.saveIntegrationCredentials(payload?.integrationId, payload?.values);
      const setting = state.credentialSettings.find((item) => item.id === payload?.integrationId);
      if (setting?.status === "stored" && ["shopify", "gemini"].includes(payload.integrationId)) {
        return connections.refreshIntegration(payload.integrationId);
      }
      return state;
    },
    "produdash:removeIntegrationCredentials": async (_event, payload) => store.removeIntegrationCredentials(payload?.integrationId),
    "produdash:refreshIntegration": async (_event, payload) => connections.refreshIntegration(payload?.integrationId),
    "produdash:refreshConnections": async () => connections.refreshConnections(),
    "produdash:createClipJob": async (_event, payload) => store.createClipJob(payload),
    "produdash:createPostPlan": async (_event, payload) => store.createPostPlan(payload),
    "produdash:approvePostPlan": async (_event, payload) => store.approvePostPlan(payload?.planId, payload?.mode),
    "produdash:markPostExported": async (_event, payload) => store.markPostExported(payload?.planId),
    "produdash:chooseSourceVideo": async (event) => chooseSourceVideo(event)
  };

  return Object.fromEntries(
    Object.entries(handlers).map(([channel, handler]) => [
      channel,
      async (event, payload) => {
        if (!trusted(event))
          return errorResponse(new AppError("UNTRUSTED_IPC_SENDER", "The request did not come from the ProduDash application."));
        try {
          return { ok: true, data: await handler(event, payload) };
        } catch (error) {
          return errorResponse(error);
        }
      }
    ])
  );
}

function registerIpc({ store, connections, appUrl }) {
  const chooseSourceVideo = async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: "Choose source video",
      properties: ["openFile"],
      filters: [
        { name: "Video files", extensions: ["mp4", "mov", "m4v", "webm", "avi", "mkv"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    return result.canceled ? null : result.filePaths[0];
  };
  const handlers = createHandlers({
    store,
    connections,
    isTrustedSender: createTrustedSender(appUrl),
    chooseSourceVideo
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler);
  }
}

module.exports = { createHandlers, createTrustedSender, registerIpc };
