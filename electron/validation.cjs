const { AppError } = require("./errors.cjs");

const CREATOR_PLATFORM_IDS = new Set(["tiktok", "instagram", "youtube"]);
const INTEGRATION_IDS = new Set(["shopify", "instagram", "facebook", "tiktok", "youtube", "stripe"]);
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const CAPTION_MODES = new Set(["off", "srt", "srt_burned"]);
const ASPECT_TREATMENTS = new Set(["original", "fit_pad", "center_crop"]);
const TARGET_ASPECTS = new Set(["original", "vertical", "square", "landscape"]);
const ANALYSIS_MODES = new Set(["local_heuristics", "transcript_only", "transcript_frames", "native_video"]);
const CAPTION_STYLES = new Set(["clean", "contrast", "notebook"]);
const CAPTION_POSITIONS = new Set(["lower", "middle", "upper"]);
const CAPTION_SAFE_AREAS = new Set(["standard", "social"]);

function requireId(value, label = "Identifier") {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  }
  return value;
}

function requireKnownIntegration(value) {
  const id = requireId(value, "Integration");
  if (!INTEGRATION_IDS.has(id)) throw new AppError("INVALID_INPUT", "Unknown integration.");
  return id;
}

function boundedString(value, { label, min = 0, max, fallback = "" }) {
  if (value === undefined || value === null) value = fallback;
  if (typeof value !== "string") throw new AppError("INVALID_INPUT", `${label} must be text.`);
  const result = value.trim();
  if (result.length < min || result.length > max) {
    throw new AppError("INVALID_INPUT", `${label} must be between ${min} and ${max} characters.`);
  }
  return result;
}

function normalizePlatforms(value) {
  if (!Array.isArray(value)) throw new AppError("INVALID_INPUT", "Destinations must be a list.");
  const platforms = [...new Set(value)];
  if (platforms.length > CREATOR_PLATFORM_IDS.size || platforms.some((item) => !CREATOR_PLATFORM_IDS.has(item))) {
    throw new AppError("INVALID_INPUT", "One or more destinations are unsupported.");
  }
  return platforms;
}

function normalizeOptionalIsoDate(value) {
  const text = boundedString(value, { label: "Schedule", max: 40 });
  if (!text) return "";
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new AppError("INVALID_INPUT", "Schedule must be a valid date and time.");
  return new Date(timestamp).toISOString();
}

function normalizeTimeZone(value, required = false) {
  const timeZone = boundedString(value, { label: "Time zone", max: 80, fallback: "UTC" });
  if (!timeZone && required) throw new AppError("INVALID_INPUT", "Choose a time zone for the planned schedule.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "UTC" }).format(new Date(0));
  } catch {
    throw new AppError("INVALID_INPUT", "The planned schedule time zone is invalid.");
  }
  return timeZone || "UTC";
}

function normalizeShopifyDomain(value) {
  const raw = boundedString(value, { label: "Shopify store domain", min: 1, max: 253 }).toLowerCase();
  let parsed;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new AppError("INVALID_SHOPIFY_DOMAIN", "Enter a valid Shopify store domain.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(parsed.hostname)
  ) {
    throw new AppError("INVALID_SHOPIFY_DOMAIN", "Use the store’s canonical name.myshopify.com domain.");
  }
  return parsed.hostname;
}

function validateClipPayload(payload) {
  return {
    title: boundedString(payload?.title, { label: "Clip title", min: 1, max: 120, fallback: "Untitled clip job" }),
    source: boundedString(payload?.source, { label: "Source", min: 1, max: 2048 }),
    goal: boundedString(payload?.goal, { label: "Clip goal", max: 500 }),
    targetLength: boundedString(payload?.targetLength, {
      label: "Target length",
      min: 1,
      max: 80,
      fallback: "30-45 seconds"
    }),
    platforms: normalizePlatforms(payload?.platforms || [])
  };
}

function validatePostPayload(payload, clipJobs, mediaJobs = []) {
  const clipJobId = payload?.clipJobId ? requireId(payload.clipJobId, "Clip job") : null;
  if (clipJobId && !clipJobs.some((job) => job.id === clipJobId)) {
    throw new AppError("CLIP_JOB_NOT_FOUND", "The selected clip job no longer exists.");
  }
  const mediaJobId = payload?.mediaJobId ? requireId(payload.mediaJobId, "Media job") : null;
  if (clipJobId && mediaJobId) throw new AppError("INVALID_INPUT", "Choose one rendered clip or one legacy clip plan.");
  const mediaJob = mediaJobId ? mediaJobs.find((job) => job.id === mediaJobId) : null;
  if (
    mediaJobId &&
    (!mediaJob ||
      mediaJob.status !== "completed" ||
      !Array.isArray(mediaJob.artifacts) ||
      !mediaJob.artifacts.some((artifact) => artifact.kind === "video"))
  ) {
    throw new AppError("MEDIA_JOB_NOT_READY", "Choose a completed media job with a rendered video.");
  }
  const title = boundedString(payload?.title, { label: "Post title", min: 1, max: 120, fallback: "Untitled post plan" });
  const caption = boundedString(payload?.caption, { label: "Caption", max: 2200 });
  const scheduledFor = normalizeOptionalIsoDate(payload?.scheduledFor);
  const platforms = normalizePlatforms(payload?.platforms || []);
  const timeZone = normalizeTimeZone(payload?.timeZone, Boolean(scheduledFor));
  return {
    clipJobId,
    mediaJobId,
    title,
    caption,
    scheduledFor,
    timeZone,
    platforms,
    platformPackages: platforms.map((platformId) => ({ platformId, title, caption }))
  };
}

