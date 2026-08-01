const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AppError } = require("../errors.cjs");
const { writeJsonAtomic } = require("../atomic-json.cjs");
const { getMediaBinaries } = require("./binaries.cjs");
const { scoreCandidate } = require("./analysis-contract.cjs");
const { formatSrt, wrapCaptionText } = require("./captions.cjs");

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

// Checks a clip ProduDash just produced, which is a different question from
// whether a source is worth clipping.
//
// This used to call inspectSource, whose rule is that anything under
// MIN_CLIP_DURATION is unusable. Keyframe alignment routinely costs a few
// hundredths of a second, so a clip requested at exactly the minimum could land
// just under it -- and the job then failed with SOURCE_TOO_SHORT, blaming a
// source that was perfectly fine, and refusing the retry that would have
// worked. What matters here is only that a real, playable video came out.
async function inspectRenderedClip(clipPath, ffprobePath, context) {
  const result = await runTool(ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", clipPath], context, {
    errorCode: "RENDER_OUTPUT_UNREADABLE",
    errorMessage: "The rendered clip could not be inspected."
  });
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    throw new AppError("RENDER_OUTPUT_UNREADABLE", "FFprobe returned invalid metadata for the rendered clip.");
  }
  const video = (Array.isArray(output.streams) ? output.streams : []).find((stream) => stream.codec_type === "video");
  const duration = Number(output.format?.duration ?? video?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0) {
    throw new AppError("RENDER_OUTPUT_EMPTY", "The rendered clip contains no playable video.");
  }
  return { duration };
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

function parseDetectedIntervals(stderr, duration) {
  const intervals = [];
  for (const pattern of [/black_start:([0-9.]+)\s+black_end:([0-9.]+)/g, /freeze_start:\s*([0-9.]+)[\s\S]*?freeze_end:\s*([0-9.]+)/g]) {
    for (const match of String(stderr).matchAll(pattern)) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        intervals.push({ start: Math.max(0, start), end: Math.min(duration, end) });
      }
    }
  }
  return intervals.slice(0, 200);
}

function waveformPeaks(filePath, count = 240) {
  if (!fs.existsSync(filePath)) return [];
  const buffer = fs.readFileSync(filePath);
  if (buffer.length <= 44) return [];
  const sampleCount = Math.floor((buffer.length - 44) / 2);
  const stride = Math.max(1, Math.floor(sampleCount / count));
  const peaks = [];
  for (let offset = 0; offset < sampleCount && peaks.length < count; offset += stride) {
    let peak = 0;
    const end = Math.min(sampleCount, offset + stride);
    for (let sample = offset; sample < end; sample += 1) {
      peak = Math.max(peak, Math.abs(buffer.readInt16LE(44 + sample * 2)) / 32768);
    }
    peaks.push(Number(Math.min(1, peak).toFixed(3)));
  }
  return peaks;
}

function intervalOverlap(start, end, otherStart, otherEnd) {
  return Math.max(0, Math.min(end, otherEnd) - Math.max(start, otherStart));
}

function boundaryScore(value, boundaries, tolerance = 2) {
  const distance = Math.min(...boundaries.map((boundary) => Math.abs(boundary - value)), tolerance);
  return Number(Math.max(0, 1 - distance / tolerance).toFixed(3));
}

