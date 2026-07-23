const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("../../errors.cjs");
const { AI_CAPABILITIES } = require("../capabilities.cjs");
const { runWhisperCpp } = require("../../media/transcription-service.cjs");

const WHISPER_CPP_MODEL = {
  id: "local-whisper",
  name: "Local whisper.cpp",
  capabilities: [AI_CAPABILITIES.AUDIO_TRANSCRIPTION]
};

class WhisperCppProviderAdapter {
  constructor(options = {}) {
    this.id = "whisper-cpp";
    this.name = "Local whisper.cpp";
    this.spawnProcess = options.spawnProcess;
    this.startAccessingBookmark = options.startAccessingBookmark;
    this.credentialFields = [
      {
        key: "executablePath",
        label: "whisper.cpp executable",
        type: "native-file",
        accept: "executable",
        sensitive: true,
        required: true
      },
      {
        key: "modelPath",
        label: "Whisper model file",
        type: "native-file",
        accept: "model",
        sensitive: true,
        required: true
      }
    ];
    this.allCredentialFields = [
      ...this.credentialFields,
      { key: "executablePathBookmark", label: "Executable bookmark", sensitive: true, required: false },
      { key: "modelPathBookmark", label: "Model bookmark", sensitive: true, required: false }
    ];
  }

  listModels() {
    return [structuredClone(WHISPER_CPP_MODEL)];
  }

  requireFiles(credentials) {
    const executable = fs.statSync(credentials?.executablePath, { throwIfNoEntry: false });
    const model = fs.statSync(credentials?.modelPath, { throwIfNoEntry: false });
    if (!executable?.isFile() || !model?.isFile()) {
      throw new AppError(
        "WHISPER_LOCAL_UNAVAILABLE",
        "Choose an existing whisper.cpp executable and model file. ProduDash never downloads them automatically."
      );
    }
  }

  startAccess(credentials) {
    if (!this.startAccessingBookmark) return () => {};
    const stops = [credentials?.executablePathBookmark, credentials?.modelPathBookmark]
      .filter(Boolean)
      .map((bookmark) => this.startAccessingBookmark(bookmark))
      .filter((stop) => typeof stop === "function");
    return () => {
      for (const stop of stops.reverse()) stop();
    };
  }

  async validate(credentials, modelId) {
    if (modelId !== WHISPER_CPP_MODEL.id) throw new AppError("AI_MODEL_NOT_FOUND", "The local Whisper model is unavailable.");
    const stopAccess = this.startAccess(credentials);
    try {
      this.requireFiles(credentials);
      return true;
    } finally {
      stopAccess();
    }
  }

  async transcribeAudio({ credentials, modelId, audioPath, duration, tempPath }) {
    if (modelId !== WHISPER_CPP_MODEL.id) throw new AppError("AI_MODEL_NOT_FOUND", "The local Whisper model is unavailable.");
    const stopAccess = this.startAccess(credentials);
    try {
      this.requireFiles(credentials);
      const outputPrefix = path.join(tempPath, "transcript");
      const resultPath = await runWhisperCpp(
        {
          executablePath: credentials.executablePath,
          modelPath: credentials.modelPath,
          audioPath,
          outputPrefix
        },
        this.spawnProcess
      );
      try {
        return { ...JSON.parse(await fs.promises.readFile(resultPath, "utf8")), sourceDuration: duration };
      } catch {
        throw new AppError("TRANSCRIPT_INVALID", "whisper.cpp returned malformed transcript data.");
      }
    } finally {
      stopAccess();
    }
  }
}

module.exports = { WHISPER_CPP_MODEL, WhisperCppProviderAdapter };
