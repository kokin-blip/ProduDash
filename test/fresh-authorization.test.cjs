const assert = require("node:assert/strict");
const test = require("node:test");
const { ConnectionService } = require("../electron/connections.cjs");
const { ConnectorRegistry } = require("../electron/connectors.cjs");
const { CONNECTOR_CAPABILITIES } = require("../electron/connectors/contract.cjs");
const { CONNECTOR_ERROR_CATEGORIES, connectorError } = require("../electron/errors.cjs");
const { TOKEN_VAULT_KEYS } = require("../electron/platforms/authorization.cjs");
const { createHarness } = require("./helpers.cjs");

const NOW = Date.parse("2026-07-28T12:00:00.000Z");

// A YouTube-shaped connector whose refresh behaviour the test controls.
function refreshableConnector({ onRefresh, onTest } = {}) {
  const calls = { refresh: 0, test: 0 };
  return {
    calls,
    connector: {
      id: "youtube",
      capabilities: [CONNECTOR_CAPABILITIES.REFRESH, CONNECTOR_CAPABILITIES.PUBLISH],
      getAuthorizationInstructions: () => ({}),
      validateConfiguration: () => ({ valid: true, missing: [] }),
      refreshAuthorization: async (credentials) => {
        calls.refresh += 1;
        if (onRefresh) return onRefresh(credentials, calls.refresh);
        return {
          accessToken: `fresh-${calls.refresh}`,
          // Google usually omits the refresh token on a refresh.
          refreshToken: null,
          tokenExpiresAt: new Date(NOW + 3_600_000).toISOString(),
          grantedScopes: []
        };
      },
      testConnection: async (credentials) => {
        calls.test += 1;
        if (onTest) return onTest(credentials, calls.test);
        return { status: "connected", authorizationUpdate: { selectedAccount: { id: "UC-1", name: "Chan" } } };
      },
      publish: async () => ({ publicationId: "v1" })
    }
  };
}

async function serviceWith(t, { connector, tokenExpiresAt, refreshToken = "1//stored-refresh" } = {}) {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.saveIntegrationCredentials("youtube", { clientId: "client-1", clientSecret: "secret-1" });
  await harness.store.saveIntegrationAuthorization("youtube", {
    accessToken: "stale-token",
    ...(refreshToken ? { refreshToken } : {}),
    ...(tokenExpiresAt ? { tokenExpiresAt } : {})
  });
  const service = new ConnectionService({
    store: harness.store,
    connectorRegistry: new ConnectorRegistry([connector]),
    providerService: {},
    now: () => NOW
  });
  return { harness, service };
}

test("a token that is still valid is reused without a refresh", async (t) => {
  const { connector, calls } = refreshableConnector();
  const { service } = await serviceWith(t, { connector, tokenExpiresAt: new Date(NOW + 3_600_000).toISOString() });
  const result = await service.getFreshAuthorization("youtube");
  assert.equal(result.accessToken, "stale-token");
  assert.equal(result.refreshed, false);
  assert.equal(calls.refresh, 0);
});

test("a token at or near expiry is refreshed proactively", async (t) => {
  const { connector, calls } = refreshableConnector();
  // Inside the skew window, so it counts as expiring.
  const { service } = await serviceWith(t, { connector, tokenExpiresAt: new Date(NOW + 30_000).toISOString() });
  const result = await service.getFreshAuthorization("youtube");
  assert.equal(result.accessToken, "fresh-1");
  assert.equal(result.refreshed, true);
  assert.equal(calls.refresh, 1);
});

test("a refreshed token and expiry are persisted, and the stored refresh token survives", async (t) => {
  const { connector } = refreshableConnector();
  const { harness, service } = await serviceWith(t, { connector, tokenExpiresAt: new Date(NOW - 1000).toISOString() });
  await service.getFreshAuthorization("youtube");

  assert.equal(harness.vault.get("youtube")[TOKEN_VAULT_KEYS.ACCESS], "fresh-1");
  // Google returned no new refresh token; losing the stored one would end the
  // grant after an hour.
  assert.equal(harness.vault.get("youtube")[TOKEN_VAULT_KEYS.REFRESH], "1//stored-refresh");
  const authorization = harness.store.getAppState().integrations.find((item) => item.id === "youtube").authorization;
  assert.equal(authorization.tokenExpiresAt, new Date(NOW + 3_600_000).toISOString());
  assert.equal(authorization.hasRefreshToken, true);
});

test("a new refresh token replaces the stored one when the provider rotates it", async (t) => {
  const { connector } = refreshableConnector({
    onRefresh: async () => ({ accessToken: "fresh", refreshToken: "1//rotated", tokenExpiresAt: null, grantedScopes: [] })
  });
  const { harness, service } = await serviceWith(t, { connector, tokenExpiresAt: new Date(NOW - 1000).toISOString() });
  await service.getFreshAuthorization("youtube");
  assert.equal(harness.vault.get("youtube")[TOKEN_VAULT_KEYS.REFRESH], "1//rotated");
});