function generateCandidates({
  duration,
  scenes = [],
  silences = [],
  transcriptBoundaries = [],
  unusableIntervals = [],
  targetDuration = 30,
  maxClips = 3
}) {
  if (!Number.isFinite(duration) || duration < MIN_CLIP_DURATION) {
    throw new AppError("SOURCE_TOO_SHORT", "The source is too short to generate a valid clip.");
  }
  const clipDuration = Math.max(MIN_CLIP_DURATION, Math.min(MAX_CLIP_DURATION, targetDuration, duration));
  const requestedLimit = Math.max(1, Math.min(MAX_CLIPS, maxClips));
  const poolLimit = Math.min(MAX_CLIPS, Math.max(6, requestedLimit * 3));
  const clipDurations = [...new Set([clipDuration * 0.65, clipDuration, clipDuration * 1.35])]
    .map((value) => Number(Math.max(MIN_CLIP_DURATION, Math.min(MAX_CLIP_DURATION, duration, value)).toFixed(3)))
    .sort((left, right) => left - right);
  const safeScenes = scenes.filter((value) => Number.isFinite(value) && value > 0 && value < duration);
  const safeTranscriptBoundaries = transcriptBoundaries.filter((value) => Number.isFinite(value) && value >= 0 && value <= duration);
  const silenceBoundaries = silences.flatMap((silence) => [silence.start, silence.end]).filter((value) => Number.isFinite(value));
  const boundaries = [0, duration, ...safeScenes, ...silenceBoundaries, ...safeTranscriptBoundaries].sort((left, right) => left - right);
  const gridStep = Math.max(MIN_CLIP_DURATION, clipDuration / 2);
  const starts = [0, ...safeScenes, ...silenceBoundaries, ...safeTranscriptBoundaries];
  for (let cursor = gridStep; cursor + MIN_CLIP_DURATION <= duration; cursor += gridStep) starts.push(cursor);
  const uniqueStarts = [...new Set(starts.map((value) => Number(Math.max(0, Math.min(duration, value)).toFixed(3))))]
    .filter((value) => value + MIN_CLIP_DURATION <= duration)
    .sort((left, right) => left - right)
    .slice(0, 200);
  const pool = [];
  for (const start of uniqueStarts) {
    for (const variantDuration of clipDurations) {
      const end = Math.min(duration, start + variantDuration);
      const candidateDuration = end - start;
      if (candidateDuration < MIN_CLIP_DURATION) continue;
      const silenceDuration = silences.reduce(
        (sum, silence) => sum + intervalOverlap(start, end, Number(silence.start), Number(silence.end ?? duration)),
        0
      );
      const silenceRatio = Math.max(0, Math.min(1, silenceDuration / candidateDuration));
      const unusableDuration = unusableIntervals.reduce(
        (sum, interval) => sum + intervalOverlap(start, end, Number(interval.start), Number(interval.end)),
        0
      );
      const unusableRatio = Math.max(0, Math.min(1, unusableDuration / candidateDuration));
      const sceneCount = safeScenes.filter((scene) => scene > start && scene < end).length;
      const excessiveCuts = Math.max(0, sceneCount - Math.max(1, candidateDuration / 4));
      const startBoundary = boundaryScore(start, boundaries);
      const endBoundary = boundaryScore(end, boundaries);
      const boundaryAlignment = (startBoundary + endBoundary) / 2;
      const activityDensity = 1 - silenceRatio;
      const scores = {
        hook: Number((0.35 + boundaryAlignment * 0.45 + activityDensity * 0.2).toFixed(3)),
        completeThought: safeTranscriptBoundaries.length ? Number(boundaryAlignment.toFixed(3)) : 0.35,
        audioClarity: Number(activityDensity.toFixed(3)),
        visualContinuity: Number(Math.max(0, 1 - excessiveCuts / 5).toFixed(3)),
        goalRelevance: 0,
        duration: Number(Math.max(0, 1 - Math.abs(candidateDuration - clipDuration) / Math.max(clipDuration, 1)).toFixed(3)),
        platformFit: 0.6,
        novelty: 1,
        duplication: 0,
        silence: Number(silenceRatio.toFixed(3)),
        unusableFrames: Number(unusableRatio.toFixed(3))
      };
      pool.push({
        id: "",
        title: "",
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        duration: Number(candidateDuration.toFixed(3)),
        confidence: Number(Math.max(0.25, Math.min(0.9, 0.45 + activityDensity * 0.25 + boundaryAlignment * 0.2)).toFixed(3)),
        scores,
        weightedScore: scoreCandidate(scores),
        rationale: `Smart local cuts measured ${Math.round(activityDensity * 100)}% audio activity, ${sceneCount} internal scene ${
          sceneCount === 1 ? "change" : "changes"
        }, ${Math.round(boundaryAlignment * 100)}% boundary alignment, and ${Math.round(
          unusableRatio * 100
        )}% locally detected black/frozen footage. Semantic goal relevance was not scored.`
      });
    }
  }
  pool.sort((left, right) => right.weightedScore - left.weightedScore || left.start - right.start);
  const selected = [];
  const usedSections = new Set();
  while (selected.length < poolLimit) {
    let best = null;
    let bestRank = -Infinity;
    for (const candidate of pool) {
      if (selected.includes(candidate)) continue;
      const overlapRatio = selected.reduce(
        (maximum, other) =>
          Math.max(
            maximum,
            intervalOverlap(candidate.start, candidate.end, other.start, other.end) / Math.min(candidate.duration, other.duration)
          ),
        0
      );
      if (overlapRatio > 0.2) continue;
      const section = Math.min(3, Math.floor((candidate.start / duration) * 4));
      const novelty = usedSections.has(section) ? 0.45 : 1;
      const durationNovelty = selected.some((other) => Math.abs(other.duration - candidate.duration) < 2) ? 0.45 : 1;
      candidate.scores.duplication = Number(overlapRatio.toFixed(3));
      candidate.weightedScore = scoreCandidate(candidate.scores);
      const rank = candidate.weightedScore + novelty * 0.08 + durationNovelty * 0.04 - overlapRatio * 0.2;
      if (rank > bestRank || (rank === bestRank && candidate.start < best.start)) {
        best = candidate;
        bestRank = rank;
      }
    }
    if (!best) break;
    best.scores.novelty = usedSections.has(Math.min(3, Math.floor((best.start / duration) * 4))) ? 0.45 : 1;
    best.weightedScore = scoreCandidate(best.scores);
    selected.push(best);
    usedSections.add(Math.min(3, Math.floor((best.start / duration) * 4)));
  }
  if (!selected.length) throw new AppError("NO_CLIP_CANDIDATES", "No valid deterministic clip intervals were found.");
  return selected.map((candidate, index) => ({
    ...candidate,
    id: `candidate-${index + 1}`,
    title: `Clip ${index + 1}`
  }));
}

function targetDimensions(targetAspect) {
  if (targetAspect === "vertical") return { width: 720, height: 1280 };
  if (targetAspect === "square") return { width: 1080, height: 1080 };
  if (targetAspect === "landscape") return { width: 1280, height: 720 };
  return null;
}

function outputDimensions(settings) {
  const base = targetDimensions(settings.targetAspect);
  if (settings.enhancement?.mode !== "resize_hd" || settings.enhancement?.reviewed !== true) return base;
  if (settings.targetAspect === "vertical") return { width: 1080, height: 1920 };
  if (settings.targetAspect === "square") return { width: 1080, height: 1080 };
  if (settings.targetAspect === "landscape") return { width: 1920, height: 1080 };
  const sourceWidth = Math.max(2, Number(settings.sourceWidth) || 1920);
  const sourceHeight = Math.max(2, Number(settings.sourceHeight) || 1080);
  if (sourceWidth >= sourceHeight) {
    return { width: 1920, height: Math.max(2, Math.round((sourceHeight / sourceWidth) * 960) * 2) };
  }
  return { width: Math.max(2, Math.round((sourceWidth / sourceHeight) * 960) * 2), height: 1920 };
}

