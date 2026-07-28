const { AppError } = require("../errors.cjs");
const { createAuthorizationRecord } = require("./authorization.cjs");

// One definition per platform. Everything that used to be a hard-coded list of
// platform ids, a `=== "shopify"` branch, or one of the four parallel catalogs in
// initial-state.cjs is derived from this file.
//
// Platform ids are load-bearing: `publishingApprovalSnapshot` (store.cjs) hashes
// them into every destination idempotency key, and state-schema.cjs recomputes
// those keys on load. Renaming an id invalidates every saved approval snapshot.

const NOT_CONNECTED = "Not connected";

// Capability flags replace behavior that used to be inferred from the id itself.
const DEFAULT_CAPABILITIES = Object.freeze({
  // Accepts credentials and has a real connector behind it. Everything else is
  // declared-but-unavailable rather than silently broken.
  hasLiveConnector: false,
  // Save-and-validate immediately attempts a live verification.
  autoVerifyOnSave: false,
  // Selectable as a publishing destination (drives creatorPlatforms).
  isPublishDestination: false,
  // Exposes creator performance metrics (drives analyticsSources).
  providesCreatorAnalytics: false,
  // Feeds the derived commerce analytics report.
  providesCommerceAnalytics: false,
  // Owns `businesses` records that cascade on disconnect.
  ownsBusinessRecords: false,
  // Gates the connection-first setup flow in the renderer.
  isSetupPrerequisite: false
});

