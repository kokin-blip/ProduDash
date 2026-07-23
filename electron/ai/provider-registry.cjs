const { AppError } = require("../errors.cjs");
const { GeminiProviderAdapter } = require("./adapters/gemini.cjs");

class ProviderRegistry {
  constructor(adapters = [new GeminiProviderAdapter()]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  get(providerType) {
    const adapter = this.adapters.get(providerType);
    if (!adapter) throw new AppError("PROVIDER_UNAVAILABLE", "This AI provider adapter is not available in the current milestone.");
    return adapter;
  }

  listProviderTypes() {
    return [...this.adapters.values()].map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      credentialFields: structuredClone(adapter.credentialFields),
      models: adapter.listModels()
    }));
  }
}

module.exports = { ProviderRegistry };