test("concurrent callers share a single refresh", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { connector, calls } = refreshableConnector({
    onRefresh: async () => {
      await gate;
      return { accessToken: "fresh-shared", refreshToken: null, tokenExpiresAt: null, grantedScopes: [] };
    }
  });
  const { service } = await serviceWith(t, { connector, tokenExpiresAt: new Date(NOW - 1000).toISOString() });

  // Publishing, a status poll, and a manual test can all fire at once. Each
  // spending the same refresh token would invalidate the others' results.
  const waiting = Promise.all([
    service.getFreshAuthorization("youtube"),
    service.getFreshAuthorization("youtube"),
    service.getFreshAuthorization("youtube")
  ]);
  release();
  const results = await waiting;
  assert.equal(calls.refresh, 1, "one exchange must serve every waiting caller");
  for (const result of results) assert.equal(result.accessToken, "fresh-shared");

  // The guard clears afterwards, so a later refresh still happens.
  await service.getFreshAuthorization("youtube", { force: true });
  assert.equal(calls.refresh, 2);
});

test("a provider-rejected token triggers exactly one retry", async (t) => {
  const { connector, calls } = refreshableConnector();
  const { service } = await serviceWith(t, { connector, tokenExpiresAt: new Date(NOW + 3_600_000).toISOString() });

  let attempts = 0;
  const result = await service.withFreshAuthorization("youtube", async (accessToken) => {
    attempts += 1;
    if (attempts === 1) {
      assert.equal(accessToken, "stale-token");
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION, "YOUTUBE_AUTH_FAILED", "Rejected.");
    }
    assert.equal(accessToken, "fresh-1");
    return "done";
  });
  assert.equal(result, "done");
  assert.equal(attempts, 2);
  assert.equal(calls.refresh, 1);
});

test("a token rejected even after refreshing does not loop", async (t) => {
  const { connector, calls } = refreshableConnector();
  const { service } = await serviceWith(t, { connector, tokenExpiresAt: new Date(NOW - 1000).toISOString() });

  let attempts = 0;
  await assert.rejects(
    () =>
      service.withFreshAuthorization("youtube", async () => {
        attempts += 1;
        throw connectorError(CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION, "YOUTUBE_AUTH_FAILED", "Rejected.");
      }),
    { code: "YOUTUBE_AUTH_FAILED" }
  );
  // The first call already used a freshly refreshed token, so there is nothing
  // to retry with.
  assert.equal(attempts, 1);
  assert.equal(calls.refresh, 1);
});

test("a non-authentication failure is not retried", async (t) => {
  const { connector, calls } = refreshableConnector();
  const { service } = await serviceWith(t, { connector, tokenExpiresAt: new Date(NOW + 3_600_000).toISOString() });
  let attempts = 0;
  await assert.rejects(
    () =>
      service.withFreshAuthorization("youtube", async () => {
        attempts += 1;
        throw connectorError(CONNECTOR_ERROR_CATEGORIES.RATE_LIMIT, "YOUTUBE_RATE_LIMITED", "Slow down.");
      }),
    { code: "YOUTUBE_RATE_LIMITED" }
  );
  assert.equal(attempts, 1);
  assert.equal(calls.refresh, 0);
});

test("no refresh token means reauthorization, not a silent failure", async (t) => {
  const { connector } = refreshableConnector();
  const { service } = await serviceWith(t, {
    connector,
    refreshToken: null,
    tokenExpiresAt: new Date(NOW - 1000).toISOString()
  });
  await assert.rejects(() => service.getFreshAuthorization("youtube"), { code: "REAUTHORIZATION_REQUIRED" });
});

test("a failed refresh marks the integration as needing reauthorization", async (t) => {
  const { connector } = refreshableConnector({
    onRefresh: async () => {
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION, "YOUTUBE_AUTH_FAILED", "The grant was revoked.");
    }
  });
  const { harness, service } = await serviceWith(t, { connector, tokenExpiresAt: new Date(NOW - 1000).toISOString() });
  await assert.rejects(() => service.getFreshAuthorization("youtube"), { code: "YOUTUBE_AUTH_FAILED" });

  const integration = harness.store.getAppState().integrations.find((item) => item.id === "youtube");
  assert.equal(integration.status, "error");
  assert.match(integration.error, /Reauthorize/i);
});

test("refresh errors never carry a token or a client secret", async (t) => {
  const { connector } = refreshableConnector({
    onRefresh: async () => {
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION, "YOUTUBE_AUTH_FAILED", "The grant was revoked.");
    }
  });
  const { harness, service } = await serviceWith(t, { connector, tokenExpiresAt: new Date(NOW - 1000).toISOString() });
  await service.getFreshAuthorization("youtube").catch((error) => {
    const serialized = `${error.code} ${error.message}`;
    assert.equal(serialized.includes("1//stored-refresh"), false);
    assert.equal(serialized.includes("secret-1"), false);
  });
  const serializedState = JSON.stringify(harness.store.getAppState());
  assert.equal(serializedState.includes("1//stored-refresh"), false);
  assert.equal(serializedState.includes("secret-1"), false);
});

