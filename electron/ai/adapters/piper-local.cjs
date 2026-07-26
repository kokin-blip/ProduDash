const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AppError } = require("../../errors.cjs");
const { workerEnvironment } = require("../../media/utility-runner.cjs");
const { AI_CAPABILITIES } = require("../capabilities.cjs");

const PIPER_LOCAL_MODEL = Object.freeze({
  id: "piper-local-model",
  name: "Configured Piper voice model",
  capabilities: [AI_CAPABILITIES.SPEECH_GENERATION]
});
const PIPER_VOICE_ID = "configured-model";
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

function isWav(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 44 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

function runPiperCommand({ command, args, input, timeoutMs = 120_000 }, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
      env: workerEnvironment()
    });
    let settled = false;
    let stderrBytes = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new AppError("LOCAL_SPEECH_TIMEOUT", "Piper did not finish the local speech request in time."));
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 128_000) {
        child.kill();
        finish(new AppError("LOCAL_SPEECH_FAILED", "Piper returned too much diagnostic output."));
      }
    });
    child.on("error", () => finish(new AppError("LOCAL_SPEECH_UNAVAILABLE", "The configured Piper executable could not be started.")));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new AppError("LOCAL_SPEECH_FAILED", "Piper could not generate speech with the configured model."));
        return;
      }
      finish();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

class PiperLocalProviderAdapter {
  constructor(options = {}) {
    this.id = "piper-local";
    this.name = "Local Piper";
    this.runCommand = options.runCommand || runPiperCommand;
    this.startAccessingBookmark = options.startAccessingBookmark;
    this.platform = options.platform || process.platform;
    this.credentialFields = [
      {
        key: "executablePath",
        label: "Piper executable",
        type: "native-file",
        accept: "executable",
        sensitive: true,
        required: true
      },
      {
        key: "modelPath",
        label: "Piper ONNX voice model",
        type: "native-file",
        accept: "model",
        sensitive: true,
        required: true
      },
      {
        key: "speakerId",
        label: "Optional speaker ID",
        type: "text",
        placeholder: "0",
        sensitive: false,
        required: false
      }
    ];
    this.allCredentialFields = [
      ...this.credentialFields,
      { key: "executablePathBookmark", label: "Executable bookmark", sensitive: true, required: false },
      { key: "modelPathBookmark", label: "Model bookmark", sensitive: true, required: false }
    ];
  }

  listModels() {
    return [structuredClone(PIPER_LOCAL_MODEL)];
  }

  requireModel(modelId) {
    if (modelId !== PIPER_LOCAL_MODEL.id) throw new AppError("AI_MODEL_NOT_FOUND", "The configured Piper model is unavailable.");
  }

  requireFiles(credentials) {
    const executable = fs.statSync(credentials?.executablePath, { throwIfNoEntry: false });
    const model = fs.statSync(credentials?.modelPath, { throwIfNoEntry: false });
    const modelConfig = fs.statSync(`${credentials?.modelPath}.json`, { throwIfNoEntry: false });
    if (!executable?.isFile() || !model?.isFile() || !modelConfig?.isFile()) {
      throw new AppError(
        "PIPER_LOCAL_UNAVAILABLE",
        "Choose a Piper executable and an ONNX voice model with its matching .onnx.json configuration file."
      );
    }
    if (this.platform !== "win32") {
      try {
        fs.accessSync(credentials.executablePath, fs.constants.X_OK);
      } catch {
        throw new AppError("PIPER_LOCAL_UNAVAILABLE", "The selected Piper file is not executable.");
      }
    }
    const speakerId = credentials?.speakerId === undefined || credentials.speakerId === "" ? null : Number(credentials.speakerId);
    if (speakerId !== null && (!Number.isInteger(speakerId) || speakerId < 0 || speakerId > 10_000)) {
      throw new AppError("INVALID_PIPER_SPEAKER", "The optional Piper speaker ID must be an integer from 0 to 10000.");
    }
    return { speakerId };
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

  async synthesize({ credentials, input }) {
    const stopAccess = this.startAccess(credentials);
    let tempPath = null;
    try {
      tempPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "produdash-piper-"));
      const outputPath = path.join(tempPath, "speech.wav");
      const { speakerId } = this.requireFiles(credentials);
      const args = ["--model", credentials.modelPath, "--output_file", outputPath];
      if (speakerId !== null) args.push("--speaker", String(speakerId));
      await this.runCommand({
        command: credentials.executablePath,
        args,
        input,
        outputPath,
        timeoutMs: 120_000
      });
      const stat = await fs.promises.stat(outputPath).catch(() => null);
      if (!stat?.isFile() || stat.size < 44 || stat.size > MAX_AUDIO_BYTES) {
        throw new AppError("LOCAL_SPEECH_INVALID", "Piper did not create a bounded WAV audio file.");
      }
      const audio = await fs.promises.readFile(outputPath);
      if (!isWav(audio)) throw new AppError("LOCAL_SPEECH_INVALID", "Piper returned an invalid WAV audio file.");
      return audio;
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
    if (voice !== PIPER_VOICE_ID) throw new AppError("CUSTOM_VOICE_UNAVAILABLE", "The configured Piper voice is unavailable.");
    if (String(instructions || "").trim()) {
      throw new AppError("CAPABILITY_UNSUPPORTED", "Piper does not support ProduDash voice-direction instructions.");
    }
    return this.synthesize({ credentials, input });
  }
}

module.exports = {
  MAX_AUDIO_BYTES,
  PIPER_LOCAL_MODEL,
  PIPER_VOICE_ID,
  PiperLocalProviderAdapter,
  isWav,
  runPiperCommand
};
