const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { PublishingDispatchService } = require("../electron/publishing/dispatch-service.cjs");
const { POST_PLAN_STATUSES, assertTransition, canTransition } = require("../electron/publishing/post-status.cjs");
const { RECEIPT_STATUSES, createReceipt, isAlreadyPublished, validateReceipt } = require("../electron/publishing/receipt.cjs");
const { ConnectorRegistry } = require("../electron/connectors.cjs");
const { CONNECTOR_CAPABILITIES } = require("../electron/connectors/contract.cjs");
const { connectorError, CONNECTOR_ERROR_CATEGORIES } = require("../electron/errors.cjs");
const { createDirectory, createHarness } = require("./helpers.cjs");

// A YouTube-shaped connector that records what it was asked to publish.
function publishingConnector({ onPublish } = {}) {
  let counter = 0;
  const calls = [];
  return {
    calls,
    connector: {
      id: "youtube",
      capabilities: [CONNECTOR_CAPABILITIES.PUBLISH, CONNECTOR_CAPABILITIES.PUBLISHING_STATUS],
      getAuthorizationInstructions: () => ({}),
      validateConfiguration: () => ({ valid: true, missing: [] }),
      testConnection: async () => ({ status: "connected" }),
      publish: async (request) => {
        calls.push(request);
        // A real connector consumes the stream; this one must release it.
        request.media?.body?.destroy?.();
        if (onPublish) await onPublish(request, calls.length);
        counter += 1;
        return { publicationId: `video-${counter}`, privacyStatus: "private", uploadStatus: "uploaded" };
      },
      getPublishingStatus: async ({ publicationId }) => ({
        publicationId,
        uploadStatus: "processed",
        privacyStatus: "private",
        complete: true,
        failed: false
      })
    }
  };
}