function enhancementSummary(settings, metadata) {
  const reviewed = settings.enhancement?.mode === "resize_hd" && settings.enhancement?.reviewed === true;
  const dimensions = reviewed
    ? outputDimensions({ ...settings, sourceWidth: metadata.width, sourceHeight: metadata.height })
    : { width: metadata.width, height: metadata.height };
  return {
    mode: reviewed ? "resize_hd" : "off",
    reviewed,
    sourceWidth: metadata.width,
    sourceHeight: metadata.height,
    outputWidth: dimensions?.width || metadata.width,
    outputHeight: dimensions?.height || metadata.height,
    detailClaim: reviewed ? "Local resize only; does not recover source detail." : "No local resize applied."
  };
}

function escapeSubtitlePath(filePath) {
  return filePath.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

function assColor(value, fallback) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(value || fallback));
  if (!match) return "&H00FFFFFF";
  return `&H00${match[3]}${match[2]}${match[1]}`.toUpperCase();
}

function subtitleStyle(settings) {
  const scale = Math.max(0.5, Math.min(2.5, Number(settings.captionScale) || 1));
  const styles = {
    clean: "FontName=Arial,BorderStyle=1,Outline=2,Shadow=0",
    contrast: "FontName=Arial,BorderStyle=3,Outline=1,Shadow=0",
    notebook: "FontName=Arial,BorderStyle=1,Outline=2,Shadow=1",
    brand: "FontName=Arial,BorderStyle=3,Outline=1,Shadow=0"
  };
  const alignments = { lower: 2, middle: 5, upper: 8 };
  const margins = { standard: 48, social: 110 };
  return `${styles[settings.captionStyle] || styles.clean},FontSize=${Math.round(
    18 * scale
  )},PrimaryColour=${assColor(settings.captionTextColor, "#ffffff")},BackColour=${assColor(
    settings.captionBackgroundColor,
    "#000000"
  )},OutlineColour=${assColor(settings.captionBackgroundColor, "#000000")},Alignment=${
    alignments[settings.captionPosition] || 2
  },MarginV=${margins[settings.captionSafeArea] || 48}`;
}

function filterText(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'")
    .replaceAll(",", "\\,")
    .replaceAll("%", "\\%");
}

