const assert = require("node:assert/strict");
const test = require("node:test");
const { ConnectionService } = require("../electron/connections.cjs");
const { createConnectorRegistry } = require("../electron/connectors.cjs");
const { ShopifyConnector } = require("../electron/connectors/shopify.cjs");
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
  // Drive the real connector with an injected client so the contract and result
  // normalization are exercised rather than bypassed.
  const connectorRegistry = createConnectorRegistry({ shopifyConnector: new ShopifyConnector({ client: shopify }) });
  const service = new ConnectionService({ store: harness.store, connectorRegistry, providerService: {} });
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

test("reading a token expiry does not clone the whole store", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.saveIntegrationCredentials("youtube", { clientId: "client-1", clientSecret: "secret-1" });
  await harness.store.saveIntegrationAuthorization("youtube", {
    accessToken: "ya29.token",
    refreshToken: "1//refresh",
    tokenExpiresAt: "2030-01-01T00:00:00.000Z"
  });

  const service = new ConnectionService({ store: harness.store, connectorRegistry: createConnectorRegistry({}), providerService: {} });
  // getAppState deep-clones every plan, media job, and conversation. It is on
  // the path of every connector call through credentialsFor, so reaching for it
  // to read one timestamp made each token fetch clone the entire application.
  let clones = 0;
  const real = harness.store.getAppState.bind(harness.store);
  harness.store.getAppState = (...args) => {
    clones += 1;
    return real(...args);
  };

  const credentials = service.credentialsFor("youtube");
  assert.equal(credentials.tokenExpiresAt, "2030-01-01T00:00:00.000Z", "the value still has to be correct");
  assert.equal(clones, 0, "credentialsFor must not clone the store to read a timestamp");
});
