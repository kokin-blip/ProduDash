const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AppError } = require("../../errors.cjs");
const { AI_CAPABILITIES } = require("../capabilities.cjs");
const { isWav, readBoundedWav, runLocalSpeechCommand } = require("../local-speech-runtime.cjs");

const CHATTERBOX_LOCAL_MODEL = Object.freeze({
  id: "chatterbox-local-model",
  name: "Configured local Chatterbox model",
  capabilities: [AI_CAPABILITIES.SPEECH_GENERATION]
});
const CHATTERBOX_VOICE_ID = "chatterbox-configured-likeness";
const CHATTERBOX_VARIANTS = new Set(["english", "multilingual-v3", "nano", "turbo"]);
const CHATTERBOX_DEVICES = new Set(["cpu", "cuda", "mps"]);

function normalizeOptions(credentials) {
  const variant = String(credentials?.variant || "")
    .trim()
    .toLowerCase();
  const device = String(credentials?.device || "")
    .trim()
    .toLowerCase();
  const language = String(credentials?.language || "")
    .trim()
    .toLowerCase();
  if (!CHATTERBOX_VARIANTS.has(variant)) {
    throw new AppError("INVALID_CHATTERBOX_VARIANT", "Choose the installed Chatterbox English, multilingual-v3, nano, or turbo model.");
  }
  if (!CHATTERBOX_DEVICES.has(device)) {
    throw new AppError("INVALID_CHATTERBOX_DEVICE", "Choose cpu, cuda, or mps for the local Chatterbox runtime.");
  }
  if (!/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(language) || (variant !== "multilingual-v3" && language !== "en")) {
    throw new AppError(
      "INVALID_CHATTERBOX_LANGUAGE",
      variant === "multilingual-v3" ? "Enter a supported Chatterbox language code." : "This Chatterbox variant requires language en."
    );
  }
  return { variant, device, language };
}

class ChatterboxLocalProviderAdapter {
  constructor(options = {}) {
    this.id = "chatterbox-local";
    this.name = "Local Chatterbox";
    this.configuredVoiceId = CHATTERBOX_VOICE_ID;
    this.runCommand = options.runCommand || runLocalSpeechCommand;
    this.startAccessingBookmark = options.startAccessingBookmark;
    this.platform = options.platform || process.platform;
    this.wrapperPath = options.wrapperPath || path.join(__dirname, "..", "python", "chatterbox_local.py");
    this.credentialFields = [
      {
        key: "pythonPath",
        label: "Chatterbox Python executable",
        type: "native-file",
        sensitive: true,
        required: true
      },
      {
        key: "modelCachePath",
        label: "Offline Chatterbox model cache",
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
        key: "variant",
        label: "Chatterbox model variant",
        type: "text",
        placeholder: "nano",
        sensitive: false,
        required: true
      },
      {
        key: "language",
        label: "Chatterbox language code",
        type: "text",
        placeholder: "en",
        sensitive: false,
        required: true
      },
      {
        key: "device",
        label: "Chatterbox device",
        type: "text",
        placeholder: "cpu",
        sensitive: false,
        required: true
      }
    ];
    this.allCredentialFields = [
      ...this.credentialFields,
      { key: "pythonPathBookmark", label: "Python bookmark", sensitive: true, required: false },
      { key: "modelCachePathBookmark", label: "Model cache bookmark", sensitive: true, required: false },
      { key: "referencePathBookmark", label: "Reference bookmark", sensitive: true, required: false }
    ];
  }

  listModels() {
    return [structuredClone(CHATTERBOX_LOCAL_MODEL)];
  }

  requireModel(modelId) {
    if (modelId !== CHATTERBOX_LOCAL_MODEL.id) {
      throw new AppError("AI_MODEL_NOT_FOUND", "The configured Chatterbox model is unavailable.");
    }
  }

  requireFiles(credentials) {
    const python = fs.statSync(credentials?.pythonPath, { throwIfNoEntry: false });
    const cache = fs.statSync(credentials?.modelCachePath, { throwIfNoEntry: false });
    const reference = fs.statSync(credentials?.referencePath, { throwIfNoEntry: false });
    if (
      !python?.isFile() ||
      !cache?.isDirectory() ||
      !reference?.isFile() ||
      path.extname(credentials.referencePath).toLowerCase() !== ".wav" ||
      reference.size < 44 ||
      reference.size > 25 * 1024 * 1024
    ) {
      throw new AppError(
        "CHATTERBOX_LOCAL_UNAVAILABLE",
        "Choose the Chatterbox Python executable, populated offline model cache, and an authorized WAV reference."
      );
    }
    if (this.platform !== "win32") {
      try {
        fs.accessSync(credentials.pythonPath, fs.constants.X_OK);
      } catch {
        throw new AppError("CHATTERBOX_LOCAL_UNAVAILABLE", "The selected Chatterbox Python file is not executable.");
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
      throw new AppError("CHATTERBOX_LOCAL_UNAVAILABLE", "The selected Chatterbox reference is not a valid WAV file.");
    }
    return normalizeOptions(credentials);
  }

  startAccess(credentials) {
    if (!this.startAccessingBookmark) return () => {};
    const stops = ["pythonPathBookmark", "modelCachePathBookmark", "referencePathBookmark"]
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
      const { variant, device, language } = this.requireFiles(credentials);
      tempPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "produdash-chatterbox-"));
      const outputPath = path.join(tempPath, "speech.wav");
      const args = [
        this.wrapperPath,
        "--reference-path",
        credentials.referencePath,
        "--variant",
        variant,
        "--language",
        language,
        "--device",
        device,
        "--output",
        outputPath
      ];
      if (validate) args.push("--validate");
      await this.runCommand({
        command: credentials.pythonPath,
        args,
        input,
        outputPath,
        timeoutMs: 15 * 60_000,
        runtimeName: "Chatterbox",
        extraEnvironment: {
          HF_HOME: credentials.modelCachePath,
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1"
        }
      });
      return await readBoundedWav(outputPath, "Chatterbox");
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
    if (voice !== CHATTERBOX_VOICE_ID) {
      throw new AppError("CUSTOM_VOICE_UNAVAILABLE", "The configured Chatterbox likeness is unavailable.");
    }
    if (String(instructions || "").trim()) {
      throw new AppError("CAPABILITY_UNSUPPORTED", "The configured Chatterbox adapter does not accept free-form voice direction.");
    }
    return this.run({ credentials, input, validate: false });
  }
}

module.exports = {
  CHATTERBOX_DEVICES,
  CHATTERBOX_LOCAL_MODEL,
  CHATTERBOX_VARIANTS,
  CHATTERBOX_VOICE_ID,
  ChatterboxLocalProviderAdapter,
  normalizeOptions
};
