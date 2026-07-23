const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AppError } = require("../errors.cjs");
const { AI_CAPABILITIES, AI_WORKLOADS } = require("../ai/capabilities.cjs");
const { invokeCapability } = require("../ai/provider-contract.cjs");
const { normalizeOpenAiTranscript, normalizeTranscript } = require("./transcript-contract.cjs");

function runWhisperCpp({ executablePath, modelPath, audioPath, outputPrefix }, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executablePath, ["-m", modelPath, "-f", audioPath, "-oj", "-of", outputPrefix], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 20_000) stderr += chunk.toString("utf8");
    });
    child.on("error", () => reject(new AppError("WHISPER_LOCAL_UNAVAILABLE", "The configured whisper.cpp executable could not start.")));
    child.on("close", (code) => {
      if (code === 0) resolve(`${outputPrefix}.json`);
      else reject(new AppError("WHISPER_LOCAL_FAILED", "whisper.cpp could not transcribe this audio file."));
    });
  });
}

function whisperTimestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const match = /^(\d+):(\d+):(\d+)[,.](\d+)$/.exec(String(value || ""));
  if (!match) return value;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`);
}

class TranscriptionService {
  constructor({ providerService, spawnProcess = spawn }) {
    this.providerService = providerService;
    this.spawnProcess = spawnProcess;
  }

  async transcribeCloud({ audioPath, duration, consent, language }) {
    const provider = this.providerService.resolveWorkload(AI_WORKLOADS.TRANSCRIPTION);
    if (
      provider.profile.providerType !== "whisper-cpp" &&
      (consent?.confirmed !== true ||
        consent?.providerId !== provider.profile.id ||
        consent?.modelId !== provider.model.id ||
        !Array.isArray(consent.dataCategories) ||
        !consent.dataCategories.includes("audio"))
    ) {
      throw new AppError(
        "CLOUD_MEDIA_CONSENT_REQUIRED",
        "Confirm this provider, model, and audio upload separately for the current media job."
      );
    }
    const result = await invokeCapability(provider.adapter, provider.model, AI_CAPABILITIES.AUDIO_TRANSCRIPTION, {
      credentials: provider.credentials,
      audioPath,
      language,
      duration,
      tempPath: path.dirname(audioPath)
    });
    if (provider.profile.providerType === "whisper-cpp") {
      const segments = (Array.isArray(result?.transcription) ? result.transcription : result?.segments || []).map((segment) => ({
        text: segment.text,
        start: whisperTimestamp(segment.start ?? segment.timestamps?.from),
        end: whisperTimestamp(segment.end ?? segment.timestamps?.to),
        words: segment.words
      }));
      return normalizeTranscript({ text: result?.text, language: result?.language, segments }, duration);
    }
    return normalizeOpenAiTranscript(result, duration);
  }

  async transcribeLocal({ audioPath, duration, executablePath, modelPath, outputDirectory }) {
    for (const [filePath, label] of [
      [executablePath, "whisper.cpp executable"],
      [modelPath, "Whisper model"],
      [audioPath, "Audio file"]
    ]) {
      if (typeof filePath !== "string" || !fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        throw new AppError("WHISPER_LOCAL_UNAVAILABLE", `The configured ${label} is unavailable.`);
      }
    }
    const outputPrefix = path.join(outputDirectory, "transcript");
    const resultPath = await runWhisperCpp({ executablePath, modelPath, audioPath, outputPrefix }, this.spawnProcess);
    let result;
    try {
      result = JSON.parse(await fs.promises.readFile(resultPath, "utf8"));
    } catch {
      throw new AppError("TRANSCRIPT_INVALID", "whisper.cpp returned malformed transcript data.");
    }
    const segments = (Array.isArray(result?.transcription) ? result.transcription : result?.segments || []).map((segment) => ({
      text: segment.text,
      start: whisperTimestamp(segment.start ?? segment.timestamps?.from),
      end: whisperTimestamp(segment.end ?? segment.timestamps?.to),
      words: segment.words
    }));
    return normalizeTranscript({ text: result?.text, language: result?.language, segments }, duration);
  }
}

module.exports = { TranscriptionService, runWhisperCpp, whisperTimestamp };
