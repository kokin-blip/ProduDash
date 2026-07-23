const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AppError } = require("../errors.cjs");
const { writeJsonAtomic } = require("../atomic-json.cjs");
const { getMediaBinaries } = require("./binaries.cjs");

const PROCESSING_VERSION = 1;
const MIN_CLIP_DURATION = 5;
const MAX_CLIP_DURATION = 180;
const MAX_CLIPS = 20;
const MAX_TOOL_OUTPUT = 5_000_000;

function safeOutputName(value, fallback = "clip") {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .toLowerCase();
  return normalized || fallback;
}

function parseTimestamp(value) {
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(value || ""));
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function parseProgressBlock(block, duration) {
  const values = Object.fromEntries(
    String(block)
      .split(/\r?\n/)
      .map((line) => line.split("=", 2))
      .filter(([key, value]) => key && value !== undefined)
  );
  const seconds = parseTimestamp(values.out_time);
  if (!Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0) return null;
  return Math.max(0, Math.min(1, seconds / duration));
}

function createContext(emit = () => {}) {
  return {
    emit,
    canceled: false,
    currentChild: null,
    forceTimer: null,
    requestCancel() {
      this.canceled = true;
      if (!this.currentChild) return;
      this.currentChild.kill("SIGTERM");
      this.forceTimer = setTimeout(() => {
        if (this.currentChild) this.currentChild.kill("SIGKILL");
      }, 2_000);
    }
  };
}

function throwIfCanceled(context) {
  if (context.canceled) throw new AppError("MEDIA_JOB_CANCELED", "The media job was canceled.");
}

function emitStage(context, stage, progress, detail) {
  context.emit({ type: "progress", stage, progress: Math.max(0, Math.min(100, Math.round(progress))), detail });
}

function runTool(command, args, context, options = {}) {
  return new Promise((resolve, reject) => {
    throwIfCanceled(context);
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    context.currentChild = child;
    const stdout = [];
    const stderr = [];
    let outputSize = 0;
    let settled = false;
    let progressBuffer = "";
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (context.forceTimer) clearTimeout(context.forceTimer);
      context.forceTimer = null;
      context.currentChild = null;
      if (context.canceled) {
        reject(new AppError("MEDIA_JOB_CANCELED", "The media job was canceled."));
      } else if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    const collect =
      (target, isStdout = false) =>
      (chunk) => {
        outputSize += chunk.length;
        if (outputSize > (options.maxOutput || MAX_TOOL_OUTPUT)) {
          child.kill("SIGTERM");
          finish(new AppError("MEDIA_TOOL_OUTPUT_LIMIT", "A local media tool returned too much diagnostic output."));
          return;
        }
        target.push(chunk);
        if (isStdout && options.onProgress) {
          progressBuffer += chunk.toString("utf8");
          const blocks = progressBuffer.split(/\r?\nprogress=(?:continue|end)\r?\n/);
          progressBuffer = blocks.pop() || "";
          for (const block of blocks) {
            const ratio = parseProgressBlock(block, options.duration);
            if (ratio !== null) options.onProgress(ratio);
          }
        }
      };
    child.stdout.on("data", collect(stdout, true));
    child.stderr.on("data", collect(stderr));
    child.on("error", () => finish(new AppError("MEDIA_TOOLS_UNAVAILABLE", "Bundled FFmpeg tools could not be started.")));
    child.on("close", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (code !== 0 && !options.allowFailure) {
        finish(new AppError(options.errorCode || "MEDIA_TOOL_FAILED", options.errorMessage || "Local media processing failed."));
      } else {
        finish(null, result);
      }
    });
  });
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectSource(sourcePath, ffprobePath, context) {
  const result = await runTool(
    ffprobePath,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", sourcePath],
    context,
    { errorCode: "INVALID_MEDIA", errorMessage: "The source video could not be inspected." }
  );
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    throw new AppError("INVALID_MEDIA", "FFprobe returned invalid source metadata.");
  }
  const streams = Array.isArray(output.streams) ? output.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(output.format?.duration ?? video?.duration);
  if (!video || !Number.isFinite(duration) || duration < MIN_CLIP_DURATION) {
    throw new AppError("SOURCE_TOO_SHORT", "The source must contain at least five seconds of supported video.");
  }
  return {
    duration,
    width: Number(video.width) || null,
    height: Number(video.height) || null,
    videoCodec: String(video.codec_name || "unknown").slice(0, 80),
    audioCodec: audio ? String(audio.codec_name || "unknown").slice(0, 80) : null,
    hasAudio: Boolean(audio)
  };
}