const PLATFORMS = [
  {
    id: "shopify",
    displayName: "Shopify",
    kind: "commerce",
    defaultStatus: "disconnected",
    detail: "Connect with Shopify OAuth and approved Admin API scopes.",
    allowedUse: "Read store metrics, products, orders, fulfillment, and payment status after merchant authorization.",
    compliance: "Use OAuth, verify HMAC callbacks, request minimum scopes, and receive changes through webhooks.",
    authType: "custom_app_token",
    credentialNote: "For a private/local setup, paste credentials from a Shopify custom app. Production app distribution should use OAuth.",
    credentialFields: [
      { key: "storeDomain", label: "Store domain", type: "text", placeholder: "your-store.myshopify.com", sensitive: false },
      { key: "adminAccessToken", label: "Admin API access token", type: "password", placeholder: "shpat_...", sensitive: true }
    ],
    publicIdentifierField: "storeDomain",
    scopes: ["read_products", "read_orders"],
    capabilities: {
      hasLiveConnector: true,
      autoVerifyOnSave: true,
      providesCommerceAnalytics: true,
      ownsBusinessRecords: true,
      isSetupPrerequisite: true
    },
    dataWindow: { recordLimit: 100, windowNote: "Shopify exposes only the most recent 60 days of orders with read_orders." },
    reviewRequirement: null,
    requiresHostedCallback: false,
    docsUrl: "https://shopify.dev/docs/api/admin-graphql"
  },
  {
    id: "instagram",
    displayName: "Instagram",
    kind: "social",
    defaultStatus: "disconnected",
    detail: "Use Meta's approved Instagram Messaging API after app review.",
    allowedUse: "Read and reply to eligible business conversations through official APIs.",
    compliance: "Respect user-initiated messaging windows, opt-ins, rate limits, page/account roles, and policy review.",
    authType: "oauth2_meta",
    // Instagram supports two official authorization routes and ProduDash offers
    // both. They are NOT interchangeable: different authorization endpoints,
    // different API hosts, different scope vocabularies, different account
    // prerequisites, and different ways of resolving the Instagram user id.
    //
    // The user picks one at connect time; the choice is persisted and every
    // request derives its host, scopes, and id resolution from it. Blending them
    // -- requesting instagram_basic against Instagram Login, or calling
    // graph.facebook.com with a graph.instagram.com token -- is the documented
    // failure mode, so top-level `scopes` stays empty and each route owns its own.
    authRoutes: {
      instagram_login: {
        id: "instagram_login",
        label: "Instagram Login",
        summary: "Sign in with the Instagram professional account directly. No linked Facebook Page required.",
        scopes: ["instagram_business_basic", "instagram_business_content_publish"],
        requiresLinkedFacebookPage: false,
        accountTypes: ["business", "creator"],
        docsUrl: "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/"
      },
      facebook_login: {
        id: "facebook_login",
        label: "Facebook Login",
        summary: "Sign in with Facebook. Requires the Instagram account to be linked to a Facebook Page.",
        scopes: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "business_management"],
        requiresLinkedFacebookPage: true,
        accountTypes: ["business", "creator"],
        docsUrl: "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/"
      }
    },
    credentialNote: "Meta/Instagram messaging still requires approved apps, scopes, and platform review.",
    credentialFields: [
      { key: "metaAppId", label: "Meta app ID", type: "text", placeholder: "123456789", sensitive: false },
      { key: "metaAppSecret", label: "Meta app secret", type: "password", placeholder: "App secret", sensitive: true }
    ],
    scopes: [],
    capabilities: { isPublishDestination: true, providesCreatorAnalytics: true },
    creator: {
      // Creator surfaces order tiktok, instagram, youtube — independent of the
      // integrations catalog order, which is shopify-first.
      order: 1,
      displayName: "Instagram Reels",
      format: "9:16 reel video",
      postingMode: "Meta content publishing with REELS media containers",
      analyticsMode: "Meta Graph API insights for eligible business/creator accounts",
      requirements: ["Instagram professional account", "Approved Meta app scopes", "Publicly reachable video URL for publishing"],
      metrics: ["plays", "reach", "likes", "comments", "shares", "saves"]
    },
    mediaConstraints: { targetAspect: "vertical", captionSafeArea: "social" },
    reviewRequirement: "Meta app review and business verification are required before content publishing.",
    requiresHostedCallback: false,
    docsUrl: "https://developers.facebook.com/docs/instagram-platform/content-publishing/"
  },
  {
    id: "facebook",
    displayName: "Facebook",
    kind: "social",
    defaultStatus: "disconnected",
    detail: "Use Meta Messenger Platform and Page permissions after app review.",
    allowedUse: "Manage Page/Messenger conversations through approved scopes.",
    compliance: "No scraping, unsolicited messaging, spam, or browser automation.",
    // Facebook Page publishing has one route. Instagram's dual-route model does
    // not apply here and must not be copied onto it.
    authType: "oauth2_meta",
    credentialNote: "Facebook Page/Messenger access must come through approved Meta permissions.",
    credentialFields: [{ key: "pageAccessToken", label: "Page access token", type: "password", placeholder: "EAAB...", sensitive: true }],
    scopes: [],
    capabilities: {},
    reviewRequirement: "Meta app review is required for Page publishing and Messenger permissions.",
    // Messenger delivery needs an inbound HTTPS webhook the user must operate.
    requiresHostedCallback: true,
    docsUrl: "https://developers.facebook.com/docs/pages-api/"
  },
  {
    id: "tiktok",
    displayName: "TikTok",
    kind: "social",
    defaultStatus: "disconnected",
    detail: "Use approved TikTok APIs for analytics, messaging, and content posting when available.",
    allowedUse: "Manage eligible business messaging, reporting, and creator-approved video publishing through TikTok-approved API access.",
    compliance: "Use Content Posting API flows only. Do not automate private accounts or scrape TikTok surfaces.",
    authType: "oauth2_pkce_loopback",
    // TikTok's desktop Login Kit specifies hex-encoded S256, not base64url.
    pkceChallengeEncoding: "hex",
    credentialNote: "TikTok APIs require approved API access before ProduDash can use these credentials.",
    credentialFields: [
      { key: "clientKey", label: "Client key", type: "text", placeholder: "TikTok client key", sensitive: false },
      { key: "clientSecret", label: "Client secret", type: "password", placeholder: "TikTok client secret", sensitive: true }
    ],
    scopes: ["user.info.basic", "video.publish"],
    capabilities: { isPublishDestination: true, providesCreatorAnalytics: true },
    creator: {
      order: 0,
      displayName: "TikTok",
      format: "9:16 short video",
      postingMode: "Content Posting API draft or direct post after approval",
      analyticsMode: "Official TikTok analytics/reporting access only",
      requirements: ["Approved TikTok developer app", "Creator authorization", "No scraping or emulator posting"],
      metrics: ["views", "likes", "comments", "shares", "profile visits", "completion rate"]
    },
    mediaConstraints: { targetAspect: "vertical", captionSafeArea: "social" },
    reviewRequirement:
      "Unaudited TikTok clients are forced to SELF_ONLY visibility. An audit is required before any other visibility may be offered.",
    requiresHostedCallback: false,
    docsUrl: "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post"
  },
  {
    id: "youtube",
    displayName: "YouTube",
    kind: "social",
    defaultStatus: "disconnected",
    detail: "Use Google OAuth, YouTube Data API uploads, and YouTube Analytics APIs.",
    allowedUse: "Upload approved Shorts, read channel/video analytics, and reconcile publishing status after authorization.",
    compliance: "Respect Google API quotas, OAuth scopes, channel ownership, and user approval before uploads.",
    authType: "oauth2_pkce_loopback",
    pkceChallengeEncoding: "base64url",
    credentialNote: "Use Google OAuth client credentials for YouTube uploads and analytics.",
    credentialFields: [
      { key: "clientId", label: "OAuth client ID", type: "text", placeholder: "Google OAuth client ID", sensitive: false },
      { key: "clientSecret", label: "OAuth client secret", type: "password", placeholder: "Google OAuth client secret", sensitive: true }
    ],
    scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
    capabilities: { hasLiveConnector: true, isPublishDestination: true, providesCreatorAnalytics: true },
    // Choices YouTube requires per upload. `default: null` means there is no
    // safe guess: the user must choose, and validation rejects an absent value
    // rather than inventing one. These become part of the approved snapshot and
    // therefore part of its hash.
    publishingOptions: {
      selfDeclaredMadeForKids: {
        type: "boolean",
        // A legal audience declaration. Guessing it on someone's behalf is not
        // an option, so this deliberately has no default.
        default: null,
        label: "Made for kids",
        help: "YouTube requires an audience declaration for every upload. ProduDash cannot choose this for you.",
        choices: [
          { value: true, label: "Yes, made for kids" },
          { value: false, label: "No, not made for kids" }
        ]
      },
      privacyStatus: {
        type: "enum",
        values: ["private", "unlisted", "public"],
        // Private is the only default that cannot surprise anyone.
        default: "private",
        label: "Visibility",
        help: "Uploads from a Google API project that has not passed a YouTube compliance audit are locked to private regardless of this choice.",
        choices: [
          { value: "private", label: "Private" },
          { value: "unlisted", label: "Unlisted" },
          { value: "public", label: "Public" }
        ]
      }
    },
    creator: {
      order: 2,
      displayName: "YouTube Shorts",
      format: "Vertical YouTube video",
      postingMode: "YouTube Data API upload after OAuth approval",
      analyticsMode: "YouTube Analytics or Reporting APIs",
      requirements: ["Google OAuth consent", "Upload quota available", "Channel authorization"],
      metrics: ["views", "likes", "comments", "average view duration", "subscribers gained"]
    },
    mediaConstraints: { targetAspect: "vertical", captionSafeArea: "social" },
    reviewRequirement: "Uploads from an API project that has not passed a YouTube compliance audit are locked to private viewing.",
    requiresHostedCallback: false,
    docsUrl: "https://developers.google.com/youtube/v3/docs/videos/insert"
  },
  {
    id: "stripe",
    displayName: "Stripe",
    kind: "payments",
    defaultStatus: "planned",
    detail: "Use Stripe only for payment-link creation and payment verification after explicit setup.",
    allowedUse: "Verify payment status before fulfillment.",
    compliance: "Do not store card data. Use hosted payment links and webhooks.",
    authType: "api_key",
    credentialNote: "Use Stripe keys only for hosted payment links and webhook verification. Never store card data.",
    credentialFields: [
      { key: "secretKey", label: "Secret key", type: "password", placeholder: "sk_live_...", sensitive: true },
      { key: "webhookSecret", label: "Webhook signing secret", type: "password", placeholder: "whsec_...", sensitive: true }
    ],
    scopes: [],
    capabilities: {},
    reviewRequirement: null,
    // Webhook-driven confirmation needs an endpoint the user operates; polling is
    // the local-only substitute and must be described as such.
    requiresHostedCallback: true,
    docsUrl: "https://docs.stripe.com/api/payment-links"
  }
];

