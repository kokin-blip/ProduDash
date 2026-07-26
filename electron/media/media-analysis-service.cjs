const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("../errors.cjs");
const { AI_CAPABILITIES, AI_WORKLOADS } = require("../ai/capabilities.cjs");
const { invokeCapability } = require("../ai/provider-contract.cjs");
const { writeJsonAtomic } = require("../atomic-json.cjs");
const { ANALYSIS_MODES, CLIP_CANDIDATE_SCHEMA, validateClipCandidates } = require("./analysis-contract.cjs");
const { validateCloudMediaConsent } = require("./cloud-consent.cjs");

const MIME_BY_EXTENSION = {
  ".mp4": "video/mp4",
  ".mov": "video/mov",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska"
};

function boundedTranscriptContext(transcript) {
  const segments = transcript.segments
    .slice(0, 2_000)
    .map((segment) => `[${segment.start.toFixed(3)}–${segment.end.toFixed(3)}] ${segment.text}`)
    .join("\n");
  return segments.slice(0, 120_000);
}

function buildAnalysisPrompt(job, transcript) {
  const poolSize = Math.min(20, Math.max(6, Number(job.settings.maxClips || 3) * 3));
  return [
    "Select strong standalone clips from the supplied media context.",
    `Goal: ${job.goal || "Find complete, useful moments."}`,
    `Target duration: ${job.settings.targetDuration} seconds. Draft up to ${poolSize} diverse candidates; the user may approve at most ${job.settings.maxClips}.`,
    `Platforms: ${(job.settings.platforms || []).join(", ") || "unspecified"}.`,
    "Return only the requested schema. Scores are 0–1. Keep rationale concise and never include hidden reasoning.",
    transcript ? `Timestamped transcript:\n${boundedTranscriptContext(transcript)}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

class MediaAnalysisService {
  constructor({ providerService, transcriptionService }) {
    this.providerService = providerService;
    this.transcriptionService = transcriptionService;
  }

  async analyze({ job, paths, localResult }) {
    const mode = job.settings.analysisMode || ANALYSIS_MODES.LOCAL_HEURISTICS;
    if (mode === ANALYSIS_MODES.LOCAL_HEURISTICS) return localResult;
    const provider = this.providerService.resolveWorkload(AI_WORKLOADS.CLIP_ANALYSIS);
    const transcriptionSelection =
      mode === ANALYSIS_MODES.TRANSCRIPT_ONLY || mode === ANALYSIS_MODES.TRANSCRIPT_FRAMES
        ? this.providerService.resolveWorkload(AI_WORKLOADS.TRANSCRIPTION)
        : null;
    const consent = validateCloudMediaConsent(job.settings.cloudConsent, {
      mode,
      providerId: provider.profile.id,
      modelId: provider.model.id,
      cloudTranscription: Boolean(transcriptionSelection && transcriptionSelection.profile.providerType !== "whisper-cpp")
    });
    let transcript = null;
    if (transcriptionSelection) {
      transcript = await this.transcriptionService.transcribeCloud({
        audioPath: path.join(paths.tempPath, "audio.wav"),
        duration: localResult.metadata.duration,
        consent: {
          ...consent,
          providerId: job.settings.cloudConsent.transcriptionProviderId || consent.providerId,
          modelId: job.settings.cloudConsent.transcriptionModelId || consent.modelId
        }
      });
      writeJsonAtomic(path.join(paths.tempPath, "transcript.json"), transcript, { backup: false });
    }
    const prompt = buildAnalysisPrompt(job, transcript);
    let output;
    if (mode === ANALYSIS_MODES.TRANSCRIPT_ONLY) {
      output = await invokeCapability(provider.adapter, provider.model, AI_CAPABILITIES.STRUCTURED_OUTPUT, {
        credentials: provider.credentials,
        prompt,
        schema: CLIP_CANDIDATE_SCHEMA,
        schemaName: "clip candidates"
      });
    } else if (mode === ANALYSIS_MODES.TRANSCRIPT_FRAMES) {
      const framePaths = (await fs.promises.readdir(paths.tempPath))
        .filter((name) => /^frame-\d+\.jpg$/i.test(name))
        .sort()
        .slice(0, 3)
        .map((name) => path.join(paths.tempPath, name));
      if (!framePaths.length) throw new AppError("FRAME_SAMPLING_FAILED", "No sampled frames are available for cloud analysis.");
      const images = await Promise.all(
        framePaths.map(async (framePath) => ({ mediaType: "image/jpeg", data: (await fs.promises.readFile(framePath)).toString("base64") }))
      );
      output = await invokeCapability(provider.adapter, provider.model, AI_CAPABILITIES.IMAGE_UNDERSTANDING, {
        credentials: provider.credentials,
        prompt,
        images,
        schema: CLIP_CANDIDATE_SCHEMA,
        schemaName: "clip candidates"
      });
    } else if (mode === ANALYSIS_MODES.NATIVE_VIDEO) {
      output = await invokeCapability(provider.adapter, provider.model, AI_CAPABILITIES.NATIVE_VIDEO_UNDERSTANDING, {
        credentials: provider.credentials,
        prompt,
        videoPath: paths.sourcePath,
        mimeType: MIME_BY_EXTENSION[path.extname(paths.sourcePath).toLowerCase()] || "video/mp4",
        schema: CLIP_CANDIDATE_SCHEMA,
        schemaName: "clip candidates"
      });
    } else {
      throw new AppError("INVALID_ANALYSIS_MODE", "The selected media analysis mode is unavailable.");
    }
    const analysis = JSON.parse(await fs.promises.readFile(path.join(paths.tempPath, "analysis.json"), "utf8"));
    const transcriptBoundaries = transcript ? transcript.segments.flatMap((segment) => [segment.start, segment.end]) : [];
    const candidates = validateClipCandidates(output, {
      duration: localResult.metadata.duration,
      sceneBoundaries: analysis.scenes,
      transcriptBoundaries
    }).slice(0, Math.min(20, Math.max(6, job.settings.maxClips * 3)));
    writeJsonAtomic(
      path.join(paths.tempPath, "analysis.json"),
      {
        ...analysis,
        candidates,
        provider: { profileId: provider.profile.id, modelId: provider.model.id },
        analysisMode: mode
      },
      { backup: false }
    );
    return {
      ...localResult,
      candidates,
      warnings: [...(localResult.warnings || []), `Candidates were drafted with ${provider.profile.name} and require human review.`]
    };
  }
}

module.exports = { MediaAnalysisService, boundedTranscriptContext, buildAnalysisPrompt };
