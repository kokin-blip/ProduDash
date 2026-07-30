const { AppError, asAppError } = require("./errors.cjs");
const { CONNECTOR_CAPABILITIES, connectorSupports, normalizeConnectionResult } = require("./connectors/contract.cjs");
const { findPlatform } = require("./platforms/registry.cjs");

// Refresh slightly early so a request cannot begin with a token that expires
// while it is still in flight.
const EXPIRY_SKEW_MS = 60_000;

class ConnectionService {
  constructor({ store, connectorRegistry, providerService, now }) {
    this.store = store;
    this.connectorRegistry = connectorRegistry;
    this.providerService = providerService;
    this.now = now || (() => Date.now());
    // One in-flight refresh per integration. Publishing, status polling, and a
    // manual test can all fire at once; without this each would spend the same
    // refresh token, and Google may invalidate the earlier results.
    this.refreshInFlight = new Map();
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

  // The single place an access token is obtained. Callers get a token that is
  // valid now, or a clear reauthorization-required failure -- never a stale one.
  async getFreshAuthorization(integrationId, { force = false } = {}) {
    const { platform, connector } = this.resolveConnector(integrationId);
    const credentials = this.credentialsFor(integrationId);
    if (!credentials.oauthAccessToken && !credentials.oauthRefreshToken) {
      throw new AppError("REAUTHORIZATION_REQUIRED", `Authorize ${platform.displayName} before continuing.`);
    }
    const expiresAt = credentials.tokenExpiresAt ? Date.parse(credentials.tokenExpiresAt) : NaN;
    const expiring = Number.isFinite(expiresAt) && expiresAt - EXPIRY_SKEW_MS <= this.now();
    if (!force && !expiring && credentials.oauthAccessToken) {
      return { accessToken: credentials.oauthAccessToken, refreshed: false };
    }
    return this.refreshAuthorization(integrationId, { platform, connector, credentials });
  }

  // Coalesces concurrent refreshes so one exchange serves every waiting caller.
  async refreshAuthorization(integrationId, context) {
    const existing = this.refreshInFlight.get(integrationId);
    if (existing) return existing;
    const attempt = this.performRefresh(integrationId, context).finally(() => this.refreshInFlight.delete(integrationId));
    this.refreshInFlight.set(integrationId, attempt);
    return attempt;
  }

  async performRefresh(integrationId, { platform, connector, credentials }) {
    if (!connectorSupports(connector, CONNECTOR_CAPABILITIES.REFRESH) || !credentials.oauthRefreshToken) {
      throw new AppError("REAUTHORIZATION_REQUIRED", `Reauthorize ${platform.displayName} to continue.`);
    }
    let result;
    try {
      result = await connector.refreshAuthorization(credentials);
    } catch (error) {
      // A refresh that fails is not transient noise: the stored grant is no
      // longer usable, so say so rather than leaving the UI looking connected.
      await this.store
        .setIntegrationResult(integrationId, {
          status: "error",
          error: `Reauthorize ${platform.displayName} to continue.`,
          auditDetail: `${platform.displayName} authorization could not be refreshed.`
        })
        .catch(() => {});
      throw asAppError(error, "REAUTHORIZATION_REQUIRED", `Reauthorize ${platform.displayName} to continue.`);
    }
    await this.store.saveIntegrationAuthorization(integrationId, {
      accessToken: result.accessToken,
      // Google usually omits the refresh token on a refresh; keeping the stored
      // one is what makes the grant survive beyond the first hour.
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      ...(result.tokenExpiresAt ? { tokenExpiresAt: result.tokenExpiresAt } : {}),
      ...(result.grantedScopes?.length ? { grantedScopes: result.grantedScopes } : {})
    });
    return { accessToken: result.accessToken, refreshed: true };
  }

  // Runs an operation with a fresh token, retrying once if the provider rejects
  // it anyway. Bounded to a single retry so a persistently rejected token
  // cannot become a refresh loop.
  //
  // `operation` may therefore run twice, so it must build whatever it consumes
  // rather than close over it. A request body is the trap: a stream created
  // outside the callback is at EOF by the time the retry runs, which sends an
  // empty body under the original Content-Length. See openBody() in
  // publishing/dispatch-service.cjs for the shape that is safe here.
  async withFreshAuthorization(integrationId, operation) {
    const first = await this.getFreshAuthorization(integrationId);
    try {
      return await operation(first.accessToken);
    } catch (error) {
      const rejected = error?.category === "authentication";
      if (!rejected || first.refreshed) throw error;
      const retry = await this.getFreshAuthorization(integrationId, { force: true });
      return operation(retry.accessToken);
    }
  }

  async refreshIntegration(integrationId) {
    const { connector } = this.resolveConnector(integrationId);
    const credentials = this.credentialsFor(integrationId);
    try {
      // Platforms that use an authorization flow get a guaranteed-fresh token;
      // API-key platforms like Shopify have nothing to refresh.
      const raw = connectorSupports(connector, CONNECTOR_CAPABILITIES.REFRESH)
        ? await this.withFreshAuthorization(integrationId, (accessToken) =>
            connector.testConnection({ ...credentials, oauthAccessToken: accessToken })
          )
        : await connector.testConnection(credentials);
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
