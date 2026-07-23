const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMockConnectors } = require("../electron/connectors.cjs");
const { ProduDashStore } = require("../electron/store.cjs");

function createHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "produdash-test-"));
  const store = new ProduDashStore(dir);
  const connectors = createMockConnectors(store);
  return { dir, store, connectors };
}

test("loads connection-first state without demo businesses", () => {
  const { store } = createHarness();
  const state = store.getAppState();
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.businesses.length, 0);
  assert.equal(state.conversations.length, 0);
  assert.ok(state.integrations.some((integration) => integration.id === "shopify"));
  assert.ok(state.auditLog[0].detail.includes("official account connections"));
});

test("old demo schema is ignored and replaced by connection-first state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "produdash-test-old-"));
  const filePath = path.join(dir, "produdash-state.json");
  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, businesses: [{ id: "demo" }] }));

  const store = new ProduDashStore(dir);
  const state = store.getAppState();
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.businesses.length, 0);
});

test("clearing local data keeps integrations but no fake accounts", () => {
  const { store } = createHarness();
  const state = store.resetLocalData();
  assert.equal(state.businesses.length, 0);
  assert.equal(state.conversations.length, 0);
  assert.ok(state.integrations.every((integration) => ["disconnected", "planned"].includes(integration.status)));
});

test("manual credentials are stored separately and redacted from app state", () => {
  const { store, dir } = createHarness();
  const state = store.saveIntegrationCredentials("gemini", { apiKey: "AIza-test-key" });
  const gemini = state.credentialSettings.find((setting) => setting.id === "gemini");

  assert.equal(gemini.status, "configured");
  assert.deepEqual(gemini.configuredFields, ["apiKey"]);
  assert.equal(JSON.stringify(state).includes("AIza-test-key"), false);

  const credentialsFile = path.join(dir, "produdash-credentials.json");
  assert.equal(fs.existsSync(credentialsFile), true);
  assert.equal(fs.readFileSync(credentialsFile, "utf8").includes("AIza-test-key"), true);
});

test("clearing local data preserves manual credential status", () => {
  const { store } = createHarness();
  store.saveIntegrationCredentials("shopify", {
    storeDomain: "example.myshopify.com",
    adminAccessToken: "shpat_test"
  });

  const state = store.resetLocalData();
  const shopify = state.credentialSettings.find((setting) => setting.id === "shopify");
  assert.equal(shopify.status, "configured");
  assert.equal(state.businesses.length, 0);
});

test("content studio queues clip jobs and approval-gated post plans", () => {
  const { store } = createHarness();
  let state = store.createClipJob({
    title: "Launch video",
    source: "/tmp/source.mp4",
    goal: "Find product hooks.",
    targetLength: "30 seconds",
    platforms: ["tiktok", "youtube"]
  });
  assert.equal(state.clipperJobs.length, 1);
  assert.equal(state.clipperJobs[0].status, "queued");

  state = store.createPostPlan({
    clipJobId: state.clipperJobs[0].id,
    title: "Launch short",
    caption: "New drop.",
    scheduledFor: "Tomorrow 6 PM",
    platforms: ["tiktok"]
  });
  assert.equal(state.postQueue.length, 1);
  assert.equal(state.postQueue[0].status, "needs_approval");
  assert.ok(state.postQueue[0].policyGate.includes("official publishing APIs"));

  state = store.approvePostPlan(state.postQueue[0].id);
  assert.equal(state.postQueue[0].status, "approved_for_official_api");
});

test("mock connectors return empty app-owned data until accounts connect", () => {
  const { connectors } = createHarness();
  assert.deepEqual(connectors.shopify.listStores(), []);
  assert.deepEqual(connectors.social.listConversations("missing"), []);
});

test("Gemini mock still exposes draft-only planning helpers", () => {
  const { connectors } = createHarness();
  const conversation = {
    customer: "Test Customer",
    channel: "Instagram",
    intent: "Checkout help",
    risk: "Human approval",
    orderDraft: { item: "Example", value: 10 }
  };
  const result = connectors.gemini.draftReply(conversation, "Keep this approval-only.", { name: "Connected Store" });
  assert.equal(result.intent, "Checkout help");
  assert.ok(result.draft.includes("require human approval"));
  assert.equal(result.nextAction, "Route to human approval.");
});
