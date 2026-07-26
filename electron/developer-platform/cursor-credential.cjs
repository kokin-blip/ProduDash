const crypto = require("node:crypto");
const { AppError } = require("../errors.cjs");
const { boundedInteger, boundedString, requireId } = require("../validation.cjs");
const { API_VERSION, OPERATION_DEFINITIONS } = require("./api-contract.cjs");

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CURSOR_TOKEN_PATTERN = /^pdc_v1_([A-Za-z0-9_-]{2,171})_([A-Za-z0-9_-]{43})$/;
const MAX_CURSOR_LIFETIME_MS = 60 * 60 * 1000;
const MIN_SIGNING_KEY_BYTES = 32;
const MAX_SIGNING_KEY_BYTES = 64;

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

function normalizeApiCursorRecord(raw) {
  const value = plainObject(raw, "API cursor record");
  onlyKeys(
    value,
    new Set([
      "apiVersion",
      "cursorId",
      "organizationId",
      "tokenId",
      "projectId",
      "resourceType",
      "queryHash",
      "snapshotRevision",
      "offset",
      "pageSize",
      "createdAt",
      "expiresAt"
    ]),
    "API cursor record"
  );
  if (value.apiVersion !== API_VERSION) throw new AppError("API_VERSION_UNSUPPORTED", "The API cursor version is unsupported.");
  const resourceType = boundedString(value.resourceType, { label: "API cursor resource type", min: 1, max: 40 });
  const definition = OPERATION_DEFINITIONS[resourceType]?.list;
  if (!definition) throw new AppError("INVALID_INPUT", "API cursor resource type is invalid.");
  const projectId = value.projectId ? requireId(value.projectId, "Project") : null;
  if (definition.projectId === "required" && !projectId) {
    throw new AppError("INVALID_INPUT", "This API cursor requires a project.");
  }
  if (definition.projectId === "forbidden" && projectId) {
    throw new AppError("INVALID_INPUT", "This API cursor is organization-scoped.");
  }
  const createdAt = isoTimestamp(value.createdAt, "API cursor creation time");
  const expiresAt = isoTimestamp(value.expiresAt, "API cursor expiry");
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetime <= 0 || lifetime > MAX_CURSOR_LIFETIME_MS) {
    throw new AppError("INVALID_INPUT", "API cursor expiry is invalid.");
  }
  return {
    apiVersion: API_VERSION,
    cursorId: requireId(value.cursorId, "API cursor"),
    organizationId: requireId(value.organizationId, "Organization"),
    tokenId: requireId(value.tokenId, "API token"),
    projectId,
    resourceType,
    queryHash: hash(value.queryHash, "API cursor query hash"),
    snapshotRevision: boundedInteger(value.snapshotRevision, {
      label: "API cursor snapshot revision",
      min: 0,
      max: 2_147_483_647
    }),
    offset: boundedInteger(value.offset, { label: "API cursor offset", min: 0, max: 10_000_000 }),
    pageSize: boundedInteger(value.pageSize, { label: "API cursor page size", min: 1, max: 100 }),
    createdAt,
    expiresAt
  };
}

function signingKey(value) {
  if (!Buffer.isBuffer(value) || value.byteLength < MIN_SIGNING_KEY_BYTES || value.byteLength > MAX_SIGNING_KEY_BYTES) {
    throw new AppError("INVALID_INPUT", "API cursor signing key is invalid.");
  }
  return value;
}

function cursorPayload(record) {
  return Buffer.from(
    JSON.stringify([
      record.apiVersion,
      record.cursorId,
      record.organizationId,
      record.tokenId,
      record.projectId,
      record.resourceType,
      record.queryHash,
      record.snapshotRevision,
      record.offset,
      record.pageSize,
      record.createdAt,
      record.expiresAt
    ]),
    "utf8"
  );
}

function signature(record, key) {
  return crypto.createHmac("sha256", key).update(cursorPayload(record)).digest();
}

function issueApiCursorToken(rawCursor, rawSigningKey, options = {}) {
  const cursor = normalizeApiCursorRecord(rawCursor);
  const key = signingKey(rawSigningKey);
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  if (Date.parse(cursor.createdAt) > now.getTime()) {
    throw new AppError("INVALID_INPUT", "The API cursor cannot be issued before its creation time.");
  }
  if (Date.parse(cursor.expiresAt) <= now.getTime()) throw new AppError("API_CURSOR_EXPIRED", "The API cursor has expired.");
  const encodedId = Buffer.from(cursor.cursorId, "utf8").toString("base64url");
  return `pdc_v1_${encodedId}_${signature(cursor, key).toString("base64url")}`;
}

function normalizeTarget(raw) {
  const value = plainObject(raw, "API cursor target");
  onlyKeys(value, new Set(["organizationId", "tokenId", "projectId", "resourceType", "queryHash", "pageSize"]), "API cursor target");
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    tokenId: requireId(value.tokenId, "API token"),
    projectId: value.projectId ? requireId(value.projectId, "Project") : null,
    resourceType: boundedString(value.resourceType, { label: "API resource type", min: 1, max: 40 }),
    queryHash: hash(value.queryHash, "API query hash"),
    pageSize: boundedInteger(value.pageSize, { label: "API page size", min: 1, max: 100 })
  };
}

function verifyApiCursorToken(cursorToken, rawCursor, rawSigningKey, rawTarget, options = {}) {
  const match = typeof cursorToken === "string" ? CURSOR_TOKEN_PATTERN.exec(cursorToken) : null;
  if (!match) throw new AppError("API_CURSOR_INVALID", "The API cursor is missing or invalid.");
  const cursor = normalizeApiCursorRecord(rawCursor);
  const key = signingKey(rawSigningKey);
  const target = normalizeTarget(rawTarget);
  let decodedId;
  try {
    decodedId = Buffer.from(match[1], "base64url").toString("utf8");
  } catch {
    throw new AppError("API_CURSOR_INVALID", "The API cursor is missing or invalid.");
  }
  const supplied = Buffer.from(match[2], "base64url");
  const expected = signature(cursor, key);
  if (decodedId !== cursor.cursorId || supplied.byteLength !== expected.byteLength || !crypto.timingSafeEqual(supplied, expected)) {
    throw new AppError("API_CURSOR_INVALID", "The API cursor is missing or invalid.");
  }
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  if (Date.parse(cursor.expiresAt) <= now.getTime()) throw new AppError("API_CURSOR_EXPIRED", "The API cursor has expired.");
  if (
    cursor.organizationId !== target.organizationId ||
    cursor.tokenId !== target.tokenId ||
    cursor.projectId !== target.projectId ||
    cursor.resourceType !== target.resourceType ||
    cursor.queryHash !== target.queryHash ||
    cursor.pageSize !== target.pageSize
  ) {
    throw new AppError("API_CURSOR_MISMATCH", "The API cursor does not match this list request.");
  }
  return cursor;
}

module.exports = {
  CURSOR_TOKEN_PATTERN,
  MAX_CURSOR_LIFETIME_MS,
  issueApiCursorToken,
  normalizeApiCursorRecord,
  verifyApiCursorToken
};
