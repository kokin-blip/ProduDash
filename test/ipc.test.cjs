const assert = require("node:assert/strict");
const test = require("node:test");
const { createHandlers } = require("../electron/ipc.cjs");

function fixtures(isTrustedSender) {
  const state = { schemaVersion: 7 };
  const store = {
    getAppState: () => state,
    getAnalyticsReport: () => ({ businessId: "business-1", metrics: [] }),
    approveAiAction: async () => state,
    rejectAiAction: async () => state,
    completeCommand: async () => state,
    resetDashboardData: async () => state,
    deleteAllLocalData: async () => state,
    saveIntegrationCredentials: async () => ({ credentialSettings: [] }),
    removeIntegrationCredentials: async () => state,
    createPostPlan: async () => state,
    updatePostPlanDraft: async () => state,
    approvePostPlan: async () => state,
    cancelPostPlan: async () => state
  };
  const connections = {
    draftAiReply: async () => ({ state }),
    refreshIntegration: async () => state,
    refreshConnections: async () => state
  };
  const providers = {
    getCatalog: () => [],
    getNativeCredentialField: () => ({ key: "modelPath", label: "Local model", type: "native-file" }),
    removeCustomVoice: async () => state,
    translateTranscript: async () => ({
      sourceLanguage: "en",
      variant: {
        id: "language-es",
        language: "es",
        label: "Spanish",
        status: "draft",
        cues: [{ sourceId: "cue-1", text: "Hola" }],
        provenance: { source: "provider", providerProfileId: "gemini", modelId: "model-1" }
      }
    })
  };
  const mediaLibrary = { query: () => ({ clips: [] }) };
  const projects = {
    query: () => ({ projects: [] }),
    get: () => ({
      id: "project-1",
      draft: {
        transcript: [{ id: "cue-1", text: "Hello" }],
        localization: { sourceLanguage: "en", activeVariantId: null, variants: [] }
      }
    }),
    create: async () => ({ id: "project-1" }),
    saveDraft: async () => ({ id: "project-1", revision: 2 }),
    commitVersion: async () => ({ id: "project-1", revision: 2 })
  };
  const mediaJobs = {
    create: async () => state,
    updateCandidate: async () => state,
    approveCandidates: async () => state,
    cancel: async () => state,
    retry: async () => state,
    selectThumbnail: async () => state,
    createProjectPreparation: async () => state,
    createProjectRender: async () => state
  };
  const advisor = {
    getHistory: () => ({ turns: [] }),
    grantConsent: () => ({ providerId: "provider-1" }),
    sendTurn: async () => ({ accepted: true }),
    cancel: () => ({ canceled: true }),
    clearHistory: async () => ({ turns: [] }),
    history: { clear: async () => ({ turns: [] }) }
  };
  return createHandlers({
    store,
    connections,
    providers,
    mediaLibrary,
    projects,
    mediaJobs,
    advisor,
    isTrustedSender,
    chooseMediaOutputFolder: async () => ({ id: "output-1", name: "Clips" }),
    chooseMediaJobThumbnail: async () => state,
    chooseLocalProviderFile: async () => state,
    exportPostPackage: async () => state,
    exportAnalyticsReport: async () => ({ exported: true }),
    openMediaJobOutput: async () => ({ jobId: "mediajob-1" })
  });
}

test("IPC rejects untrusted senders before invoking privileged handlers", async () => {
  const handlers = fixtures(() => false);
  const response = await handlers["produdash:getAppState"]({});
  assert.deepEqual(response, {
    ok: false,
    error: {
      code: "UNTRUSTED_IPC_SENDER",
      message: "The request did not come from the ProduDash application."
    }
  });
});

test("IPC returns normalized success envelopes", async () => {
  const handlers = fixtures(() => true);
  const response = await handlers["produdash:getAppState"]({});
  assert.deepEqual(response, { ok: true, data: { schemaVersion: 7 } });
  assert.equal(
    (await handlers["produdash:removeCustomVoice"]({}, { providerProfileId: "elevenlabs", voiceId: "voice-authorized" })).ok,
    true
  );
  assert.equal((await handlers["produdash:chooseLocalProviderFile"]({}, { profileId: "piper-local", fieldKey: "modelPath" })).ok, true);
});

test("dashboard reset and delete-all clear only ProduDash library metadata", async () => {
  const events = [];
  const state = { schemaVersion: 7 };
  const handlers = createHandlers({
    store: {
      resetDashboardData: async () => {
        events.push("reset-state");
        return state;
      },
      deleteAllLocalData: async () => {
        events.push("delete-state");
        return state;
      }
    },
    connections: {},
    providers: {},
    mediaLibrary: {
      clear: async (options) => events.push(options?.removeIndex ? "remove-index" : "clear-index")
    },
    brandAssets: {
      clearGeneratedVoiceovers: async () => events.push("clear-voiceovers"),
      deleteAll: async () => events.push("remove-brand-assets")
    },
    projects: {
      clearPreparation: async () => events.push("clear-project-cache"),
      clear: async () => events.push("remove-projects")
    },
    mediaJobs: {
      clear: async () => events.push("clear-jobs")
    },
    advisor: {
      clearHistory: async () => events.push("clear-advisor"),
      history: { clear: async () => events.push("remove-advisor-history") }
    },
    isTrustedSender: () => true
  });
  assert.equal((await handlers["produdash:resetDashboardData"]({})).ok, true);
  assert.deepEqual(events, ["clear-jobs", "clear-index", "clear-project-cache", "clear-voiceovers", "clear-advisor", "reset-state"]);
  events.length = 0;
  assert.equal((await handlers["produdash:deleteAllLocalData"]({})).ok, true);
  assert.deepEqual(events, [
    "clear-jobs",
    "remove-index",
    "remove-projects",
    "remove-brand-assets",
    "remove-advisor-history",
    "delete-state"
  ]);
});

