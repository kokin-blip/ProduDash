const { AppError, asAppError } = require("../errors.cjs");
const { boundedString, requireId } = require("../validation.cjs");
const { AI_WORKLOADS, WORKLOAD_REQUIREMENTS, hasCapabilities } = require("./capabilities.cjs");
const { buildDraftPrompt, DRAFT_SCHEMA, validateDraftResult } = require("./draft-contract.cjs");
const { AI_CAPABILITIES } = require("./capabilities.cjs");
const { invokeCapability } = require("./provider-contract.cjs");
const {
  TRANSLATION_SCHEMA,
  buildTranslationPrompt,
  canonicalLanguage,
  createTranslationVariant,
  normalizeSourceCues,
  validateTranslationConsent,
  validateTranslationResult
} = require("./translation-contract.cjs");
const { BUILT_IN_VOICES, normalizeSpeechRequest, validateSpeechConsent } = require("./speech-contract.cjs");
const { LIKENESS_TERMS_VERSION, requireLikenessAcceptance } = require("./voice-likeness-contract.cjs");

class ProviderService {
  constructor({ store, registry }) {
    this.store = store;
    this.registry = registry;
  }

  async initialize() {
    return this.store.syncAiProviderCredentialStatus((providerType, profile) => {
      if (!this.registry.has(providerType)) return null;
      const adapter = this.registry.get(providerType);
      return {
        credentialFields: adapter.credentialFields,
        models: adapter.listModels(profile),
        name: adapter.name
      };
    });
  }

  getCatalog() {
    return this.registry.listProviderTypes();
  }

  getNativeCredentialField(profileId, fieldKey) {
    const profile = this.store.getAiProvider(profileId);
    const adapter = this.registry.get(profile.providerType);
    const field = adapter.credentialFields.find((item) => item.key === fieldKey && item.type === "native-file");
    if (!field) throw new AppError("INVALID_INPUT", "The selected local provider file type is invalid.");
    return structuredClone(field);
  }

  async saveCredentials(profileId, values) {
    const profile = this.store.getAiProvider(profileId);
    const adapter = this.registry.get(profile.providerType);
    await this.store.saveAiProviderCredentials(profileId, values, adapter.credentialFields);
    const configured = this.store.getAiProvider(profileId);
    const models = adapter.listModels(configured);
    const selectedModelId =
      typeof values?.selectedModelId === "string" && models.some((model) => model.id === values.selectedModelId)
        ? values.selectedModelId
        : configured.selectedModelId;
    await this.store.updateAiProviderModels(profileId, models, selectedModelId);
    return this.testConnection(profileId);
  }

  async saveCredentialDraft(profileId, values) {
    const profile = this.store.getAiProvider(profileId);
    const adapter = this.registry.get(profile.providerType);
    return this.store.saveAiProviderCredentials(profileId, values, adapter.allCredentialFields || adapter.credentialFields);
  }

  async testConnection(profileId) {
    const profile = this.store.getAiProvider(profileId);
    const adapter = this.registry.get(profile.providerType);
    const credentials = this.store.getAiProviderCredentials(profileId);
    try {
      await adapter.validate(credentials, profile.selectedModelId);
      return this.store.setAiProviderResult(profileId, {
        status: "connected",
        error: null,
        lastValidatedAt: new Date().toISOString()
      });
    } catch (error) {
      const safe = asAppError(error, "PROVIDER_CONNECTION_FAILED", "The AI provider could not be validated.");
      await this.store.setAiProviderResult(profileId, {
        status: "error",
        error: safe.message,
        lastValidatedAt: new Date().toISOString()
      });
      throw safe;
    }
  }

  async removeCredentials(profileId) {
    return this.store.removeAiProviderCredentials(profileId);
  }

  async setWorkload(workloadId, selection) {
    if (!Object.values(AI_WORKLOADS).includes(workloadId)) {
      throw new AppError("INVALID_AI_WORKLOAD", "The selected AI workload is not supported.");
    }
    if (selection?.mode === "same_as_advisor") {
      if (![AI_WORKLOADS.CLIP_ANALYSIS].includes(workloadId)) {
        throw new AppError("INVALID_AI_WORKLOAD", "This workload cannot inherit the advisor model.");
      }
      const advisor = this.store.getAiWorkload(AI_WORKLOADS.ADVISOR);
      this.assertCompatible(workloadId, advisor);
      return this.store.setAiWorkload(workloadId, { mode: "same_as_advisor" });
    }
    if (selection?.mode === "unassigned" && workloadId === AI_WORKLOADS.TRANSCRIPTION) {
      return this.store.setAiWorkload(workloadId, { mode: "unassigned" });
    }
    const normalized = {
      mode: "provider",
      profileId: requireId(selection?.profileId, "AI provider"),
      modelId: boundedString(selection?.modelId, { label: "AI model", min: 1, max: 200 })
    };
    this.assertCompatible(workloadId, normalized);
    return this.store.setAiWorkload(workloadId, normalized);
  }

