const assert = require("node:assert/strict");
const test = require("node:test");
const { buildPlatformCatalog, REASONS } = require("../electron/platforms/catalog.cjs");
const { CONNECTION_STATES, createAuthorizationRecord } = require("../electron/platforms/authorization.cjs");
const { createHarness } = require("./helpers.cjs");

function stateWith({ youtube = {}, setting = {} } = {}) {
  return {
    integrations: [
      { id: "shopify", name: "Shopify", status: "disconnected", authorization: createAuthorizationRecord() },
      { id: "youtube", name: "YouTube", status: "disconnected", authorization: createAuthorizationRecord(), ...youtube }
    ],
    credentialSettings: [
      { id: "shopify", name: "Shopify", status: "missing", fields: [] },
      { id: "youtube", name: "YouTube", status: "missing", fields: [], ...setting }
    ]
  };
}

function youtubeEntry(overrides) {
  return buildPlatformCatalog(stateWith(overrides)).find((entry) => entry.id === "youtube");
}

function actionOf(entry, id) {
  return entry.actions.find((item) => item.id === id);
}

test("the catalog covers every platform and separates live from planned", () => {
  const catalog = buildPlatformCatalog(stateWith());
  assert.deepEqual(
    catalog.filter((entry) => entry.hasLiveConnector).map((entry) => entry.id),
    ["shopify", "youtube"]
  );
  // Everything without a connector stays planned and unavailable.
  for (const entry of catalog.filter((item) => !item.hasLiveConnector)) {
    assert.equal(entry.connectionState, CONNECTION_STATES.UNAVAILABLE, `${entry.id} must be unavailable`);
    assert.equal(actionOf(entry, "save_configuration").available, false);
    assert.equal(actionOf(entry, "connect").available, false);
  }
});

test("YouTube walks through each connection state as configuration and authorization arrive", () => {
  // Nothing entered.
  let entry = youtubeEntry();
  assert.equal(entry.connectionState, CONNECTION_STATES.REQUIRES_CONFIGURATION);
  assert.equal(actionOf(entry, "connect").available, false);
  assert.equal(actionOf(entry, "connect").reason, REASONS.NOT_CONFIGURED);

  // Configuration saved, not yet authorized.
  entry = youtubeEntry({ setting: { status: "stored" } });
  assert.equal(entry.connectionState, CONNECTION_STATES.AUTHORIZATION_REQUIRED);
  assert.equal(actionOf(entry, "connect").available, true);
  assert.equal(actionOf(entry, "connect").label, "Connect");
  assert.equal(actionOf(entry, "disconnect").available, false);

  // Authorized but not yet verified.
  entry = youtubeEntry({
    setting: { status: "stored" },
    youtube: { authorization: { ...createAuthorizationRecord(), hasAccessToken: true } }
  });
  assert.equal(entry.connectionState, CONNECTION_STATES.CREDENTIALS_STORED_UNVERIFIED);
  // Reauthorizing is still offered, now labelled as such.
  assert.equal(actionOf(entry, "connect").label, "Reauthorize");
  assert.equal(actionOf(entry, "disconnect").available, true);

  // Verified.
  entry = youtubeEntry({
    setting: { status: "stored" },
    youtube: { status: "connected", authorization: { ...createAuthorizationRecord(), hasAccessToken: true } }
  });
  assert.equal(entry.connectionState, CONNECTION_STATES.CONNECTED);
});

test("an expired access token with a refresh token is not reported as expired", () => {
  // Refreshing happens without the user present, so an hour-old access token is
  // the ordinary steady state. Calling it expired sent people through a browser
  // reauthorization they did not need.
  const entry = youtubeEntry({
    setting: { status: "stored" },
    youtube: {
      status: "connected",
      authorization: {
        ...createAuthorizationRecord(),
        hasAccessToken: true,
        hasRefreshToken: true,
        tokenExpiresAt: "2020-01-01T00:00:00.000Z"
      }
    }
  });
  assert.equal(entry.connectionState, CONNECTION_STATES.CONNECTED);

  // With nothing left to refresh from, the grant really is finished.
  const stranded = youtubeEntry({
    setting: { status: "stored" },
    youtube: {
      status: "connected",
      authorization: {
        ...createAuthorizationRecord(),
        hasAccessToken: true,
        hasRefreshToken: false,
        tokenExpiresAt: "2020-01-01T00:00:00.000Z"
      }
    }
  });
  assert.equal(stranded.connectionState, CONNECTION_STATES.TOKEN_EXPIRED);
});