function buildVideoFilter(settings, subtitlePath = "") {
  const dimensions = outputDimensions(settings);
  const filters = [];
  if (dimensions && settings.aspectTreatment === "original" && settings.enhancement?.reviewed === true) {
    filters.push(`scale=${dimensions.width}:${dimensions.height}:flags=lanczos`);
  } else if (dimensions && settings.aspectTreatment !== "original") {
    const { width, height } = dimensions;
    if (settings.aspectTreatment === "center_crop") {
      const reviewedSubject = (settings.intelligentTracks?.subject || []).find((item) => item.reviewed);
      const keyframe = reviewedSubject?.keyframes?.[0];
      const x = Math.max(0, Math.min(1, Number(keyframe?.x) || 0.5)).toFixed(3);
      const y = Math.max(0, Math.min(1, Number(keyframe?.y) || 0.5)).toFixed(3);
      filters.push(`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}:(iw-ow)*${x}:(ih-oh)*${y}`);
    } else {
      const background = /^#[0-9a-f]{6}$/i.test(settings.composition?.backgroundColor || "")
        ? settings.composition.backgroundColor
        : "#000000";
      filters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:${background}`
      );
    }
  }
  if (subtitlePath) {
    filters.push(`subtitles=filename='${escapeSubtitlePath(subtitlePath)}':force_style='${subtitleStyle(settings)}'`);
  }
  for (const overlay of Array.isArray(settings.composition?.overlays) ? settings.composition.overlays : []) {
    if (!["text", "cta"].includes(overlay.type)) continue;
    const start = Number(overlay.start).toFixed(3);
    const end = Number(overlay.end).toFixed(3);
    const opacity = Math.max(0.1, Math.min(1, Number(overlay.opacity) || 1));
    const fontSize = Math.round(32 * Math.max(0.5, Math.min(3, Number(overlay.fontScale) || 1)));
    const x = `(w-text_w)*${Math.max(0, Math.min(1, Number(overlay.x) || 0.5)).toFixed(3)}`;
    const y = `(h-text_h)*${Math.max(0, Math.min(1, Number(overlay.y) || 0.82)).toFixed(3)}`;
    const textColor = /^#[0-9a-f]{6}$/i.test(overlay.textColor || "") ? overlay.textColor : "#ffffff";
    const backgroundColor = /^#[0-9a-f]{6}$/i.test(overlay.backgroundColor || "") ? overlay.backgroundColor : "#000000";
    filters.push(
      `drawtext=text='${filterText(overlay.text)}':x=${x}:y=${y}:fontsize=${fontSize}:fontcolor=${textColor}@${opacity}:box=1:boxcolor=${backgroundColor}@${Math.min(
        0.9,
        opacity * 0.82
      )}:boxborderw=12:enable='between(t,${start},${end})'`
    );
  }
  return filters.join(",");
}

function buildRenderArgs({ sourcePath, outputPath, candidate, settings, hasAudio, subtitlePath = "", assetPaths = {} }) {
  if (Array.isArray(candidate.segments) && candidate.segments.length) {
    return buildProjectRenderArgs({ sourcePath, outputPath, candidate, settings, hasAudio, subtitlePath, assetPaths });
  }
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

function buildProjectRenderArgs({ sourcePath, outputPath, candidate, settings, hasAudio, subtitlePath = "", assetPaths = {} }) {
  const args = ["-nostdin", "-y", "-i", sourcePath];
  if (!hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  let nextInput = hasAudio ? 1 : 2;
  const logoInputs = [];
  for (const overlay of Array.isArray(settings.composition?.overlays) ? settings.composition.overlays : []) {
    if (overlay.type !== "logo") continue;
    const logoPath = assetPaths[overlay.assetId];
    if (!logoPath) throw new AppError("BRAND_ASSET_MISSING", "A snapshotted logo asset is unavailable.");
    args.push("-loop", "1", "-i", logoPath);
    logoInputs.push({ overlay, input: nextInput });
    nextInput += 1;
  }
  let musicInput = null;
  if (settings.composition?.music) {
    const musicPath = assetPaths[settings.composition.music.assetId];
    if (!musicPath) throw new AppError("BRAND_ASSET_MISSING", "The snapshotted music asset is unavailable.");
    args.push("-stream_loop", "-1", "-i", musicPath);
    musicInput = nextInput;
    nextInput += 1;
  }
  const brollInputs = [];
  for (const track of Array.isArray(settings.intelligentTracks?.broll) ? settings.intelligentTracks.broll : []) {
    if (!track.reviewed) continue;
    const brollPath = assetPaths[track.mediaId];
    if (!brollPath) throw new AppError("BROLL_SOURCE_MISSING", "A snapshotted B-roll source is unavailable.");
    args.push("-i", brollPath);
    brollInputs.push({ track, input: nextInput });
    nextInput += 1;
  }
  const sfxInputs = [];
  for (const track of Array.isArray(settings.intelligentTracks?.sfx) ? settings.intelligentTracks.sfx : []) {
    if (!track.reviewed) continue;
    const sfxPath = assetPaths[track.assetId];
    if (!sfxPath) throw new AppError("SFX_SOURCE_MISSING", "A snapshotted sound-effect asset is unavailable.");
    args.push("-i", sfxPath);
    sfxInputs.push({ track, input: nextInput });
    nextInput += 1;
  }
  const voiceoverInputs = [];
  for (const track of Array.isArray(settings.voiceovers) ? settings.voiceovers : []) {
    if (track.status !== "reviewed") continue;
    const voiceoverPath = assetPaths[track.assetId];
    if (!voiceoverPath) throw new AppError("VOICEOVER_SOURCE_MISSING", "A snapshotted voiceover preview is unavailable.");
    args.push("-i", voiceoverPath);
    voiceoverInputs.push({ track, input: nextInput });
    nextInput += 1;
  }
  const chains = [];
  candidate.segments.forEach((segment, index) => {
    const segmentDuration = Number(segment.sourceEnd - segment.sourceStart);
    const transitionDuration =
      settings.composition?.transition === "fade"
        ? Math.min(Number(settings.composition.transitionDuration) || 0.25, Math.max(0.05, segmentDuration / 3))
        : 0;
    const videoTransition = transitionDuration
      ? `,fade=t=in:st=0:d=${transitionDuration.toFixed(3)},fade=t=out:st=${Math.max(0, segmentDuration - transitionDuration).toFixed(
          3
        )}:d=${transitionDuration.toFixed(3)}`
      : "";
    chains.push(
      `[0:v:0]trim=start=${segment.sourceStart.toFixed(3)}:end=${segment.sourceEnd.toFixed(3)},setpts=PTS-STARTPTS${videoTransition}[v${index}]`
    );
    if (hasAudio) {
      const audioTransition = transitionDuration
        ? `,afade=t=in:st=0:d=${transitionDuration.toFixed(3)},afade=t=out:st=${Math.max(0, segmentDuration - transitionDuration).toFixed(
            3
          )}:d=${transitionDuration.toFixed(3)}`
        : "";
      chains.push(
        `[0:a:0]atrim=start=${segment.sourceStart.toFixed(3)}:end=${segment.sourceEnd.toFixed(
          3
        )},asetpts=PTS-STARTPTS${audioTransition}[a${index}]`
      );
    }
  });
  const inputs = candidate.segments.map((_segment, index) => `[v${index}]${hasAudio ? `[a${index}]` : ""}`).join("");
  chains.push(`${inputs}concat=n=${candidate.segments.length}:v=1:a=${hasAudio ? 1 : 0}[vcat]${hasAudio ? "[acat]" : ""}`);
  const videoFilter = buildVideoFilter(settings, subtitlePath);
  let videoLabel = "vcat";
  if (videoFilter) {
    chains.push(`[vcat]${videoFilter}[vbase]`);
    videoLabel = "vbase";
  }
  logoInputs.forEach(({ overlay, input }, index) => {
    const logoLabel = `logo${index}`;
    const nextLabel = `vlogo${index}`;
    const opacity = Math.max(0.1, Math.min(1, Number(overlay.opacity) || 1)).toFixed(3);
    const outputWidth = outputDimensions(settings)?.width || Number(settings.sourceWidth) || 1920;
    const targetWidth = Math.max(24, Math.min(outputWidth, Math.round(outputWidth * (Number(overlay.width) || 0.18))));
    chains.push(`[${input}:v]scale=${targetWidth}:-1,format=rgba,colorchannelmixer=aa=${opacity}[${logoLabel}]`);
    chains.push(
      `[${videoLabel}][${logoLabel}]overlay=x='(main_w-overlay_w)*${Number(overlay.x).toFixed(
        3
      )}':y='(main_h-overlay_h)*${Number(overlay.y).toFixed(3)}':enable='between(t,${Number(overlay.start).toFixed(
        3
      )},${Number(overlay.end).toFixed(3)})'[${nextLabel}]`
    );
    videoLabel = nextLabel;
  });
  brollInputs.forEach(({ track, input }, index) => {
    const dimensions = outputDimensions(settings);
    const width = dimensions?.width || Number(settings.sourceWidth) || 1920;
    const height = dimensions?.height || Number(settings.sourceHeight) || 1080;
    const scale =
      track.fit === "center_crop"
        ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
        : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:#000000`;
    const layerLabel = `broll${index}`;
    const nextLabel = `vbroll${index}`;
    chains.push(
      `[${input}:v]trim=start=${Number(track.sourceStart).toFixed(3)}:end=${Number(track.sourceEnd).toFixed(
        3
      )},setpts=PTS-STARTPTS+${Number(track.start).toFixed(3)}/TB,${scale},format=rgba,colorchannelmixer=aa=${Number(track.opacity).toFixed(
        3
      )}[${layerLabel}]`
    );
    chains.push(
      `[${videoLabel}][${layerLabel}]overlay=eof_action=pass:repeatlast=0:enable='between(t,${Number(track.start).toFixed(3)},${Number(
        track.end
      ).toFixed(3)})'[${nextLabel}]`
    );
    videoLabel = nextLabel;
  });
  let audioLabel = hasAudio ? "acat" : "1:a:0";
  if (musicInput !== null) {
    const cue = settings.composition.music;
    const duration = Number(cue.end - cue.start);
    const fadeOutStart = Math.max(0, duration - Number(cue.fadeOut || 0));
    chains.push(
      `[${musicInput}:a]atrim=start=0:end=${duration.toFixed(3)},asetpts=PTS-STARTPTS+${Number(cue.start).toFixed(
        3
      )}/TB,volume=${Number(cue.volume).toFixed(3)},afade=t=in:st=${Number(cue.start).toFixed(3)}:d=${Number(cue.fadeIn || 0).toFixed(
        3
      )},afade=t=out:st=${(Number(cue.start) + fadeOutStart).toFixed(3)}:d=${Number(cue.fadeOut || 0).toFixed(3)}[music]`
    );
    chains.push(`[${audioLabel}][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
    audioLabel = "aout";
  }
  sfxInputs.forEach(({ track, input }, index) => {
    const duration = Number(track.end - track.start);
    const effectLabel = `sfx${index}`;
    const nextLabel = `asfx${index}`;
    chains.push(
      `[${input}:a]atrim=start=0:end=${duration.toFixed(3)},asetpts=PTS-STARTPTS+${Number(track.start).toFixed(
        3
      )}/TB,volume=${Number(track.volume).toFixed(3)}[${effectLabel}]`
    );
    chains.push(`[${audioLabel}][${effectLabel}]amix=inputs=2:duration=first:dropout_transition=0[${nextLabel}]`);
    audioLabel = nextLabel;
  });
  voiceoverInputs.forEach(({ track, input }, index) => {
    const duration = Number(track.end - track.start);
    const voiceLabel = `voiceover${index}`;
    const nextLabel = `avoiceover${index}`;
    if (track.originalAudio === "replace") {
      const mutedLabel = `avoiceoverbase${index}`;
      chains.push(
        `[${audioLabel}]volume=0:enable='between(t,${Number(track.start).toFixed(3)},${Number(track.end).toFixed(3)})'[${mutedLabel}]`
      );
      audioLabel = mutedLabel;
    }
    chains.push(
      `[${input}:a]atrim=start=0:end=${duration.toFixed(3)},asetpts=PTS-STARTPTS+${Number(track.start).toFixed(
        3
      )}/TB,volume=${Number(track.volume).toFixed(3)}[${voiceLabel}]`
    );
    chains.push(`[${audioLabel}][${voiceLabel}]amix=inputs=2:duration=first:dropout_transition=0[${nextLabel}]`);
    audioLabel = nextLabel;
  });
  const reviewedAudio = (settings.intelligentTracks?.audio || []).filter((item) => item.reviewed);
  reviewedAudio.forEach((track, index) => {
    const nextLabel = `aenhance${index}`;
    const strength = Math.max(0, Math.min(1, Number(track.strength) || 0.5));
    const filters =
      track.preset === "voice_cleanup"
        ? `highpass=f=${Math.round(60 + strength * 60)},lowpass=f=${Math.round(
            15_000 - strength * 5_000
          )},acompressor=threshold=${(-12 - strength * 12).toFixed(1)}dB:ratio=${(2 + strength * 3).toFixed(1)}:attack=20:release=180`
        : track.preset === "enhance"
          ? `equalizer=f=3000:t=q:w=1:g=${(strength * 4).toFixed(1)},acompressor=threshold=-18dB:ratio=${(2 + strength * 2).toFixed(
              1
            )}:attack=15:release=150`
          : `acompressor=threshold=-20dB:ratio=${(1.5 + strength * 2).toFixed(1)}:attack=25:release=200`;
    const start = Math.max(0, Number(track.start) || 0);
    const end = Math.min(candidate.duration, Number(track.end) || candidate.duration);
    if (start <= 0 && end >= candidate.duration) {
      chains.push(`[${audioLabel}]${filters}[${nextLabel}]`);
    } else {
      const preLabel = `aenhancepre${index}`;
      const selectedLabel = `aenhanceselected${index}`;
      const postLabel = `aenhancepost${index}`;
      const splitLabels = [`[${preLabel}]`, `[${selectedLabel}]`, `[${postLabel}]`].join("");
      chains.push(`[${audioLabel}]asplit=3${splitLabels}`);
      chains.push(`[${preLabel}]atrim=start=0:end=${start.toFixed(3)},asetpts=PTS-STARTPTS[apreparedpre${index}]`);
      chains.push(
        `[${selectedLabel}]atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS,${filters}[apreparedselected${index}]`
      );
      chains.push(
        `[${postLabel}]atrim=start=${end.toFixed(3)}:end=${candidate.duration.toFixed(3)},asetpts=PTS-STARTPTS[apreparedpost${index}]`
      );
      chains.push(`[apreparedpre${index}][apreparedselected${index}][apreparedpost${index}]concat=n=3:v=0:a=1[${nextLabel}]`);
    }
    audioLabel = nextLabel;
  });
  args.push("-filter_complex", chains.join(";"), "-map", `[${videoLabel}]`, "-map", `[${audioLabel}]`);
  args.push(
    "-t",
    candidate.duration.toFixed(3),
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

function writeCaptionFile(filePath, duration, input, offset = 0) {
  const segments = Array.isArray(input)
    ? input.map((segment) => ({
        ...segment,
        start: Number(segment.start) + offset,
        end: Number(segment.end) + offset
      }))
    : [
        {
          start: 0,
          end: duration,
          text: wrapCaptionText(input)
        }
      ];
  fs.writeFileSync(filePath, formatSrt(segments, duration + offset), { mode: 0o600 });
}

function bookendTargetDimensions(settings, metadata) {
  const enhanced = outputDimensions({ ...settings, sourceWidth: metadata.width, sourceHeight: metadata.height });
  if (enhanced && settings.enhancement?.reviewed === true) return [enhanced.width, enhanced.height];
  const explicit = {
    vertical: [1080, 1920],
    square: [1080, 1080],
    landscape: [1920, 1080]
  }[settings.targetAspect];
  if (explicit) return explicit;
  const width = Math.max(2, Math.floor(Number(metadata.width || 1920) / 2) * 2);
  const height = Math.max(2, Math.floor(Number(metadata.height || 1080) / 2) * 2);
  return [width, height];
}

async function normalizeBookendAsset({ sourcePath, outputPath, hasAudio, duration, width, height, context, binaries }) {
  const args = ["-nostdin", "-y", "-i", sourcePath];
  if (!hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  args.push(
    "-t",
    Number(duration).toFixed(3),
    "-map",
    "0:v:0",
    "-map",
    hasAudio ? "0:a:0?" : "1:a:0",
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:#000000,fps=30`,
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
    "-ar",
    "48000",
    "-ac",
    "2",
    "-b:a",
    "192k",
    "-shortest",
    outputPath
  );
  await runTool(binaries.ffmpegPath, args, context, {
    duration,
    errorCode: "BOOKEND_RENDER_FAILED",
    errorMessage: "FFmpeg could not normalize an intro or outro asset."
  });
}

