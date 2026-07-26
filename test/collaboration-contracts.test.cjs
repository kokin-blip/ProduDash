const assert = require("node:assert/strict");
const test = require("node:test");
const {
  COLLABORATION_PERMISSIONS,
  ROLE_PERMISSIONS,
  assertCollaborationPermission,
  authorizeSyncEnvelope,
  evaluateSyncEnvelope,
  normalizePrincipal,
  normalizeSyncEnvelope
} = require("../electron/collaboration/contracts.cjs");

const NOW = new Date("2026-07-25T12:00:00.000Z");
const PAYLOAD_HASH = `sha256:${"a".repeat(64)}`;

function principal(overrides = {}) {
  return {
    organizationId: "organization-a",
    userId: "user-a",
    roles: ["editor"],
    projectIds: ["project-a"],
    expiresAt: "2026-08-25T12:00:00.000Z",
    revokedAt: null,
    ...overrides
  };
}

function envelope(overrides = {}) {
  return {
    organizationId: "organization-a",
    projectId: "project-a",
    resourceType: "project",
    resourceId: "project-a",
    operation: "edit",
    baseRevision: 4,
    revision: 5,
    mutationId: "mutation-a",
    deviceId: "device-a",
    occurredAt: "2026-07-25T11:59:00.000Z",
    payloadHash: PAYLOAD_HASH,
    ...overrides
  };
}

test("collaboration roles keep edit, approval, publishing, analytics, and admin permissions separate", () => {
  assert.deepEqual(ROLE_PERMISSIONS.viewer, ["project_read"]);
  assert.equal(ROLE_PERMISSIONS.editor.includes(COLLABORATION_PERMISSIONS.PROJECT_EDIT), true);
  assert.equal(ROLE_PERMISSIONS.editor.includes(COLLABORATION_PERMISSIONS.APPROVAL_DECIDE), false);
  assert.equal(ROLE_PERMISSIONS.approver.includes(COLLABORATION_PERMISSIONS.APPROVAL_DECIDE), true);
  assert.equal(ROLE_PERMISSIONS.approver.includes(COLLABORATION_PERMISSIONS.REVIEW_RESOLVE), true);
  assert.equal(ROLE_PERMISSIONS.approver.includes(COLLABORATION_PERMISSIONS.PUBLISHING_APPROVE), false);
  assert.equal(ROLE_PERMISSIONS.publisher.includes(COLLABORATION_PERMISSIONS.PUBLISHING_APPROVE), true);
  assert.equal(ROLE_PERMISSIONS.publisher.includes(COLLABORATION_PERMISSIONS.ANALYTICS_READ), false);
  assert.equal(ROLE_PERMISSIONS.analyst.includes(COLLABORATION_PERMISSIONS.ANALYTICS_READ), true);
  assert.deepEqual(new Set(ROLE_PERMISSIONS.admin), new Set(Object.values(COLLABORATION_PERMISSIONS)));
});

test("collaboration permissions deny revoked, expired, cross-tenant, out-of-scope, and insufficient access", () => {
  assert.deepEqual(
    assertCollaborationPermission(
      principal(),
      COLLABORATION_PERMISSIONS.PROJECT_EDIT,
      { organizationId: "organization-a", projectId: "project-a" },
      { now: NOW }
    ),
    {
      organizationId: "organization-a",
      projectId: "project-a",
      userId: "user-a",
      permission: "project_edit"
    }
  );
  const attempts = [
    {
      value: principal({ revokedAt: "2026-07-25T11:00:00.000Z" }),
      target: { organizationId: "organization-a", projectId: "project-a" },
      permission: COLLABORATION_PERMISSIONS.PROJECT_EDIT,
      code: "COLLABORATION_REVOKED"
    },
    {
      value: principal({ expiresAt: "2026-07-25T11:00:00.000Z" }),
      target: { organizationId: "organization-a", projectId: "project-a" },
      permission: COLLABORATION_PERMISSIONS.PROJECT_EDIT,
      code: "COLLABORATION_EXPIRED"
    },
    {
      value: principal(),
      target: { organizationId: "organization-b", projectId: "project-a" },
      permission: COLLABORATION_PERMISSIONS.PROJECT_EDIT,
      code: "COLLABORATION_FORBIDDEN"
    },
    {
      value: principal(),
      target: { organizationId: "organization-a", projectId: "project-b" },
      permission: COLLABORATION_PERMISSIONS.PROJECT_EDIT,
      code: "COLLABORATION_FORBIDDEN"
    },
    {
      value: principal({ roles: ["viewer"] }),
      target: { organizationId: "organization-a", projectId: "project-a" },
      permission: COLLABORATION_PERMISSIONS.PROJECT_EDIT,
      code: "COLLABORATION_FORBIDDEN"
    }
  ];
  for (const attempt of attempts) {
    assert.throws(
      () => assertCollaborationPermission(attempt.value, attempt.permission, attempt.target, { now: NOW }),
      (error) => error.code === attempt.code
    );
  }
});

