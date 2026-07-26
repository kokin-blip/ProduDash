const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertApiCredentialRotation,
  evaluateApiCredentialTransition,
  issueApiCredential,
  normalizeApiCredentialRecord,
  verifyApiCredential
} = require("../electron/developer-platform/token-credential.cjs");
const { API_SCOPES } = require("../electron/developer-platform/api-contract.cjs");

const NOW = new Date("2026-07-25T12:00:00.000Z");

function metadata(overrides = {}) {
  return {
    organizationId: "organization-a",
    tokenId: "token-a",
    label: "Editing integration",
    scopes: [API_SCOPES.PROJECTS_READ, API_SCOPES.PROJECTS_WRITE],
    projectIds: ["project-a"],
    createdByUserId: "user-a",
    createdAt: "2026-07-25T12:00:00.000Z",
    expiresAt: "2026-08-25T12:00:00.000Z",
    revokedAt: null,
    lastUsedAt: null,
    rateLimitClass: "standard",
    rotatedFromTokenId: null,
    ...overrides
  };
}

function deterministicBytes(length) {
  assert.equal(length, 44);
  return Buffer.from(Array.from({ length }, (_, index) => index + 1));
}

function issued(rawMetadata = metadata()) {
  return issueApiCredential(rawMetadata, { now: NOW, randomBytes: deterministicBytes });
}

