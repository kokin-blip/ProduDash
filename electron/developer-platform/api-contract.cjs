const crypto = require("node:crypto");
const { AppError } = require("../errors.cjs");
const { boundedInteger, boundedString, requireId } = require("../validation.cjs");

const API_VERSION = "v1";
const API_SCOPES = Object.freeze({
  PROJECTS_READ: "projects:read",
  PROJECTS_WRITE: "projects:write",
  JOBS_READ: "jobs:read",
  JOBS_WRITE: "jobs:write",
  APPROVALS_READ: "approvals:read",
  APPROVALS_DECIDE: "approvals:decide",
  PUBLISHING_READ: "publishing:read",
  PUBLISHING_APPROVE: "publishing:approve",
  ANALYTICS_READ: "analytics:read",
  ORGANIZATION_EXPORT: "organization:export",
  WEBHOOKS_MANAGE: "webhooks:manage"
});

const ALL_SCOPES = new Set(Object.values(API_SCOPES));
const RATE_LIMIT_CLASSES = new Set(["low", "standard", "high"]);
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OPERATION_DEFINITIONS = Object.freeze({
  projects: Object.freeze({
    list: Object.freeze({ scope: API_SCOPES.PROJECTS_READ, mutation: false, resourceId: "forbidden", projectId: "optional" }),
    get: Object.freeze({ scope: API_SCOPES.PROJECTS_READ, mutation: false, resourceId: "required", projectId: "required" }),
    create: Object.freeze({
      scope: API_SCOPES.PROJECTS_WRITE,
      mutation: true,
      resourceId: "forbidden",
      projectId: "forbidden",
      organizationWide: true
    }),
    update: Object.freeze({ scope: API_SCOPES.PROJECTS_WRITE, mutation: true, resourceId: "required", projectId: "required" })
  }),
  jobs: Object.freeze({
    list: Object.freeze({ scope: API_SCOPES.JOBS_READ, mutation: false, resourceId: "forbidden", projectId: "required" }),
    get: Object.freeze({ scope: API_SCOPES.JOBS_READ, mutation: false, resourceId: "required", projectId: "required" }),
    create: Object.freeze({ scope: API_SCOPES.JOBS_WRITE, mutation: true, resourceId: "forbidden", projectId: "required" }),
    cancel: Object.freeze({ scope: API_SCOPES.JOBS_WRITE, mutation: true, resourceId: "required", projectId: "required" }),
    retry: Object.freeze({ scope: API_SCOPES.JOBS_WRITE, mutation: true, resourceId: "required", projectId: "required" })
  }),
  approvals: Object.freeze({
    list: Object.freeze({ scope: API_SCOPES.APPROVALS_READ, mutation: false, resourceId: "forbidden", projectId: "required" }),
    get: Object.freeze({ scope: API_SCOPES.APPROVALS_READ, mutation: false, resourceId: "required", projectId: "required" }),
    decide: Object.freeze({ scope: API_SCOPES.APPROVALS_DECIDE, mutation: true, resourceId: "required", projectId: "required" })
  }),
  publishing: Object.freeze({
    list: Object.freeze({ scope: API_SCOPES.PUBLISHING_READ, mutation: false, resourceId: "forbidden", projectId: "required" }),
    get: Object.freeze({ scope: API_SCOPES.PUBLISHING_READ, mutation: false, resourceId: "required", projectId: "required" }),
    approve: Object.freeze({ scope: API_SCOPES.PUBLISHING_APPROVE, mutation: true, resourceId: "required", projectId: "required" })
  }),
  analytics: Object.freeze({
    get: Object.freeze({ scope: API_SCOPES.ANALYTICS_READ, mutation: false, resourceId: "forbidden", projectId: "optional" })
  }),
  organization_exports: Object.freeze({
    create: Object.freeze({
      scope: API_SCOPES.ORGANIZATION_EXPORT,
      mutation: true,
      resourceId: "forbidden",
      projectId: "forbidden",
      organizationWide: true
    }),
    get: Object.freeze({
      scope: API_SCOPES.ORGANIZATION_EXPORT,
      mutation: false,
      resourceId: "required",
      projectId: "forbidden",
      organizationWide: true
    })
  }),
  webhooks: Object.freeze({
    list: Object.freeze({
      scope: API_SCOPES.WEBHOOKS_MANAGE,
      mutation: false,
      resourceId: "forbidden",
      projectId: "forbidden",
      organizationWide: true
    }),
    create: Object.freeze({
      scope: API_SCOPES.WEBHOOKS_MANAGE,
      mutation: true,
      resourceId: "forbidden",
      projectId: "forbidden",
      organizationWide: true
    }),
    update: Object.freeze({
      scope: API_SCOPES.WEBHOOKS_MANAGE,
      mutation: true,
      resourceId: "required",
      projectId: "forbidden",
      organizationWide: true
    }),
    delete: Object.freeze({
      scope: API_SCOPES.WEBHOOKS_MANAGE,
      mutation: true,
      resourceId: "required",
      projectId: "forbidden",
      organizationWide: true
    })
  })
});
const IDEMPOTENCY_STATUSES = new Set(["in_progress", "completed", "failed"]);

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

