const { GeminiConnector } = require("./connectors/gemini.cjs");
const { ShopifyClient } = require("./connectors/shopify.cjs");

function createConnectors(options = {}) {
  return {
    shopify: options.shopify || new ShopifyClient(options.shopifyOptions),
    gemini: options.gemini || new GeminiConnector(options.geminiOptions)
  };
}

module.exports = { createConnectors, GeminiConnector, ShopifyClient };
