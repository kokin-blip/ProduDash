const { AppError } = require("../errors.cjs");

// Durable record of an in-flight resumable upload.
//
// This exists because ProduDash's idempotency key is local: the provider never
// sees it. Without a persisted session there is a window where YouTube has
// accepted a complete upload and created a video, ProduDash exits before
// recording the returned id, and the next dispatch -- seeing a receipt with no
// publication id -- opens a fresh session and uploads a second copy.
//
// The session URI is a capability: anyone holding it can append bytes to that
// upload. It is therefore stored in the encrypted credential vault alongside
// tokens, never in app state, exports, audit entries, receipts, or errors.
// Public state carries only a boolean saying a session exists.
const SESSION_VERSION = 1;

// `open` is resumable. `unresolved` records an attempt whose outcome could not
// be established with the provider: it is deliberately kept rather than
// deleted, because deleting it would make the next dispatch look like a first
// attempt and upload the duplicate this module exists to prevent.
const SESSION_STATUSES = Object.freeze({ OPEN: "open", UNRESOLVED: "unresolved" });

const HEX_64 = /^[a-f0-9]{64}$/;

// Mirrors the existing `media-job-${id}` convention in the vault.
const VAULT_KEY_PREFIX = "upload-session-";

function vaultKeyFor(idempotencyKey) {
  if (typeof idempotencyKey !== "string" || !HEX_64.test(idempotencyKey)) {
    throw new AppError("INVALID_INPUT", "An upload session requires a valid idempotency key.");
  }
  return `${VAULT_KEY_PREFIX}${idempotencyKey}`;
}

function createUploadSession({ planId, platformId, approvalHash, idempotencyKey, uploadUri, contentLength, createdAt }) {
  if (!uploadUri || typeof uploadUri !== "string") {
    throw new AppError("INVALID_INPUT", "An upload session requires a session URI.");
  }
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    throw new AppError("INVALID_INPUT", "An upload session requires a positive content length.");
  }
  return {
    version: SESSION_VERSION,
    planId,
    platformId,
    // Provenance only. The vault key derives from the idempotency key, which is
    // sha256(`${planId}:${platformId}:${approvalHash}`) and is re-verified on
    // load, so a record found under this key cannot belong to a different
    // approval. Guarding against a mismatch here would be unreachable code.
    approvalHash,
    idempotencyKey,
    uploadUri,
    contentLength,
    createdAt: createdAt || new Date().toISOString(),
    status: SESSION_STATUSES.OPEN
  };
}

// Whether this record is worth taking to the provider.
//
// Two things are deliberately not criteria. Age is not: a session URI's real
// state is only knowable by asking, and condemning an old-but-live session on a
// guess is the restart this module exists to avoid. `version` is not either --
// it is provenance, and a record written by a different build still carries the
// only two fields that mean anything to the provider. Refusing on version alone
// turned a routine bump into a message telling every user with an interrupted
// upload that it could not be reconciled, without ever asking.
//
// The obligation that buys: a future version that changes what `uploadUri` or
// `contentLength` mean must migrate or clear existing records, because old ones
// are still acted upon. Adding a field is free; redefining these two is not.
function isUsableSession(session) {
  if (!session || session.status !== SESSION_STATUSES.OPEN) return false;
  if (typeof session.uploadUri !== "string" || !session.uploadUri) return false;
  return Number.isFinite(session.contentLength) && session.contentLength > 0;
}

// Reading, writing, and clearing the private session record. Kept behind a
// small class so the vault key convention lives in exactly one place.
class UploadSessionStore {
  constructor(credentialVault) {
    this.credentialVault = credentialVault;
  }

  assertAvailable() {
    if (!this.credentialVault) {
      throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure storage is unavailable, so an upload cannot be resumed safely.");
    }
  }

  get(idempotencyKey) {
    if (!this.credentialVault) return null;
    const stored = this.credentialVault.get(vaultKeyFor(idempotencyKey));
    if (!stored?.session) return null;
    try {
      return JSON.parse(stored.session);
    } catch {
      return null;
    }
  }

  // Persisted before any bytes are sent. That ordering is the entire point.
  async save(session) {
    this.assertAvailable();
    await this.credentialVault.replace(vaultKeyFor(session.idempotencyKey), { session: JSON.stringify(session) });
    return session;
  }

  // Retires a session whose outcome could not be established, without losing
  // the evidence that it happened. `isUsableSession` rejects the result, so
  // every later dispatch refuses identically instead of starting over.
  async markUnresolved(idempotencyKey) {
    const session = this.get(idempotencyKey);
    if (!session || session.status === SESSION_STATUSES.UNRESOLVED) return session;
    return this.save({ ...session, status: SESSION_STATUSES.UNRESOLVED });
  }

  async clear(idempotencyKey) {
    if (!this.credentialVault) return;
    await this.credentialVault.remove(vaultKeyFor(idempotencyKey));
  }

  // Every session record still stored, for when the plans that owned them are
  // gone. A record is addressed by its destination's idempotency key, so once
  // the plan carrying that destination is destroyed there is no way to name it
  // again -- and it holds a URI that can still append bytes to a real upload.
  async clearAll() {
    if (!this.credentialVault) return;
    const stored = this.credentialVault.entryIds().filter((id) => id.startsWith(VAULT_KEY_PREFIX));
    if (stored.length) await this.credentialVault.removeMany(stored);
  }
}

module.exports = {
  SESSION_STATUSES,
  SESSION_VERSION,
  UploadSessionStore,
  createUploadSession,
  isUsableSession,
  vaultKeyFor
};
