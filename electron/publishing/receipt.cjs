// A durable, safe record of one publication attempt to one destination.
//
// Deliberately excludes raw tokens, complete provider payloads, absolute local
// paths, and private responses. Everything here is either ProduDash's own
// identifier, a provider identifier, or a fixed safe code.
const RECEIPT_VERSION = 1;

const RECEIPT_STATUSES = Object.freeze({
  // Approved and queued, nothing sent yet.
  PENDING: "pending",
  // Bytes are being transferred.
  UPLOADING: "uploading",
  // The provider accepted the media and is processing it.
  PROCESSING: "processing",
  // The provider confirmed publication.
  PUBLISHED: "published",
  // The attempt ended without a publication.
  FAILED: "failed"
});

const STATUS_VALUES = Object.freeze(new Set(Object.values(RECEIPT_STATUSES)));

const MAX_ATTEMPTS_RECORDED = 10;
const HEX_64 = /^[a-f0-9]{64}$/;

function isIsoTimestamp(value) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function safeIdentifier(value, max = 128) {
  return typeof value === "string" && value ? value.slice(0, max) : null;
}

function createReceipt({ planId, platformId, accountId, approvedContentHash, idempotencyKey }) {
  return {
    version: RECEIPT_VERSION,
    planId,
    platformId,
    accountId: accountId || null,
    approvedContentHash,
    idempotencyKey,
    providerPublicationId: null,
    status: RECEIPT_STATUSES.PENDING,
    attempts: [],
    errorCode: null,
    retryable: true,
    // Says only that a resumable session exists. The session URI itself is a
    // capability and lives in the encrypted vault, never here.
    hasResumableSession: false
  };
}

function normalizeAttempt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isIsoTimestamp(value.startedAt)) return null;
  return {
    startedAt: new Date(value.startedAt).toISOString(),
    endedAt: isIsoTimestamp(value.endedAt) ? new Date(value.endedAt).toISOString() : null,
    outcome: STATUS_VALUES.has(value.outcome) ? value.outcome : RECEIPT_STATUSES.FAILED
  };
}

// Coerces onto the known shape and drops unknown keys, so a provider response
// can never widen what gets persisted.
function normalizeReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const planId = safeIdentifier(value.planId);
  const platformId = safeIdentifier(value.platformId, 40);
  const idempotencyKey = typeof value.idempotencyKey === "string" && HEX_64.test(value.idempotencyKey) ? value.idempotencyKey : null;
  const approvedContentHash =
    typeof value.approvedContentHash === "string" && HEX_64.test(value.approvedContentHash) ? value.approvedContentHash : null;
  if (!planId || !platformId || !idempotencyKey || !approvedContentHash) return null;
  return {
    version: RECEIPT_VERSION,
    planId,
    platformId,
    accountId: safeIdentifier(value.accountId),
    approvedContentHash,
    idempotencyKey,
    providerPublicationId: safeIdentifier(value.providerPublicationId),
    status: STATUS_VALUES.has(value.status) ? value.status : RECEIPT_STATUSES.PENDING,
    attempts: (Array.isArray(value.attempts) ? value.attempts : []).map(normalizeAttempt).filter(Boolean).slice(-MAX_ATTEMPTS_RECORDED),
    // Codes only -- never a provider message.
    errorCode: typeof value.errorCode === "string" && /^[A-Z0-9_]{1,60}$/.test(value.errorCode) ? value.errorCode : null,
    retryable: value.retryable !== false,
    hasResumableSession: value.hasResumableSession === true
  };
}

function validateReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.version !== RECEIPT_VERSION) return false;
  if (typeof value.planId !== "string" || !value.planId) return false;
  if (typeof value.platformId !== "string" || !value.platformId) return false;
  if (!HEX_64.test(value.idempotencyKey || "")) return false;
  if (!HEX_64.test(value.approvedContentHash || "")) return false;
  if (!STATUS_VALUES.has(value.status)) return false;
  if (!Array.isArray(value.attempts) || value.attempts.length > MAX_ATTEMPTS_RECORDED) return false;
  if (value.attempts.some((attempt) => !isIsoTimestamp(attempt?.startedAt))) return false;
  if (value.errorCode !== null && !/^[A-Z0-9_]{1,60}$/.test(value.errorCode)) return false;
  if (typeof value.retryable !== "boolean") return false;
  if (typeof value.hasResumableSession !== "boolean") return false;
  if (value.providerPublicationId !== null && typeof value.providerPublicationId !== "string") return false;
  if (value.accountId !== null && typeof value.accountId !== "string") return false;
  // A receipt must never carry a token, a path, or a raw provider body.
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") continue;
    if (/token|secret|password/i.test(key)) return false;
    // Absolute POSIX or Windows paths.
    if (/^(?:[/~]|[A-Za-z]:[\\/])/.test(entry)) return false;
  }
  return true;
}

// Whether the provider has already created something for this destination.
//
// This is the question that decides not to upload again, and it is keyed on the
// provider's own id rather than on how the attempt is classified. A video
// YouTube has accepted but not finished processing exists; so does one it
// accepted and later rejected. Sending either a second time puts a duplicate on
// the channel, so the id alone is what makes a repeated dispatch -- another
// click, or a restart mid-flight -- safe.
function hasProviderPublication(receipt) {
  return Boolean(receipt?.providerPublicationId);
}

// Whether this destination actually succeeded, which is a different question
// and decides whether the plan as a whole published. A receipt the provider
// later rejected keeps its id, so that a retry cannot duplicate it, but it is
// not a success.
function isAlreadyPublished(receipt) {
  return Boolean(
    receipt?.providerPublicationId && (receipt.status === RECEIPT_STATUSES.PUBLISHED || receipt.status === RECEIPT_STATUSES.PROCESSING)
  );
}

module.exports = {
  MAX_ATTEMPTS_RECORDED,
  RECEIPT_STATUSES,
  RECEIPT_VERSION,
  createReceipt,
  hasProviderPublication,
  isAlreadyPublished,
  normalizeReceipt,
  validateReceipt
};
