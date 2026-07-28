const { listPlatforms } = require("./registry.cjs");
const {
  CONNECTION_STATES,
  deriveConnectionState,
  missingScopes,
  normalizeAuthorizationRecord,
  requiresAuthorizationFlow
} = require("./authorization.cjs");

// A safe, derived view model of every platform for the renderer.
//
// The renderer cannot require main-process modules, so without this it would
// have to re-derive connection state from raw fields -- duplicating
// deriveConnectionState and drifting from it. Instead main resolves the state
// and the available actions once, and the renderer stays presentational.
//
// Built fresh inside getAppState() from an already-cloned state and never
// written back, so nothing here is persisted or validated as saved state.
// It contains no tokens, no secrets, and no filesystem paths.

// Why each action is unavailable, in words the UI can show directly. Every
// disabled control has to explain itself.
const REASONS = Object.freeze({
  NO_CONNECTOR: "ProduDash has no connector for this platform yet.",
  NOT_CONFIGURED: "Save this platform's configuration first.",
  NO_AUTH_FLOW: "This platform does not use an authorization flow.",
  NOT_AUTHORIZED: "Authorize this platform first.",
  NOTHING_STORED: "Nothing is stored for this platform yet."
});

function action(id, label, available, reason = null) {
  return { id, label, available, reason: available ? null : reason };
}

function buildActions({ platform, setting, authorization }) {
  const live = platform.capabilities.hasLiveConnector;
  const configured = setting?.status === "stored";
  const usesOauth = requiresAuthorizationFlow(platform);
  const authorized = authorization.hasAccessToken;

  return [
    action("save_configuration", "Save configuration", live, REASONS.NO_CONNECTOR),
    action(
      "connect",
      authorized ? "Reauthorize" : "Connect",
      live && usesOauth && configured,
      !live ? REASONS.NO_CONNECTOR : !usesOauth ? REASONS.NO_AUTH_FLOW : REASONS.NOT_CONFIGURED
    ),
    action("test", "Test connection", live && configured, !live ? REASONS.NO_CONNECTOR : REASONS.NOT_CONFIGURED),
    action(
      "disconnect",
      "Disconnect authorization",
      live && usesOauth && authorized,
      !live ? REASONS.NO_CONNECTOR : !usesOauth ? REASONS.NO_AUTH_FLOW : REASONS.NOT_AUTHORIZED
    ),
    action("remove", "Remove all configuration", configured || authorized, REASONS.NOTHING_STORED)
  ];
}

function buildPlatformEntry(state, platform) {
  const setting = state.credentialSettings.find((item) => item.id === platform.id) || null;
  const integration = state.integrations.find((item) => item.id === platform.id) || null;
  const authorization = normalizeAuthorizationRecord(integration?.authorization);
  const connectionState = deriveConnectionState({ platform, integration, setting });

  return {
    id: platform.id,
    displayName: platform.displayName,
    kind: platform.kind,
    // Drives which section the platform is rendered in.
    hasLiveConnector: platform.capabilities.hasLiveConnector,
    isPublishDestination: platform.capabilities.isPublishDestination,
    authType: platform.authType,
    requiresAuthorizationFlow: requiresAuthorizationFlow(platform),
    connectionState,
    // Only meaningful once an authorization actually granted something, which
    // is why deriveConnectionState guards on grantedScopes.length.
    requiredScopes: [...platform.scopes],
    grantedScopes: [...authorization.grantedScopes],
    missingScopes: authorization.grantedScopes.length ? missingScopes(platform, authorization) : [],
    reviewRequirement: platform.reviewRequirement,
    reviewStatus: authorization.reviewStatus,
    docsUrl: platform.docsUrl,
    credentialNote: platform.credentialNote,
    // Safe booleans only: whether a token exists, never the token.
    hasAccessToken: authorization.hasAccessToken,
    hasRefreshToken: authorization.hasRefreshToken,
    tokenExpiresAt: authorization.tokenExpiresAt,
    selectedAccount: authorization.selectedAccount,
    lastVerifiedAt: authorization.lastVerifiedAt,
    // Instagram declares two mutually exclusive routes; null everywhere else.
    authRoutes: platform.authRoutes
      ? Object.values(platform.authRoutes).map((route) => ({
          id: route.id,
          label: route.label,
          summary: route.summary,
          scopes: [...route.scopes],
          requiresLinkedFacebookPage: route.requiresLinkedFacebookPage,
          docsUrl: route.docsUrl
        }))
      : null,
    actions: buildActions({ platform, setting, authorization })
  };
}

function buildPlatformCatalog(state) {
  return listPlatforms().map((platform) => buildPlatformEntry(state, platform));
}

module.exports = { CONNECTION_STATES, REASONS, buildActions, buildPlatformCatalog, buildPlatformEntry };
