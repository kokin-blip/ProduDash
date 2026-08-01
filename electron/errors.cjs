class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.cause = options.cause;
  }
}

// Connector failures must stay distinguishable so callers can react correctly:
// a rate limit is worth retrying, a revoked token is not, and "the provider has
// not approved this app yet" is neither an outage nor a user mistake.
const CONNECTOR_ERROR_CATEGORIES = Object.freeze({
  // Credentials are missing, malformed, expired, or revoked.
  AUTHENTICATION: "authentication",
  // Credentials are valid but lack the scope or account access required.
  AUTHORIZATION: "authorization",
  // The provider is throttling. Retry later.
  RATE_LIMIT: "rate_limit",
  // The request was rejected before it left ProduDash, or the provider rejected
  // its shape. Retrying the identical request cannot help.
  VALIDATION: "validation",
  // The provider requires an app review, audit, or eligibility ProduDash's user
  // has not completed. Not a transient failure.
  PROVIDER_REVIEW: "provider_review",
  // Transferring media failed partway.
  UPLOAD: "upload",
  // The provider accepted the media but failed while processing it.
  PROCESSING: "processing",
  // ProduDash could not reach the provider at all.
  NETWORK: "network"
});

const CATEGORY_VALUES = Object.freeze(new Set(Object.values(CONNECTOR_ERROR_CATEGORIES)));

// Whether an identical retry could plausibly succeed. Callers may override when
// a provider says otherwise (for example a 4xx upload that must be restarted).
const DEFAULT_RETRYABLE = Object.freeze({
  [CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION]: false,
  [CONNECTOR_ERROR_CATEGORIES.AUTHORIZATION]: false,
  [CONNECTOR_ERROR_CATEGORIES.RATE_LIMIT]: true,
  [CONNECTOR_ERROR_CATEGORIES.VALIDATION]: false,
  [CONNECTOR_ERROR_CATEGORIES.PROVIDER_REVIEW]: false,
  [CONNECTOR_ERROR_CATEGORIES.UPLOAD]: true,
  [CONNECTOR_ERROR_CATEGORIES.PROCESSING]: true,
  [CONNECTOR_ERROR_CATEGORIES.NETWORK]: true
});

// A connector failure carrying a stable code, a coarse category, and whether a
// retry is worth attempting. The message must be ProduDash's own fixed text --
// never a provider body, header, or credential.
class ConnectorError extends AppError {
  constructor(code, message, options = {}) {
    super(code, message, { cause: options.cause });
    this.name = "ConnectorError";
    if (!CATEGORY_VALUES.has(options.category)) {
      throw new AppError("INTERNAL_ERROR", "A connector error was raised without a valid category.");
    }
    this.category = options.category;
    this.retryable = typeof options.retryable === "boolean" ? options.retryable : DEFAULT_RETRYABLE[options.category];
    this.platformId = options.platformId || null;
  }
}

function connectorError(category, code, message, options = {}) {
  return new ConnectorError(code, message, { ...options, category });
}

function asAppError(error, fallbackCode = "INTERNAL_ERROR", fallbackMessage = "ProduDash could not complete that request.") {
  if (error instanceof AppError) return error;
  return new AppError(fallbackCode, fallbackMessage, { cause: error });
}

// Retryability is only meaningful when a connector actually declared it. An
// ordinary AppError carries no claim either way, so treat it as not retryable.
function isRetryable(error) {
  return error instanceof ConnectorError ? error.retryable : false;
}

function errorResponse(error) {
  const safe = asAppError(error);
  return {
    ok: false,
    error: {
      code: safe.code,
      message: safe.message
    }
  };
}

module.exports = {
  AppError,
  CONNECTOR_ERROR_CATEGORIES,
  ConnectorError,
  DEFAULT_RETRYABLE,
  asAppError,
  connectorError,
  errorResponse,
  isRetryable
};
