const { AppError } = require("../errors.cjs");

const DEFAULT_TIMEOUT_MS = 20_000;

function withProviderTimeout(promise, providerName, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new AppError("PROVIDER_TIMEOUT", `${providerName} did not respond before the request timed out.`)),
      timeoutMs
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

function normalizeProviderError(error, providerName) {
  if (error instanceof AppError) return error;
  const status = Number(error?.status);
  if (status === 401 || status === 403) {
    return new AppError("PROVIDER_AUTH_FAILED", `${providerName} rejected the configured credentials.`);
  }
  if (status === 429) {
    return new AppError("PROVIDER_RATE_LIMITED", `${providerName} is temporarily rate limited. Try again later.`);
  }
  if (status >= 500 || error?.code === "ECONNRESET" || error?.code === "ENOTFOUND") {
    return new AppError("PROVIDER_UNAVAILABLE", `${providerName} is temporarily unavailable.`);
  }
  return new AppError("PROVIDER_REQUEST_FAILED", `${providerName} could not complete the request.`);
}

function parseJsonText(value, providerName, schemaName = "structured") {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("PROVIDER_INVALID_RESPONSE", `${providerName} returned an invalid ${schemaName} response.`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new AppError("PROVIDER_INVALID_RESPONSE", `${providerName} returned malformed ${schemaName} data.`);
  }
}

function normalizeToolCalls(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.type === "function_call" || item?.type === "tool_use")
    .slice(0, 20)
    .map((item) => {
      let input = item.arguments ?? item.input ?? {};
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          input = {};
        }
      }
      return {
        id: String(item.call_id || item.id || "").slice(0, 200),
        name: String(item.name || "").slice(0, 100),
        input: input && typeof input === "object" && !Array.isArray(input) ? input : {}
      };
    });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  normalizeProviderError,
  normalizeToolCalls,
  parseJsonText,
  withProviderTimeout
};
