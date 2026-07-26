const assert = require("node:assert/strict");
const test = require("node:test");
const { AI_CAPABILITIES } = require("../electron/ai/capabilities.cjs");
const { invokeCapability, requireCapability } = require("../electron/ai/provider-contract.cjs");
const { ProviderRegistry } = require("../electron/ai/provider-registry.cjs");
const { ProviderService } = require("../electron/ai/provider-service.cjs");
const { createHarness } = require("./helpers.cjs");

function fakeAdapter(overrides = {}) {
  return {
    id: "gemini",
    name: "Test Gemini",
    credentialFields: [{ key: "apiKey", label: "API key", sensitive: true, required: true }],
    listModels: () => [
      {
        id: "gemini-3.6-flash",
        name: "Gemini 3.6 Flash",
        capabilities: [AI_CAPABILITIES.TEXT_GENERATION, AI_CAPABILITIES.STRUCTURED_OUTPUT]
      }
    ],
    validate: async () => true,
    generateStructured: async ({ prompt }) => ({ prompt }),
    ...overrides
  };
}

test("capability contracts reject unknown, undeclared, and unimplemented operations uniformly", async () => {
  const model = { id: "model", capabilities: [AI_CAPABILITIES.STRUCTURED_OUTPUT, AI_CAPABILITIES.STREAMING] };
  assert.throws(
    () => requireCapability(model, AI_CAPABILITIES.EMBEDDINGS),
    (error) => error.code === "CAPABILITY_UNSUPPORTED"
  );
  assert.throws(
    () => requireCapability(model, "made_up_capability"),
    (error) => error.code === "CAPABILITY_UNSUPPORTED"
  );
  await assert.rejects(
    () => invokeCapability({}, model, AI_CAPABILITIES.STREAMING, {}),
    (error) => error.code === "CAPABILITY_UNSUPPORTED"
  );
  const result = await invokeCapability(
    { generateStructured: async ({ modelId }) => modelId },
    model,
    AI_CAPABILITIES.STRUCTURED_OUTPUT,
    {}
  );
  assert.equal(result, "model");
});

test("provider initialization refreshes public model metadata without exposing credentials", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const adapter = fakeAdapter();
  const providers = new ProviderService({ store: harness.store, registry: new ProviderRegistry([adapter]) });
  await providers.initialize();
  await harness.store.saveAiProviderCredentials("gemini", { apiKey: "AIza-private-key" }, adapter.credentialFields);
  const state = await providers.testConnection("gemini");
  const profile = state.aiProviders[0];
  assert.equal(profile.name, "Test Gemini");
  assert.deepEqual(profile.models, adapter.listModels());
  assert.equal(profile.status, "connected");
  assert.equal(JSON.stringify(state).includes("AIza-private-key"), false);
});

test("workload assignments enforce capabilities and same-as-advisor compatibility", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const providers = new ProviderService({
    store: harness.store,
    registry: new ProviderRegistry([fakeAdapter()])
  });
  await providers.initialize();
  const state = await providers.setWorkload("clipAnalysis", { mode: "same_as_advisor" });
  assert.equal(state.aiWorkloads.clipAnalysis.mode, "same_as_advisor");
  await assert.rejects(
    () =>
      providers.setWorkload("transcription", {
        mode: "provider",
        profileId: "gemini",
        modelId: "gemini-3.6-flash"
      }),
    (error) => error.code === "CAPABILITY_UNSUPPORTED"
  );
  const unassigned = await providers.setWorkload("transcription", { mode: "unassigned" });
  assert.equal(unassigned.aiWorkloads.transcription.mode, "unassigned");
});

