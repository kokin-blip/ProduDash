const crypto = require("node:crypto");
const { isIP } = require("node:net");
const { AppError } = require("../errors.cjs");
const { boundedInteger, boundedString, requireId } = require("../validation.cjs");

const WEBHOOK_VERSION = "v1";
const WEBHOOK_EVENT_TYPES = Object.freeze([
  "analytics.snapshot.updated",
  "approval.decided",
  "job.completed",
  "job.failed",
  "project.updated",
  "publishing.approved"
]);
const EVENT_TYPES = new Set(WEBHOOK_EVENT_TYPES);
const ENDPOINT_STATUSES = new Set(["active", "paused", "disabled"]);
const DELIVERY_STATUSES = new Set(["queued", "delivering", "delivered", "retry_scheduled", "dead_lettered"]);
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^v1=([a-f0-9]{64})$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_DELIVERY_ATTEMPTS = 10;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

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

function hash(value, label) {
  const result = boundedString(value, { label, min: 71, max: 71 });
  if (!HASH_PATTERN.test(result)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return result;
}

function safeCode(value, label, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const result = boundedString(value, { label, min: 1, max: 80 });
  if (!SAFE_CODE_PATTERN.test(result)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return result;
}

function optionalStatus(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return boundedInteger(value, { label, min: 100, max: 599 });
}

function normalizeWebhookUrl(value) {
  const raw = boundedString(value, { label: "Webhook endpoint URL", min: 1, max: 2048 });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError("INVALID_WEBHOOK_URL", "Enter a valid HTTPS webhook endpoint.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const labels = hostname.split(".");
  const localSuffixes = [".localhost", ".local", ".internal", ".home", ".lan"];
  const validHostname =
    hostname.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    parsed.search ||
    parsed.hash ||
    isIP(hostname) ||
    hostname === "localhost" ||
    localSuffixes.some((suffix) => hostname.endsWith(suffix)) ||
    !validHostname
  ) {
    throw new AppError(
      "INVALID_WEBHOOK_URL",
      "Webhook endpoints must use a public HTTPS hostname without credentials, query parameters, or fragments."
    );
  }
  return parsed.toString();
}

function normalizeWebhookEndpoint(raw) {
  const value = plainObject(raw, "Webhook endpoint");
  onlyKeys(
    value,
    new Set([
      "organizationId",
      "endpointId",
      "url",
      "eventTypes",
      "status",
      "signingKeyId",
      "createdByUserId",
      "createdAt",
      "updatedAt",
      "disabledAt",
      "failureCount",
      "lastDeliveryAt"
    ]),
    "Webhook endpoint"
  );
  if (!Array.isArray(value.eventTypes) || !value.eventTypes.length || value.eventTypes.length > EVENT_TYPES.size) {
    throw new AppError("INVALID_INPUT", "Webhook event types are invalid.");
  }
  const eventTypes = [...new Set(value.eventTypes)];
  if (eventTypes.length !== value.eventTypes.length || eventTypes.some((eventType) => !EVENT_TYPES.has(eventType))) {
    throw new AppError("INVALID_INPUT", "Webhook event types are invalid.");
  }
  const status = boundedString(value.status, { label: "Webhook endpoint status", min: 1, max: 40 });
  if (!ENDPOINT_STATUSES.has(status)) throw new AppError("INVALID_INPUT", "Webhook endpoint status is invalid.");
  const createdAt = isoTimestamp(value.createdAt, "Webhook endpoint creation time");
  const updatedAt = isoTimestamp(value.updatedAt, "Webhook endpoint update time");
  const disabledAt = isoTimestamp(value.disabledAt, "Webhook endpoint disable time", true);
  const lastDeliveryAt = isoTimestamp(value.lastDeliveryAt, "Webhook endpoint last-delivery time", true);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new AppError("INVALID_INPUT", "Webhook endpoint update time cannot precede creation.");
  }
  for (const timestamp of [disabledAt, lastDeliveryAt].filter(Boolean)) {
    if (Date.parse(timestamp) < Date.parse(createdAt) || Date.parse(timestamp) > Date.parse(updatedAt)) {
      throw new AppError("INVALID_INPUT", "Webhook endpoint lifecycle timestamps are invalid.");
    }
  }
  if ((status === "disabled") !== Boolean(disabledAt)) {
    throw new AppError("INVALID_INPUT", "Disabled webhook endpoints require a matching disable time.");
  }
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    endpointId: requireId(value.endpointId, "Webhook endpoint"),
    url: normalizeWebhookUrl(value.url),
    eventTypes,
    status,
    signingKeyId: requireId(value.signingKeyId, "Webhook signing key"),
    createdByUserId: requireId(value.createdByUserId, "Webhook endpoint creator"),
    createdAt,
    updatedAt,
    disabledAt,
    failureCount: boundedInteger(value.failureCount, {
      label: "Webhook endpoint failure count",
      min: 0,
      max: 2_147_483_647
    }),
    lastDeliveryAt
  };
}