test("collaboration principals require explicit bounded project scope", () => {
  assert.deepEqual(normalizePrincipal(principal({ projectIds: null })).projectIds, null);
  assert.throws(
    () => normalizePrincipal({ ...principal(), projectIds: undefined }),
    (error) => error.code === "INVALID_INPUT"
  );
  assert.throws(
    () => normalizePrincipal({ ...principal(), token: "must-not-enter-public-contracts" }),
    (error) => error.code === "INVALID_INPUT"
  );
  assert.throws(
    () => normalizePrincipal(principal({ projectIds: Array.from({ length: 501 }, (_, index) => `project-${index}`) })),
    (error) => error.code === "INVALID_INPUT"
  );
});

test("sync envelopes are strict, bounded, revisioned, and contain hashes rather than payloads", () => {
  assert.deepEqual(normalizeSyncEnvelope(envelope()), envelope());
  for (const invalid of [
    envelope({ revision: 6 }),
    envelope({ payloadHash: "sha256:short" }),
    envelope({ operation: "publish" }),
    envelope({ occurredAt: "not-a-date" }),
    { ...envelope(), payload: { sourcePath: "/must/not/sync.mp4" } },
    { ...envelope(), credential: "must-not-sync" }
  ]) {
    assert.throws(
      () => normalizeSyncEnvelope(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("sync authorization maps each operation to its distinct permission", () => {
  assert.equal(authorizeSyncEnvelope(principal(), envelope(), { now: NOW }).permission, COLLABORATION_PERMISSIONS.PROJECT_EDIT);
  assert.throws(
    () => authorizeSyncEnvelope(principal({ roles: ["publisher"] }), envelope(), { now: NOW }),
    (error) => error.code === "COLLABORATION_FORBIDDEN"
  );
  assert.equal(
    authorizeSyncEnvelope(
      principal({ roles: ["publisher"] }),
      envelope({ resourceType: "publishing", resourceId: "publishing-a", operation: "publish" }),
      { now: NOW }
    ).permission,
    COLLABORATION_PERMISSIONS.PUBLISHING_APPROVE
  );
  assert.equal(
    authorizeSyncEnvelope(
      principal({ roles: ["approver"] }),
      envelope({ resourceType: "review", resourceId: "review-a", operation: "resolve" }),
      { now: NOW }
    ).permission,
    COLLABORATION_PERMISSIONS.REVIEW_RESOLVE
  );
  assert.equal(
    authorizeSyncEnvelope(principal(), envelope({ resourceType: "conflict", resourceId: "conflict-a", operation: "resolve_conflict" }), {
      now: NOW
    }).permission,
    COLLABORATION_PERMISSIONS.CONFLICT_RESOLVE
  );
});

test("sync evaluation is idempotent and surfaces revision or target conflicts without merging", () => {
  const current = {
    organizationId: "organization-a",
    projectId: "project-a",
    resourceType: "project",
    resourceId: "project-a",
    revision: 4,
    seenMutationIds: []
  };
  assert.deepEqual(evaluateSyncEnvelope(envelope(), current), {
    status: "apply",
    mutationId: "mutation-a",
    currentRevision: 4,
    nextRevision: 5,
    payloadHash: PAYLOAD_HASH
  });
  assert.deepEqual(evaluateSyncEnvelope(envelope(), { ...current, revision: 5, seenMutationIds: ["mutation-a"] }), {
    status: "idempotent",
    mutationId: "mutation-a",
    currentRevision: 5
  });
  assert.deepEqual(evaluateSyncEnvelope(envelope(), { ...current, revision: 9 }), {
    status: "conflict",
    reason: "revision_mismatch",
    mutationId: "mutation-a",
    currentRevision: 9,
    incomingBaseRevision: 4
  });
  assert.throws(
    () => evaluateSyncEnvelope(envelope(), { ...current, organizationId: "organization-b" }),
    (error) => error.code === "SYNC_TARGET_MISMATCH"
  );
});
