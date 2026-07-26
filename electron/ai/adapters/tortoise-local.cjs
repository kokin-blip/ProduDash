const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AppError } = require("../../errors.cjs");
const { AI_CAPABILITIES } = require("../capabilities.cjs");
const { isWav, readBoundedWav, runLocalSpeechCommand } = require("../local-speech-runtime.cjs");

const TORTOISE_LOCAL_MODEL = Object.freeze({
  id: "tortoise-local-model",
  name: "Configured local Tortoise TTS model",
  capabilities: [AI_CAPABILITIES.SPEECH_GENERATION]
});
const TORTOISE_VOICE_ID = "tortoise-configured-likeness";
const TORTOISE_PRESETS = new Set(["fast", "high_quality", "standard", "ultra_fast"]);

function normalizePreset(value) {
  const preset = String(value || "")
    .trim()
    .toLowerCase();
  if (!TORTOISE_PRESETS.has(preset)) {
    throw new AppError("INVALID_TORTOISE_PRESET", "Choose the ultra_fast, fast, standard, or high_quality Tortoise preset.");
  }
  return preset;
}

class TortoiseLocalProviderAdapter {
  constructor(options = {}) {
    this.id = "tortoise-local";
    this.name = "Local Tortoise TTS";
    this.configuredVoiceId = TORTOISE_VOICE_ID;
    this.runCommand = options.runCommand || runLocalSpeechCommand;
    this.startAccessingBookmark = options.startAccessingBookmark;
    this.platform = options.platform || process.platform;
    this.wrapperPath = options.wrapperPath || path.join(__dirname, "..", "python", "tortoise_local.py");
    this.credentialFields = [
      {
        key: "pythonPath",
        label: "Tortoise Python executable",
        type: "native-file",
        sensitive: true,
        required: true
      },
      {
        key: "modelsPath",
        label: "Offline Tortoise model folder",
        type: "native-folder",
        sensitive: true,
        required: true
      },
      {
        key: "referencePath",
        label: "Authorized reference WAV",
        type: "native-file",
        sensitive: true,
        required: true
      },
      {
        key: "preset",
        label: "Tortoise quality preset",
        type: "text",
        placeholder: "fast",
        sensitive: false,
        required: true
      }
    ];
    this.allCredentialFields = [
      ...this.credentialFields,
      { key: "pythonPathBookmark", label: "Python bookmark", sensitive: true, required: false },
      { key: "modelsPathBookmark", label: "Model folder bookmark", sensitive: true, required: false },
      { key: "referencePathBookmark", label: "Reference bookmark", sensitive: true, required: false }
    ];
  }

  listModels() {
    return [structuredClone(TORTOISE_LOCAL_MODEL)];
  }

  requireModel(modelId) {
    if (modelId !== TORTOISE_LOCAL_MODEL.id) {
      throw new AppError("AI_MODEL_NOT_FOUND", "The configured Tortoise model is unavailable.");
    }
  }

  requireFiles(credentials) {
    const python = fs.statSync(credentials?.pythonPath, { throwIfNoEntry: false });
    const models = fs.statSync(credentials?.modelsPath, { throwIfNoEntry: false });
    const reference = fs.statSync(credentials?.referencePath, { throwIfNoEntry: false });
    if (
      !python?.isFile() ||
      !models?.isDirectory() ||
      !reference?.isFile() ||
      path.extname(credentials.referencePath).toLowerCase() !== ".wav" ||
      reference.size < 44 ||
      reference.size > 25 * 1024 * 1024
    ) {
      throw new AppError(
        "TORTOISE_LOCAL_UNAVAILABLE",
        "Choose the Tortoise Python executable, complete offline model folder, and an authorized WAV reference."
      );
    }
    if (this.platform !== "win32") {
      try {
        fs.accessSync(credentials.pythonPath, fs.constants.X_OK);
      } catch {
        throw new AppError("TORTOISE_LOCAL_UNAVAILABLE", "The selected Tortoise Python file is not executable.");
      }
    }
    const header = Buffer.alloc(12);
    const descriptor = fs.openSync(credentials.referencePath, "r");
    try {
      fs.readSync(descriptor, header, 0, header.length, 0);
    } finally {
      fs.closeSync(descriptor);
    }
    if (!isWav(Buffer.concat([header, Buffer.alloc(32)]))) {
      throw new AppError("TORTOISE_LOCAL_UNAVAILABLE", "The selected Tortoise reference is not a valid WAV file.");
    }
    return { preset: normalizePreset(credentials.preset) };
  }

  startAccess(credentials) {
    if (!this.startAccessingBookmark) return () => {};
    const stops = ["pythonPathBookmark", "modelsPathBookmark", "referencePathBookmark"]
      .map((key) => credentials?.[key])
      .filter(Boolean)
      .map((bookmark) => this.startAccessingBookmark(bookmark))
      .filter((stop) => typeof stop === "function");
    return () => {
      for (const stop of stops.reverse()) stop();
    };
  }

  async run({ credentials, input, validate }) {
    const stopAccess = this.startAccess(credentials);
    let tempPath = null;
    try {
      const { preset } = this.requireFiles(credentials);
      tempPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "produdash-tortoise-"));
      const outputPath = path.join(tempPath, "speech.wav");
      const args = [this.wrapperPath, "--reference-path", credentials.referencePath, "--preset", preset, "--output", outputPath];
      if (validate) args.push("--validate");
      await this.runCommand({
        command: credentials.pythonPath,
        args,
        input,
        outputPath,
        timeoutMs: 30 * 60_000,
        runtimeName: "Tortoise TTS",
        extraEnvironment: {
          TORTOISE_MODELS_DIR: credentials.modelsPath,
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1"
        }
      });
      return await readBoundedWav(outputPath, "Tortoise TTS");
    } finally {
      stopAccess();
      if (tempPath) await fs.promises.rm(tempPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  async validate(credentials, modelId) {
    this.requireModel(modelId);
    await this.run({ credentials, input: "", validate: true });
    return true;
  }

  async generateSpeech({ credentials, modelId, input, voice, instructions = "" }) {
    this.requireModel(modelId);
    if (voice !== TORTOISE_VOICE_ID) {
      throw new AppError("CUSTOM_VOICE_UNAVAILABLE", "The configured Tortoise likeness is unavailable.");
    }
    if (String(instructions || "").trim()) {
      throw new AppError("CAPABILITY_UNSUPPORTED", "The configured Tortoise adapter does not accept free-form voice direction.");
    }
    return this.run({ credentials, input, validate: false });
  }
}

module.exports = {
  TORTOISE_LOCAL_MODEL,
  TORTOISE_PRESETS,
  TORTOISE_VOICE_ID,
  TortoiseLocalProviderAdapter,
  normalizePreset
};