function isoTimestamp(value, label, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const text = boundedString(value, { label, min: 1, max: 40 });
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return new Date(timestamp).toISOString();
}

function hash(value, label, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const result = boundedString(value, { label, min: 71, max: 71 });
  if (!HASH_PATTERN.test(result)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return result;
}

function safeCode(value, label, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const result = boundedString(value, { label, min: 1, max: 80 });
  if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(result)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return result;
}

function normalizeApiTokenMetadata(raw) {
  const value = plainObject(raw, "API token metadata");
  onlyKeys(
    value,
    new Set([
      "organizationId",
      "tokenId",
      "label",
      "scopes",
      "projectIds",
      "createdByUserId",
      "createdAt",
      "expiresAt",
      "revokedAt",
      "lastUsedAt",
      "rateLimitClass",
      "rotatedFromTokenId"
    ]),
    "API token metadata"
  );
  if (!Array.isArray(value.scopes) || !value.scopes.length || value.scopes.length > ALL_SCOPES.size) {
    throw new AppError("INVALID_INPUT", "API token scopes are invalid.");
  }
  const scopes = [...new Set(value.scopes)];
  if (scopes.some((scope) => typeof scope !== "string" || !ALL_SCOPES.has(scope))) {
    throw new AppError("INVALID_INPUT", "API token scopes are invalid.");
  }
  if (!Object.hasOwn(value, "projectIds") || (value.projectIds !== null && !Array.isArray(value.projectIds))) {
    throw new AppError("INVALID_INPUT", "API token project scope is invalid.");
  }
  if (value.projectIds?.length > 500) throw new AppError("INVALID_INPUT", "API token project scope is too large.");
  const projectIds = value.projectIds === null ? null : [...new Set(value.projectIds.map((item) => requireId(item, "Project")))];
  const createdAt = isoTimestamp(value.createdAt, "API token creation time");
  const expiresAt = isoTimestamp(value.expiresAt, "API token expiry");
  const revokedAt = isoTimestamp(value.revokedAt, "API token revocation", true);
  const lastUsedAt = isoTimestamp(value.lastUsedAt, "API token last-used time", true);
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new AppError("INVALID_INPUT", "API token expiry must follow creation.");
  for (const timestamp of [revokedAt, lastUsedAt].filter(Boolean)) {
    if (Date.parse(timestamp) < Date.parse(createdAt)) {
      throw new AppError("INVALID_INPUT", "API token lifecycle times cannot precede creation.");
    }
  }
  if (lastUsedAt && Date.parse(lastUsedAt) >= Date.parse(expiresAt)) {
    throw new AppError("INVALID_INPUT", "API token use cannot occur at or after expiry.");
  }
  const rateLimitClass = boundedString(value.rateLimitClass, { label: "API rate-limit class", min: 1, max: 40 });
  if (!RATE_LIMIT_CLASSES.has(rateLimitClass)) throw new AppError("INVALID_INPUT", "API rate-limit class is invalid.");
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    tokenId: requireId(value.tokenId, "API token"),
    label: boundedString(value.label, { label: "API token label", min: 1, max: 80 }),
    labelFormat: "plain_text",
    scopes,
    projectIds,
    createdByUserId: requireId(value.createdByUserId, "API token creator"),
    createdAt,
    expiresAt,
    revokedAt,
    lastUsedAt,
    rateLimitClass,
    rotatedFromTokenId: value.rotatedFromTokenId ? requireId(value.rotatedFromTokenId, "Rotated API token") : null
  };
}

