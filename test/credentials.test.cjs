const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { CredentialVault } = require("../electron/credential-vault.cjs");
const { createDirectory, createHarness, fakeEncryption } = require("./helpers.cjs");

test("legacy plaintext credentials migrate to an encrypted vault", async (t) => {
  const directory = createDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacyPath = path.join(directory, "produdash-credentials.json");
  fs.writeFileSync(legacyPath, JSON.stringify({ gemini: { apiKey: "AIza-secret-value" } }), { mode: 0o600 });
  const vault = new CredentialVault(directory, fakeEncryption());
  const notices = await vault.initialize();
  const encryptedPath = path.join(directory, "produdash-credentials.enc.json");
  assert.equal(fs.existsSync(legacyPath), false);
  assert.equal(fs.existsSync(encryptedPath), true);
  assert.equal(fs.readFileSync(encryptedPath, "utf8").includes("AIza-secret-value"), false);
  assert.equal(vault.get("gemini").apiKey, "AIza-secret-value");
  assert.ok(notices.some((notice) => notice.code === "CREDENTIALS_MIGRATED"));
});

test("legacy Shopify public metadata is separated from encrypted secrets", async (t) => {
  const directory = createDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, "produdash-credentials.json"),
    JSON.stringify({
      shopify: {
        storeDomain: "https://legacy.myshopify.com/",
        adminAccessToken: "shpat_legacy_secret"
      }
    }),
    { mode: 0o600 }
  );
  const { ProduDashStore } = require("../electron/store.cjs");
  const vault = new CredentialVault(directory, fakeEncryption());
  const store = new ProduDashStore(directory, { credentialVault: vault });
  await store.initialize();
  const setting = store.getAppState().credentialSettings.find((item) => item.id === "shopify");
  assert.equal(setting.status, "stored");
  assert.equal(setting.publicValues.storeDomain, "legacy.myshopify.com");
  assert.equal(vault.get("shopify").storeDomain, undefined);
  assert.equal(vault.get("shopify").adminAccessToken, "shpat_legacy_secret");
});

test("secure-storage unavailability fails without writing credentials", async (t) => {
  const directory = createDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const vault = new CredentialVault(directory, fakeEncryption({ available: false }));
  await assert.rejects(
    () => vault.initialize(),
    (error) => error.code === "SECURE_STORAGE_UNAVAILABLE"
  );
  assert.equal(fs.existsSync(path.join(directory, "produdash-credentials.enc.json")), false);
});

test("credentials never appear in app state or ordinary state files", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.saveIntegrationCredentials("shopify", {
    storeDomain: "https://example.myshopify.com/",
    adminAccessToken: "shpat_super_secret"
  });
  const state = harness.store.getAppState();
  assert.equal(state.credentialSettings.find((item) => item.id === "shopify").publicValues.storeDomain, "example.myshopify.com");
  assert.equal(JSON.stringify(state).includes("shpat_super_secret"), false);
  assert.equal(fs.readFileSync(path.join(harness.directory, "produdash-state.json"), "utf8").includes("shpat_super_secret"), false);
  assert.equal(
    fs.readFileSync(path.join(harness.directory, "produdash-credentials.enc.json"), "utf8").includes("shpat_super_secret"),
    false
  );
});

test("missing encrypted vault is restored from its protected backup", async (t) => {
  const directory = createDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const vault = new CredentialVault(directory, fakeEncryption());
  await vault.initialize();
  await vault.save("gemini", { apiKey: "AIza-first-key" });
  await vault.save("gemini", { apiKey: "AIza-second-key" });
  fs.unlinkSync(path.join(directory, "produdash-credentials.enc.json"));
  const recovered = new CredentialVault(directory, fakeEncryption());
  const notices = await recovered.initialize();
  // The backup holds the current credentials, not the previous generation.
  // This assertion used to expect "AIza-first-key", which was the leak stated
  // as a guarantee: it meant a rotated key stayed readable on disk forever.
  assert.equal(recovered.get("gemini").apiKey, "AIza-second-key");
  assert.ok(notices.some((notice) => notice.code === "CREDENTIALS_RECOVERED"));
});

test("removing credentials rotates the encrypted backup without the deleted secret", async (t) => {
  const directory = createDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const vault = new CredentialVault(directory, fakeEncryption());
  await vault.initialize();
  await vault.save("gemini", { apiKey: "AIza-delete-me" });
  await vault.remove("gemini");
  fs.unlinkSync(path.join(directory, "produdash-credentials.enc.json"));
  const recovered = new CredentialVault(directory, fakeEncryption());
  await recovered.initialize();
  assert.deepEqual(recovered.get("gemini"), {});
});

test("reset retains credentials while delete-all removes them", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.saveAiProviderCredentials("gemini", { apiKey: "AIza-test-key" }, [
    { key: "apiKey", label: "API key", sensitive: true, required: true }
  ]);
  let state = await harness.store.resetDashboardData();
  assert.equal(state.aiProviders.find((item) => item.id === "gemini").credentialStatus, "stored");
  fs.writeFileSync(path.join(harness.directory, "produdash-credentials.enc.json.recovery-test"), "protected");
  state = await harness.store.deleteAllLocalData();
  assert.equal(state.aiProviders.find((item) => item.id === "gemini").credentialStatus, "missing");
  assert.equal(fs.existsSync(path.join(harness.directory, "produdash-credentials.enc.json")), false);
  assert.equal(
    fs.readdirSync(harness.directory).some((entry) => entry.startsWith("produdash-credentials")),
    false
  );
});

