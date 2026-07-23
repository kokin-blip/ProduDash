const assert = require("node:assert/strict");
const test = require("node:test");
const { ConnectionService } = require("../electron/connections.cjs");
const { createHarness } = require("./helpers.cjs");

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
  const service = new ConnectionService({ store: harness.store, shopify, gemini: {} });
  await service.refreshIntegration("shopify");
  const state = await service.refreshIntegration("shopify");
  assert.equal(state.businesses.length, 1);
  assert.equal(state.businesses[0].name, "Store 2");
  assert.equal(state.integrations.find((item) => item.id === "shopify").status, "connected");
});

test("Gemini credential presence remains distinct from validated connection state", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.saveIntegrationCredentials("gemini", { apiKey: "AIza-test-key" });
  let state = harness.store.getAppState();
  assert.equal(state.credentialSettings.find((item) => item.id === "gemini").status, "stored");
  assert.equal(state.integrations.find((item) => item.id === "gemini").status, "disconnected");
  const service = new ConnectionService({
    store: harness.store,
    shopify: {},
    gemini: { validate: async () => true }
  });
  state = await service.refreshIntegration("gemini");
  assert.equal(state.integrations.find((item) => item.id === "gemini").status, "connected");
});

test("provider failures persist a safe error state", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.saveIntegrationCredentials("gemini", { apiKey: "AIza-never-show" });
  const service = new ConnectionService({
    store: harness.store,
    shopify: {},
    gemini: {
      validate: async () => {
        throw new Error("raw provider failure AIza-never-show");
      }
    }
  });
  await assert.rejects(
    () => service.refreshIntegration("gemini"),
    (error) => error.code === "CONNECTION_FAILED"
  );
  const integration = harness.store.getAppState().integrations.find((item) => item.id === "gemini");
  assert.equal(integration.status, "error");
  assert.equal(integration.error.includes("AIza-never-show"), false);
});
