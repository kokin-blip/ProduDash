const { AppError } = require("../../errors.cjs");
const { AI_CAPABILITIES } = require("../capabilities.cjs");
const { boundedString } = require("../../validation.cjs");
const { createOriginLockedFetch, normalizeCustomEndpoint } = require("../endpoint-validation.cjs");
const { OpenAIProviderAdapter } = require("./openai.cjs");

const CONFIGURABLE_CAPABILITIES = new Set([
  AI_CAPABILITIES.TEXT_GENERATION,
  AI_CAPABILITIES.STREAMING,
  AI_CAPABILITIES.STRUCTURED_OUTPUT,
  AI_CAPABILITIES.TOOL_CALLING,
  AI_CAPABILITIES.IMAGE_UNDERSTANDING,
  AI_CAPABILITIES.AUDIO_TRANSCRIPTION,
  AI_CAPABILITIES.EMBEDDINGS
]);

function parseConfiguredCapabilities(value) {
  const entries = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = [...new Set(entries)];
  if (unique.some((item) => !CONFIGURABLE_CAPABILITIES.has(item))) {
    throw new AppError("INVALID_PROVIDER_CAPABILITIES", "One or more custom provider capabilities are not supported.");
  }
  return unique;
}

class OpenAICompatibleProviderAdapter extends OpenAIProviderAdapter {
  constructor(options = {}) {
    super({
      ...options,
      id: "openai-compatible",
      name: "OpenAI-compatible endpoint",
      credentialFields: [
        {
          key: "endpointUrl",
          label: "Endpoint URL",
          type: "url",
          placeholder: "https://provider.example/v1",
          sensitive: false,
          required: true
        },
        {
          key: "modelId",
          label: "Model ID",
          type: "text",
          placeholder: "provider-model",
          sensitive: false,
          required: true
        },
        {
          key: "capabilities",
          label: "Verified capabilities",
          type: "text",
          placeholder: "text_generation,streaming",
          sensitive: false,
          required: true
        },
        {
          key: "apiKey",
          label: "API key",
          type: "password",
          placeholder: "Provider API key",
          sensitive: true,
          required: true
        }
      ]
    });
    this.transport = options.transport || globalThis.fetch;
  }

  listModels(profile = {}) {
    const values = profile.publicValues || profile;
    const modelId = typeof values.modelId === "string" ? values.modelId.trim() : "";
    if (!modelId) return [];
    return [
      {
        id: boundedString(modelId, { label: "Custom model ID", min: 1, max: 200 }),
        name: boundedString(modelId, { label: "Custom model ID", min: 1, max: 200 }),
        capabilities: parseConfiguredCapabilities(values.capabilities)
      }
    ];
  }

  createClient(credentials) {
    const endpoint = normalizeCustomEndpoint(credentials?.endpointUrl);
    if (typeof credentials?.apiKey !== "string" || credentials.apiKey.trim().length < 8) {
      throw new AppError("PROVIDER_AUTH_FAILED", "The custom endpoint requires a valid API key.");
    }
    return this.clientFactory({
      apiKey: credentials.apiKey,
      baseURL: endpoint,
      fetch: createOriginLockedFetch(endpoint, this.transport),
      timeout: this.timeoutMs,
      maxRetries: 0
    });
  }

  requireModel(modelId, profile = null) {
    if (!modelId || (profile && !this.listModels(profile).some((model) => model.id === modelId))) {
      throw new AppError("AI_MODEL_NOT_FOUND", "Configure a valid custom provider model.");
    }
    return { id: modelId };
  }

  async validate(credentials, modelId) {
    const models = this.listModels(credentials);
    const model = models.find((item) => item.id === modelId);
    if (!model || !model.capabilities.length) {
      throw new AppError("INVALID_PROVIDER_CAPABILITIES", "Configure at least one capability before testing this endpoint.");
    }
    const client = this.createClient(credentials);
    try {
      await client.models.retrieve(modelId);
    } catch (error) {
      throw require("../provider-utils.cjs").normalizeProviderError(error, this.name);
    }
    return true;
  }
}

module.exports = {
  CONFIGURABLE_CAPABILITIES,
  OpenAICompatibleProviderAdapter,
  parseConfiguredCapabilities
};