  assertCompatible(workloadId, selection) {
    const resolved = selection?.mode === "same_as_advisor" ? this.store.getAiWorkload(AI_WORKLOADS.ADVISOR) : selection;
    if (!resolved || resolved.mode !== "provider") {
      throw new AppError("AI_WORKLOAD_UNASSIGNED", "Select a provider and model for this workload.");
    }
    const profile = this.store.getAiProvider(resolved.profileId);
    const model = profile.models.find((item) => item.id === resolved.modelId);
    if (!model || !hasCapabilities(model, WORKLOAD_REQUIREMENTS[workloadId])) {
      throw new AppError("CAPABILITY_UNSUPPORTED", "The selected model does not support this workload.");
    }
    return { profile, model };
  }

  resolveWorkload(workloadId) {
    const selection = this.store.getAiWorkload(workloadId);
    const resolved = selection?.mode === "same_as_advisor" ? this.store.getAiWorkload(AI_WORKLOADS.ADVISOR) : selection;
    const { profile, model } = this.assertCompatible(workloadId, resolved);
    if (profile.status !== "connected") {
      throw new AppError("PROVIDER_NOT_READY", "Validate the selected AI provider before using this workload.");
    }
    return {
      adapter: this.registry.get(profile.providerType),
      credentials: this.store.getAiProviderCredentials(profile.id),
      profile,
      model
    };
  }

  resolveExplicitProvider(profileId, modelId, requiredCapabilities) {
    const profile = this.store.getAiProvider(requireId(profileId, "AI provider"));
    const selectedModelId = boundedString(modelId, { label: "AI model", min: 1, max: 200 });
    const model = profile.models.find((item) => item.id === selectedModelId);
    if (!model || !hasCapabilities(model, requiredCapabilities)) {
      throw new AppError("CAPABILITY_UNSUPPORTED", "The selected model does not support structured transcript translation.");
    }
    if (profile.status !== "connected") {
      throw new AppError("PROVIDER_NOT_READY", "Validate the selected AI provider before translating a transcript.");
    }
    return {
      adapter: this.registry.get(profile.providerType),
      credentials: this.store.getAiProviderCredentials(profile.id),
      profile,
      model
    };
  }

  async translateTranscript(input) {
    const provider = this.resolveExplicitProvider(input?.providerProfileId, input?.modelId, [
      AI_CAPABILITIES.TEXT_GENERATION,
      AI_CAPABILITIES.STRUCTURED_OUTPUT
    ]);
    validateTranslationConsent(input?.consent, { profileId: provider.profile.id, modelId: provider.model.id });
    const sourceLanguage = canonicalLanguage(input?.sourceLanguage, "Source language");
    const targetLanguage = canonicalLanguage(input?.targetLanguage, "Target language");
    if (sourceLanguage === targetLanguage) {
      throw new AppError("INVALID_TRANSLATION", "Source and target languages must be different.");
    }
    const sourceCues = normalizeSourceCues(input?.cues);
    const result = await invokeCapability(provider.adapter, provider.model, AI_CAPABILITIES.STRUCTURED_OUTPUT, {
      credentials: provider.credentials,
      prompt: buildTranslationPrompt({ sourceLanguage, targetLanguage, cues: sourceCues }),
      schema: TRANSLATION_SCHEMA,
      schemaName: "transcript translation"
    });
    return {
      sourceLanguage,
      variant: createTranslationVariant({
        language: targetLanguage,
        label: input?.label,
        cues: validateTranslationResult(result, sourceCues),
        profileId: provider.profile.id,
        modelId: provider.model.id
      })
    };
  }

