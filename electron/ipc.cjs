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
  mediaJobs,
  advisor,
  isTrustedSender,
  chooseClipFolders,
  chooseClipFiles,
  chooseMediaOutputFolder,
  chooseLocalWhisperFile,
  relocateClipFolder,
  openClipInFolder,
  openMediaJobOutput
}) {
  const trusted = isTrustedSender || (() => false);
  const handlers = {
    "produdash:getAppState": async () => store.getAppState(),
    "produdash:getAdvisorHistory": async () => advisor.getHistory(),
    "produdash:grantAdvisorConsent": async (_event, payload) => advisor.grantConsent(payload),
    "produdash:sendAdvisorTurn": async (_event, payload) => advisor.sendTurn(payload),
    "produdash:cancelAdvisorTurn": async (_event, payload) => advisor.cancel(payload?.requestId),
    "produdash:clearAdvisorHistory": async () => advisor.clearHistory(),
    "produdash:updateAdvisorSettings": async (_event, payload) => store.updateAdvisorSettings(payload),
    "produdash:getAiProviderCatalog": async () => providers.getCatalog(),
    "produdash:draftAiReply": async (_event, payload) => connections.draftAiReply(payload?.conversationId, payload?.prompt),
    "produdash:approveAiAction": async (_event, payload) => store.approveAiAction(payload?.actionId),
    "produdash:rejectAiAction": async (_event, payload) => store.rejectAiAction(payload?.actionId),
    "produdash:completeCommand": async (_event, payload) => store.completeCommand(payload?.commandId),
    "produdash:resetDashboardData": async () => {
      try {
        if (mediaJobs) await mediaJobs.clear();
        if (mediaLibrary) await mediaLibrary.clear();
        if (advisor) await advisor.clearHistory();
        return await store.resetDashboardData();
      } finally {
        mediaJobs?.resume?.();
      }
    },
    "produdash:deleteAllLocalData": async () => {
      try {
        if (mediaJobs) await mediaJobs.clear();
        if (mediaLibrary) await mediaLibrary.clear({ removeIndex: true });
        if (advisor) await advisor.history.clear({ removeFiles: true });
        return await store.deleteAllLocalData();
      } finally {
        mediaJobs?.resume?.();
      }
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
    "produdash:chooseLocalWhisperFile": async (event, payload) => chooseLocalWhisperFile(event, payload?.kind),
    "produdash:getClipLibrary": async (_event, payload) => mediaLibrary.query(payload),
    "produdash:chooseClipFolders": async (event) => chooseClipFolders(event),
    "produdash:chooseClipFiles": async (event) => chooseClipFiles(event),
    "produdash:rescanClipFolder": async (_event, payload) => mediaLibrary.rescanFolder(payload?.folderId),
    "produdash:relocateClipFolder": async (event, payload) => relocateClipFolder(event, payload?.folderId),
    "produdash:removeClipFolder": async (_event, payload) => mediaLibrary.removeFolder(payload?.folderId),
    "produdash:removeClip": async (_event, payload) => mediaLibrary.removeClip(payload?.clipId),
    "produdash:updateClipTags": async (_event, payload) => mediaLibrary.updateTags(payload?.clipId, payload?.tags),
    "produdash:openClipInFolder": async (event, payload) => openClipInFolder(event, payload?.clipId),
    "produdash:chooseMediaOutputFolder": async (event) => chooseMediaOutputFolder(event),
    "produdash:createMediaJob": async (_event, payload) => mediaJobs.create(payload),
    "produdash:approveMediaCandidates": async (_event, payload) => mediaJobs.approveCandidates(payload?.jobId, payload?.candidateIds),
    "produdash:cancelMediaJob": async (_event, payload) => mediaJobs.cancel(payload?.jobId),
    "produdash:retryMediaJob": async (_event, payload) => mediaJobs.retry(payload?.jobId),
    "produdash:openMediaJobOutput": async (event, payload) => openMediaJobOutput(event, payload?.jobId),
    "produdash:createPostPlan": async (_event, payload) => store.createPostPlan(payload),
    "produdash:approvePostPlan": async (_event, payload) => store.approvePostPlan(payload?.planId, payload?.mode),
    "produdash:markPostExported": async (_event, payload) => store.markPostExported(payload?.planId)
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

function registerIpc({ store, connections, providers, mediaLibrary, mediaJobs, advisor, appUrl, shell }) {
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
  const chooseMediaOutputFolder = async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: "Choose a folder for generated clips",
      properties: ["openDirectory", "createDirectory"],
      securityScopedBookmarks: true
    });
    if (result.canceled) return null;
    return mediaJobs.rememberOutputSelection({
      path: result.filePaths[0],
      bookmark: result.bookmarks?.[0] || null
    });
  };
  const chooseLocalWhisperFile = async (event, kind) => {
    if (!["executablePath", "modelPath"].includes(kind)) {
      throw new AppError("INVALID_INPUT", "The local Whisper file type is invalid.");
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: kind === "executablePath" ? "Choose whisper.cpp executable" : "Choose local Whisper model",
      properties: ["openFile"],
      securityScopedBookmarks: true
    });
    if (result.canceled) return store.getAppState();
    return providers.saveCredentialDraft("whisper-cpp", {
      [kind]: result.filePaths[0],
      ...(result.bookmarks?.[0] ? { [`${kind}Bookmark`]: result.bookmarks[0] } : {})
    });
  };
  const openMediaJobOutput = async (_event, jobId) => mediaJobs.revealOutput(jobId, (outputPath) => shell.showItemInFolder(outputPath));
  const handlers = createHandlers({
    store,
    connections,
    providers,
    mediaLibrary,
    mediaJobs,
    advisor,
    isTrustedSender: createTrustedSender(appUrl),
    chooseClipFolders,
    chooseClipFiles,
    chooseMediaOutputFolder,
    chooseLocalWhisperFile,
    relocateClipFolder,
    openClipInFolder,
    openMediaJobOutput
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler);
  }
}

module.exports = { createHandlers, createTrustedSender, registerIpc };
