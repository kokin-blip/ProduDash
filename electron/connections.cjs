const { AppError, asAppError } = require("./errors.cjs");
const { normalizeConnectionResult } = require("./connectors/contract.cjs");
const { findPlatform } = require("./platforms/registry.cjs");

class ConnectionService {
  constructor({ store, connectorRegistry, providerService }) {
    this.store = store;
    this.connectorRegistry = connectorRegistry;
    this.providerService = providerService;
  }

  // Unknown, unavailable, and unconfigured each fail with their own code so the
  // UI can say which one is true instead of showing one vague error.
  resolveConnector(integrationId) {
    const platform = findPlatform(integrationId);
    if (!platform) throw new AppError("INVALID_INPUT", "Unknown integration.");
    const connector = this.connectorRegistry?.find(integrationId);
    if (!platform.capabilities.hasLiveConnector || !connector) {
      throw new AppError("INTEGRATION_UNAVAILABLE", "This integration is planned but does not have a live connector yet.");
    }
    return { platform, connector };
  }

  async refreshIntegration(integrationId) {
    const { connector } = this.resolveConnector(integrationId);
    const credentials = this.store.getIntegrationCredentials(integrationId);
    try {
      const result = normalizeConnectionResult(await connector.testConnection(credentials), integrationId);
      // Only platforms that own business records return a snapshot to apply.
      return result.business
        ? this.store.applyConnectorSnapshot(integrationId, result)
        : this.store.setIntegrationResult(integrationId, result);
    } catch (error) {
      const safe = asAppError(error, "CONNECTION_FAILED", "The integration could not be refreshed.");
      await this.store.setIntegrationResult(integrationId, {
        status: "error",
        error: safe.message,
        auditDetail: `${findPlatform(integrationId).displayName} connection failed safely.`
      });
      throw safe;
    }
  }

  // Refreshes every integration that is both configured and actually connectable.
  refreshableIntegrationIds() {
    const state = this.store.getAppState();
    return state.credentialSettings
      .filter((setting) => setting.status === "stored" && this.connectorRegistry?.has(setting.id))
      .map((setting) => setting.id);
  }

  async refreshConnections() {
    const state = this.store.getAppState();
    const providers = state.aiProviders.filter((profile) => profile.credentialStatus === "stored");
    await Promise.allSettled([
      ...this.refreshableIntegrationIds().map((integrationId) => this.refreshIntegration(integrationId)),
      ...providers.map((profile) => this.providerService.testConnection(profile.id))
    ]);
    return this.store.getAppState();
  }

  async draftAiReply(conversationId, prompt) {
    return this.providerService.draftAiReply(conversationId, prompt);
  }
}

module.exports = { ConnectionService };