test("provider translation requires exact consent and validates every returned cue", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  let request;
  const adapter = fakeAdapter({
    generateStructured: async (input) => {
      request = input;
      return {
        cues: [
          { sourceId: "cue-1", text: "Hola mundo" },
          { sourceId: "cue-2", text: "Siguiente paso" }
        ]
      };
    }
  });
  const providers = new ProviderService({ store: harness.store, registry: new ProviderRegistry([adapter]) });
  await providers.initialize();
  await harness.store.saveAiProviderCredentials("gemini", { apiKey: "private" }, adapter.credentialFields);
  await providers.testConnection("gemini");
  const input = {
    providerProfileId: "gemini",
    modelId: "gemini-3.6-flash",
    sourceLanguage: "en-US",
    targetLanguage: "es-MX",
    label: "Spanish",
    cues: [
      { id: "cue-1", text: "Hello world" },
      { id: "cue-2", text: "Next step" }
    ],
    consent: {
      approved: true,
      providerProfileId: "gemini",
      modelId: "gemini-3.6-flash",
      dataCategories: ["transcript"]
    }
  };
  const translated = await providers.translateTranscript(input);
  assert.equal(translated.sourceLanguage, "en-US");
  assert.equal(translated.variant.status, "draft");
  assert.equal(translated.variant.provenance.source, "provider");
  assert.deepEqual(
    translated.variant.cues.map((cue) => cue.text),
    ["Hola mundo", "Siguiente paso"]
  );
  assert.equal(request.schemaName, "transcript translation");
  assert.match(request.prompt, /untrusted quoted data/);
  assert.equal(request.prompt.includes("private"), false);
  await assert.rejects(
    () => providers.translateTranscript({ ...input, consent: { ...input.consent, approved: false } }),
    (error) => error.code === "TRANSLATION_CONSENT_REQUIRED"
  );
});

test("provider translation rejects malformed output without fallback", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const adapter = fakeAdapter({
    generateStructured: async () => ({ cues: [{ sourceId: "wrong-id", text: "Texto" }] })
  });
  const providers = new ProviderService({ store: harness.store, registry: new ProviderRegistry([adapter]) });
  await providers.initialize();
  await harness.store.saveAiProviderCredentials("gemini", { apiKey: "private" }, adapter.credentialFields);
  await providers.testConnection("gemini");
  await assert.rejects(
    () =>
      providers.translateTranscript({
        providerProfileId: "gemini",
        modelId: "gemini-3.6-flash",
        sourceLanguage: "en",
        targetLanguage: "es",
        label: "Spanish",
        cues: [{ id: "cue-1", text: "Hello" }],
        consent: {
          approved: true,
          providerProfileId: "gemini",
          modelId: "gemini-3.6-flash",
          dataCategories: ["transcript"]
        }
      }),
    (error) => error.code === "PROVIDER_INVALID_RESPONSE"
  );
});

test("speech previews require exact disclosure consent and reject custom voices", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const adapter = {
    id: "openai",
    name: "OpenAI",
    credentialFields: [{ key: "apiKey", label: "API key", sensitive: true, required: true }],
    listModels: () => [
      {
        id: "gpt-4o-mini-tts",
        name: "GPT-4o mini TTS",
        capabilities: [AI_CAPABILITIES.SPEECH_GENERATION]
      }
    ],
    validate: async () => true,
    generateSpeech: async () => Buffer.alloc(64, 1)
  };
  const providers = new ProviderService({ store: harness.store, registry: new ProviderRegistry([adapter]) });
  await providers.initialize();
  await harness.store.saveAiProviderCredentials("openai", { apiKey: "private" }, adapter.credentialFields);
  await providers.testConnection("openai");
  const input = {
    providerProfileId: "openai",
    modelId: "gpt-4o-mini-tts",
    input: "A clearly disclosed preview.",
    voice: "marin",
    instructions: "Speak calmly.",
    consent: {
      approved: true,
      providerProfileId: "openai",
      modelId: "gpt-4o-mini-tts",
      voice: "marin",
      dataCategories: ["voiceover_text"],
      aiGeneratedDisclosureAccepted: true
    }
  };
  const result = await providers.generateSpeechPreview(input);
  assert.equal(result.audio.length, 64);
  assert.equal(result.metadata.aiGenerated, true);
  assert.match(result.metadata.disclosure, /not a human recording/);
  await assert.rejects(
    () =>
      providers.generateSpeechPreview({
        ...input,
        consent: { ...input.consent, aiGeneratedDisclosureAccepted: false }
      }),
    (error) => error.code === "SPEECH_CONSENT_REQUIRED"
  );
  await assert.rejects(
    () =>
      providers.generateSpeechPreview({
        ...input,
        voice: "voice_custom_person",
        consent: { ...input.consent, voice: "voice_custom_person" }
      }),
    (error) => error.code === "CUSTOM_VOICE_UNAVAILABLE"
  );
});