function freezePlatform(definition) {
  return Object.freeze({
    creatorDisplayName: definition.creator?.displayName || definition.displayName,
    pkceChallengeEncoding: null,
    publicIdentifierField: null,
    authRoutes: null,
    publishingOptions: null,
    mediaConstraints: null,
    dataWindow: null,
    creator: null,
    experimental: false,
    ...definition,
    capabilities: Object.freeze({ ...DEFAULT_CAPABILITIES, ...(definition.capabilities || {}) }),
    credentialFields: Object.freeze(definition.credentialFields.map((field) => Object.freeze({ ...field }))),
    scopes: Object.freeze([...definition.scopes]),
    creator: definition.creator
      ? Object.freeze({
          ...definition.creator,
          requirements: Object.freeze([...definition.creator.requirements]),
          metrics: Object.freeze([...definition.creator.metrics])
        })
      : null,
    authRoutes: definition.authRoutes
      ? Object.freeze(
          Object.fromEntries(
            Object.entries(definition.authRoutes).map(([key, route]) => [
              key,
              Object.freeze({
                ...route,
                scopes: Object.freeze([...route.scopes]),
                accountTypes: Object.freeze([...route.accountTypes])
              })
            ])
          )
        )
      : null,
    publishingOptions: definition.publishingOptions
      ? Object.freeze(
          Object.fromEntries(
            Object.entries(definition.publishingOptions).map(([key, option]) => [
              key,
              Object.freeze({
                ...option,
                values: option.values ? Object.freeze([...option.values]) : null,
                choices: Object.freeze(option.choices.map((choice) => Object.freeze({ ...choice })))
              })
            ])
          )
        )
      : null,
    mediaConstraints: definition.mediaConstraints ? Object.freeze({ ...definition.mediaConstraints }) : null,
    dataWindow: definition.dataWindow ? Object.freeze({ ...definition.dataWindow }) : null
  });
}