function parseSilence(stderr) {
  const starts = [...String(stderr).matchAll(/silence_start:\s*([0-9.]+)/g)].map((match) => Number(match[1]));
  const ends = [...String(stderr).matchAll(/silence_end:\s*([0-9.]+)/g)].map((match) => Number(match[1]));
  return starts
    .map((start, index) => ({ start, end: Number.isFinite(ends[index]) ? ends[index] : null }))
    .filter((item) => Number.isFinite(item.start));
}

function parseScenes(stderr, duration) {
  return [
    ...new Set(
      [...String(stderr).matchAll(/pts_time:([0-9.]+)/g)]
        .map((match) => Number(match[1]))
        .filter((value) => Number.isFinite(value) && value > 0 && value < duration)
        .map((value) => Number(value.toFixed(3)))
    )
  ].sort((left, right) => left - right);
}

function generateCandidates({ duration, scenes = [], silences = [], targetDuration = 30, maxClips = 3 }) {
  if (!Number.isFinite(duration) || duration < MIN_CLIP_DURATION) {
    throw new AppError("SOURCE_TOO_SHORT", "The source is too short to generate a valid clip.");
  }
  const clipDuration = Math.max(MIN_CLIP_DURATION, Math.min(MAX_CLIP_DURATION, targetDuration, duration));
  const limit = Math.max(1, Math.min(MAX_CLIPS, maxClips));
  const starts = [0, ...scenes].filter((value) => value + MIN_CLIP_DURATION <= duration);
  for (let cursor = clipDuration; cursor + MIN_CLIP_DURATION <= duration; cursor += clipDuration) starts.push(cursor);
  const uniqueStarts = [...new Set(starts.map((value) => Number(value.toFixed(3))))].sort((left, right) => left - right);
  const candidates = [];
  for (const proposedStart of uniqueStarts) {
    if (candidates.length >= limit) break;
    const previous = candidates.at(-1);
    let start = proposedStart;
    if (previous && start < previous.end) start = previous.end;
    if (start + MIN_CLIP_DURATION > duration) continue;
    const end = Math.min(duration, start + clipDuration);
    const silencePenalty = silences.some((silence) => silence.start < end && (silence.end ?? duration) > start) ? 0.15 : 0;
    candidates.push({
      id: `candidate-${candidates.length + 1}`,
      title: `Clip ${candidates.length + 1}`,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      duration: Number((end - start).toFixed(3)),
      confidence: Number(Math.max(0, 0.7 - silencePenalty).toFixed(2)),
      scores: {
        duration: Number(Math.min(1, (end - start) / Math.max(targetDuration, MIN_CLIP_DURATION)).toFixed(2)),
        audioClarity: silencePenalty ? 0.55 : 0.8,
        visualContinuity: scenes.includes(proposedStart) ? 0.8 : 0.65
      },
      rationale: silencePenalty
        ? "A deterministic interval near a scene boundary; review the detected silence before rendering."
        : "A deterministic interval aligned to the source timeline or a detected scene boundary."
    });
  }
  if (!candidates.length) throw new AppError("NO_CLIP_CANDIDATES", "No valid deterministic clip intervals were found.");
  return candidates;
}

function targetDimensions(targetAspect) {
  if (targetAspect === "vertical") return { width: 720, height: 1280 };
  if (targetAspect === "square") return { width: 1080, height: 1080 };
  if (targetAspect === "landscape") return { width: 1280, height: 720 };
  return null;
}

