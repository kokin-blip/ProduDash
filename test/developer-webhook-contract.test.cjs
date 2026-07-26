const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_BODY_BYTES,
  createWebhookSignature,
  evaluateWebhookDeliveryTransition,
  normalizeWebhookDelivery,
  normalizeWebhookEndpoint,
  normalizeWebhookEvent,
  normalizeWebhookUrl,
  verifyWebhookSignature
} = require("../electron/developer-platform/webhook-contract.cjs");

const NOW = new Date("2026-07-25T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const SIGNING_MATERIAL = Buffer.alloc(32, 7);
const BODY_HASH = `sha256:${"1".repeat(64)}`;

function endpoint(overrides = {}) {
  return {
    organizationId: "organization-a",
    endpointId: "endpoint-a",
    url: "https://hooks.example.com/produdash",
    eventTypes: ["project.updated", "job.completed"],
    status: "active",
    signingKeyId: "signing-key-a",
    createdByUserId: "user-a",
    createdAt: "2026-07-25T09:00:00.000Z",
    updatedAt: "2026-07-25T11:00:00.000Z",
    disabledAt: null,
    failureCount: 0,
    lastDeliveryAt: null,
    ...overrides
  };
}

function event(overrides = {}) {
  return {
    version: "v1",
    eventId: "event-a",
    deliveryId: "delivery-a",
    organizationId: "organization-a",
    projectId: "project-a",
    eventType: "project.updated",
    resourceId: "project-a",
    sequence: 1,
    occurredAt: NOW.toISOString(),
    dataHash: BODY_HASH,
    ...overrides
  };
}

function delivery(overrides = {}) {
  return {
    organizationId: "organization-a",
    endpointId: "endpoint-a",
    eventId: "event-a",
    deliveryId: "delivery-a",
    attemptNumber: 1,
    maxAttempts: 3,
    status: "queued",
    bodyHash: BODY_HASH,
    responseStatus: null,
    resultCode: null,
    createdAt: "2026-07-25T11:59:00.000Z",
    updatedAt: "2026-07-25T11:59:00.000Z",
    nextAttemptAt: null,
    completedAt: null,
    sequence: 1,
    ...overrides
  };
}

test("webhook endpoints require public-style HTTPS URLs and safe public metadata", () => {
  const normalized = normalizeWebhookEndpoint(endpoint());
  assert.equal(normalized.url, "https://hooks.example.com/produdash");
  assert.deepEqual(normalized.eventTypes, ["project.updated", "job.completed"]);
  for (const url of [
    "http://hooks.example.com",
    "https://user:pass@hooks.example.com",
    "https://hooks.example.com?token=value",
    "https://hooks.example.com/#fragment",
    "https://hooks.example.com:8443",
    "https://127.0.0.1/hook",
    "https://[::1]/hook",
    "https://localhost/hook",
    "https://worker.internal/hook",
    "https://singlelabel/hook"
  ]) {
    assert.throws(
      () => normalizeWebhookUrl(url),
      (error) => error.code === "INVALID_WEBHOOK_URL"
    );
  }
  for (const invalid of [
    { ...endpoint(), secret: "must-not-persist" },
    { ...endpoint(), headers: { authorization: "must-not-persist" } },
    { ...endpoint(), token: "must-not-persist" },
    endpoint({ eventTypes: ["project.updated", "project.updated"] }),
    endpoint({ eventTypes: ["project.deleted"] }),
    endpoint({ status: "disabled" }),
    endpoint({ status: "active", disabledAt: "2026-07-25T10:00:00.000Z" }),
    endpoint({ updatedAt: "2026-07-25T08:00:00.000Z" })
  ]) {
    assert.throws(
      () => normalizeWebhookEndpoint(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("webhook event envelopes contain only bounded references and hashes", () => {
  const normalized = normalizeWebhookEvent(event());
  assert.equal(normalized.version, "v1");
  assert.equal(normalized.dataHash, BODY_HASH);
  for (const invalid of [
    event({ version: "v2" }),
    event({ eventType: "filesystem.read" }),
    event({ dataHash: "sha256:short" }),
    { ...event(), payload: { title: "Raw payload stays outside the envelope." } },
    { ...event(), sourcePath: "/private/media.mov" },
    { ...event(), credential: "must-not-persist" }
  ]) {
    assert.throws(
      () => normalizeWebhookEvent(invalid),
      (error) => ["INVALID_INPUT", "WEBHOOK_VERSION_UNSUPPORTED"].includes(error.code)
    );
  }
});

test("webhook signatures verify deterministically without returning signing material", () => {
  const rawBody = JSON.stringify(event());
  const signed = createWebhookSignature({
    secret: SIGNING_MATERIAL,
    timestamp: NOW_SECONDS,
    deliveryId: "delivery-a",
    rawBody
  });
  assert.match(signed.signature, /^v1=[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(signed, "secret"), false);
  assert.deepEqual(
    verifyWebhookSignature(
      {
        secret: SIGNING_MATERIAL,
        signature: signed.signature,
        timestamp: signed.timestamp,
        deliveryId: signed.deliveryId,
        rawBody,
        seenDeliveryIds: []
      },
      { now: NOW }
    ),
    { verified: true, timestamp: NOW_SECONDS, deliveryId: "delivery-a" }
  );
  assert.equal(
    createWebhookSignature({
      secret: SIGNING_MATERIAL,
      timestamp: NOW_SECONDS,
      deliveryId: "delivery-a",
      rawBody
    }).signature,
    signed.signature
  );
});

test("webhook verification rejects tampering, stale timestamps, and replay", () => {
  const rawBody = JSON.stringify(event());
  const signed = createWebhookSignature({
    secret: SIGNING_MATERIAL,
    timestamp: NOW_SECONDS,
    deliveryId: "delivery-a",
    rawBody
  });
  const base = {
    secret: SIGNING_MATERIAL,
    signature: signed.signature,
    timestamp: NOW_SECONDS,
    deliveryId: "delivery-a",
    rawBody,
    seenDeliveryIds: []
  };
  for (const attempt of [
    { input: { ...base, rawBody: `${rawBody} ` }, code: "WEBHOOK_SIGNATURE_INVALID" },
    { input: { ...base, deliveryId: "delivery-b" }, code: "WEBHOOK_SIGNATURE_INVALID" },
    { input: { ...base, signature: `v1=${"0".repeat(64)}` }, code: "WEBHOOK_SIGNATURE_INVALID" },
    { input: { ...base, signature: ` v1=${signed.signature.slice(3)}` }, code: "WEBHOOK_SIGNATURE_INVALID" },
    { input: { ...base, timestamp: NOW_SECONDS - 301 }, code: "WEBHOOK_TIMESTAMP_INVALID" },
    { input: { ...base, timestamp: NOW_SECONDS + 301 }, code: "WEBHOOK_TIMESTAMP_INVALID" },
    { input: { ...base, seenDeliveryIds: ["delivery-a"] }, code: "WEBHOOK_REPLAY" }
  ]) {
    assert.throws(
      () => verifyWebhookSignature(attempt.input, { now: NOW }),
      (error) => error.code === attempt.code
    );
  }
  for (const input of [
    { ...base, secret: Buffer.alloc(31) },
    { ...base, rawBody: Buffer.alloc(MAX_BODY_BYTES + 1) },
    { ...base, seenDeliveryIds: "delivery-a" },
    { ...base, seenDeliveryIds: Array.from({ length: 10_001 }, (_, index) => `delivery-${index}`) }
  ]) {
    assert.throws(
      () => verifyWebhookSignature(input, { now: NOW }),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("webhook delivery records keep bounded retry and dead-letter state without response bodies", () => {
  assert.equal(normalizeWebhookDelivery(delivery()).status, "queued");
  assert.equal(
    normalizeWebhookDelivery(
      delivery({
        status: "retry_scheduled",
        responseStatus: 503,
        resultCode: "REMOTE_UNAVAILABLE",
        updatedAt: "2026-07-25T12:00:00.000Z",
        nextAttemptAt: "2026-07-25T12:01:00.000Z",
        sequence: 3
      })
    ).status,
    "retry_scheduled"
  );
  assert.equal(
    normalizeWebhookDelivery(
      delivery({
        status: "dead_lettered",
        resultCode: "RETRY_LIMIT_REACHED",
        updatedAt: "2026-07-25T12:05:00.000Z",
        completedAt: "2026-07-25T12:05:00.000Z",
        sequence: 6
      })
    ).status,
    "dead_lettered"
  );
  for (const invalid of [
    { ...delivery(), responseBody: "provider details" },
    { ...delivery(), responseHeaders: { authorization: "must-not-persist" } },
    { ...delivery(), endpointUrl: "https://hooks.example.com" },
    delivery({ attemptNumber: 4 }),
    delivery({ attemptNumber: 2 }),
    delivery({ status: "delivered", responseStatus: 500, completedAt: "2026-07-25T12:00:00.000Z" }),
    delivery({ status: "retry_scheduled", resultCode: "raw provider error" }),
    delivery({
      status: "retry_scheduled",
      responseStatus: 204,
      resultCode: "UNEXPECTED_RESPONSE",
      nextAttemptAt: "2026-07-25T12:01:00.000Z"
    }),
    delivery({
      status: "dead_lettered",
      responseStatus: 204,
      resultCode: "UNEXPECTED_RESPONSE",
      completedAt: "2026-07-25T12:00:00.000Z"
    }),
    delivery({
      attemptNumber: 3,
      status: "retry_scheduled",
      resultCode: "REMOTE_UNAVAILABLE",
      nextAttemptAt: "2026-07-25T12:01:00.000Z"
    }),
    delivery({
      status: "retry_scheduled",
      resultCode: "REMOTE_UNAVAILABLE",
      updatedAt: "2026-07-25T12:00:00.000Z",
      nextAttemptAt: "2026-07-26T12:00:01.000Z"
    })
  ]) {
    assert.throws(
      () => normalizeWebhookDelivery(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("webhook delivery transitions are consecutive, retryable, and terminal", () => {
  const queued = delivery();
  const deliveringFirst = delivery({
    status: "delivering",
    updatedAt: "2026-07-25T12:00:00.000Z",
    sequence: 2
  });
  const retry = delivery({
    status: "retry_scheduled",
    responseStatus: 503,
    resultCode: "REMOTE_UNAVAILABLE",
    updatedAt: "2026-07-25T12:00:01.000Z",
    nextAttemptAt: "2026-07-25T12:01:00.000Z",
    sequence: 3
  });
  const deliveringSecond = delivery({
    attemptNumber: 2,
    status: "delivering",
    updatedAt: "2026-07-25T12:01:00.000Z",
    sequence: 4
  });
  const delivered = delivery({
    attemptNumber: 2,
    status: "delivered",
    responseStatus: 204,
    updatedAt: "2026-07-25T12:01:01.000Z",
    completedAt: "2026-07-25T12:01:01.000Z",
    sequence: 5
  });
  assert.equal(evaluateWebhookDeliveryTransition(queued, deliveringFirst).status, "apply");
  assert.equal(evaluateWebhookDeliveryTransition(deliveringFirst, retry).status, "apply");
  assert.equal(evaluateWebhookDeliveryTransition(retry, deliveringSecond).status, "apply");
  assert.equal(evaluateWebhookDeliveryTransition(deliveringSecond, delivered).status, "apply");
  assert.equal(evaluateWebhookDeliveryTransition(delivered, delivered).status, "idempotent");
  assert.throws(
    () =>
      evaluateWebhookDeliveryTransition(
        delivered,
        delivery({
          attemptNumber: 2,
          status: "dead_lettered",
          resultCode: "REPLACED_OUTCOME",
          updatedAt: "2026-07-25T12:02:00.000Z",
          completedAt: "2026-07-25T12:02:00.000Z",
          sequence: 6
        })
      ),
    (error) => error.code === "WEBHOOK_DELIVERY_FINAL"
  );
  assert.throws(
    () => evaluateWebhookDeliveryTransition(queued, { ...deliveringFirst, bodyHash: `sha256:${"2".repeat(64)}` }),
    (error) => error.code === "WEBHOOK_DELIVERY_MISMATCH"
  );
  assert.throws(
    () => evaluateWebhookDeliveryTransition(queued, { ...deliveringFirst, sequence: 3 }),
    (error) => error.code === "INVALID_INPUT"
  );
});
