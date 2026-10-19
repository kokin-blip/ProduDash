export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function requireValue(condition, message) {
  if (!condition) throw new ApiError(400, 'invalid_request', message);
}

export function safeError(error) {
  if (error instanceof ApiError) return { status: error.status, body: {
    error: { code: error.code, message: error.message, ...error.details }
  } };
  // Browser and upstream exceptions can contain signed URLs or message text.
  return { status: 500, body: { error: {
    code: 'internal_error', message: 'Operation failed; no automatic retry was attempted.'
  } } };
}
