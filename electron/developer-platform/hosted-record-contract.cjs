const { AppError } = require("../errors.cjs");
const { boundedInteger, boundedString, requireId } = require("../validation.cjs");
const { API_VERSION } = require("./api-contract.cjs");

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_RETENTION_MS = 30 * DAY_MS;
const MAX_OWNER_POLICY_RETENTION_MS = 365 * DAY_MS;

const HOSTED_RECORD_POLICIES = Object.freeze({
  token_metadata: Object.freeze({ storageClass: "restricted", expiry: "optional", maxLifetimeMs: null }),
  token_credential: Object.freeze({ storageClass: "sealed", expiry: "required", maxLifetimeMs: null }),
  cursor: Object.freeze({ storageClass: "restricted", expiry: "required", maxLifetimeMs: 60 * 60 * 1000 }),
  idempotency: Object.freeze({ storageClass: "restricted", expiry: "required", maxLifetimeMs: DAY_MS }),
  webhook_endpoint: Object.freeze({ storageClass: "restricted", expiry: "optional", maxLifetimeMs: null }),
  webhook_credential: Object.freeze({ storageClass: "sealed", expiry: "optional", maxLifetimeMs: null }),
  webhook_delivery: Object.freeze({ storageClass: "restricted", expiry: "required", maxLifetimeMs: 30 * DAY_MS }),
  rate_limit: Object.freeze({ storageClass: "restricted", expiry: "required", maxLifetimeMs: 2 * 60 * 1000 }),
  abuse_signal: Object.freeze({ storageClass: "restricted", expiry: "required", maxLifetimeMs: 30 * DAY_MS }),
  operational_audit: Object.freeze({
    storageClass: "restricted",
    expiry: "required",
    maxLifetimeMs: MAX_OWNER_POLICY_RETENTION_MS
  })
});

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

function payloadHash(value, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const result = boundedString(value, { label: "Hosted record payload hash", min: 71, max: 71 });
  if (!HASH_PATTERN.test(result)) throw new AppError("INVALID_INPUT", "Hosted record payload hash is invalid.");
  return result;
}

function normalizeHostedRecordEnvelope(raw) {
  const value = plainObject(raw, "Hosted record envelope");
  onlyKeys(
    value,
    new Set([
      "apiVersion",
      "organizationId",
      "recordType",
      "recordId",
      "storageClass",
      "retentionPolicyId",
      "payloadHash",
      "createdAt",
      "updatedAt",
      "expiresAt",
      "deletedAt",
      "revision"
    ]),
    "Hosted record envelope"
  );
  if (value.apiVersion !== API_VERSION) {
    throw new AppError("API_VERSION_UNSUPPORTED", "The hosted record version is unsupported.");
  }
  const recordType = boundedString(value.recordType, { label: "Hosted record type", min: 1, max: 40 });
  const policy = HOSTED_RECORD_POLICIES[recordType];
  if (!policy || value.storageClass !== policy.storageClass) {
    throw new AppError("INVALID_INPUT", "Hosted record storage classification is invalid.");
  }
  const createdAt = isoTimestamp(value.createdAt, "Hosted record creation time");
  const updatedAt = isoTimestamp(value.updatedAt, "Hosted record update time");
  const expiresAt = isoTimestamp(value.expiresAt, "Hosted record expiry", true);
  const deletedAt = isoTimestamp(value.deletedAt, "Hosted record deletion time", true);
  const deleted = Boolean(deletedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt) || (deleted && deletedAt !== updatedAt)) {
    throw new AppError("INVALID_INPUT", "Hosted record lifecycle timestamps are invalid.");
  }
  if (deleted) {
    if (
      value.payloadHash !== null ||
      !expiresAt ||
      Date.parse(expiresAt) <= Date.parse(deletedAt) ||
      Date.parse(expiresAt) - Date.parse(deletedAt) > TOMBSTONE_RETENTION_MS
    ) {
      throw new AppError("INVALID_INPUT", "Hosted record tombstone retention is invalid.");
    }
  } else {
    if (policy.expiry === "required" && !expiresAt) {
      throw new AppError("INVALID_INPUT", "Hosted record expiry is required.");
    }
    if (
      expiresAt &&
      (Date.parse(expiresAt) <= Date.parse(updatedAt) ||
        (policy.maxLifetimeMs && Date.parse(expiresAt) - Date.parse(createdAt) > policy.maxLifetimeMs))
    ) {
      throw new AppError("INVALID_INPUT", "Hosted record retention is invalid.");
    }
  }
  return {
    apiVersion: API_VERSION,
    organizationId: requireId(value.organizationId, "Organization"),
    recordType,
    recordId: requireId(value.recordId, "Hosted record"),
    storageClass: policy.storageClass,
    retentionPolicyId: requireId(value.retentionPolicyId, "Retention policy"),
    payloadHash: payloadHash(value.payloadHash, deleted),
    createdAt,
    updatedAt,
    expiresAt,
    deletedAt,
    revision: boundedInteger(value.revision, {
      label: "Hosted record revision",
      min: 1,
      max: 2_147_483_647
    })
  };
}

