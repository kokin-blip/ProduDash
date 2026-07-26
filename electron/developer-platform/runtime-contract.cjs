const { AppError } = require("../errors.cjs");
const { boundedInteger, boundedString, requireId } = require("../validation.cjs");
const { API_VERSION, OPERATION_DEFINITIONS, authorizeApiRequest } = require("./api-contract.cjs");
const { MAX_CURSOR_LIFETIME_MS, normalizeApiCursorRecord, verifyApiCursorToken } = require("./cursor-credential.cjs");

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_POLICIES = Object.freeze({
  low: Object.freeze({ requestsPerMinute: 60 }),
  standard: Object.freeze({ requestsPerMinute: 300 }),
  high: Object.freeze({ requestsPerMinute: 1200 })
});
const API_ERROR_DEFINITIONS = Object.freeze({
  API_INVALID_REQUEST: Object.freeze({
    statusCode: 400,
    message: "The request is invalid.",
    retryable: false
  }),
  API_UNAUTHENTICATED: Object.freeze({
    statusCode: 401,
    message: "Authentication is required.",
    retryable: false
  }),
  API_FORBIDDEN: Object.freeze({
    statusCode: 403,
    message: "This token cannot perform the requested operation.",
    retryable: false
  }),
  API_NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "The requested resource was not found.",
    retryable: false
  }),
  API_REQUEST_STALE: Object.freeze({
    statusCode: 408,
    message: "The request timestamp is outside the accepted window.",
    retryable: true
  }),
  API_CONFLICT: Object.freeze({
    statusCode: 409,
    message: "The request conflicts with the current resource state.",
    retryable: false
  }),
  API_RATE_LIMITED: Object.freeze({
    statusCode: 429,
    message: "The API request limit has been reached.",
    retryable: true
  }),
  API_INTERNAL_ERROR: Object.freeze({
    statusCode: 500,
    message: "ProduDash could not complete the API request.",
    retryable: true
  }),
  API_SERVICE_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "The API service is temporarily unavailable.",
    retryable: true
  })
});
const AUDIT_OUTCOMES = new Set(["success", "replay", "denied", "rate_limited", "failure"]);
const DURATION_BUCKETS = new Set(["under_100ms", "under_500ms", "under_2s", "under_10s", "over_10s"]);

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  }
  return value;
}

function onlyKeys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AppError("INVALID_INPUT", `${label} contains unsupported fields.`);
  }
}

function isoTimestamp(value, label) {
  const text = boundedString(value, { label, min: 1, max: 40 });
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return new Date(timestamp).toISOString();
}

