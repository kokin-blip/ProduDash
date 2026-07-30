const { AppError } = require("../errors.cjs");

// Public authorization metadata for one platform.
//
// Deliberately separate from both "credentials stored" (credentialSettings[].status)
// and "connection verified" (integrations[].status). Storing a client secret is
// not authorizing; authorizing is not verifying; and a verified connection can
// still be missing a scope the user needs. Each of those is its own field so the
// UI can say which one is actually true.
//
// Nothing here is a secret. Access and refresh tokens live only in the
// safeStorage vault under the reserved keys below; this record carries only
// booleans saying whether they exist.
const AUTHORIZATION_VERSION = 1;

const TOKEN_VAULT_KEYS = Object.freeze({
  ACCESS: "oauthAccessToken",
  REFRESH: "oauthRefreshToken"
});

const RESERVED_VAULT_KEYS = Object.freeze(new Set(Object.values(TOKEN_VAULT_KEYS)));

const REVIEW_STATUSES = Object.freeze(
  new Set([
    // ProduDash has not been told either way.
    "unknown",
    // The provider requires no review for the operations ProduDash uses.
    "not_required",
    // The user's own app still needs provider review, audit, or verification.
    "required",
    // The user has confirmed their app passed.
    "approved"
  ])
);

// The states the renderer can render. Every one of them is reachable and each
// says something different about what the user should do next.
const CONNECTION_STATES = Object.freeze({
  UNAVAILABLE: "unavailable",
  REQUIRES_CONFIGURATION: "requires_configuration",
  AUTHORIZATION_REQUIRED: "authorization_required",
  TOKEN_EXPIRED: "token_expired",
  MISSING_SCOPE: "missing_scope",
  PROVIDER_APPROVAL_REQUIRED: "provider_approval_required",
  ERROR: "error",
  CONNECTED: "connected",
  // Reachable, but only partly. Kept distinct from CONNECTED because the two
  // call for different reactions and the badge is the only place a user learns
  // which one they have.
  DEGRADED: "degraded",
  DISCONNECTED: "disconnected",
  CREDENTIALS_STORED_UNVERIFIED: "credentials_stored_unverified"
});

function createAuthorizationRecord() {
  return {
    version: AUTHORIZATION_VERSION,
    grantedScopes: [],
    tokenExpiresAt: null,
    reviewStatus: "unknown",
    selectedAccount: null,
    lastVerifiedAt: null,
    hasAccessToken: false,
    hasRefreshToken: false
  };
}

function isIsoTimestamp(value) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function normalizeSelectedAccount(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = typeof value.id === "string" ? value.id.slice(0, 128) : "";
  if (!id) return null;
  return { id, name: typeof value.name === "string" ? value.name.slice(0, 200) : "" };
}

// Coerces persisted or provider-supplied data onto the known shape. Unknown
// fields are dropped rather than carried forward, so a provider response can
// never smuggle extra keys into saved state.
function normalizeAuthorizationRecord(value) {
  const base = createAuthorizationRecord();
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  return {
    version: AUTHORIZATION_VERSION,
    grantedScopes: Array.isArray(value.grantedScopes)
      ? [...new Set(value.grantedScopes.filter((scope) => typeof scope === "string" && scope).map((scope) => scope.slice(0, 200)))].slice(
          0,
          50
        )
      : [],
    tokenExpiresAt: isIsoTimestamp(value.tokenExpiresAt) ? new Date(value.tokenExpiresAt).toISOString() : null,
    reviewStatus: REVIEW_STATUSES.has(value.reviewStatus) ? value.reviewStatus : "unknown",
    selectedAccount: normalizeSelectedAccount(value.selectedAccount),
    lastVerifiedAt: isIsoTimestamp(value.lastVerifiedAt) ? new Date(value.lastVerifiedAt).toISOString() : null,
    hasAccessToken: value.hasAccessToken === true,
    hasRefreshToken: value.hasRefreshToken === true
  };
}

function validateAuthorizationRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.version !== AUTHORIZATION_VERSION) return false;
  if (!Array.isArray(value.grantedScopes) || value.grantedScopes.some((scope) => typeof scope !== "string")) return false;
  if (value.grantedScopes.length > 50) return false;
  if (value.tokenExpiresAt !== null && !isIsoTimestamp(value.tokenExpiresAt)) return false;
  if (value.lastVerifiedAt !== null && !isIsoTimestamp(value.lastVerifiedAt)) return false;
  if (!REVIEW_STATUSES.has(value.reviewStatus)) return false;
  if (typeof value.hasAccessToken !== "boolean" || typeof value.hasRefreshToken !== "boolean") return false;
  if (value.selectedAccount !== null) {
    const account = value.selectedAccount;
    if (!account || typeof account !== "object" || Array.isArray(account)) return false;
    if (typeof account.id !== "string" || !account.id || typeof account.name !== "string") return false;
  }
  // A token record must never contain a token.
  for (const key of Object.keys(value)) {
    if (/token$/i.test(key) && key !== "tokenExpiresAt" && typeof value[key] === "string") return false;
  }
  return true;
}

function requiresAuthorizationFlow(platform) {
  return typeof platform?.authType === "string" && platform.authType.startsWith("oauth2");
}

function missingScopes(platform, authorization) {
  const granted = new Set(authorization?.grantedScopes || []);
  return platform.scopes.filter((scope) => !granted.has(scope));
}

// Resolves the one state the UI should show. Order matters: the most
// actionable, most specific answer wins, so a user is told "reauthorize"
// rather than a generic "error" whenever that is the real cause.
function deriveConnectionState({ platform, integration, setting, now = Date.now() }) {
  if (!platform) throw new AppError("INVALID_INPUT", "Unknown integration.");
  if (!platform.capabilities.hasLiveConnector) return CONNECTION_STATES.UNAVAILABLE;
  if (setting?.status !== "stored") return CONNECTION_STATES.REQUIRES_CONFIGURATION;

  const authorization = normalizeAuthorizationRecord(integration?.authorization);
  if (requiresAuthorizationFlow(platform) && !authorization.hasAccessToken) {
    return CONNECTION_STATES.AUTHORIZATION_REQUIRED;
  }
  // An expired access token backed by a refresh token is the ordinary steady
  // state, not a fault: ConnectionService renews it on the next call without
  // the user present. Only a grant with nothing left to refresh from actually
  // needs them to reauthorize, and saying so otherwise sends people through a
  // browser flow roughly once an hour for no reason.
  if (authorization.tokenExpiresAt && Date.parse(authorization.tokenExpiresAt) <= now && !authorization.hasRefreshToken) {
    return CONNECTION_STATES.TOKEN_EXPIRED;
  }
  // Only meaningful once an authorization actually granted something.
  if (authorization.grantedScopes.length && missingScopes(platform, authorization).length) {
    return CONNECTION_STATES.MISSING_SCOPE;
  }
  if (authorization.reviewStatus === "required") return CONNECTION_STATES.PROVIDER_APPROVAL_REQUIRED;
  if (integration?.status === "error") return CONNECTION_STATES.ERROR;
  // Reported separately. Collapsing it into CONNECTED put a success badge
  // directly above the error text describing the part that failed, and claimed
  // "verified against the provider" for a sync that was not.
  if (integration?.status === "degraded") return CONNECTION_STATES.DEGRADED;
  if (integration?.status === "connected") return CONNECTION_STATES.CONNECTED;
  // Verified before, not verified now.
  if (authorization.lastVerifiedAt) return CONNECTION_STATES.DISCONNECTED;
  return CONNECTION_STATES.CREDENTIALS_STORED_UNVERIFIED;
}

module.exports = {
  AUTHORIZATION_VERSION,
  CONNECTION_STATES,
  RESERVED_VAULT_KEYS,
  REVIEW_STATUSES,
  TOKEN_VAULT_KEYS,
  createAuthorizationRecord,
  deriveConnectionState,
  missingScopes,
  normalizeAuthorizationRecord,
  requiresAuthorizationFlow,
  validateAuthorizationRecord
};