function sameRecordIdentity(current, next) {
  return ["organizationId", "recordType", "recordId", "storageClass", "retentionPolicyId", "createdAt"].every(
    (field) => current[field] === next[field]
  );
}

function evaluateHostedRecordWrite(rawCurrent, rawNext) {
  const next = normalizeHostedRecordEnvelope(rawNext);
  if (rawCurrent === null || rawCurrent === undefined) {
    if (next.revision !== 1 || next.deletedAt || next.createdAt !== next.updatedAt) {
      throw new AppError("HOSTED_RECORD_CONFLICT", "A hosted record must begin as revision one.");
    }
    return { status: "create", record: next };
  }
  const current = normalizeHostedRecordEnvelope(rawCurrent);
  if (JSON.stringify(current) === JSON.stringify(next)) return { status: "idempotent", record: current };
  if (!sameRecordIdentity(current, next)) {
    throw new AppError("HOSTED_RECORD_MISMATCH", "Hosted record identity fields cannot change.");
  }
  if (current.deletedAt) throw new AppError("HOSTED_RECORD_FINAL", "A deleted hosted record cannot change.");
  if (next.revision !== current.revision + 1 || Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
    throw new AppError("HOSTED_RECORD_CONFLICT", "Hosted record updates require the next revision.");
  }
  if (next.deletedAt) return { status: "delete", record: next };
  if (next.payloadHash === current.payloadHash) {
    throw new AppError("HOSTED_RECORD_CONFLICT", "A hosted record update must change its payload.");
  }
  if (current.expiresAt && (!next.expiresAt || Date.parse(next.expiresAt) > Date.parse(current.expiresAt))) {
    throw new AppError("HOSTED_RECORD_CONFLICT", "Hosted record retention cannot be extended by an update.");
  }
  return { status: "update", record: next };
}

function normalizeHostedRecordTarget(raw) {
  const value = plainObject(raw, "Hosted record target");
  onlyKeys(value, new Set(["organizationId", "recordType", "recordId"]), "Hosted record target");
  const recordType = boundedString(value.recordType, { label: "Hosted record type", min: 1, max: 40 });
  if (!HOSTED_RECORD_POLICIES[recordType]) throw new AppError("INVALID_INPUT", "Hosted record type is invalid.");
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    recordType,
    recordId: requireId(value.recordId, "Hosted record")
  };
}

function evaluateHostedRecordRead(rawRecord, rawTarget, options = {}) {
  const record = normalizeHostedRecordEnvelope(rawRecord);
  const target = normalizeHostedRecordTarget(rawTarget);
  if (record.organizationId !== target.organizationId || record.recordType !== target.recordType || record.recordId !== target.recordId) {
    throw new AppError("HOSTED_RECORD_MISMATCH", "Hosted record target does not match.");
  }
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  if (record.deletedAt) return { status: "deleted", recordId: record.recordId, revision: record.revision };
  if (record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()) {
    return { status: "expired", recordId: record.recordId, revision: record.revision };
  }
  return {
    status: "available",
    recordId: record.recordId,
    revision: record.revision,
    payloadHash: record.payloadHash,
    storageClass: record.storageClass
  };
}

function selectExpiredHostedRecords(rawRecords, rawTarget, options = {}) {
  if (!Array.isArray(rawRecords) || rawRecords.length > 10_000) {
    throw new AppError("INVALID_INPUT", "Hosted record sweep input is invalid.");
  }
  const target = plainObject(rawTarget, "Hosted record sweep target");
  onlyKeys(target, new Set(["organizationId", "limit"]), "Hosted record sweep target");
  const organizationId = requireId(target.organizationId, "Organization");
  const limit = boundedInteger(target.limit, {
    label: "Hosted record sweep limit",
    min: 1,
    max: 500,
    fallback: 100
  });
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  return rawRecords
    .map(normalizeHostedRecordEnvelope)
    .filter((record) => record.organizationId === organizationId && record.expiresAt && Date.parse(record.expiresAt) <= now.getTime())
    .sort((first, second) => Date.parse(first.expiresAt) - Date.parse(second.expiresAt))
    .slice(0, limit)
    .map((record) => ({
      recordType: record.recordType,
      recordId: record.recordId,
      revision: record.revision,
      expiredAt: record.expiresAt
    }));
}

module.exports = {
  HOSTED_RECORD_POLICIES,
  MAX_OWNER_POLICY_RETENTION_MS,
  TOMBSTONE_RETENTION_MS,
  evaluateHostedRecordRead,
  evaluateHostedRecordWrite,
  normalizeHostedRecordEnvelope,
  selectExpiredHostedRecords
};
