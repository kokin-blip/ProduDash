const crypto = require("node:crypto");
const { AppError } = require("../errors.cjs");
const { API_VERSION, normalizeApiTokenMetadata } = require("./api-contract.cjs");

const LOOKUP_BYTES = 12;
const SECRET_BYTES = 32;
const TOKEN_PATTERN = /^pd_v1_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/;
const LOOKUP_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_ISSUANCE_DELAY_MS = 5 * 60 * 1000;

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
  if (typeof value !== "string" || value.length < 1 || value.length > 40) {
    throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return new Date(timestamp).toISOString();
}

function normalizeApiCredentialRecord(raw) {
  const value = plainObject(raw, "API credential record");
  onlyKeys(
    value,
    new Set(["apiVersion", "organizationId", "tokenId", "lookupId", "bearerHash", "createdAt", "expiresAt", "revokedAt", "sequence"]),
    "API credential record"
  );
  if (value.apiVersion !== API_VERSION) {
    throw new AppError("API_VERSION_UNSUPPORTED", "The API credential version is unsupported.");
  }
  if (typeof value.lookupId !== "string" || !LOOKUP_PATTERN.test(value.lookupId)) {
    throw new AppError("INVALID_INPUT", "API credential lookup identifier is invalid.");
  }
  if (typeof value.bearerHash !== "string" || !HASH_PATTERN.test(value.bearerHash)) {
    throw new AppError("INVALID_INPUT", "API credential hash is invalid.");
  }
  const createdAt = isoTimestamp(value.createdAt, "API credential creation time");
  const expiresAt = isoTimestamp(value.expiresAt, "API credential expiry");
  const revokedAt = isoTimestamp(value.revokedAt, "API credential revocation time", true);
  if (Date.parse(expiresAt) <= Date.parse(createdAt) || (revokedAt && Date.parse(revokedAt) < Date.parse(createdAt))) {
    throw new AppError("INVALID_INPUT", "API credential lifecycle timestamps are invalid.");
  }
  if (
    typeof value.organizationId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.organizationId) ||
    typeof value.tokenId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.tokenId)
  ) {
    throw new AppError("INVALID_INPUT", "API credential identity is invalid.");
  }
  if (!Number.isInteger(value.sequence) || value.sequence < 1 || value.sequence > 2_147_483_647) {
    throw new AppError("INVALID_INPUT", "API credential sequence is invalid.");
  }
  return {
    apiVersion: API_VERSION,
    organizationId: value.organizationId,
    tokenId: value.tokenId,
    lookupId: value.lookupId,
    bearerHash: value.bearerHash,
    createdAt,
    expiresAt,
    revokedAt,
    sequence: value.sequence
  };
}

function hashBearerToken(bearerToken) {
  return `sha256:${crypto.createHash("sha256").update(bearerToken, "utf8").digest("hex")}`;
}

function randomMaterial(randomBytes) {
  let generated;
  try {
    generated = randomBytes(LOOKUP_BYTES + SECRET_BYTES);
  } catch {
    throw new AppError("API_CREDENTIAL_GENERATION_FAILED", "ProduDash could not generate an API credential.");
  }
  if (!Buffer.isBuffer(generated) || generated.byteLength !== LOOKUP_BYTES + SECRET_BYTES) {
    throw new AppError("API_CREDENTIAL_GENERATION_FAILED", "ProduDash could not generate an API credential.");
  }
  return generated;
}

function issueApiCredential(rawMetadata, options = {}) {
  const metadata = normalizeApiTokenMetadata(rawMetadata);
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  const creationAge = now.getTime() - Date.parse(metadata.createdAt);
  if (metadata.revokedAt || creationAge < 0 || creationAge > MAX_ISSUANCE_DELAY_MS || Date.parse(metadata.expiresAt) <= now.getTime()) {
    throw new AppError("INVALID_INPUT", "API token metadata is not active for issuance.");
  }
  const randomBytes = typeof options.randomBytes === "function" ? options.randomBytes : crypto.randomBytes;
  const generated = randomMaterial(randomBytes);
  const lookupId = generated.subarray(0, LOOKUP_BYTES).toString("base64url");
  const secret = generated.subarray(LOOKUP_BYTES).toString("base64url");
  const bearerToken = `pd_v1_${lookupId}_${secret}`;
  const credentialRecord = normalizeApiCredentialRecord({
    apiVersion: API_VERSION,
    organizationId: metadata.organizationId,
    tokenId: metadata.tokenId,
    lookupId,
    bearerHash: hashBearerToken(bearerToken),
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
    revokedAt: null,
    sequence: 1
  });
  return { bearerToken, credentialRecord };
}

