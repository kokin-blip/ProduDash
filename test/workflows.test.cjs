const assert = require("node:assert/strict");
const test = require("node:test");
const { createHarness } = require("./helpers.cjs");
const { validateState } = require("../electron/state-schema.cjs");

function seedConversation(store) {
  store.state.businesses.push({
    id: "business-1",
    name: "Test Store",
    commands: [],
    orders: [],
    signals: [],
    socials: [],
    automations: [],
    aiPolicy: [],
    checkoutWorkflow: [],
    metrics: {},
    financeTrend: []
  });
  store.state.conversations.push({
    id: "conversation-1",
    businessId: "business-1",
    customer: "Customer",
    channel: "Instagram",
    intent: "Question",
    risk: "Human approval",
    messages: [{ role: "customer", text: "Can I order?" }],
    orderDraft: null,
    status: "open"
  });
  store.persist();
}

const fakeGemini = {
  async draftReply() {
    return {
      draft: "Please use our secure checkout.",
      intent: "Purchase question",
      summary: "Customer asked to order.",
      orderDetails: null,
      recommendedAction: "Review the draft.",
      riskFlags: ["human_approval_required"]
    };
  }
};

test("AI approvals are single-pending, idempotent, and cannot reverse", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  seedConversation(harness.store);
  const result = await harness.store.draftAiReply("conversation-1", "Draft safely.", fakeGemini);
  await assert.rejects(
    () => harness.store.draftAiReply("conversation-1", "Create another.", fakeGemini),
    (error) => error.code === "PENDING_APPROVAL_EXISTS"
  );
  let state = await harness.store.approveAiAction(result.approval.id);
  const auditCount = state.auditLog.length;
  state = await harness.store.approveAiAction(result.approval.id);
  assert.equal(state.auditLog.length, auditCount);
  assert.equal(state.conversations[0].messages.filter((message) => message.approvalId === result.approval.id).length, 1);
  assert.equal(state.conversations[0].status, "draft_approved");
  await assert.rejects(
    () => harness.store.rejectAiAction(result.approval.id),
    (error) => error.code === "INVALID_TRANSITION"
  );
});

test("rejected AI approval cannot later be approved", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  seedConversation(harness.store);
  const result = await harness.store.draftAiReply("conversation-1", "Draft safely.", fakeGemini);
  await harness.store.rejectAiAction(result.approval.id);
  await assert.rejects(
    () => harness.store.approveAiAction(result.approval.id),
    (error) => error.code === "INVALID_TRANSITION"
  );
});

test("manual export requires approval and repeated transitions are idempotent", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  let state = await harness.store.createClipJob({
    title: "Launch clip",
    source: "/tmp/source.mp4",
    platforms: ["youtube"]
  });
  state = await harness.store.createPostPlan({
    clipJobId: state.clipperJobs[0].id,
    title: "Launch post",
    caption: "New launch",
    scheduledFor: "2026-08-01T18:00:00Z",
    platforms: ["youtube"]
  });
  const planId = state.postQueue[0].id;
  const duplicateState = await harness.store.createPostPlan({
    clipJobId: state.clipperJobs[0].id,
    title: "Launch post",
    caption: "New launch",
    scheduledFor: "2026-08-01T18:00:00Z",
    platforms: ["youtube"]
  });
  assert.equal(duplicateState.postQueue.length, 1);
  assert.equal(duplicateState.postQueue[0].id, planId);
  assert.equal(state.postQueue[0].schedule.timeZone, "UTC");
  assert.equal(state.postQueue[0].schedule.mode, "planned_local_only");
  assert.deepEqual(state.postQueue[0].platformPackages, [{ platformId: "youtube", title: "Launch post", caption: "New launch" }]);
  await assert.rejects(
    () => harness.store.markPostExported(planId),
    (error) => error.code === "INVALID_TRANSITION"
  );
  state = await harness.store.approvePostPlan(planId, "manual_export");
  assert.match(state.postQueue[0].approvalSnapshot.hash, /^[a-f0-9]{64}$/);
  assert.equal(state.postQueue[0].approvalSnapshot.mode, "manual_export");
  assert.equal(state.postQueue[0].approvalSnapshot.destinations.length, 1);
  const exportedPackage = harness.store.getPostExportPackage(planId);
  assert.equal(exportedPackage.format, "produdash-publishing-package");
  assert.equal(exportedPackage.approval.hash, state.postQueue[0].approvalSnapshot.hash);
  assert.doesNotMatch(JSON.stringify(exportedPackage), /\/tmp\/source|sourcePath|outputPath|bookmark/i);
  const auditCount = state.auditLog.length;
  state = await harness.store.approvePostPlan(planId, "manual_export");
  assert.equal(state.auditLog.length, auditCount);
  state = await harness.store.markPostExported(planId);
  assert.equal(state.postQueue[0].status, "export_ready");
  await assert.rejects(
    () => harness.store.approvePostPlan(planId, "official_api"),
    (error) => error.code === "INVALID_TRANSITION"
  );
});