test("a partly-failed refresh is reported as degraded, not as connected", () => {
  // integrationReady already refuses a degraded integration, so reporting it as
  // connected put a success badge on something the rest of the app treats as
  // not ready -- directly above the error text explaining what failed.
  const entry = youtubeEntry({
    setting: { status: "stored" },
    youtube: { status: "degraded", authorization: { ...createAuthorizationRecord(), hasAccessToken: true } }
  });
  assert.equal(entry.connectionState, CONNECTION_STATES.DEGRADED);
});

test("expired, missing-scope, and review states are distinguished", () => {
  const stored = { setting: { status: "stored" } };
  const expired = youtubeEntry({
    ...stored,
    youtube: {
      status: "connected",
      authorization: { ...createAuthorizationRecord(), hasAccessToken: true, tokenExpiresAt: "2020-01-01T00:00:00.000Z" }
    }
  });
  assert.equal(expired.connectionState, CONNECTION_STATES.TOKEN_EXPIRED);

  const partial = youtubeEntry({
    ...stored,
    youtube: {
      status: "connected",
      authorization: {
        ...createAuthorizationRecord(),
        hasAccessToken: true,
        grantedScopes: ["https://www.googleapis.com/auth/youtube.upload"]
      }
    }
  });
  assert.equal(partial.connectionState, CONNECTION_STATES.MISSING_SCOPE);
  assert.deepEqual(partial.missingScopes, ["https://www.googleapis.com/auth/youtube.readonly"]);

  const review = youtubeEntry({
    ...stored,
    youtube: {
      status: "connected",
      authorization: { ...createAuthorizationRecord(), hasAccessToken: true, reviewStatus: "required" }
    }
  });
  assert.equal(review.connectionState, CONNECTION_STATES.PROVIDER_APPROVAL_REQUIRED);
});

test("every unavailable action explains itself", () => {
  for (const entry of buildPlatformCatalog(stateWith())) {
    for (const item of entry.actions) {
      if (item.available) assert.equal(item.reason, null, `${entry.id}.${item.id} available actions carry no reason`);
      else assert.ok(item.reason, `${entry.id}.${item.id} must explain why it is unavailable`);
    }
  }
});

test("the catalog never carries a token, a secret, or a path", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.saveIntegrationCredentials("youtube", { clientId: "client-1", clientSecret: "super-secret" });
  await harness.store.saveIntegrationAuthorization("youtube", {
    accessToken: "ya29.catalog-leak",
    refreshToken: "1//catalog-refresh",
    selectedAccount: { id: "UC-1", name: "Chan" }
  });

  const state = harness.store.getAppState();
  const serialized = JSON.stringify(state.platformCatalog);
  assert.equal(serialized.includes("ya29.catalog-leak"), false);
  assert.equal(serialized.includes("1//catalog-refresh"), false);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes(harness.store.userDataPath), false);

  // Only the safe booleans and the account identity survive.
  const entry = state.platformCatalog.find((item) => item.id === "youtube");
  assert.equal(entry.hasAccessToken, true);
  assert.equal(entry.hasRefreshToken, true);
  assert.equal(entry.selectedAccount.id, "UC-1");
});

test("the catalog is derived, never persisted", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  assert.ok(harness.store.getAppState().platformCatalog.length > 0);
  // The saved state object itself must stay free of the derived view model.
  assert.equal(Object.hasOwn(harness.store.state, "platformCatalog"), false);
});