function assertCredentialMatchesMetadata(rawCredential, rawMetadata) {
  const credential = normalizeApiCredentialRecord(rawCredential);
  const metadata = normalizeApiTokenMetadata(rawMetadata);
  if (
    credential.organizationId !== metadata.organizationId ||
    credential.tokenId !== metadata.tokenId ||
    credential.createdAt !== metadata.createdAt ||
    credential.expiresAt !== metadata.expiresAt ||
    credential.revokedAt !== metadata.revokedAt
  ) {
    throw new AppError("API_CREDENTIAL_MISMATCH", "The API credential does not match its public token metadata.");
  }
  return { credential, metadata };
}

function verifyApiCredential(bearerToken, rawCredential, rawMetadata, options = {}) {
  const match = typeof bearerToken === "string" ? TOKEN_PATTERN.exec(bearerToken) : null;
  if (!match) throw new AppError("API_UNAUTHENTICATED", "The API credential is invalid.");
  const { credential } = assertCredentialMatchesMetadata(rawCredential, rawMetadata);
  const suppliedLookup = Buffer.from(match[1], "utf8");
  const expectedLookup = Buffer.from(credential.lookupId, "utf8");
  const suppliedHash = Buffer.from(hashBearerToken(bearerToken).slice(7), "hex");
  const expectedHash = Buffer.from(credential.bearerHash.slice(7), "hex");
  const validLookup = suppliedLookup.length === expectedLookup.length && crypto.timingSafeEqual(suppliedLookup, expectedLookup);
  const validHash = suppliedHash.length === expectedHash.length && crypto.timingSafeEqual(suppliedHash, expectedHash);
  if (!validLookup || !validHash) throw new AppError("API_UNAUTHENTICATED", "The API credential is invalid.");
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  if (credential.revokedAt) throw new AppError("API_TOKEN_REVOKED", "This API token has been revoked.");
  if (Date.parse(credential.expiresAt) <= now.getTime()) throw new AppError("API_TOKEN_EXPIRED", "This API token has expired.");
  return {
    verified: true,
    organizationId: credential.organizationId,
    tokenId: credential.tokenId
  };
}

function evaluateApiCredentialTransition(rawCurrent, rawNext) {
  const current = normalizeApiCredentialRecord(rawCurrent);
  const next = normalizeApiCredentialRecord(rawNext);
  if (JSON.stringify(current) === JSON.stringify(next)) return { status: "idempotent", record: current };
  for (const field of ["organizationId", "tokenId", "lookupId", "bearerHash", "createdAt", "expiresAt"]) {
    if (current[field] !== next[field]) {
      throw new AppError("API_CREDENTIAL_MISMATCH", "API credential identity fields cannot change.");
    }
  }
  if (current.revokedAt) throw new AppError("API_CREDENTIAL_FINAL", "A revoked API credential cannot be changed.");
  if (!next.revokedAt || next.sequence !== current.sequence + 1) {
    throw new AppError("INVALID_INPUT", "API credential revocation requires the next sequence.");
  }
  return { status: "apply", record: next };
}

function sameValues(first, second) {
  if (first === null || second === null) return first === second;
  if (first.length !== second.length) return false;
  const sortedFirst = [...first].sort();
  const sortedSecond = [...second].sort();
  return sortedFirst.every((value, index) => value === sortedSecond[index]);
}

function assertApiCredentialRotation(rawPreviousMetadata, rawPreviousCredential, rawNextMetadata, rawNextCredential) {
  const previous = assertCredentialMatchesMetadata(rawPreviousCredential, rawPreviousMetadata);
  const next = assertCredentialMatchesMetadata(rawNextCredential, rawNextMetadata);
  const samePrivileges =
    sameValues(previous.metadata.scopes, next.metadata.scopes) &&
    sameValues(previous.metadata.projectIds, next.metadata.projectIds) &&
    previous.metadata.rateLimitClass === next.metadata.rateLimitClass;
  if (
    !previous.credential.revokedAt ||
    next.credential.revokedAt ||
    previous.metadata.organizationId !== next.metadata.organizationId ||
    previous.metadata.tokenId === next.metadata.tokenId ||
    next.metadata.rotatedFromTokenId !== previous.metadata.tokenId ||
    Date.parse(next.metadata.createdAt) < Date.parse(previous.credential.revokedAt) ||
    !samePrivileges
  ) {
    throw new AppError("INVALID_API_ROTATION", "API credential rotation is invalid.");
  }
  return {
    valid: true,
    organizationId: next.metadata.organizationId,
    previousTokenId: previous.metadata.tokenId,
    nextTokenId: next.metadata.tokenId
  };
}

module.exports = {
  LOOKUP_BYTES,
  MAX_ISSUANCE_DELAY_MS,
  SECRET_BYTES,
  assertApiCredentialRotation,
  assertCredentialMatchesMetadata,
  evaluateApiCredentialTransition,
  issueApiCredential,
  normalizeApiCredentialRecord,
  verifyApiCredential
};
