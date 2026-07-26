const { AppError } = require("../errors.cjs");
const { boundedString } = require("../validation.cjs");

const BUILT_IN_VOICES = Object.freeze([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar"
]);

function validateSpeechConsent(value, { profileId, modelId, voice }) {
  const categories = Array.isArray(value?.dataCategories) ? value.dataCategories : [];
  if (
    value?.approved !== true ||
    value?.providerProfileId !== profileId ||
    value?.modelId !== modelId ||
    value?.voice !== voice ||
    value?.aiGeneratedDisclosureAccepted !== true ||
    categories.length !== 1 ||
    categories[0] !== "voiceover_text"
  ) {
    throw new AppError(
      "SPEECH_CONSENT_REQUIRED",
      "Confirm the provider, model, built-in voice, voiceover text, and AI-generated voice disclosure."
    );
  }
}

function normalizeSpeechRequest(value, options = {}) {
  const allowedCustomVoices = Array.isArray(options) ? options : options.allowedCustomVoices || [];
  const allowedBuiltInVoices = Array.isArray(options) ? BUILT_IN_VOICES : options.allowedBuiltInVoices || [];
  const voice = boundedString(value?.voice, { label: "Voice", min: 1, max: 200 });
  if (!allowedBuiltInVoices.includes(voice) && !allowedCustomVoices.includes(voice)) {
    throw new AppError("CUSTOM_VOICE_UNAVAILABLE", "The selected voice is not authorized for this provider in ProduDash.");
  }
  return {
    voice,
    voiceType: allowedCustomVoices.includes(voice) ? "custom" : "built_in",
    input: boundedString(value?.input, { label: "Voiceover text", min: 1, max: 4_096 }),
    instructions: boundedString(value?.instructions, { label: "Voice direction", max: 500 })
  };
}

module.exports = { BUILT_IN_VOICES, normalizeSpeechRequest, validateSpeechConsent };
