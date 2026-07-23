const { BrowserWindow, dialog, ipcMain } = require("electron");

function registerIpc({ store, connectors }) {
  ipcMain.handle("produdash:getAppState", () => store.getAppState());
  ipcMain.handle("produdash:saveBusinessSettings", (_event, businessId, settings) =>
    store.saveBusinessSettings(businessId, settings)
  );
  ipcMain.handle("produdash:listConversations", (_event, businessId) => connectors.social.listConversations(businessId));
  ipcMain.handle("produdash:draftAiReply", (_event, conversationId, prompt) =>
    store.draftAiReply(conversationId, prompt, connectors.gemini)
  );
  ipcMain.handle("produdash:approveAiAction", (_event, actionId) => store.approveAiAction(actionId));
  ipcMain.handle("produdash:rejectAiAction", (_event, actionId) => store.rejectAiAction(actionId));
  ipcMain.handle("produdash:completeCommand", (_event, commandId) => store.completeCommand(commandId));
  ipcMain.handle("produdash:resetLocalData", () => store.resetLocalData());
  ipcMain.handle("produdash:saveIntegrationCredentials", (_event, integrationId, values) =>
    store.saveIntegrationCredentials(integrationId, values)
  );
  ipcMain.handle("produdash:removeIntegrationCredentials", (_event, integrationId) =>
    store.removeIntegrationCredentials(integrationId)
  );
  ipcMain.handle("produdash:createClipJob", (_event, payload) => store.createClipJob(payload));
  ipcMain.handle("produdash:createPostPlan", (_event, payload) => store.createPostPlan(payload));
  ipcMain.handle("produdash:approvePostPlan", (_event, planId) => store.approvePostPlan(planId));
  ipcMain.handle("produdash:markPostExported", (_event, planId) => store.markPostExported(planId));
  ipcMain.handle("produdash:chooseSourceVideo", async (event) => {
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
  });
  ipcMain.handle("produdash:shopifySnapshot", (_event, businessId) => ({
    products: connectors.shopify.listProducts(businessId),
    orders: connectors.shopify.listOrders(businessId),
    metrics: connectors.shopify.getMetrics(businessId),
    signals: connectors.shopify.listSignals(businessId)
  }));
}

module.exports = { registerIpc };