function operationDefinition(resourceType, operation) {
  const definition = OPERATION_DEFINITIONS[resourceType]?.[operation];
  if (!definition) throw new AppError("INVALID_INPUT", "API resource and operation are incompatible.");
  return definition;
}

function normalizeApiRequestEnvelope(raw) {
  const value = plainObject(raw, "API request envelope");
  onlyKeys(
    value,
    new Set([
      "apiVersion",
      "requestId",
      "organizationId",
      "projectId",
      "resourceType",
      "resourceId",
      "operation",
      "idempotencyKey",
      "bodyHash",
      "issuedAt"
    ]),
    "API request envelope"
  );
  if (value.apiVersion !== API_VERSION) throw new AppError("API_VERSION_UNSUPPORTED", "The requested API version is unsupported.");
  const resourceType = boundedString(value.resourceType, { label: "API resource type", min: 1, max: 40 });
  const operation = boundedString(value.operation, { label: "API operation", min: 1, max: 40 });
  const definition = operationDefinition(resourceType, operation);
  const projectId = value.projectId ? requireId(value.projectId, "Project") : null;
  const resourceId = value.resourceId ? requireId(value.resourceId, "API resource") : null;
  if (definition.projectId === "required" && !projectId) throw new AppError("INVALID_INPUT", "This API operation requires a project.");
  if (definition.projectId === "forbidden" && projectId) throw new AppError("INVALID_INPUT", "This API operation is organization-scoped.");
  if (definition.resourceId === "required" && !resourceId) throw new AppError("INVALID_INPUT", "This API operation requires a resource.");
  if (definition.resourceId === "forbidden" && resourceId)
    throw new AppError("INVALID_INPUT", "This API operation does not accept a resource.");
  if (resourceType === "projects" && resourceId && projectId !== resourceId) {
    throw new AppError("INVALID_INPUT", "Project API resource and project scope must match.");
  }
  const idempotencyKey = value.idempotencyKey ? requireId(value.idempotencyKey, "Idempotency key") : null;
  const bodyHash = hash(value.bodyHash, "API request body hash", true);
  if (definition.mutation && (!idempotencyKey || !bodyHash)) {
    throw new AppError("INVALID_INPUT", "API mutations require an idempotency key and request-body hash.");
  }
  if (!definition.mutation && (idempotencyKey || bodyHash)) {
    throw new AppError("INVALID_INPUT", "Read-only API operations cannot include mutation idempotency fields.");
  }
  return {
    apiVersion: API_VERSION,
    requestId: requireId(value.requestId, "API request"),
    organizationId: requireId(value.organizationId, "Organization"),
    projectId,
    resourceType,
    resourceId,
    operation,
    requiredScope: definition.scope,
    mutation: definition.mutation,
    idempotencyKey,
    bodyHash,
    issuedAt: isoTimestamp(value.issuedAt, "API request time"),
    organizationWide: definition.organizationWide === true
  };
}

