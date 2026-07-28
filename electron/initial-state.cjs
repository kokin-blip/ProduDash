const {
  buildAnalyticsSourceCatalog,
  buildCreatorPlatformCatalog,
  buildCredentialSettingsCatalog,
  buildIntegrationCatalog
} = require("./platforms/registry.cjs");
const { CURRENT_SCHEMA_VERSION } = require("./schema-version.cjs");

function createInitialState() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    selectedBusinessId: null,
    selectedConversationId: null,
    integrations: buildIntegrationCatalog(),
    credentialSettings: buildCredentialSettingsCatalog(),
    aiProviders: [
      {
        id: "gemini",
        providerType: "gemini",
        name: "Google Gemini",
        status: "disconnected",
        credentialStatus: "missing",
        selectedModelId: "gemini-3.6-flash",
        models: [
          {
            id: "gemini-3.6-flash",
            name: "Gemini 3.6 Flash",
            capabilities: [
              "text_generation",
              "streaming",
              "structured_output",
              "tool_calling",
              "image_understanding",
              "native_video_understanding"
            ]
          }
        ],
        lastValidatedAt: null,
        error: null
      },
      {
        id: "openai",
        providerType: "openai",
        name: "OpenAI",
        status: "disconnected",
        credentialStatus: "missing",
        selectedModelId: "gpt-5.6-terra",
        models: [
          {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            capabilities: ["text_generation", "streaming", "structured_output", "tool_calling", "image_understanding"]
          },
          {
            id: "gpt-5.6-terra",
            name: "GPT-5.6 Terra",
            capabilities: ["text_generation", "streaming", "structured_output", "tool_calling", "image_understanding"]
          },
          {
            id: "gpt-5.6-luna",
            name: "GPT-5.6 Luna",
            capabilities: ["text_generation", "streaming", "structured_output", "tool_calling", "image_understanding"]
          },
          {
            id: "whisper-1",
            name: "Whisper 1 (timestamped transcription)",
            capabilities: ["audio_transcription"]
          }
        ],
        lastValidatedAt: null,
        error: null
      },
      {
        id: "anthropic",
        providerType: "anthropic",
        name: "Anthropic Claude",
        status: "disconnected",
        credentialStatus: "missing",
        selectedModelId: "claude-sonnet-5",
        models: [
          {
            id: "claude-sonnet-5",
            name: "Claude Sonnet 5",
            capabilities: ["text_generation", "streaming", "structured_output", "tool_calling", "image_understanding"]
          }
        ],
        lastValidatedAt: null,
        error: null
      },
      {
        id: "elevenlabs",
        providerType: "elevenlabs",
        name: "ElevenLabs",
        status: "disconnected",
        credentialStatus: "missing",
        selectedModelId: "eleven_multilingual_v2",
        models: [
          {
            id: "eleven_multilingual_v2",
            name: "Eleven Multilingual v2",
            capabilities: ["speech_generation"]
          }
        ],
        lastValidatedAt: null,
        error: null
      },
      {
        id: "openai-compatible",
        providerType: "openai-compatible",
        name: "OpenAI-compatible endpoint",
        status: "disconnected",
        credentialStatus: "missing",
        selectedModelId: null,
        models: [],
        publicValues: {},
        lastValidatedAt: null,
        error: null
      },
      {
        id: "whisper-cpp",
        providerType: "whisper-cpp",
        name: "Local whisper.cpp",
        status: "disconnected",
        credentialStatus: "missing",
        selectedModelId: "local-whisper",
        models: [
          {
            id: "local-whisper",
            name: "Local whisper.cpp",
            capabilities: ["audio_transcription"]
          }
        ],
        lastValidatedAt: null,
        error: null
      },
      {
        id: "piper-local",
        providerType: "piper-local",
        name: "Local Piper",
        status: "disconnected",
        credentialStatus: "missing",
        selectedModelId: "piper-local-model",
        models: [
          {
            id: "piper-local-model",
            name: "Configured Piper voice model",
            capabilities: ["speech_generation"]
          }
        ],
        lastValidatedAt: null,
        error: null
      },
      {
        id: "kokoro-local",
        providerType: "kokoro-local",
        name: "Local Kokoro CLI",
        status: "disconnected",
        credentialStatus: "missing",
        selectedModelId: "kokoro-local-model",
        models: [
          {
            id: "kokoro-local-model",
            name: "Configured Kokoro voice",
            capabilities: ["speech_generation"]
          }
        ],
        publicValues: { voiceId: "af_heart" },
        lastValidatedAt: null,
        error: null
      },
      {
        id: "rvc-local",
        providerType: "rvc-local",
        name: "Local RVC",
        status: "disconnected",
        credentialStatus: "missing",
        selectedModelId: "rvc-local-model",
        models: [
          {
            id: "rvc-local-model",
            name: "Configured RVC voice model",
            capabilities: ["voice_conversion"]
          }
        ],
        lastValidatedAt: null,
        error: null
      },
      {
        id: "xtts-local",
        providerType: "xtts-local",
        name: "Local XTTS",
        status: "disconnected",
        credentialStatus: "missing",
        selectedModelId: "xtts-local-model",
        models: [
          {
            id: "xtts-local-model",
            name: "Configured local XTTS model",
            capabilities: ["speech_generation"]
          }
        ],
        publicValues: { language: "en" },
        lastValidatedAt: null,
        error: null
      },
      {
        id: "chatterbox-local",
        providerType: "chatterbox-local",
        name: "Local Chatterbox",
        status: "disconnected",
        credentialStatus: "missing",
        selectedModelId: "chatterbox-local-model",
        models: [
          {
            id: "chatterbox-local-model",
            name: "Configured local Chatterbox model",
            capabilities: ["speech_generation"]
          }
        ],
        publicValues: { variant: "nano", language: "en", device: "cpu" },
        lastValidatedAt: null,
        error: null
      },
      {
        id: "tortoise-local",
        providerType: "tortoise-local",
        name: "Local Tortoise TTS",
        status: "disconnected",
        credentialStatus: "missing",
        selectedModelId: "tortoise-local-model",
        models: [
          {
            id: "tortoise-local-model",
            name: "Configured local Tortoise TTS model",
            capabilities: ["speech_generation"]
          }
        ],
        publicValues: { preset: "fast" },
        lastValidatedAt: null,
        error: null
      }
    ],
    aiWorkloads: {
      advisor: {
        mode: "provider",
        profileId: "gemini",
        modelId: "gemini-3.6-flash"
      },
      inboxDrafting: {
        mode: "provider",
        profileId: "gemini",
        modelId: "gemini-3.6-flash"
      },
      clipAnalysis: {
        mode: "same_as_advisor"
      },
      transcription: {
        mode: "unassigned"
      }
    },
    advisorSettings: {
      displayName: "Juanito"
    },
    voiceLikeness: {
      acceptance: null,
      voices: []
    },
    creatorPlatforms: buildCreatorPlatformCatalog(),
    mediaJobs: [],
    clipperJobs: [],
    postQueue: [],
    analyticsSources: buildAnalyticsSourceCatalog(),
    businesses: [],
    conversations: [],
    approvals: [],
    auditLog: [
      {
        id: "audit-initial-state",
        at: new Date().toISOString(),
        type: "system",
        detail: "ProduDash is waiting for official account connections. Demo business data is disabled."
      }
    ]
  };
}

module.exports = { createInitialState };
