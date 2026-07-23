const { BrowserWindow, dialog, ipcMain } = require("electron");
const { AppError, errorResponse } = require("./errors.cjs");

function createTrustedSender(appUrl) {
  return (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return Boolean(window && event.senderFrame && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === appUrl);
  };
}

function createHandlers({
  store,
  connections,
  providers,
  mediaLibrary,
  isTrustedSender,
  chooseSourceVideo,
  chooseClipFolders,
  chooseClipFiles,
  relocateClipFolder,
  openClipInFolder
}) {
  const trusted = isTrustedSender || (() => false);
  const handlers = {
    "produdash:getAppState": async () => store.getAppState(),
    "produdash:getAiProviderCatalog": async () => providers.getCatalog(),
    "produdash:draftAiReply": async (_event, payload) => connections.draftAiReply(payload?.conversationId, payload?.prompt),
    "produdash:approveAiAction": async (_event, payload) => store.approveAiAction(payload?.actionId),
    "produdash:rejectAiAction": async (_event, payload) => store.rejectAiAction(payload?.actionId),
    "produdash:completeCommand": async (_event, payload) => store.completeCommand(payload?.commandId),
    "produdash:resetDashboardData": async () => {
      if (mediaLibrary) await mediaLibrary.clear();
      return store.resetDashboardData();
    },
    "produdash:deleteAllLocalData": async () => {
      if (mediaLibrary) await mediaLibrary.clear({ removeIndex: true });
      return store.deleteAllLocalData();
    },
    "produdash:saveIntegrationCredentials": async (_event, payload) => {
      const state = await store.saveIntegrationCredentials(payload?.integrationId, payload?.values);
      const setting = state.credentialSettings.find((item) => item.id === payload?.integrationId);
      if (setting?.status === "stored" && payload.integrationId === "shopify") {
        return connections.refreshIntegration(payload.integrationId);
      }
      return state;
    },
    "produdash:removeIntegrationCredentials": async (_event, payload) => store.removeIntegrationCredentials(payload?.integrationId),
    "produdash:refreshIntegration": async (_event, payload) => connections.refreshIntegration(payload?.integrationId),
    "produdash:refreshConnections": async () => connections.refreshConnections(),
    "produdash:saveAiProviderCredentials": async (_event, payload) => providers.saveCredentials(payload?.profileId, payload?.values),
    "produdash:testAiProvider": async (_event, payload) => providers.testConnection(payload?.profileId),
    "produdash:removeAiProviderCredentials": async (_event, payload) => providers.removeCredentials(payload?.profileId),
    "produdash:setAiWorkload": async (_event, payload) => providers.setWorkload(payload?.workloadId, payload?.selection),
    "produdash:getClipLibrary": async (_event, payload) => mediaLibrary.query(payload),
    "produdash:chooseClipFolders": async (event) => chooseClipFolders(event),
    "produdash:chooseClipFiles": async (event) => chooseClipFiles(event),
    "produdash:rescanClipFolder": async (_event, payload) => mediaLibrary.rescanFolder(payload?.folderId),
    "produdash:relocateClipFolder": async (event, payload) => relocateClipFolder(event, payload?.folderId),
    "produdash:removeClipFolder": async (_event, payload) => mediaLibrary.removeFolder(payload?.folderId),
    "produdash:removeClip": async (_event, payload) => mediaLibrary.removeClip(payload?.clipId),
    "produdash:updateClipTags": async (_event, payload) => mediaLibrary.updateTags(payload?.clipId, payload?.tags),
    "produdash:openClipInFolder": async (event, payload) => openClipInFolder(event, payload?.clipId),
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

function registerIpc({ store, connections, providers, mediaLibrary, appUrl, shell }) {
  const folderDialogOptions = {
    title: "Add folders to Clip Library",
    properties: ["openDirectory", "multiSelections"],
    securityScopedBookmarks: true
  };
  const videoFilters = [{ name: "Video files", extensions: ["mp4", "mov", "m4v", "webm", "mkv", "avi", "wmv", "flv", "mpeg", "mpg"] }];
  const normalizeSelections = (result) =>
    result.canceled
      ? []
      : result.filePaths.map((selectedPath, index) => ({
          path: selectedPath,
          bookmark: result.bookmarks?.[index] || null
        }));
  const chooseClipFolders = async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, folderDialogOptions);
    return mediaLibrary.addFolders(normalizeSelections(result));
  };
  const chooseClipFiles = async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: "Add videos to Clip Library",
      properties: ["openFile", "multiSelections"],
      securityScopedBookmarks: true,
      filters: videoFilters
    });
    return mediaLibrary.addFiles(normalizeSelections(result));
  };
  const relocateClipFolder = async (event, folderId) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      ...folderDialogOptions,
      title: "Relocate Clip Library folder",
      properties: ["openDirectory"]
    });
    const [selection] = normalizeSelections(result);
    return selection ? mediaLibrary.relocateFolder(folderId, selection) : mediaLibrary.query({});
  };
  const openClipInFolder = async (_event, clipId) => {
    shell.showItemInFolder(mediaLibrary.resolveClipPath(clipId));
    return { clipId };
  };
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
    providers,
    mediaLibrary,
    isTrustedSender: createTrustedSender(appUrl),
    chooseSourceVideo,
    chooseClipFolders,
    chooseClipFiles,
    relocateClipFolder,
    openClipInFolder
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler);
  }
}

module.exports = { createHandlers, createTrustedSender, registerIpc };
