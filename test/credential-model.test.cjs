const assert = require("node:assert/strict");
const test = require("node:test");
const { createInitialState } = require("../electron/initial-state.cjs");
const { migrateState, validateState } = require("../electron/state-schema.cjs");
const { CURRENT_SCHEMA_VERSION, MINIMUM_SUPPORTED_SCHEMA_VERSION } = require("../electron/schema-version.cjs");
const { getPlatform } = require("../electron/platforms/registry.cjs");
const {
  CONNECTION_STATES,
  TOKEN_VAULT_KEYS,
  createAuthorizationRecord,
  deriveConnectionState,
  normalizeAuthorizationRecord,
  validateAuthorizationRecord
} = require("../electron/platforms/authorization.cjs");
const { createHarness } = require("./helpers.cjs");

test("the schema version constant has exactly one source of truth", () => {
  assert.equal(createInitialState().schemaVersion, CURRENT_SCHEMA_VERSION);
  // A fresh state must survive its own validator; loadRecoverableState writes
  // fresh state unvalidated, so drift here would only surface on the next boot.
  assert.doesNotThrow(() => validateState(createInitialState()));
});

test("every supported prior schema migrates to the current one", () => {
  for (let version = MINIMUM_SUPPORTED_SCHEMA_VERSION; version < CURRENT_SCHEMA_VERSION; version += 1) {
    const legacy = createInitialState();
    legacy.schemaVersion = version;
    const migrated = migrateState(legacy);
    assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION, `schema ${version} should migrate`);
    assert.doesNotThrow(() => validateState(migrated), `schema ${version} should validate after migrating`);
    for (const integration of migrated.integrations) {
      assert.ok(validateAuthorizationRecord(integration.authorization), `schema ${version} backfills ${integration.id}`);
    }
  }
});

test("migration is idempotent and never invents a connected state", () => {
  const legacy = createInitialState();
  legacy.schemaVersion = 7;
  const once = migrateState(legacy);
  const twice = migrateState(once);
  assert.deepEqual(once.integrations, twice.integrations);
  for (const integration of twice.integrations) {
    assert.notEqual(integration.status, "connected");
    assert.equal(integration.authorization.hasAccessToken, false);
    assert.equal(integration.authorization.lastVerifiedAt, null);
  }
});

test("migration preserves an existing authorization rather than resetting it", () => {
  // Defaults-first ordering matters: the v5->v6 and v6->v7 steps use
  // spread-then-override and would clobber real data if ever re-run.
  const legacy = createInitialState();
  legacy.schemaVersion = 7;
  const youtube = legacy.integrations.find((item) => item.id === "youtube");
  youtube.authorization = {
    version: 1,
    grantedScopes: ["https://www.googleapis.com/auth/youtube.upload"],
    tokenExpiresAt: "2030-01-01T00:00:00.000Z",
    reviewStatus: "approved",
    selectedAccount: { id: "UC123", name: "Test channel" },
    lastVerifiedAt: "2026-07-01T00:00:00.000Z",
    hasAccessToken: true,
    hasRefreshToken: true
  };
  const migrated = migrateState(legacy);
  const migratedYoutube = migrated.integrations.find((item) => item.id === "youtube");
  assert.equal(migratedYoutube.authorization.reviewStatus, "approved");
  assert.equal(migratedYoutube.authorization.selectedAccount.id, "UC123");
  assert.deepEqual(migratedYoutube.authorization.grantedScopes, ["https://www.googleapis.com/auth/youtube.upload"]);
});

test("a newer schema is refused rather than rewritten", () => {
  const future = createInitialState();
  future.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
  assert.throws(() => migrateState(future), { code: "FUTURE_SCHEMA" });
});

test("authorization records reject smuggled tokens and unknown fields", () => {
  const record = normalizeAuthorizationRecord({
    grantedScopes: ["a", "a", "b"],
    reviewStatus: "invented",
    accessToken: "ya29.super-secret",
    somethingElse: true,
    hasAccessToken: "yes"
  });
  // Unknown keys are dropped, not carried forward.
  assert.equal(Object.hasOwn(record, "accessToken"), false);
  assert.equal(Object.hasOwn(record, "somethingElse"), false);
  assert.deepEqual(record.grantedScopes, ["a", "b"]);
  assert.equal(record.reviewStatus, "unknown");
  // Only a real boolean counts.
  assert.equal(record.hasAccessToken, false);

  assert.equal(validateAuthorizationRecord(createAuthorizationRecord()), true);
  assert.equal(validateAuthorizationRecord({ ...createAuthorizationRecord(), refreshToken: "1//secret" }), false);
  assert.equal(validateAuthorizationRecord({ ...createAuthorizationRecord(), version: 2 }), false);
  assert.equal(validateAuthorizationRecord(null), false);
});

test("state validation rejects an authorization record carrying a token", () => {
  const state = createInitialState();
  state.integrations[0].authorization = { ...createAuthorizationRecord(), accessToken: "ya29.leak" };
  assert.throws(() => validateState(state), { code: "INVALID_STATE" });
});

function connectionState(platformId, { setting = {}, integration = {} } = {}) {
  return deriveConnectionState({
    platform: getPlatform(platformId),
    setting,
    integration: { authorization: createAuthorizationRecord(), ...integration }
  });
}

