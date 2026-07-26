const assert = require("node:assert/strict");
const test = require("node:test");
const {
  HOSTED_RECORD_POLICIES,
  evaluateHostedRecordRead,
  evaluateHostedRecordWrite,
  normalizeHostedRecordEnvelope,
  selectExpiredHostedRecords
} = require("../electron/developer-platform/hosted-record-contract.cjs");

const NOW = new Date("2026-07-25T12:00:00.000Z");
const HASH_A = `sha256:${"1".repeat(64)}`;
const HASH_B = `sha256:${"2".repeat(64)}`;

function record(overrides = {}) {
  return {
    apiVersion: "v1",
    organizationId: "organization-a",
    recordType: "cursor",
    recordId: "cursor-a",
    storageClass: "restricted",
    retentionPolicyId: "cursor-1h",
    payloadHash: HASH_A,
    createdAt: "2026-07-25T11:30:00.000Z",
    updatedAt: "2026-07-25T11:30:00.000Z",
    expiresAt: "2026-07-25T12:30:00.000Z",
    deletedAt: null,
    revision: 1,
    ...overrides
  };
}

test("hosted record policies classify every persisted API record without a public storage class", () => {
  assert.deepEqual(new Set(Object.values(HOSTED_RECORD_POLICIES).map((policy) => policy.storageClass)), new Set(["restricted", "sealed"]));
  assert.equal(HOSTED_RECORD_POLICIES.token_credential.storageClass, "sealed");
  assert.equal(HOSTED_RECORD_POLICIES.webhook_credential.storageClass, "sealed");
  assert.equal(HOSTED_RECORD_POLICIES.cursor.maxLifetimeMs, 60 * 60 * 1000);
  assert.equal(HOSTED_RECORD_POLICIES.abuse_signal.maxLifetimeMs, 30 * 24 * 60 * 60 * 1000);
});

test("hosted record envelopes are tenant-partitioned, hash-only, bounded, and classification-aware", () => {
  assert.equal(normalizeHostedRecordEnvelope(record()).payloadHash, HASH_A);
  for (const invalid of [
    record({ storageClass: "sealed" }),
    record({ storageClass: "public" }),
    record({ expiresAt: "2026-07-25T12:30:01.000Z" }),
    record({ payload: { customer: "raw data" } }),
    record({ authorization: "Bearer secret" }),
    record({ localPath: "/private/record" }),
    record({ payloadHash: "not-a-hash" })
  ]) {
    assert.throws(
      () => normalizeHostedRecordEnvelope(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("hosted record writes enforce insert uniqueness and optimistic revision transitions", () => {
  const initial = record();
  const updated = record({
    payloadHash: HASH_B,
    updatedAt: "2026-07-25T11:40:00.000Z",
    expiresAt: "2026-07-25T12:20:00.000Z",
    revision: 2
  });
  assert.equal(evaluateHostedRecordWrite(null, initial).status, "create");
  assert.equal(evaluateHostedRecordWrite(initial, initial).status, "idempotent");
  assert.equal(evaluateHostedRecordWrite(initial, updated).status, "update");
  for (const invalid of [
    record({ revision: 2 }),
    { ...updated, organizationId: "organization-b" },
    { ...updated, revision: 3 },
    { ...updated, payloadHash: HASH_A },
    { ...updated, expiresAt: "2026-07-25T12:31:00.000Z" }
  ]) {
    assert.throws(
      () => evaluateHostedRecordWrite(invalid.revision === 2 && invalid.createdAt === invalid.updatedAt ? null : initial, invalid),
      (error) => ["HOSTED_RECORD_CONFLICT", "HOSTED_RECORD_MISMATCH", "INVALID_INPUT"].includes(error.code)
    );
  }
});

test("hosted deletion creates a bounded terminal tombstone without retaining payload data", () => {
  const deleted = record({
    payloadHash: null,
    updatedAt: "2026-07-25T12:00:00.000Z",
    expiresAt: "2026-08-24T12:00:00.000Z",
    deletedAt: "2026-07-25T12:00:00.000Z",
    revision: 2
  });
  assert.equal(evaluateHostedRecordWrite(record(), deleted).status, "delete");
  assert.deepEqual(
    evaluateHostedRecordRead(deleted, { organizationId: "organization-a", recordType: "cursor", recordId: "cursor-a" }, { now: NOW }),
    { status: "deleted", recordId: "cursor-a", revision: 2 }
  );
  assert.throws(
    () => evaluateHostedRecordWrite(deleted, { ...deleted, revision: 3 }),
    (error) => error.code === "HOSTED_RECORD_FINAL"
  );
});

test("hosted reads and expiry sweeps remain tenant-scoped, bounded, and payload-free", () => {
  const expiredA = record({ recordId: "cursor-expired-a", expiresAt: NOW.toISOString() });
  const expiredB = record({
    organizationId: "organization-b",
    recordId: "cursor-expired-b",
    expiresAt: NOW.toISOString()
  });
  const active = record({ recordId: "cursor-active" });
  assert.deepEqual(
    evaluateHostedRecordRead(active, { organizationId: "organization-a", recordType: "cursor", recordId: "cursor-active" }, { now: NOW }),
    {
      status: "available",
      recordId: "cursor-active",
      revision: 1,
      payloadHash: HASH_A,
      storageClass: "restricted"
    }
  );
  assert.throws(
    () =>
      evaluateHostedRecordRead(active, { organizationId: "organization-b", recordType: "cursor", recordId: "cursor-active" }, { now: NOW }),
    (error) => error.code === "HOSTED_RECORD_MISMATCH"
  );
  assert.deepEqual(
    selectExpiredHostedRecords([active, expiredB, expiredA], { organizationId: "organization-a", limit: 10 }, { now: NOW }),
    [
      {
        recordType: "cursor",
        recordId: "cursor-expired-a",
        revision: 1,
        expiredAt: NOW.toISOString()
      }
    ]
  );
});