test("Advisor IPC uses normalized envelopes for history, consent, turns, cancellation, and clearing", async () => {
  const handlers = fixtures(() => true);
  assert.equal((await handlers["produdash:getAdvisorHistory"]({})).ok, true);
  assert.equal(
    (await handlers["produdash:grantAdvisorConsent"]({}, { profileId: "provider-1", dataCategories: ["dashboard_summary"] })).ok,
    true
  );
  assert.equal((await handlers["produdash:sendAdvisorTurn"]({}, { requestId: "request-1" })).ok, true);
  assert.equal((await handlers["produdash:cancelAdvisorTurn"]({}, { requestId: "request-1" })).data.canceled, true);
  assert.equal((await handlers["produdash:clearAdvisorHistory"]({})).ok, true);
});

test("media job IPC keeps output selection and lifecycle operations in normalized envelopes", async () => {
  const handlers = fixtures(() => true);
  assert.equal((await handlers["produdash:chooseMediaOutputFolder"]({})).data.id, "output-1");
  assert.equal((await handlers["produdash:createMediaJob"]({}, { title: "Local job" })).ok, true);
  assert.equal(
    (await handlers["produdash:updateMediaCandidate"]({}, { jobId: "mediajob-1", candidateId: "candidate-1", values: { title: "Edited" } }))
      .ok,
    true
  );
  assert.equal((await handlers["produdash:approveMediaCandidates"]({}, { jobId: "mediajob-1", candidateIds: ["candidate-1"] })).ok, true);
  assert.equal((await handlers["produdash:cancelMediaJob"]({}, { jobId: "mediajob-1" })).ok, true);
  assert.equal((await handlers["produdash:retryMediaJob"]({}, { jobId: "mediajob-1" })).ok, true);
  assert.equal(
    (await handlers["produdash:selectMediaJobThumbnail"]({}, { jobId: "mediajob-1", thumbnailId: "artifact-1234567890abcdef12345678" })).ok,
    true
  );
  assert.equal(
    (await handlers["produdash:addMediaJobThumbnail"]({}, { jobId: "mediajob-1", groupId: "thumbgroup-1234567890abcdef1234" })).ok,
    true
  );
  assert.equal((await handlers["produdash:openMediaJobOutput"]({}, { jobId: "mediajob-1" })).ok, true);
});

test("publishing IPC keeps approval, export, and cancellation in normalized envelopes", async () => {
  const handlers = fixtures(() => true);
  assert.equal((await handlers["produdash:createPostPlan"]({}, { title: "Post" })).ok, true);
  assert.equal(
    (
      await handlers["produdash:updatePostPlanDraft"](
        {},
        { planId: "post-1", values: { platformPackages: [], scheduledFor: "", timeZone: "UTC" } }
      )
    ).ok,
    true
  );
  assert.equal((await handlers["produdash:approvePostPlan"]({}, { planId: "post-1", mode: "manual_export" })).ok, true);
  assert.equal((await handlers["produdash:exportPostPackage"]({}, { planId: "post-1" })).ok, true);
  assert.equal((await handlers["produdash:cancelPostPlan"]({}, { planId: "post-1" })).ok, true);
});

test("analytics IPC keeps reports and local CSV export in normalized envelopes", async () => {
  const handlers = fixtures(() => true);
  assert.equal((await handlers["produdash:getAnalyticsReport"]({}, { businessId: "business-1" })).data.businessId, "business-1");
  assert.equal((await handlers["produdash:exportAnalyticsReport"]({}, { businessId: "business-1" })).data.exported, true);
});

test("analytics IPC forwards only the selected business and validated comparison window", async () => {
  const calls = [];
  const handlers = createHandlers({
    store: {
      getAnalyticsReport: (businessId, rangeDays) => {
        calls.push(["report", businessId, rangeDays]);
        return { businessId, rangeDays };
      }
    },
    connections: {},
    providers: {},
    isTrustedSender: () => true,
    exportAnalyticsReport: async (_event, businessId, rangeDays) => {
      calls.push(["export", businessId, rangeDays]);
      return { exported: true };
    }
  });
  assert.equal((await handlers["produdash:getAnalyticsReport"]({}, { businessId: "business-1", rangeDays: 7 })).data.rangeDays, 7);
  assert.equal((await handlers["produdash:exportAnalyticsReport"]({}, { businessId: "business-1", rangeDays: 60 })).data.exported, true);
  assert.deepEqual(calls, [
    ["report", "business-1", 7],
    ["export", "business-1", 60]
  ]);
});