const REGISTRY = Object.freeze(PLATFORMS.map(freezePlatform));
const BY_ID = new Map(REGISTRY.map((platform) => [platform.id, platform]));

function listPlatforms() {
  return REGISTRY;
}

function findPlatform(id) {
  return BY_ID.get(id) || null;
}

function getPlatform(id) {
  const platform = BY_ID.get(id);
  if (!platform) throw new AppError("INVALID_INPUT", "Unknown integration.");
  return platform;
}

function platformsWhere(capability) {
  return REGISTRY.filter((platform) => platform.capabilities[capability]);
}

function idsWhere(capability) {
  return new Set(platformsWhere(capability).map((platform) => platform.id));
}

// Every platform is an integration; the publishable subset drives destinations.
const INTEGRATION_IDS = Object.freeze(new Set(REGISTRY.map((platform) => platform.id)));
const CREATOR_PLATFORM_IDS = Object.freeze(idsWhere("isPublishDestination"));

// Ordered creator ids (tiktok, instagram, youtube). JSON-Schema `enum` order is
// part of the generated OpenAPI draft, so this must stay stable.
function creatorPlatformIdList() {
  return creatorPlatformsInOrder("isPublishDestination").map((platform) => platform.id);
}

function hasCapability(id, capability) {
  return Boolean(findPlatform(id)?.capabilities[capability]);
}

// --- derived initial-state catalogs -----------------------------------------

function buildIntegrationCatalog() {
  return REGISTRY.map((platform) => ({
    id: platform.id,
    name: platform.displayName,
    status: platform.defaultStatus,
    detail: platform.detail,
    lastSync: NOT_CONNECTED,
    allowedUse: platform.allowedUse,
    compliance: platform.compliance,
    authorization: createAuthorizationRecord()
  }));
}

function buildCredentialSettingsCatalog() {
  return REGISTRY.map((platform) => ({
    id: platform.id,
    name: platform.displayName,
    status: "missing",
    updatedAt: null,
    configuredFields: [],
    publicValues: {},
    note: platform.credentialNote,
    fields: platform.credentialFields.map((field) => ({ ...field }))
  }));
}

// Creator-facing catalogs use their own declared order, not registry order.
function creatorPlatformsInOrder(capability) {
  return platformsWhere(capability)
    .slice()
    .sort((left, right) => left.creator.order - right.creator.order);
}

function buildCreatorPlatformCatalog() {
  return creatorPlatformsInOrder("isPublishDestination").map((platform) => ({
    id: platform.id,
    name: platform.creator.displayName,
    format: platform.creator.format,
    postingMode: platform.creator.postingMode,
    analyticsMode: platform.creator.analyticsMode,
    requirements: [...platform.creator.requirements]
  }));
}

function buildAnalyticsSourceCatalog() {
  return creatorPlatformsInOrder("providesCreatorAnalytics").map((platform) => ({
    id: platform.id,
    name: platform.creator.displayName,
    status: "waiting_for_connection",
    metrics: [...platform.creator.metrics],
    lastSync: NOT_CONNECTED
  }));
}

module.exports = {
  NOT_CONNECTED,
  CREATOR_PLATFORM_IDS,
  INTEGRATION_IDS,
  listPlatforms,
  findPlatform,
  getPlatform,
  platformsWhere,
  idsWhere,
  creatorPlatformIdList,
  hasCapability,
  buildIntegrationCatalog,
  buildCredentialSettingsCatalog,
  buildCreatorPlatformCatalog,
  buildAnalyticsSourceCatalog
};
