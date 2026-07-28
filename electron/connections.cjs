const { AppError, asAppError } = require("./errors.cjs");
const { CONNECTOR_CAPABILITIES, connectorSupports, normalizeConnectionResult } = require("./connectors/contract.cjs");
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

  // Connectors need the user's own app configuration, the stored tokens, and
  // the public token expiry -- which lives on the authorization record rather
  // than in the credential vault.
  credentialsFor(integrationId) {
    const credentials = this.store.getIntegrationCredentials(integrationId);
    const integration = this.store.getAppState().integrations.find((item) => item.id === integrationId);
    return { ...credentials, tokenExpiresAt: integration?.authorization?.tokenExpiresAt || null };
  }

  async refreshIntegration(integrationId) {
    const { connector } = this.resolveConnector(integrationId);
    const credentials = this.credentialsFor(integrationId);
    try {
      const raw = await connector.testConnection(credentials);
      // Persist refreshed tokens and account metadata before recording the
      // connection result, so the verification timestamp is stamped last.
      if (raw?.authorizationUpdate) {
        await this.store.saveIntegrationAuthorization(integrationId, raw.authorizationUpdate);
      }
      const result = normalizeConnectionResult(raw, integrationId);
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

  // Runs an interactive authorization, then immediately verifies it. Storing
  // tokens is not a connection: the integration only becomes connected after
  // the follow-up provider request actually succeeds.
  async authorizeIntegration(integrationId) {
    const { connector } = this.resolveConnector(integrationId);
    if (!connectorSupports(connector, CONNECTOR_CAPABILITIES.AUTHORIZE)) {
      throw new AppError("AUTHORIZATION_UNSUPPORTED", "This integration does not use an authorization flow.");
    }
    const result = await connector.authorize(this.credentialsFor(integrationId));
    await this.store.saveIntegrationAuthorization(integrationId, result);
    return this.refreshIntegration(integrationId);
  }

  // Revokes at the provider first where supported, then clears locally. A
  // provider-side failure must not leave ProduDash claiming access is gone.
  async disconnectIntegration(integrationId) {
    const { connector } = this.resolveConnector(integrationId);
    if (connectorSupports(connector, CONNECTOR_CAPABILITIES.DISCONNECT)) {
      await connector.disconnect(this.credentialsFor(integrationId));
    }
    return this.store.clearIntegrationAuthorization(integrationId);
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
