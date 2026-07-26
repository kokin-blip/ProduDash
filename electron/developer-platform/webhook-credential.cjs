const crypto = require("node:crypto");
const { AppError } = require("../errors.cjs");
const { boundedInteger, boundedString, requireId } = require("../validation.cjs");
const { API_VERSION } = require("./api-contract.cjs");

const SECRET_BYTES = 32;
const SECRET_PATTERN = /^pdwhsec_v1_[A-Za-z0-9_-]{43}$/;
const SEALED_SECRET_PATTERN = /^[A-Za-z0-9_-]{16,8192}$/;
const MAX_PROVISIONING_DELAY_MS = 5 * 60 * 1000;

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

function normalizeWebhookCredentialIdentity(raw) {
  const value = plainObject(raw, "Webhook credential identity");
  onlyKeys(value, new Set(["organizationId", "endpointId", "signingKeyId", "createdAt"]), "Webhook credential identity");
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    endpointId: requireId(value.endpointId, "Webhook endpoint"),
    signingKeyId: requireId(value.signingKeyId, "Webhook signing key"),
    createdAt: isoTimestamp(value.createdAt, "Webhook credential creation time")
  };
}

function normalizeWebhookCredentialRecord(raw) {
  const value = plainObject(raw, "Webhook credential record");
  onlyKeys(
    value,
    new Set([
      "apiVersion",
      "organizationId",
      "endpointId",
      "signingKeyId",
      "wrappingKeyId",
      "sealedSecret",
      "createdAt",
      "revokedAt",
      "sequence"
    ]),
    "Webhook credential record"
  );
  if (value.apiVersion !== API_VERSION) {
    throw new AppError("API_VERSION_UNSUPPORTED", "The webhook credential version is unsupported.");
  }
  const createdAt = isoTimestamp(value.createdAt, "Webhook credential creation time");
  const revokedAt = isoTimestamp(value.revokedAt, "Webhook credential revocation time", true);
  if (revokedAt && Date.parse(revokedAt) < Date.parse(createdAt)) {
    throw new AppError("INVALID_INPUT", "Webhook credential revocation cannot precede creation.");
  }
  const sealedSecret = boundedString(value.sealedSecret, {
    label: "Sealed webhook signing material",
    min: 16,
    max: 8192
  });
  if (!SEALED_SECRET_PATTERN.test(sealedSecret)) {
    throw new AppError("INVALID_INPUT", "Sealed webhook signing material is invalid.");
  }
  return {
    apiVersion: API_VERSION,
    organizationId: requireId(value.organizationId, "Organization"),
    endpointId: requireId(value.endpointId, "Webhook endpoint"),
    signingKeyId: requireId(value.signingKeyId, "Webhook signing key"),
    wrappingKeyId: requireId(value.wrappingKeyId, "Webhook wrapping key"),
    sealedSecret,
    createdAt,
    revokedAt,
    sequence: boundedInteger(value.sequence, {
      label: "Webhook credential sequence",
      min: 1,
      max: 2_147_483_647
    })
  };
}

function generatedSecret(randomBytes) {
  let generated;
  try {
    generated = randomBytes(SECRET_BYTES);
  } catch {
    throw new AppError("WEBHOOK_CREDENTIAL_GENERATION_FAILED", "ProduDash could not generate webhook signing material.");
  }
  if (!Buffer.isBuffer(generated) || generated.byteLength !== SECRET_BYTES) {
    throw new AppError("WEBHOOK_CREDENTIAL_GENERATION_FAILED", "ProduDash could not generate webhook signing material.");
  }
  return `pdwhsec_v1_${generated.toString("base64url")}`;
}

function sealedResult(raw, plaintext) {
  const value = plainObject(raw, "Sealed webhook credential");
  onlyKeys(value, new Set(["wrappingKeyId", "ciphertext"]), "Sealed webhook credential");
  if (
    !Buffer.isBuffer(value.ciphertext) ||
    value.ciphertext.byteLength < plaintext.byteLength + 12 ||
    value.ciphertext.byteLength > 6144 ||
    value.ciphertext.includes(plaintext)
  ) {
    throw new AppError("WEBHOOK_CREDENTIAL_SEAL_FAILED", "ProduDash could not protect webhook signing material.");
  }
  return {
    wrappingKeyId: requireId(value.wrappingKeyId, "Webhook wrapping key"),
    sealedSecret: value.ciphertext.toString("base64url")
  };
}

