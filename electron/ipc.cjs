const { BrowserWindow, dialog, ipcMain } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AppError, errorResponse } = require("./errors.cjs");
const { boundedString } = require("./validation.cjs");
const { parseTranscriptText } = require("./projects/transcript-import.cjs");
const { rebaseTranscript } = require("./projects/render-plan.cjs");
const { assertPortableDocument, normalizeTemplateSettings } = require("./projects/template-store.cjs");
const { scanLocalVoiceCompatibility } = require("./ai/local-voice-compatibility.cjs");
const { analyticsReportCsv } = require("./analytics-report.cjs");
const { hasCapability } = require("./platforms/registry.cjs");

function createTrustedSender(appUrl) {
  return (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const trusted = Boolean(
      window && event.senderFrame && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === appUrl
    );
    // Opt-in trace for packaged smoke testing. A rejection here renders a fatal
    // startup error with no indication of which value differed.
    if (!trusted && process.env.PRODUDASH_TRACE_IPC_SENDER === "1") {
      process.stderr.write(
        `[produdash] untrusted IPC sender expected=${appUrl} actual=${event.senderFrame?.url ?? "(no sender frame)"} ` +
          `window=${Boolean(window)} mainFrame=${Boolean(window && event.senderFrame === window.webContents.mainFrame)}\n`
      );
    }
    return trusted;
  };
}