function hash(value, label) {
  const result = boundedString(value, { label, min: 71, max: 71 });
  if (!HASH_PATTERN.test(result)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return result;
}

function safeCode(value, label, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const result = boundedString(value, { label, min: 1, max: 80 });
  if (!SAFE_CODE_PATTERN.test(result)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return result;
}

function operationDefinition(resourceType, operation) {
  const definition = OPERATION_DEFINITIONS[resourceType]?.[operation];
  if (!definition) throw new AppError("INVALID_INPUT", "API resource and operation are incompatible.");
  return definition;
}

function normalizeApiPageRequest(raw) {
  const value = plainObject(raw, "API page request");
  onlyKeys(value, new Set(["limit", "cursorToken", "queryHash"]), "API page request");
  return {
    limit: boundedInteger(value.limit, { label: "API page size", min: 1, max: 100, fallback: 50 }),
    cursorToken: value.cursorToken ? boundedString(value.cursorToken, { label: "API cursor", min: 1, max: 230 }) : null,
    queryHash: hash(value.queryHash, "API query hash")
  };
}

function authorizeApiPage(rawToken, rawRequest, rawPageRequest, rawCursor, options = {}) {
  const authorized = authorizeApiRequest(rawToken, rawRequest, options);
  const page = normalizeApiPageRequest(rawPageRequest);
  if (authorized.request.operation !== "list" || authorized.request.mutation) {
    throw new AppError("INVALID_INPUT", "Only API list operations support pagination.");
  }
  if (!page.cursorToken) {
    if (rawCursor !== null && rawCursor !== undefined) {
      throw new AppError("INVALID_INPUT", "The first API page cannot include a cursor record.");
    }
    return { ...authorized, page, cursor: null };
  }
  if (!rawCursor) throw new AppError("API_CURSOR_INVALID", "The API cursor is missing or invalid.");
  const cursor = verifyApiCursorToken(
    page.cursorToken,
    rawCursor,
    options.cursorSigningKey,
    {
      organizationId: authorized.request.organizationId,
      tokenId: authorized.authorization.tokenId,
      projectId: authorized.request.projectId,
      resourceType: authorized.request.resourceType,
      queryHash: page.queryHash,
      pageSize: page.limit
    },
    options
  );
  return { ...authorized, page, cursor };
}

function normalizeApiSuccessEnvelope(raw) {
  const value = plainObject(raw, "API success envelope");
  onlyKeys(
    value,
    new Set([
      "apiVersion",
      "requestId",
      "organizationId",
      "projectId",
      "resourceType",
      "operation",
      "statusCode",
      "dataHash",
      "resultCount",
      "nextCursor",
      "completedAt"
    ]),
    "API success envelope"
  );
  if (value.apiVersion !== API_VERSION) throw new AppError("API_VERSION_UNSUPPORTED", "The API response version is unsupported.");
  const resourceType = boundedString(value.resourceType, { label: "API response resource type", min: 1, max: 40 });
  const operation = boundedString(value.operation, { label: "API response operation", min: 1, max: 40 });
  const definition = operationDefinition(resourceType, operation);
  const projectId = value.projectId ? requireId(value.projectId, "Project") : null;
  if (definition.projectId === "required" && !projectId) {
    throw new AppError("INVALID_INPUT", "This API response requires a project.");
  }
  if (definition.projectId === "forbidden" && projectId) {
    throw new AppError("INVALID_INPUT", "This API response is organization-scoped.");
  }
  const statusCode = boundedInteger(value.statusCode, { label: "API success status", min: 200, max: 299 });
  const resultCount = boundedInteger(value.resultCount, { label: "API result count", min: 0, max: 100 });
  const nextCursor = value.nextCursor ? boundedString(value.nextCursor, { label: "Next API cursor", min: 1, max: 230 }) : null;
  if (operation !== "list" && (nextCursor || resultCount > 1)) {
    throw new AppError("INVALID_INPUT", "Only API list responses can contain pagination or multiple results.");
  }
  return {
    apiVersion: API_VERSION,
    requestId: requireId(value.requestId, "API request"),
    organizationId: requireId(value.organizationId, "Organization"),
    projectId,
    resourceType,
    operation,
    statusCode,
    dataHash: hash(value.dataHash, "API response data hash"),
    resultCount,
    nextCursor,
    completedAt: isoTimestamp(value.completedAt, "API completion time")
  };
}

function normalizeApiErrorEnvelope(raw) {
  const value = plainObject(raw, "API error envelope");
  onlyKeys(value, new Set(["apiVersion", "requestId", "statusCode", "error", "completedAt"]), "API error envelope");
  if (value.apiVersion !== API_VERSION) throw new AppError("API_VERSION_UNSUPPORTED", "The API response version is unsupported.");
  const error = plainObject(value.error, "API error");
  onlyKeys(error, new Set(["code", "message", "retryable", "retryAfterSeconds"]), "API error");
  const code = safeCode(error.code, "API error code");
  const definition = API_ERROR_DEFINITIONS[code];
  if (!definition) throw new AppError("INVALID_INPUT", "API error code is invalid.");
  const statusCode = boundedInteger(value.statusCode, { label: "API error status", min: 400, max: 599 });
  const retryAfterSeconds =
    error.retryAfterSeconds === null || error.retryAfterSeconds === undefined
      ? null
      : boundedInteger(error.retryAfterSeconds, { label: "API retry delay", min: 1, max: 3600 });
  if (
    statusCode !== definition.statusCode ||
    error.message !== definition.message ||
    error.retryable !== definition.retryable ||
    (code === "API_RATE_LIMITED") !== Boolean(retryAfterSeconds)
  ) {
    throw new AppError("INVALID_INPUT", "API error details do not match the safe error definition.");
  }
  return {
    apiVersion: API_VERSION,
    requestId: requireId(value.requestId, "API request"),
    statusCode,
    error: {
      code,
      message: definition.message,
      retryable: definition.retryable,
      retryAfterSeconds
    },
    completedAt: isoTimestamp(value.completedAt, "API completion time")
  };
}

function createApiErrorEnvelope({ requestId, code, retryAfterSeconds = null, completedAt } = {}) {
  const definition = API_ERROR_DEFINITIONS[code];
  if (!definition) throw new AppError("INVALID_INPUT", "API error code is invalid.");
  return normalizeApiErrorEnvelope({
    apiVersion: API_VERSION,
    requestId,
    statusCode: definition.statusCode,
    error: {
      code,
      message: definition.message,
      retryable: definition.retryable,
      retryAfterSeconds
    },
    completedAt
  });
}

function rateLimitPolicy(rateLimitClass) {
  const policy = RATE_LIMIT_POLICIES[rateLimitClass];
  if (!policy) throw new AppError("INVALID_INPUT", "API rate-limit class is invalid.");
  return policy;
}

function normalizeRateLimitRecord(raw) {
  const value = plainObject(raw, "API rate-limit record");
  onlyKeys(
    value,
    new Set([
      "apiVersion",
      "organizationId",
      "tokenId",
      "rateLimitClass",
      "windowStartedAt",
      "windowEndsAt",
      "used",
      "limit",
      "updatedAt",
      "sequence"
    ]),
    "API rate-limit record"
  );
  if (value.apiVersion !== API_VERSION) throw new AppError("API_VERSION_UNSUPPORTED", "The API rate-limit version is unsupported.");
  const rateLimitClass = boundedString(value.rateLimitClass, { label: "API rate-limit class", min: 1, max: 40 });
  const policy = rateLimitPolicy(rateLimitClass);
  const windowStartedAt = isoTimestamp(value.windowStartedAt, "API rate-limit window start");
  const windowEndsAt = isoTimestamp(value.windowEndsAt, "API rate-limit window end");
  const updatedAt = isoTimestamp(value.updatedAt, "API rate-limit update time");
  if (
    Date.parse(windowEndsAt) - Date.parse(windowStartedAt) !== RATE_WINDOW_MS ||
    Date.parse(updatedAt) < Date.parse(windowStartedAt) ||
    Date.parse(updatedAt) >= Date.parse(windowEndsAt)
  ) {
    throw new AppError("INVALID_INPUT", "API rate-limit window is invalid.");
  }
  const limit = boundedInteger(value.limit, { label: "API rate limit", min: 1, max: 10_000 });
  if (limit !== policy.requestsPerMinute) throw new AppError("INVALID_INPUT", "API rate limit does not match its class.");
  return {
    apiVersion: API_VERSION,
    organizationId: requireId(value.organizationId, "Organization"),
    tokenId: requireId(value.tokenId, "API token"),
    rateLimitClass,
    windowStartedAt,
    windowEndsAt,
    used: boundedInteger(value.used, { label: "API rate-limit usage", min: 0, max: limit }),
    limit,
    updatedAt,
    sequence: boundedInteger(value.sequence, { label: "API rate-limit sequence", min: 1, max: 2_147_483_647 })
  };
}

function apiRequestCost(request) {
  if (request.resourceType === "organization_exports" && request.operation === "create") return 10;
  return request.mutation ? 5 : 1;
}

function newRateLimitRecord(authorization, now, used, sequence) {
  const policy = rateLimitPolicy(authorization.rateLimitClass);
  const windowStartedAtMs = Math.floor(now.getTime() / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  return normalizeRateLimitRecord({
    apiVersion: API_VERSION,
    organizationId: authorization.organizationId,
    tokenId: authorization.tokenId,
    rateLimitClass: authorization.rateLimitClass,
    windowStartedAt: new Date(windowStartedAtMs).toISOString(),
    windowEndsAt: new Date(windowStartedAtMs + RATE_WINDOW_MS).toISOString(),
    used,
    limit: policy.requestsPerMinute,
    updatedAt: now.toISOString(),
    sequence
  });
}

function evaluateApiRateLimit(rawToken, rawRequest, rawExisting, options = {}) {
  const authorized = authorizeApiRequest(rawToken, rawRequest, options);
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  const cost = apiRequestCost(authorized.request);
  if (!rawExisting) {
    const record = newRateLimitRecord(authorized.authorization, now, cost, 1);
    return { allowed: true, cost, remaining: record.limit - record.used, retryAfterSeconds: null, record };
  }
  const existing = normalizeRateLimitRecord(rawExisting);
  if (
    existing.organizationId !== authorized.authorization.organizationId ||
    existing.tokenId !== authorized.authorization.tokenId ||
    existing.rateLimitClass !== authorized.authorization.rateLimitClass
  ) {
    throw new AppError("RATE_LIMIT_TARGET_MISMATCH", "The API rate-limit record does not match this token.");
  }
  if (now.getTime() >= Date.parse(existing.windowEndsAt)) {
    const record = newRateLimitRecord(authorized.authorization, now, cost, existing.sequence + 1);
    return { allowed: true, cost, remaining: record.limit - record.used, retryAfterSeconds: null, record };
  }
  if (now.getTime() < Date.parse(existing.windowStartedAt)) {
    throw new AppError("INVALID_INPUT", "The API rate-limit clock moved before the active window.");
  }
  if (existing.used + cost > existing.limit) {
    return {
      allowed: false,
      cost,
      remaining: existing.limit - existing.used,
      retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(existing.windowEndsAt) - now.getTime()) / 1000)),
      record: existing
    };
  }
  const record = normalizeRateLimitRecord({
    ...existing,
    used: existing.used + cost,
    updatedAt: now.toISOString(),
    sequence: existing.sequence + 1
  });
  return { allowed: true, cost, remaining: record.limit - record.used, retryAfterSeconds: null, record };
}

