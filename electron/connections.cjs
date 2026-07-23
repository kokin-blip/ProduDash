const { AppError, asAppError } = require("./errors.cjs");

class ConnectionService {
  constructor({ store, shopify, gemini }) {
    this.store = store;
    this.shopify = shopify;
    this.gemini = gemini;
  }

  async refreshIntegration(integrationId) {
    const credentials = this.store.getIntegrationCredentials(integrationId);
    try {
      if (integrationId === "shopify") {
        const snapshot = await this.shopify.sync(credentials);
        return this.store.applyShopifySync(snapshot);
      }
      if (integrationId === "gemini") {
        await this.gemini.validate(credentials.apiKey);
        return this.store.setIntegrationResult("gemini", {
          status: "connected",
          detail: "Gemini is validated for structured, approval-only drafting.",
          auditDetail: "Validated the Gemini API connection."
        });
      }
      throw new AppError("INTEGRATION_UNAVAILABLE", "This integration is planned but does not have a live connector yet.");
    } catch (error) {
      const safe = asAppError(error, "CONNECTION_FAILED", "The integration could not be refreshed.");
      if (["shopify", "gemini"].includes(integrationId)) {
        await this.store.setIntegrationResult(integrationId, {
          status: "error",
          error: safe.message,
          auditDetail: `${integrationId === "shopify" ? "Shopify" : "Gemini"} connection failed safely.`
        });
      }
      throw safe;
    }
  }

  async refreshConnections() {
    const state = this.store.getAppState();
    const configured = state.credentialSettings.filter(
      (setting) => setting.status === "stored" && ["shopify", "gemini"].includes(setting.id)
    );
    await Promise.allSettled(configured.map((setting) => this.refreshIntegration(setting.id)));
    return this.store.getAppState();
  }

  async draftAiReply(conversationId, prompt) {
    const credentials = this.store.getIntegrationCredentials("gemini");
    const state = this.store.getAppState();
    const integration = state.integrations.find((item) => item.id === "gemini");
    if (integration?.status !== "connected") throw new AppError("INTEGRATION_NOT_READY", "Validate the Gemini connection before drafting.");
    const connector = {
      draftReply: (conversation, instruction, business) =>
        this.gemini.draftReply(conversation, instruction, { ...business, geminiApiKey: credentials.apiKey })
    };
    return this.store.draftAiReply(conversationId, prompt, connector);
  }
}

module.exports = { ConnectionService };
