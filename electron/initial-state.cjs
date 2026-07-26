function createInitialState() {
  return {
    schemaVersion: 7,
    selectedBusinessId: null,
    selectedConversationId: null,
    integrations: [
      {
        id: "shopify",
        name: "Shopify",
        status: "disconnected",
        detail: "Connect with Shopify OAuth and approved Admin API scopes.",
        lastSync: "Not connected",
        allowedUse: "Read store metrics, products, orders, fulfillment, and payment status after merchant authorization.",
        compliance: "Use OAuth, verify HMAC callbacks, request minimum scopes, and receive changes through webhooks."
      },
      {
        id: "instagram",
        name: "Instagram",
        status: "disconnected",
        detail: "Use Meta's approved Instagram Messaging API after app review.",
        lastSync: "Not connected",
        allowedUse: "Read and reply to eligible business conversations through official APIs.",
        compliance: "Respect user-initiated messaging windows, opt-ins, rate limits, page/account roles, and policy review."
      },
      {
        id: "facebook",
        name: "Facebook",
        status: "disconnected",
        detail: "Use Meta Messenger Platform and Page permissions after app review.",
        lastSync: "Not connected",
        allowedUse: "Manage Page/Messenger conversations through approved scopes.",
        compliance: "No scraping, unsolicited messaging, spam, or browser automation."
      },
      {
        id: "tiktok",
        name: "TikTok",
        status: "disconnected",
        detail: "Use approved TikTok APIs for analytics, messaging, and content posting when available.",
        lastSync: "Not connected",
        allowedUse:
          "Manage eligible business messaging, reporting, and creator-approved video publishing through TikTok-approved API access.",
        compliance: "Use Content Posting API flows only. Do not automate private accounts or scrape TikTok surfaces."
      },
      {
        id: "youtube",
        name: "YouTube",
        status: "disconnected",
        detail: "Use Google OAuth, YouTube Data API uploads, and YouTube Analytics APIs.",
        lastSync: "Not connected",
        allowedUse: "Upload approved Shorts, read channel/video analytics, and reconcile publishing status after authorization.",
        compliance: "Respect Google API quotas, OAuth scopes, channel ownership, and user approval before uploads."
      },
      {
        id: "stripe",
        name: "Stripe",
        status: "planned",
        detail: "Use Stripe only for payment-link creation and payment verification after explicit setup.",
        lastSync: "Not connected",
        allowedUse: "Verify payment status before fulfillment.",
        compliance: "Do not store card data. Use hosted payment links and webhooks."
      }
    ],
    credentialSettings: [
      {
        id: "shopify",
        name: "Shopify",
        status: "missing",
        updatedAt: null,
        configuredFields: [],
        publicValues: {},
        note: "For a private/local setup, paste credentials from a Shopify custom app. Production app distribution should use OAuth.",
        fields: [
          {
            key: "storeDomain",
            label: "Store domain",
            type: "text",
            placeholder: "your-store.myshopify.com",
            sensitive: false
          },
          {
            key: "adminAccessToken",
            label: "Admin API access token",
            type: "password",
            placeholder: "shpat_...",
            sensitive: true
          }
        ]
      },
      {
        id: "instagram",
        name: "Instagram",
        status: "missing",
        updatedAt: null,
        configuredFields: [],
        publicValues: {},
        note: "Meta/Instagram messaging still requires approved apps, scopes, and platform review.",
        fields: [
          {
            key: "metaAppId",
            label: "Meta app ID",
            type: "text",
            placeholder: "123456789",
            sensitive: false
          },
          {
            key: "metaAppSecret",
            label: "Meta app secret",
            type: "password",
            placeholder: "App secret",
            sensitive: true
          }
        ]
      },
      {
        id: "facebook",
        name: "Facebook",
        status: "missing",
        updatedAt: null,
        configuredFields: [],
        publicValues: {},
        note: "Facebook Page/Messenger access must come through approved Meta permissions.",
        fields: [
          {
            key: "pageAccessToken",
            label: "Page access token",
            type: "password",
            placeholder: "EAAB...",
            sensitive: true
          }
        ]
      },
      {
        id: "tiktok",
        name: "TikTok",
        status: "missing",
        updatedAt: null,
        configuredFields: [],
        publicValues: {},
        note: "TikTok APIs require approved API access before ProduDash can use these credentials.",
        fields: [
          {
            key: "clientKey",
            label: "Client key",
            type: "text",
            placeholder: "TikTok client key",
            sensitive: false
          },
          {
            key: "clientSecret",
            label: "Client secret",
            type: "password",
            placeholder: "TikTok client secret",
            sensitive: true
          }
        ]
      },
      {
        id: "youtube",
        name: "YouTube",
        status: "missing",
        updatedAt: null,
        configuredFields: [],
        publicValues: {},
        note: "Use Google OAuth client credentials for YouTube uploads and analytics.",
        fields: [
          {
            key: "clientId",
            label: "OAuth client ID",
            type: "text",
            placeholder: "Google OAuth client ID",
            sensitive: false
          },
          {
            key: "clientSecret",
            label: "OAuth client secret",
            type: "password",
            placeholder: "Google OAuth client secret",
            sensitive: true
          }
        ]
      },
      {
        id: "stripe",
        name: "Stripe",
        status: "missing",
        updatedAt: null,
        configuredFields: [],
        publicValues: {},
        note: "Use Stripe keys only for hosted payment links and webhook verification. Never store card data.",
        fields: [
          {
            key: "secretKey",
            label: "Secret key",
            type: "password",
            placeholder: "sk_live_...",
            sensitive: true
          },
          {
            key: "webhookSecret",
            label: "Webhook signing secret",
            type: "password",
            placeholder: "whsec_...",
            sensitive: true
          }
        ]
      }
    ],
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
    creatorPlatforms: [
      {
        id: "tiktok",
        name: "TikTok",
        format: "9:16 short video",
        postingMode: "Content Posting API draft or direct post after approval",
        analyticsMode: "Official TikTok analytics/reporting access only",
        requirements: ["Approved TikTok developer app", "Creator authorization", "No scraping or emulator posting"]
      },
      {
        id: "instagram",
        name: "Instagram Reels",
        format: "9:16 reel video",
        postingMode: "Meta content publishing with REELS media containers",
        analyticsMode: "Meta Graph API insights for eligible business/creator accounts",
        requirements: ["Instagram professional account", "Approved Meta app scopes", "Publicly reachable video URL for publishing"]
      },
      {
        id: "youtube",
        name: "YouTube Shorts",
        format: "Vertical YouTube video",
        postingMode: "YouTube Data API upload after OAuth approval",
        analyticsMode: "YouTube Analytics or Reporting APIs",
        requirements: ["Google OAuth consent", "Upload quota available", "Channel authorization"]
      }
    ],
    mediaJobs: [],
    clipperJobs: [],
    postQueue: [],
    analyticsSources: [
      {
        id: "tiktok",
        name: "TikTok",
        status: "waiting_for_connection",
        metrics: ["views", "likes", "comments", "shares", "profile visits", "completion rate"],
        lastSync: "Not connected"
      },
      {
        id: "instagram",
        name: "Instagram Reels",
        status: "waiting_for_connection",
        metrics: ["plays", "reach", "likes", "comments", "shares", "saves"],
        lastSync: "Not connected"
      },
      {
        id: "youtube",
        name: "YouTube Shorts",
        status: "waiting_for_connection",
        metrics: ["views", "likes", "comments", "average view duration", "subscribers gained"],
        lastSync: "Not connected"
      }
    ],
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