// Builds an approved-for-official-API plan with a real rendered file on disk.
async function approvedPlan(t, { onPublish } = {}) {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const outputPath = createDirectory();
  t.after(() => fs.rmSync(outputPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outputPath, "launch.mp4"), "video-bytes");

  // Credentials plus an authorization, so the destination is genuinely ready.
  await harness.store.saveIntegrationCredentials("youtube", { clientId: "client-1", clientSecret: "secret-1" });
  await harness.store.saveIntegrationAuthorization("youtube", {
    accessToken: "ya29.token",
    refreshToken: "1//refresh",
    selectedAccount: { id: "UC-channel", name: "Channel" }
  });
  await harness.store.setIntegrationResult("youtube", { status: "connected" });

  const completedJob = {
    id: "media-1",
    status: "completed",
    title: "Launch",
    outputFolderName: path.basename(outputPath),
    artifacts: [{ id: "artifact-1", kind: "video", name: "launch.mp4" }],
    thumbnailSelections: [],
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
  harness.store.state.mediaJobs.push(completedJob);

  let state = await harness.store.createPostPlan({
    mediaJobId: "media-1",
    title: "Launch post",
    caption: "Launch copy",
    platforms: ["youtube"]
  });
  const planId = state.postQueue[0].id;
  state = await harness.store.approvePostPlan(planId, "official_api");
  assert.equal(state.postQueue[0].status, POST_PLAN_STATUSES.APPROVED_FOR_OFFICIAL_API);

  const { connector, calls } = publishingConnector({ onPublish });
  const service = new PublishingDispatchService({
    store: harness.store,
    connectorRegistry: new ConnectorRegistry([connector]),
    connections: { credentialsFor: (id) => harness.store.getIntegrationCredentials(id) },
    mediaJobs: { getPrivatePaths: () => ({ sourcePath: "/src", outputPath, tempPath: "/tmp" }) }
  });
  return { harness, service, planId, calls, outputPath };
}

test("the transition table matches the documented publishing lifecycle", () => {
  assert.equal(canTransition(POST_PLAN_STATUSES.APPROVED_FOR_OFFICIAL_API, POST_PLAN_STATUSES.DISPATCHING), true);
  assert.equal(canTransition(POST_PLAN_STATUSES.DISPATCHING, POST_PLAN_STATUSES.PUBLISHED), true);
  assert.equal(canTransition(POST_PLAN_STATUSES.DISPATCH_FAILED, POST_PLAN_STATUSES.DISPATCHING), true);
  // Published and canceled are terminal.
  assert.equal(canTransition(POST_PLAN_STATUSES.PUBLISHED, POST_PLAN_STATUSES.DISPATCHING), false);
  assert.equal(canTransition(POST_PLAN_STATUSES.CANCELED, POST_PLAN_STATUSES.DISPATCHING), false);
  // A published post cannot be reopened for editing.
  assert.equal(canTransition(POST_PLAN_STATUSES.PUBLISHED, POST_PLAN_STATUSES.NEEDS_APPROVAL), false);
  assert.throws(() => assertTransition(POST_PLAN_STATUSES.NEEDS_APPROVAL, POST_PLAN_STATUSES.PUBLISHED), { code: "INVALID_TRANSITION" });
});

test("the approval path now invokes a real connector and publishes", async (t) => {
  const { harness, service, planId, calls } = await approvedPlan(t);
  const state = await service.dispatch(planId);
  const plan = state.postQueue.find((item) => item.id === planId);

  assert.equal(plan.status, POST_PLAN_STATUSES.PUBLISHED);
  assert.equal(calls.length, 1);
  // The approved copy is what was sent, not the draft.
  assert.equal(calls[0].title, "Launch post");
  assert.equal(calls[0].description, "Launch copy");
  // Never public unless explicitly approved as such.
  assert.equal(calls[0].privacyStatus, "private");
  assert.equal(calls[0].media.contentLength, "video-bytes".length);

  const receipt = plan.publicationReceipts[0];
  assert.equal(receipt.providerPublicationId, "video-1");
  assert.equal(receipt.status, RECEIPT_STATUSES.PUBLISHED);
  assert.equal(receipt.accountId, "UC-channel");
  assert.equal(receipt.approvedContentHash, plan.approvalSnapshot.hash);
  assert.equal(receipt.idempotencyKey, plan.approvalSnapshot.destinations[0].idempotencyKey);
  assert.equal(receipt.retryable, false);
  assert.equal(receipt.attempts.length, 1);
  assert.ok(receipt.attempts[0].endedAt);
  assert.equal(harness.store.getAppState().postQueue[0].publishedAt !== undefined, true);
});

test("dispatching twice does not publish twice", async (t) => {
  const { service, planId, calls } = await approvedPlan(t);
  await service.dispatch(planId);
  // A second click on an already-published plan is refused outright.
  await assert.rejects(() => service.dispatch(planId), { code: "INVALID_TRANSITION" });
  assert.equal(calls.length, 1);
});

test("a restart mid-dispatch does not republish an already-published destination", async (t) => {
  const { harness, service, planId, calls } = await approvedPlan(t);
  await service.dispatch(planId);

  // Simulate a crash after the upload but before the plan reached a terminal
  // state: force the plan back to dispatching, keeping its receipts.
  const plan = harness.store.state.postQueue.find((item) => item.id === planId);
  plan.status = POST_PLAN_STATUSES.DISPATCH_FAILED;

  const state = await service.dispatch(planId);
  // The existing receipt satisfied the destination; no second upload happened.
  assert.equal(calls.length, 1);
  assert.equal(state.postQueue[0].status, POST_PLAN_STATUSES.PUBLISHED);
  assert.equal(state.postQueue[0].publicationReceipts.length, 1);
});

test("a failed destination is recorded truthfully and stays retryable", async (t) => {
  const { service, planId, calls, harness } = await approvedPlan(t, {
    onPublish: async (_request, callNumber) => {
      if (callNumber === 1) {
        throw connectorError(CONNECTOR_ERROR_CATEGORIES.RATE_LIMIT, "YOUTUBE_RATE_LIMITED", "Slow down.");
      }
    }
  });

  let state = await service.dispatch(planId);
  let plan = state.postQueue.find((item) => item.id === planId);
  assert.equal(plan.status, POST_PLAN_STATUSES.DISPATCH_FAILED);
  assert.equal(plan.publicationReceipts[0].status, RECEIPT_STATUSES.FAILED);
  assert.equal(plan.publicationReceipts[0].errorCode, "YOUTUBE_RATE_LIMITED");
  // Rate limiting is genuinely retryable.
  assert.equal(plan.publicationReceipts[0].retryable, true);
  assert.equal(plan.publicationReceipts[0].providerPublicationId, null);

  // Retrying a failed dispatch is allowed and succeeds.
  state = await service.dispatch(planId);
  plan = state.postQueue.find((item) => item.id === planId);
  assert.equal(plan.status, POST_PLAN_STATUSES.PUBLISHED);
  assert.equal(calls.length, 2);
  // The retry reused the same receipt rather than creating a second one.
  assert.equal(plan.publicationReceipts.length, 1);
  assert.equal(plan.publicationReceipts[0].attempts.length, 2);
  assert.equal(harness.store.getAppState().postQueue[0].publicationReceipts[0].providerPublicationId, "video-1");
});

test("a non-retryable failure is not marked retryable", async (t) => {
  const { service, planId } = await approvedPlan(t, {
    onPublish: async () => {
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.PROVIDER_REVIEW, "YOUTUBE_REVIEW_REQUIRED", "Audit required.");
    }
  });
  const state = await service.dispatch(planId);
  const receipt = state.postQueue[0].publicationReceipts[0];
  assert.equal(receipt.retryable, false);
  assert.equal(receipt.errorCode, "YOUTUBE_REVIEW_REQUIRED");
});

