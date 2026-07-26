const { AppError } = require("../errors.cjs");
const { boundedInteger, boundedString, requireId } = require("../validation.cjs");
const { API_VERSION } = require("./api-contract.cjs");

const ABUSE_EVENT_TYPES = new Set([
  "credential_failure",
  "cursor_mismatch",
  "forbidden_scope",
  "idempotency_mismatch",
  "payload_too_large",
  "rate_limit_exceeded",
  "replay_attempt"
]);
const ABUSE_DISPOSITIONS = new Set(["observe", "review_required", "temporarily_blocked"]);
const MAX_SIGNAL_WINDOW_MS = 60 * 60 * 1000;
const MAX_BLOCK_MS = 24 * 60 * 60 * 1000;
const MAX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

function normalizeApiAbuseRecord(raw) {
  const value = plainObject(raw, "API abuse record");
  onlyKeys(
    value,
    new Set([
      "apiVersion",
      "signalId",
      "organizationId",
      "tokenId",
      "eventType",
      "count",
      "disposition",
      "windowStartedAt",
      "windowEndsAt",
      "createdAt",
      "blockedUntil",
      "expiresAt",
      "sequence"
    ]),
    "API abuse record"
  );
  if (value.apiVersion !== API_VERSION) throw new AppError("API_VERSION_UNSUPPORTED", "The API abuse-record version is unsupported.");
  const eventType = boundedString(value.eventType, { label: "API abuse event type", min: 1, max: 80 });
  if (!ABUSE_EVENT_TYPES.has(eventType)) throw new AppError("INVALID_INPUT", "API abuse event type is invalid.");
  const disposition = boundedString(value.disposition, { label: "API abuse disposition", min: 1, max: 40 });
  if (!ABUSE_DISPOSITIONS.has(disposition)) throw new AppError("INVALID_INPUT", "API abuse disposition is invalid.");
  const windowStartedAt = isoTimestamp(value.windowStartedAt, "API abuse window start");
  const windowEndsAt = isoTimestamp(value.windowEndsAt, "API abuse window end");
  const createdAt = isoTimestamp(value.createdAt, "API abuse creation time");
  const blockedUntil = isoTimestamp(value.blockedUntil, "API abuse block expiry", true);
  const expiresAt = isoTimestamp(value.expiresAt, "API abuse record expiry");
  const windowDuration = Date.parse(windowEndsAt) - Date.parse(windowStartedAt);
  const retention = Date.parse(expiresAt) - Date.parse(createdAt);
  if (
    windowDuration <= 0 ||
    windowDuration > MAX_SIGNAL_WINDOW_MS ||
    Date.parse(createdAt) < Date.parse(windowStartedAt) ||
    Date.parse(createdAt) > Date.parse(windowEndsAt) ||
    retention <= 0 ||
    retention > MAX_RETENTION_MS
  ) {
    throw new AppError("INVALID_INPUT", "API abuse lifecycle timestamps are invalid.");
  }
  const tokenId = value.tokenId ? requireId(value.tokenId, "API token") : null;
  if (disposition === "temporarily_blocked") {
    const blockDuration = blockedUntil ? Date.parse(blockedUntil) - Date.parse(createdAt) : 0;
    if (!tokenId || blockDuration <= 0 || blockDuration > MAX_BLOCK_MS || Date.parse(blockedUntil) > Date.parse(expiresAt)) {
      throw new AppError("INVALID_INPUT", "Temporary API restrictions require a bounded token-specific expiry.");
    }
  } else if (blockedUntil) {
    throw new AppError("INVALID_INPUT", "Only temporarily blocked API records can contain a block expiry.");
  }
  return {
    apiVersion: API_VERSION,
    signalId: requireId(value.signalId, "API abuse signal"),
    organizationId: requireId(value.organizationId, "Organization"),
    tokenId,
    eventType,
    count: boundedInteger(value.count, { label: "API abuse event count", min: 1, max: 1_000_000 }),
    disposition,
    windowStartedAt,
    windowEndsAt,
    createdAt,
    blockedUntil,
    expiresAt,
    sequence: boundedInteger(value.sequence, { label: "API abuse sequence", min: 1, max: 2_147_483_647 })
  };
}

function evaluateApiAbuseTransition(rawCurrent, rawNext) {
  const current = normalizeApiAbuseRecord(rawCurrent);
  const next = normalizeApiAbuseRecord(rawNext);
  if (JSON.stringify(current) === JSON.stringify(next)) return { status: "idempotent", record: current };
  for (const field of ["signalId", "organizationId", "tokenId", "eventType", "windowStartedAt", "windowEndsAt", "createdAt", "expiresAt"]) {
    if (current[field] !== next[field]) throw new AppError("API_ABUSE_MISMATCH", "API abuse identity fields cannot change.");
  }
  if (current.disposition !== "observe") {
    throw new AppError("API_ABUSE_FINAL", "A reviewed or enforced API abuse record cannot be changed.");
  }
  if (next.disposition === "observe" || next.count < current.count || next.sequence !== current.sequence + 1) {
    throw new AppError("INVALID_INPUT", "API abuse disposition changes must be consecutive and preserve evidence.");
  }
  return { status: "apply", record: next };
}

function evaluateApiAbuseRestriction(rawRecord, rawTarget, options = {}) {
  const record = normalizeApiAbuseRecord(rawRecord);
  const target = plainObject(rawTarget, "API abuse target");
  onlyKeys(target, new Set(["organizationId", "tokenId"]), "API abuse target");
  const organizationId = requireId(target.organizationId, "Organization");
  const tokenId = requireId(target.tokenId, "API token");
  if (record.organizationId !== organizationId || record.tokenId !== tokenId) {
    throw new AppError("API_ABUSE_MISMATCH", "The API abuse record does not match this token.");
  }
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  if (now.getTime() < Date.parse(record.createdAt)) {
    throw new AppError("INVALID_INPUT", "The API abuse clock precedes the recorded signal.");
  }
  const retained = Date.parse(record.expiresAt) > now.getTime();
  const blocked =
    retained && record.disposition === "temporarily_blocked" && record.blockedUntil && Date.parse(record.blockedUntil) > now.getTime();
  return {
    blocked: Boolean(blocked),
    retained,
    reasonCode: blocked ? "API_TEMPORARILY_BLOCKED" : null,
    retryAfterSeconds: blocked ? Math.max(1, Math.ceil((Date.parse(record.blockedUntil) - now.getTime()) / 1000)) : null
  };
}

module.exports = {
  MAX_BLOCK_MS,
  MAX_RETENTION_MS,
  MAX_SIGNAL_WINDOW_MS,
  evaluateApiAbuseRestriction,
  evaluateApiAbuseTransition,
  normalizeApiAbuseRecord
};
