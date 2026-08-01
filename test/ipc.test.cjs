const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { createHandlers, sameLocalFile } = require("../electron/ipc.cjs");

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
    authorizeConfiguredLocalVoice: async () => state,
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
  assert.equal((await handlers["produdash:authorizeConfiguredLocalVoice"]({}, { providerProfileId: "xtts-local" })).ok, true);
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

test("upload-session channels exist and refuse cleanly without a publishing service", async () => {
  const handlers = fixtures(() => true);
  // Registered, so the renderer's control is reachable at all...
  assert.equal(typeof handlers["produdash:discardUploadSession"], "function");
  // ...and when official publishing is unavailable it fails in a normalized
  // envelope rather than throwing across the bridge.
  const refused = await handlers["produdash:discardUploadSession"]({}, { planId: "post-1", platformId: "youtube" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "PUBLISHING_UNSUPPORTED");
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

test("RVC conversion appends an unreviewed preview without modifying the source asset", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "produdash-ipc-rvc-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "source.wav");
  const sourceBytes = Buffer.alloc(64, 7);
  await fs.promises.writeFile(sourcePath, sourceBytes);
  let savedPlan;
  const project = {
    id: "project-rvc",
    title: "RVC project",
    revision: 2,
    draft: {
      totalDuration: 10,
      localization: {
        sourceLanguage: "en",
        activeVariantId: null,
        variants: [],
        voiceovers: [
          {
            id: "voiceover-source",
            sourceId: "cue-one",
            assetId: "asset-source",
            start: 1,
            end: 2,
            status: "reviewed",
            originalAudio: "replace",
            volume: 0.8,
            provenance: {
              providerProfileId: "openai",
              modelId: "gpt-4o-mini-tts",
              voice: "marin",
              voiceType: "built_in",
              textHash: "a".repeat(64)
            }
          }
        ]
      }
    }
  };
  const handlers = createHandlers({
    store: {},
    connections: {},
    providers: {
      convertVoicePreview: async (_payload, audio) => {
        assert.deepEqual(audio, sourceBytes);
        return {
          audio: Buffer.alloc(64, 9),
          metadata: {
            providerProfileId: "rvc-local",
            modelId: "rvc-local-model",
            voice: "Authorized RVC voice",
            voiceType: "custom"
          }
        };
      }
    },
    mediaLibrary: {},
    projects: {
      get: () => project,
      saveDraft: async (_projectId, plan) => {
        savedPlan = plan;
        return { ...project, revision: 3, draft: plan };
      }
    },
    brandAssets: {
      resolve: () => ({ filePath: sourcePath }),
      importGeneratedVoiceover: async () => ({ id: "asset-converted", duration: 1.25 }),
      remove: async () => {}
    },
    mediaJobs: {},
    advisor: {},
    isTrustedSender: () => true
  });
  const response = await handlers["produdash:convertProjectVoiceover"](
    {},
    {
      projectId: project.id,
      voiceoverId: "voiceover-source",
      expectedRevision: 2,
      providerProfileId: "rvc-local",
      modelId: "rvc-local-model",
      voiceName: "Authorized RVC voice"
    }
  );
  assert.equal(response.ok, true);
  assert.equal(savedPlan.localization.voiceovers.length, 2);
  assert.equal(savedPlan.localization.voiceovers[0].assetId, "asset-source");
  assert.equal(savedPlan.localization.voiceovers[1].assetId, "asset-converted");
  assert.equal(savedPlan.localization.voiceovers[1].status, "draft");
  assert.equal(savedPlan.localization.voiceovers[1].provenance.voiceType, "custom");
  assert.deepEqual(await fs.promises.readFile(sourcePath), sourceBytes);
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

// The packaged Windows build rejected its own renderer while macOS accepted it:
// appUrl is built by pathToFileURL() and the frame's URL by Chromium via
// loadFile(), and the two spell the same file differently. Comparing resolved
// paths answers the question being asked without depending on one spelling.
test("sender identity survives two spellings of the same file, and only that file", () => {
  const indexPath = path.join(__dirname, "..", "index.html");
  const canonical = pathToFileURL(indexPath).href;

  assert.equal(sameLocalFile(canonical, canonical), true);

  // A path segment needing escaping is where the two builders diverge: one
  // percent-encodes the space, the other leaves it literal. Same file.
  const spaced = pathToFileURL(path.join(os.tmpdir(), "Produ Dash", "index.html")).href;
  assert.equal(spaced.includes("%20"), true, "precondition: pathToFileURL encodes the space");
  assert.equal(sameLocalFile(spaced.replace(/%20/g, " "), spaced), true);

  // A different file in the same directory is still refused.
  assert.equal(sameLocalFile(pathToFileURL(path.join(__dirname, "..", "package.json")).href, canonical), false);

  // Nothing that is not a local file can be the renderer.
  for (const hostile of ["https://example.com/index.html", "data:text/html,<p>x", "", null, undefined]) {
    assert.equal(sameLocalFile(hostile, canonical), false);
  }

  // Case folding is correct per platform: Windows paths are case-insensitive,
  // and folding anywhere else would let a genuinely different file through.
  const shouted = canonical.replace(/index\.html$/, "INDEX.HTML");
  assert.equal(sameLocalFile(shouted, canonical), process.platform === "win32");
});
