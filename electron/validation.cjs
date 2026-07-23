const { AppError } = require("./errors.cjs");

const CREATOR_PLATFORM_IDS = new Set(["tiktok", "instagram", "youtube"]);
const INTEGRATION_IDS = new Set(["shopify", "instagram", "facebook", "tiktok", "youtube", "stripe"]);
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

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

function validatePostPayload(payload, clipJobs) {
  const clipJobId = payload?.clipJobId ? requireId(payload.clipJobId, "Clip job") : null;
  if (clipJobId && !clipJobs.some((job) => job.id === clipJobId)) {
    throw new AppError("CLIP_JOB_NOT_FOUND", "The selected clip job no longer exists.");
  }
  return {
    clipJobId,
    title: boundedString(payload?.title, { label: "Post title", min: 1, max: 120, fallback: "Untitled post plan" }),
    caption: boundedString(payload?.caption, { label: "Caption", max: 2200 }),
    scheduledFor: normalizeOptionalIsoDate(payload?.scheduledFor),
    platforms: normalizePlatforms(payload?.platforms || [])
  };
}

module.exports = {
  CREATOR_PLATFORM_IDS,
  INTEGRATION_IDS,
  boundedString,
  normalizePlatforms,
  normalizeShopifyDomain,
  requireId,
  requireKnownIntegration,
  validateClipPayload,
  validatePostPayload
};
