const assert = require("node:assert/strict");
const test = require("node:test");
const {
  authorizeConflictResolution,
  authorizeDeviceRegistration,
  evaluateConflictTransition,
  evaluateDeviceIdentityTransition,
  normalizeAuditEvent,
  normalizeDeviceIdentity,
  normalizeSyncConflict
} = require("../electron/collaboration/integrity.cjs");

const NOW = new Date("2026-07-25T12:00:00.000Z");
const LOCAL_HASH = `sha256:${"c".repeat(64)}`;
const REMOTE_HASH = `sha256:${"d".repeat(64)}`;
const MANUAL_HASH = `sha256:${"e".repeat(64)}`;

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

function device(overrides = {}) {
  return {
    organizationId: "organization-a",
    userId: "user-a",
    deviceId: "device-a",
    label: "Editing laptop",
    platform: "macos",
    architecture: "arm64",
    publicKeyFingerprint: `sha256:${"f".repeat(64)}`,
    status: "active",
    registeredAt: "2026-07-25T09:00:00.000Z",
    lastSeenAt: "2026-07-25T10:00:00.000Z",
    revokedAt: null,
    sequence: 1,
    ...overrides
  };
}

function conflict(overrides = {}) {
  return {
    organizationId: "organization-a",
    projectId: "project-a",
    conflictId: "conflict-a",
    resourceType: "project",
    resourceId: "project-a",
    localRevision: 5,
    remoteBaseRevision: 4,
    remoteRevision: 5,
    localPayloadHash: LOCAL_HASH,
    remotePayloadHash: REMOTE_HASH,
    detectedAt: "2026-07-25T10:30:00.000Z",
    status: "open",
    resolution: null,
    sequence: 1,
    ...overrides
  };
}

function resolvedConflict(type = "manual_revision", overrides = {}) {
  const payloadHash = type === "keep_local" ? LOCAL_HASH : type === "accept_remote" ? REMOTE_HASH : MANUAL_HASH;
  return conflict({
    status: "resolved",
    resolution: {
      type,
      resolvedByUserId: "user-a",
      resolvedAt: "2026-07-25T11:00:00.000Z",
      revision: 6,
      payloadHash
    },
    sequence: 2,
    ...overrides
  });
}

function audit(overrides = {}) {
  return {
    organizationId: "organization-a",
    eventId: "audit-a",
    sequence: 1,
    actorType: "user",
    actorId: "user-a",
    action: "project_edit",
    outcome: "succeeded",
    projectId: "project-a",
    resourceType: "project",
    resourceId: "project-a",
    occurredAt: "2026-07-25T11:15:00.000Z",
    requestId: "request-a",
    deviceId: "device-a",
    mutationId: "mutation-a",
    reasonCode: null,
    ...overrides
  };
}