test("Project IPC stays normalized and reuses typed media-job lifecycle handlers", async () => {
  const handlers = fixtures(() => true);
  assert.deepEqual((await handlers["produdash:getProjects"]({}, {})).data, { projects: [] });
  assert.equal((await handlers["produdash:createProject"]({}, { sourceMediaId: "media-1" })).data.id, "project-1");
  assert.equal(
    (await handlers["produdash:saveProjectDraft"]({}, { projectId: "project-1", renderPlan: {}, expectedRevision: 1 })).data.revision,
    2
  );
  assert.equal(
    (
      await handlers["produdash:translateProjectTranscript"](
        {},
        {
          projectId: "project-1",
          expectedRevision: 1,
          providerProfileId: "gemini",
          modelId: "model-1",
          targetLanguage: "es",
          label: "Spanish",
          consent: {
            approved: true,
            providerProfileId: "gemini",
            modelId: "model-1",
            dataCategories: ["transcript"]
          }
        }
      )
    ).data.revision,
    2
  );
  assert.equal((await handlers["produdash:prepareProject"]({}, { projectId: "project-1" })).ok, true);
  assert.equal((await handlers["produdash:renderProject"]({}, { projectId: "project-1", outputSelectionId: "output-1" })).ok, true);
});

test("speaker dubbing generates only unvoiced in-timeline drafts and saves once", async () => {
  const generatedTexts = [];
  const removedAssets = [];
  let savedPlan;
  const project = {
    id: "project-voice",
    title: "Speaker project",
    revision: 4,
    draft: {
      totalDuration: 12,
      segments: [{ id: "segment-1", sourceStart: 0, sourceEnd: 12, timelineStart: 0, duration: 12 }],
      transcript: [
        { id: "cue-host-one", start: 0, end: 2, text: "Existing", speaker: "Host" },
        { id: "cue-host-two", start: 3, end: 5, text: "Generate this", speaker: "Host" },
        { id: "cue-guest", start: 6, end: 8, text: "Not selected", speaker: "Guest" }
      ],
      localization: {
        sourceLanguage: "en",
        activeVariantId: null,
        variants: [],
        voiceovers: [
          {
            id: "voiceover-existing",
            sourceId: "cue-host-one",
            assetId: "asset-existing",
            start: 0,
            end: 1,
            status: "draft"
          }
        ]
      }
    }
  };
  const handlers = createHandlers({
    store: {},
    connections: {},
    providers: {
      generateSpeechPreview: async ({ input, providerProfileId, modelId, voice }) => {
        generatedTexts.push(input);
        return {
          audio: Buffer.alloc(64, 1),
          metadata: { providerProfileId, modelId, voice, voiceType: "built_in" }
        };
      }
    },
    mediaLibrary: {},
    projects: {
      get: () => project,
      saveDraft: async (_projectId, plan) => {
        savedPlan = plan;
        return { id: project.id, revision: 5, draft: plan };
      }
    },
    brandAssets: {
      importGeneratedVoiceover: async (_audio, metadata) => ({
        id: `asset-${metadata.sourceId}`,
        duration: 1,
        previewUrl: `produdash-media://brand/asset-${metadata.sourceId}`
      }),
      remove: async (assetId) => removedAssets.push(assetId)
    },
    mediaJobs: {},
    advisor: {},
    isTrustedSender: () => true
  });
  const response = await handlers["produdash:generateProjectSpeakerVoiceovers"](
    {},
    {
      projectId: project.id,
      expectedRevision: 4,
      speaker: "Host",
      providerProfileId: "openai",
      modelId: "gpt-4o-mini-tts",
      voice: "marin",
      consent: {
        approved: true,
        providerProfileId: "openai",
        modelId: "gpt-4o-mini-tts",
        voice: "marin",
        dataCategories: ["voiceover_text"],
        aiGeneratedDisclosureAccepted: true
      }
    }
  );
  assert.equal(response.ok, true);
  assert.deepEqual(generatedTexts, ["Generate this"]);
  assert.equal(savedPlan.localization.voiceovers.length, 2);
  assert.equal(savedPlan.localization.voiceovers[1].sourceId, "cue-host-two");
  assert.equal(savedPlan.localization.voiceovers[1].status, "draft");
  assert.deepEqual(removedAssets, []);
});

test("IPC returns controlled errors without stacks or secrets", async () => {
  const handlers = createHandlers({
    store: {
      getAppState() {
        throw Object.assign(new Error("raw token shpat_secret"), { stack: "secret stack" });
      }
    },
    connections: {},
    isTrustedSender: () => true
  });
  const response = await handlers["produdash:getAppState"]({});
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INTERNAL_ERROR");
  assert.equal(JSON.stringify(response).includes("shpat_secret"), false);
  assert.equal(JSON.stringify(response).includes("stack"), false);
});