function validatePostPlanDraft(payload, platformIds) {
  const platforms = normalizePlatforms(platformIds);
  if (!Array.isArray(payload?.platformPackages) || payload.platformPackages.length !== platforms.length) {
    throw new AppError("INVALID_INPUT", "Include one copy draft for every selected destination.");
  }
  const submitted = new Map();
  for (const item of payload.platformPackages) {
    const platformId = boundedString(item?.platformId, { label: "Destination", min: 1, max: 40 });
    if (!platforms.includes(platformId) || submitted.has(platformId)) {
      throw new AppError("INVALID_INPUT", "Destination copy contains an unsupported or duplicate destination.");
    }
    submitted.set(platformId, {
      platformId,
      title: boundedString(item?.title, { label: `${platformId} title`, min: 1, max: 120 }),
      caption: boundedString(item?.caption, { label: `${platformId} caption`, max: 2200 })
    });
  }
  const scheduledFor = normalizeOptionalIsoDate(payload?.scheduledFor);
  const timeZone = normalizeTimeZone(payload?.timeZone, Boolean(scheduledFor));
  return {
    platformPackages: platforms.map((platformId) => submitted.get(platformId)),
    scheduledFor,
    timeZone,
    schedule: {
      mode: scheduledFor ? "planned_local_only" : "unscheduled",
      scheduledFor: scheduledFor || null,
      timeZone: scheduledFor ? timeZone : null
    }
  };
}

function boundedInteger(value, { label, min, max, fallback }) {
  const number = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AppError("INVALID_INPUT", `${label} must be a whole number between ${min} and ${max}.`);
  }
  return number;
}

function validateMediaJobPayload(payload) {
  const captionMode = String(payload?.captionMode || "off");
  const aspectTreatment = String(payload?.aspectTreatment || "fit_pad");
  const targetAspect = String(payload?.targetAspect || "original");
  const analysisMode = String(payload?.analysisMode || "local_heuristics");
  if (!CAPTION_MODES.has(captionMode)) throw new AppError("INVALID_INPUT", "Caption mode is invalid.");
  if (!ASPECT_TREATMENTS.has(aspectTreatment)) throw new AppError("INVALID_INPUT", "Aspect treatment is invalid.");
  if (!TARGET_ASPECTS.has(targetAspect)) throw new AppError("INVALID_INPUT", "Target aspect is invalid.");
  if (!ANALYSIS_MODES.has(analysisMode)) throw new AppError("INVALID_ANALYSIS_MODE", "The selected media analysis mode is invalid.");
  const captionText = boundedString(payload?.captionText, { label: "Caption text", max: 2000 });
  let cloudConsent = null;
  if (analysisMode !== "local_heuristics") {
    const consent = payload?.cloudConsent;
    if (consent?.confirmed !== true || !Array.isArray(consent?.dataCategories) || consent.dataCategories.length > 4) {
      throw new AppError("CLOUD_MEDIA_CONSENT_REQUIRED", "Confirm the cloud media disclosure for this individual job.");
    }
    cloudConsent = {
      confirmed: true,
      providerId: requireId(consent.providerId, "Analysis provider"),
      modelId: boundedString(consent.modelId, { label: "Analysis model", min: 1, max: 200 }),
      transcriptionProviderId: consent.transcriptionProviderId
        ? requireId(consent.transcriptionProviderId, "Transcription provider")
        : null,
      transcriptionModelId: consent.transcriptionModelId
        ? boundedString(consent.transcriptionModelId, { label: "Transcription model", min: 1, max: 200 })
        : null,
      dataCategories: [...new Set(consent.dataCategories.map((item) => boundedString(item, { label: "Data category", min: 1, max: 40 })))]
    };
  }
  return {
    sourceMediaId: requireId(payload?.sourceMediaId, "Source media"),
    outputSelectionId: requireId(payload?.outputSelectionId, "Output folder selection"),
    title: boundedString(payload?.title, { label: "Media job title", min: 1, max: 120, fallback: "Untitled media job" }),
    goal: boundedString(payload?.goal, { label: "Clip goal", max: 500 }),
    maxClips: boundedInteger(payload?.maxClips, { label: "Clip count", min: 1, max: 20, fallback: 3 }),
    targetDuration: boundedInteger(payload?.targetDuration, {
      label: "Target duration",
      min: 5,
      max: 180,
      fallback: 30
    }),
    captionMode,
    captionText,
    aspectTreatment,
    targetAspect,
    analysisMode,
    cloudConsent,
    platforms: normalizePlatforms(payload?.platforms || [])
  };
}