function assertApiScope(rawToken, scope, rawTarget, options = {}) {
  if (!ALL_SCOPES.has(scope)) throw new AppError("INVALID_INPUT", "API scope is invalid.");
  const token = normalizeApiTokenMetadata(rawToken);
  const target = plainObject(rawTarget, "API authorization target");
  onlyKeys(target, new Set(["organizationId", "projectId"]), "API authorization target");
  const organizationId = requireId(target.organizationId, "Organization");
  const projectId = target.projectId ? requireId(target.projectId, "Project") : null;
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  if (token.revokedAt) throw new AppError("API_TOKEN_REVOKED", "This API token has been revoked.");
  if (Date.parse(token.expiresAt) <= now.getTime()) throw new AppError("API_TOKEN_EXPIRED", "This API token has expired.");
  if (token.organizationId !== organizationId) {
    throw new AppError("API_FORBIDDEN", "This API token does not include the requested organization.");
  }
  if (projectId && token.projectIds && !token.projectIds.includes(projectId)) {
    throw new AppError("API_FORBIDDEN", "This API token does not include the requested project.");
  }
  if (!token.scopes.includes(scope)) throw new AppError("API_FORBIDDEN", "This API token does not include the required scope.");
  return {
    organizationId,
    projectId,
    projectFilter: projectId ? [projectId] : token.projectIds,
    tokenId: token.tokenId,
    scope,
    rateLimitClass: token.rateLimitClass
  };
}

function authorizeApiRequest(rawToken, rawRequest, options = {}) {
  const request = normalizeApiRequestEnvelope(rawRequest);
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  const maxSkewMs = boundedInteger(options.maxSkewMs, {
    label: "API request clock skew",
    min: 1_000,
    max: 15 * 60 * 1000,
    fallback: 5 * 60 * 1000
  });
  if (Math.abs(now.getTime() - Date.parse(request.issuedAt)) > maxSkewMs) {
    throw new AppError("API_REQUEST_STALE", "The API request timestamp is outside the accepted window.");
  }
  const authorization = assertApiScope(
    rawToken,
    request.requiredScope,
    { organizationId: request.organizationId, projectId: request.projectId },
    { now }
  );
  if (request.organizationWide && authorization.projectFilter !== null) {
    throw new AppError("API_FORBIDDEN", "This API operation requires an organization-wide token.");
  }
  return { authorization, request };
}