async function combineBookends({ corePath, finalPath, candidate, settings, assetPaths, context, binaries, metadata }) {
  const composition = settings.composition || {};
  const snapshots = settings.assetSnapshots || {};
  const ordered = [];
  const [width, height] = bookendTargetDimensions(settings, metadata);
  for (const [position, assetId] of [
    ["intro", composition.introAssetId],
    ["outro", composition.outroAssetId]
  ]) {
    if (!assetId) continue;
    const snapshot = snapshots[assetId];
    const sourcePath = assetPaths[assetId];
    if (!snapshot || !sourcePath) throw new AppError("BRAND_ASSET_MISSING", `The snapshotted ${position} asset is unavailable.`);
    const normalizedPath = path.join(path.dirname(corePath), `${position}-${assetId}.mp4`);
    await normalizeBookendAsset({
      sourcePath,
      outputPath: normalizedPath,
      hasAudio: snapshot.hasAudio,
      duration: snapshot.duration,
      width,
      height,
      context,
      binaries
    });
    ordered.push({ position, path: normalizedPath });
  }
  const files = [
    ...ordered.filter((item) => item.position === "intro").map((item) => item.path),
    corePath,
    ...ordered.filter((item) => item.position === "outro").map((item) => item.path)
  ];
  const listPath = path.join(path.dirname(corePath), `concat-${candidate.id}.txt`);
  fs.writeFileSync(listPath, files.map((filePath) => `file '${filePath.replaceAll("'", "'\\''")}'`).join("\n"), { mode: 0o600 });
  await runTool(
    binaries.ffmpegPath,
    ["-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", finalPath],
    context,
    {
      duration:
        candidate.duration +
        ordered.reduce(
          (total, item) => total + Number(snapshots[path.basename(item.path, ".mp4").replace(/^(intro|outro)-/, "")]?.duration || 0),
          0
        ),
      errorCode: "BOOKEND_CONCAT_FAILED",
      errorMessage: "FFmpeg could not attach the approved intro or outro."
    }
  );
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

  emitStage(context, "quality_detection", 50, "Checking for sustained black or frozen footage.");
  const qualityResult = await runTool(
    binaries.ffmpegPath,
    ["-nostdin", "-i", job.sourcePath, "-vf", "blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=1.5", "-an", "-f", "null", "-"],
    context,
    { allowFailure: true }
  );
  const unusableIntervals = qualityResult.code === 0 ? parseDetectedIntervals(qualityResult.stderr, metadata.duration) : [];
  if (qualityResult.code !== 0) warnings.push("Local black/frozen-frame detection was unavailable for this source.");

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
  let transcriptBoundaries = [];
  const transcriptPath = path.join(job.tempPath, "transcript.json");
  if (fs.existsSync(transcriptPath)) {
    try {
      const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
      transcriptBoundaries = (Array.isArray(transcript.segments) ? transcript.segments : []).flatMap((segment) => [
        Number(segment.start),
        Number(segment.end)
      ]);
    } catch {
      transcriptBoundaries = [];
      warnings.push("A cached transcript was invalid and was not used for Smart local cuts.");
    }
  }
  const candidates = generateCandidates({
    duration: metadata.duration,
    scenes,
    silences,
    transcriptBoundaries,
    unusableIntervals,
    targetDuration: job.settings.targetDuration,
    maxClips: job.settings.maxClips
  });
  const analysisPath = path.join(job.tempPath, "analysis.json");
  const waveform = metadata.hasAudio ? waveformPeaks(audioPath) : [];
  writeJsonAtomic(
    analysisPath,
    {
      version: PROCESSING_VERSION,
      fingerprint,
      scenes,
      silences,
      unusableIntervals,
      waveform,
      candidates
    },
    { backup: false }
  );
  emitStage(context, "candidate_review", 75, "Candidates are ready for human review.");
  return {
    type: "awaiting_review",
    candidates,
    warnings,
    metadata: { duration: metadata.duration, width: metadata.width, height: metadata.height, hasAudio: metadata.hasAudio },
    preparation: { scenes, waveform, silences, unusableIntervals }
  };
}

