const assert = require("node:assert/strict");
const test = require("node:test");
const { API_SCOPES } = require("../electron/developer-platform/api-contract.cjs");
const { issueApiCursorToken } = require("../electron/developer-platform/cursor-credential.cjs");
const {
  API_ERROR_DEFINITIONS,
  authorizeApiPage,
  createApiErrorEnvelope,
  evaluateApiRateLimit,
  normalizeApiCursorRecord,
  normalizeApiErrorEnvelope,
  normalizeApiOperationalAudit,
  normalizeApiSuccessEnvelope,
  normalizeRateLimitRecord
} = require("../electron/developer-platform/runtime-contract.cjs");

const NOW = new Date("2026-07-25T12:00:30.000Z");
const HASH = `sha256:${"1".repeat(64)}`;
const CURSOR_SIGNING_KEY = Buffer.alloc(32, 7);

function token(overrides = {}) {
  return {
    organizationId: "organization-a",
    tokenId: "token-a",
    label: "Editing integration",
    scopes: [API_SCOPES.PROJECTS_READ, API_SCOPES.PROJECTS_WRITE],
    projectIds: ["project-a"],
    createdByUserId: "user-a",
    createdAt: "2026-07-25T09:00:00.000Z",
    expiresAt: "2026-08-25T09:00:00.000Z",
    revokedAt: null,
    lastUsedAt: null,
    rateLimitClass: "standard",
    rotatedFromTokenId: null,
    ...overrides
  };
}

function listRequest(overrides = {}) {
  return {
    apiVersion: "v1",
    requestId: "request-a",
    organizationId: "organization-a",
    projectId: null,
    resourceType: "projects",
    resourceId: null,
    operation: "list",
    idempotencyKey: null,
    bodyHash: null,
    issuedAt: "2026-07-25T12:00:00.000Z",
    ...overrides
  };
}

function mutationRequest(overrides = {}) {
  return {
    apiVersion: "v1",
    requestId: "request-a",
    organizationId: "organization-a",
    projectId: "project-a",
    resourceType: "projects",
    resourceId: "project-a",
    operation: "update",
    idempotencyKey: "idempotency-a",
    bodyHash: HASH,
    issuedAt: "2026-07-25T12:00:00.000Z",
    ...overrides
  };
}

function cursor(overrides = {}) {
  return {
    apiVersion: "v1",
    cursorId: "cursor-a",
    organizationId: "organization-a",
    tokenId: "token-a",
    projectId: null,
    resourceType: "projects",
    queryHash: HASH,
    snapshotRevision: 7,
    offset: 50,
    pageSize: 50,
    createdAt: "2026-07-25T11:55:00.000Z",
    expiresAt: "2026-07-25T12:30:00.000Z",
    ...overrides
  };
}

function rateRecord(overrides = {}) {
  return {
    apiVersion: "v1",
    organizationId: "organization-a",
    tokenId: "token-a",
    rateLimitClass: "standard",
    windowStartedAt: "2026-07-25T12:00:00.000Z",
    windowEndsAt: "2026-07-25T12:01:00.000Z",
    used: 20,
    limit: 300,
    updatedAt: "2026-07-25T12:00:20.000Z",
    sequence: 2,
    ...overrides
  };
}

function signedCursor(value = cursor(), now = NOW) {
  return issueApiCursorToken(value, CURSOR_SIGNING_KEY, { now });
}

function audit(overrides = {}) {
  return {
    apiVersion: "v1",
    auditId: "audit-a",
    organizationId: "organization-a",
    projectId: "project-a",
    tokenId: "token-a",
    requestId: "request-a",
    resourceType: "projects",
    operation: "update",
    outcome: "success",
    statusCode: 200,
    errorCode: null,
    rateLimitClass: "standard",
    durationBucket: "under_100ms",
    occurredAt: NOW.toISOString(),
    ...overrides
  };
}