function normalizeApiOperationalAudit(raw) {
  const value = plainObject(raw, "API operational audit");
  onlyKeys(
    value,
    new Set([
      "apiVersion",
      "auditId",
      "organizationId",
      "projectId",
      "tokenId",
      "requestId",
      "resourceType",
      "operation",
      "outcome",
      "statusCode",
      "errorCode",
      "rateLimitClass",
      "durationBucket",
      "occurredAt"
    ]),
    "API operational audit"
  );
  if (value.apiVersion !== API_VERSION) throw new AppError("API_VERSION_UNSUPPORTED", "The API audit version is unsupported.");
  const resourceType = boundedString(value.resourceType, { label: "API audit resource type", min: 1, max: 40 });
  const operation = boundedString(value.operation, { label: "API audit operation", min: 1, max: 40 });
  const definition = operationDefinition(resourceType, operation);
  const projectId = value.projectId ? requireId(value.projectId, "Project") : null;
  if (definition.projectId === "required" && !projectId) {
    throw new AppError("INVALID_INPUT", "This API audit event requires a project.");
  }
  if (definition.projectId === "forbidden" && projectId) {
    throw new AppError("INVALID_INPUT", "This API audit event is organization-scoped.");
  }
  const outcome = boundedString(value.outcome, { label: "API audit outcome", min: 1, max: 40 });
  if (!AUDIT_OUTCOMES.has(outcome)) throw new AppError("INVALID_INPUT", "API audit outcome is invalid.");
  const statusCode = boundedInteger(value.statusCode, { label: "API audit status", min: 200, max: 599 });
  const errorCode = safeCode(value.errorCode, "API audit error code", true);
  const errorDefinition = errorCode ? API_ERROR_DEFINITIONS[errorCode] : null;
  if (errorCode && !errorDefinition) throw new AppError("INVALID_INPUT", "API audit error code is invalid.");
  const validOutcome =
    (["success", "replay"].includes(outcome) && statusCode >= 200 && statusCode <= 299 && !errorCode) ||
    (outcome === "denied" && [401, 403].includes(statusCode) && errorDefinition?.statusCode === statusCode) ||
    (outcome === "rate_limited" && statusCode === 429 && errorCode === "API_RATE_LIMITED") ||
    (outcome === "failure" && statusCode >= 400 && Boolean(errorCode) && errorDefinition?.statusCode === statusCode);
  if (!validOutcome) throw new AppError("INVALID_INPUT", "API audit outcome does not match its safe status.");
  const tokenId = value.tokenId ? requireId(value.tokenId, "API token") : null;
  if (!tokenId && !(outcome === "denied" && statusCode === 401 && errorCode === "API_UNAUTHENTICATED")) {
    throw new AppError("INVALID_INPUT", "Only unauthenticated API audit events can omit a token identifier.");
  }
  const rateLimitClass = boundedString(value.rateLimitClass, { label: "API audit rate-limit class", min: 1, max: 40 });
  rateLimitPolicy(rateLimitClass);
  const durationBucket = boundedString(value.durationBucket, { label: "API audit duration", min: 1, max: 40 });
  if (!DURATION_BUCKETS.has(durationBucket)) throw new AppError("INVALID_INPUT", "API audit duration is invalid.");
  return {
    apiVersion: API_VERSION,
    auditId: requireId(value.auditId, "API audit"),
    organizationId: requireId(value.organizationId, "Organization"),
    projectId,
    tokenId,
    requestId: requireId(value.requestId, "API request"),
    resourceType,
    operation,
    outcome,
    statusCode,
    errorCode,
    rateLimitClass,
    durationBucket,
    occurredAt: isoTimestamp(value.occurredAt, "API audit time")
  };
}

module.exports = {
  API_ERROR_DEFINITIONS,
  MAX_CURSOR_LIFETIME_MS,
  RATE_LIMIT_POLICIES,
  RATE_WINDOW_MS,
  authorizeApiPage,
  createApiErrorEnvelope,
  evaluateApiRateLimit,
  normalizeApiCursorRecord,
  normalizeApiErrorEnvelope,
  normalizeApiOperationalAudit,
  normalizeApiPageRequest,
  normalizeApiSuccessEnvelope,
  normalizeRateLimitRecord
};
