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

  async interact(apiKey, input, schema, modelId = MODEL, options = {}) {
    const key = boundedString(apiKey, { label: "Gemini API key", min: 8, max: 4096 });
    try {
      const client = await this.clientFactory(key);
      return await withTimeout(
        client.interactions.create(
          {
            model: modelId,
            input,
            ...(schema
              ? {
                  response_format: {
                    type: "text",
                    mime_type: "application/json",
                    schema
                  }
                }
              : {}),
            ...(options.stream ? { stream: true } : {}),
            ...(Array.isArray(options.tools) ? { tools: options.tools } : {})
          },
          { signal: options.signal }
        ),
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

  async generateText(apiKey, input, modelId = MODEL) {
    const interaction = await this.interact(apiKey, input, null, modelId);
    if (typeof interaction?.outputText !== "string") {
      throw new AppError("GEMINI_INVALID_RESPONSE", "Gemini returned an invalid text response.");
    }
    return interaction.outputText;
  }

  async streamText(apiKey, input, modelId = MODEL) {
    return this.interact(apiKey, input, null, modelId, { stream: true });
  }

  async generateWithTools(apiKey, input, tools, modelId = MODEL, signal) {
    return this.interact(apiKey, input, null, modelId, { tools, signal });
  }

  async generateStructuredWithMedia(apiKey, prompt, media, schema, schemaName, modelId = MODEL) {
    const key = boundedString(apiKey, { label: "Gemini API key", min: 8, max: 4096 });
    let client;
    const uploaded = [];
    try {
      client = await this.clientFactory(key);
      const mediaContent = [];
      for (const item of Array.isArray(media) ? media : [media]) {
        if (item.path) {
          const file = await withTimeout(client.files.upload({ file: item.path, config: { mimeType: item.mimeType } }), this.timeoutMs);
          uploaded.push(file);
          mediaContent.push({ type: item.type, uri: file.uri, mime_type: file.mimeType || item.mimeType });
        } else {
          mediaContent.push({ type: item.type, data: item.data, mime_type: item.mimeType });
        }
      }
      const interaction = await withTimeout(
        client.interactions.create({
          model: modelId,
          input: [{ type: "text", text: prompt }, ...mediaContent],
          response_format: { type: "text", mime_type: "application/json", schema }
        }),
        this.timeoutMs
      );
      return parseInteraction(interaction, schemaName);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("GEMINI_API_ERROR", "Gemini could not analyze the selected media.");
    } finally {
      if (client?.files?.delete) {
        await Promise.all(uploaded.filter((file) => file?.name).map((file) => client.files.delete({ name: file.name }).catch(() => {})));
      }
    }
  }
}

module.exports = { GeminiConnector, MODEL, VALIDATION_SCHEMA };
