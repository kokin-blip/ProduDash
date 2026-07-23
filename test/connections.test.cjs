const assert = require("node:assert/strict");
const test = require("node:test");
const { ConnectionService } = require("../electron/connections.cjs");
const { ProviderRegistry } = require("../electron/ai/provider-registry.cjs");
const { ProviderService } = require("../electron/ai/provider-service.cjs");
const { createHarness } = require("./helpers.cjs");

function createProviderService(store, validate) {
  const adapter = {
    id: "gemini",
    name: "Google Gemini",
    credentialFields: [{ key: "apiKey", label: "API key", sensitive: true, required: true }],
    listModels: () => [
      {
        id: "gemini-3.6-flash",
        name: "Gemini 3.6 Flash",
        capabilities: ["text_generation", "structured_output"]
      }
    ],
    validate
  };
  return new ProviderService({ store, registry: new ProviderRegistry([adapter]) });
}

test("Shopify refresh creates and then updates one business record", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.saveIntegrationCredentials("shopify", {
    storeDomain: "connected.myshopify.com",
    adminAccessToken: "shpat_test_token"
  });
  let syncNumber = 0;
  const shopify = {
    async sync(credentials) {
      assert.equal(credentials.storeDomain, "connected.myshopify.com");
      assert.equal(credentials.adminAccessToken, "shpat_test_token");
      syncNumber += 1;
      return {
        status: "connected",
        error: null,
        syncedAt: `2026-07-23T00:00:0${syncNumber}Z`,
        business: {
          id: "shopify-123",
          shopifyShopId: "gid://shopify/Shop/123",
          name: `Store ${syncNumber}`,
          source: "shopify",
          commands: [],
          orders: [],
          signals: [],
          socials: [],
          automations: [],
          aiPolicy: [],
          checkoutWorkflow: [],
          metrics: {},
          financeTrend: []
        }
      };
    }
  };
  const service = new ConnectionService({ store: harness.store, shopify, providerService: {} });
  await service.refreshIntegration("shopify");
  const state = await service.refreshIntegration("shopify");
  assert.equal(state.businesses.length, 1);
  assert.equal(state.businesses[0].name, "Store 2");
  assert.equal(state.integrations.find((item) => item.id === "shopify").status, "connected");
});

test("Gemini credential presence remains distinct from validated connection state", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const fields = [{ key: "apiKey", label: "API key", sensitive: true, required: true }];
  await harness.store.saveAiProviderCredentials("gemini", { apiKey: "AIza-test-key" }, fields);
  let state = harness.store.getAppState();
  assert.equal(state.aiProviders.find((item) => item.id === "gemini").credentialStatus, "stored");
  assert.equal(state.aiProviders.find((item) => item.id === "gemini").status, "disconnected");
  const providers = createProviderService(harness.store, async () => true);
  state = await providers.testConnection("gemini");
  assert.equal(state.aiProviders.find((item) => item.id === "gemini").status, "connected");
});

test("provider failures persist a safe error state", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.saveAiProviderCredentials("gemini", { apiKey: "AIza-never-show" }, [
    { key: "apiKey", label: "API key", sensitive: true, required: true }
  ]);
  const service = createProviderService(harness.store, async () => {
    throw new Error("raw provider failure AIza-never-show");
  });
  await assert.rejects(
    () => service.testConnection("gemini"),
    (error) => error.code === "PROVIDER_CONNECTION_FAILED"
  );
  const profile = harness.store.getAppState().aiProviders.find((item) => item.id === "gemini");
  assert.equal(profile.status, "error");
  assert.equal(profile.error.includes("AIza-never-show"), false);
});