async function provisionWebhookSigningCredential(rawIdentity, options = {}) {
  const identity = normalizeWebhookCredentialIdentity(rawIdentity);
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  const provisioningAge = now.getTime() - Date.parse(identity.createdAt);
  if (provisioningAge < 0 || provisioningAge > MAX_PROVISIONING_DELAY_MS) {
    throw new AppError("INVALID_INPUT", "Webhook signing material must be provisioned at endpoint creation.");
  }
  if (typeof options.seal !== "function") {
    throw new AppError("WEBHOOK_CREDENTIAL_SEAL_UNAVAILABLE", "Secure webhook credential protection is unavailable.");
  }
  const randomBytes = typeof options.randomBytes === "function" ? options.randomBytes : crypto.randomBytes;
  const signingSecret = generatedSecret(randomBytes);
  const plaintext = Buffer.from(signingSecret, "utf8");
  let protectedValue;
  try {
    protectedValue = sealedResult(
      await options.seal(plaintext, {
        organizationId: identity.organizationId,
        endpointId: identity.endpointId,
        signingKeyId: identity.signingKeyId
      }),
      plaintext
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("WEBHOOK_CREDENTIAL_SEAL_FAILED", "ProduDash could not protect webhook signing material.");
  }
  const credentialRecord = normalizeWebhookCredentialRecord({
    apiVersion: API_VERSION,
    ...identity,
    ...protectedValue,
    revokedAt: null,
    sequence: 1
  });
  return { signingSecret, credentialRecord };
}

async function openWebhookSigningCredential(rawRecord, options = {}) {
  const record = normalizeWebhookCredentialRecord(rawRecord);
  if (record.revokedAt) throw new AppError("WEBHOOK_CREDENTIAL_REVOKED", "The webhook signing credential is revoked.");
  if (typeof options.unseal !== "function") {
    throw new AppError("WEBHOOK_CREDENTIAL_UNSEAL_UNAVAILABLE", "Secure webhook credential access is unavailable.");
  }
  let plaintext;
  try {
    plaintext = await options.unseal(Buffer.from(record.sealedSecret, "base64url"), {
      organizationId: record.organizationId,
      endpointId: record.endpointId,
      signingKeyId: record.signingKeyId,
      wrappingKeyId: record.wrappingKeyId
    });
  } catch {
    throw new AppError("WEBHOOK_CREDENTIAL_UNSEAL_FAILED", "ProduDash could not access webhook signing material.");
  }
  if (!Buffer.isBuffer(plaintext)) {
    throw new AppError("WEBHOOK_CREDENTIAL_UNSEAL_FAILED", "ProduDash could not access webhook signing material.");
  }
  const signingSecret = plaintext.toString("utf8");
  if (!SECRET_PATTERN.test(signingSecret)) {
    throw new AppError("WEBHOOK_CREDENTIAL_UNSEAL_FAILED", "ProduDash could not access webhook signing material.");
  }
  return Buffer.from(signingSecret, "utf8");
}

function evaluateWebhookCredentialTransition(rawCurrent, rawNext) {
  const current = normalizeWebhookCredentialRecord(rawCurrent);
  const next = normalizeWebhookCredentialRecord(rawNext);
  if (JSON.stringify(current) === JSON.stringify(next)) return { status: "idempotent", record: current };
  for (const field of ["organizationId", "endpointId", "signingKeyId", "wrappingKeyId", "sealedSecret", "createdAt"]) {
    if (current[field] !== next[field]) {
      throw new AppError("WEBHOOK_CREDENTIAL_MISMATCH", "Webhook credential identity fields cannot change.");
    }
  }
  if (current.revokedAt) throw new AppError("WEBHOOK_CREDENTIAL_FINAL", "A revoked webhook credential cannot change.");
  if (!next.revokedAt || next.sequence !== current.sequence + 1) {
    throw new AppError("INVALID_INPUT", "Webhook credential revocation requires the next sequence.");
  }
  return { status: "apply", record: next };
}

module.exports = {
  MAX_PROVISIONING_DELAY_MS,
  SECRET_BYTES,
  evaluateWebhookCredentialTransition,
  normalizeWebhookCredentialRecord,
  openWebhookSigningCredential,
  provisionWebhookSigningCredential
};
