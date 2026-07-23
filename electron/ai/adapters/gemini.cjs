const { AI_CAPABILITIES } = require("../capabilities.cjs");
const { GeminiConnector, MODEL } = require("../../connectors/gemini.cjs");
const { AppError } = require("../../errors.cjs");

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

  requireModel(modelId) {
    const model = MODELS.find((item) => item.id === modelId);
    if (!model) throw new AppError("AI_MODEL_NOT_FOUND", "The selected Gemini model is unavailable.");
    return model;
  }
}

module.exports = { GeminiProviderAdapter, MODELS };
