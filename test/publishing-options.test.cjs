const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { createInitialState } = require("../electron/initial-state.cjs");
const { migrateState, validateState } = require("../electron/state-schema.cjs");
const { getPlatform } = require("../electron/platforms/registry.cjs");
const { YouTubeConnector } = require("../electron/connectors/youtube.cjs");
const { createHarness } = require("./helpers.cjs");

const YOUTUBE_PACKAGE = (options) => [{ platformId: "youtube", title: "Launch", caption: "Copy", options }];

async function planWith(t, options) {
  const harness = await createHarness();
  t.after(harness.cleanup);
  let state = await harness.store.createPostPlan({ title: "Launch", caption: "Copy", platforms: ["youtube"] });
  const planId = state.postQueue[0].id;
  if (options !== undefined) {
    state = await harness.store.updatePostPlanDraft(planId, { platformPackages: YOUTUBE_PACKAGE(options) });
  }
  return { harness, planId, state };
}

test("a new YouTube plan starts with no audience declaration and a private default", async (t) => {
  const { state } = await planWith(t);
  const options = state.postQueue[0].platformPackages[0].options;
  // Visibility has a safe default. The audience declaration deliberately does not.
  assert.equal(options.privacyStatus, "private");
  assert.equal(options.selfDeclaredMadeForKids, null);
});

test("approval is refused until the audience declaration is made", async (t) => {
  const { harness, planId } = await planWith(t, { privacyStatus: "public" });
  await assert.rejects(() => harness.store.approvePostPlan(planId, "manual_export"), { code: "PUBLISHING_OPTION_REQUIRED" });
  await assert.rejects(() => harness.store.approvePostPlan(planId, "official_api"), { code: "PUBLISHING_OPTION_REQUIRED" });
});

test("both explicit audience values are accepted and preserved exactly", async (t) => {
  for (const declared of [true, false]) {
    const { harness, planId } = await planWith(t, { selfDeclaredMadeForKids: declared, privacyStatus: "private" });
    const state = await harness.store.approvePostPlan(planId, "manual_export");
    const approved = state.postQueue[0].approvalSnapshot.payload.platformPackages[0].options;
    assert.equal(approved.selfDeclaredMadeForKids, declared);
  }
});

test("a non-boolean audience value is rejected rather than coerced", async (t) => {
  const { harness, planId } = await planWith(t);
  for (const bad of ["maybe", 1, {}]) {
    await assert.rejects(
      () => harness.store.updatePostPlanDraft(planId, { platformPackages: YOUTUBE_PACKAGE({ selfDeclaredMadeForKids: bad }) }),
      { code: "INVALID_INPUT" },
      `${JSON.stringify(bad)} must not be coerced`
    );
  }
});

test("visibility accepts the supported values and rejects anything else", async (t) => {
  const { harness, planId } = await planWith(t);
  for (const visibility of ["private", "unlisted", "public"]) {
    const state = await harness.store.updatePostPlanDraft(planId, {
      platformPackages: YOUTUBE_PACKAGE({ selfDeclaredMadeForKids: false, privacyStatus: visibility })
    });
    assert.equal(state.postQueue[0].platformPackages[0].options.privacyStatus, visibility);
  }
  await assert.rejects(
    () =>
      harness.store.updatePostPlanDraft(planId, {
        platformPackages: YOUTUBE_PACKAGE({ selfDeclaredMadeForKids: false, privacyStatus: "everyone" })
      }),
    { code: "INVALID_INPUT" }
  );
});

test("the approval hash changes when a choice changes", async (t) => {
  const first = await planWith(t, { selfDeclaredMadeForKids: false, privacyStatus: "private" });
  const firstState = await first.harness.store.approvePostPlan(first.planId, "manual_export");
  const firstHash = firstState.postQueue[0].approvalSnapshot.hash;

  const second = await planWith(t, { selfDeclaredMadeForKids: true, privacyStatus: "private" });
  const secondState = await second.harness.store.approvePostPlan(second.planId, "manual_export");

  // Same copy, different declaration: the approved content is genuinely
  // different, so its hash and its idempotency key must differ too.
  assert.notEqual(firstHash, secondState.postQueue[0].approvalSnapshot.hash);
  assert.notEqual(
    firstState.postQueue[0].approvalSnapshot.destinations[0].idempotencyKey,
    secondState.postQueue[0].approvalSnapshot.destinations[0].idempotencyKey
  );
});

test("approved choices cannot be edited afterwards", async (t) => {
  const { harness, planId } = await planWith(t, { selfDeclaredMadeForKids: false, privacyStatus: "private" });
  await harness.store.approvePostPlan(planId, "manual_export");
  await assert.rejects(
    () =>
      harness.store.updatePostPlanDraft(planId, {
        platformPackages: YOUTUBE_PACKAGE({ selfDeclaredMadeForKids: true, privacyStatus: "public" })
      }),
    { code: "POST_PLAN_LOCKED" }
  );
});

test("the approved choices reach the exported package without credentials", async (t) => {
  const { harness, planId } = await planWith(t, { selfDeclaredMadeForKids: true, privacyStatus: "unlisted" });
  await harness.store.approvePostPlan(planId, "manual_export");
  const packageDocument = harness.store.getPostExportPackage(planId);
  const options = packageDocument.approval.payload.platformPackages[0].options;
  assert.equal(options.selfDeclaredMadeForKids, true);
  assert.equal(options.privacyStatus, "unlisted");
  assert.equal(JSON.stringify(packageDocument).includes("oauth"), false);
});

