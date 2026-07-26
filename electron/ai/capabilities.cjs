const AI_CAPABILITIES = Object.freeze({
  TEXT_GENERATION: "text_generation",
  STREAMING: "streaming",
  STRUCTURED_OUTPUT: "structured_output",
  TOOL_CALLING: "tool_calling",
  IMAGE_UNDERSTANDING: "image_understanding",
  NATIVE_VIDEO_UNDERSTANDING: "native_video_understanding",
  AUDIO_TRANSCRIPTION: "audio_transcription",
  SPEECH_GENERATION: "speech_generation",
  EMBEDDINGS: "embeddings"
});

const AI_WORKLOADS = Object.freeze({
  ADVISOR: "advisor",
  INBOX_DRAFTING: "inboxDrafting",
  CLIP_ANALYSIS: "clipAnalysis",
  TRANSCRIPTION: "transcription"
});

const WORKLOAD_REQUIREMENTS = Object.freeze({
  [AI_WORKLOADS.ADVISOR]: [AI_CAPABILITIES.TEXT_GENERATION, AI_CAPABILITIES.TOOL_CALLING],
  [AI_WORKLOADS.INBOX_DRAFTING]: [AI_CAPABILITIES.TEXT_GENERATION, AI_CAPABILITIES.STRUCTURED_OUTPUT],
  [AI_WORKLOADS.CLIP_ANALYSIS]: [AI_CAPABILITIES.TEXT_GENERATION, AI_CAPABILITIES.STRUCTURED_OUTPUT],
  [AI_WORKLOADS.TRANSCRIPTION]: [AI_CAPABILITIES.AUDIO_TRANSCRIPTION]
});

function hasCapabilities(model, required) {
  const available = new Set(Array.isArray(model?.capabilities) ? model.capabilities : []);
  return required.every((capability) => available.has(capability));
}

module.exports = { AI_CAPABILITIES, AI_WORKLOADS, WORKLOAD_REQUIREMENTS, hasCapabilities };
