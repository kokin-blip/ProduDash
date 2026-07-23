const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createInitialState } = require("../electron/initial-state.cjs");
const { ProduDashStore } = require("../electron/store.cjs");
const { createDirectory, createHarness, fakeEncryption } = require("./helpers.cjs");
const { CredentialVault } = require("../electron/credential-vault.cjs");

test("starts with validated schema 4 provider-neutral state", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const state = harness.store.getAppState();
  assert.equal(state.schemaVersion, 4);
  assert.deepEqual(state.businesses, []);
  assert.equal(state.integrations.find((item) => item.id === "shopify").status, "disconnected");
  assert.equal(state.aiProviders[0].providerType, "gemini");
  assert.equal(state.aiWorkloads.inboxDrafting.profileId, "gemini");
  assert.deepEqual(state.mediaJobs, []);
});

test("atomic writes keep a valid last-known-good backup", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.store.createClipJob({ title: "First", source: "/tmp/first.mp4", platforms: [] });
  await harness.store.createClipJob({ title: "Second", source: "/tmp/second.mp4", platforms: [] });
  const primary = JSON.parse(fs.readFileSync(path.join(harness.directory, "produdash-state.json"), "utf8"));
  const backup = JSON.parse(fs.readFileSync(path.join(harness.directory, "produdash-state.json.bak"), "utf8"));
  assert.equal(primary.clipperJobs.length, 2);
  assert.equal(backup.clipperJobs.length, 1);
  assert.equal(
    fs.readdirSync(harness.directory).some((name) => name.includes(".tmp-")),
    false
  );
});

test("corrupt primary state is preserved and recovered from backup", async (t) => {
  const harness = await createHarness();
  await harness.store.createClipJob({ title: "Recover me", source: "/tmp/source.mp4", platforms: [] });
  await harness.store.createClipJob({ title: "Newer", source: "/tmp/newer.mp4", platforms: [] });
  fs.writeFileSync(path.join(harness.directory, "produdash-state.json"), "{broken");

  const recovered = new ProduDashStore(harness.directory, {
    credentialVault: new CredentialVault(harness.directory, fakeEncryption())
  });
  await recovered.initialize();
  t.after(harness.cleanup);
  assert.equal(recovered.getAppState().clipperJobs.length, 1);
  assert.ok(recovered.getAppState().systemNotices.some((notice) => notice.code === "STATE_RECOVERED"));
  assert.ok(fs.readdirSync(harness.directory).some((name) => name.includes(".recovery-")));
});

test("missing primary state is restored from the valid backup", async (t) => {
  const harness = await createHarness();
  await harness.store.createClipJob({ title: "Backup", source: "/tmp/backup.mp4", platforms: [] });
  await harness.store.createClipJob({ title: "Primary", source: "/tmp/primary.mp4", platforms: [] });
  fs.unlinkSync(path.join(harness.directory, "produdash-state.json"));
  const recovered = new ProduDashStore(harness.directory, {
    credentialVault: new CredentialVault(harness.directory, fakeEncryption())
  });
  await recovered.initialize();
  t.after(harness.cleanup);
  assert.equal(recovered.getAppState().clipperJobs.length, 1);
  assert.ok(recovered.getAppState().systemNotices.some((notice) => notice.code === "STATE_RECOVERED"));
});

test("schema 2 state migrates sequentially to schema 4 without losing valid data", async (t) => {
  const directory = createDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = createInitialState();
  state.schemaVersion = 2;
  state.clipperJobs.push({ id: "clip-existing", title: "Existing", source: "/tmp/source.mp4", platforms: [] });
  fs.writeFileSync(path.join(directory, "produdash-state.json"), JSON.stringify(state));
  const store = new ProduDashStore(directory, { credentialVault: new CredentialVault(directory, fakeEncryption()) });
  await store.initialize();
  assert.equal(store.getAppState().schemaVersion, 4);
  assert.equal(store.getAppState().clipperJobs[0].id, "clip-existing");
  assert.equal(store.getAppState().clipperJobs[0].status, "legacy_plan");
});

test("schema 3 Gemini state migrates to an idempotent provider profile and legacy plans", async (t) => {
  const directory = createDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = createInitialState();
  state.schemaVersion = 3;
  delete state.aiProviders;
  delete state.aiWorkloads;
  delete state.advisorSettings;
  state.integrations.push({
    id: "gemini",
    name: "Gemini",
    status: "connected",
    lastSync: "2026-07-23T01:00:00.000Z"
  });
  state.credentialSettings.push({ id: "gemini", name: "Gemini", status: "stored", fields: [] });
  state.clipperJobs.push({ id: "clip-legacy", title: "Legacy" });
  fs.writeFileSync(path.join(directory, "produdash-state.json"), JSON.stringify(state));
  fs.writeFileSync(path.join(directory, "produdash-credentials.json"), JSON.stringify({ gemini: { apiKey: "AIza-preserved-key" } }), {
    mode: 0o600
  });
  const store = new ProduDashStore(directory, { credentialVault: new CredentialVault(directory, fakeEncryption()) });
  await store.initialize();
  const migrated = store.getAppState();
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(
    migrated.integrations.some((item) => item.id === "gemini"),
    false
  );
  assert.equal(migrated.aiProviders[0].status, "connected");
  assert.equal(migrated.clipperJobs[0].status, "legacy_plan");
});

test("future schema blocks startup without modifying the file", () => {
  const directory = createDirectory();
  const filePath = path.join(directory, "produdash-state.json");
  const future = JSON.stringify({ schemaVersion: 99, integrations: [] });
  fs.writeFileSync(filePath, future);
  assert.throws(
    () => new ProduDashStore(directory),
    (error) => error.code === "FUTURE_SCHEMA"
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), future);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("audit log is bounded and conflicting mutations are serialized", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  harness.store.state.auditLog = Array.from({ length: 600 }, (_, index) => ({
    id: `audit-${index}`,
    at: new Date().toISOString(),
    type: "test",
    detail: "bounded"
  }));
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      harness.store.createClipJob({ title: `Clip ${index}`, source: `/tmp/${index}.mp4`, platforms: ["youtube"] })
    )
  );
  const state = harness.store.getAppState();
  assert.equal(state.clipperJobs.length, 20);
  assert.equal(state.auditLog.length, 500);
});
