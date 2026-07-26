const crypto = require("node:crypto");
const fs = require("node:fs");
const { AppError } = require("../../errors.cjs");
const { AI_CAPABILITIES } = require("../capabilities.cjs");
const { normalizeProviderError, withProviderTimeout } = require("../provider-utils.cjs");

const ELEVENLABS_MODELS = [
  {
    id: "eleven_multilingual_v2",
    name: "Eleven Multilingual v2",
    capabilities: [AI_CAPABILITIES.SPEECH_GENERATION]
  }
];

function pcmToWav(pcm, sampleRate = 24_000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

class ElevenLabsProviderAdapter {
  constructor(options = {}) {
    this.id = "elevenlabs";
    this.name = "ElevenLabs";
    this.timeoutMs = options.timeoutMs || 20_000;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.credentialFields = [
      {
        key: "apiKey",
        label: "ElevenLabs API key",
        type: "password",
        placeholder: "ElevenLabs API key",
        sensitive: true,
        required: true
      }
    ];
  }

  listModels() {
    return structuredClone(ELEVENLABS_MODELS);
  }

  requireCredentials(credentials) {
    if (typeof credentials?.apiKey !== "string" || credentials.apiKey.trim().length < 8) {
      throw new AppError("PROVIDER_AUTH_FAILED", "ElevenLabs requires a valid API key.");
    }
  }

  async request(credentials, pathname, options = {}) {
    this.requireCredentials(credentials);
    try {
      const response = await withProviderTimeout(
        this.fetchImpl(`https://api.elevenlabs.io${pathname}`, {
          ...options,
          headers: { "xi-api-key": credentials.apiKey, ...(options.headers || {}) },
          redirect: "error"
        }),
        this.name,
        this.timeoutMs
      );
      if (!response?.ok) {
        throw new AppError(
          response?.status === 401 ? "PROVIDER_AUTH_FAILED" : "PROVIDER_REQUEST_FAILED",
          response?.status === 401 ? "ElevenLabs rejected the configured API key." : "ElevenLabs could not complete the voice request."
        );
      }
      return response;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw normalizeProviderError(error, this.name);
    }
  }

  async validate(credentials, modelId) {
    if (!ELEVENLABS_MODELS.some((model) => model.id === modelId)) {
      throw new AppError("AI_MODEL_NOT_FOUND", "The selected ElevenLabs model is unavailable.");
    }
    await this.request(credentials, "/v1/user");
    return true;
  }

  async createCustomVoice({ credentials, name, consentRecording, sampleRecording }) {
    const form = new globalThis.FormData();
    const sample = await fs.promises.readFile(sampleRecording.path);
    form.append("name", name);
    form.append("files", new globalThis.Blob([sample], { type: sampleRecording.type }), sampleRecording.name);
    form.append("remove_background_noise", "false");
    form.append("description", "Authorized synthetic voice likeness created through ProduDash.");
    const response = await this.request(credentials, "/v1/voices/add", { method: "POST", body: form });
    const result = await response.json().catch(() => null);
    if (typeof result?.voice_id !== "string" || !result.voice_id) {
      throw new AppError("PROVIDER_INVALID_RESPONSE", "ElevenLabs returned invalid custom voice metadata.");
    }
    const consentBytes = await fs.promises.readFile(consentRecording.path);
    return {
      id: result.voice_id,
      name,
      consentId: null,
      consentEvidenceHash: crypto.createHash("sha256").update(consentBytes).digest("hex")
    };
  }

  async deleteCustomVoice({ credentials, voiceId }) {
    await this.request(credentials, `/v1/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE" });
    return true;
  }

  async generateSpeech({ credentials, modelId, input, voice }) {
    if (!ELEVENLABS_MODELS.some((model) => model.id === modelId)) {
      throw new AppError("AI_MODEL_NOT_FOUND", "The selected ElevenLabs model is unavailable.");
    }
    const response = await this.request(credentials, `/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_24000`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input, model_id: modelId })
    });
    const pcm = Buffer.from(await response.arrayBuffer());
    if (!pcm.length || pcm.length > 50 * 1024 * 1024) {
      throw new AppError("PROVIDER_INVALID_RESPONSE", "ElevenLabs returned invalid speech audio.");
    }
    return pcmToWav(pcm);
  }
}

module.exports = { ELEVENLABS_MODELS, ElevenLabsProviderAdapter, pcmToWav };
