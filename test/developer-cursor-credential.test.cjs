const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CURSOR_TOKEN_PATTERN,
  issueApiCursorToken,
  normalizeApiCursorRecord,
  verifyApiCursorToken
} = require("../electron/developer-platform/cursor-credential.cjs");

const NOW = new Date("2026-07-25T12:00:00.000Z");
const HASH = `sha256:${"1".repeat(64)}`;
const SIGNING_KEY = Buffer.alloc(32, 9);

function cursor(overrides = {}) {
  return {
    apiVersion: "v1",
    cursorId: "cursor-a",
    organizationId: "organization-a",
    tokenId: "token-a",
    projectId: "project-a",
    resourceType: "jobs",
    queryHash: HASH,
    snapshotRevision: 7,
    offset: 50,
    pageSize: 50,
    createdAt: "2026-07-25T11:55:00.000Z",
    expiresAt: "2026-07-25T12:30:00.000Z",
    ...overrides
  };
}

function target(overrides = {}) {
  return {
    organizationId: "organization-a",
    tokenId: "token-a",
    projectId: "project-a",
    resourceType: "jobs",
    queryHash: HASH,
    pageSize: 50,
    ...overrides
  };
}

test("cursor issuance creates a bounded signed token without exposing its signing key", () => {
  const cursorToken = issueApiCursorToken(cursor(), SIGNING_KEY, { now: NOW });
  assert.match(cursorToken, CURSOR_TOKEN_PATTERN);
  assert.equal(cursorToken.includes(SIGNING_KEY.toString("base64url")), false);
  assert.deepEqual(verifyApiCursorToken(cursorToken, cursor(), SIGNING_KEY, target(), { now: NOW }), normalizeApiCursorRecord(cursor()));
});

test("cursor verification rejects tampering, the wrong key, stale tokens, and changed records", () => {
  const cursorToken = issueApiCursorToken(cursor(), SIGNING_KEY, { now: NOW });
  const replacement = cursorToken.endsWith("A") ? "B" : "A";
  const tampered = `${cursorToken.slice(0, -1)}${replacement}`;
  for (const attempt of [
    () => verifyApiCursorToken(tampered, cursor(), SIGNING_KEY, target(), { now: NOW }),
    () => verifyApiCursorToken(cursorToken, cursor(), Buffer.alloc(32, 8), target(), { now: NOW }),
    () => verifyApiCursorToken(cursorToken, cursor({ offset: 100 }), SIGNING_KEY, target(), { now: NOW }),
    () => verifyApiCursorToken(cursorToken, cursor(), SIGNING_KEY, target(), { now: new Date("2026-07-25T12:30:00.000Z") })
  ]) {
    assert.throws(attempt, (error) => ["API_CURSOR_EXPIRED", "API_CURSOR_INVALID"].includes(error.code));
  }
});

test("cursor verification is tenant, token, project, resource, query, and page-size scoped", () => {
  const cursorToken = issueApiCursorToken(cursor(), SIGNING_KEY, { now: NOW });
  for (const mismatch of [
    { organizationId: "organization-b" },
    { tokenId: "token-b" },
    { projectId: "project-b" },
    { resourceType: "approvals" },
    { queryHash: `sha256:${"2".repeat(64)}` },
    { pageSize: 25 }
  ]) {
    assert.throws(
      () => verifyApiCursorToken(cursorToken, cursor(), SIGNING_KEY, target(mismatch), { now: NOW }),
      (error) => error.code === "API_CURSOR_MISMATCH"
    );
  }
});

test("cursor records and targets reject secret, path, and unsupported fields", () => {
  for (const invalid of [
    { ...cursor(), signingKey: "secret" },
    { ...cursor(), sourcePath: "/private/source.mp4" },
    { ...cursor(), query: "raw customer query" }
  ]) {
    assert.throws(
      () => normalizeApiCursorRecord(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
  assert.throws(
    () => verifyApiCursorToken("cursor-a", cursor(), SIGNING_KEY, target(), { now: NOW }),
    (error) => error.code === "API_CURSOR_INVALID"
  );
});
