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
const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    draft: { type: "string" },
    intent: { type: "string" },
    summary: { type: "string" },
    orderDetails: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        item: { type: ["string", "null"] },
        variant: { type: ["string", "null"] },
        quantity: { type: ["integer", "null"] },
        value: { type: ["number", "null"] },
        currency: { type: ["string", "null"] },
        paymentStatus: { type: ["string", "null"] }
      }
    },
    recommendedAction: { type: "string" },
    riskFlags: { type: "array", maxItems: 10, items: { type: "string" } }
  },
  required: ["draft", "intent", "summary", "orderDetails", "recommendedAction", "riskFlags"]
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

  async interact(apiKey, input, schema) {
    const key = boundedString(apiKey, { label: "Gemini API key", min: 8, max: 4096 });
    try {
      const client = await this.clientFactory(key);
      return await withTimeout(
        client.interactions.create({
          model: MODEL,
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

  async validate(apiKey) {
    const interaction = await this.interact(apiKey, "Return a JSON object with status set to ok.", VALIDATION_SCHEMA);
    const result = parseInteraction(interaction, "connection validation");
    if (result.status !== "ok") throw new AppError("GEMINI_INVALID_RESPONSE", "Gemini did not validate the connection.");
    return true;
  }

  async draftReply(conversation, instruction, business) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages.slice(-20) : [];
    const safeConversation = {
      channel: String(conversation.channel || "unknown").slice(0, 80),
      intent: String(conversation.intent || "unknown").slice(0, 120),
      risk: String(conversation.risk || "human review required").slice(0, 160),
      messages: messages.map((message) => ({
        role: message.role === "customer" ? "customer" : "staff",
        text: String(message.text || "").slice(0, 2000)
      }))
    };
    const prompt = [
      "You are an internal customer-support drafting assistant.",
      "Do not claim to send messages, charge customers, place orders, refund, discount, or fulfill anything.",
      "Create a concise draft that requires human approval.",
      `Business: ${String(business.name || "Connected business").slice(0, 120)}`,
      `Operator instruction: ${instruction}`,
      `Conversation JSON: ${JSON.stringify(safeConversation).slice(0, 20_000)}`
    ].join("\n");
    const interaction = await this.interact(business.geminiApiKey, prompt, DRAFT_SCHEMA);
    return validateDraftResult(parseInteraction(interaction, "draft"));
  }
}

function validateDraftResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new AppError("GEMINI_INVALID_RESPONSE", "Gemini returned an invalid draft.");
  }
  if (
    result.orderDetails !== null &&
    (!result.orderDetails || typeof result.orderDetails !== "object" || Array.isArray(result.orderDetails))
  ) {
    throw new AppError("GEMINI_INVALID_RESPONSE", "Gemini returned invalid order details.");
  }
  if (!Array.isArray(result.riskFlags)) throw new AppError("GEMINI_INVALID_RESPONSE", "Gemini returned invalid risk flags.");
  return {
    draft: boundedString(result.draft, { label: "Gemini draft", min: 1, max: 2000 }),
    intent: boundedString(result.intent, { label: "Gemini intent", min: 1, max: 120 }),
    summary: boundedString(result.summary, { label: "Gemini summary", min: 1, max: 500 }),
    orderDetails: result.orderDetails ? normalizeOrderDetails(result.orderDetails) : null,
    recommendedAction: boundedString(result.recommendedAction, { label: "Gemini recommendation", min: 1, max: 500 }),
    riskFlags: result.riskFlags.slice(0, 10).map((item) => boundedString(item, { label: "Gemini risk flag", min: 1, max: 120 }))
  };
}

function normalizeOrderDetails(details) {
  const optionalText = (value, label, max) =>
    value === null || value === undefined || value === "" ? null : boundedString(value, { label, min: 1, max });
  const quantity = details.quantity === null || details.quantity === undefined ? null : Number(details.quantity);
  const value = details.value === null || details.value === undefined ? null : Number(details.value);
  if (quantity !== null && (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000)) {
    throw new AppError("GEMINI_INVALID_RESPONSE", "Gemini returned an invalid order quantity.");
  }
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100_000_000)) {
    throw new AppError("GEMINI_INVALID_RESPONSE", "Gemini returned an invalid order value.");
  }
  const currency = optionalText(details.currency, "Gemini order currency", 3)?.toUpperCase() || null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new AppError("GEMINI_INVALID_RESPONSE", "Gemini returned an invalid order currency.");
  return {
    item: optionalText(details.item, "Gemini order item", 240),
    variant: optionalText(details.variant, "Gemini order variant", 240),
    quantity,
    value,
    currency,
    paymentStatus: optionalText(details.paymentStatus, "Gemini payment status", 80)
  };
}

module.exports = { DRAFT_SCHEMA, GeminiConnector, MODEL, VALIDATION_SCHEMA, normalizeOrderDetails, validateDraftResult };
