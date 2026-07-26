const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AppError } = require("../../errors.cjs");
const { AI_CAPABILITIES } = require("../capabilities.cjs");
const { isWav, readBoundedWav, runLocalSpeechCommand } = require("../local-speech-runtime.cjs");

const XTTS_LOCAL_MODEL = Object.freeze({
  id: "xtts-local-model",
  name: "Configured local XTTS model",
  capabilities: [AI_CAPABILITIES.SPEECH_GENERATION]
});
const XTTS_VOICE_ID = "xtts-configured-likeness";
const XTTS_LANGUAGES = new Set(["ar", "cs", "de", "en", "es", "fr", "hu", "it", "ja", "ko", "nl", "pl", "pt", "ru", "tr", "zh-cn"]);

function normalizeLanguage(value) {
  const language = String(value || "")
    .trim()
    .toLowerCase();
  if (!XTTS_LANGUAGES.has(language)) {
    throw new AppError("INVALID_XTTS_LANGUAGE", "Choose one language supported by the configured XTTS model.");
  }
  return language;
}

class XttsLocalProviderAdapter {
  constructor(options = {}) {
    this.id = "xtts-local";
    this.name = "Local XTTS";
    this.configuredVoiceId = XTTS_VOICE_ID;
    this.runCommand = options.runCommand || runLocalSpeechCommand;
    this.startAccessingBookmark = options.startAccessingBookmark;
    this.platform = options.platform || process.platform;
    this.wrapperPath = options.wrapperPath || path.join(__dirname, "..", "python", "xtts_local.py");
    this.credentialFields = [
      {
        key: "pythonPath",
        label: "XTTS Python executable",
        type: "native-file",
        accept: "executable",
        sensitive: true,
        required: true
      },
      {
        key: "modelPath",
        label: "Local XTTS model folder",
        type: "native-folder",
        accept: "model",
        sensitive: true,
        required: true
      },
      {
        key: "configPath",
        label: "XTTS config.json",
        type: "native-file",
        accept: "model",
        sensitive: true,
        required: true
      },
      {
        key: "referencePath",
        label: "Authorized reference WAV",
        type: "native-file",
        accept: "audio",
        sensitive: true,
        required: true
      },
      {
        key: "language",
        label: "XTTS language code",
        type: "text",
        placeholder: "en",
        sensitive: false,
        required: true
      }
    ];
    this.allCredentialFields = [
      ...this.credentialFields,
      { key: "pythonPathBookmark", label: "Python bookmark", sensitive: true, required: false },
      { key: "modelPathBookmark", label: "Model folder bookmark", sensitive: true, required: false },
      { key: "configPathBookmark", label: "Config bookmark", sensitive: true, required: false },
      { key: "referencePathBookmark", label: "Reference bookmark", sensitive: true, required: false }
    ];
  }

  listModels() {
    return [structuredClone(XTTS_LOCAL_MODEL)];
  }

  requireModel(modelId) {
    if (modelId !== XTTS_LOCAL_MODEL.id) throw new AppError("AI_MODEL_NOT_FOUND", "The configured XTTS model is unavailable.");
  }

  requireFiles(credentials) {
    const python = fs.statSync(credentials?.pythonPath, { throwIfNoEntry: false });
    const model = fs.statSync(credentials?.modelPath, { throwIfNoEntry: false });
    const config = fs.statSync(credentials?.configPath, { throwIfNoEntry: false });
    const reference = fs.statSync(credentials?.referencePath, { throwIfNoEntry: false });
    if (
      !python?.isFile() ||
      !model?.isDirectory() ||
      !config?.isFile() ||
      path.extname(credentials.configPath).toLowerCase() !== ".json" ||
      !reference?.isFile() ||
      path.extname(credentials.referencePath).toLowerCase() !== ".wav" ||
      reference.size < 44 ||
      reference.size > 25 * 1024 * 1024
    ) {
      throw new AppError(
        "XTTS_LOCAL_UNAVAILABLE",
        "Choose the XTTS Python executable, complete local model folder, config.json, and an authorized WAV reference."
      );
    }
    if (this.platform !== "win32") {
      try {
        fs.accessSync(credentials.pythonPath, fs.constants.X_OK);
      } catch {
        throw new AppError("XTTS_LOCAL_UNAVAILABLE", "The selected XTTS Python file is not executable.");
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
      throw new AppError("XTTS_LOCAL_UNAVAILABLE", "The selected XTTS reference is not a valid WAV file.");
    }
    return { language: normalizeLanguage(credentials.language) };
  }

  startAccess(credentials) {
    if (!this.startAccessingBookmark) return () => {};
    const stops = ["pythonPathBookmark", "modelPathBookmark", "configPathBookmark", "referencePathBookmark"]
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
      const { language } = this.requireFiles(credentials);
      tempPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "produdash-xtts-"));
      const outputPath = path.join(tempPath, "speech.wav");
      const args = [
        this.wrapperPath,
        "--model-path",
        credentials.modelPath,
        "--config-path",
        credentials.configPath,
        "--output",
        outputPath
      ];
      if (validate) args.push("--validate");
      else args.push("--reference-path", credentials.referencePath, "--language", language);
      await this.runCommand({
        command: credentials.pythonPath,
        args,
        input,
        outputPath,
        timeoutMs: 10 * 60_000,
        runtimeName: "XTTS",
        extraEnvironment: {
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1"
        }
      });
      return await readBoundedWav(outputPath, "XTTS");
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
    if (voice !== XTTS_VOICE_ID) throw new AppError("CUSTOM_VOICE_UNAVAILABLE", "The configured XTTS likeness is unavailable.");
    if (String(instructions || "").trim()) {
      throw new AppError("CAPABILITY_UNSUPPORTED", "The configured XTTS adapter does not support voice-direction instructions.");
    }
    return this.run({ credentials, input, validate: false });
  }
}

module.exports = { XTTS_LANGUAGES, XTTS_LOCAL_MODEL, XTTS_VOICE_ID, XttsLocalProviderAdapter, normalizeLanguage };
