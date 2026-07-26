const { AppError } = require("../errors.cjs");
const { boundedInteger, boundedString, requireId } = require("../validation.cjs");

const COLLABORATION_PERMISSIONS = Object.freeze({
  PROJECT_READ: "project_read",
  PROJECT_EDIT: "project_edit",
  REVIEW_COMMENT: "review_comment",
  REVIEW_RESOLVE: "review_resolve",
  REVIEW_ASSIGN: "review_assign",
  CONFLICT_RESOLVE: "conflict_resolve",
  APPROVAL_DECIDE: "approval_decide",
  PUBLISHING_APPROVE: "publishing_approve",
  ANALYTICS_READ: "analytics_read",
  ORGANIZATION_EXPORT: "organization_export",
  ORGANIZATION_ADMIN: "organization_admin"
});

const ROLE_PERMISSIONS = Object.freeze({
  viewer: Object.freeze([COLLABORATION_PERMISSIONS.PROJECT_READ]),
  editor: Object.freeze([
    COLLABORATION_PERMISSIONS.PROJECT_READ,
    COLLABORATION_PERMISSIONS.PROJECT_EDIT,
    COLLABORATION_PERMISSIONS.REVIEW_COMMENT,
    COLLABORATION_PERMISSIONS.CONFLICT_RESOLVE
  ]),
  approver: Object.freeze([
    COLLABORATION_PERMISSIONS.PROJECT_READ,
    COLLABORATION_PERMISSIONS.REVIEW_COMMENT,
    COLLABORATION_PERMISSIONS.REVIEW_RESOLVE,
    COLLABORATION_PERMISSIONS.REVIEW_ASSIGN,
    COLLABORATION_PERMISSIONS.APPROVAL_DECIDE
  ]),
  publisher: Object.freeze([COLLABORATION_PERMISSIONS.PROJECT_READ, COLLABORATION_PERMISSIONS.PUBLISHING_APPROVE]),
  analyst: Object.freeze([COLLABORATION_PERMISSIONS.PROJECT_READ, COLLABORATION_PERMISSIONS.ANALYTICS_READ]),
  admin: Object.freeze(Object.values(COLLABORATION_PERMISSIONS))
});

const ALL_PERMISSIONS = new Set(Object.values(COLLABORATION_PERMISSIONS));
const ROLE_NAMES = new Set(Object.keys(ROLE_PERMISSIONS));
const SYNC_OPERATION_PERMISSIONS = Object.freeze({
  edit: COLLABORATION_PERMISSIONS.PROJECT_EDIT,
  comment: COLLABORATION_PERMISSIONS.REVIEW_COMMENT,
  resolve: COLLABORATION_PERMISSIONS.REVIEW_RESOLVE,
  resolve_conflict: COLLABORATION_PERMISSIONS.CONFLICT_RESOLVE,
  assign: COLLABORATION_PERMISSIONS.REVIEW_ASSIGN,
  approve: COLLABORATION_PERMISSIONS.APPROVAL_DECIDE,
  publish: COLLABORATION_PERMISSIONS.PUBLISHING_APPROVE
});
const SYNC_RESOURCE_OPERATIONS = Object.freeze({
  project: new Set(["edit"]),
  review: new Set(["comment", "resolve"]),
  conflict: new Set(["resolve_conflict"]),
  assignment: new Set(["assign"]),
  approval: new Set(["approve"]),
  publishing: new Set(["publish"])
});
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

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

function isoTimestamp(value, label, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const text = boundedString(value, { label, min: 1, max: 40 });
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return new Date(timestamp).toISOString();
}

function normalizePrincipal(raw) {
  const value = plainObject(raw, "Collaboration principal");
  onlyKeys(value, new Set(["organizationId", "userId", "roles", "projectIds", "expiresAt", "revokedAt"]), "Collaboration principal");
  if (!Array.isArray(value.roles) || !value.roles.length || value.roles.length > ROLE_NAMES.size) {
    throw new AppError("INVALID_INPUT", "Collaboration roles are invalid.");
  }
  const roles = [...new Set(value.roles)];
  if (roles.some((role) => typeof role !== "string" || !ROLE_NAMES.has(role))) {
    throw new AppError("INVALID_INPUT", "Collaboration roles are invalid.");
  }
  if (!Object.hasOwn(value, "projectIds") || (value.projectIds !== null && !Array.isArray(value.projectIds))) {
    throw new AppError("INVALID_INPUT", "Collaboration project scope is invalid.");
  }
  if (value.projectIds?.length > 500) {
    throw new AppError("INVALID_INPUT", "Collaboration project scope is too large.");
  }
  const projectIds = value.projectIds === null ? null : [...new Set(value.projectIds.map((projectId) => requireId(projectId, "Project")))];
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    userId: requireId(value.userId, "User"),
    roles,
    projectIds,
    expiresAt: isoTimestamp(value.expiresAt, "Collaboration expiry"),
    revokedAt: isoTimestamp(value.revokedAt, "Collaboration revocation", true)
  };
}