function fingerprintNormalizedRequest(request) {
  if (!request.mutation) throw new AppError("INVALID_INPUT", "Only API mutations have idempotency fingerprints.");
  const canonical = JSON.stringify({
    apiVersion: request.apiVersion,
    organizationId: request.organizationId,
    projectId: request.projectId,
    resourceType: request.resourceType,
    resourceId: request.resourceId,
    operation: request.operation,
    bodyHash: request.bodyHash
  });
  return `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

function apiRequestFingerprint(rawRequest) {
  return fingerprintNormalizedRequest(normalizeApiRequestEnvelope(rawRequest));
}

function normalizeIdempotencyRecord(raw) {
  const value = plainObject(raw, "API idempotency record");
  onlyKeys(
    value,
    new Set([
      "organizationId",
      "tokenId",
      "idempotencyKey",
      "requestFingerprint",
      "status",
      "responseHash",
      "failureCode",
      "createdAt",
      "updatedAt",
      "expiresAt",
      "sequence"
    ]),
    "API idempotency record"
  );
  const status = boundedString(value.status, { label: "Idempotency status", min: 1, max: 40 });
  if (!IDEMPOTENCY_STATUSES.has(status)) throw new AppError("INVALID_INPUT", "Idempotency status is invalid.");
  const createdAt = isoTimestamp(value.createdAt, "Idempotency creation time");
  const updatedAt = isoTimestamp(value.updatedAt, "Idempotency update time");
  const expiresAt = isoTimestamp(value.expiresAt, "Idempotency expiry");
  if (Date.parse(updatedAt) < Date.parse(createdAt) || Date.parse(expiresAt) <= Date.parse(updatedAt)) {
    throw new AppError("INVALID_INPUT", "Idempotency lifecycle timestamps are invalid.");
  }
  const responseHash = hash(value.responseHash, "Idempotency response hash", true);
  const failureCode = safeCode(value.failureCode, "Idempotency failure code", true);
  if (status === "in_progress" && (responseHash || failureCode)) {
    throw new AppError("INVALID_INPUT", "In-progress idempotency records cannot contain a response.");
  }
  if (status === "completed" && (!responseHash || failureCode)) {
    throw new AppError("INVALID_INPUT", "Completed idempotency records require only a response hash.");
  }
  if (status === "failed" && (!responseHash || !failureCode)) {
    throw new AppError("INVALID_INPUT", "Failed idempotency records require a response hash and safe failure code.");
  }
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    tokenId: requireId(value.tokenId, "API token"),
    idempotencyKey: requireId(value.idempotencyKey, "Idempotency key"),
    requestFingerprint: hash(value.requestFingerprint, "Idempotency request fingerprint"),
    status,
    responseHash,
    failureCode,
    createdAt,
    updatedAt,
    expiresAt,
    sequence: boundedInteger(value.sequence, { label: "Idempotency sequence", min: 1, max: 2_147_483_647 })
  };
}

function evaluateIdempotencyRequest(rawRequest, rawExisting, tokenId, options = {}) {
  const request = normalizeApiRequestEnvelope(rawRequest);
  const fingerprint = fingerprintNormalizedRequest(request);
  const normalizedTokenId = requireId(tokenId, "API token");
  if (!rawExisting) {
    return {
      status: "execute",
      organizationId: request.organizationId,
      tokenId: normalizedTokenId,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: fingerprint
    };
  }
  const existing = normalizeIdempotencyRecord(rawExisting);
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  if (
    existing.organizationId !== request.organizationId ||
    existing.tokenId !== normalizedTokenId ||
    existing.idempotencyKey !== request.idempotencyKey
  ) {
    throw new AppError("IDEMPOTENCY_TARGET_MISMATCH", "The idempotency record does not match this API request.");
  }
  if (existing.requestFingerprint !== fingerprint) {
    throw new AppError("IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used for a different API request.");
  }
  if (Date.parse(existing.expiresAt) <= now.getTime()) {
    return { status: "expired", idempotencyKey: existing.idempotencyKey };
  }
  if (existing.status === "in_progress") {
    return { status: "in_progress", idempotencyKey: existing.idempotencyKey };
  }
  return {
    status: "replay",
    outcome: existing.status,
    idempotencyKey: existing.idempotencyKey,
    responseHash: existing.responseHash,
    failureCode: existing.failureCode
  };
}

function evaluateIdempotencyTransition(rawCurrent, rawNext) {
  const current = normalizeIdempotencyRecord(rawCurrent);
  const next = normalizeIdempotencyRecord(rawNext);
  if (JSON.stringify(current) === JSON.stringify(next)) return { status: "idempotent", record: current };
  for (const field of ["organizationId", "tokenId", "idempotencyKey", "requestFingerprint", "createdAt", "expiresAt"]) {
    if (current[field] !== next[field]) throw new AppError("IDEMPOTENCY_TARGET_MISMATCH", "Idempotency identity fields cannot change.");
  }
  if (current.status !== "in_progress") {
    throw new AppError("IDEMPOTENCY_FINAL", "A completed idempotency record cannot be changed.");
  }
  if (next.status === "in_progress" || next.sequence !== current.sequence + 1) {
    throw new AppError("INVALID_INPUT", "Idempotency completion requires the next terminal sequence.");
  }
  if (Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
    throw new AppError("INVALID_INPUT", "Idempotency update time cannot move backward.");
  }
  return { status: "apply", record: next };
}

module.exports = {
  API_SCOPES,
  API_VERSION,
  OPERATION_DEFINITIONS,
  apiRequestFingerprint,
  assertApiScope,
  authorizeApiRequest,
  evaluateIdempotencyRequest,
  evaluateIdempotencyTransition,
  normalizeApiRequestEnvelope,
  normalizeApiTokenMetadata,
  normalizeIdempotencyRecord
};
