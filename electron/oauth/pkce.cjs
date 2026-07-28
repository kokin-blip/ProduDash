const crypto = require("node:crypto");
const { AppError } = require("../errors.cjs");

// PKCE (RFC 7636) code verifier and challenge.
//
// The challenge encoding is a parameter, not a constant, because providers
// disagree: Google's installed-app flow uses base64url-encoded SHA-256 per the
// RFC, while TikTok's desktop Login Kit specifies a hex-encoded SHA-256 of the
// same verifier. Hard-coding either one silently breaks the other -- the
// authorization request is accepted and only the token exchange fails.
const CHALLENGE_ENCODINGS = Object.freeze({
  BASE64URL: "base64url",
  HEX: "hex"
});

const SUPPORTED_ENCODINGS = Object.freeze(new Set(Object.values(CHALLENGE_ENCODINGS)));

// RFC 7636 section 4.1: the verifier is 43-128 characters from the unreserved
// set. 32 random bytes base64url-encode to exactly 43.
const VERIFIER_BYTES = 32;
const MIN_VERIFIER_LENGTH = 43;
const MAX_VERIFIER_LENGTH = 128;
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

function createCodeVerifier() {
  return crypto.randomBytes(VERIFIER_BYTES).toString("base64url");
}

function assertVerifier(verifier) {
  if (typeof verifier !== "string" || !VERIFIER_PATTERN.test(verifier)) {
    throw new AppError("INVALID_PKCE_VERIFIER", "The PKCE code verifier is invalid.");
  }
  return verifier;
}

function createCodeChallenge(verifier, encoding = CHALLENGE_ENCODINGS.BASE64URL) {
  assertVerifier(verifier);
  if (!SUPPORTED_ENCODINGS.has(encoding)) {
    throw new AppError("INVALID_PKCE_ENCODING", "The PKCE challenge encoding is unsupported.");
  }
  return crypto.createHash("sha256").update(verifier).digest(encoding);
}

// A fresh verifier per authorization attempt. Reusing one across attempts would
// let a leaked verifier redeem a later authorization code.
function createPkcePair(encoding = CHALLENGE_ENCODINGS.BASE64URL) {
  const verifier = createCodeVerifier();
  return {
    codeVerifier: verifier,
    codeChallenge: createCodeChallenge(verifier, encoding),
    codeChallengeMethod: "S256"
  };
}

// 32 bytes of randomness, compared in constant time on the way back in.
function createState() {
  return crypto.randomBytes(32).toString("base64url");
}

function safeStateEquals(expected, received) {
  if (typeof expected !== "string" || typeof received !== "string") return false;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  // timingSafeEqual throws on length mismatch, which itself leaks length; check
  // it separately and return the same way for both failure modes.
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

module.exports = {
  CHALLENGE_ENCODINGS,
  MAX_VERIFIER_LENGTH,
  MIN_VERIFIER_LENGTH,
  assertVerifier,
  createCodeChallenge,
  createCodeVerifier,
  createPkcePair,
  createState,
  safeStateEquals
};