async function renderJob(job, context, binaries) {
  const metadataPath = path.join(job.tempPath, "metadata.json");
  const analysisPath = path.join(job.tempPath, "analysis.json");
  if (!fs.existsSync(metadataPath) || !fs.existsSync(analysisPath)) {
    throw new AppError("DURABLE_ARTIFACT_MISSING", "Validated analysis artifacts are missing. Retry analysis before rendering.");
  }
  // Guarded the way analyzeJob already guards its own cached read. A truncated
  // file -- power loss mid-write, or a temp folder inside a directory the user
  // can move -- otherwise threw a raw SyntaxError that surfaced as a generic
  // retryable failure, and every retry hit the same read again.
  let metadata;
  let analysis;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
  } catch {
    throw new AppError("DURABLE_ARTIFACT_MISSING", "Validated analysis artifacts are unreadable. Retry analysis before rendering.");
  }
  const publicCandidates = Array.isArray(job.candidates) && job.candidates.length ? job.candidates : analysis.candidates;
  const selected = job.selectedCandidateIds.map((id) => publicCandidates.find((candidate) => candidate.id === id));
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
    const storedCandidate = selected[index];
    const edit = storedCandidate.edit || {};
    const candidate = {
      ...storedCandidate,
      ...edit,
      duration: Number((Number(edit.end ?? storedCandidate.end) - Number(edit.start ?? storedCandidate.start)).toFixed(3))
    };
    const candidateSettings = {
      ...job.settings,
      ...edit,
      sourceWidth: metadata.width,
      sourceHeight: metadata.height
    };
    const ordinal = String(index + 1).padStart(2, "0");
    const baseName = `clip-${ordinal}-${safeOutputName(candidate.title, `clip-${ordinal}`)}`;
    const finalVideoPath = path.join(job.outputPath, `${baseName}.mp4`);
    const partialVideoPath = path.join(job.tempPath, `${baseName}.partial.mp4`);
    const knownArtifact = isKnownArtifact(finalVideoPath);
    if (fs.existsSync(finalVideoPath) && !knownArtifact) {
      throw new AppError("OUTPUT_COLLISION", "A generated clip filename already exists. ProduDash will not overwrite it.");
    }
    let captionPath = "";
    const introDuration = Number(candidateSettings.assetSnapshots?.[candidateSettings.composition?.introAssetId]?.duration || 0);
    let burnedCaptionPath = "";
    if (job.settings.captionMode !== "off") {
      emitStage(context, "captions", 76 + Math.round((index / selected.length) * 12), `Preparing captions for clip ${index + 1}.`);
      captionPath = path.join(job.outputPath, `${baseName}.srt`);
      if (fs.existsSync(captionPath) && !isKnownArtifact(captionPath)) {
        throw new AppError("OUTPUT_COLLISION", "A generated caption filename already exists. ProduDash will not overwrite it.");
      }
      const captionSegments = Array.isArray(edit.captionSegments) ? edit.captionSegments : [];
      const manualCaptionText = edit.manualCaptionText || job.settings.captionText;
      if (!captionSegments.length && !manualCaptionText) {
        throw new AppError("TIMED_CAPTIONS_UNAVAILABLE", "Timed captions require a transcript or an intentional manual caption fallback.");
      }
      if (!fs.existsSync(captionPath)) {
        writeCaptionFile(captionPath, candidate.duration, captionSegments.length ? captionSegments : manualCaptionText, introDuration);
      }
      if (job.settings.captionMode === "srt_burned" && introDuration > 0) {
        burnedCaptionPath = path.join(job.tempPath, `${baseName}.burned.srt`);
        writeCaptionFile(burnedCaptionPath, candidate.duration, captionSegments.length ? captionSegments : manualCaptionText);
      }
      recordArtifact({ kind: "caption", name: path.basename(captionPath), path: captionPath });
    }
    if (!fs.existsSync(finalVideoPath)) {
      const hasBookends = Boolean(candidateSettings.composition?.introAssetId || candidateSettings.composition?.outroAssetId);
      const coreVideoPath = hasBookends ? path.join(job.tempPath, `${baseName}.core.mp4`) : partialVideoPath;
      await fs.promises.unlink(partialVideoPath).catch(() => {});
      await fs.promises.unlink(coreVideoPath).catch(() => {});
      const subtitlePath = job.settings.captionMode === "srt_burned" ? burnedCaptionPath || captionPath : "";
      emitStage(context, "rendering", 78, `Rendering clip ${index + 1} of ${selected.length}.`);
      const args = buildRenderArgs({
        sourcePath: job.sourcePath,
        outputPath: coreVideoPath,
        candidate,
        settings: candidateSettings,
        hasAudio: metadata.hasAudio,
        subtitlePath,
        assetPaths: job.assetPaths || {}
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
      if (hasBookends) {
        emitStage(context, "rendering", 91, "Attaching approved intro and outro assets.");
        await combineBookends({
          corePath: coreVideoPath,
          finalPath: partialVideoPath,
          candidate,
          settings: candidateSettings,
          assetPaths: job.assetPaths || {},
          context,
          binaries,
          metadata
        });
      }
      await inspectRenderedClip(partialVideoPath, binaries.ffprobePath, context);
      await fs.promises.rename(partialVideoPath, finalVideoPath);
    }
    recordArtifact({ kind: "video", name: path.basename(finalVideoPath), path: finalVideoPath });

    emitStage(context, "thumbnails", 93, `Creating thumbnail variants ${index + 1} of ${selected.length}.`);
    const thumbnailVariants = [
      { suffix: "thumbnail", ratio: 0.2 },
      { suffix: "thumbnail-middle", ratio: 0.5 },
      { suffix: "thumbnail-late", ratio: 0.8 }
    ];
    for (const variant of thumbnailVariants) {
      const thumbnailPath = path.join(job.outputPath, `${baseName}-${variant.suffix}.jpg`);
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
            Math.max(0, Math.min(candidate.duration - 0.04, candidate.duration * variant.ratio)).toFixed(3),
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
          { errorCode: "THUMBNAIL_FAILED", errorMessage: "A rendered clip thumbnail variant could not be created." }
        );
      }
      recordArtifact({
        kind: "thumbnail",
        name: path.basename(thumbnailPath),
        path: thumbnailPath,
        variant: { source: "local_render", positionRatio: variant.ratio }
      });
    }
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
      fingerprint: metadata.fingerprint,
      width: metadata.width,
      height: metadata.height
    },
    settings: {
      maxClips: job.settings.maxClips,
      targetDuration: job.settings.targetDuration,
      captionMode: job.settings.captionMode,
      aspectTreatment: job.settings.aspectTreatment,
      targetAspect: job.settings.targetAspect,
      enhancement: enhancementSummary(job.settings, metadata),
      platforms: job.settings.platforms,
      analysisMode: job.settings.analysisMode || "local_heuristics"
    },
    startedAt,
    completedAt: new Date().toISOString(),
    files: artifacts.map((artifact) => ({ kind: artifact.kind, filename: artifact.name })),
    thumbnailVariants: artifacts
      .filter((artifact) => artifact.kind === "thumbnail")
      .map((artifact) => ({
        filename: artifact.name,
        source: "local_render",
        positionRatio: artifact.variant?.positionRatio ?? null
      })),
    analysis: {
      provider: analysis.provider?.profileId || "local_heuristics",
      model: analysis.provider?.modelId || "deterministic-v1",
      mode: analysis.analysisMode || "local_heuristics",
      candidates: selected.map((candidate) => ({
        id: candidate.id,
        original: candidate.original || { title: candidate.title, start: candidate.start, end: candidate.end },
        approved: {
          title: candidate.edit?.title || candidate.title,
          start: candidate.edit?.start ?? candidate.start,
          end: candidate.edit?.end ?? candidate.end,
          captionStyle: candidate.edit?.captionStyle || "clean",
          captionPosition: candidate.edit?.captionPosition || "lower",
          captionSafeArea: candidate.edit?.captionSafeArea || "standard",
          captionCueCount: Array.isArray(candidate.edit?.captionSegments) ? candidate.edit.captionSegments.length : 0,
          aspectTreatment: candidate.edit?.aspectTreatment || job.settings.aspectTreatment,
          targetAspect: candidate.edit?.targetAspect || job.settings.targetAspect,
          enhancement: enhancementSummary({ ...job.settings, ...(candidate.edit || {}) }, metadata),
          template: candidate.edit?.templateRef
            ? {
                id: candidate.edit.templateRef.id,
                version: candidate.edit.templateRef.version,
                hash: candidate.edit.templateRef.hash
              }
            : null,
          composition: candidate.edit?.composition
            ? {
                transition: candidate.edit.composition.transition,
                transitionDuration: candidate.edit.composition.transitionDuration,
                overlayCount: Array.isArray(candidate.edit.composition.overlays) ? candidate.edit.composition.overlays.length : 0,
                hasMusic: Boolean(candidate.edit.composition.music),
                hasIntro: Boolean(candidate.edit.composition.introAssetId),
                hasOutro: Boolean(candidate.edit.composition.outroAssetId)
              }
            : null,
          languageVariant: candidate.edit?.languageVariant
            ? {
                id: candidate.edit.languageVariant.id,
                language: candidate.edit.languageVariant.language,
                label: candidate.edit.languageVariant.label,
                provenance: candidate.edit.languageVariant.provenance
              }
            : null,
          voiceovers: Array.isArray(candidate.edit?.voiceovers)
            ? candidate.edit.voiceovers
                .filter((voiceover) => voiceover.status === "reviewed")
                .map((voiceover) => ({
                  id: voiceover.id,
                  sourceId: voiceover.sourceId,
                  start: voiceover.start,
                  end: voiceover.end,
                  originalAudio: voiceover.originalAudio,
                  volume: voiceover.volume,
                  providerProfileId: voiceover.provenance.providerProfileId,
                  modelId: voiceover.provenance.modelId,
                  voice: voiceover.provenance.voice,
                  voiceType: voiceover.provenance.voiceType === "custom" ? "custom" : "built_in",
                  aiGenerated: true,
                  disclosure:
                    voiceover.provenance.voiceType === "custom"
                      ? "Synthetic voice likeness; not the original speaker recording."
                      : "AI-generated voice; not a human recording."
                }))
            : [],
          segments: Array.isArray(candidate.edit?.segments)
            ? candidate.edit.segments.map((segment) => ({
                id: segment.id,
                sourceStart: segment.sourceStart,
                sourceEnd: segment.sourceEnd,
                timelineStart: segment.timelineStart,
                duration: segment.duration
              }))
            : undefined
        },
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
  buildProjectRenderArgs,
  createContext,
  generateCandidates,
  parseProgressBlock,
  runMediaTask,
  safeOutputName,
  waveformPeaks,
  writeCaptionFile
};
