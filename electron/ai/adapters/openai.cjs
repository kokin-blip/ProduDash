const fs = require("node:fs");
const OpenAI = require("openai").default;
const { AppError } = require("../../errors.cjs");
const { AI_CAPABILITIES } = require("../capabilities.cjs");
const { normalizeProviderError, normalizeToolCalls, parseJsonText, withProviderTimeout } = require("../provider-utils.cjs");

const OPENAI_MODELS = [
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    capabilities: [
      AI_CAPABILITIES.TEXT_GENERATION,
      AI_CAPABILITIES.STREAMING,
      AI_CAPABILITIES.STRUCTURED_OUTPUT,
      AI_CAPABILITIES.TOOL_CALLING,
      AI_CAPABILITIES.IMAGE_UNDERSTANDING
    ]
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    capabilities: [
      AI_CAPABILITIES.TEXT_GENERATION,
      AI_CAPABILITIES.STREAMING,
      AI_CAPABILITIES.STRUCTURED_OUTPUT,
      AI_CAPABILITIES.TOOL_CALLING,
      AI_CAPABILITIES.IMAGE_UNDERSTANDING
    ]
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    capabilities: [
      AI_CAPABILITIES.TEXT_GENERATION,
      AI_CAPABILITIES.STREAMING,
      AI_CAPABILITIES.STRUCTURED_OUTPUT,
      AI_CAPABILITIES.TOOL_CALLING,
      AI_CAPABILITIES.IMAGE_UNDERSTANDING
    ]
  },
  {
    id: "whisper-1",
    name: "Whisper 1 (timestamped transcription)",
    capabilities: [AI_CAPABILITIES.AUDIO_TRANSCRIPTION]
  },
  {
    id: "gpt-4o-mini-tts",
    name: "GPT-4o mini TTS (built-in voices)",
    capabilities: [AI_CAPABILITIES.SPEECH_GENERATION]
  }
];

class OpenAIProviderAdapter {
  constructor(options = {}) {
    this.id = options.id || "openai";
    this.name = options.name || "OpenAI";
    this.timeoutMs = options.timeoutMs || 20_000;
    this.clientFactory = options.clientFactory || ((config) => new OpenAI(config));
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.credentialFields = options.credentialFields || [
      {
        key: "apiKey",
        label: "OpenAI API key",
        type: "password",
        placeholder: "sk-…",
        sensitive: true,
        required: true
      }
    ];
  }

  listModels() {
    return structuredClone(OPENAI_MODELS);
  }

  createClient(credentials) {
    if (typeof credentials?.apiKey !== "string" || credentials.apiKey.trim().length < 8) {
      throw new AppError("PROVIDER_AUTH_FAILED", `${this.name} requires a valid API key.`);
    }
    return this.clientFactory({ apiKey: credentials.apiKey, timeout: this.timeoutMs, maxRetries: 1 });
  }

  requireModel(modelId) {
    const model = this.listModels().find((item) => item.id === modelId);
    if (!model) throw new AppError("AI_MODEL_NOT_FOUND", `The selected ${this.name} model is unavailable.`);
    return model;
  }

  async request(credentials, callback) {
    try {
      return await withProviderTimeout(callback(this.createClient(credentials)), this.name, this.timeoutMs);
    } catch (error) {
      throw normalizeProviderError(error, this.name);
    }
  }

  async validate(credentials, modelId) {
    this.requireModel(modelId);
    if (modelId === "whisper-1" || modelId === "gpt-4o-mini-tts") {
      await this.request(credentials, (client) => client.models.retrieve(modelId));
      return true;
    }
    await this.request(credentials, (client) =>
      client.responses.create({ model: modelId, input: "Reply with only the word ok.", max_output_tokens: 8 })
    );
    return true;
  }

  async generateText({ credentials, modelId, prompt }) {
    this.requireModel(modelId);
    const response = await this.request(credentials, (client) => client.responses.create({ model: modelId, input: prompt }));
    if (typeof response?.output_text !== "string") {
      throw new AppError("PROVIDER_INVALID_RESPONSE", `${this.name} returned an invalid text response.`);
    }
    return response.output_text;
  }

  async streamText({ credentials, modelId, prompt }) {
    this.requireModel(modelId);
    return this.request(credentials, (client) => client.responses.create({ model: modelId, input: prompt, stream: true }));
  }

  async generateStructured({ credentials, modelId, prompt, schema, schemaName = "structured" }) {
    this.requireModel(modelId);
    const response = await this.request(credentials, (client) =>
      client.responses.create({
        model: modelId,
        input: prompt,
        text: {
          format: {
            type: "json_schema",
            name:
              String(schemaName)
                .toLowerCase()
                .replace(/[^a-z0-9_-]/g, "_")
                .slice(0, 64) || "structured_output",
            schema,
            strict: true
          }
        }
      })
    );
    return parseJsonText(response?.output_text, this.name, schemaName);
  }