test("API credential issuance returns one high-entropy bearer and stores only its hash", () => {
  const result = issued();
  assert.match(result.bearerToken, /^pd_v1_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/);
  assert.match(result.credentialRecord.bearerHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.credentialRecord.lookupId.length, 16);
  assert.equal(JSON.stringify(result.credentialRecord).includes(result.bearerToken), false);
  for (const field of ["secret", "bearerToken", "authorization", "headers"]) {
    assert.equal(Object.hasOwn(result.credentialRecord, field), false);
  }
  assert.throws(
    () => issueApiCredential(metadata(), { now: NOW, randomBytes: () => Buffer.alloc(43) }),
    (error) => error.code === "API_CREDENTIAL_GENERATION_FAILED"
  );
  assert.throws(
    () =>
      issueApiCredential(metadata(), {
        now: NOW,
        randomBytes: () => {
          throw new Error("raw operating-system error");
        }
      }),
    (error) => error.code === "API_CREDENTIAL_GENERATION_FAILED" && !error.message.includes("operating-system")
  );
  for (const invalid of [
    metadata({ createdAt: "2026-07-25T11:54:59.000Z" }),
    metadata({ createdAt: "2026-07-25T12:00:01.000Z" }),
    metadata({ revokedAt: "2026-07-25T12:00:00.000Z" }),
    metadata({
      createdAt: "2026-07-25T11:59:00.000Z",
      expiresAt: "2026-07-25T12:00:00.000Z"
    })
  ]) {
    assert.throws(
      () => issueApiCredential(invalid, { now: NOW, randomBytes: deterministicBytes }),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("API credential verification is constant-shape and returns no bearer material", () => {
  const result = issued();
  assert.deepEqual(verifyApiCredential(result.bearerToken, result.credentialRecord, metadata(), { now: NOW }), {
    verified: true,
    organizationId: "organization-a",
    tokenId: "token-a"
  });
  for (const invalidBearer of [
    "not-a-token",
    `${result.bearerToken.slice(0, -1)}A`,
    result.bearerToken.replace(result.credentialRecord.lookupId, "AAAAAAAAAAAAAAAA"),
    ` ${result.bearerToken}`
  ]) {
    assert.throws(
      () => verifyApiCredential(invalidBearer, result.credentialRecord, metadata(), { now: NOW }),
      (error) => error.code === "API_UNAUTHENTICATED"
    );
  }
});

test("API credential verification enforces metadata identity, revocation, and expiry", () => {
  const result = issued();
  assert.throws(
    () => verifyApiCredential(result.bearerToken, result.credentialRecord, metadata({ organizationId: "organization-b" }), { now: NOW }),
    (error) => error.code === "API_CREDENTIAL_MISMATCH"
  );
  assert.throws(
    () =>
      verifyApiCredential(
        result.bearerToken,
        {
          ...result.credentialRecord,
          createdAt: "2026-07-25T09:00:00.000Z",
          expiresAt: "2026-07-25T11:59:00.000Z"
        },
        metadata({
          createdAt: "2026-07-25T09:00:00.000Z",
          expiresAt: "2026-07-25T11:59:00.000Z"
        }),
        { now: NOW }
      ),
    (error) => error.code === "API_TOKEN_EXPIRED"
  );
  const revokedAt = "2026-07-25T12:01:00.000Z";
  assert.throws(
    () =>
      verifyApiCredential(result.bearerToken, { ...result.credentialRecord, revokedAt, sequence: 2 }, metadata({ revokedAt }), {
        now: new Date("2026-07-25T12:02:00.000Z")
      }),
    (error) => error.code === "API_TOKEN_REVOKED"
  );
});

test("API credential records reject plaintext material and invalid lifecycle fields", () => {
  const record = issued().credentialRecord;
  assert.equal(normalizeApiCredentialRecord(record).tokenId, "token-a");
  for (const invalid of [
    { ...record, bearerToken: "must-not-persist" },
    { ...record, secret: "must-not-persist" },
    { ...record, authorization: "must-not-persist" },
    { ...record, bearerHash: "sha256:short" },
    { ...record, lookupId: "short" },
    { ...record, expiresAt: record.createdAt },
    { ...record, revokedAt: "2026-07-25T11:59:00.000Z" },
    { ...record, sequence: 0 }
  ]) {
    assert.throws(
      () => normalizeApiCredentialRecord(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("API credential revocation is consecutive, idempotent, and irreversible", () => {
  const active = issued().credentialRecord;
  const revoked = {
    ...active,
    revokedAt: "2026-07-25T12:01:00.000Z",
    sequence: 2
  };
  assert.equal(evaluateApiCredentialTransition(active, revoked).status, "apply");
  assert.equal(evaluateApiCredentialTransition(revoked, revoked).status, "idempotent");
  assert.throws(
    () => evaluateApiCredentialTransition(revoked, { ...active, sequence: 3 }),
    (error) => error.code === "API_CREDENTIAL_FINAL"
  );
  assert.throws(
    () => evaluateApiCredentialTransition(active, { ...revoked, bearerHash: `sha256:${"f".repeat(64)}` }),
    (error) => error.code === "API_CREDENTIAL_MISMATCH"
  );
  assert.throws(
    () => evaluateApiCredentialTransition(active, { ...revoked, sequence: 3 }),
    (error) => error.code === "INVALID_INPUT"
  );
});

test("API credential rotation requires explicit linkage and preserves privileges", () => {
  const previousIssued = issued();
  const revokedAt = "2026-07-25T12:01:00.000Z";
  const previousMetadata = metadata({ revokedAt });
  const previousCredential = { ...previousIssued.credentialRecord, revokedAt, sequence: 2 };
  const nextMetadata = metadata({
    tokenId: "token-b",
    createdAt: revokedAt,
    expiresAt: "2026-08-25T12:01:00.000Z",
    rotatedFromTokenId: "token-a"
  });
  const nextIssued = issueApiCredential(nextMetadata, {
    now: new Date(revokedAt),
    randomBytes: (length) => Buffer.alloc(length, 9)
  });
  assert.deepEqual(assertApiCredentialRotation(previousMetadata, previousCredential, nextMetadata, nextIssued.credentialRecord), {
    valid: true,
    organizationId: "organization-a",
    previousTokenId: "token-a",
    nextTokenId: "token-b"
  });
  const reorderedMetadata = {
    ...nextMetadata,
    scopes: [...nextMetadata.scopes].reverse()
  };
  assert.equal(
    assertApiCredentialRotation(previousMetadata, previousCredential, reorderedMetadata, nextIssued.credentialRecord).valid,
    true
  );
  for (const invalidMetadata of [
    { ...nextMetadata, organizationId: "organization-b" },
    { ...nextMetadata, rotatedFromTokenId: null },
    { ...nextMetadata, scopes: [...nextMetadata.scopes, API_SCOPES.JOBS_READ] },
    { ...nextMetadata, projectIds: null },
    { ...nextMetadata, rateLimitClass: "high" },
    { ...nextMetadata, createdAt: "2026-07-25T12:00:30.000Z" }
  ]) {
    const matchingCredential = {
      ...nextIssued.credentialRecord,
      organizationId: invalidMetadata.organizationId,
      createdAt: invalidMetadata.createdAt
    };
    assert.throws(
      () => assertApiCredentialRotation(previousMetadata, previousCredential, invalidMetadata, matchingCredential),
      (error) => ["INVALID_API_ROTATION", "API_CREDENTIAL_MISMATCH"].includes(error.code)
    );
  }
});