test("API cursors are short-lived and bound to the exact list authorization and query", () => {
  const first = authorizeApiPage(token(), listRequest(), { limit: 50, cursorToken: null, queryHash: HASH }, null, {
    now: NOW,
    cursorSigningKey: CURSOR_SIGNING_KEY
  });
  assert.equal(first.cursor, null);
  const nextRecord = cursor();
  const next = authorizeApiPage(
    token(),
    listRequest({ requestId: "request-next" }),
    { limit: 50, cursorToken: signedCursor(nextRecord), queryHash: HASH },
    nextRecord,
    { now: NOW, cursorSigningKey: CURSOR_SIGNING_KEY }
  );
  assert.equal(next.cursor.offset, 50);
  const expired = cursor({ expiresAt: NOW.toISOString() });
  const validToken = signedCursor();
  const replacement = validToken.endsWith("A") ? "B" : "A";
  for (const invalid of [
    { page: { limit: 25, cursorToken: signedCursor(), queryHash: HASH }, record: cursor() },
    {
      page: { limit: 50, cursorToken: `${validToken.slice(0, -1)}${replacement}`, queryHash: HASH },
      record: cursor()
    },
    {
      page: { limit: 50, cursorToken: signedCursor(), queryHash: `sha256:${"2".repeat(64)}` },
      record: cursor()
    },
    {
      page: { limit: 50, cursorToken: signedCursor(), queryHash: HASH },
      record: cursor({ tokenId: "token-b" })
    },
    {
      page: {
        limit: 50,
        cursorToken: signedCursor(expired, new Date("2026-07-25T12:00:00.000Z")),
        queryHash: HASH
      },
      record: expired
    }
  ]) {
    assert.throws(
      () =>
        authorizeApiPage(token(), listRequest(), invalid.page, invalid.record, {
          now: NOW,
          cursorSigningKey: CURSOR_SIGNING_KEY
        }),
      (error) => ["API_CURSOR_EXPIRED", "API_CURSOR_INVALID", "API_CURSOR_MISMATCH"].includes(error.code)
    );
  }
  assert.throws(
    () =>
      authorizeApiPage(token(), mutationRequest(), { limit: 50, cursorToken: null, queryHash: HASH }, null, {
        now: NOW,
        cursorSigningKey: CURSOR_SIGNING_KEY
      }),
    (error) => error.code === "INVALID_INPUT"
  );
});

test("API cursor records reject excessive lifetime, invalid list scope, and sensitive fields", () => {
  assert.equal(normalizeApiCursorRecord(cursor()).pageSize, 50);
  for (const invalid of [
    cursor({ expiresAt: "2026-07-25T13:00:01.000Z" }),
    cursor({ resourceType: "analytics" }),
    cursor({ resourceType: "jobs", projectId: null }),
    cursor({ resourceType: "webhooks", projectId: "project-a" }),
    { ...cursor(), sourcePath: "/private/project.json" },
    { ...cursor(), token: "must-not-persist" },
    { ...cursor(), query: "raw customer query" }
  ]) {
    assert.throws(
      () => normalizeApiCursorRecord(invalid),
      (error) => ["INVALID_INPUT"].includes(error.code)
    );
  }
});