test("dispatch refuses a plan that was never approved for official API", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const state = await harness.store.createPostPlan({ title: "Draft", caption: "", platforms: ["youtube"] });
  const service = new PublishingDispatchService({
    store: harness.store,
    connectorRegistry: new ConnectorRegistry([publishingConnector().connector]),
    connections: { credentialsFor: () => ({}) },
    mediaJobs: { getPrivatePaths: () => ({}) }
  });
  await assert.rejects(() => service.dispatch(state.postQueue[0].id), { code: "INVALID_TRANSITION" });
});

test("receipts never carry tokens, secrets, or absolute paths", async (t) => {
  const { harness, service, planId } = await approvedPlan(t);
  await service.dispatch(planId);
  const state = harness.store.getAppState();
  const serialized = JSON.stringify(state.postQueue[0].publicationReceipts);

  assert.equal(serialized.includes("ya29.token"), false);
  assert.equal(serialized.includes("1//refresh"), false);
  assert.equal(serialized.includes("secret-1"), false);
  assert.equal(serialized.includes(state.postQueue[0].mediaSnapshot.outputFolderName + path.sep), false);
  // The validator rejects anything path-shaped or token-named.
  assert.equal(validateReceipt({ ...state.postQueue[0].publicationReceipts[0], accessToken: "ya29.leak" }), false);
  assert.equal(validateReceipt({ ...state.postQueue[0].publicationReceipts[0], providerPublicationId: "/Users/me/video.mp4" }), false);
});

test("publication status is re-read from the provider, never assumed", async (t) => {
  const { service, planId } = await approvedPlan(t);
  await service.dispatch(planId);
  const status = await service.refreshPublicationStatus(planId, "youtube");
  assert.equal(status.publicationId, "video-1");
  assert.equal(status.complete, true);
  // A destination with no publication cannot be queried.
  await assert.rejects(() => service.refreshPublicationStatus(planId, "tiktok"), { code: "PUBLICATION_NOT_FOUND" });
});

test("a missing rendered file fails before anything is uploaded", async (t) => {
  const { harness, service, planId, calls, outputPath } = await approvedPlan(t);
  fs.rmSync(path.join(outputPath, "launch.mp4"));
  const state = await service.dispatch(planId);
  assert.equal(calls.length, 0);
  assert.equal(state.postQueue[0].status, POST_PLAN_STATUSES.DISPATCH_FAILED);
  assert.equal(state.postQueue[0].publicationReceipts[0].errorCode, "MEDIA_FILE_MISSING");
  assert.equal(harness.store.getAppState().postQueue[0].publicationReceipts[0].providerPublicationId, null);
});

test("an already-published receipt is recognized regardless of plan state", () => {
  const base = createReceipt({
    planId: "plan-1",
    platformId: "youtube",
    accountId: "UC-1",
    approvedContentHash: "a".repeat(64),
    idempotencyKey: "b".repeat(64)
  });
  assert.equal(isAlreadyPublished(base), false);
  assert.equal(isAlreadyPublished({ ...base, status: RECEIPT_STATUSES.PUBLISHED }), false, "needs a publication id");
  assert.equal(isAlreadyPublished({ ...base, status: RECEIPT_STATUSES.PUBLISHED, providerPublicationId: "v1" }), true);
  // A failed attempt that somehow has an id is still not published.
  assert.equal(isAlreadyPublished({ ...base, status: RECEIPT_STATUSES.FAILED, providerPublicationId: "v1" }), false);
});
