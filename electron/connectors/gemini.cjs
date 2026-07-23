const { AppError } = require("../errors.cjs");
const { boundedString } = require("../validation.cjs");

const MODEL = "gemini-3.6-flash";
const VALIDATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["ok"] }
  },
  required: ["status"]
};
async function defaultClientFactory(apiKey) {
  const { GoogleGenAI } = await import("@google/genai");
  return new GoogleGenAI({ apiKey });
}

function withTimeout(promise, timeoutMs) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new AppError("GEMINI_TIMEOUT", "Gemini did not respond before the request timed out.")), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function parseInteraction(interaction, schemaName) {
  const raw = interaction?.outputText;
  if (typeof raw !== "string") throw new AppError("GEMINI_INVALID_RESPONSE", `Gemini returned an invalid ${schemaName} response.`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError("GEMINI_INVALID_RESPONSE", `Gemini returned malformed ${schemaName} data.`);
  }
}

class GeminiConnector {
  constructor(options = {}) {
    this.clientFactory = options.clientFactory || defaultClientFactory;
    this.timeoutMs = options.timeoutMs || 20_000;
  }

  async interact(apiKey, input, schema, modelId = MODEL) {
    const key = boundedString(apiKey, { label: "Gemini API key", min: 8, max: 4096 });
    try {
      const client = await this.clientFactory(key);
      return await withTimeout(
        client.interactions.create({
          model: modelId,
          input,
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema
          }
        }),
        this.timeoutMs
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("GEMINI_API_ERROR", "Gemini could not complete the request.");
    }
  }

  async validate(apiKey, modelId = MODEL) {
    const interaction = await this.interact(apiKey, "Return a JSON object with status set to ok.", VALIDATION_SCHEMA, modelId);
    const result = parseInteraction(interaction, "connection validation");
    if (result.status !== "ok") throw new AppError("GEMINI_INVALID_RESPONSE", "Gemini did not validate the connection.");
    return true;
  }

  async generateStructured(apiKey, input, schema, schemaName = "structured", modelId = MODEL) {
    const interaction = await this.interact(apiKey, input, schema, modelId);
    return parseInteraction(interaction, schemaName);
  }
}

module.exports = { GeminiConnector, MODEL, VALIDATION_SCHEMA };
