const { AppError } = require("../errors.cjs");
const { boundedString } = require("../validation.cjs");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function normalizeCustomEndpoint(value) {
  const raw = boundedString(value, { label: "Custom endpoint URL", min: 1, max: 2048 });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError("INVALID_PROVIDER_ENDPOINT", "Enter a valid custom provider endpoint URL.");
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    !["https:", "http:"].includes(parsed.protocol) ||
    (parsed.protocol === "http:" && !loopback)
  ) {
    throw new AppError(
      "INVALID_PROVIDER_ENDPOINT",
      "Custom endpoints require HTTPS, except explicit HTTP loopback addresses, and cannot contain credentials, queries, or fragments."
    );
  }
  if (!parsed.port || /^\d{1,5}$/.test(parsed.port)) {
    const port = parsed.port ? Number(parsed.port) : null;
    if (port !== null && (port < 1 || port > 65535)) {
      throw new AppError("INVALID_PROVIDER_ENDPOINT", "The custom provider endpoint port is invalid.");
    }
  } else {
    throw new AppError("INVALID_PROVIDER_ENDPOINT", "The custom provider endpoint port is invalid.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/v1";
  return parsed.toString().replace(/\/$/, "");
}

function createOriginLockedFetch(endpoint, transport = globalThis.fetch) {
  const allowed = new URL(normalizeCustomEndpoint(endpoint));
  return async (url, options = {}) => {
    const target = new URL(String(url));
    if (target.origin !== allowed.origin) {
      throw new AppError("PROVIDER_REDIRECT_BLOCKED", "The custom provider attempted to contact an unauthorized origin.");
    }
    const response = await transport(target, { ...options, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      throw new AppError("PROVIDER_REDIRECT_BLOCKED", "Custom provider redirects are not allowed.");
    }
    return response;
  };
}

module.exports = { LOOPBACK_HOSTS, createOriginLockedFetch, normalizeCustomEndpoint };