function validateCandidateSelection(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20) {
    throw new AppError("INVALID_INPUT", "Select between 1 and 20 clip candidates.");
  }
  return [...new Set(value.map((candidateId) => requireId(candidateId, "Clip candidate")))];
}

function finiteCandidateTime(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new AppError("INVALID_CANDIDATE_EDIT", `${label} must be a finite timestamp.`);
  return Number(number.toFixed(3));
}

function validateCaptionSegments(value, duration) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) {
    throw new AppError("INVALID_CANDIDATE_EDIT", "Caption edits must contain at most 100 timed segments.");
  }
  let previousEnd = 0;
  return value.map((segment, index) => {
    const start = finiteCandidateTime(segment?.start, `Caption ${index + 1} start`);
    const end = finiteCandidateTime(segment?.end, `Caption ${index + 1} end`);
    if (start < previousEnd || end <= start || start < 0 || end > duration) {
      throw new AppError("INVALID_CANDIDATE_EDIT", "Caption timings must be ordered, positive, and remain inside the edited clip.");
    }
    previousEnd = end;
    return {
      id: segment?.id ? requireId(segment.id, "Caption segment") : `caption-${index + 1}`,
      start,
      end,
      text: boundedString(segment?.text, { label: `Caption ${index + 1}`, min: 1, max: 240 })
    };
  });
}

function validateCandidateEdits(value, { sourceDuration, candidates = [], candidateId }) {
  const duration = Number(sourceDuration);
  if (!Number.isFinite(duration) || duration < 5) {
    throw new AppError("INVALID_CANDIDATE_EDIT", "Source duration is unavailable for candidate editing.");
  }
  const start = finiteCandidateTime(value?.start, "Clip start");
  const end = finiteCandidateTime(value?.end, "Clip end");
  const clipDuration = Number((end - start).toFixed(3));
  if (start < 0 || end > duration || clipDuration < 5 || clipDuration > 180) {
    throw new AppError("INVALID_CANDIDATE_EDIT", "Edited clips must stay within the source and be between 5 and 180 seconds.");
  }
  for (const other of candidates) {
    if (!other || other.id === candidateId) continue;
    const otherStart = Number(other.edit?.start ?? other.start);
    const otherEnd = Number(other.edit?.end ?? other.end);
    if (!Number.isFinite(otherStart) || !Number.isFinite(otherEnd)) continue;
    const overlap = Math.max(0, Math.min(end, otherEnd) - Math.max(start, otherStart));
    const shorter = Math.min(clipDuration, otherEnd - otherStart);
    if (shorter > 0 && overlap / shorter > 0.2) {
      throw new AppError("CANDIDATE_OVERLAP", "Edited candidates cannot overlap by more than 20% of the shorter clip.");
    }
  }
  const captionStyle = String(value?.captionStyle || "clean");
  const captionPosition = String(value?.captionPosition || "lower");
  const captionSafeArea = String(value?.captionSafeArea || "standard");
  const aspectTreatment = String(value?.aspectTreatment || "fit_pad");
  const targetAspect = String(value?.targetAspect || "original");
  if (!CAPTION_STYLES.has(captionStyle) || !CAPTION_POSITIONS.has(captionPosition) || !CAPTION_SAFE_AREAS.has(captionSafeArea)) {
    throw new AppError("INVALID_CANDIDATE_EDIT", "Caption presentation settings are invalid.");
  }
  if (!ASPECT_TREATMENTS.has(aspectTreatment) || !TARGET_ASPECTS.has(targetAspect)) {
    throw new AppError("INVALID_CANDIDATE_EDIT", "Clip presentation settings are invalid.");
  }
  return {
    title: boundedString(value?.title, { label: "Candidate title", min: 1, max: 120 }),
    start,
    end,
    duration: clipDuration,
    captionSegments: validateCaptionSegments(value?.captionSegments, clipDuration) || [],
    manualCaptionText: boundedString(value?.manualCaptionText, { label: "Manual caption fallback", max: 2000 }),
    captionStyle,
    captionPosition,
    captionSafeArea,
    aspectTreatment,
    targetAspect
  };
}

module.exports = {
  CREATOR_PLATFORM_IDS,
  INTEGRATION_IDS,
  boundedString,
  boundedInteger,
  normalizePlatforms,
  normalizeShopifyDomain,
  normalizeTimeZone,
  requireId,
  requireKnownIntegration,
  validateClipPayload,
  validateCandidateEdits,
  validateCandidateSelection,
  validateMediaJobPayload,
  validatePostPlanDraft,
  validatePostPayload
};