function escapeSubtitlePath(filePath) {
  return filePath.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

function buildVideoFilter(settings, subtitlePath = "") {
  const dimensions = targetDimensions(settings.targetAspect);
  const filters = [];
  if (dimensions && settings.aspectTreatment !== "original") {
    const { width, height } = dimensions;
    if (settings.aspectTreatment === "center_crop") {
      filters.push(`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`);
    } else {
      filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`);
    }
  }
  if (subtitlePath) filters.push(`subtitles=filename='${escapeSubtitlePath(subtitlePath)}'`);
  return filters.join(",");
}

function buildRenderArgs({ sourcePath, outputPath, candidate, settings, hasAudio, subtitlePath = "" }) {
  const args = ["-nostdin", "-y", "-ss", candidate.start.toFixed(3), "-i", sourcePath];
  if (!hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  args.push("-t", candidate.duration.toFixed(3), "-map", "0:v:0", "-map", hasAudio ? "0:a?" : "1:a:0");
  const videoFilter = buildVideoFilter(settings, subtitlePath);
  if (videoFilter) args.push("-vf", videoFilter);
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-shortest",
    "-progress",
    "pipe:1",
    "-nostats",
    outputPath
  );
  return args;
}

function srtTimestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(
    3,
    "0"
  )}`;
}

function writeCaptionFile(filePath, duration, text) {
  const safeText = String(text || "")
    .replace(/\r?\n+/g, "\n")
    .trim();
  fs.writeFileSync(filePath, `1\n${srtTimestamp(0)} --> ${srtTimestamp(duration)}\n${safeText}\n`, { mode: 0o600 });
}

async function ensureDiskSpace(outputPath, sourceSize) {
  if (typeof fs.promises.statfs !== "function") return;
  const stats = await fs.promises.statfs(outputPath);
  const available = Number(stats.bavail) * Number(stats.bsize);
  const required = Math.max(512 * 1024 * 1024, sourceSize * 2);
  if (Number.isFinite(available) && available < required) {
    throw new AppError("DISK_SPACE_LOW", "The selected output drive does not have enough free space for this job.");
  }
}

async function analyzeJob(job, context, binaries) {
  emitStage(context, "validation", 2, "Validating source, output folder, and disk space.");
  const sourceStat = await fs.promises.stat(job.sourcePath).catch(() => null);
  const outputStat = await fs.promises.stat(job.outputPath).catch(() => null);
  if (!sourceStat?.isFile()) throw new AppError("SOURCE_UNAVAILABLE", "The source video is unavailable.");
  if (!outputStat?.isDirectory()) throw new AppError("OUTPUT_UNAVAILABLE", "The selected output folder is unavailable.");
  await ensureDiskSpace(job.outputPath, sourceStat.size);
  await fs.promises.mkdir(job.tempPath, { recursive: true });
  throwIfCanceled(context);

  const fingerprint = await hashFile(job.sourcePath);
  emitStage(context, "metadata", 8, "Inspecting source metadata.");
  const metadataPath = path.join(job.tempPath, "metadata.json");
  let metadata = null;
  if (fs.existsSync(metadataPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (cached.fingerprint === fingerprint) metadata = cached;
    } catch {
      metadata = null;
    }
  }
  if (!metadata) {
    metadata = { ...(await inspectSource(job.sourcePath, binaries.ffprobePath, context)), fingerprint };
    writeJsonAtomic(metadataPath, metadata, { backup: false });
  }

  const warnings = [];
  const audioPath = path.join(job.tempPath, "audio.wav");
  emitStage(context, "audio_extraction", 15, "Extracting a local analysis track.");
  if (metadata.hasAudio) {
    if (!fs.existsSync(audioPath)) {
      await runTool(
        binaries.ffmpegPath,
        ["-nostdin", "-y", "-i", job.sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath],
        context,
        { errorCode: "AUDIO_EXTRACTION_FAILED", errorMessage: "The source audio could not be extracted." }
      );
    }
  } else {
    warnings.push("The source has no audio track; rendered clips will contain silent AAC audio.");
  }

  let silences = [];
  emitStage(context, "silence_detection", 25, "Detecting sustained silence locally.");
  if (metadata.hasAudio) {
    const silenceResult = await runTool(
      binaries.ffmpegPath,
      ["-nostdin", "-i", audioPath, "-af", "silencedetect=n=-35dB:d=0.5", "-f", "null", "-"],
      context,
      { errorCode: "SILENCE_DETECTION_FAILED", errorMessage: "Local silence detection failed." }
    );
    silences = parseSilence(silenceResult.stderr);
  }

  emitStage(context, "scene_detection", 42, "Detecting scene boundaries locally.");
  const sceneResult = await runTool(
    binaries.ffmpegPath,
    ["-nostdin", "-i", job.sourcePath, "-vf", "select='gt(scene,0.35)',showinfo", "-an", "-f", "null", "-"],
    context,
    { errorCode: "SCENE_DETECTION_FAILED", errorMessage: "Local scene detection failed." }
  );
  const scenes = parseScenes(sceneResult.stderr, metadata.duration);

  emitStage(context, "frame_sampling", 58, "Sampling local review frames.");
  const framePattern = path.join(job.tempPath, "frame-%02d.jpg");
  if (!fs.existsSync(path.join(job.tempPath, "frame-01.jpg"))) {
    const interval = Math.max(1, metadata.duration / 3);
    await runTool(
      binaries.ffmpegPath,
      ["-nostdin", "-y", "-i", job.sourcePath, "-vf", `fps=1/${interval.toFixed(3)},scale=640:-2`, "-frames:v", "3", framePattern],
      context,
      { errorCode: "FRAME_SAMPLING_FAILED", errorMessage: "Local frame sampling failed." }
    );
  }

  emitStage(context, "candidate_generation", 72, "Generating deterministic clip candidates.");
  const candidates = generateCandidates({
    duration: metadata.duration,
    scenes,
    silences,
    targetDuration: job.settings.targetDuration,
    maxClips: job.settings.maxClips
  });
  const analysisPath = path.join(job.tempPath, "analysis.json");
  writeJsonAtomic(
    analysisPath,
    {
      version: PROCESSING_VERSION,
      fingerprint,
      scenes,
      silences,
      candidates
    },
    { backup: false }
  );
  emitStage(context, "candidate_review", 75, "Candidates are ready for human review.");
  return {
    type: "awaiting_review",
    candidates,
    warnings,
    metadata: { duration: metadata.duration, width: metadata.width, height: metadata.height, hasAudio: metadata.hasAudio }
  };
}

async function renderJob(job, context, binaries) {
  const metadataPath = path.join(job.tempPath, "metadata.json");
  const analysisPath = path.join(job.tempPath, "analysis.json");
  if (!fs.existsSync(metadataPath) || !fs.existsSync(analysisPath)) {
    throw new AppError("DURABLE_ARTIFACT_MISSING", "Validated analysis artifacts are missing. Retry analysis before rendering.");
  }
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
  const selected = job.selectedCandidateIds.map((id) => analysis.candidates.find((candidate) => candidate.id === id));
  if (selected.some((candidate) => !candidate)) {
    throw new AppError("CANDIDATE_NOT_FOUND", "One or more approved candidates are unavailable.");
  }
  const warnings = Array.isArray(job.warnings) ? [...job.warnings] : [];
  const renderStatePath = path.join(job.tempPath, "render-state.json");
  let artifacts = [];
  if (fs.existsSync(renderStatePath)) {
    try {
      const durable = JSON.parse(fs.readFileSync(renderStatePath, "utf8"));
      artifacts = (Array.isArray(durable.artifacts) ? durable.artifacts : []).filter((artifact) => {
        const artifactPath = path.resolve(String(artifact.path || ""));
        return (
          ["video", "caption", "thumbnail", "manifest"].includes(artifact.kind) &&
          artifactPath.startsWith(`${path.resolve(job.outputPath)}${path.sep}`) &&
          fs.existsSync(artifactPath)
        );
      });
    } catch {
      artifacts = [];
    }
  }
  const recordArtifact = (artifact) => {
    if (!artifacts.some((item) => item.kind === artifact.kind && item.name === artifact.name)) artifacts.push(artifact);
    writeJsonAtomic(renderStatePath, { version: PROCESSING_VERSION, artifacts }, { backup: false });
  };
  const isKnownArtifact = (artifactPath) =>
    (Array.isArray(job.existingArtifactNames) && job.existingArtifactNames.includes(path.basename(artifactPath))) ||
    artifacts.some((artifact) => artifact.name === path.basename(artifactPath) && artifact.path === artifactPath);
  const startedAt = new Date().toISOString();

  for (let index = 0; index < selected.length; index += 1) {
    throwIfCanceled(context);
    const candidate = selected[index];
    const ordinal = String(index + 1).padStart(2, "0");
    const baseName = `clip-${ordinal}-${safeOutputName(candidate.title, `clip-${ordinal}`)}`;
    const finalVideoPath = path.join(job.outputPath, `${baseName}.mp4`);
    const partialVideoPath = path.join(job.tempPath, `${baseName}.partial.mp4`);
    const knownArtifact = isKnownArtifact(finalVideoPath);
    if (fs.existsSync(finalVideoPath) && !knownArtifact) {
      throw new AppError("OUTPUT_COLLISION", "A generated clip filename already exists. ProduDash will not overwrite it.");
    }
    let captionPath = "";
    if (job.settings.captionMode !== "off") {
      emitStage(context, "captions", 76 + Math.round((index / selected.length) * 12), `Preparing captions for clip ${index + 1}.`);
      captionPath = path.join(job.outputPath, `${baseName}.srt`);
      if (fs.existsSync(captionPath) && !isKnownArtifact(captionPath)) {
        throw new AppError("OUTPUT_COLLISION", "A generated caption filename already exists. ProduDash will not overwrite it.");
      }
      if (!fs.existsSync(captionPath)) writeCaptionFile(captionPath, candidate.duration, job.settings.captionText);
      recordArtifact({ kind: "caption", name: path.basename(captionPath), path: captionPath });
    }
    if (!fs.existsSync(finalVideoPath)) {
      await fs.promises.unlink(partialVideoPath).catch(() => {});
      const subtitlePath = job.settings.captionMode === "srt_burned" ? captionPath : "";
      emitStage(context, "rendering", 78, `Rendering clip ${index + 1} of ${selected.length}.`);
      const args = buildRenderArgs({
        sourcePath: job.sourcePath,
        outputPath: partialVideoPath,
        candidate,
        settings: job.settings,
        hasAudio: metadata.hasAudio,
        subtitlePath
      });
      await runTool(binaries.ffmpegPath, args, context, {
        duration: candidate.duration,
        onProgress: (ratio) =>
          emitStage(
            context,
            "rendering",
            78 + Math.round(((index + ratio) / selected.length) * 14),
            `Rendering clip ${index + 1} of ${selected.length}.`
          ),
        errorCode: "CLIP_RENDER_FAILED",
        errorMessage: "FFmpeg could not render an approved clip."
      });
      await inspectSource(partialVideoPath, binaries.ffprobePath, context);
      await fs.promises.rename(partialVideoPath, finalVideoPath);
    }
    recordArtifact({ kind: "video", name: path.basename(finalVideoPath), path: finalVideoPath });

    emitStage(context, "thumbnails", 93, `Creating thumbnail ${index + 1} of ${selected.length}.`);
    const thumbnailPath = path.join(job.outputPath, `${baseName}-thumbnail.jpg`);
    if (fs.existsSync(thumbnailPath) && !isKnownArtifact(thumbnailPath)) {
      throw new AppError("OUTPUT_COLLISION", "A generated thumbnail filename already exists. ProduDash will not overwrite it.");
    }
    if (!fs.existsSync(thumbnailPath)) {
      await runTool(
        binaries.ffmpegPath,
        [
          "-nostdin",
          "-y",
          "-ss",
          Math.min(1, candidate.duration / 2).toFixed(3),
          "-i",
          finalVideoPath,
          "-frames:v",
          "1",
          "-vf",
          "scale=640:-2",
          "-q:v",
          "3",
          thumbnailPath
        ],
        context,
        { errorCode: "THUMBNAIL_FAILED", errorMessage: "A rendered clip thumbnail could not be created." }
      );
    }
    recordArtifact({ kind: "thumbnail", name: path.basename(thumbnailPath), path: thumbnailPath });
  }

  emitStage(context, "manifest", 97, "Writing a safe processing manifest.");
  const manifestPath = path.join(job.outputPath, "produdash-manifest.json");
  if (fs.existsSync(manifestPath) && !isKnownArtifact(manifestPath)) {
    throw new AppError("OUTPUT_COLLISION", "A ProduDash manifest already exists. ProduDash will not overwrite it.");
  }
  const manifest = {
    version: PROCESSING_VERSION,
    source: {
      basename: path.basename(job.sourcePath),
      fingerprint: metadata.fingerprint
    },
    settings: {
      maxClips: job.settings.maxClips,
      targetDuration: job.settings.targetDuration,
      captionMode: job.settings.captionMode,
      aspectTreatment: job.settings.aspectTreatment,
      targetAspect: job.settings.targetAspect,
      platforms: job.settings.platforms
    },
    startedAt,
    completedAt: new Date().toISOString(),
    files: artifacts.map((artifact) => ({ kind: artifact.kind, filename: artifact.name })),
    analysis: {
      provider: "local_heuristics",
      model: "deterministic-v1",
      candidates: selected.map((candidate) => ({
        id: candidate.id,
        start: candidate.start,
        end: candidate.end,
        confidence: candidate.confidence,
        scores: candidate.scores,
        rationale: candidate.rationale
      }))
    },
    processingVersion: PROCESSING_VERSION,
    warnings
  };
  writeJsonAtomic(manifestPath, manifest, { backup: false });
  recordArtifact({ kind: "manifest", name: path.basename(manifestPath), path: manifestPath });
  emitStage(context, "library_import", 99, "Preparing rendered clips for local library import.");
  return { type: "completed", artifacts, warnings };
}

async function runMediaTask(job, options = {}) {
  const context = options.context || createContext(options.emit);
  const binaries = options.binaries || getMediaBinaries();
  if (job.mode === "analyze") return analyzeJob(job, context, binaries);
  if (job.mode === "render") return renderJob(job, context, binaries);
  throw new AppError("INVALID_MEDIA_JOB_MODE", "The media job mode is invalid.");
}

async function handleParentMessage(event) {
  const message = event?.data;
  if (message?.type === "cancel") {
    activeContext?.requestCancel();
    return;
  }
  if (message?.type !== "run" || activeContext) return;
  activeContext = createContext((payload) => process.parentPort.postMessage(payload));
  try {
    const result = await runMediaTask(message.job, { context: activeContext });
    process.parentPort.postMessage(result);
  } catch (error) {
    const safe = error instanceof AppError ? error : new AppError("MEDIA_JOB_FAILED", "Local media processing failed.");
    let artifacts = [];
    if (message.job?.mode === "render") {
      try {
        const durable = JSON.parse(fs.readFileSync(path.join(message.job.tempPath, "render-state.json"), "utf8"));
        artifacts = Array.isArray(durable.artifacts) ? durable.artifacts : [];
      } catch {
        artifacts = [];
      }
    }
    process.parentPort.postMessage({
      type: safe.code === "MEDIA_JOB_CANCELED" ? "canceled" : "error",
      error: { code: safe.code, message: safe.message },
      retryable: !["SOURCE_TOO_SHORT", "INVALID_MEDIA_JOB_MODE"].includes(safe.code),
      artifacts
    });
  } finally {
    activeContext = null;
  }
}

let activeContext = null;
if (process.parentPort) process.parentPort.on("message", handleParentMessage);

module.exports = {
  MAX_CLIPS,
  MAX_CLIP_DURATION,
  MIN_CLIP_DURATION,
  PROCESSING_VERSION,
  buildRenderArgs,
  createContext,
  generateCandidates,
  parseProgressBlock,
  runMediaTask,
  safeOutputName,
  writeCaptionFile
};
