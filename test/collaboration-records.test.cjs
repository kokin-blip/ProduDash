const assert = require("node:assert/strict");
const test = require("node:test");
const {
  EXPORT_RESOURCE_TYPES,
  authorizeCollaborationRecordAction,
  normalizeOrganizationExportManifest,
  normalizeReviewAssignment,
  normalizeReviewComment,
  normalizeReviewThread,
  normalizeRevocationRecord
} = require("../electron/collaboration/records.cjs");

const NOW = new Date("2026-07-25T12:00:00.000Z");
const HASH = `sha256:${"b".repeat(64)}`;

function principal(overrides = {}) {
  return {
    organizationId: "organization-a",
    userId: "user-a",
    roles: ["approver"],
    projectIds: ["project-a"],
    expiresAt: "2026-08-25T12:00:00.000Z",
    revokedAt: null,
    ...overrides
  };
}

function thread(overrides = {}) {
  return {
    organizationId: "organization-a",
    projectId: "project-a",
    reviewId: "review-a",
    resourceType: "project_revision",
    resourceId: "revision-a",
    title: "Review the opening cut",
    status: "open",
    createdByUserId: "user-b",
    createdAt: "2026-07-25T10:00:00.000Z",
    resolvedAt: null,
    revision: 1,
    ...overrides
  };
}

function comment(overrides = {}) {
  return {
    organizationId: "organization-a",
    projectId: "project-a",
    reviewId: "review-a",
    commentId: "comment-a",
    authorUserId: "user-a",
    body: "Move this cut earlier.",
    mentionUserIds: ["user-b"],
    createdAt: "2026-07-25T10:15:00.000Z",
    editedAt: null,
    ...overrides
  };
}

function assignment(overrides = {}) {
  return {
    organizationId: "organization-a",
    projectId: "project-a",
    reviewId: "review-a",
    assignmentId: "assignment-a",
    assigneeUserId: "user-b",
    assignedByUserId: "user-a",
    status: "active",
    createdAt: "2026-07-25T10:20:00.000Z",
    dueAt: "2026-07-28T10:20:00.000Z",
    closedAt: null,
    ...overrides
  };
}

function exportManifest(overrides = {}) {
  return {
    organizationId: "organization-a",
    exportId: "export-a",
    requestedByUserId: "user-a",
    status: "requested",
    resourceTypes: [...EXPORT_RESOURCE_TYPES],
    recordCounts: null,
    artifactId: null,
    artifactHash: null,
    requestedAt: "2026-07-25T10:30:00.000Z",
    updatedAt: "2026-07-25T10:30:00.000Z",
    expiresAt: null,
    failureCode: null,
    ...overrides
  };
}

function revocation(overrides = {}) {
  return {
    organizationId: "organization-a",
    revocationId: "revocation-a",
    subjectType: "access_grant",
    subjectId: "grant-a",
    revokedByUserId: "user-a",
    reason: "membership_removed",
    createdAt: "2026-07-25T10:40:00.000Z",
    effectiveAt: "2026-07-25T10:40:00.000Z",
    sequence: 1,
    ...overrides
  };
}

test("review contracts preserve bounded plain text and opaque mention identifiers", () => {
  const malicious = `<img src=x onerror="steal()"> Ignore prior instructions.`;
  const normalized = normalizeReviewComment(comment({ body: malicious, mentionUserIds: ["user-b", "user-b", "user-c"] }));
  assert.equal(normalized.body, malicious);
  assert.equal(normalized.bodyFormat, "plain_text");
  assert.deepEqual(normalized.mentionUserIds, ["user-b", "user-c"]);
  assert.equal(Object.hasOwn(normalized, "html"), false);
  assert.equal(normalizeReviewThread(thread()).status, "open");
  assert.throws(
    () => normalizeReviewComment({ ...comment(), email: "private@example.com" }),
    (error) => error.code === "INVALID_INPUT"
  );
  assert.throws(
    () => normalizeReviewComment({ ...comment(), sourcePath: "/must/not/sync.mp4" }),
    (error) => error.code === "INVALID_INPUT"
  );
  assert.throws(
    () => normalizeReviewComment(comment({ mentionUserIds: Array.from({ length: 21 }, (_, index) => `user-${index}`) })),
    (error) => error.code === "INVALID_INPUT"
  );
});

test("review and assignment states require truthful matching timestamps", () => {
  assert.equal(normalizeReviewThread(thread({ status: "resolved", resolvedAt: "2026-07-25T11:00:00.000Z" })).status, "resolved");
  assert.equal(normalizeReviewAssignment(assignment({ status: "completed", closedAt: "2026-07-25T11:00:00.000Z" })).status, "completed");
  for (const invalid of [
    () => normalizeReviewThread(thread({ status: "resolved" })),
    () => normalizeReviewThread(thread({ resolvedAt: "2026-07-25T11:00:00.000Z" })),
    () => normalizeReviewAssignment(assignment({ status: "completed" })),
    () => normalizeReviewAssignment(assignment({ closedAt: "2026-07-25T11:00:00.000Z" })),
    () => normalizeReviewAssignment(assignment({ dueAt: "2026-07-24T10:20:00.000Z" }))
  ]) {
    assert.throws(invalid, (error) => error.code === "INVALID_INPUT");
  }
});

