const assert = require("node:assert/strict");
const test = require("node:test");
const { CONNECTOR_ERROR_CATEGORIES, ConnectorError, connectorError, isRetryable, AppError } = require("../electron/errors.cjs");
const {
  CONNECTOR_CAPABILITIES,
  assertConnectorContract,
  connectorSupports,
  normalizeConnectionResult
} = require("../electron/connectors/contract.cjs");
const { ConnectorRegistry, assertRegistryAgreement, createConnectorRegistry } = require("../electron/connectors.cjs");
const { ShopifyConnector, asShopifyConnectorError } = require("../electron/connectors/shopify.cjs");
const { ConnectionService } = require("../electron/connections.cjs");
const { createHarness } = require("./helpers.cjs");

function minimalConnector(overrides = {}) {
  return {
    // A platform that is deliberately NOT marked live, so registering it is a
    // registry-agreement failure.
    id: "tiktok",
    capabilities: [],
    getAuthorizationInstructions: () => ({}),
    validateConfiguration: () => ({ valid: true, missing: [] }),
    testConnection: async () => ({ status: "connected" }),
    ...overrides
  };
}

test("a connector must declare a known platform and implement the required methods", () => {
  assert.doesNotThrow(() => assertConnectorContract(minimalConnector()));
  assert.throws(() => assertConnectorContract(null), { code: "INVALID_CONNECTOR" });
  assert.throws(() => assertConnectorContract(minimalConnector({ id: "myspace" })), { code: "INVALID_CONNECTOR" });
  assert.throws(() => assertConnectorContract(minimalConnector({ capabilities: "nope" })), { code: "INVALID_CONNECTOR" });
  assert.throws(() => assertConnectorContract(minimalConnector({ testConnection: undefined })), { code: "INVALID_CONNECTOR" });
  assert.throws(() => assertConnectorContract(minimalConnector({ capabilities: ["teleport"] })), { code: "INVALID_CONNECTOR" });
});

test("declared capabilities and implemented methods must agree in both directions", () => {
  // Declared but not implemented.
  assert.throws(() => assertConnectorContract(minimalConnector({ capabilities: [CONNECTOR_CAPABILITIES.PUBLISH] })), {
    code: "INVALID_CONNECTOR"
  });
  // Implemented but not declared -- invisible to every capability check.
  assert.throws(() => assertConnectorContract(minimalConnector({ publish: async () => ({}) })), {
    code: "INVALID_CONNECTOR"
  });
  assert.doesNotThrow(() =>
    assertConnectorContract(minimalConnector({ capabilities: [CONNECTOR_CAPABILITIES.PUBLISH], publish: async () => ({}) }))
  );
});

test("capability support is read from the declaration, never probed", () => {
  const connector = minimalConnector({ capabilities: [CONNECTOR_CAPABILITIES.PUBLISH], publish: async () => ({}) });
  assert.equal(connectorSupports(connector, CONNECTOR_CAPABILITIES.PUBLISH), true);
  assert.equal(connectorSupports(connector, CONNECTOR_CAPABILITIES.ANALYTICS), false);
  assert.equal(connectorSupports(null, CONNECTOR_CAPABILITIES.PUBLISH), false);
});

test("connection results are normalized and unknown statuses are rejected", () => {
  const result = normalizeConnectionResult({ status: "connected" }, "shopify");
  assert.equal(result.platformId, "shopify");
  assert.equal(result.error, null);
  assert.equal(result.business, null);
  assert.ok(result.syncedAt);
  assert.throws(() => normalizeConnectionResult({ status: "vibes" }, "shopify"), { code: "INVALID_CONNECTOR_RESULT" });
  assert.throws(() => normalizeConnectionResult(null, "shopify"), { code: "INVALID_CONNECTOR_RESULT" });
  assert.throws(() => normalizeConnectionResult([], "shopify"), { code: "INVALID_CONNECTOR_RESULT" });
});

test("the registry and the platform registry must agree about what is live", () => {
  // youtube is not flagged hasLiveConnector yet, so registering one is a bug.
  assert.throws(() => assertRegistryAgreement(new ConnectorRegistry([minimalConnector()])), { code: "INVALID_CONNECTOR" });
  // Dropping shopify, which IS flagged live, is equally a bug.
  assert.throws(() => assertRegistryAgreement(new ConnectorRegistry([])), { code: "INVALID_CONNECTOR" });
  assert.doesNotThrow(() => createConnectorRegistry());
});

