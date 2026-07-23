const assert = require("node:assert/strict");
const test = require("node:test");
const { GeminiConnector, MODEL } = require("../electron/connectors/gemini.cjs");

function clientReturning(value, capture = {}) {
  return {
    interactions: {
      async create(request) {
        capture.request = request;
        return { outputText: typeof value === "string" ? value : JSON.stringify(value) };
      }
    }
  };
}

test("Gemini validates a real structured connection response", async () => {
  const capture = {};
  const connector = new GeminiConnector({ clientFactory: async () => clientReturning({ status: "ok" }, capture) });
  assert.equal(await connector.validate("AIza-test-key"), true);
  assert.equal(capture.request.model, MODEL);
  assert.equal(capture.request.response_format.mime_type, "application/json");
});

test("Gemini returns only validated approval-draft fields with bounded context", async () => {
  const capture = {};
  const connector = new GeminiConnector({
    clientFactory: async () =>
      clientReturning(
        {
          draft: "Please use secure checkout.",
          intent: "Purchase",
          summary: "Customer wants to buy.",
          orderDetails: null,
          recommendedAction: "Approve or edit this draft.",
          riskFlags: ["human_approval_required"]
        },
        capture
      )
  });
  const result = await connector.draftReply(
    {
      channel: "Instagram",
      intent: "Purchase",
      risk: "Human approval",
      messages: Array.from({ length: 30 }, (_, index) => ({ role: "customer", text: `Message ${index}` }))
    },
    "Draft safely.",
    { name: "Store", geminiApiKey: "AIza-test-key" }
  );
  assert.equal(result.draft, "Please use secure checkout.");
  assert.equal(result.orderDetails, null);
  assert.ok(capture.request.input.length < 21_000);
  assert.equal(capture.request.input.includes("Message 0"), false);
});

test("Gemini rejects malformed structured output without a mock fallback", async () => {
  const connector = new GeminiConnector({ clientFactory: async () => clientReturning("not-json") });
  await assert.rejects(
    () => connector.validate("AIza-test-key"),
    (error) => error.code === "GEMINI_INVALID_RESPONSE"
  );
});

test("Gemini rejects invalid structured order fields", async () => {
  const connector = new GeminiConnector({
    clientFactory: async () =>
      clientReturning({
        draft: "Draft",
        intent: "Purchase",
        summary: "Summary",
        orderDetails: { item: "Product", quantity: -4 },
        recommendedAction: "Review",
        riskFlags: []
      })
  });
  await assert.rejects(
    () =>
      connector.draftReply({ messages: [] }, "Draft safely.", {
        name: "Store",
        geminiApiKey: "AIza-test-key"
      }),
    (error) => error.code === "GEMINI_INVALID_RESPONSE"
  );
});

test("Gemini enforces a request timeout", async () => {
  const connector = new GeminiConnector({
    timeoutMs: 5,
    clientFactory: async () => ({
      interactions: {
        create: () => new Promise(() => {})
      }
    })
  });
  await assert.rejects(
    () => connector.validate("AIza-test-key"),
    (error) => error.code === "GEMINI_TIMEOUT"
  );
});
