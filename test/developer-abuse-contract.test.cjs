const assert = require("node:assert/strict");
const test = require("node:test");
const {
  evaluateApiAbuseRestriction,
  evaluateApiAbuseTransition,
  normalizeApiAbuseRecord
} = require("../electron/developer-platform/abuse-contract.cjs");

const NOW = new Date("2026-07-25T12:30:00.000Z");

function record(overrides = {}) {
  return {
    apiVersion: "v1",
    signalId: "signal-a",
    organizationId: "organization-a",
    tokenId: "token-a",
    eventType: "rate_limit_exceeded",
    count: 5,
    disposition: "observe",
    windowStartedAt: "2026-07-25T12:00:00.000Z",
    windowEndsAt: "2026-07-25T13:00:00.000Z",
    createdAt: "2026-07-25T12:20:00.000Z",
    blockedUntil: null,
    expiresAt: "2026-08-24T12:20:00.000Z",
    sequence: 1,
    ...overrides
  };
}

test("API abuse records are bounded, retained for at most 30 days, and contain no request data", () => {
  assert.equal(normalizeApiAbuseRecord(record()).disposition, "observe");
  for (const invalid of [
    record({ eventType: "unknown_event" }),
    record({ windowEndsAt: "2026-07-25T13:00:01.000Z" }),
    record({ createdAt: "2026-07-25T13:00:01.000Z" }),
    record({ expiresAt: "2026-08-24T12:20:01.000Z" }),
    record({ count: 0 }),
    { ...record(), ipAddress: "203.0.113.10" },
    { ...record(), authorization: "must-not-persist" },
    { ...record(), requestBody: { title: "must-not-persist" } },
    { ...record(), headers: { cookie: "must-not-persist" } },
    { ...record(), stack: "must-not-persist" }
  ]) {
    assert.throws(
      () => normalizeApiAbuseRecord(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("temporary API restrictions require one token and a maximum 24-hour block", () => {
  const blocked = record({
    disposition: "temporarily_blocked",
    blockedUntil: "2026-07-26T12:20:00.000Z",
    sequence: 2
  });
  assert.equal(normalizeApiAbuseRecord(blocked).tokenId, "token-a");
  for (const invalid of [
    { ...blocked, tokenId: null },
    { ...blocked, blockedUntil: "2026-07-26T12:20:01.000Z" },
    { ...blocked, blockedUntil: null },
    record({ blockedUntil: "2026-07-25T13:00:00.000Z" })
  ]) {
    assert.throws(
      () => normalizeApiAbuseRecord(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("API abuse disposition transitions preserve evidence and become terminal", () => {
  const observed = record();
  const blocked = record({
    count: 6,
    disposition: "temporarily_blocked",
    blockedUntil: "2026-07-25T18:20:00.000Z",
    sequence: 2
  });
  assert.equal(evaluateApiAbuseTransition(observed, blocked).status, "apply");
  assert.equal(evaluateApiAbuseTransition(blocked, blocked).status, "idempotent");
  assert.throws(
    () => evaluateApiAbuseTransition(blocked, { ...blocked, disposition: "review_required", blockedUntil: null, sequence: 3 }),
    (error) => error.code === "API_ABUSE_FINAL"
  );
  assert.throws(
    () => evaluateApiAbuseTransition(observed, { ...blocked, count: 4 }),
    (error) => error.code === "INVALID_INPUT"
  );
  assert.throws(
    () => evaluateApiAbuseTransition(observed, { ...blocked, tokenId: "token-b" }),
    (error) => error.code === "API_ABUSE_MISMATCH"
  );
});

test("API abuse restrictions are token-scoped, expire automatically, and never mutate credentials", () => {
  const blocked = record({
    disposition: "temporarily_blocked",
    blockedUntil: "2026-07-25T13:00:00.000Z",
    sequence: 2
  });
  assert.deepEqual(evaluateApiAbuseRestriction(blocked, { organizationId: "organization-a", tokenId: "token-a" }, { now: NOW }), {
    blocked: true,
    retained: true,
    reasonCode: "API_TEMPORARILY_BLOCKED",
    retryAfterSeconds: 1800
  });
  assert.equal(
    evaluateApiAbuseRestriction(
      blocked,
      { organizationId: "organization-a", tokenId: "token-a" },
      { now: new Date("2026-07-25T13:00:00.000Z") }
    ).blocked,
    false
  );
  assert.equal(
    evaluateApiAbuseRestriction(
      blocked,
      { organizationId: "organization-a", tokenId: "token-a" },
      { now: new Date("2026-08-24T12:20:00.000Z") }
    ).retained,
    false
  );
  assert.throws(
    () => evaluateApiAbuseRestriction(blocked, { organizationId: "organization-a", tokenId: "token-b" }, { now: NOW }),
    (error) => error.code === "API_ABUSE_MISMATCH"
  );
  assert.throws(
    () =>
      evaluateApiAbuseRestriction(
        blocked,
        { organizationId: "organization-a", tokenId: "token-a" },
        {
          now: new Date("2026-07-25T12:19:59.000Z")
        }
      ),
    (error) => error.code === "INVALID_INPUT"
  );
});
