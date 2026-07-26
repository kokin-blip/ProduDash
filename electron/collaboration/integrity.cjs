const { AppError } = require("../errors.cjs");
const { boundedInteger, boundedString, requireId } = require("../validation.cjs");
const { COLLABORATION_PERMISSIONS, assertCollaborationPermission } = require("./contracts.cjs");

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DEVICE_PLATFORMS = new Set(["macos", "windows", "linux"]);
const DEVICE_ARCHITECTURES = new Set(["arm64", "x64"]);
const DEVICE_STATUSES = new Set(["active", "revoked"]);
const CONFLICT_RESOURCE_TYPES = new Set(["project", "review", "assignment", "approval", "publishing"]);
const CONFLICT_RESOLUTIONS = new Set(["keep_local", "accept_remote", "manual_revision"]);
const AUDIT_ACTOR_TYPES = new Set(["user", "system"]);
const AUDIT_OUTCOMES = new Set(["succeeded", "denied", "conflict", "failed"]);
const AUDIT_ACTIONS = new Set([
  "project_edit",
  "review_create",
  "review_comment",
  "review_resolve",
  "assignment_create",
  "approval_decide",
  "publishing_approve",
  "analytics_read",
  "organization_export",
  "access_revoke",
  "device_register",
  "device_revoke",
  "sync_apply",
  "sync_conflict",
  "conflict_resolve"
]);
const AUDIT_RESOURCE_TYPES = new Set([
  "project",
  "review",
  "assignment",
  "approval",
  "publishing",
  "analytics",
  "organization_export",
  "access_grant",
  "device",
  "sync_conflict"
]);

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  }
  return value;
}

function onlyKeys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AppError("INVALID_INPUT", `${label} contains unsupported fields.`);
  }
}