test("device identities expose coarse metadata and fingerprints without keys or machine identifiers", () => {
  const normalized = normalizeDeviceIdentity(device({ label: `<img src=x onerror="steal()">` }));
  assert.equal(normalized.labelFormat, "plain_text");
  assert.equal(normalized.publicKeyFingerprint.startsWith("sha256:"), true);
  for (const invalid of [
    { ...device(), publicKey: "secret-key-material" },
    { ...device(), hardwareUuid: "machine-uuid" },
    { ...device(), ipAddress: "192.0.2.1" },
    { ...device(), token: "secret-token" },
    device({ publicKeyFingerprint: "sha256:short" }),
    device({ lastSeenAt: "2026-07-25T08:00:00.000Z" }),
    device({ status: "revoked" })
  ]) {
    assert.throws(
      () => normalizeDeviceIdentity(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
  assert.equal(authorizeDeviceRegistration(principal(), device(), { now: NOW }).authorization.userId, "user-a");
  assert.throws(
    () => authorizeDeviceRegistration(principal(), device({ userId: "user-b" }), { now: NOW }),
    (error) => error.code === "COLLABORATION_FORBIDDEN"
  );
  assert.throws(
    () => authorizeDeviceRegistration(principal(), device({ sequence: 2 }), { now: NOW }),
    (error) => error.code === "INVALID_INPUT"
  );
});

test("device transitions are consecutive, monotonic, identity-bound, and never reactivate revoked devices", () => {
  const heartbeat = device({ lastSeenAt: "2026-07-25T10:30:00.000Z", sequence: 2 });
  assert.equal(evaluateDeviceIdentityTransition(device(), heartbeat).status, "apply");
  const revoked = device({
    status: "revoked",
    lastSeenAt: "2026-07-25T10:30:00.000Z",
    revokedAt: "2026-07-25T11:00:00.000Z",
    sequence: 3
  });
  assert.equal(evaluateDeviceIdentityTransition(heartbeat, revoked).status, "apply");
  assert.equal(evaluateDeviceIdentityTransition(revoked, revoked).status, "idempotent");
  assert.throws(
    () => evaluateDeviceIdentityTransition(revoked, device({ sequence: 4, lastSeenAt: "2026-07-25T11:30:00.000Z" })),
    (error) => error.code === "DEVICE_REVOKED"
  );
  assert.throws(
    () => evaluateDeviceIdentityTransition(device(), device({ deviceId: "device-b", sequence: 2 })),
    (error) => error.code === "DEVICE_IDENTITY_MISMATCH"
  );
  assert.throws(
    () => evaluateDeviceIdentityTransition(device(), device({ sequence: 3 })),
    (error) => error.code === "INVALID_INPUT"
  );
});

test("sync conflicts preserve both hashes and require an explicit next-revision resolution", () => {
  assert.equal(normalizeSyncConflict(conflict()).status, "open");
  for (const type of ["keep_local", "accept_remote", "manual_revision"]) {
    assert.equal(normalizeSyncConflict(resolvedConflict(type)).resolution.type, type);
  }
  for (const invalid of [
    conflict({ remoteBaseRevision: 5 }),
    conflict({ remotePayloadHash: LOCAL_HASH }),
    conflict({ payload: { sourcePath: "/must/not/sync.mp4" } }),
    conflict({ status: "resolved" }),
    resolvedConflict("keep_local", {
      resolution: {
        type: "keep_local",
        resolvedByUserId: "user-a",
        resolvedAt: "2026-07-25T11:00:00.000Z",
        revision: 6,
        payloadHash: REMOTE_HASH
      }
    }),
    resolvedConflict("manual_revision", {
      resolution: {
        type: "manual_revision",
        resolvedByUserId: "user-a",
        resolvedAt: "2026-07-25T11:00:00.000Z",
        revision: 7,
        payloadHash: MANUAL_HASH
      }
    })
  ]) {
    assert.throws(
      () => normalizeSyncConflict(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});

test("conflict transitions and authorization reject evidence replacement, repeat resolution, and actor mismatch", () => {
  const resolved = resolvedConflict();
  assert.equal(evaluateConflictTransition(conflict(), resolved).status, "apply");
  assert.equal(evaluateConflictTransition(resolved, resolved).status, "idempotent");
  assert.equal(authorizeConflictResolution(principal(), resolved, { now: NOW }).authorization.permission, "conflict_resolve");
  assert.throws(
    () => evaluateConflictTransition(conflict(), resolvedConflict("manual_revision", { localPayloadHash: REMOTE_HASH })),
    (error) => error.code === "SYNC_CONFLICT_MISMATCH" || error.code === "INVALID_INPUT"
  );
  assert.throws(
    () =>
      evaluateConflictTransition(
        resolved,
        resolvedConflict("keep_local", {
          resolution: {
            type: "keep_local",
            resolvedByUserId: "user-a",
            resolvedAt: "2026-07-25T11:05:00.000Z",
            revision: 6,
            payloadHash: LOCAL_HASH
          },
          sequence: 3
        })
      ),
    (error) => error.code === "SYNC_CONFLICT_RESOLVED"
  );
  assert.throws(
    () =>
      authorizeConflictResolution(
        principal(),
        resolvedConflict("manual_revision", {
          resolution: {
            type: "manual_revision",
            resolvedByUserId: "user-b",
            resolvedAt: "2026-07-25T11:00:00.000Z",
            revision: 6,
            payloadHash: MANUAL_HASH
          }
        }),
        { now: NOW }
      ),
    (error) => error.code === "COLLABORATION_FORBIDDEN"
  );
  assert.throws(
    () => authorizeConflictResolution(principal({ projectIds: ["project-b"] }), resolved, { now: NOW }),
    (error) => error.code === "COLLABORATION_FORBIDDEN"
  );
});

test("audit events retain safe identifiers and codes without raw operational data", () => {
  assert.deepEqual(normalizeAuditEvent(audit()), audit());
  assert.equal(
    normalizeAuditEvent(audit({ outcome: "conflict", action: "sync_conflict", reasonCode: "REVISION_MISMATCH" })).reasonCode,
    "REVISION_MISMATCH"
  );
  for (const invalid of [
    audit({ reasonCode: "UNEXPECTED" }),
    audit({ outcome: "failed" }),
    audit({ outcome: "failed", reasonCode: "raw provider failure" }),
    { ...audit(), stack: "secret stack" },
    { ...audit(), headers: { authorization: "secret" } },
    { ...audit(), payload: { sourcePath: "/must/not/log.mp4" } },
    { ...audit(), ipAddress: "192.0.2.1" }
  ]) {
    assert.throws(
      () => normalizeAuditEvent(invalid),
      (error) => error.code === "INVALID_INPUT"
    );
  }
});