test("the connector refuses to invent an audience declaration", () => {
  const connector = new YouTubeConnector({ transport: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  for (const missing of [undefined, null, "false", 0]) {
    assert.throws(() => connector.buildVideoMetadata({ title: "T", selfDeclaredMadeForKids: missing }), {
      code: "YOUTUBE_AUDIENCE_DECLARATION_REQUIRED"
    });
  }
  // An explicit value passes through unchanged.
  assert.equal(connector.buildVideoMetadata({ title: "T", selfDeclaredMadeForKids: true }).status.selfDeclaredMadeForKids, true);
  assert.equal(connector.buildVideoMetadata({ title: "T", selfDeclaredMadeForKids: false }).status.selfDeclaredMadeForKids, false);
});

test("a platform with no declared options carries none", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  assert.equal(getPlatform("instagram").publishingOptions, null);
  const state = await harness.store.createPostPlan({ title: "IG", caption: "", platforms: ["instagram"] });
  assert.equal(state.postQueue[0].platformPackages[0].options, null);
});

// --- migration ------------------------------------------------------------

function legacyStateWithApprovedPlan() {
  const state = createInitialState();
  state.schemaVersion = 9;
  const plan = {
    id: "post-legacy",
    clipJobId: null,
    mediaJobId: null,
    title: "Legacy launch",
    caption: "Legacy copy",
    scheduledFor: null,
    timeZone: null,
    platforms: ["youtube"],
    // The v1 package shape: no options key at all.
    platformPackages: [{ platformId: "youtube", title: "Legacy launch", caption: "Legacy copy" }],
    schedule: { mode: "unscheduled", scheduledFor: null, timeZone: null },
    status: "approved_for_manual_export",
    contentHash: null,
    mediaSnapshot: null,
    exportReceipt: null,
    publicationReceipts: [],
    canceledAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    approvedAt: "2026-01-02T00:00:00.000Z"
  };
  const payload = {
    planId: plan.id,
    title: plan.title,
    caption: plan.caption,
    platformPackages: plan.platformPackages,
    schedule: plan.schedule,
    media: null
  };
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  plan.approvalSnapshot = {
    version: 1,
    hash,
    mode: "manual_export",
    approvedAt: plan.approvedAt,
    payload,
    destinations: [
      { platformId: "youtube", idempotencyKey: crypto.createHash("sha256").update(`${plan.id}:youtube:${hash}`).digest("hex") }
    ]
  };
  state.postQueue = [plan];
  return state;
}

test("an existing v1 approval still validates after the payload shape grew", () => {
  // Without version-aware hashing this would throw INVALID_STATE and the app
  // would refuse to boot for anyone with an already-approved plan.
  const migrated = migrateState(legacyStateWithApprovedPlan());
  assert.doesNotThrow(() => validateState(migrated));
  const plan = migrated.postQueue[0];
  assert.equal(plan.approvalSnapshot.version, 1);
  assert.equal(plan.status, "approved_for_manual_export");
});

test("migration seeds options without inventing an audience declaration", () => {
  const migrated = migrateState(legacyStateWithApprovedPlan());
  const options = migrated.postQueue[0].platformPackages[0].options;
  assert.equal(options.privacyStatus, "private");
  // The critical assertion: an old plan is left incomplete rather than being
  // given a declaration its owner never made.
  assert.equal(options.selfDeclaredMadeForKids, null);
});

test("a migrated legacy plan cannot be published until its declaration is made", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  harness.store.state = migrateState(legacyStateWithApprovedPlan());
  // Its own approval predates the declaration, so re-approving is refused
  // until the choice exists.
  await assert.rejects(
    () => harness.store.approvePostPlan("post-legacy", "official_api"),
    (error) => ["PUBLISHING_OPTION_REQUIRED", "INVALID_TRANSITION"].includes(error.code)
  );
});

test("a plan whose options drifted from the registry still loads", async (t) => {
  // The registry is code and a saved plan is data the user already has, so the
  // two will disagree the first time a release adds or retires an option.
  // Rejecting here is not a contained failure: validateState throwing sends
  // loadRecoverableState through the backup -- which has the same shape and
  // fails identically -- and on to createInitialState(), so the user opens an
  // empty app because a field was added.
  const drifted = migrateState(legacyStateWithApprovedPlan());
  drifted.postQueue[0].platformPackages[0].options = {
    // Retired since this plan was written.
    legacyChoice: "gone",
    // Still declared, but holding a value the registry no longer offers.
    privacyStatus: "friends-only"
    // selfDeclaredMadeForKids has been dropped entirely: newly declared, or
    // written by a build that did not have it.
  };
  assert.doesNotThrow(() => validateState(drifted), "drifted options must not make existing state unloadable");

  // Structure is still structure: this is not a plausible options record.
  drifted.postQueue[0].platformPackages[0].options = ["not", "an", "object"];
  assert.throws(() => validateState(drifted));

  // And nothing has been loosened where refusing is safe -- approval still
  // demands a declaration nobody has made.
  const harness = await createHarness();
  t.after(harness.cleanup);
  harness.store.state = migrateState(legacyStateWithApprovedPlan());
  harness.store.state.postQueue[0].status = "needs_approval";
  harness.store.state.postQueue[0].platformPackages[0].options = { privacyStatus: "private" };
  await assert.rejects(() => harness.store.approvePostPlan("post-legacy", "manual_export"), { code: "PUBLISHING_OPTION_REQUIRED" });
});
