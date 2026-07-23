const Anthropic = require("@anthropic-ai/sdk").default;
const { AppError } = require("../../errors.cjs");
const { AI_CAPABILITIES } = require("../capabilities.cjs");
const { normalizeProviderError, normalizeToolCalls, parseJsonText, withProviderTimeout } = require("../provider-utils.cjs");

const ANTHROPIC_MODELS = [
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    capabilities: [
      AI_CAPABILITIES.TEXT_GENERATION,
      AI_CAPABILITIES.STREAMING,
      AI_CAPABILITIES.STRUCTURED_OUTPUT,
      AI_CAPABILITIES.TOOL_CALLING,
      AI_CAPABILITIES.IMAGE_UNDERSTANDING
    ]
  }
];

function textFromMessage(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

class AnthropicProviderAdapter {
  constructor(options = {}) {
    this.id = "anthropic";
    this.name = "Anthropic Claude";
    this.timeoutMs = options.timeoutMs || 20_000;
    this.clientFactory = options.clientFactory || ((config) => new Anthropic(config));
    this.credentialFields = [
      {
        key: "apiKey",
        label: "Anthropic API key",
        type: "password",
        placeholder: "sk-ant-…",
        sensitive: true,
        required: true
      }
    ];
  }

  listModels() {
    return structuredClone(ANTHROPIC_MODELS);
  }

  requireModel(modelId) {
    const model = ANTHROPIC_MODELS.find((item) => item.id === modelId);
    if (!model) throw new AppError("AI_MODEL_NOT_FOUND", "The selected Claude model is unavailable.");
    return model;
  }

  createClient(credentials) {
    if (typeof credentials?.apiKey !== "string" || credentials.apiKey.trim().length < 8) {
      throw new AppError("PROVIDER_AUTH_FAILED", "Anthropic requires a valid API key.");
    }
    return this.clientFactory({ apiKey: credentials.apiKey, timeout: this.timeoutMs, maxRetries: 1 });
  }

  async request(credentials, callback) {
    try {
      return await withProviderTimeout(callback(this.createClient(credentials)), this.name, this.timeoutMs);
    } catch (error) {
      throw normalizeProviderError(error, this.name);
    }
  }

  messageParams(modelId, prompt) {
    this.requireModel(modelId);
    return { model: modelId, max_tokens: 4096, messages: [{ role: "user", content: prompt }] };
  }

  async validate(credentials, modelId) {
    await this.request(credentials, (client) =>
      client.messages.create({ ...this.messageParams(modelId, "Reply with only the word ok."), max_tokens: 8 })
    );
    return true;
  }

  async generateText({ credentials, modelId, prompt }) {
    const message = await this.request(credentials, (client) => client.messages.create(this.messageParams(modelId, prompt)));
    return textFromMessage(message);
  }

  async streamText({ credentials, modelId, prompt }) {
    return this.request(credentials, (client) => client.messages.stream(this.messageParams(modelId, prompt)));
  }

  async generateStructured({ credentials, modelId, prompt, schema, schemaName = "structured" }) {
    const message = await this.request(credentials, (client) =>
      client.messages.create({
        ...this.messageParams(modelId, prompt),
        output_config: { format: { type: "json_schema", schema } }
      })
    );
    return message?.parsed_output || parseJsonText(textFromMessage(message), this.name, schemaName);
  }

  async generateWithTools({ credentials, modelId, prompt, tools = [] }) {
    const message = await this.request(credentials, (client) =>
      client.messages.create({
        ...this.messageParams(modelId, prompt),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema
        }))
      })
    );
    return { text: textFromMessage(message), toolCalls: normalizeToolCalls(message?.content) };
  }

  async analyzeImages({ credentials, modelId, prompt, images = [], schema, schemaName = "image analysis" }) {
    this.requireModel(modelId);
    const content = images.slice(0, 12).map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data }
    }));
    content.push({ type: "text", text: prompt });
    const message = await this.request(credentials, (client) =>
      client.messages.create({
        model: modelId,
        max_tokens: 4096,
        messages: [{ role: "user", content }],
        ...(schema ? { output_config: { format: { type: "json_schema", schema } } } : {})
      })
    );
    return schema ? message?.parsed_output || parseJsonText(textFromMessage(message), this.name, schemaName) : textFromMessage(message);
  }
}

module.exports = { ANTHROPIC_MODELS, AnthropicProviderAdapter, textFromMessage };