test("publishing packages snapshot completed media, reject bad schedules, and cancel locally without deleting output", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  harness.store.state.mediaJobs.push({
    id: "mediajob-publish",
    jobType: "clip_generation",
    projectId: null,
    renderPlanVersion: null,
    renderPlanHash: null,
    title: "Rendered launch",
    goal: "",
    sourceMediaId: "media-source",
    sourceName: "source.mp4",
    sourcePreviewUrl: null,
    sourceDuration: 10,
    outputFolderName: "safe-output",
    status: "completed",
    stage: "complete",
    progress: 100,
    settings: {},
    candidates: [],
    selectedCandidateIds: [],
    warnings: [],
    artifacts: [{ kind: "video", name: "launch.mp4" }],
    thumbnailSelections: [],
    error: null,
    retryable: false,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:01:00.000Z",
    completedAt: "2026-07-24T00:01:00.000Z"
  });
  let state = await harness.store.createPostPlan({
    mediaJobId: "mediajob-publish",
    title: "Rendered post",
    caption: "Approved copy",
    scheduledFor: "2026-11-01T08:30:00.000Z",
    timeZone: "America/Phoenix",
    platforms: ["instagram"]
  });
  const planId = state.postQueue[0].id;
  assert.equal(state.postQueue[0].mediaSnapshot.videos[0].name, "launch.mp4");
  assert.equal(JSON.stringify(state.postQueue[0]).includes("source.mp4"), false);
  state = await harness.store.approvePostPlan(planId, "manual_export");
  assert.doesNotThrow(() => validateState(state));
  state = await harness.store.cancelPostPlan(planId);
  assert.equal(state.postQueue[0].status, "canceled");
  const auditCount = state.auditLog.length;
  state = await harness.store.cancelPostPlan(planId);
  assert.equal(state.auditLog.length, auditCount);
  await assert.rejects(
    harness.store.createPostPlan({
      title: "Bad zone",
      scheduledFor: "2026-11-01T08:30:00.000Z",
      timeZone: "Mars/Olympus",
      platforms: []
    }),
    { code: "INVALID_INPUT" }
  );
  await assert.rejects(harness.store.createPostPlan({ title: "Missing media", mediaJobId: "mediajob-missing", platforms: [] }), {
    code: "MEDIA_JOB_NOT_READY"
  });
});