function assertCollaborationPermission(rawPrincipal, permission, rawTarget, options = {}) {
  if (!ALL_PERMISSIONS.has(permission)) throw new AppError("INVALID_INPUT", "Collaboration permission is invalid.");
  const principal = normalizePrincipal(rawPrincipal);
  const target = plainObject(rawTarget, "Collaboration target");
  onlyKeys(target, new Set(["organizationId", "projectId"]), "Collaboration target");
  const organizationId = requireId(target.organizationId, "Organization");
  const projectId = target.projectId ? requireId(target.projectId, "Project") : null;
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();

  if (principal.revokedAt) {
    throw new AppError("COLLABORATION_REVOKED", "This collaboration access has been revoked.");
  }
  if (Date.parse(principal.expiresAt) <= now.getTime()) {
    throw new AppError("COLLABORATION_EXPIRED", "This collaboration access has expired.");
  }
  if (principal.organizationId !== organizationId) {
    throw new AppError("COLLABORATION_FORBIDDEN", "This collaboration access does not include the requested organization.");
  }
  if (projectId && principal.projectIds && !principal.projectIds.includes(projectId)) {
    throw new AppError("COLLABORATION_FORBIDDEN", "This collaboration access does not include the requested project.");
  }
  const permissions = new Set(principal.roles.flatMap((role) => ROLE_PERMISSIONS[role]));
  if (!permissions.has(permission)) {
    throw new AppError("COLLABORATION_FORBIDDEN", "This collaboration role does not allow the requested action.");
  }
  return {
    organizationId,
    projectId,
    userId: principal.userId,
    permission
  };
}

function normalizeSyncEnvelope(raw) {
  const value = plainObject(raw, "Sync envelope");
  onlyKeys(
    value,
    new Set([
      "organizationId",
      "projectId",
      "resourceType",
      "resourceId",
      "operation",
      "baseRevision",
      "revision",
      "mutationId",
      "deviceId",
      "occurredAt",
      "payloadHash"
    ]),
    "Sync envelope"
  );
  const resourceType = boundedString(value.resourceType, { label: "Sync resource type", min: 1, max: 40 });
  const operation = boundedString(value.operation, { label: "Sync operation", min: 1, max: 40 });
  if (!SYNC_RESOURCE_OPERATIONS[resourceType]?.has(operation)) {
    throw new AppError("INVALID_INPUT", "Sync resource and operation are incompatible.");
  }
  const baseRevision = boundedInteger(value.baseRevision, {
    label: "Base revision",
    min: 0,
    max: 2_147_483_646
  });
  const revision = boundedInteger(value.revision, {
    label: "Revision",
    min: 1,
    max: 2_147_483_647
  });
  if (revision !== baseRevision + 1) {
    throw new AppError("INVALID_INPUT", "Sync revision must follow its base revision.");
  }
  const payloadHash = boundedString(value.payloadHash, { label: "Sync payload hash", min: 71, max: 71 });
  if (!HASH_PATTERN.test(payloadHash)) throw new AppError("INVALID_INPUT", "Sync payload hash is invalid.");
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    projectId: requireId(value.projectId, "Project"),
    resourceType,
    resourceId: requireId(value.resourceId, "Sync resource"),
    operation,
    baseRevision,
    revision,
    mutationId: requireId(value.mutationId, "Sync mutation"),
    deviceId: requireId(value.deviceId, "Device"),
    occurredAt: isoTimestamp(value.occurredAt, "Sync timestamp"),
    payloadHash
  };
}

function authorizeSyncEnvelope(rawPrincipal, rawEnvelope, options = {}) {
  const envelope = normalizeSyncEnvelope(rawEnvelope);
  return assertCollaborationPermission(
    rawPrincipal,
    SYNC_OPERATION_PERMISSIONS[envelope.operation],
    { organizationId: envelope.organizationId, projectId: envelope.projectId },
    options
  );
}

function evaluateSyncEnvelope(rawEnvelope, rawCurrent) {
  const envelope = normalizeSyncEnvelope(rawEnvelope);
  const current = plainObject(rawCurrent, "Current sync state");
  onlyKeys(
    current,
    new Set(["organizationId", "projectId", "resourceType", "resourceId", "revision", "seenMutationIds"]),
    "Current sync state"
  );
  const currentRevision = boundedInteger(current.revision, {
    label: "Current revision",
    min: 0,
    max: 2_147_483_647
  });
  if (
    requireId(current.organizationId, "Organization") !== envelope.organizationId ||
    requireId(current.projectId, "Project") !== envelope.projectId ||
    boundedString(current.resourceType, { label: "Sync resource type", min: 1, max: 40 }) !== envelope.resourceType ||
    requireId(current.resourceId, "Sync resource") !== envelope.resourceId
  ) {
    throw new AppError("SYNC_TARGET_MISMATCH", "The sync envelope does not match the current resource.");
  }
  if (!Array.isArray(current.seenMutationIds) || current.seenMutationIds.length > 1000) {
    throw new AppError("INVALID_INPUT", "Seen sync mutations are invalid.");
  }
  const seenMutationIds = new Set(current.seenMutationIds.map((mutationId) => requireId(mutationId, "Sync mutation")));
  if (seenMutationIds.has(envelope.mutationId)) {
    return { status: "idempotent", mutationId: envelope.mutationId, currentRevision };
  }
  if (envelope.baseRevision !== currentRevision) {
    return {
      status: "conflict",
      reason: "revision_mismatch",
      mutationId: envelope.mutationId,
      currentRevision,
      incomingBaseRevision: envelope.baseRevision
    };
  }
  return {
    status: "apply",
    mutationId: envelope.mutationId,
    currentRevision,
    nextRevision: envelope.revision,
    payloadHash: envelope.payloadHash
  };
}

module.exports = {
  COLLABORATION_PERMISSIONS,
  ROLE_PERMISSIONS,
  assertCollaborationPermission,
  authorizeSyncEnvelope,
  evaluateSyncEnvelope,
  normalizePrincipal,
  normalizeSyncEnvelope
};