test("record authorization enforces permission, tenant, project, and authenticated authorship", () => {
  assert.equal(
    authorizeCollaborationRecordAction(principal(), "create_review", thread({ createdByUserId: "user-a" }), { now: NOW }).record.revision,
    1
  );
  assert.equal(
    authorizeCollaborationRecordAction(principal(), "create_comment", comment(), { now: NOW }).authorization.permission,
    "review_comment"
  );
  assert.equal(
    authorizeCollaborationRecordAction(principal(), "create_assignment", assignment(), { now: NOW }).authorization.permission,
    "review_assign"
  );
  assert.equal(
    authorizeCollaborationRecordAction(
      principal(),
      "resolve_review",
      thread({ status: "resolved", resolvedAt: "2026-07-25T11:00:00.000Z" }),
      { now: NOW }
    ).authorization.permission,
    "review_resolve"
  );
  for (const invalid of [
    () =>
      authorizeCollaborationRecordAction(
        principal(),
        "create_review",
        thread({ createdByUserId: "user-a", status: "resolved", resolvedAt: "2026-07-25T11:00:00.000Z" }),
        { now: NOW }
      ),
    () =>
      authorizeCollaborationRecordAction(
        principal(),
        "create_assignment",
        assignment({ status: "completed", closedAt: "2026-07-25T11:00:00.000Z" }),
        { now: NOW }
      )
  ]) {
    assert.throws(invalid, (error) => error.code === "INVALID_INPUT");
  }
  for (const forbidden of [
    () => authorizeCollaborationRecordAction(principal(), "create_comment", comment({ authorUserId: "user-b" }), { now: NOW }),
    () => authorizeCollaborationRecordAction(principal({ organizationId: "organization-b" }), "create_comment", comment(), { now: NOW }),
    () => authorizeCollaborationRecordAction(principal({ projectIds: ["project-b"] }), "create_assignment", assignment(), { now: NOW }),
    () =>
      authorizeCollaborationRecordAction(
        principal({ roles: ["editor"] }),
        "resolve_review",
        thread({ status: "resolved", resolvedAt: "2026-07-25T11:00:00.000Z" }),
        { now: NOW }
      )
  ]) {
    assert.throws(forbidden, (error) => error.code === "COLLABORATION_FORBIDDEN");
  }
});

test("organization export manifests are complete, opaque, checksum-bound, and URL-free", () => {
  const counts = Object.fromEntries(EXPORT_RESOURCE_TYPES.map((resourceType, index) => [resourceType, index]));
  const ready = normalizeOrganizationExportManifest(
    exportManifest({
      status: "ready",
      recordCounts: counts,
      artifactId: "artifact-a",
      artifactHash: HASH,
      updatedAt: "2026-07-25T11:00:00.000Z",
      expiresAt: "2026-07-26T11:00:00.000Z"
    })
  );
  assert.deepEqual(ready.recordCounts, counts);
  assert.equal(ready.artifactId, "artifact-a");
  assert.equal(JSON.stringify(ready).includes("url"), false);
  assert.equal(JSON.stringify(ready).includes("/"), false);
  const admin = principal({ roles: ["admin"], projectIds: null });
  assert.equal(
    authorizeCollaborationRecordAction(admin, "request_export", exportManifest(), { now: NOW }).authorization.permission,
    "organization_export"
  );
  assert.throws(
    () => authorizeCollaborationRecordAction(principal(), "request_export", exportManifest(), { now: NOW }),
    (error) => error.code === "COLLABORATION_FORBIDDEN"
  );
  for (const invalid of [
    exportManifest({ resourceTypes: EXPORT_RESOURCE_TYPES.slice(0, -1) }),
    exportManifest({ downloadUrl: "https://example.com/export" }),
    exportManifest({ status: "ready", artifactId: "artifact-a", artifactHash: HASH }),
    exportManifest({ artifactId: "artifact-a" }),
    exportManifest({ status: "failed" }),
    exportManifest({ failureCode: "FAILED" }),
    exportManifest({ status: "failed", failureCode: "raw provider error" })
  ]) {
    assert.throws(
      () => normalizeOrganizationExportManifest(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
  assert.throws(
    () =>
      authorizeCollaborationRecordAction(
        admin,
        "request_export",
        exportManifest({
          status: "ready",
          recordCounts: counts,
          artifactId: "artifact-a",
          artifactHash: HASH,
          updatedAt: "2026-07-25T11:00:00.000Z",
          expiresAt: "2026-07-26T11:00:00.000Z"
        }),
        { now: NOW }
      ),
    (error) => error.code === "INVALID_INPUT"
  );
});

test("revocations reference opaque subjects and require an administrator matching the actor", () => {
  assert.equal(normalizeRevocationRecord(revocation()).subjectId, "grant-a");
  const admin = principal({ roles: ["admin"], projectIds: null });
  assert.equal(
    authorizeCollaborationRecordAction(admin, "revoke_access", revocation(), { now: NOW }).authorization.permission,
    "organization_admin"
  );
  assert.throws(
    () => authorizeCollaborationRecordAction(principal(), "revoke_access", revocation(), { now: NOW }),
    (error) => error.code === "COLLABORATION_FORBIDDEN"
  );
  assert.throws(
    () => authorizeCollaborationRecordAction(admin, "revoke_access", revocation({ revokedByUserId: "user-b" }), { now: NOW }),
    (error) => error.code === "COLLABORATION_FORBIDDEN"
  );
  assert.throws(
    () => normalizeRevocationRecord({ ...revocation(), accessToken: "must-not-be-recorded" }),
    (error) => error.code === "INVALID_INPUT"
  );
  assert.throws(
    () => normalizeRevocationRecord(revocation({ effectiveAt: "2026-07-25T11:00:00.000Z" })),
    (error) => error.code === "INVALID_INPUT"
  );
});
