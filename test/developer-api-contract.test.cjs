const assert = require("node:assert/strict");
const test = require("node:test");
const {
  API_SCOPES,
  API_VERSION,
  apiRequestFingerprint,
  assertApiScope,
  authorizeApiRequest,
  evaluateIdempotencyRequest,
  evaluateIdempotencyTransition,
  normalizeApiTokenMetadata,
  normalizeIdempotencyRecord
} = require("../electron/developer-platform/api-contract.cjs");

const NOW = new Date("2026-07-25T12:00:00.000Z");
const BODY_HASH = `sha256:${"1".repeat(64)}`;
const RESPONSE_HASH = `sha256:${"2".repeat(64)}`;

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

function request(overrides = {}) {
  return {
    apiVersion: API_VERSION,
    requestId: "request-a",
    organizationId: "organization-a",
    projectId: "project-a",
    resourceType: "projects",
    resourceId: "project-a",
    operation: "update",
    idempotencyKey: "idempotency-a",
    bodyHash: BODY_HASH,
    issuedAt: "2026-07-25T11:59:00.000Z",
    ...overrides
  };
}

function idempotencyRecord(overrides = {}) {
  return {
    organizationId: "organization-a",
    tokenId: "token-a",
    idempotencyKey: "idempotency-a",
    requestFingerprint: apiRequestFingerprint(request()),
    status: "in_progress",
    responseHash: null,
    failureCode: null,
    createdAt: "2026-07-25T11:59:00.000Z",
    updatedAt: "2026-07-25T11:59:00.000Z",
    expiresAt: "2026-07-26T11:59:00.000Z",
    sequence: 1,
    ...overrides
  };
}

