const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHarness } = require("./helpers.cjs");
const { CustomApiManager } = require("../electron/custom-apis/manager.cjs");
const { TikTokConnector } = require("../electron/connectors/tiktok.cjs");
const { ConnectorRegistry } = require("../electron/connectors.cjs");
const { PublishingDispatchService } = require("../electron/publishing/dispatch-service.cjs");
const { validateState } = require("../electron/state-schema.cjs");
const { TikTokMessagingService } = require("../electron/custom-apis/messaging.cjs");
async function fixture(t) {
  const h = await createHarness();
  t.after(h.cleanup);
  const runtimeDir = path.join(h.directory, "custom-apis", "tiktok");
  fs.mkdirSync(path.join(runtimeDir, "media"), { recursive: true });
  const { startApi } = await import(pathToFileURL(path.join(__dirname, "../integrations/tiktok-api/src/runtime.js")).href);
  const calls = [];
  const browser = {
    allowedRecipient: "unused",
    queue: Promise.resolve(),
    close: async () => {},
    verifySession: async () => ({ state: "verified", account: { id: "jamftest", name: "jamftest" } }),
    post: async (body) => {
      calls.push(body);
      assert.ok(fs.existsSync(path.join(runtimeDir, "media", body.video_path)));
      return { state: "submitted", item_id: "7695910788313271566" };
    },
    conversations: async () => ({ conversations: [{ id: "0:1:123:123", name: "jamftest" }] }),
    message: async (body) => {
      calls.push(body);
      return { state: "submitted", conversation_id: body.conversation_id, delivery_confirmed: false };
    }
  };
  const token = "test-api-key-".repeat(4);
  const runtime = await startApi({ apiKey: token, port: 0, runtimeDir, browser, managed: true, writesEnabled: true });
  t.after(() => runtime.stop());
  const manager = new CustomApiManager({ userDataPath: h.directory });
  manager.runs.set("tiktok", {
    state: "running",
    port: runtime.port,
    token,
    account: { id: "jamftest", name: "jamftest" },
    pending: new Set()
  });
  h.store.customApis = manager;
  return { ...h, manager, calls, runtimeDir, runtime };
}
test("Studio approval dispatches through the actual HTTP API with stable media and returns processing, never published", async (t) => {
  const f = await fixture(t);
  const output = path.join(f.directory, "rendered");
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, "test.mp4"), "synthetic fixture bytes");
  f.store.state.mediaJobs.push({
    id: "media-test",
    status: "completed",
    title: "Test",
    sourceMediaId: "source-test",
    jobType: "clip_generation",
    projectId: null,
    renderPlanVersion: null,
    renderPlanHash: null,
    outputFolderName: "rendered",
    stage: "completed",
    progress: 100,
    settings: {},
    candidates: [],
    selectedCandidateIds: [],
    warnings: [],
    artifacts: [{ id: "artifact-test", kind: "video", name: "test.mp4" }],
    thumbnailSelections: [],
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });
  let state = await f.store.createPostPlan({
    mediaJobId: "media-test",
    title: "Synthetic API integration fixture",
    caption: "Fixture only",
    platforms: ["tiktok"]
  });
  const id = state.postQueue[0].id;
  state = await f.store.approvePostPlan(id, "api");
  assert.equal(state.postQueue[0].approvalSnapshot.version, 3);
  assert.equal(state.postQueue[0].approvalSnapshot.payload.connectionBindings.tiktok.accountId, "jamftest");
  assert.doesNotThrow(() => validateState(f.store.state));
  const dispatch = new PublishingDispatchService({
    store: f.store,
    connectorRegistry: new ConnectorRegistry([new TikTokConnector(f.manager)]),
    connections: {
      withFreshAuthorization: () => {
        throw new Error("browser posting must not use OAuth");
      }
    },
    mediaJobs: { getPrivatePaths: () => ({ outputPath: output }) },
    credentialVault: f.vault
  });
  state = await dispatch.dispatch(id);
  assert.equal(state.postQueue[0].status, "processing");
  assert.equal(state.postQueue[0].publicationReceipts[0].status, "processing");
  assert.match(state.postQueue[0].publicationReceipts[0].publicationUrl, /tiktok.com\/@jamftest\/video/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].privacy_level, "SELF_ONLY");
  const prior = await f.manager.request(
    "tiktok",
    "/v1/posts",
    f.calls[0],
    state.postQueue[0].approvalSnapshot.destinations[0].idempotencyKey
  );
  assert.equal(prior.item_id, "7695910788313271566");
  assert.equal(f.calls.length, 1);
  assert.doesNotThrow(() => validateState(f.store.state));
});
test("managed HTTP messaging targets a loaded ID without relaxing the CLI recipient restriction", async (t) => {
  const f = await fixture(t);
  const messaging = new TikTokMessagingService({ manager: f.manager, store: f.store });
  messaging.initialize();
  await messaging.refreshConversations();
  const thread = f.store.state.conversations[0];
  await messaging.send({ conversationId: thread.id, text: "HTTP fixture", operationId: "http-message-test" });
  assert.equal(f.calls[0].conversation_id, thread.externalId);
  assert.equal(f.calls[0].recipient, undefined);
  assert.equal(f.store.state.messageDispatches[0].status, "submitted");
  const { validate } = await import(pathToFileURL(path.join(__dirname, "../integrations/tiktok-api/src/validation.js")).href);
  assert.throws(() => validate("/v1/messages", { conversation_id: thread.externalId, text: "x" }), { code: "invalid_request" });
});
test("profile ownership prevents a second API and health requires authentication without opening a browser", async (t) => {
  const f = await fixture(t);
  const { startApi } = await import(pathToFileURL(path.join(__dirname, "../integrations/tiktok-api/src/runtime.js")).href);
  await assert.rejects(startApi({ runtimeDir: f.runtimeDir, apiKey: "x".repeat(32), port: 0 }), /already in use/);
  const port = f.runtime.port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/health`)).status, 401);
  assert.deepEqual(await f.manager.request("tiktok", "/v1/health"), { service: "tiktok", protocol: 1, ready: true });
});

test("changing the verified account after approval prevents any upload", async (t) => {
  const f = await fixture(t);
  let state = await f.store.createPostPlan({ title: "Account binding fixture", caption: "No upload", platforms: ["tiktok"] });
  const id = state.postQueue[0].id;
  await f.store.approvePostPlan(id, "api");
  f.manager.runs.get("tiktok").account = { id: "different", name: "different" };
  const connector = new TikTokConnector(f.manager);
  await assert.rejects(connector.publish({ filePath: "unused.mp4", idempotencyKey: "f".repeat(64), expectedAccountId: "jamftest" }), {
    code: "APPROVED_ACCOUNT_CHANGED"
  });
  assert.equal(f.calls.length, 0);
});
test("staged media cannot silently change under an approved idempotency key", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.directory, "staging-fixture.mp4");
  fs.writeFileSync(file, "first render");
  await f.manager.stageMedia("tiktok", file, "f".repeat(64));
  fs.writeFileSync(file, "changed render");
  await assert.rejects(f.manager.stageMedia("tiktok", file, "f".repeat(64)), { code: "APPROVED_MEDIA_CHANGED" });
});