function normalizeWebhookEvent(raw) {
  const value = plainObject(raw, "Webhook event");
  onlyKeys(
    value,
    new Set([
      "version",
      "eventId",
      "deliveryId",
      "organizationId",
      "projectId",
      "eventType",
      "resourceId",
      "sequence",
      "occurredAt",
      "dataHash"
    ]),
    "Webhook event"
  );
  if (value.version !== WEBHOOK_VERSION) {
    throw new AppError("WEBHOOK_VERSION_UNSUPPORTED", "The webhook event version is unsupported.");
  }
  const eventType = boundedString(value.eventType, { label: "Webhook event type", min: 1, max: 80 });
  if (!EVENT_TYPES.has(eventType)) throw new AppError("INVALID_INPUT", "Webhook event type is invalid.");
  return {
    version: WEBHOOK_VERSION,
    eventId: requireId(value.eventId, "Webhook event"),
    deliveryId: requireId(value.deliveryId, "Webhook delivery"),
    organizationId: requireId(value.organizationId, "Organization"),
    projectId: value.projectId ? requireId(value.projectId, "Project") : null,
    eventType,
    resourceId: requireId(value.resourceId, "Webhook resource"),
    sequence: boundedInteger(value.sequence, { label: "Webhook event sequence", min: 1, max: 2_147_483_647 }),
    occurredAt: isoTimestamp(value.occurredAt, "Webhook event time"),
    dataHash: hash(value.dataHash, "Webhook event data hash")
  };
}

function secretBuffer(value) {
  if (!(typeof value === "string" || Buffer.isBuffer(value))) {
    throw new AppError("INVALID_INPUT", "Webhook signing material is invalid.");
  }
  const result = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (result.byteLength < 32 || result.byteLength > 128) {
    throw new AppError("INVALID_INPUT", "Webhook signing material is invalid.");
  }
  return result;
}

function bodyBuffer(value) {
  if (!(typeof value === "string" || Buffer.isBuffer(value))) {
    throw new AppError("INVALID_INPUT", "Webhook body is invalid.");
  }
  const result = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (result.byteLength > MAX_BODY_BYTES) throw new AppError("INVALID_INPUT", "Webhook body is too large.");
  return result;
}

function unixTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 9_999_999_999) {
    throw new AppError("WEBHOOK_TIMESTAMP_INVALID", "The webhook timestamp is invalid.");
  }
  return timestamp;
}

function signatureDigest(secret, timestamp, deliveryId, rawBody) {
  const prefix = Buffer.from(`${timestamp}.${deliveryId}.`, "utf8");
  return crypto.createHmac("sha256", secret).update(prefix).update(rawBody).digest();
}

function createWebhookSignature({ secret, timestamp, deliveryId, rawBody } = {}) {
  const normalizedTimestamp = unixTimestamp(timestamp);
  const normalizedDeliveryId = requireId(deliveryId, "Webhook delivery");
  const digest = signatureDigest(secretBuffer(secret), normalizedTimestamp, normalizedDeliveryId, bodyBuffer(rawBody));
  return {
    signature: `v1=${digest.toString("hex")}`,
    timestamp: normalizedTimestamp,
    deliveryId: normalizedDeliveryId
  };
}

