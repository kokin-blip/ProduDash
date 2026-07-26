const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AppError } = require("../../errors.cjs");
const { AI_CAPABILITIES } = require("../capabilities.cjs");
const { readBoundedWav, runLocalSpeechCommand } = require("../local-speech-runtime.cjs");

const KOKORO_LOCAL_MODEL = Object.freeze({
  id: "kokoro-local-model",
  name: "Configured Kokoro voice",
  capabilities: [AI_CAPABILITIES.SPEECH_GENERATION]
});

function normalizeVoiceId(value) {
  const voiceId = String(value || "").trim();
  if (!/^[a-z]{2}_[a-z0-9_-]{1,60}$/.test(voiceId)) {
    throw new AppError("INVALID_KOKORO_VOICE", "Enter one installed Kokoro voice ID, such as af_heart.");
  }
  return voiceId;
}

class KokoroLocalProviderAdapter {
  constructor(options = {}) {
    this.id = "kokoro-local";
    this.name = "Local Kokoro CLI";
    this.runCommand = options.runCommand || runLocalSpeechCommand;
    this.startAccessingBookmark = options.startAccessingBookmark;
    this.platform = options.platform || process.platform;
    this.credentialFields = [
      {
        key: "executablePath",
        label: "kokoro-tts executable",
        type: "native-file",
        accept: "executable",
        sensitive: true,
        required: true
      },
      {
        key: "voiceId",
        label: "Installed Kokoro voice ID",
        type: "text",
        placeholder: "af_heart",
        sensitive: false,
        required: true
      }
    ];
    this.allCredentialFields = [
      ...this.credentialFields,
      { key: "executablePathBookmark", label: "Executable bookmark", sensitive: true, required: false }
    ];
  }

  listModels() {
    return [structuredClone(KOKORO_LOCAL_MODEL)];
  }

  requireModel(modelId) {
    if (modelId !== KOKORO_LOCAL_MODEL.id) throw new AppError("AI_MODEL_NOT_FOUND", "The configured Kokoro model is unavailable.");
  }

  requireRuntime(credentials) {
    const executable = fs.statSync(credentials?.executablePath, { throwIfNoEntry: false });
    if (!executable?.isFile()) {
      throw new AppError("KOKORO_LOCAL_UNAVAILABLE", "Choose an existing kokoro-tts CLI executable.");
    }
    if (this.platform !== "win32") {
      try {
        fs.accessSync(credentials.executablePath, fs.constants.X_OK);
      } catch {
        throw new AppError("KOKORO_LOCAL_UNAVAILABLE", "The selected kokoro-tts file is not executable.");
      }
    }
    return { voiceId: normalizeVoiceId(credentials.voiceId) };
  }

  startAccess(credentials) {
    if (!this.startAccessingBookmark || !credentials?.executablePathBookmark) return () => {};
    const stop = this.startAccessingBookmark(credentials.executablePathBookmark);
    return typeof stop === "function" ? stop : () => {};
  }

  async synthesize({ credentials, input }) {
    const stopAccess = this.startAccess(credentials);
    let tempPath = null;
    try {
      tempPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "produdash-kokoro-"));
      const outputPath = path.join(tempPath, "speech.wav");
      const { voiceId } = this.requireRuntime(credentials);
      await this.runCommand({
        command: credentials.executablePath,
        args: ["--no-play", "--batch", "--save", outputPath, "--voice", voiceId],
        input,
        outputPath,
        timeoutMs: 120_000,
        runtimeName: "Kokoro CLI"
      });
      return await readBoundedWav(outputPath, "Kokoro CLI");
    } finally {
      stopAccess();
      if (tempPath) await fs.promises.rm(tempPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  async validate(credentials, modelId) {
    this.requireModel(modelId);
    await this.synthesize({ credentials, input: "ProduDash local voice check." });
    return true;
  }

  async generateSpeech({ credentials, modelId, input, voice, instructions = "" }) {
    this.requireModel(modelId);
    const voiceId = normalizeVoiceId(credentials?.voiceId);
    if (voice !== voiceId) throw new AppError("CUSTOM_VOICE_UNAVAILABLE", "The configured Kokoro voice is unavailable.");
    if (String(instructions || "").trim()) {
      throw new AppError("CAPABILITY_UNSUPPORTED", "The configured Kokoro CLI does not support voice-direction instructions.");
    }
    return this.synthesize({ credentials, input });
  }
}

module.exports = { KOKORO_LOCAL_MODEL, KokoroLocalProviderAdapter, normalizeVoiceId };
