const { AppError } = require("./errors.cjs");
const { assertConnectorContract } = require("./connectors/contract.cjs");
const { GeminiConnector } = require("./connectors/gemini.cjs");
const { ShopifyClient, ShopifyConnector } = require("./connectors/shopify.cjs");
const { listPlatforms } = require("./platforms/registry.cjs");

// Platform connectors, keyed by platform id. A platform is only reachable if the
// registry says it has a live connector AND one is registered here -- the two
// must agree, so a half-finished connector cannot appear usable.
class ConnectorRegistry {
  constructor(connectors = []) {
    this.connectors = new Map();
    for (const connector of connectors) this.register(connector);
  }

  register(connector) {
    assertConnectorContract(connector);
    if (this.connectors.has(connector.id)) {
      throw new AppError("INVALID_CONNECTOR", `A connector is already registered for ${connector.id}.`);
    }
    this.connectors.set(connector.id, connector);
    return this;
  }

  has(platformId) {
    return this.connectors.has(platformId);
  }

  find(platformId) {
    return this.connectors.get(platformId) || null;
  }

  ids() {
    return [...this.connectors.keys()];
  }
}

// Guards against the registry and the connector set drifting apart in either
// direction: a platform flagged hasLiveConnector with nothing behind it, or a
// connector registered for a platform the registry says is unavailable.
function assertRegistryAgreement(registry) {
  for (const platform of listPlatforms()) {
    const registered = registry.has(platform.id);
    if (platform.capabilities.hasLiveConnector && !registered) {
      throw new AppError("INVALID_CONNECTOR", `${platform.id} declares a live connector but none is registered.`);
    }
    if (registered && !platform.capabilities.hasLiveConnector) {
      throw new AppError("INVALID_CONNECTOR", `${platform.id} has a registered connector but is not marked live.`);
    }
  }
  return registry;
}

function createConnectorRegistry(options = {}) {
  if (options.registry) return assertRegistryAgreement(options.registry);
  const registry = new ConnectorRegistry([options.shopifyConnector || new ShopifyConnector(options.shopifyOptions)]);
  return assertRegistryAgreement(registry);
}

// The Gemini connector is an AI-provider client, not a platform connector: it is
// consumed by the AI adapter layer and never by the connection service.
function createConnectors(options = {}) {
  return {
    connectorRegistry: createConnectorRegistry(options),
    gemini: options.gemini || new GeminiConnector(options.geminiOptions)
  };
}

module.exports = {
  ConnectorRegistry,
  GeminiConnector,
  ShopifyClient,
  ShopifyConnector,
  assertRegistryAgreement,
  createConnectorRegistry,
  createConnectors
};