  async generateWithTools({ credentials, modelId, prompt, tools = [], signal }) {
    this.requireModel(modelId);
    const response = await this.request(credentials, (client) =>
      client.responses.create(
        {
          model: modelId,
          input: prompt,
          tools: tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: true
          }))
        },
        { signal }
      )
    );
    return { text: response?.output_text || "", toolCalls: normalizeToolCalls(response?.output), usage: response?.usage || null };
  }

  async analyzeImages({ credentials, modelId, prompt, images = [], schema, schemaName = "image analysis" }) {
    this.requireModel(modelId);
    const content = [{ type: "input_text", text: prompt }].concat(
      images.slice(0, 12).map((image) => ({
        type: "input_image",
        image_url: image.url || `data:${image.mediaType};base64,${image.data}`,
        detail: "low"
      }))
    );
    const response = await this.request(credentials, (client) =>
      client.responses.create({
        model: modelId,
        input: [{ role: "user", content }],
        ...(schema
          ? {
              text: {
                format: {
                  type: "json_schema",
                  name:
                    String(schemaName)
                      .toLowerCase()
                      .replace(/[^a-z0-9_-]/g, "_")
                      .slice(0, 64) || "image_analysis",
                  schema,
                  strict: true
                }
              }
            }
          : {})
      })
    );
    if (typeof response?.output_text !== "string") {
      throw new AppError("PROVIDER_INVALID_RESPONSE", `${this.name} returned an invalid image response.`);
    }
    return schema ? parseJsonText(response.output_text, this.name, schemaName) : response.output_text;
  }

  async transcribeAudio({ credentials, modelId, audioPath, language }) {
    this.requireModel(modelId);
    const response = await this.request(credentials, (client) =>
      client.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: modelId,
        response_format: "verbose_json",
        timestamp_granularities: ["segment", "word"],
        ...(language ? { language } : {})
      })
    );
    return response;
  }

  async generateSpeech({ credentials, modelId, input, voice, voiceType = "built_in", instructions = "" }) {
    this.requireModel(modelId);
    const response = await this.request(credentials, (client) =>
      client.audio.speech.create({
        model: modelId,
        voice: voiceType === "custom" ? { id: voice } : voice,
        input,
        ...(instructions ? { instructions } : {}),
        response_format: "wav"
      })
    );
    if (!response || typeof response.arrayBuffer !== "function") {
      throw new AppError("PROVIDER_INVALID_RESPONSE", `${this.name} returned invalid speech audio.`);
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length < 44 || audio.length > 50 * 1024 * 1024) {
      throw new AppError("PROVIDER_INVALID_RESPONSE", `${this.name} returned invalid speech audio.`);
    }
    return audio;
  }

  async postVoiceForm(credentials, pathname, fields) {
    if (typeof this.fetchImpl !== "function") {
      throw new AppError("PROVIDER_UNAVAILABLE", "OpenAI voice creation is unavailable in this runtime.");
    }
    this.createClient(credentials);
    const form = new globalThis.FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value && typeof value === "object" && value.path) {
        const data = await fs.promises.readFile(value.path);
        form.append(key, new globalThis.Blob([data], { type: value.type }), value.name);
      } else {
        form.append(key, value);
      }
    }
    let response;
    try {
      response = await withProviderTimeout(
        this.fetchImpl(`https://api.openai.com/v1${pathname}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${credentials.apiKey}` },
          body: form,
          redirect: "error"
        }),
        this.name,
        this.timeoutMs
      );
    } catch (error) {
      throw normalizeProviderError(error, this.name);
    }
    if (!response?.ok) {
      throw new AppError(
        response?.status === 401 ? "PROVIDER_AUTH_FAILED" : "PROVIDER_REQUEST_FAILED",
        response?.status === 401
          ? "OpenAI rejected the configured API key."
          : "OpenAI could not create the custom voice. Check account eligibility and the recordings."
      );
    }
    const result = await response.json().catch(() => null);
    if (!result?.id || typeof result.id !== "string") {
      throw new AppError("PROVIDER_INVALID_RESPONSE", "OpenAI returned invalid custom voice metadata.");
    }
    return result;
  }

  async createCustomVoice({ credentials, name, language, consentRecording, sampleRecording }) {
    const consent = await this.postVoiceForm(credentials, "/audio/voice_consents", {
      name: `${name} consent`,
      language,
      recording: consentRecording
    });
    try {
      const voice = await this.postVoiceForm(credentials, "/audio/voices", {
        name,
        audio_sample: sampleRecording,
        consent: consent.id
      });
      return { id: voice.id, consentId: consent.id, name: voice.name || name };
    } catch (error) {
      await this.deleteVoiceConsent({ credentials, consentId: consent.id }).catch(() => {});
      throw error;
    }
  }

  async deleteVoiceConsent({ credentials, consentId }) {
    this.createClient(credentials);
    const response = await this.fetchImpl(`https://api.openai.com/v1/audio/voice_consents/${encodeURIComponent(consentId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${credentials.apiKey}` },
      redirect: "error"
    });
    if (!response?.ok && response?.status !== 404) {
      throw new AppError("PROVIDER_REQUEST_FAILED", "OpenAI could not remove the unused voice consent.");
    }
    return true;
  }

  async createEmbeddings({ credentials, modelId, input }) {
    this.requireModel(modelId);
    const response = await this.request(credentials, (client) =>
      client.embeddings.create({ model: modelId, input: Array.isArray(input) ? input.slice(0, 100) : input })
    );
    return (Array.isArray(response?.data) ? response.data : []).map((item) => item.embedding);
  }
}

module.exports = { OPENAI_MODELS, OpenAIProviderAdapter };
