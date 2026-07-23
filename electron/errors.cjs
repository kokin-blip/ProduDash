class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.cause = options.cause;
  }
}

function asAppError(error, fallbackCode = "INTERNAL_ERROR", fallbackMessage = "ProduDash could not complete that request.") {
  if (error instanceof AppError) return error;
  return new AppError(fallbackCode, fallbackMessage, { cause: error });
}

function errorResponse(error) {
  const safe = asAppError(error);
  return {
    ok: false,
    error: {
      code: safe.code,
      message: safe.message
    }
  };
}

module.exports = { AppError, asAppError, errorResponse };