  async generateSpeechPreview(input) {
    const provider = this.resolveExplicitProvider(input?.providerProfileId, input?.modelId, [AI_CAPABILITIES.SPEECH_GENERATION]);
    const allowedCustomVoices = (this.store.getAppState().voiceLikeness?.voices || [])
      .filter((voice) => voice.providerProfileId === provider.profile.id)
      .map((voice) => voice.id);
    const allowedBuiltInVoices =
      provider.profile.providerType === "openai"
        ? BUILT_IN_VOICES
        : provider.profile.providerType === "piper-local"
          ? ["configured-model"]
          : provider.profile.providerType === "kokoro-local" && provider.profile.publicValues?.voiceId
            ? [provider.profile.publicValues.voiceId]
            : provider.profile.providerType === "openai-compatible" && provider.profile.publicValues?.voiceId
              ? [provider.profile.publicValues.voiceId]
              : [];
    const request = normalizeSpeechRequest(input, { allowedCustomVoices, allowedBuiltInVoices });
    validateSpeechConsent(input?.consent, {
      profileId: provider.profile.id,
      modelId: provider.model.id,
      voice: request.voice
    });
    const audio = await invokeCapability(provider.adapter, provider.model, AI_CAPABILITIES.SPEECH_GENERATION, {
      credentials: provider.credentials,
      ...request
    });
    return {
      audio,
      metadata: {
        providerProfileId: provider.profile.id,
        modelId: provider.model.id,
        voice: request.voice,
        voiceType: request.voiceType,
        format: "wav",
        aiGenerated: true,
        disclosure:
          request.voiceType === "custom"
            ? "Synthetic voice likeness; not the original speaker recording."
            : "AI-generated voice; not a human recording."
      }
    };
  }

  async createCustomVoice(input, recordings) {
    const profile = this.store.getAiProvider(input?.providerProfileId);
    if (profile.status !== "connected") {
      throw new AppError("PROVIDER_NOT_READY", "Validate the selected voice provider before creating a custom voice.");
    }
    if (!this.store.hasCurrentVoiceLikenessAcceptance(LIKENESS_TERMS_VERSION)) {
      const acceptance = requireLikenessAcceptance(input?.acceptance);
      await this.store.acceptVoiceLikenessTerms(acceptance);
    }
    const name = boundedString(input?.name, { label: "Custom voice name", min: 1, max: 64 });
    const language = boundedString(input?.language, { label: "Consent language", min: 2, max: 5 });
    const adapter = this.registry.get(profile.providerType);
    if (typeof adapter.createCustomVoice !== "function") {
      throw new AppError("CAPABILITY_UNSUPPORTED", "This provider does not support custom voice creation.");
    }
    const created = await adapter.createCustomVoice({
      credentials: this.store.getAiProviderCredentials(profile.id),
      name,
      language,
      ...recordings
    });
    await this.store.addCustomVoice({
      id: created.id,
      name: created.name || name,
      providerProfileId: profile.id,
      providerType: profile.providerType,
      consentId: created.consentId,
      consentEvidenceHash: created.consentEvidenceHash || null,
      language,
      createdAt: new Date().toISOString(),
      aiGenerated: true,
      disclosure: "Synthetic voice likeness; not the original speaker recording."
    });
    return this.store.getAppState();
  }

  async removeCustomVoice(input) {
    const profileId = requireId(input?.providerProfileId, "Voice provider");
    const voiceId = requireId(input?.voiceId, "Custom voice");
    const voice = (this.store.getAppState().voiceLikeness?.voices || []).find(
      (item) => item.providerProfileId === profileId && item.id === voiceId
    );
    if (!voice) throw new AppError("CUSTOM_VOICE_NOT_FOUND", "The selected custom voice is unavailable.");
    const profile = this.store.getAiProvider(profileId);
    const adapter = this.registry.get(profile.providerType);
    const credentials = this.store.getAiProviderCredentials(profile.id);
    if (profile.credentialStatus === "stored" && typeof adapter.deleteCustomVoice === "function") {
      await adapter.deleteCustomVoice({ credentials, voiceId });
    } else if (profile.credentialStatus === "stored" && voice.consentId && typeof adapter.deleteVoiceConsent === "function") {
      await adapter.deleteVoiceConsent({ credentials, consentId: voice.consentId });
    }
    return this.store.removeCustomVoice(profileId, voiceId);
  }

  async draftAiReply(conversationId, prompt) {
    const provider = this.resolveWorkload(AI_WORKLOADS.INBOX_DRAFTING);
    const connector = {
      draftReply: async (conversation, instruction, business) => {
        const result = await invokeCapability(provider.adapter, provider.model, AI_CAPABILITIES.STRUCTURED_OUTPUT, {
          credentials: provider.credentials,
          prompt: buildDraftPrompt(conversation, instruction, business),
          schema: DRAFT_SCHEMA,
          schemaName: "approval draft"
        });
        return validateDraftResult(result);
      }
    };
    return this.store.draftAiReply(conversationId, prompt, connector);
  }
}

module.exports = { ProviderService };
