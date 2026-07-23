const { AppError } = require("../errors.cjs");
const { ANALYSIS_MODES } = require("./analysis-contract.cjs");

const CLOUD_DATA_CATEGORIES = new Set(["audio", "transcript", "frames", "complete_video"]);

function requiredCategories(mode, cloudTranscription = false) {
  if (mode === ANALYSIS_MODES.NATIVE_VIDEO) return ["complete_video"];
  if (mode === ANALYSIS_MODES.TRANSCRIPT_FRAMES) return [...(cloudTranscription ? ["audio"] : []), "transcript", "frames"];
  if (mode === ANALYSIS_MODES.TRANSCRIPT_ONLY) return [...(cloudTranscription ? ["audio"] : []), "transcript"];
  return [];
}

function validateCloudMediaConsent(consent, { mode, providerId, modelId, cloudTranscription = false }) {
  if (mode === ANALYSIS_MODES.LOCAL_HEURISTICS) return null;
  const categories = Array.isArray(consent?.dataCategories) ? [...new Set(consent.dataCategories)] : [];
  if (
    consent?.confirmed !== true ||
    consent?.providerId !== providerId ||
    consent?.modelId !== modelId ||
    categories.some((category) => !CLOUD_DATA_CATEGORIES.has(category))
  ) {
    throw new AppError(
      "CLOUD_MEDIA_CONSENT_REQUIRED",
      "Confirm the selected provider, model, and media categories for this cloud media job."
    );
  }
  const required = requiredCategories(mode, cloudTranscription);
  if (required.some((category) => !categories.includes(category))) {
    throw new AppError("CLOUD_MEDIA_CONSENT_REQUIRED", "Cloud media consent is missing a required data category.");
  }
  return { confirmed: true, providerId, modelId, dataCategories: categories.sort() };
}

module.exports = { CLOUD_DATA_CATEGORIES, requiredCategories, validateCloudMediaConsent };