test("planned integrations reject credentials until a real connector exists", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await assert.rejects(
    () => harness.store.saveIntegrationCredentials("stripe", { secretKey: "sk_live_not_saved" }),
    (error) => error.code === "INTEGRATION_UNAVAILABLE"
  );
  assert.equal(JSON.stringify(harness.vault.get("stripe")).includes("sk_live_not_saved"), false);
});

test("disconnecting an integration leaves no recoverable token in the backup", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.saveIntegrationCredentials("youtube", { clientId: "client-1", clientSecret: "secret-1" });
  await harness.store.saveIntegrationAuthorization("youtube", {
    accessToken: "ya29.access-secret",
    refreshToken: "1//refresh-secret",
    selectedAccount: { id: "UC-channel", name: "Channel" }
  });
  await harness.store.clearIntegrationAuthorization("youtube");

  // Checked through the backup rather than the live vault. writeJsonAtomic
  // copies the current file into `.bak` before replacing it, so a revoked token
  // can survive there while the vault itself looks correctly cleaned -- and the
  // backup is what someone with disk access actually reads.
  fs.unlinkSync(path.join(harness.directory, "produdash-credentials.enc.json"));
  const recovered = new CredentialVault(harness.directory, fakeEncryption());
  await recovered.initialize();
  const values = recovered.get("youtube");
  assert.equal(values.oauthAccessToken, undefined, "a disconnected access token must not be recoverable");
  assert.equal(values.oauthRefreshToken, undefined, "a disconnected refresh token must not be recoverable");
  // The user's own app configuration is not a revoked grant and stays put.
  // (clientId is not sensitive, so it lives in app state rather than the vault.)
  assert.equal(values.clientSecret, "secret-1");
});

test("rotating a secret leaves the previous value unrecoverable", async (t) => {
  const directory = createDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const vault = new CredentialVault(directory, fakeEncryption());
  await vault.initialize();
  await vault.save("gemini", { apiKey: "AIza-compromised" });
  await vault.save("gemini", { apiKey: "AIza-rotated" });

  fs.unlinkSync(path.join(directory, "produdash-credentials.enc.json"));
  const recovered = new CredentialVault(directory, fakeEncryption());
  await recovered.initialize();
  assert.equal(recovered.get("gemini").apiKey, "AIza-rotated");
});

test("delete-all removes the vault copies a recovery leaves behind", async (t) => {
  const directory = createDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const vault = new CredentialVault(directory, fakeEncryption());
  await vault.initialize();
  await vault.save("youtube", { oauthRefreshToken: "1//refresh-secret" });

  // Drive the real recovery path. A vault can fail to decode without being
  // damaged -- a reinstalled OS or a changed keychain leaves the ciphertext
  // perfectly intact and simply unreadable here -- and recovery sets those
  // copies aside rather than deleting them.
  const filePath = path.join(directory, "produdash-credentials.enc.json");
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, ciphertext: "not-decryptable" }));
  fs.writeFileSync(`${filePath}.bak`, JSON.stringify({ version: 1, ciphertext: "not-decryptable" }));
  const broken = new CredentialVault(directory, fakeEncryption());
  await assert.rejects(() => broken.initialize(), { code: "CREDENTIAL_VAULT_INVALID" });
  assert.ok(
    fs.readdirSync(directory).some((entry) => entry.includes(".recovery-")),
    "the recovery path must have preserved something for this test to mean anything"
  );

  await vault.clearAll();
  assert.deepEqual(
    fs.readdirSync(directory).filter((entry) => entry.startsWith("produdash-credentials")),
    [],
    "deleting all local data must leave no copy of the credential vault behind"
  );
});

test("a legacy credentials file that cannot be migrated does not brick startup", async (t) => {
  const directory = createDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacyPath = path.join(directory, "produdash-credentials.json");
  fs.writeFileSync(legacyPath, "{ not valid json", { mode: 0o600 });

  // Throwing here reaches main.cjs, which shows a fatal dialog and quits. The
  // file is still there on the next launch, so it fails identically forever and
  // the user cannot reach the UI to clear it -- the app is unlaunchable.
  const vault = new CredentialVault(directory, fakeEncryption());
  const notices = await vault.initialize();
  assert.ok(
    notices.some((notice) => notice.code === "LEGACY_CREDENTIALS_UNREADABLE"),
    "the user has to be told their old credentials were not migrated"
  );
  assert.equal(fs.existsSync(legacyPath), false, "the unreadable file is set aside so the next launch is clean");
  assert.ok(
    fs.readdirSync(directory).some((entry) => entry.startsWith("produdash-credentials.json.")),
    "and it is kept rather than destroyed -- it is the user's only copy"
  );

  // The app is usable: credentials can be entered again.
  await vault.save("gemini", { apiKey: "AIza-new" });
  assert.equal(vault.get("gemini").apiKey, "AIza-new");

  // A second launch sees no legacy file at all.
  const relaunched = new CredentialVault(directory, fakeEncryption());
  await relaunched.initialize();
  assert.equal(relaunched.get("gemini").apiKey, "AIza-new");
});

test("delete-all removes a preserved legacy credentials file", async (t) => {
  const directory = createDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "produdash-credentials.json"), "{ not valid json", { mode: 0o600 });
  const vault = new CredentialVault(directory, fakeEncryption());
  await vault.initialize();

  // The preserved copy is plaintext, so leaving it behind after "delete all
  // local data" is worse than the encrypted sidecars.
  await vault.clearAll();
  assert.deepEqual(
    fs.readdirSync(directory).filter((entry) => entry.startsWith("produdash-credentials")),
    []
  );
});