test("destination copy and local schedules are editable only before publishing approval", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  let state = await harness.store.createPostPlan({
    title: "Shared launch",
    caption: "Shared caption",
    scheduledFor: "",
    platforms: ["instagram", "youtube"]
  });
  const planId = state.postQueue[0].id;
  state = await harness.store.updatePostPlanDraft(planId, {
    platformPackages: [
      { platformId: "youtube", title: "YouTube launch", caption: "Long-form destination copy" },
      { platformId: "instagram", title: "Instagram launch", caption: "Short destination copy" }
    ],
    scheduledFor: "2026-12-10T19:30:00.000Z",
    timeZone: "America/Phoenix"
  });
  const plan = state.postQueue[0];
  assert.deepEqual(
    plan.platformPackages.map((item) => item.platformId),
    ["instagram", "youtube"]
  );
  assert.equal(plan.platformPackages[0].title, "Instagram launch");
  assert.equal(plan.schedule.mode, "planned_local_only");
  assert.equal(plan.schedule.timeZone, "America/Phoenix");
  assert.match(plan.contentHash, /^[a-f0-9]{64}$/);
  const auditCount = state.auditLog.length;
  state = await harness.store.updatePostPlanDraft(planId, {
    platformPackages: [
      { platformId: "instagram", title: "Instagram launch", caption: "Short destination copy" },
      { platformId: "youtube", title: "YouTube launch", caption: "Long-form destination copy" }
    ],
    scheduledFor: "2026-12-10T19:30:00.000Z",
    timeZone: "America/Phoenix"
  });
  assert.equal(state.auditLog.length, auditCount);
  state = await harness.store.createPostPlan({
    title: "Shared launch",
    caption: "Shared caption",
    scheduledFor: "",
    platforms: ["instagram", "youtube"]
  });
  const duplicateTargetId = state.postQueue.find((item) => item.id !== planId).id;
  await assert.rejects(
    () =>
      harness.store.updatePostPlanDraft(duplicateTargetId, {
        platformPackages: [
          { platformId: "instagram", title: "Instagram launch", caption: "Short destination copy" },
          { platformId: "youtube", title: "YouTube launch", caption: "Long-form destination copy" }
        ],
        scheduledFor: "2026-12-10T19:30:00.000Z",
        timeZone: "America/Phoenix"
      }),
    { code: "POST_PLAN_DUPLICATE" }
  );
  await assert.rejects(
    () =>
      harness.store.updatePostPlanDraft(planId, {
        platformPackages: [{ platformId: "youtube", title: "Incomplete", caption: "" }],
        scheduledFor: "",
        timeZone: "UTC"
      }),
    { code: "INVALID_INPUT" }
  );
  state = await harness.store.approvePostPlan(planId, "manual_export");
  const approvedPlan = state.postQueue.find((item) => item.id === planId);
  assert.equal(approvedPlan.approvalSnapshot.payload.platformPackages[0].title, "Instagram launch");
  await assert.rejects(
    () =>
      harness.store.updatePostPlanDraft(planId, {
        platformPackages: approvedPlan.platformPackages,
        scheduledFor: "",
        timeZone: "UTC"
      }),
    { code: "POST_PLAN_LOCKED" }
  );
});

test("official API approval verifies genuine connection readiness", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  let state = await harness.store.createPostPlan({
    title: "Official plan",
    caption: "",
    scheduledFor: "",
    platforms: ["youtube"]
  });
  const planId = state.postQueue[0].id;
  await assert.rejects(
    () => harness.store.approvePostPlan(planId, "official_api"),
    (error) => error.code === "INTEGRATION_NOT_READY"
  );
  harness.store.state.integrations.find((item) => item.id === "youtube").status = "connected";
  state = await harness.store.approvePostPlan(planId, "official_api");
  assert.equal(state.postQueue[0].status, "approved_for_official_api");
});

test("post and clip payload validation rejects unknown platforms and missing clip jobs", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await assert.rejects(
    () => harness.store.createClipJob({ title: "Bad", source: "/tmp/source.mp4", platforms: ["unknown"] }),
    (error) => error.code === "INVALID_INPUT"
  );
  await assert.rejects(
    () => harness.store.createPostPlan({ title: "Bad", clipJobId: "clip-missing", platforms: [] }),
    (error) => error.code === "CLIP_JOB_NOT_FOUND"
  );
});