test("a platform cannot be registered twice", () => {
  const registry = new ConnectorRegistry([new ShopifyConnector()]);
  assert.throws(() => registry.register(new ShopifyConnector()), { code: "INVALID_CONNECTOR" });
});

test("connector errors carry a category and honest retryability", () => {
  const limited = connectorError(CONNECTOR_ERROR_CATEGORIES.RATE_LIMIT, "X_RATE_LIMITED", "Slow down.");
  assert.equal(limited.category, "rate_limit");
  assert.equal(limited.retryable, true);
  assert.equal(isRetryable(limited), true);

  const revoked = connectorError(CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION, "X_AUTH", "Reauthorize.");
  assert.equal(revoked.retryable, false);

  // Review requirements are not transient and must never look retryable.
  const review = connectorError(CONNECTOR_ERROR_CATEGORIES.PROVIDER_REVIEW, "X_REVIEW", "Audit required.");
  assert.equal(review.retryable, false);

  // An explicit override wins over the category default.
  assert.equal(connectorError(CONNECTOR_ERROR_CATEGORIES.UPLOAD, "X_UP", "No.", { retryable: false }).retryable, false);

  // A plain AppError makes no retryability claim.
  assert.equal(isRetryable(new AppError("NOPE", "no")), false);
  assert.throws(() => new ConnectorError("X", "y", { category: "invented" }), { code: "INTERNAL_ERROR" });
});

test("shopify failures map onto the shared taxonomy without changing their codes", () => {
  const cases = [
    ["SHOPIFY_AUTH_FAILED", "authentication", false],
    ["SHOPIFY_RATE_LIMITED", "rate_limit", true],
    ["SHOPIFY_NETWORK_ERROR", "network", true],
    ["SHOPIFY_TIMEOUT", "network", true],
    ["INVALID_SHOPIFY_DOMAIN", "validation", false]
  ];
  for (const [code, category, retryable] of cases) {
    const mapped = asShopifyConnectorError(new AppError(code, "message"));
    assert.equal(mapped.code, code, `${code} keeps its code`);
    assert.equal(mapped.category, category);
    assert.equal(mapped.retryable, retryable);
    assert.equal(mapped.platformId, "shopify");
  }
  // An unrecognized failure is treated as a processing problem, not as success.
  assert.equal(asShopifyConnectorError(new Error("boom")).category, "processing");
});

test("unknown, unavailable, and unconfigured integrations fail with distinct codes", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const service = new ConnectionService({
    store: harness.store,
    connectorRegistry: createConnectorRegistry(),
    providerService: {}
  });

  await assert.rejects(() => service.refreshIntegration("myspace"), { code: "INVALID_INPUT" });
  // Declared in the registry but with no connector behind it.
  await assert.rejects(() => service.refreshIntegration("tiktok"), { code: "INTEGRATION_UNAVAILABLE" });
  await assert.rejects(() => service.refreshIntegration("stripe"), { code: "INTEGRATION_UNAVAILABLE" });
});

test("a failed refresh records a safe error and never leaks credentials", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.saveIntegrationCredentials("shopify", {
    storeDomain: "leaky.myshopify.com",
    adminAccessToken: "shpat_secret_value"
  });
  const connectorRegistry = createConnectorRegistry({
    shopifyConnector: new ShopifyConnector({
      client: {
        async sync() {
          throw new AppError("SHOPIFY_AUTH_FAILED", "Shopify rejected the Admin API credentials.");
        }
      }
    })
  });
  const service = new ConnectionService({ store: harness.store, connectorRegistry, providerService: {} });

  await assert.rejects(() => service.refreshIntegration("shopify"), { code: "SHOPIFY_AUTH_FAILED" });
  const integration = harness.store.getAppState().integrations.find((item) => item.id === "shopify");
  assert.equal(integration.status, "error");
  assert.equal(integration.error.includes("shpat_secret_value"), false);
  const serialized = JSON.stringify(harness.store.getAppState());
  assert.equal(serialized.includes("shpat_secret_value"), false);
});

test("refreshConnections only touches integrations that are configured and connectable", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const service = new ConnectionService({
    store: harness.store,
    connectorRegistry: createConnectorRegistry(),
    providerService: {}
  });
  // Nothing is configured yet.
  assert.deepEqual(service.refreshableIntegrationIds(), []);

  await harness.store.saveIntegrationCredentials("shopify", {
    storeDomain: "ready.myshopify.com",
    adminAccessToken: "shpat_token"
  });
  assert.deepEqual(service.refreshableIntegrationIds(), ["shopify"]);
});