function verifyWebhookSignature({ secret, signature, timestamp, deliveryId, rawBody, seenDeliveryIds } = {}, options = {}) {
  const normalizedTimestamp = unixTimestamp(timestamp);
  const normalizedDeliveryId = requireId(deliveryId, "Webhook delivery");
  const match = typeof signature === "string" ? SIGNATURE_PATTERN.exec(signature) : null;
  if (!match) throw new AppError("WEBHOOK_SIGNATURE_INVALID", "The webhook signature is invalid.");
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  const maxAgeSeconds = boundedInteger(options.maxAgeSeconds, {
    label: "Webhook replay window",
    min: 30,
    max: 900,
    fallback: 300
  });
  if (Math.abs(Math.floor(now.getTime() / 1000) - normalizedTimestamp) > maxAgeSeconds) {
    throw new AppError("WEBHOOK_TIMESTAMP_INVALID", "The webhook timestamp is outside the accepted window.");
  }
  const expected = signatureDigest(secretBuffer(secret), normalizedTimestamp, normalizedDeliveryId, bodyBuffer(rawBody));
  const provided = Buffer.from(match[1], "hex");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new AppError("WEBHOOK_SIGNATURE_INVALID", "The webhook signature is invalid.");
  }
  if (!Array.isArray(seenDeliveryIds) || seenDeliveryIds.length > 10_000) {
    throw new AppError("INVALID_INPUT", "Webhook replay records are invalid.");
  }
  const seen = new Set(seenDeliveryIds.map((item) => requireId(item, "Seen webhook delivery")));
  if (seen.has(normalizedDeliveryId)) {
    throw new AppError("WEBHOOK_REPLAY", "This webhook delivery has already been accepted.");
  }
  return {
    verified: true,
    timestamp: normalizedTimestamp,
    deliveryId: normalizedDeliveryId
  };
}