test("API success metadata is hash-bound, bounded, and pagination-aware", () => {
  const nextCursor = signedCursor();
  const normalized = normalizeApiSuccessEnvelope({
    apiVersion: "v1",
    requestId: "request-a",
    organizationId: "organization-a",
    projectId: null,
    resourceType: "projects",
    operation: "list",
    statusCode: 200,
    dataHash: HASH,
    resultCount: 50,
    nextCursor,
    completedAt: NOW.toISOString()
  });
  assert.equal(normalized.nextCursor, nextCursor);
  for (const invalid of [
    { ...normalized, resultCount: 101 },
    { ...normalized, data: [{ title: "Raw data stays outside metadata." }] },
    { ...normalized, headers: { authorization: "must-not-persist" } },
    { ...normalized, localPath: "/private/result.json" },
    {
      ...normalized,
      operation: "get",
      resultCount: 2,
      nextCursor
    },
    { ...normalized, resourceType: "jobs", operation: "list", projectId: null }
  ]) {
    assert.throws(
      () => normalizeApiSuccessEnvelope(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("API errors use fixed safe messages and rate-limit retry metadata only", () => {
  const limited = createApiErrorEnvelope({
    requestId: "request-a",
    code: "API_RATE_LIMITED",
    retryAfterSeconds: 30,
    completedAt: NOW.toISOString()
  });
  assert.deepEqual(limited.error, {
    code: "API_RATE_LIMITED",
    message: API_ERROR_DEFINITIONS.API_RATE_LIMITED.message,
    retryable: true,
    retryAfterSeconds: 30
  });
  const internal = createApiErrorEnvelope({
    requestId: "request-b",
    code: "API_INTERNAL_ERROR",
    completedAt: NOW.toISOString()
  });
  assert.equal(internal.error.message, "ProduDash could not complete the API request.");
  for (const invalid of [
    { ...limited, stack: "must-not-persist" },
    { ...limited, error: { ...limited.error, message: "Raw provider error" } },
    { ...limited, error: { ...limited.error, rawError: "must-not-persist" } },
    { ...limited, statusCode: 500 },
    { ...internal, error: { ...internal.error, retryAfterSeconds: 30 } }
  ]) {
    assert.throws(
      () => normalizeApiErrorEnvelope(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("API rate limits are concrete, operation-weighted, isolated, and reset by fixed windows", () => {
  const first = evaluateApiRateLimit(token(), listRequest(), null, { now: NOW });
  assert.equal(first.cost, 1);
  assert.equal(first.record.limit, 300);
  const mutation = evaluateApiRateLimit(token(), mutationRequest(), rateRecord(), { now: NOW });
  assert.equal(mutation.cost, 5);
  assert.equal(mutation.record.used, 25);
  assert.equal(mutation.record.sequence, 3);
  const denied = evaluateApiRateLimit(token(), mutationRequest(), rateRecord({ used: 298 }), { now: NOW });
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 30);
  assert.equal(denied.record.used, 298);
  const reset = evaluateApiRateLimit(token(), mutationRequest({ issuedAt: "2026-07-25T12:01:00.000Z" }), rateRecord(), {
    now: new Date("2026-07-25T12:01:05.000Z")
  });
  assert.equal(reset.allowed, true);
  assert.equal(reset.record.used, 5);
  assert.equal(reset.record.sequence, 3);
  for (const invalid of [
    rateRecord({ tokenId: "token-b" }),
    rateRecord({ organizationId: "organization-b" }),
    rateRecord({ rateLimitClass: "high", limit: 1200 }),
    rateRecord({ limit: 999 }),
    { ...rateRecord(), ipAddress: "203.0.113.10" }
  ]) {
    assert.throws(
      () => evaluateApiRateLimit(token(), mutationRequest(), invalid, { now: NOW }),
      (error) => ["INVALID_INPUT", "RATE_LIMIT_TARGET_MISMATCH"].includes(error.code)
    );
  }
  assert.throws(
    () => normalizeRateLimitRecord(rateRecord({ windowEndsAt: "2026-07-25T12:02:00.000Z" })),
    (error) => error.code === "INVALID_INPUT"
  );
});

test("API operational audit records keep only safe codes and coarse timing", () => {
  assert.equal(normalizeApiOperationalAudit(audit()).outcome, "success");
  assert.equal(
    normalizeApiOperationalAudit(
      audit({
        tokenId: null,
        outcome: "denied",
        statusCode: 401,
        errorCode: "API_UNAUTHENTICATED"
      })
    ).tokenId,
    null
  );
  assert.equal(
    normalizeApiOperationalAudit(
      audit({
        outcome: "rate_limited",
        statusCode: 429,
        errorCode: "API_RATE_LIMITED"
      })
    ).outcome,
    "rate_limited"
  );
  for (const invalid of [
    audit({ outcome: "success", errorCode: "API_INTERNAL_ERROR", statusCode: 500 }),
    audit({ outcome: "denied", errorCode: "API_NOT_FOUND", statusCode: 404 }),
    audit({ outcome: "rate_limited", errorCode: "API_SERVICE_UNAVAILABLE", statusCode: 503 }),
    audit({ tokenId: null }),
    audit({ resourceType: "organization_exports", operation: "get", projectId: "project-a" }),
    audit({ durationBucket: "137ms" }),
    { ...audit(), requestBody: { title: "must-not-persist" } },
    { ...audit(), headers: { authorization: "must-not-persist" } },
    { ...audit(), ipAddress: "203.0.113.10" },
    { ...audit(), stack: "must-not-persist" }
  ]) {
    assert.throws(
      () => normalizeApiOperationalAudit(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});
