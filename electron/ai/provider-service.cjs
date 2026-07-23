const { AppError, asAppError } = require("../errors.cjs");
const { boundedString, requireId } = require("../validation.cjs");
const { AI_WORKLOADS, WORKLOAD_REQUIREMENTS, hasCapabilities } = require("./capabilities.cjs");
const { buildDraftPrompt, DRAFT_SCHEMA, validateDraftResult } = require("./draft-contract.cjs");
const { AI_CAPABILITIES } = require("./capabilities.cjs");
const { invokeCapability } = require("./provider-contract.cjs");

class ProviderService {
  constructor({ store, registry }) {
    this.store = store;
    this.registry = registry;
  }

  async initialize() {
    return this.store.syncAiProviderCredentialStatus((providerType) => {
      const adapter = this.registry.get(providerType);
      return {
        credentialFields: adapter.credentialFields,
        models: adapter.listModels(),
        name: adapter.name
      };
    });
  }

  getCatalog() {
    return this.registry.listProviderTypes();
  }

  async saveCredentials(profileId, values) {
    const profile = this.store.getAiProvider(profileId);
    const adapter = this.registry.get(profile.providerType);
    await this.store.saveAiProviderCredentials(profileId, values, adapter.credentialFields);
    return this.testConnection(profileId);
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
    return { adapter: this.registry.get(profile.providerType), credentials: this.store.getAiProviderCredentials(profile.id), model };
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