function normalizeWebhookDelivery(raw) {
  const value = plainObject(raw, "Webhook delivery");
  onlyKeys(
    value,
    new Set([
      "organizationId",
      "endpointId",
      "eventId",
      "deliveryId",
      "attemptNumber",
      "maxAttempts",
      "status",
      "bodyHash",
      "responseStatus",
      "resultCode",
      "createdAt",
      "updatedAt",
      "nextAttemptAt",
      "completedAt",
      "sequence"
    ]),
    "Webhook delivery"
  );
  const attemptNumber = boundedInteger(value.attemptNumber, {
    label: "Webhook delivery attempt",
    min: 1,
    max: MAX_DELIVERY_ATTEMPTS
  });
  const maxAttempts = boundedInteger(value.maxAttempts, {
    label: "Webhook maximum attempts",
    min: 1,
    max: MAX_DELIVERY_ATTEMPTS
  });
  if (attemptNumber > maxAttempts) throw new AppError("INVALID_INPUT", "Webhook delivery attempt exceeds its limit.");
  const status = boundedString(value.status, { label: "Webhook delivery status", min: 1, max: 40 });
  if (!DELIVERY_STATUSES.has(status)) throw new AppError("INVALID_INPUT", "Webhook delivery status is invalid.");
  if (status === "queued" && attemptNumber !== 1) {
    throw new AppError("INVALID_INPUT", "Queued webhook deliveries must begin at the first attempt.");
  }
  const createdAt = isoTimestamp(value.createdAt, "Webhook delivery creation time");
  const updatedAt = isoTimestamp(value.updatedAt, "Webhook delivery update time");
  const nextAttemptAt = isoTimestamp(value.nextAttemptAt, "Webhook next-attempt time", true);
  const completedAt = isoTimestamp(value.completedAt, "Webhook completion time", true);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new AppError("INVALID_INPUT", "Webhook delivery update time cannot precede creation.");
  }
  if (completedAt && Date.parse(completedAt) < Date.parse(updatedAt)) {
    throw new AppError("INVALID_INPUT", "Webhook completion time cannot precede its final update.");
  }
  const responseStatus = optionalStatus(value.responseStatus, "Webhook response status");
  const resultCode = safeCode(value.resultCode, "Webhook result code", true);
  if (status === "queued" || status === "delivering") {
    if (responseStatus || resultCode || nextAttemptAt || completedAt) {
      throw new AppError("INVALID_INPUT", "Pending webhook deliveries cannot contain an outcome.");
    }
  } else if (status === "delivered") {
    if (!responseStatus || responseStatus < 200 || responseStatus > 299 || resultCode || nextAttemptAt || !completedAt) {
      throw new AppError("INVALID_INPUT", "Delivered webhooks require only a successful response status and completion time.");
    }
  } else if (status === "retry_scheduled") {
    if (
      attemptNumber >= maxAttempts ||
      !resultCode ||
      (responseStatus !== null && responseStatus >= 200 && responseStatus <= 299) ||
      !nextAttemptAt ||
      completedAt ||
      Date.parse(nextAttemptAt) <= Date.parse(updatedAt) ||
      Date.parse(nextAttemptAt) - Date.parse(updatedAt) > MAX_RETRY_DELAY_MS
    ) {
      throw new AppError("INVALID_INPUT", "Webhook retry state is invalid.");
    }
  } else if (!resultCode || (responseStatus !== null && responseStatus >= 200 && responseStatus <= 299) || nextAttemptAt || !completedAt) {
    throw new AppError("INVALID_INPUT", "Dead-lettered webhooks require a safe result code and completion time.");
  }
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    endpointId: requireId(value.endpointId, "Webhook endpoint"),
    eventId: requireId(value.eventId, "Webhook event"),
    deliveryId: requireId(value.deliveryId, "Webhook delivery"),
    attemptNumber,
    maxAttempts,
    status,
    bodyHash: hash(value.bodyHash, "Webhook body hash"),
    responseStatus,
    resultCode,
    createdAt,
    updatedAt,
    nextAttemptAt,
    completedAt,
    sequence: boundedInteger(value.sequence, { label: "Webhook delivery sequence", min: 1, max: 2_147_483_647 })
  };
}

function evaluateWebhookDeliveryTransition(rawCurrent, rawNext) {
  const current = normalizeWebhookDelivery(rawCurrent);
  const next = normalizeWebhookDelivery(rawNext);
  if (JSON.stringify(current) === JSON.stringify(next)) return { status: "idempotent", record: current };
  for (const field of ["organizationId", "endpointId", "eventId", "deliveryId", "maxAttempts", "bodyHash", "createdAt"]) {
    if (current[field] !== next[field]) {
      throw new AppError("WEBHOOK_DELIVERY_MISMATCH", "Webhook delivery identity fields cannot change.");
    }
  }
  if (current.status === "delivered" || current.status === "dead_lettered") {
    throw new AppError("WEBHOOK_DELIVERY_FINAL", "A completed webhook delivery cannot be changed.");
  }
  if (next.sequence !== current.sequence + 1 || Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
    throw new AppError("INVALID_INPUT", "Webhook delivery updates must be consecutive and chronological.");
  }
  const allowed =
    (current.status === "queued" && next.status === "delivering" && next.attemptNumber === current.attemptNumber) ||
    (current.status === "delivering" &&
      ["delivered", "retry_scheduled", "dead_lettered"].includes(next.status) &&
      next.attemptNumber === current.attemptNumber) ||
    (current.status === "retry_scheduled" && next.status === "delivering" && next.attemptNumber === current.attemptNumber + 1);
  if (!allowed) throw new AppError("INVALID_INPUT", "Webhook delivery transition is invalid.");
  return { status: "apply", record: next };
}

module.exports = {
  MAX_BODY_BYTES,
  MAX_DELIVERY_ATTEMPTS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_VERSION,
  createWebhookSignature,
  evaluateWebhookDeliveryTransition,
  normalizeWebhookDelivery,
  normalizeWebhookEndpoint,
  normalizeWebhookEvent,
  normalizeWebhookUrl,
  verifyWebhookSignature
};
