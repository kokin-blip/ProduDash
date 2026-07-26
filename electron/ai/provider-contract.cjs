const { AppError } = require("../errors.cjs");
const { AI_CAPABILITIES, hasCapabilities } = require("./capabilities.cjs");

const CAPABILITY_METHODS = Object.freeze({
  [AI_CAPABILITIES.TEXT_GENERATION]: "generateText",
  [AI_CAPABILITIES.STREAMING]: "streamText",
  [AI_CAPABILITIES.STRUCTURED_OUTPUT]: "generateStructured",
  [AI_CAPABILITIES.TOOL_CALLING]: "generateWithTools",
  [AI_CAPABILITIES.IMAGE_UNDERSTANDING]: "analyzeImages",
  [AI_CAPABILITIES.NATIVE_VIDEO_UNDERSTANDING]: "analyzeVideo",
  [AI_CAPABILITIES.AUDIO_TRANSCRIPTION]: "transcribeAudio",
  [AI_CAPABILITIES.SPEECH_GENERATION]: "generateSpeech",
  [AI_CAPABILITIES.EMBEDDINGS]: "createEmbeddings"
});

function requireCapability(model, capability) {
  if (!Object.hasOwn(CAPABILITY_METHODS, capability) || !hasCapabilities(model, [capability])) {
    throw new AppError("CAPABILITY_UNSUPPORTED", "The selected AI model does not support this capability.");
  }
}

async function invokeCapability(adapter, model, capability, request) {
  requireCapability(model, capability);
  const method = CAPABILITY_METHODS[capability];
  if (typeof adapter?.[method] !== "function") {
    throw new AppError("CAPABILITY_UNSUPPORTED", "This provider adapter does not implement the requested capability.");
  }
  return adapter[method]({ ...request, modelId: model.id });
}

module.exports = { CAPABILITY_METHODS, invokeCapability, requireCapability };