test("testing a connection also runs through the fresh-token path", async (t) => {
  const { connector, calls } = refreshableConnector();
  const { service } = await serviceWith(t, { connector, tokenExpiresAt: new Date(NOW - 1000).toISOString() });
  await service.refreshIntegration("youtube");
  assert.equal(calls.refresh, 1, "an expired token must be refreshed before the check");
  assert.equal(calls.test, 1);
});

test("a refresh that returns no expiry does not leave the old one in place", async (t) => {
  // Google can answer without expires_in. The stored expiry is already in the
  // past, so keeping it means every later call believes the token is expiring
  // and refreshes again -- a storm the provider eventually answers by revoking
  // the grant.
  const { connector, calls } = refreshableConnector({
    onRefresh: async () => ({ accessToken: "fresh-1", refreshToken: null, tokenExpiresAt: null, grantedScopes: [] })
  });
  const { service, harness } = await serviceWith(t, { connector, tokenExpiresAt: new Date(NOW - 3_600_000).toISOString() });

  const first = await service.getFreshAuthorization("youtube");
  assert.equal(first.accessToken, "fresh-1");
  assert.equal(calls.refresh, 1);

  const stored = harness.store.getAppState().integrations.find((item) => item.id === "youtube");
  assert.equal(stored.authorization.tokenExpiresAt, null, "an unknown expiry has to replace the stale one, not be skipped");

  // With no expiry the token is used until the provider actually rejects it.
  const second = await service.getFreshAuthorization("youtube");
  assert.equal(second.refreshed, false);
  assert.equal(calls.refresh, 1, "a second call must not refresh again");
});

test("a transient refresh failure does not demand reauthorization", async (t) => {
  // A Wi-Fi blip or a 503 says nothing about whether the stored refresh token is
  // still good. Persisting an error state for it left a healthy integration
  // looking broken, with publishing approval blocked, until the user happened to
  // press Test connection.
  const { connector } = refreshableConnector({
    onRefresh: async () => {
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.NETWORK, "YOUTUBE_NETWORK_ERROR", "The network request failed.");
    }
  });
  const { service, harness } = await serviceWith(t, { connector, tokenExpiresAt: new Date(NOW - 1000).toISOString() });
  await harness.store.setIntegrationResult("youtube", { status: "connected" });

  await assert.rejects(() => service.getFreshAuthorization("youtube"), { code: "YOUTUBE_NETWORK_ERROR" });
  const integration = harness.store.getAppState().integrations.find((item) => item.id === "youtube");
  assert.equal(integration.status, "connected", "a retryable failure must leave the stored status alone");
});

test("a rejected grant is still recorded as needing reauthorization", async (t) => {
  const { connector } = refreshableConnector({
    onRefresh: async () => {
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION, "YOUTUBE_AUTH_FAILED", "The stored authorization was rejected.");
    }
  });
  const { service, harness } = await serviceWith(t, { connector, tokenExpiresAt: new Date(NOW - 1000).toISOString() });
  await harness.store.setIntegrationResult("youtube", { status: "connected" });

  await assert.rejects(() => service.getFreshAuthorization("youtube"), { code: "YOUTUBE_AUTH_FAILED" });
  const integration = harness.store.getAppState().integrations.find((item) => item.id === "youtube");
  assert.equal(integration.status, "error", "the grant really is dead, so the UI must say so");
});

test("a revoked grant is recorded even though Google reports it as a bad request", async () => {
  // Google's token endpoint answers a revoked or expired refresh token with 400
  // invalid_grant, not 401. Falling through to the validation default meant the
  // one failure that genuinely requires reauthorizing was classified as a
  // malformed request, so nothing recorded the grant as dead and the badge
  // stayed green until someone happened to press Test connection.
  const { YouTubeConnector } = require("../electron/connectors/youtube.cjs");
  const connector = new YouTubeConnector({
    transport: async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) })
  });
  await assert.rejects(
    () => connector.refreshAuthorization({ clientId: "client-1", oauthRefreshToken: "1//revoked" }),
    (error) => {
      assert.equal(error.code, "YOUTUBE_AUTH_FAILED");
      assert.equal(error.category, CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION);
      return true;
    }
  );

  // A 400 from an ordinary API call still means a malformed request.
  const api = new YouTubeConnector({ transport: async () => ({ ok: false, status: 400, json: async () => ({}) }) });
  await assert.rejects(() => api.getPublishingStatus({ accessToken: "at", publicationId: "v1" }), { code: "YOUTUBE_REQUEST_REJECTED" });
});