test("connection state distinguishes every reason a platform is not usable", () => {
  // No connector at all.
  assert.equal(connectionState("tiktok", { setting: { status: "stored" } }), CONNECTION_STATES.UNAVAILABLE);
  // Live connector, nothing entered.
  assert.equal(connectionState("shopify", { setting: { status: "missing" } }), CONNECTION_STATES.REQUIRES_CONFIGURATION);
  // Stored but never verified is NOT connected.
  assert.equal(
    connectionState("shopify", { setting: { status: "stored" }, integration: { status: "disconnected" } }),
    CONNECTION_STATES.CREDENTIALS_STORED_UNVERIFIED
  );
  assert.equal(
    connectionState("shopify", { setting: { status: "stored" }, integration: { status: "connected" } }),
    CONNECTION_STATES.CONNECTED
  );
  assert.equal(connectionState("shopify", { setting: { status: "stored" }, integration: { status: "error" } }), CONNECTION_STATES.ERROR);
  // Verified before, not now.
  assert.equal(
    connectionState("shopify", {
      setting: { status: "stored" },
      integration: { status: "disconnected", authorization: { ...createAuthorizationRecord(), lastVerifiedAt: "2026-01-01T00:00:00.000Z" } }
    }),
    CONNECTION_STATES.DISCONNECTED
  );
});

test("an expired token reads as expired, not as a generic error", () => {
  const platform = getPlatform("shopify");
  const state = deriveConnectionState({
    platform,
    setting: { status: "stored" },
    integration: {
      status: "error",
      authorization: { ...createAuthorizationRecord(), hasAccessToken: true, tokenExpiresAt: "2020-01-01T00:00:00.000Z" }
    }
  });
  assert.equal(state, CONNECTION_STATES.TOKEN_EXPIRED);
});

test("a granted authorization missing a required scope says so", () => {
  const platform = getPlatform("shopify");
  const state = deriveConnectionState({
    platform,
    setting: { status: "stored" },
    integration: {
      status: "connected",
      // shopify requires read_products and read_orders.
      authorization: { ...createAuthorizationRecord(), hasAccessToken: true, grantedScopes: ["read_products"] }
    }
  });
  assert.equal(state, CONNECTION_STATES.MISSING_SCOPE);
});

test("a platform awaiting provider review says so instead of claiming connected", () => {
  const platform = getPlatform("shopify");
  const state = deriveConnectionState({
    platform,
    setting: { status: "stored" },
    integration: {
      status: "connected",
      authorization: { ...createAuthorizationRecord(), reviewStatus: "required" }
    }
  });
  assert.equal(state, CONNECTION_STATES.PROVIDER_APPROVAL_REQUIRED);
});

test("credentials cannot be stored for a platform with no connector", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await assert.rejects(() => harness.store.saveIntegrationCredentials("tiktok", { clientKey: "x", clientSecret: "y" }), {
    code: "INTEGRATION_UNAVAILABLE"
  });
  await assert.rejects(() => harness.store.saveIntegrationAuthorization("tiktok", { accessToken: "ya29.x" }), {
    code: "INTEGRATION_UNAVAILABLE"
  });
});

test("authorization tokens live only in the vault, never in app state", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.saveIntegrationCredentials("shopify", {
    storeDomain: "tokens.myshopify.com",
    adminAccessToken: "shpat_token"
  });
  await harness.store.saveIntegrationAuthorization("shopify", {
    accessToken: "ya29.access-secret",
    refreshToken: "1//refresh-secret",
    grantedScopes: ["read_products", "read_orders"],
    selectedAccount: { id: "shop-1", name: "Tokens" }
  });

  const state = harness.store.getAppState();
  const integration = state.integrations.find((item) => item.id === "shopify");
  assert.equal(integration.authorization.hasAccessToken, true);
  assert.equal(integration.authorization.hasRefreshToken, true);
  assert.equal(integration.authorization.selectedAccount.id, "shop-1");
  // Storing an authorization is not verifying a connection.
  assert.notEqual(integration.status, "connected");
  assert.equal(integration.authorization.lastVerifiedAt, null);

  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes("ya29.access-secret"), false);
  assert.equal(serialized.includes("1//refresh-secret"), false);
  assert.equal(serialized.includes("shpat_token"), false);
  assert.equal(harness.vault.get("shopify")[TOKEN_VAULT_KEYS.ACCESS], "ya29.access-secret");
});

test("clearing an authorization keeps the user's own app configuration", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.saveIntegrationCredentials("shopify", {
    storeDomain: "keep.myshopify.com",
    adminAccessToken: "shpat_keep"
  });
  await harness.store.saveIntegrationAuthorization("shopify", { accessToken: "ya29.drop" });
  await harness.store.clearIntegrationAuthorization("shopify");

  const state = harness.store.getAppState();
  const integration = state.integrations.find((item) => item.id === "shopify");
  const setting = state.credentialSettings.find((item) => item.id === "shopify");
  assert.equal(integration.authorization.hasAccessToken, false);
  // The merchant's own credentials survive so they can reauthorize.
  assert.equal(setting.status, "stored");
  assert.equal(setting.publicValues.storeDomain, "keep.myshopify.com");
  assert.equal(harness.vault.get("shopify").adminAccessToken, "shpat_keep");
  assert.equal(harness.vault.get("shopify")[TOKEN_VAULT_KEYS.ACCESS], undefined);
});

test("removing credentials also clears the authorization record", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.saveIntegrationCredentials("shopify", {
    storeDomain: "gone.myshopify.com",
    adminAccessToken: "shpat_gone"
  });
  await harness.store.saveIntegrationAuthorization("shopify", {
    accessToken: "ya29.gone",
    grantedScopes: ["read_products"]
  });
  await harness.store.removeIntegrationCredentials("shopify");

  const integration = harness.store.getAppState().integrations.find((item) => item.id === "shopify");
  assert.deepEqual(integration.authorization, createAuthorizationRecord());
  assert.equal(integration.status, getPlatform("shopify").defaultStatus);
});
