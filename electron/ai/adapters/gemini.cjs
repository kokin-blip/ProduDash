const { AI_CAPABILITIES } = require("../capabilities.cjs");
const { GeminiConnector, MODEL } = require("../../connectors/gemini.cjs");
const { AppError } = require("../../errors.cjs");
const { normalizeToolCalls } = require("../provider-utils.cjs");

const MODELS = [
  {
    id: MODEL,
    name: "Gemini 3.6 Flash",
    capabilities: [
      AI_CAPABILITIES.TEXT_GENERATION,
      AI_CAPABILITIES.STREAMING,
      AI_CAPABILITIES.STRUCTURED_OUTPUT,
      AI_CAPABILITIES.TOOL_CALLING,
      AI_CAPABILITIES.IMAGE_UNDERSTANDING,
      AI_CAPABILITIES.NATIVE_VIDEO_UNDERSTANDING
    ]
  }
];

class GeminiProviderAdapter {
  constructor(options = {}) {
    this.id = "gemini";
    this.name = "Google Gemini";
    this.credentialFields = [
      {
        key: "apiKey",
        label: "Gemini API key",
        type: "password",
        placeholder: "AIza…",
        sensitive: true,
        required: true
      }
    ];
    this.connector = options.connector || new GeminiConnector(options.connectorOptions);
  }

  listModels() {
    return structuredClone(MODELS);
  }

  async validate(credentials, modelId) {
    this.requireModel(modelId);
    await this.connector.validate(credentials.apiKey, modelId);
    return true;
  }

  async generateStructured({ credentials, modelId, prompt, schema, schemaName }) {
    this.requireModel(modelId);
    return this.connector.generateStructured(credentials.apiKey, prompt, schema, schemaName, modelId);
  }

  async generateText({ credentials, modelId, prompt }) {
    this.requireModel(modelId);
    return this.connector.generateText(credentials.apiKey, prompt, modelId);
  }

  async streamText({ credentials, modelId, prompt }) {
    this.requireModel(modelId);
    return this.connector.streamText(credentials.apiKey, prompt, modelId);
  }

  async generateWithTools({ credentials, modelId, prompt, tools = [], signal }) {
    this.requireModel(modelId);
    const interaction = await this.connector.generateWithTools(
      credentials.apiKey,
      prompt,
      tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      })),
      modelId,
      signal
    );
    return {
      text: interaction?.outputText || "",
      toolCalls: normalizeToolCalls(interaction?.outputs || interaction?.output),
      usage: interaction?.usageMetadata || interaction?.usage || null
    };
  }

  async analyzeImages({ credentials, modelId, prompt, images = [], schema, schemaName = "image analysis" }) {
    this.requireModel(modelId);
    if (!images.length || images.length > 12 || images.some((image) => !image?.data || !image?.mediaType)) {
      throw new AppError("INVALID_INPUT", "Gemini image analysis requires between one and twelve bounded images.");
    }
    return this.connector.generateStructuredWithMedia(
      credentials.apiKey,
      prompt,
      images.map((image) => ({ type: "image", data: image.data, mimeType: image.mediaType })),
      schema,
      schemaName,
      modelId
    );
  }

  async analyzeVideo({ credentials, modelId, prompt, videoPath, mimeType, schema, schemaName = "video analysis" }) {
    this.requireModel(modelId);
    return this.connector.generateStructuredWithMedia(
      credentials.apiKey,
      prompt,
      { type: "video", path: videoPath, mimeType },
      schema,
      schemaName,
      modelId
    );
  }

  requireModel(modelId) {
    const model = MODELS.find((item) => item.id === modelId);
    if (!model) throw new AppError("AI_MODEL_NOT_FOUND", "The selected Gemini model is unavailable.");
    return model;
  }
}

module.exports = { GeminiProviderAdapter, MODELS };