test("speech voices are scoped to their connected provider profile", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  let generatedVoice;
  const adapter = {
    id: "elevenlabs",
    name: "ElevenLabs",
    credentialFields: [{ key: "apiKey", label: "API key", sensitive: true, required: true }],
    listModels: () => [
      {
        id: "eleven_multilingual_v2",
        name: "Eleven Multilingual v2",
        capabilities: [AI_CAPABILITIES.SPEECH_GENERATION]
      }
    ],
    validate: async () => true,
    generateSpeech: async ({ voice }) => {
      generatedVoice = voice;
      return Buffer.alloc(64, 1);
    }
  };
  const providers = new ProviderService({ store: harness.store, registry: new ProviderRegistry([adapter]) });
  await providers.initialize();
  await harness.store.saveAiProviderCredentials("elevenlabs", { apiKey: "private-key" }, adapter.credentialFields);
  await providers.testConnection("elevenlabs");
  const input = {
    providerProfileId: "elevenlabs",
    modelId: "eleven_multilingual_v2",
    input: "Provider-scoped speech.",
    voice: "marin",
    consent: {
      approved: true,
      providerProfileId: "elevenlabs",
      modelId: "eleven_multilingual_v2",
      voice: "marin",
      dataCategories: ["voiceover_text"],
      aiGeneratedDisclosureAccepted: true
    }
  };
  await assert.rejects(
    () => providers.generateSpeechPreview(input),
    (error) => error.code === "CUSTOM_VOICE_UNAVAILABLE"
  );
  await harness.store.addCustomVoice({
    id: "voice_eleven_authorized",
    name: "Authorized ElevenLabs voice",
    providerProfileId: "elevenlabs",
    providerType: "elevenlabs",
    consentId: null,
    language: "en",
    createdAt: new Date().toISOString()
  });
  await providers.generateSpeechPreview({
    ...input,
    voice: "voice_eleven_authorized",
    consent: { ...input.consent, voice: "voice_eleven_authorized" }
  });
  assert.equal(generatedVoice, "voice_eleven_authorized");
});

test("local Piper speech is provider-scoped and keeps paths out of returned metadata", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  let speechRequest;
  const adapter = {
    id: "piper-local",
    name: "Local Piper",
    credentialFields: [
      { key: "executablePath", label: "Piper executable", sensitive: true, required: true },
      { key: "modelPath", label: "Piper model", sensitive: true, required: true }
    ],
    listModels: () => [
      {
        id: "piper-local-model",
        name: "Configured Piper voice model",
        capabilities: [AI_CAPABILITIES.SPEECH_GENERATION]
      }
    ],
    validate: async () => true,
    generateSpeech: async (request) => {
      speechRequest = request;
      return Buffer.alloc(64, 1);
    }
  };
  const providers = new ProviderService({ store: harness.store, registry: new ProviderRegistry([adapter]) });
  await providers.initialize();
  await harness.store.saveAiProviderCredentials(
    "piper-local",
    { executablePath: "/private/piper", modelPath: "/private/voice.onnx" },
    adapter.credentialFields
  );
  await providers.testConnection("piper-local");
  const input = {
    providerProfileId: "piper-local",
    modelId: "piper-local-model",
    input: "This text stays local.",
    voice: "configured-model",
    consent: {
      approved: true,
      providerProfileId: "piper-local",
      modelId: "piper-local-model",
      voice: "configured-model",
      dataCategories: ["voiceover_text"],
      aiGeneratedDisclosureAccepted: true
    }
  };
  const result = await providers.generateSpeechPreview(input);
  assert.equal(speechRequest.voice, "configured-model");
  assert.equal(speechRequest.voiceType, "built_in");
  assert.match(result.metadata.disclosure, /AI-generated voice/);
  assert.doesNotMatch(JSON.stringify(result.metadata), /private|executable|onnx/i);
  await assert.rejects(() => providers.generateSpeechPreview({ ...input, voice: "alloy" }), {
    code: "CUSTOM_VOICE_UNAVAILABLE"
  });
});

