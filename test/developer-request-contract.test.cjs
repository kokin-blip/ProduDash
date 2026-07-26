const assert = require("node:assert/strict");
const test = require("node:test");
const { EXPORT_RESOURCE_TYPES } = require("../electron/collaboration/records.cjs");
const {
  REQUEST_SCHEMA_BY_OPERATION,
  mutationRequestSchemas,
  normalizeApiMutationRequest
} = require("../electron/developer-platform/request-contract.cjs");
const { WEBHOOK_EVENT_TYPES } = require("../electron/developer-platform/webhook-contract.cjs");

const PLAN_HASH = `sha256:${"1".repeat(64)}`;

test("every API mutation has one strict internal request schema", () => {
  const schemas = mutationRequestSchemas();
  assert.equal(Object.keys(REQUEST_SCHEMA_BY_OPERATION).length, 11);
  assert.deepEqual(new Set(Object.values(REQUEST_SCHEMA_BY_OPERATION)), new Set(Object.keys(schemas)));
  for (const schema of Object.values(schemas)) {
    const variants = schema.oneOf || [schema];
    for (const variant of variants) assert.equal(variant.additionalProperties, false);
  }
});

test("project mutation requests are bounded, revision-aware, and media-ID only", () => {
  assert.deepEqual(
    normalizeApiMutationRequest("projects", "create", {
      sourceMediaId: "media-a",
      title: "Launch clip",
      description: "A local project",
      businessId: null,
      tags: ["launch"],
      collectionId: null,
      platforms: ["youtube"],
      desiredLengths: ["30 seconds"],
      instructions: "Keep the complete thought."
    }),
    {
      title: "Launch clip",
      description: "A local project",
      businessId: null,
      collectionId: null,
      tags: ["launch"],
      platforms: ["youtube"],
      desiredLengths: ["30 seconds"],
      instructions: "Keep the complete thought.",
      sourceMediaId: "media-a"
    }
  );
  assert.deepEqual(
    normalizeApiMutationRequest("projects", "update", {
      expectedRevision: 4,
      title: "Revised title",
      favorite: true
    }),
    { title: "Revised title", expectedRevision: 4, favorite: true }
  );
  for (const invalid of [
    { sourceMediaId: "media-a", title: "Project", sourcePath: "/private/source.mp4" },
    { sourceMediaId: "media-a", title: "Project", credential: "secret" },
    { sourceMediaId: "media-a", title: "Project", tags: ["same", "same"] }
  ]) {
    assert.throws(
      () => normalizeApiMutationRequest("projects", "create", invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
  assert.throws(
    () => normalizeApiMutationRequest("projects", "update", { expectedRevision: 4 }),
    (error) => error.code === "INVALID_INPUT"
  );
});

test("job requests distinguish local preparation from explicitly approved immutable rendering", () => {
  assert.deepEqual(
    normalizeApiMutationRequest("jobs", "create", {
      jobType: "project_prepare",
      projectRevision: 2
    }),
    { jobType: "project_prepare", projectRevision: 2 }
  );
  assert.deepEqual(
    normalizeApiMutationRequest("jobs", "create", {
      jobType: "project_render",
      projectRevision: 3,
      renderPlanHash: PLAN_HASH,
      approvalId: "approval-a"
    }),
    {
      jobType: "project_render",
      projectRevision: 3,
      renderPlanHash: PLAN_HASH,
      approvalId: "approval-a"
    }
  );
  assert.deepEqual(normalizeApiMutationRequest("jobs", "cancel", {}), {});
  assert.deepEqual(normalizeApiMutationRequest("jobs", "retry", {}), {});
  for (const invalid of [
    { jobType: "clip_generation", projectRevision: 1 },
    { jobType: "project_render", projectRevision: 1, renderPlanHash: PLAN_HASH },
    { jobType: "project_prepare", projectRevision: 1, approvalId: "approval-a" }
  ]) {
    assert.throws(
      () => normalizeApiMutationRequest("jobs", "create", invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("approval and export requests preserve explicit human gates and complete exports", () => {
  assert.deepEqual(
    normalizeApiMutationRequest("approvals", "decide", {
      expectedStatus: "pending",
      decision: "approved"
    }),
    { expectedStatus: "pending", decision: "approved" }
  );
  assert.deepEqual(
    normalizeApiMutationRequest("publishing", "approve", {
      expectedStatus: "needs_approval",
      approvalPath: "manual_export"
    }),
    { expectedStatus: "needs_approval", approvalPath: "manual_export" }
  );
  assert.deepEqual(
    normalizeApiMutationRequest("organization_exports", "create", {
      resourceTypes: [...EXPORT_RESOURCE_TYPES]
    }),
    { resourceTypes: [...EXPORT_RESOURCE_TYPES] }
  );
  for (const [resourceType, operation, payload] of [
    ["approvals", "decide", { expectedStatus: "approved", decision: "rejected" }],
    ["publishing", "approve", { expectedStatus: "needs_approval", approvalPath: "dispatch_now" }],
    ["organization_exports", "create", { resourceTypes: EXPORT_RESOURCE_TYPES.slice(1) }],
    ["projects", "get", {}]
  ]) {
    assert.throws(
      () => normalizeApiMutationRequest(resourceType, operation, payload),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("webhook mutation requests reuse public HTTPS and event allowlists without accepting signing material", () => {
  assert.deepEqual(
    normalizeApiMutationRequest("webhooks", "create", {
      url: "https://hooks.example.com/events",
      eventTypes: [WEBHOOK_EVENT_TYPES[0]],
      status: "active"
    }),
    {
      url: "https://hooks.example.com/events",
      eventTypes: [WEBHOOK_EVENT_TYPES[0]],
      status: "active"
    }
  );
  assert.deepEqual(
    normalizeApiMutationRequest("webhooks", "update", {
      expectedUpdatedAt: "2026-07-25T12:00:00Z",
      status: "paused"
    }),
    { expectedUpdatedAt: "2026-07-25T12:00:00.000Z", status: "paused" }
  );
  assert.deepEqual(
    normalizeApiMutationRequest("webhooks", "delete", {
      expectedUpdatedAt: "2026-07-25T12:00:00Z"
    }),
    { expectedUpdatedAt: "2026-07-25T12:00:00.000Z" }
  );
  for (const invalid of [
    { url: "http://localhost:3000/events", eventTypes: [WEBHOOK_EVENT_TYPES[0]], status: "active" },
    { url: "https://hooks.example.com/events", eventTypes: ["everything"], status: "active" },
    {
      url: "https://hooks.example.com/events",
      eventTypes: [WEBHOOK_EVENT_TYPES[0]],
      status: "active",
      secret: "must-not-be-accepted"
    }
  ]) {
    assert.throws(
      () => normalizeApiMutationRequest("webhooks", "create", invalid),
      (error) => ["INVALID_INPUT", "INVALID_WEBHOOK_URL"].includes(error.code)
    );
  }
  assert.throws(
    () => normalizeApiMutationRequest("webhooks", "update", { expectedUpdatedAt: "2026-07-25T12:00:00Z" }),
    (error) => error.code === "INVALID_INPUT"
  );
});
