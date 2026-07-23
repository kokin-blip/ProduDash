const { AppError, asAppError } = require("./errors.cjs");

class ConnectionService {
  constructor({ store, shopify, providerService }) {
    this.store = store;
    this.shopify = shopify;
    this.providerService = providerService;
  }

  async refreshIntegration(integrationId) {
    const credentials = this.store.getIntegrationCredentials(integrationId);
    try {
      if (integrationId === "shopify") {
        const snapshot = await this.shopify.sync(credentials);
        return this.store.applyShopifySync(snapshot);
      }
      throw new AppError("INTEGRATION_UNAVAILABLE", "This integration is planned but does not have a live connector yet.");
    } catch (error) {
      const safe = asAppError(error, "CONNECTION_FAILED", "The integration could not be refreshed.");
      if (integrationId === "shopify") {
        await this.store.setIntegrationResult(integrationId, {
          status: "error",
          error: safe.message,
          auditDetail: "Shopify connection failed safely."
        });
      }
      throw safe;
    }
  }

  async refreshConnections() {
    const state = this.store.getAppState();
    const configured = state.credentialSettings.filter((setting) => setting.status === "stored" && setting.id === "shopify");
    const providers = state.aiProviders.filter((profile) => profile.credentialStatus === "stored");
    await Promise.allSettled([
      ...configured.map((setting) => this.refreshIntegration(setting.id)),
      ...providers.map((profile) => this.providerService.testConnection(profile.id))
    ]);
    return this.store.getAppState();
  }

  async draftAiReply(conversationId, prompt) {
    return this.providerService.draftAiReply(conversationId, prompt);
  }
}

module.exports = { ConnectionService };