test("API token metadata is scoped, bounded, and excludes bearer secrets", () => {
  const normalized = normalizeApiTokenMetadata(token({ label: `<img src=x onerror="steal()">` }));
  assert.equal(normalized.labelFormat, "plain_text");
  assert.deepEqual(normalized.projectIds, ["project-a"]);
  for (const invalid of [
    { ...token(), token: "bearer-secret" },
    { ...token(), secret: "bearer-secret" },
    { ...token(), tokenDigest: `sha256:${"3".repeat(64)}` },
    { ...token(), authorization: "Bearer secret" },
    token({ scopes: ["projects:delete"] }),
    token({ projectIds: Array.from({ length: 501 }, (_, index) => `project-${index}`) }),
    token({ expiresAt: "2026-07-25T08:00:00.000Z" }),
    token({ lastUsedAt: "2026-08-25T09:00:00.000Z" }),
    token({ rateLimitClass: "unlimited" })
  ]) {
    assert.throws(
      () => normalizeApiTokenMetadata(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("API scope checks fail closed for missing scope, projects, tenants, expiry, and revocation", () => {
  assert.equal(
    assertApiScope(token(), API_SCOPES.PROJECTS_WRITE, { organizationId: "organization-a", projectId: "project-a" }, { now: NOW }).scope,
    API_SCOPES.PROJECTS_WRITE
  );
  const attempts = [
    {
      value: token({ scopes: [API_SCOPES.PROJECTS_READ] }),
      target: { organizationId: "organization-a", projectId: "project-a" },
      code: "API_FORBIDDEN"
    },
    {
      value: token(),
      target: { organizationId: "organization-a", projectId: "project-b" },
      code: "API_FORBIDDEN"
    },
    {
      value: token(),
      target: { organizationId: "organization-b", projectId: "project-a" },
      code: "API_FORBIDDEN"
    },
    {
      value: token({ expiresAt: "2026-07-25T11:00:00.000Z" }),
      target: { organizationId: "organization-a", projectId: "project-a" },
      code: "API_TOKEN_EXPIRED"
    },
    {
      value: token({ revokedAt: "2026-07-25T11:00:00.000Z" }),
      target: { organizationId: "organization-a", projectId: "project-a" },
      code: "API_TOKEN_REVOKED"
    }
  ];
  for (const attempt of attempts) {
    assert.throws(
      () => assertApiScope(attempt.value, API_SCOPES.PROJECTS_WRITE, attempt.target, { now: NOW }),
      (error) => error.code === attempt.code
    );
  }
});

test("API operations use minimal scopes and keep reads distinct from mutations", () => {
  assert.equal(authorizeApiRequest(token(), request(), { now: NOW }).authorization.scope, API_SCOPES.PROJECTS_WRITE);
  const read = request({
    requestId: "request-read",
    operation: "get",
    idempotencyKey: null,
    bodyHash: null
  });
  assert.equal(authorizeApiRequest(token(), read, { now: NOW }).authorization.scope, API_SCOPES.PROJECTS_READ);
  const create = request({
    requestId: "request-create",
    projectId: null,
    resourceId: null,
    operation: "create"
  });
  assert.throws(
    () => authorizeApiRequest(token(), create, { now: NOW }),
    (error) => error.code === "API_FORBIDDEN"
  );
  assert.equal(authorizeApiRequest(token({ projectIds: null }), create, { now: NOW }).authorization.scope, API_SCOPES.PROJECTS_WRITE);
  for (const invalid of [
    request({ apiVersion: "v2" }),
    request({ operation: "delete" }),
    request({ idempotencyKey: null }),
    request({ bodyHash: null }),
    request({ projectId: "project-b" }),
    request({ resourceId: "project-b" }),
    { ...request(), body: { title: "Raw body must stay outside the envelope" } },
    { ...request(), headers: { authorization: "Bearer secret" } },
    { ...request(), url: "https://example.com/projects/project-a" },
    { ...read, idempotencyKey: "unexpected" }
  ]) {
    assert.throws(
      () => authorizeApiRequest(token(), invalid, { now: NOW }),
      (error) => ["INVALID_INPUT", "API_VERSION_UNSUPPORTED", "API_FORBIDDEN"].includes(error.code)
    );
  }
  assert.throws(
    () => authorizeApiRequest(token(), request({ issuedAt: "2026-07-25T11:00:00.000Z" }), { now: NOW }),
    (error) => error.code === "API_REQUEST_STALE"
  );
});

test("API request fingerprints ignore retry transport identifiers but bind logical mutation content", () => {
  const first = apiRequestFingerprint(request());
  assert.equal(first, apiRequestFingerprint(request({ requestId: "request-retry", issuedAt: "2026-07-25T12:01:00.000Z" })));
  assert.notEqual(first, apiRequestFingerprint(request({ bodyHash: `sha256:${"4".repeat(64)}` })));
  assert.throws(
    () =>
      apiRequestFingerprint(
        request({
          operation: "get",
          idempotencyKey: null,
          bodyHash: null
        })
      ),
    (error) => error.code === "INVALID_INPUT"
  );
});

test("idempotency records execute once, replay terminal hashes, and reject key reuse", () => {
  assert.equal(evaluateIdempotencyRequest(request(), null, "token-a", { now: NOW }).status, "execute");
  assert.equal(evaluateIdempotencyRequest(request(), idempotencyRecord(), "token-a", { now: NOW }).status, "in_progress");
  const completed = idempotencyRecord({
    status: "completed",
    responseHash: RESPONSE_HASH,
    updatedAt: "2026-07-25T12:00:00.000Z",
    sequence: 2
  });
  assert.deepEqual(evaluateIdempotencyRequest(request(), completed, "token-a", { now: NOW }), {
    status: "replay",
    outcome: "completed",
    idempotencyKey: "idempotency-a",
    responseHash: RESPONSE_HASH,
    failureCode: null
  });
  assert.throws(
    () => evaluateIdempotencyRequest(request({ bodyHash: `sha256:${"4".repeat(64)}` }), completed, "token-a", { now: NOW }),
    (error) => error.code === "IDEMPOTENCY_KEY_REUSED"
  );
  assert.throws(
    () => evaluateIdempotencyRequest(request(), completed, "token-b", { now: NOW }),
    (error) => error.code === "IDEMPOTENCY_TARGET_MISMATCH"
  );
  assert.equal(
    evaluateIdempotencyRequest(request(), completed, "token-a", { now: new Date("2026-07-27T12:00:00.000Z") }).status,
    "expired"
  );
});

test("idempotency transitions are consecutive, terminal, and path-free", () => {
  const current = idempotencyRecord();
  const completed = idempotencyRecord({
    status: "completed",
    responseHash: RESPONSE_HASH,
    updatedAt: "2026-07-25T12:00:00.000Z",
    sequence: 2
  });
  assert.equal(evaluateIdempotencyTransition(current, completed).status, "apply");
  assert.equal(evaluateIdempotencyTransition(completed, completed).status, "idempotent");
  assert.throws(
    () =>
      evaluateIdempotencyTransition(
        completed,
        idempotencyRecord({
          status: "failed",
          responseHash: RESPONSE_HASH,
          failureCode: "FAILED",
          updatedAt: "2026-07-25T12:01:00.000Z",
          sequence: 3
        })
      ),
    (error) => error.code === "IDEMPOTENCY_FINAL"
  );
  for (const invalid of [
    { ...current, responseBody: { localPath: "/must/not/store" } },
    { ...current, responseHeaders: { authorization: "secret" } },
    { ...current, failureCode: "raw provider error" },
    { ...current, requestFingerprint: "sha256:short" }
  ]) {
    assert.throws(
      () => normalizeIdempotencyRecord(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});
