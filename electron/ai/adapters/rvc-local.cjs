const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AppError } = require("../../errors.cjs");
const { AI_CAPABILITIES } = require("../capabilities.cjs");
const { isWav, readBoundedWav, runLocalSpeechCommand } = require("../local-speech-runtime.cjs");

const RVC_LOCAL_MODEL = Object.freeze({
  id: "rvc-local-model",
  name: "Configured RVC voice model",
  capabilities: [AI_CAPABILITIES.VOICE_CONVERSION]
});

function createProbeWav() {
  const sampleRate = 16_000;
  const sampleCount = 8_000;
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 2_000);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
  return buffer;
}

class RvcLocalProviderAdapter {
  constructor(options = {}) {
    this.id = "rvc-local";
    this.name = "Local RVC";
    this.runCommand = options.runCommand || runLocalSpeechCommand;
    this.startAccessingBookmark = options.startAccessingBookmark;
    this.platform = options.platform || process.platform;
    this.credentialFields = [
      {
        key: "executablePath",
        label: "RVC executable",
        type: "native-file",
        accept: "executable",
        sensitive: true,
        required: true
      },
      {
        key: "modelPath",
        label: "RVC .pth voice model",
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
    return [structuredClone(RVC_LOCAL_MODEL)];
  }

  requireModel(modelId) {
    if (modelId !== RVC_LOCAL_MODEL.id) throw new AppError("AI_MODEL_NOT_FOUND", "The configured RVC model is unavailable.");
  }

  requireFiles(credentials) {
    const executable = fs.statSync(credentials?.executablePath, { throwIfNoEntry: false });
    const model = fs.statSync(credentials?.modelPath, { throwIfNoEntry: false });
    if (!executable?.isFile() || !model?.isFile() || path.extname(credentials.modelPath).toLowerCase() !== ".pth") {
      throw new AppError("RVC_LOCAL_UNAVAILABLE", "Choose an RVC executable and an existing .pth voice model.");
    }
    if (this.platform !== "win32") {
      try {
        fs.accessSync(credentials.executablePath, fs.constants.X_OK);
      } catch {
        throw new AppError("RVC_LOCAL_UNAVAILABLE", "The selected RVC file is not executable.");
      }
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

  async convert({ credentials, inputAudio }) {
    if (!isWav(inputAudio) || inputAudio.length > 32 * 1024 * 1024) {
      throw new AppError("INVALID_VOICE_AUDIO", "Choose a bounded WAV voice preview for local conversion.");
    }
    const stopAccess = this.startAccess(credentials);
    let tempPath = null;
    try {
      this.requireFiles(credentials);
      tempPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "produdash-rvc-"));
      const inputPath = path.join(tempPath, "source.wav");
      const outputPath = path.join(tempPath, "converted.wav");
      await fs.promises.writeFile(inputPath, inputAudio, { flag: "wx", mode: 0o600 });
      await this.runCommand({
        command: credentials.executablePath,
        args: ["infer", "-m", credentials.modelPath, "-i", inputPath, "-o", outputPath],
        input: "",
        outputPath,
        timeoutMs: 10 * 60_000,
        runtimeName: "RVC"
      });
      return await readBoundedWav(outputPath, "RVC");
    } finally {
      stopAccess();
      if (tempPath) await fs.promises.rm(tempPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  async validate(credentials, modelId) {
    this.requireModel(modelId);
    await this.convert({ credentials, inputAudio: createProbeWav() });
    return true;
  }

  async convertVoice({ credentials, modelId, inputAudio }) {
    this.requireModel(modelId);
    return this.convert({ credentials, inputAudio });
  }
}

module.exports = { RVC_LOCAL_MODEL, RvcLocalProviderAdapter, createProbeWav };
