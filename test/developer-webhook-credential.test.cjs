const assert = require("node:assert/strict");
const test = require("node:test");
const {
  evaluateWebhookCredentialTransition,
  normalizeWebhookCredentialRecord,
  openWebhookSigningCredential,
  provisionWebhookSigningCredential
} = require("../electron/developer-platform/webhook-credential.cjs");
const { createWebhookSignature, verifyWebhookSignature } = require("../electron/developer-platform/webhook-contract.cjs");

const NOW = new Date("2026-07-25T12:00:00.000Z");

function identity(overrides = {}) {
  return {
    organizationId: "organization-a",
    endpointId: "endpoint-a",
    signingKeyId: "signing-key-a",
    createdAt: NOW.toISOString(),
    ...overrides
  };
}

function seal(plaintext) {
  return {
    wrappingKeyId: "wrapping-key-a",
    ciphertext: Buffer.concat([Buffer.alloc(16, 11), Buffer.from(plaintext.map((value) => value ^ 0x5a))])
  };
}

function unseal(ciphertext) {
  return Buffer.from(ciphertext.subarray(16).map((value) => value ^ 0x5a));
}

test("webhook provisioning returns a secret once and retains only sealed signing material", async () => {
  const issued = await provisionWebhookSigningCredential(identity(), {
    now: NOW,
    randomBytes: () => Buffer.alloc(32, 7),
    seal
  });
  assert.match(issued.signingSecret, /^pdwhsec_v1_[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(issued.credentialRecord).includes(issued.signingSecret), false);
  assert.equal(Object.hasOwn(issued.credentialRecord, "signingSecret"), false);
  assert.equal(Object.hasOwn(issued.credentialRecord, "secret"), false);
  const opened = await openWebhookSigningCredential(issued.credentialRecord, { unseal });
  assert.equal(opened.toString("utf8"), issued.signingSecret);
});

test("opened webhook signing material interoperates with the existing HMAC contract", async () => {
  const issued = await provisionWebhookSigningCredential(identity(), {
    now: NOW,
    randomBytes: () => Buffer.alloc(32, 8),
    seal
  });
  const secret = await openWebhookSigningCredential(issued.credentialRecord, { unseal });
  const signed = createWebhookSignature({
    secret,
    timestamp: Math.floor(NOW.getTime() / 1000),
    deliveryId: "delivery-a",
    rawBody: '{"event":"job.completed"}'
  });
  assert.equal(
    verifyWebhookSignature(
      {
        secret: issued.signingSecret,
        ...signed,
        rawBody: '{"event":"job.completed"}',
        seenDeliveryIds: []
      },
      { now: new Date("2026-07-25T12:00:00.000Z") }
    ).verified,
    true
  );
});

test("webhook credentials require injected sealing and reject plaintext persisted fields", async () => {
  await assert.rejects(
    () => provisionWebhookSigningCredential(identity(), { now: NOW, randomBytes: () => Buffer.alloc(32, 1) }),
    (error) => error.code === "WEBHOOK_CREDENTIAL_SEAL_UNAVAILABLE"
  );
  await assert.rejects(
    () =>
      provisionWebhookSigningCredential(identity(), {
        now: NOW,
        randomBytes: () => Buffer.alloc(32, 1),
        seal: (plaintext) => ({ wrappingKeyId: "wrapping-key-a", ciphertext: plaintext })
      }),
    (error) => error.code === "WEBHOOK_CREDENTIAL_SEAL_FAILED"
  );
  for (const invalid of [
    {
      apiVersion: "v1",
      ...identity(),
      wrappingKeyId: "wrapping-key-a",
      sealedSecret: Buffer.from("sealed-material").toString("base64url"),
      revokedAt: null,
      sequence: 1,
      secret: "plaintext"
    },
    {
      apiVersion: "v1",
      ...identity(),
      wrappingKeyId: "wrapping-key-a",
      sealedSecret: Buffer.from("sealed-material").toString("base64url"),
      revokedAt: null,
      sequence: 1,
      localPath: "/private/credential"
    }
  ]) {
    assert.throws(
      () => normalizeWebhookCredentialRecord(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("webhook credential revocation is consecutive, idempotent, and irreversible", async () => {
  const issued = await provisionWebhookSigningCredential(identity(), {
    now: NOW,
    randomBytes: () => Buffer.alloc(32, 2),
    seal
  });
  const revoked = normalizeWebhookCredentialRecord({
    ...issued.credentialRecord,
    revokedAt: "2026-07-25T12:05:00.000Z",
    sequence: 2
  });
  assert.equal(evaluateWebhookCredentialTransition(issued.credentialRecord, revoked).status, "apply");
  assert.equal(evaluateWebhookCredentialTransition(revoked, revoked).status, "idempotent");
  await assert.rejects(
    () => openWebhookSigningCredential(revoked, { unseal }),
    (error) => error.code === "WEBHOOK_CREDENTIAL_REVOKED"
  );
  assert.throws(
    () =>
      evaluateWebhookCredentialTransition(revoked, {
        ...revoked,
        revokedAt: "2026-07-25T12:06:00.000Z",
        sequence: 3
      }),
    (error) => error.code === "WEBHOOK_CREDENTIAL_FINAL"
  );
});
