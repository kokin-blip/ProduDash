const assert = require("node:assert/strict");
const test = require("node:test");
const { createHarness } = require("./helpers.cjs");

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
  await assert.rejects(
    () => harness.store.markPostExported(planId),
    (error) => error.code === "INVALID_TRANSITION"
  );
  state = await harness.store.approvePostPlan(planId, "manual_export");
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
