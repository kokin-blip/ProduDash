const { AppError } = require("../errors.cjs");
const { findPlatform } = require("../platforms/registry.cjs");

// Optional connector capabilities. A connector declares what it can do; the rest
// of the app asks the declaration, never a `typeof connector.publish` probe, so
// an unimplemented capability fails loudly instead of silently doing nothing.
const CONNECTOR_CAPABILITIES = Object.freeze({
  // Runs an interactive authorization flow (OAuth). Absent for API-key providers.
  AUTHORIZE: "authorize",
  // Exchanges a refresh token for a new access token.
  REFRESH: "refreshAuthorization",
  // Publishes approved media to the platform.
  PUBLISH: "publish",
  // Publishes in three separately callable steps so the caller can durably
  // persist the provider's session handle before any bytes are sent, and
  // reconcile an interrupted transfer instead of restarting it.
  RESUMABLE_UPLOAD: "resumableUpload",
  // Reports the coarse state of something already published.
  PUBLISHING_STATUS: "publishingStatus",
  // Reads performance metrics.
  ANALYTICS: "analytics",
  // Revokes access at the provider, not just locally.
  DISCONNECT: "disconnect"
});

const CAPABILITY_VALUES = Object.freeze(new Set(Object.values(CONNECTOR_CAPABILITIES)));

// Method required for the declared capability. Everything not listed here is
// required of every connector.
const CAPABILITY_METHODS = Object.freeze({
  [CONNECTOR_CAPABILITIES.AUTHORIZE]: "authorize",
  [CONNECTOR_CAPABILITIES.REFRESH]: "refreshAuthorization",
  [CONNECTOR_CAPABILITIES.PUBLISH]: "publish",
  [CONNECTOR_CAPABILITIES.RESUMABLE_UPLOAD]: ["beginUpload", "probeUpload", "sendUpload"],
  [CONNECTOR_CAPABILITIES.PUBLISHING_STATUS]: "getPublishingStatus",
  [CONNECTOR_CAPABILITIES.ANALYTICS]: "getAnalytics",
  [CONNECTOR_CAPABILITIES.DISCONNECT]: "disconnect"
});

// Every connector must be able to describe its own setup and verify itself.
const REQUIRED_METHODS = Object.freeze(["getAuthorizationInstructions", "validateConfiguration", "testConnection"]);

const CONNECTION_STATUSES = Object.freeze(new Set(["connected", "degraded", "error", "disconnected"]));

// A capability may require more than one method; normalize to a list.
function methodsFor(capability) {
  const methods = CAPABILITY_METHODS[capability];
  return Array.isArray(methods) ? methods : [methods];
}

function assertConnectorContract(connector) {
  if (!connector || typeof connector !== "object") {
    throw new AppError("INVALID_CONNECTOR", "A connector must be an object.");
  }
  if (!findPlatform(connector.id)) {
    throw new AppError("INVALID_CONNECTOR", "A connector must declare a known platform id.");
  }
  if (!Array.isArray(connector.capabilities)) {
    throw new AppError("INVALID_CONNECTOR", `Connector ${connector.id} must declare a capability list.`);
  }
  for (const capability of connector.capabilities) {
    if (!CAPABILITY_VALUES.has(capability)) {
      throw new AppError("INVALID_CONNECTOR", `Connector ${connector.id} declared an unknown capability.`);
    }
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof connector[method] !== "function") {
      throw new AppError("INVALID_CONNECTOR", `Connector ${connector.id} must implement ${method}().`);
    }
  }
  // A declared capability without its method would fail at the call site, long
  // after the mistake was made. Catch it at registration instead.
  for (const capability of connector.capabilities) {
    for (const method of methodsFor(capability)) {
      if (typeof connector[method] !== "function") {
        throw new AppError("INVALID_CONNECTOR", `Connector ${connector.id} declares ${capability} but has no ${method}().`);
      }
    }
  }
  // The reverse is just as dangerous: an implemented-but-undeclared capability
  // is invisible to every capability check in the app.
  for (const capability of Object.values(CONNECTOR_CAPABILITIES)) {
    const methods = methodsFor(capability);
    if (methods.some((method) => typeof connector[method] === "function") && !connector.capabilities.includes(capability)) {
      throw new AppError("INVALID_CONNECTOR", `Connector ${connector.id} implements ${methods[0]}() without declaring ${capability}.`);
    }
  }
  return connector;
}

function connectorSupports(connector, capability) {
  return Boolean(connector) && Array.isArray(connector.capabilities) && connector.capabilities.includes(capability);
}

// Normalizes what a connector reports back from testConnection() so the store
// never has to know which provider produced it.
function normalizeConnectionResult(result, platformId) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new AppError("INVALID_CONNECTOR_RESULT", "The connector returned an unusable result.");
  }
  if (!CONNECTION_STATUSES.has(result.status)) {
    throw new AppError("INVALID_CONNECTOR_RESULT", "The connector returned an unknown connection status.");
  }
  return {
    platformId,
    status: result.status,
    error: typeof result.error === "string" && result.error ? result.error : null,
    syncedAt: typeof result.syncedAt === "string" && result.syncedAt ? result.syncedAt : new Date().toISOString(),
    auditDetail: typeof result.auditDetail === "string" && result.auditDetail ? result.auditDetail : null,
    // Only platforms that own business records return one.
    business: result.business && typeof result.business === "object" && !Array.isArray(result.business) ? result.business : null
  };
}

module.exports = {
  CAPABILITY_METHODS,
  CONNECTION_STATUSES,
  CONNECTOR_CAPABILITIES,
  REQUIRED_METHODS,
  assertConnectorContract,
  connectorSupports,
  normalizeConnectionResult
};