function createHandlers({
  store,
  connections,
  connectorRegistry,
  publishing,
  providers,
  mediaLibrary,
  projects,
  templates,
  brandAssets,
  mediaJobs,
  advisor,
  isTrustedSender,
  chooseClipFolders,
  chooseClipFiles,
  chooseMediaOutputFolder,
  chooseMediaJobThumbnail,
  chooseLocalProviderFile,
  relocateClipFolder,
  openClipInFolder,
  openMediaJobOutput,
  chooseProjectTranscript,
  importProjectDocument,
  exportProjectDocument,
  importBrandTemplate,
  exportBrandTemplate,
  exportPostPackage,
  exportAnalyticsReport,
  chooseBrandAsset,
  chooseCustomVoiceRecordings
}) {
  const trusted = isTrustedSender || (() => false);
  const resolveVoiceoverVariant = (project, variantId) => {
    const variant = variantId
      ? project.draft.localization?.variants?.find((item) => item.id === variantId && item.status === "reviewed")
      : null;
    if (variantId && !variant) {
      throw new AppError("LANGUAGE_VARIANT_NOT_REVIEWED", "Review the selected language variant before generating speech.");
    }
    return variant;
  };
  const createVoiceoverDraft = async ({ project, payload, sourceCue, timelineCue, variant }) => {
    const text = variant?.cues?.find((cue) => cue.sourceId === sourceCue.id)?.text || sourceCue.text;
    const generated = await providers.generateSpeechPreview({ ...payload, input: text });
    const textHash = crypto.createHash("sha256").update(text).digest("hex");
    const asset = await brandAssets.importGeneratedVoiceover(generated.audio, {
      name: `${project.title} — AI voice preview`,
      projectId: project.id,
      sourceId: sourceCue.id,
      textHash,
      ...generated.metadata
    });
    const end = Number((timelineCue.start + Number(asset.duration || 0)).toFixed(3));
    if (!asset.duration || end > project.draft.totalDuration) {
      await brandAssets.remove(asset.id).catch(() => {});
      throw new AppError("VOICEOVER_TIMING_INVALID", "The generated preview does not fit inside the edited timeline.");
    }
    return {
      asset,
      voiceover: {
        id: `voiceover-${crypto.randomUUID()}`,
        sourceId: sourceCue.id,
        assetId: asset.id,
        start: timelineCue.start,
        end,
        status: "draft",
        originalAudio: "mix",
        volume: 1,
        provenance: {
          source: "provider",
          providerProfileId: generated.metadata.providerProfileId,
          modelId: generated.metadata.modelId,
          voice: generated.metadata.voice,
          voiceType: generated.metadata.voiceType,
          textHash,
          aiGenerated: true
        }
      }
    };
  };
  const handlers = {
    "produdash:getAppState": async () => store.getAppState(),
    "produdash:getAnalyticsReport": async (_event, payload) => store.getAnalyticsReport(payload?.businessId, payload?.rangeDays),
    "produdash:getAdvisorHistory": async () => advisor.getHistory(),
    "produdash:grantAdvisorConsent": async (_event, payload) => advisor.grantConsent(payload),
    "produdash:sendAdvisorTurn": async (_event, payload) => advisor.sendTurn(payload),
    "produdash:cancelAdvisorTurn": async (_event, payload) => advisor.cancel(payload?.requestId),
    "produdash:clearAdvisorHistory": async () => advisor.clearHistory(),
    "produdash:updateAdvisorSettings": async (_event, payload) => store.updateAdvisorSettings(payload),
    "produdash:getAiProviderCatalog": async () => providers.getCatalog(),
    "produdash:scanLocalVoiceCompatibility": async () => scanLocalVoiceCompatibility(),
    "produdash:draftAiReply": async (_event, payload) => connections.draftAiReply(payload?.conversationId, payload?.prompt),
    "produdash:approveAiAction": async (_event, payload) => store.approveAiAction(payload?.actionId),
    "produdash:rejectAiAction": async (_event, payload) => store.rejectAiAction(payload?.actionId),
    "produdash:completeCommand": async (_event, payload) => store.completeCommand(payload?.commandId),
    "produdash:resetDashboardData": async () => {
      try {
        if (mediaJobs) await mediaJobs.clear();
        if (mediaLibrary) await mediaLibrary.clear();
        if (projects) await projects.clearPreparation();
        if (brandAssets) await brandAssets.clearGeneratedVoiceovers();
        if (advisor) await advisor.clearHistory();
        // Reset keeps credentials but discards every plan, so nothing would be
        // left that can name these records again.
        if (publishing) await publishing.releaseAllSessions();
        return await store.resetDashboardData();
      } finally {
        mediaJobs?.resume?.();
      }
    },
    "produdash:deleteAllLocalData": async () => {
      try {
        if (mediaJobs) await mediaJobs.clear();
        if (mediaLibrary) await mediaLibrary.clear({ removeIndex: true });
        if (projects) await projects.clear({ removeFiles: true });
        if (templates) await templates.clear({ removeFiles: true });
        if (brandAssets) await brandAssets.deleteAll();
        if (advisor) await advisor.history.clear({ removeFiles: true });
        return await store.deleteAllLocalData();
      } finally {
        mediaJobs?.resume?.();
      }
    },
    "produdash:saveIntegrationCredentials": async (_event, payload) => {
      const state = await store.saveIntegrationCredentials(payload?.integrationId, payload?.values);
      const setting = state.credentialSettings.find((item) => item.id === payload?.integrationId);
      if (setting?.status === "stored" && hasCapability(payload?.integrationId, "autoVerifyOnSave")) {
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
    "produdash:createCustomVoice": async (event, payload) => providers.createCustomVoice(payload, await chooseCustomVoiceRecordings(event)),
    "produdash:authorizeConfiguredLocalVoice": async (_event, payload) => providers.authorizeConfiguredLocalVoice(payload),
    "produdash:removeCustomVoice": async (_event, payload) => providers.removeCustomVoice(payload),
    "produdash:chooseLocalProviderFile": async (event, payload) => chooseLocalProviderFile(event, payload?.profileId, payload?.fieldKey),
    "produdash:getClipLibrary": async (_event, payload) => mediaLibrary.query(payload),
    "produdash:rebuildClipSearchIndex": async (_event, payload) => mediaLibrary.rebuildSearchIndex(payload),
    "produdash:cancelClipSearchIndex": async () => mediaLibrary.cancelSearchIndexRebuild(),
    "produdash:getProjects": async (_event, payload) => projects.query(payload),
    "produdash:getBrandTemplates": async () => templates.list(),
    "produdash:getBrandAssets": async () => brandAssets.list(),
    "produdash:importBrandAsset": async (event, payload) => chooseBrandAsset(event, payload?.kind),
    "produdash:deleteBrandAsset": async (_event, payload) => brandAssets.remove(payload?.assetId),
    "produdash:createBrandTemplate": async (_event, payload) => templates.create(payload),
    "produdash:updateBrandTemplate": async (_event, payload) => templates.update(payload?.templateId, payload?.values),
    "produdash:deleteBrandTemplate": async (_event, payload) => templates.remove(payload?.templateId),
    "produdash:applyBrandTemplate": async (_event, payload) => {
      const template = templates.get(payload?.templateId);
      const composition = template.settings.composition;
      for (const overlay of composition.overlays.filter((item) => item.type === "logo")) {
        brandAssets.resolve(overlay.assetId, "logo");
      }
      if (composition.music) brandAssets.resolve(composition.music.assetId, "music");
      if (composition.introAssetId) brandAssets.resolve(composition.introAssetId, "intro");
      if (composition.outroAssetId) brandAssets.resolve(composition.outroAssetId, "outro");
      return projects.applyTemplate(payload?.projectId, template);
    },
    "produdash:importBrandTemplate": async (event) => importBrandTemplate(event),
    "produdash:exportBrandTemplate": async (event, payload) => exportBrandTemplate(event, payload?.templateId),
    "produdash:getProject": async (_event, payload) => projects.get(payload?.projectId),
    "produdash:createProject": async (_event, payload) => projects.create(payload),
    "produdash:importProjectDocument": async (event) => importProjectDocument(event),
    "produdash:exportProjectDocument": async (event, payload) => exportProjectDocument(event, payload?.projectId),
    "produdash:updateProject": async (_event, payload) => projects.update(payload?.projectId, payload?.values),
    "produdash:duplicateProject": async (_event, payload) => projects.duplicate(payload?.projectId),
    "produdash:archiveProject": async (_event, payload) => projects.setStatus(payload?.projectId, "archived"),
    "produdash:restoreProject": async (_event, payload) => projects.setStatus(payload?.projectId, "active"),
    "produdash:deleteProject": async (_event, payload) => {
      const project = projects.get(payload?.projectId);
      const result = await projects.remove(project.id);
      for (const voiceover of project.draft.localization?.voiceovers || []) {
        await brandAssets.remove(voiceover.assetId).catch(() => {});
      }
      return result;
    },
    "produdash:createProjectCollection": async (_event, payload) => projects.createCollection(payload?.name),
    "produdash:relinkProject": async (_event, payload) => projects.relink(payload?.projectId, payload?.sourceMediaId),
    "produdash:createProjectFromCandidate": async (_event, payload) =>
      projects.createFromMediaJob(store.getMediaJob(payload?.jobId), payload?.candidateId),
    "produdash:saveProjectDraft": async (_event, payload) =>
      projects.saveDraft(payload?.projectId, payload?.renderPlan, payload?.expectedRevision),
    "produdash:translateProjectTranscript": async (_event, payload) => {
      const project = projects.get(payload?.projectId);
      const translated = await providers.translateTranscript({
        ...payload,
        sourceLanguage: payload?.sourceLanguage || project.draft.localization?.sourceLanguage || "und",
        cues: project.draft.transcript
      });
      const localization = project.draft.localization || { sourceLanguage: "und", activeVariantId: null, variants: [] };
      return projects.saveDraft(
        project.id,
        {
          ...project.draft,
          localization: {
            ...localization,
            sourceLanguage: translated.sourceLanguage,
            variants: [...localization.variants, translated.variant]
          }
        },
        payload?.expectedRevision
      );
    },
    "produdash:generateProjectVoiceover": async (_event, payload) => {
      const project = projects.get(payload?.projectId);
      const sourceId = String(payload?.sourceId || "");
      const sourceCue = project.draft.transcript.find((cue) => cue.id === sourceId);
      if (!sourceCue) throw new AppError("TRANSCRIPT_CUE_NOT_FOUND", "The selected transcript cue is unavailable.");
      const variant = resolveVoiceoverVariant(project, payload?.variantId);
      const timelineCue = rebaseTranscript(project.draft, variant?.id).find((cue) => cue.sourceId === sourceId);
      if (!timelineCue) throw new AppError("VOICEOVER_CUE_NOT_IN_TIMELINE", "The selected transcript cue is outside the edited timeline.");
      let draft;
      try {
        draft = await createVoiceoverDraft({ project, payload, sourceCue, timelineCue, variant });
        const localization = project.draft.localization || {
          sourceLanguage: "und",
          activeVariantId: null,
          variants: [],
          voiceovers: []
        };
        return await projects.saveDraft(
          project.id,
          {
            ...project.draft,
            localization: {
              ...localization,
              voiceovers: [...(localization.voiceovers || []), draft.voiceover]
            }
          },
          payload?.expectedRevision
        );
      } catch (error) {
        if (draft?.asset) await brandAssets.remove(draft.asset.id).catch(() => {});
        throw error;
      }
    },
    "produdash:generateProjectSpeakerVoiceovers": async (_event, payload) => {
      const project = projects.get(payload?.projectId);
      const speaker = boundedString(payload?.speaker, { label: "Transcript speaker", min: 1, max: 80 });
      const variant = resolveVoiceoverVariant(project, payload?.variantId);
      const localization = project.draft.localization || {
        sourceLanguage: "und",
        activeVariantId: null,
        variants: [],
        voiceovers: []
      };
      const existingSourceIds = new Set((localization.voiceovers || []).map((voiceover) => voiceover.sourceId));
      const sourceById = new Map(project.draft.transcript.map((cue) => [cue.id, cue]));
      const timelineCues = rebaseTranscript(project.draft, variant?.id).filter((cue) => {
        const sourceCue = sourceById.get(cue.sourceId);
        return sourceCue?.speaker === speaker && !existingSourceIds.has(cue.sourceId);
      });
      const uniqueCues = [...new Map(timelineCues.map((cue) => [cue.sourceId, cue])).values()].slice(0, 12);
      if (!uniqueCues.length) {
        throw new AppError("VOICEOVER_SPEAKER_COMPLETE", "This speaker has no unvoiced cues in the edited timeline.");
      }
      const drafts = [];
      try {
        for (const timelineCue of uniqueCues) {
          const sourceCue = sourceById.get(timelineCue.sourceId);
          drafts.push(await createVoiceoverDraft({ project, payload, sourceCue, timelineCue, variant }));
        }
        return await projects.saveDraft(
          project.id,
          {
            ...project.draft,
            localization: {
              ...localization,
              voiceovers: [...(localization.voiceovers || []), ...drafts.map((draft) => draft.voiceover)]
            }
          },
          payload?.expectedRevision
        );
      } catch (error) {
        for (const draft of drafts) await brandAssets.remove(draft.asset.id).catch(() => {});
        throw error;
      }
    },
    "produdash:convertProjectVoiceover": async (_event, payload) => {
      const project = projects.get(payload?.projectId);
      const sourceVoiceover = project.draft.localization?.voiceovers?.find((item) => item.id === payload?.voiceoverId);
      if (!sourceVoiceover) throw new AppError("VOICEOVER_NOT_FOUND", "Voiceover preview not found.");
      const resolved = brandAssets.resolve(sourceVoiceover.assetId, "voiceover");
      const sourceAudio = await fs.promises.readFile(resolved.filePath);
      let asset;
      try {
        const generated = await providers.convertVoicePreview(payload, sourceAudio);
        asset = await brandAssets.importGeneratedVoiceover(generated.audio, {
          name: `${project.title} — converted voice preview`,
          projectId: project.id,
          sourceId: sourceVoiceover.sourceId,
          textHash: sourceVoiceover.provenance.textHash,
          ...generated.metadata
        });
        const end = Number((sourceVoiceover.start + Number(asset.duration || 0)).toFixed(3));
        if (!asset.duration || end > project.draft.totalDuration) {
          throw new AppError("VOICEOVER_TIMING_INVALID", "The converted preview does not fit inside the edited timeline.");
        }
        const localization = project.draft.localization || {
          sourceLanguage: "und",
          activeVariantId: null,
          variants: [],
          voiceovers: []
        };
        return await projects.saveDraft(
          project.id,
          {
            ...project.draft,
            localization: {
              ...localization,
              voiceovers: [
                ...(localization.voiceovers || []),
                {
                  id: `voiceover-${crypto.randomUUID()}`,
                  sourceId: sourceVoiceover.sourceId,
                  assetId: asset.id,
                  start: sourceVoiceover.start,
                  end,
                  status: "draft",
                  originalAudio: sourceVoiceover.originalAudio,
                  volume: sourceVoiceover.volume,
                  provenance: {
                    source: "provider",
                    providerProfileId: generated.metadata.providerProfileId,
                    modelId: generated.metadata.modelId,
                    voice: generated.metadata.voice,
                    voiceType: "custom",
                    textHash: sourceVoiceover.provenance.textHash,
                    aiGenerated: true
                  }
                }
              ]
            }
          },
          payload?.expectedRevision
        );
      } catch (error) {
        if (asset) await brandAssets.remove(asset.id).catch(() => {});
        throw error;
      }
    },
    "produdash:deleteProjectVoiceover": async (_event, payload) => {
      const project = projects.get(payload?.projectId);
      const voiceover = project.draft.localization?.voiceovers?.find((item) => item.id === payload?.voiceoverId);
      if (!voiceover) throw new AppError("VOICEOVER_NOT_FOUND", "Voiceover preview not found.");
      const next = await projects.saveDraft(
        project.id,
        {
          ...project.draft,
          localization: {
            ...project.draft.localization,
            voiceovers: project.draft.localization.voiceovers.filter((item) => item.id !== voiceover.id)
          }
        },
        payload?.expectedRevision
      );
      await brandAssets.remove(voiceover.assetId);
      return next;
    },
    "produdash:saveProjectVersion": async (_event, payload) => projects.commitVersion(payload?.projectId, payload?.label),
    "produdash:restoreProjectVersion": async (_event, payload) => projects.restoreVersion(payload?.projectId, payload?.versionId),
    "produdash:importProjectTranscript": async (event, payload) => chooseProjectTranscript(event, payload?.projectId),
    "produdash:prepareProject": async (_event, payload) => mediaJobs.createProjectPreparation(payload?.projectId),
    "produdash:renderProject": async (_event, payload) => mediaJobs.createProjectRender(payload?.projectId, payload?.outputSelectionId),
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
    "produdash:updateMediaCandidate": async (_event, payload) =>
      mediaJobs.updateCandidate(payload?.jobId, payload?.candidateId, payload?.values),
    "produdash:approveMediaCandidates": async (_event, payload) => mediaJobs.approveCandidates(payload?.jobId, payload?.candidateIds),
    "produdash:cancelMediaJob": async (_event, payload) => mediaJobs.cancel(payload?.jobId),
    "produdash:retryMediaJob": async (_event, payload) => mediaJobs.retry(payload?.jobId),
    "produdash:selectMediaJobThumbnail": async (_event, payload) => mediaJobs.selectThumbnail(payload?.jobId, payload?.thumbnailId),
    "produdash:addMediaJobThumbnail": async (event, payload) => chooseMediaJobThumbnail(event, payload?.jobId, payload?.groupId),
    "produdash:openMediaJobOutput": async (event, payload) => openMediaJobOutput(event, payload?.jobId),
    "produdash:createPostPlan": async (_event, payload) => store.createPostPlan(payload),
    "produdash:updatePostPlanDraft": async (_event, payload) => store.updatePostPlanDraft(payload?.planId, payload?.values),
    "produdash:approvePostPlan": async (_event, payload) => store.approvePostPlan(payload?.planId, payload?.mode),
    "produdash:exportPostPackage": async (event, payload) => exportPostPackage(event, payload?.planId),
    "produdash:exportAnalyticsReport": async (event, payload) => exportAnalyticsReport(event, payload?.businessId, payload?.rangeDays),
    "produdash:cancelPostPlan": async (_event, payload) => {
      const state = await store.cancelPostPlan(payload?.planId);
      // Cancelled after the store agreed to it, so a refused cancel leaves the
      // session intact. The plan keeps its snapshot, so the destinations are
      // still readable here -- this is the last moment they are.
      if (publishing) await publishing.releaseSessionsForPlan(payload?.planId);
      return state;
    },
    "produdash:dispatchPostPlan": async (_event, payload) => {
      if (!publishing) throw new AppError("PUBLISHING_UNSUPPORTED", "Official API publishing is unavailable.");
      return publishing.dispatch(payload?.planId);
    },
    "produdash:refreshPublicationStatus": async (_event, payload) => {
      if (!publishing) throw new AppError("PUBLISHING_UNSUPPORTED", "Official API publishing is unavailable.");
      return publishing.refreshPublicationStatus(payload?.planId, payload?.platformId);
    },
    "produdash:discardUploadSession": async (_event, payload) => {
      if (!publishing) throw new AppError("PUBLISHING_UNSUPPORTED", "Official API publishing is unavailable.");
      return publishing.discardUploadSession(payload?.planId, payload?.platformId);
    },
    "produdash:authorizeIntegration": async (_event, payload) => connections.authorizeIntegration(payload?.integrationId),
    "produdash:disconnectIntegration": async (_event, payload) => connections.disconnectIntegration(payload?.integrationId),
    "produdash:getAuthorizationInstructions": async (_event, payload) => {
      const connector = connectorRegistry?.find(payload?.integrationId);
      if (!connector) throw new AppError("INTEGRATION_UNAVAILABLE", "That integration has no connector yet.");
      return connector.getAuthorizationInstructions();
    }
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

function registerIpc({
  store,
  connections,
  connectorRegistry,
  publishing,
  providers,
  mediaLibrary,
  projects,
  templates,
  brandAssets,
  mediaJobs,
  advisor,
  appUrl,
  shell
}) {
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
  const chooseLocalProviderFile = async (event, profileId, fieldKey) => {
    const field = providers.getNativeCredentialField(profileId, fieldKey);
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: `Choose ${field.label}`,
      properties: [field.type === "native-folder" ? "openDirectory" : "openFile"],
      securityScopedBookmarks: true
    });
    if (result.canceled) return store.getAppState();
    return providers.saveCredentialDraft(profileId, {
      [fieldKey]: result.filePaths[0],
      ...(result.bookmarks?.[0] ? { [`${fieldKey}Bookmark`]: result.bookmarks[0] } : {})
    });
  };
  const chooseMediaJobThumbnail = async (event, jobId, groupId) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: "Add a custom thumbnail",
      properties: ["openFile"],
      securityScopedBookmarks: true,
      filters: [{ name: "Thumbnail images", extensions: ["jpg", "jpeg", "png", "webp"] }]
    });
    if (result.canceled) return store.getAppState();
    return mediaJobs.importThumbnail(jobId, groupId, {
      path: result.filePaths[0],
      bookmark: result.bookmarks?.[0] || null
    });
  };
  const chooseProjectTranscript = async (event, projectId) => {
    const project = projects.get(projectId);
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: "Import project transcript",
      properties: ["openFile"],
      filters: [{ name: "Transcript files", extensions: ["srt", "vtt"] }]
    });
    if (result.canceled) return project;
    const selectedPath = result.filePaths[0];
    const extension = path.extname(selectedPath).toLowerCase().slice(1);
    if (!["srt", "vtt"].includes(extension)) throw new AppError("INVALID_TRANSCRIPT", "Choose an SRT or VTT transcript.");
    const stat = await fs.promises.stat(selectedPath);
    if (!stat.isFile() || stat.size > 2_000_000) {
      throw new AppError("TRANSCRIPT_TOO_LARGE", "The transcript file is too large.");
    }
    const text = await fs.promises.readFile(selectedPath, "utf8");
    return projects.replaceTranscript(projectId, parseTranscriptText(text, extension, project.source.duration));
  };
  const importBrandTemplate = async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: "Import ProduDash brand template",
      properties: ["openFile"],
      filters: [{ name: "ProduDash template", extensions: ["json"] }]
    });
    if (result.canceled) return null;
    const selectedPath = result.filePaths[0];
    const stat = await fs.promises.stat(selectedPath);
    // A brand template is a small settings document. The old ceiling was 400 MB,
    // which JSON.parse would turn into a multi-second freeze of the main process
    // -- taking any in-flight render with it -- or an out-of-memory crash. The
    // transcript importer nearby already caps at 2 MB.
    if (!stat.isFile() || stat.size > 4_000_000) {
      throw new AppError("TEMPLATE_TOO_LARGE", "The selected brand template is too large.");
    }
    let document;
    try {
      document = JSON.parse(await fs.promises.readFile(selectedPath, "utf8"));
    } catch {
      // Unguarded, a malformed file surfaced as a generic internal error that
      // said nothing about which file or why.
      throw new AppError("TEMPLATE_UNREADABLE", "The selected brand template is not valid JSON.");
    }
    if (
      !document ||
      typeof document !== "object" ||
      document.format !== "produdash-brand-template" ||
      document.version !== 1 ||
      Object.keys(document).some((key) => !["format", "version", "name", "description", "settings", "assets"].includes(key))
    ) {
      throw new AppError("INVALID_TEMPLATE_IMPORT", "The selected file is not a supported ProduDash brand template package.");
    }
    assertPortableDocument({
      format: document.format,
      version: document.version,
      name: document.name,
      description: document.description,
      settings: document.settings
    });
    normalizeTemplateSettings(document.settings);
    const packagedAssets = Array.isArray(document.assets) ? document.assets : [];
    if (packagedAssets.length > 24) throw new AppError("INVALID_TEMPLATE_IMPORT", "A template package contains too many assets.");
    const replacements = new Map();
    for (const packagedAsset of packagedAssets) {
      const imported = await brandAssets.importPackageAsset(packagedAsset);
      replacements.set(packagedAsset.id, imported.id);
    }
    const replaceAssetId = (assetId) => (assetId && replacements.has(assetId) ? replacements.get(assetId) : assetId);
    const settings = structuredClone(document.settings || {});
    if (settings.composition) {
      settings.composition.introAssetId = replaceAssetId(settings.composition.introAssetId);
      settings.composition.outroAssetId = replaceAssetId(settings.composition.outroAssetId);
      if (settings.composition.music) settings.composition.music.assetId = replaceAssetId(settings.composition.music.assetId);
      for (const overlay of Array.isArray(settings.composition.overlays) ? settings.composition.overlays : []) {
        if (overlay.type === "logo") overlay.assetId = replaceAssetId(overlay.assetId);
      }
    }
    return templates.importDocument({
      format: document.format,
      version: document.version,
      name: document.name,
      description: document.description,
      settings
    });
  };
  const chooseBrandAsset = async (event, kind) => {
    const filters = {
      logo: [{ name: "Logo images", extensions: ["png", "jpg", "jpeg", "webp"] }],
      music: [{ name: "Music", extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg"] }],
      intro: [{ name: "Intro videos", extensions: ["mp4", "mov", "m4v", "webm", "mkv"] }],
      outro: [{ name: "Outro videos", extensions: ["mp4", "mov", "m4v", "webm", "mkv"] }]
    };
    if (!filters[kind]) throw new AppError("INVALID_BRAND_ASSET", "Choose a supported brand asset type.");
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: `Add ${kind} asset`,
      properties: ["openFile"],
      filters: filters[kind]
    });
    if (result.canceled) return null;
    return brandAssets.import(kind, result.filePaths[0]);
  };
  const chooseCustomVoiceRecordings = async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const filters = [{ name: "Voice recording", extensions: ["mp3", "wav", "ogg", "aac", "flac", "webm", "mp4"] }];
    const select = async (title) => {
      const result = await dialog.showOpenDialog(window, {
        title,
        properties: ["openFile"],
        filters
      });
      if (result.canceled) throw new AppError("VOICE_CREATION_CANCELED", "Custom voice creation was canceled.");
      const selectedPath = result.filePaths[0];
      const stat = await fs.promises.stat(selectedPath);
      if (!stat.isFile() || stat.size < 512 || stat.size > 25 * 1024 * 1024) {
        throw new AppError("INVALID_VOICE_RECORDING", "Choose a voice recording between 512 bytes and 25 MB.");
      }
      const extension = path.extname(selectedPath).toLowerCase().slice(1);
      const mediaTypes = {
        mp3: "audio/mpeg",
        wav: "audio/wav",
        ogg: "audio/ogg",
        aac: "audio/aac",
        flac: "audio/flac",
        webm: "audio/webm",
        mp4: "audio/mp4"
      };
      if (!mediaTypes[extension]) throw new AppError("INVALID_VOICE_RECORDING", "Choose a supported voice recording.");
      return { path: selectedPath, name: path.basename(selectedPath), type: mediaTypes[extension] };
    };
    return {
      consentRecording: await select("Choose the exact provider consent recording"),
      sampleRecording: await select("Choose the matching voice sample")
    };
  };
  const importProjectDocument = async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: "Import ProduDash project",
      properties: ["openFile"],
      filters: [{ name: "ProduDash project", extensions: ["json"] }]
    });
    if (result.canceled) return null;
    const selectedPath = result.filePaths[0];
    const stat = await fs.promises.stat(selectedPath);
    if (!stat.isFile() || stat.size > 4_000_000) {
      throw new AppError("PROJECT_IMPORT_TOO_LARGE", "The selected project document is too large.");
    }
    return projects.importDocument(JSON.parse(await fs.promises.readFile(selectedPath, "utf8")));
  };
  const exportProjectDocument = async (event, projectId) => {
    const project = projects.get(projectId);
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(window, {
      title: "Export ProduDash project",
      defaultPath: `${project.title.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "produdash-project"}.json`,
      filters: [{ name: "ProduDash project", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePath) return { exported: false };
    await fs.promises.writeFile(result.filePath, `${JSON.stringify(projects.exportDocument(projectId), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    return { exported: true };
  };
  const exportBrandTemplate = async (event, templateId) => {
    const template = templates.get(templateId);
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(window, {
      title: "Export ProduDash brand template",
      defaultPath: `${template.name.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "brand-template"}.json`,
      filters: [{ name: "ProduDash template", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePath) return { exported: false };
    const document = templates.exportDocument(templateId);
    const composition = document.settings.composition || {};
    const assetIds = [
      ...composition.overlays.filter((overlay) => overlay.type === "logo").map((overlay) => overlay.assetId),
      composition.music?.assetId,
      composition.introAssetId,
      composition.outroAssetId
    ].filter(Boolean);
    document.assets = [...new Set(assetIds)].map((assetId) => brandAssets.exportPackageAsset(assetId));
    await fs.promises.writeFile(result.filePath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    return { exported: true };
  };
  const exportPostPackage = async (event, planId) => {
    const document = store.getPostExportPackage(planId);
    const window = BrowserWindow.fromWebContents(event.sender);
    const safeTitle =
      String(document.approval?.payload?.title || "post-plan")
        .replace(/[^a-z0-9_-]+/gi, "-")
        .toLowerCase()
        .slice(0, 80) || "post-plan";
    const result = await dialog.showSaveDialog(window, {
      title: "Export approved publishing package",
      defaultPath: `${safeTitle}.produdash-post.json`,
      filters: [{ name: "ProduDash publishing package", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePath) return store.getAppState();
    await fs.promises.writeFile(result.filePath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    return store.markPostExported(planId);
  };
  const exportAnalyticsReport = async (event, businessId, rangeDays) => {
    const report = store.getAnalyticsReport(businessId, rangeDays);
    if (!report.businessId || !report.source) {
      throw new AppError("ANALYTICS_UNAVAILABLE", "Connect and synchronize Shopify before exporting analytics.");
    }
    const safeName =
      String(report.businessName || "shopify")
        .replace(/[^a-z0-9_-]+/gi, "-")
        .toLowerCase()
        .slice(0, 80) || "shopify";
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(window, {
      title: "Export Shopify analytics snapshot",
      defaultPath: `${safeName}-analytics.csv`,
      filters: [{ name: "CSV report", extensions: ["csv"] }]
    });
    if (result.canceled || !result.filePath) return { exported: false };
    await fs.promises.writeFile(result.filePath, analyticsReportCsv(report), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    return {
      exported: true,
      rowCount:
        report.metrics.length +
        report.trend.length +
        report.unavailableMetrics.length +
        (report.comparison?.metrics.length || 0) * 2 +
        (report.comparison?.observations.length || 0)
    };
  };
  const openMediaJobOutput = async (_event, jobId) => mediaJobs.revealOutput(jobId, (outputPath) => shell.showItemInFolder(outputPath));
  const handlers = createHandlers({
    store,
    connections,
    connectorRegistry,
    publishing,
    providers,
    mediaLibrary,
    projects,
    templates,
    brandAssets,
    mediaJobs,
    advisor,
    isTrustedSender: createTrustedSender(appUrl),
    chooseClipFolders,
    chooseClipFiles,
    chooseMediaOutputFolder,
    chooseMediaJobThumbnail,
    chooseLocalProviderFile,
    relocateClipFolder,
    openClipInFolder,
    openMediaJobOutput,
    chooseProjectTranscript,
    importProjectDocument,
    exportProjectDocument,
    importBrandTemplate,
    exportBrandTemplate,
    exportPostPackage,
    exportAnalyticsReport,
    chooseBrandAsset,
    chooseCustomVoiceRecordings
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler);
  }
}

module.exports = { createHandlers, createTrustedSender, registerIpc };