function oneOf(value, allowed, label) {
  const result = boundedString(value, { label, min: 1, max: 40 });
  if (!allowed.has(result)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return result;
}

function isoTimestamp(value, label, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const text = boundedString(value, { label, min: 1, max: 40 });
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return new Date(timestamp).toISOString();
}

function timestampNotBefore(value, label, earliest, nullable = false) {
  const timestamp = isoTimestamp(value, label, nullable);
  if (timestamp && Date.parse(timestamp) < Date.parse(earliest)) {
    throw new AppError("INVALID_INPUT", `${label} is earlier than its allowed boundary.`);
  }
  return timestamp;
}

function hash(value, label) {
  const result = boundedString(value, { label, min: 71, max: 71 });
  if (!HASH_PATTERN.test(result)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return result;
}

function safeCode(value, label, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const result = boundedString(value, { label, min: 1, max: 80 });
  if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(result)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return result;
}

function normalizeDeviceIdentity(raw) {
  const value = plainObject(raw, "Device identity");
  onlyKeys(
    value,
    new Set([
      "organizationId",
      "userId",
      "deviceId",
      "label",
      "platform",
      "architecture",
      "publicKeyFingerprint",
      "status",
      "registeredAt",
      "lastSeenAt",
      "revokedAt",
      "sequence"
    ]),
    "Device identity"
  );
  const status = oneOf(value.status, DEVICE_STATUSES, "Device status");
  const registeredAt = isoTimestamp(value.registeredAt, "Device registration time");
  const lastSeenAt = timestampNotBefore(value.lastSeenAt, "Device last-seen time", registeredAt);
  const revokedAt = timestampNotBefore(value.revokedAt, "Device revocation time", lastSeenAt, true);
  if ((status === "revoked") !== Boolean(revokedAt)) {
    throw new AppError("INVALID_INPUT", "Revoked devices require a revocation time and active devices cannot include one.");
  }
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    userId: requireId(value.userId, "User"),
    deviceId: requireId(value.deviceId, "Device"),
    label: boundedString(value.label, { label: "Device label", min: 1, max: 80 }),
    labelFormat: "plain_text",
    platform: oneOf(value.platform, DEVICE_PLATFORMS, "Device platform"),
    architecture: oneOf(value.architecture, DEVICE_ARCHITECTURES, "Device architecture"),
    publicKeyFingerprint: hash(value.publicKeyFingerprint, "Device public-key fingerprint"),
    status,
    registeredAt,
    lastSeenAt,
    revokedAt,
    sequence: boundedInteger(value.sequence, { label: "Device sequence", min: 1, max: 2_147_483_647 })
  };
}

function evaluateDeviceIdentityTransition(rawCurrent, rawNext) {
  const current = normalizeDeviceIdentity(rawCurrent);
  const next = normalizeDeviceIdentity(rawNext);
  if (JSON.stringify(current) === JSON.stringify(next)) return { status: "idempotent", device: current };
  for (const field of ["organizationId", "userId", "deviceId", "platform", "architecture", "publicKeyFingerprint", "registeredAt"]) {
    if (current[field] !== next[field]) throw new AppError("DEVICE_IDENTITY_MISMATCH", "Device identity fields cannot be replaced.");
  }
  if (current.status === "revoked") throw new AppError("DEVICE_REVOKED", "A revoked device cannot be changed or reactivated.");
  if (next.sequence !== current.sequence + 1) {
    throw new AppError("INVALID_INPUT", "Device transitions require the next consecutive sequence.");
  }
  if (Date.parse(next.lastSeenAt) < Date.parse(current.lastSeenAt)) {
    throw new AppError("INVALID_INPUT", "Device last-seen time cannot move backward.");
  }
  return { status: "apply", device: next };
}

function authorizeDeviceRegistration(rawPrincipal, rawDevice, options = {}) {
  const device = normalizeDeviceIdentity(rawDevice);
  if (device.status !== "active" || device.sequence !== 1) {
    throw new AppError("INVALID_INPUT", "New device identities must start active at sequence one.");
  }
  const authorization = assertCollaborationPermission(
    rawPrincipal,
    COLLABORATION_PERMISSIONS.PROJECT_READ,
    { organizationId: device.organizationId, projectId: null },
    options
  );
  if (device.userId !== authorization.userId) {
    throw new AppError("COLLABORATION_FORBIDDEN", "The device owner does not match the authenticated user.");
  }
  return { authorization, device };
}

function normalizeConflictResolution(value, conflict) {
  if (value === null || value === undefined) return null;
  const resolution = plainObject(value, "Conflict resolution");
  onlyKeys(resolution, new Set(["type", "resolvedByUserId", "resolvedAt", "revision", "payloadHash"]), "Conflict resolution");
  const type = oneOf(resolution.type, CONFLICT_RESOLUTIONS, "Conflict resolution type");
  const payloadHash = hash(resolution.payloadHash, "Conflict resolution payload hash");
  if (type === "keep_local" && payloadHash !== conflict.localPayloadHash) {
    throw new AppError("INVALID_INPUT", "Keep-local resolution must reference the local payload hash.");
  }
  if (type === "accept_remote" && payloadHash !== conflict.remotePayloadHash) {
    throw new AppError("INVALID_INPUT", "Accept-remote resolution must reference the remote payload hash.");
  }
  const expectedRevision = Math.max(conflict.localRevision, conflict.remoteRevision) + 1;
  const revision = boundedInteger(resolution.revision, {
    label: "Conflict resolution revision",
    min: 1,
    max: 2_147_483_647
  });
  if (revision !== expectedRevision) {
    throw new AppError("INVALID_INPUT", "Conflict resolution must create the next revision after both competing revisions.");
  }
  return {
    type,
    resolvedByUserId: requireId(resolution.resolvedByUserId, "Conflict resolver"),
    resolvedAt: timestampNotBefore(resolution.resolvedAt, "Conflict resolution time", conflict.detectedAt),
    revision,
    payloadHash
  };
}

function normalizeSyncConflict(raw) {
  const value = plainObject(raw, "Sync conflict");
  onlyKeys(
    value,
    new Set([
      "organizationId",
      "projectId",
      "conflictId",
      "resourceType",
      "resourceId",
      "localRevision",
      "remoteBaseRevision",
      "remoteRevision",
      "localPayloadHash",
      "remotePayloadHash",
      "detectedAt",
      "status",
      "resolution",
      "sequence"
    ]),
    "Sync conflict"
  );
  const localRevision = boundedInteger(value.localRevision, {
    label: "Local conflict revision",
    min: 0,
    max: 2_147_483_646
  });
  const remoteBaseRevision = boundedInteger(value.remoteBaseRevision, {
    label: "Remote base revision",
    min: 0,
    max: 2_147_483_646
  });
  const remoteRevision = boundedInteger(value.remoteRevision, {
    label: "Remote conflict revision",
    min: 1,
    max: 2_147_483_646
  });
  if (remoteRevision !== remoteBaseRevision + 1 || remoteBaseRevision === localRevision) {
    throw new AppError("INVALID_INPUT", "Sync conflict revisions do not describe a divergent change.");
  }
  const conflict = {
    organizationId: requireId(value.organizationId, "Organization"),
    projectId: requireId(value.projectId, "Project"),
    conflictId: requireId(value.conflictId, "Sync conflict"),
    resourceType: oneOf(value.resourceType, CONFLICT_RESOURCE_TYPES, "Conflict resource type"),
    resourceId: requireId(value.resourceId, "Conflict resource"),
    localRevision,
    remoteBaseRevision,
    remoteRevision,
    localPayloadHash: hash(value.localPayloadHash, "Local conflict payload hash"),
    remotePayloadHash: hash(value.remotePayloadHash, "Remote conflict payload hash"),
    detectedAt: isoTimestamp(value.detectedAt, "Conflict detection time")
  };
  if (conflict.localPayloadHash === conflict.remotePayloadHash) {
    throw new AppError("INVALID_INPUT", "A sync conflict requires different payload hashes.");
  }
  const status = oneOf(value.status, new Set(["open", "resolved"]), "Conflict status");
  const resolution = normalizeConflictResolution(value.resolution, conflict);
  if ((status === "resolved") !== Boolean(resolution)) {
    throw new AppError("INVALID_INPUT", "Resolved conflicts require a resolution and open conflicts cannot include one.");
  }
  return {
    ...conflict,
    status,
    resolution,
    sequence: boundedInteger(value.sequence, { label: "Conflict sequence", min: 1, max: 2_147_483_647 })
  };
}

function evaluateConflictTransition(rawCurrent, rawNext) {
  const current = normalizeSyncConflict(rawCurrent);
  const next = normalizeSyncConflict(rawNext);
  if (JSON.stringify(current) === JSON.stringify(next)) return { status: "idempotent", conflict: current };
  for (const field of [
    "organizationId",
    "projectId",
    "conflictId",
    "resourceType",
    "resourceId",
    "localRevision",
    "remoteBaseRevision",
    "remoteRevision",
    "localPayloadHash",
    "remotePayloadHash",
    "detectedAt"
  ]) {
    if (current[field] !== next[field]) throw new AppError("SYNC_CONFLICT_MISMATCH", "Sync conflict evidence cannot be replaced.");
  }
  if (current.status === "resolved") throw new AppError("SYNC_CONFLICT_RESOLVED", "A resolved sync conflict cannot be changed.");
  if (next.status !== "resolved" || next.sequence !== current.sequence + 1) {
    throw new AppError("INVALID_INPUT", "An open conflict can only transition to the next resolved sequence.");
  }
  return { status: "apply", conflict: next };
}

function authorizeConflictResolution(rawPrincipal, rawConflict, options = {}) {
  const conflict = normalizeSyncConflict(rawConflict);
  if (conflict.status !== "resolved") throw new AppError("INVALID_INPUT", "Only a resolved conflict can complete this action.");
  const authorization = assertCollaborationPermission(
    rawPrincipal,
    COLLABORATION_PERMISSIONS.CONFLICT_RESOLVE,
    { organizationId: conflict.organizationId, projectId: conflict.projectId },
    options
  );
  if (conflict.resolution.resolvedByUserId !== authorization.userId) {
    throw new AppError("COLLABORATION_FORBIDDEN", "The conflict resolver does not match the authenticated user.");
  }
  return { authorization, conflict };
}

function normalizeAuditEvent(raw) {
  const value = plainObject(raw, "Collaboration audit event");
  onlyKeys(
    value,
    new Set([
      "organizationId",
      "eventId",
      "sequence",
      "actorType",
      "actorId",
      "action",
      "outcome",
      "projectId",
      "resourceType",
      "resourceId",
      "occurredAt",
      "requestId",
      "deviceId",
      "mutationId",
      "reasonCode"
    ]),
    "Collaboration audit event"
  );
  const outcome = oneOf(value.outcome, AUDIT_OUTCOMES, "Audit outcome");
  const reasonCode = safeCode(value.reasonCode, "Audit reason code", true);
  if ((outcome === "succeeded") === Boolean(reasonCode)) {
    throw new AppError("INVALID_INPUT", "Failed, denied, or conflicting audit outcomes require a safe reason code.");
  }
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    eventId: requireId(value.eventId, "Audit event"),
    sequence: boundedInteger(value.sequence, { label: "Audit sequence", min: 1, max: 2_147_483_647 }),
    actorType: oneOf(value.actorType, AUDIT_ACTOR_TYPES, "Audit actor type"),
    actorId: requireId(value.actorId, "Audit actor"),
    action: oneOf(value.action, AUDIT_ACTIONS, "Audit action"),
    outcome,
    projectId: value.projectId ? requireId(value.projectId, "Project") : null,
    resourceType: oneOf(value.resourceType, AUDIT_RESOURCE_TYPES, "Audit resource type"),
    resourceId: requireId(value.resourceId, "Audit resource"),
    occurredAt: isoTimestamp(value.occurredAt, "Audit event time"),
    requestId: requireId(value.requestId, "Audit request"),
    deviceId: value.deviceId ? requireId(value.deviceId, "Device") : null,
    mutationId: value.mutationId ? requireId(value.mutationId, "Sync mutation") : null,
    reasonCode
  };
}

module.exports = {
  authorizeConflictResolution,
  authorizeDeviceRegistration,
  evaluateConflictTransition,
  evaluateDeviceIdentityTransition,
  normalizeAuditEvent,
  normalizeDeviceIdentity,
  normalizeSyncConflict
};