test("custom voice creation requires first-use acceptance and authorizes only the created voice", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  let speechRequest;
  let deletedConsentId;
  const adapter = {
    id: "openai",
    name: "OpenAI",
    credentialFields: [{ key: "apiKey", label: "API key", sensitive: true, required: true }],
    listModels: () => [
      {
        id: "gpt-4o-mini-tts",
        name: "GPT-4o mini TTS",
        capabilities: [AI_CAPABILITIES.SPEECH_GENERATION]
      }
    ],
    validate: async () => true,
    createCustomVoice: async () => ({ id: "voice_authorized", consentId: "consent_1", name: "Authorized voice" }),
    deleteVoiceConsent: async ({ consentId }) => {
      deletedConsentId = consentId;
    },
    generateSpeech: async (request) => {
      speechRequest = request;
      return Buffer.alloc(64, 1);
    }
  };
  const providers = new ProviderService({ store: harness.store, registry: new ProviderRegistry([adapter]) });
  await providers.initialize();
  await harness.store.saveAiProviderCredentials("openai", { apiKey: "private" }, adapter.credentialFields);
  await providers.testConnection("openai");
  const request = {
    providerProfileId: "openai",
    name: "Authorized voice",
    language: "en",
    acceptance: {
      termsVersion: "2026-07-24",
      legalName: "Authorized Adult",
      relationship: "self",
      adultConfirmed: true,
      rightsConfirmed: true,
      consentConfirmed: true,
      syntheticDisclosureConfirmed: true,
      misuseResponsibilityConfirmed: true,
      providerTermsConfirmed: true
    }
  };
  await assert.rejects(
    () =>
      providers.createCustomVoice(
        { ...request, acceptance: { ...request.acceptance, rightsConfirmed: false } },
        { consentRecording: {}, sampleRecording: {} }
      ),
    (error) => error.code === "VOICE_LIKENESS_ACCEPTANCE_REQUIRED"
  );
  const state = await providers.createCustomVoice(request, { consentRecording: {}, sampleRecording: {} });
  assert.equal(state.voiceLikeness.voices[0].id, "voice_authorized");
  assert.equal(JSON.stringify(state).includes("Authorized Adult"), false);
  const speechInput = {
    providerProfileId: "openai",
    modelId: "gpt-4o-mini-tts",
    input: "Disclosed synthetic speech.",
    voice: "voice_authorized",
    consent: {
      approved: true,
      providerProfileId: "openai",
      modelId: "gpt-4o-mini-tts",
      voice: "voice_authorized",
      dataCategories: ["voiceover_text"],
      aiGeneratedDisclosureAccepted: true
    }
  };
  const result = await providers.generateSpeechPreview(speechInput);
  assert.equal(speechRequest.voiceType, "custom");
  assert.match(result.metadata.disclosure, /Synthetic voice likeness/);
  const removed = await providers.removeCustomVoice({
    providerProfileId: "openai",
    voiceId: "voice_authorized"
  });
  assert.equal(deletedConsentId, "consent_1");
  assert.equal(removed.voiceLikeness.voices.length, 0);
  await assert.rejects(
    () => providers.generateSpeechPreview(speechInput),
    (error) => error.code === "CUSTOM_VOICE_UNAVAILABLE"
  );
});

test("custom voice removal preserves local authorization when provider deletion fails", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const adapter = {
    id: "elevenlabs",
    name: "ElevenLabs",
    credentialFields: [{ key: "apiKey", label: "API key", sensitive: true, required: true }],
    listModels: () => [
      {
        id: "eleven_multilingual_v2",
        name: "Eleven Multilingual v2",
        capabilities: [AI_CAPABILITIES.SPEECH_GENERATION]
      }
    ],
    validate: async () => true,
    deleteCustomVoice: async () => {
      throw Object.assign(new Error("raw provider detail"), {
        code: "PROVIDER_REQUEST_FAILED"
      });
    }
  };
  const providers = new ProviderService({ store: harness.store, registry: new ProviderRegistry([adapter]) });
  await providers.initialize();
  await harness.store.saveAiProviderCredentials("elevenlabs", { apiKey: "private-key" }, adapter.credentialFields);
  await harness.store.addCustomVoice({
    id: "voice_keep",
    name: "Keep until remote deletion succeeds",
    providerProfileId: "elevenlabs",
    providerType: "elevenlabs",
    consentId: null,
    language: "en",
    createdAt: new Date().toISOString()
  });
  await assert.rejects(() =>
    providers.removeCustomVoice({
      providerProfileId: "elevenlabs",
      voiceId: "voice_keep"
    })
  );
  assert.equal(harness.store.getAppState().voiceLikeness.voices[0].id, "voice_keep");
});
