const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CREATOR_PLATFORM_IDS,
  INTEGRATION_IDS,
  buildAnalyticsSourceCatalog,
  buildCreatorPlatformCatalog,
  buildCredentialSettingsCatalog,
  buildIntegrationCatalog,
  creatorPlatformIdList,
  findPlatform,
  getPlatform,
  hasCapability,
  listPlatforms,
  platformsWhere
} = require("../electron/platforms/registry.cjs");
const { createInitialState } = require("../electron/initial-state.cjs");

// Platform ids are hashed into every approval-snapshot destination idempotency
// key by store.cjs and recomputed on load by state-schema.cjs. Renaming one
// silently invalidates saved approvals, so the id list is pinned here.
test("platform ids and their order are stable", () => {
  assert.deepEqual(
    listPlatforms().map((platform) => platform.id),
    ["shopify", "instagram", "facebook", "tiktok", "youtube", "stripe"]
  );
  assert.deepEqual([...INTEGRATION_IDS], ["shopify", "instagram", "facebook", "tiktok", "youtube", "stripe"]);
  // Creator surfaces carry their own order, independent of registry order.
  assert.deepEqual(creatorPlatformIdList(), ["tiktok", "instagram", "youtube"]);
  assert.deepEqual([...CREATOR_PLATFORM_IDS].sort(), ["instagram", "tiktok", "youtube"]);
});

test("every platform declares the fields the rest of the app reads", () => {
  for (const platform of listPlatforms()) {
    assert.ok(platform.displayName, `${platform.id} needs a display name`);
    assert.ok(platform.detail, `${platform.id} needs detail copy`);
    assert.ok(platform.allowedUse, `${platform.id} needs allowedUse copy`);
    assert.ok(platform.compliance, `${platform.id} needs compliance copy`);
    assert.ok(platform.credentialNote, `${platform.id} needs a credential note`);
    assert.ok(platform.authType, `${platform.id} needs an auth type`);
    assert.ok(platform.docsUrl.startsWith("https://"), `${platform.id} needs an https docs URL`);
    assert.ok(platform.credentialFields.length > 0, `${platform.id} needs credential fields`);
    for (const field of platform.credentialFields) {
      assert.ok(field.key && field.label && field.type, `${platform.id} field is incomplete`);
      assert.equal(typeof field.sensitive, "boolean");
    }
    // Capability defaults must be filled in so callers never read undefined.
    for (const flag of ["hasLiveConnector", "isPublishDestination", "providesCreatorAnalytics"]) {
      assert.equal(typeof platform.capabilities[flag], "boolean", `${platform.id}.${flag}`);
    }
    // A publishable destination must carry the creator metadata its catalogs need.
    if (platform.capabilities.isPublishDestination) {
      assert.ok(platform.creator, `${platform.id} is publishable and needs creator metadata`);
      assert.equal(typeof platform.creator.order, "number");
      assert.ok(platform.creator.requirements.length > 0);
      assert.ok(platform.creator.metrics.length > 0);
    }
  }
});

test("shopify is the only platform with a live connector today", () => {
  assert.deepEqual(
    platformsWhere("hasLiveConnector").map((platform) => platform.id),
    ["shopify"]
  );
  assert.equal(hasCapability("shopify", "ownsBusinessRecords"), true);
  assert.equal(hasCapability("youtube", "hasLiveConnector"), false);
  assert.equal(hasCapability("nope", "hasLiveConnector"), false);
});

test("stripe stays planned until a connector exists", () => {
  assert.equal(getPlatform("stripe").defaultStatus, "planned");
  for (const platform of listPlatforms()) {
    if (platform.id !== "stripe") assert.equal(platform.defaultStatus, "disconnected");
  }
});

test("unknown platform lookups fail closed", () => {
  assert.equal(findPlatform("myspace"), null);
  assert.throws(() => getPlatform("myspace"), { code: "INVALID_INPUT" });
});

test("definitions are frozen so callers cannot mutate shared state", () => {
  const youtube = getPlatform("youtube");
  assert.ok(Object.isFrozen(youtube));
  assert.ok(Object.isFrozen(youtube.capabilities));
  assert.ok(Object.isFrozen(youtube.scopes));
  assert.ok(Object.isFrozen(youtube.creator));
  assert.ok(Object.isFrozen(youtube.credentialFields[0]));

  // Sloppy-mode assignment fails silently rather than throwing, so assert the
  // value survives rather than asserting a TypeError.
  youtube.displayName = "changed";
  youtube.capabilities.hasLiveConnector = true;
  assert.equal(getPlatform("youtube").displayName, "YouTube");
  assert.equal(getPlatform("youtube").capabilities.hasLiveConnector, false);

  // Array mutation throws even in sloppy mode.
  assert.throws(() => youtube.scopes.push("extra"), TypeError);
});

test("derived catalogs are the ones initial state actually uses", () => {
  const state = createInitialState();
  assert.deepEqual(state.integrations, buildIntegrationCatalog());
  assert.deepEqual(state.credentialSettings, buildCredentialSettingsCatalog());
  assert.deepEqual(state.creatorPlatforms, buildCreatorPlatformCatalog());
  assert.deepEqual(state.analyticsSources, buildAnalyticsSourceCatalog());
});

test("derived catalogs hand out copies, not registry internals", () => {
  const first = buildCredentialSettingsCatalog();
  first[0].fields[0].label = "mutated";
  assert.equal(buildCredentialSettingsCatalog()[0].fields[0].label, "Store domain");

  const creators = buildCreatorPlatformCatalog();
  creators[0].requirements.push("mutated");
  assert.equal(buildCreatorPlatformCatalog()[0].requirements.length, 3);
});

test("credential catalogs never seed a stored status or a secret value", () => {
  for (const setting of buildCredentialSettingsCatalog()) {
    assert.equal(setting.status, "missing");
    assert.deepEqual(setting.configuredFields, []);
    assert.deepEqual(setting.publicValues, {});
    assert.equal(setting.updatedAt, null);
    for (const field of setting.fields) {
      assert.equal(Object.hasOwn(field, "value"), false, "credential fields must not carry values");
    }
  }
});

test("integration catalog never seeds a connected status", () => {
  for (const integration of buildIntegrationCatalog()) {
    assert.notEqual(integration.status, "connected");
    assert.equal(integration.lastSync, "Not connected");
  }
});
