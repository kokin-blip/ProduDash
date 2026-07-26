const { AppError } = require("../errors.cjs");
const { boundedInteger, boundedString, requireId } = require("../validation.cjs");
const { COLLABORATION_PERMISSIONS, assertCollaborationPermission } = require("./contracts.cjs");

const REVIEW_RESOURCE_TYPES = new Set(["project_revision", "media_candidate", "publishing_package"]);
const REVIEW_STATUSES = new Set(["open", "resolved"]);
const ASSIGNMENT_STATUSES = new Set(["active", "completed", "canceled"]);
const REVOCATION_SUBJECT_TYPES = new Set(["user", "device", "session", "access_grant"]);
const REVOCATION_REASONS = new Set([
  "membership_removed",
  "role_changed",
  "device_lost",
  "session_ended",
  "security_response",
  "owner_request"
]);
const EXPORT_STATUSES = new Set(["requested", "preparing", "ready", "failed", "expired"]);
const EXPORT_RESOURCE_TYPES = Object.freeze(["projects", "reviews", "assignments", "approvals", "publishing", "analytics", "audit"]);
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

function orderedTimestamp(value, label, earliest, nullable = false) {
  const timestamp = isoTimestamp(value, label, nullable);
  if (timestamp && Date.parse(timestamp) < Date.parse(earliest)) {
    throw new AppError("INVALID_INPUT", `${label} cannot be earlier than the record creation time.`);
  }
  return timestamp;
}

function normalizeIdList(value, label, max) {
  if (!Array.isArray(value) || value.length > max) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return [...new Set(value.map((item) => requireId(item, label)))];
}

function normalizeReviewThread(raw) {
  const value = plainObject(raw, "Review thread");
  onlyKeys(
    value,
    new Set([
      "organizationId",
      "projectId",
      "reviewId",
      "resourceType",
      "resourceId",
      "title",
      "status",
      "createdByUserId",
      "createdAt",
      "resolvedAt",
      "revision"
    ]),
    "Review thread"
  );
  const status = oneOf(value.status, REVIEW_STATUSES, "Review status");
  const createdAt = isoTimestamp(value.createdAt, "Review creation time");
  const resolvedAt = orderedTimestamp(value.resolvedAt, "Review resolution time", createdAt, true);
  if ((status === "resolved") !== Boolean(resolvedAt)) {
    throw new AppError("INVALID_INPUT", "Resolved reviews require a resolution time and open reviews cannot include one.");
  }
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    projectId: requireId(value.projectId, "Project"),
    reviewId: requireId(value.reviewId, "Review"),
    resourceType: oneOf(value.resourceType, REVIEW_RESOURCE_TYPES, "Review resource type"),
    resourceId: requireId(value.resourceId, "Review resource"),
    title: boundedString(value.title, { label: "Review title", min: 1, max: 120 }),
    status,
    createdByUserId: requireId(value.createdByUserId, "Review creator"),
    createdAt,
    resolvedAt,
    revision: boundedInteger(value.revision, { label: "Review revision", min: 1, max: 2_147_483_647 })
  };
}

function normalizeReviewComment(raw) {
  const value = plainObject(raw, "Review comment");
  onlyKeys(
    value,
    new Set(["organizationId", "projectId", "reviewId", "commentId", "authorUserId", "body", "mentionUserIds", "createdAt", "editedAt"]),
    "Review comment"
  );
  const createdAt = isoTimestamp(value.createdAt, "Comment creation time");
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    projectId: requireId(value.projectId, "Project"),
    reviewId: requireId(value.reviewId, "Review"),
    commentId: requireId(value.commentId, "Comment"),
    authorUserId: requireId(value.authorUserId, "Comment author"),
    body: boundedString(value.body, { label: "Comment", min: 1, max: 4000 }),
    bodyFormat: "plain_text",
    mentionUserIds: normalizeIdList(value.mentionUserIds || [], "Mentioned user", 20),
    createdAt,
    editedAt: orderedTimestamp(value.editedAt, "Comment edit time", createdAt, true)
  };
}

function normalizeReviewAssignment(raw) {
  const value = plainObject(raw, "Review assignment");
  onlyKeys(
    value,
    new Set([
      "organizationId",
      "projectId",
      "reviewId",
      "assignmentId",
      "assigneeUserId",
      "assignedByUserId",
      "status",
      "createdAt",
      "dueAt",
      "closedAt"
    ]),
    "Review assignment"
  );
  const status = oneOf(value.status, ASSIGNMENT_STATUSES, "Assignment status");
  const createdAt = isoTimestamp(value.createdAt, "Assignment creation time");
  const dueAt = orderedTimestamp(value.dueAt, "Assignment due time", createdAt, true);
  const closedAt = orderedTimestamp(value.closedAt, "Assignment closure time", createdAt, true);
  if ((status === "active") === Boolean(closedAt)) {
    throw new AppError("INVALID_INPUT", "Closed assignments require a closure time and active assignments cannot include one.");
  }
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    projectId: requireId(value.projectId, "Project"),
    reviewId: requireId(value.reviewId, "Review"),
    assignmentId: requireId(value.assignmentId, "Assignment"),
    assigneeUserId: requireId(value.assigneeUserId, "Assignee"),
    assignedByUserId: requireId(value.assignedByUserId, "Assignment creator"),
    status,
    createdAt,
    dueAt,
    closedAt
  };
}

function normalizeRevocationRecord(raw) {
  const value = plainObject(raw, "Revocation record");
  onlyKeys(
    value,
    new Set([
      "organizationId",
      "revocationId",
      "subjectType",
      "subjectId",
      "revokedByUserId",
      "reason",
      "createdAt",
      "effectiveAt",
      "sequence"
    ]),
    "Revocation record"
  );
  const createdAt = isoTimestamp(value.createdAt, "Revocation creation time");
  const effectiveAt = isoTimestamp(value.effectiveAt, "Revocation effective time");
  if (Date.parse(effectiveAt) > Date.parse(createdAt)) {
    throw new AppError("INVALID_INPUT", "Revocation cannot take effect after it is recorded.");
  }
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    revocationId: requireId(value.revocationId, "Revocation"),
    subjectType: oneOf(value.subjectType, REVOCATION_SUBJECT_TYPES, "Revocation subject type"),
    subjectId: requireId(value.subjectId, "Revocation subject"),
    revokedByUserId: requireId(value.revokedByUserId, "Revoking user"),
    reason: oneOf(value.reason, REVOCATION_REASONS, "Revocation reason"),
    createdAt,
    effectiveAt,
    sequence: boundedInteger(value.sequence, { label: "Revocation sequence", min: 1, max: 2_147_483_647 })
  };
}

function normalizeRecordCounts(value) {
  if (value === null || value === undefined) return null;
  const counts = plainObject(value, "Export record counts");
  onlyKeys(counts, new Set(EXPORT_RESOURCE_TYPES), "Export record counts");
  if (EXPORT_RESOURCE_TYPES.some((resourceType) => !Object.hasOwn(counts, resourceType))) {
    throw new AppError("INVALID_INPUT", "Export record counts are incomplete.");
  }
  return Object.fromEntries(
    EXPORT_RESOURCE_TYPES.map((resourceType) => [
      resourceType,
      boundedInteger(counts[resourceType], { label: `${resourceType} export count`, min: 0, max: 100_000_000 })
    ])
  );
}

function normalizeOrganizationExportManifest(raw) {
  const value = plainObject(raw, "Organization export manifest");
  onlyKeys(
    value,
    new Set([
      "organizationId",
      "exportId",
      "requestedByUserId",
      "status",
      "resourceTypes",
      "recordCounts",
      "artifactId",
      "artifactHash",
      "requestedAt",
      "updatedAt",
      "expiresAt",
      "failureCode"
    ]),
    "Organization export manifest"
  );
  if (!Array.isArray(value.resourceTypes) || value.resourceTypes.length !== EXPORT_RESOURCE_TYPES.length) {
    throw new AppError("INVALID_INPUT", "Organization exports must include every supported resource type.");
  }
  const resourceTypes = [...new Set(value.resourceTypes)];
  if (resourceTypes.length !== EXPORT_RESOURCE_TYPES.length || EXPORT_RESOURCE_TYPES.some((item) => !resourceTypes.includes(item))) {
    throw new AppError("INVALID_INPUT", "Organization exports must include every supported resource type.");
  }
  const status = oneOf(value.status, EXPORT_STATUSES, "Export status");
  const requestedAt = isoTimestamp(value.requestedAt, "Export request time");
  const updatedAt = orderedTimestamp(value.updatedAt, "Export update time", requestedAt);
  const expiresAt = orderedTimestamp(value.expiresAt, "Export expiry time", updatedAt, true);
  const artifactId = value.artifactId ? requireId(value.artifactId, "Export artifact") : null;
  const artifactHash = value.artifactHash ? boundedString(value.artifactHash, { label: "Export artifact hash", min: 71, max: 71 }) : null;
  if (artifactHash && !HASH_PATTERN.test(artifactHash)) throw new AppError("INVALID_INPUT", "Export artifact hash is invalid.");
  const recordCounts = normalizeRecordCounts(value.recordCounts);
  const failureCode = value.failureCode ? boundedString(value.failureCode, { label: "Export failure code", min: 1, max: 80 }) : null;
  if (failureCode && !/^[A-Z][A-Z0-9_]{0,79}$/.test(failureCode)) {
    throw new AppError("INVALID_INPUT", "Export failure code is invalid.");
  }
  if (status === "ready" && (!artifactId || !artifactHash || !recordCounts || !expiresAt)) {
    throw new AppError("INVALID_INPUT", "Ready exports require an opaque artifact, checksum, record counts, and expiry.");
  }
  if (status !== "ready" && (artifactId || artifactHash || expiresAt)) {
    throw new AppError("INVALID_INPUT", "Only ready exports can reference a downloadable artifact.");
  }
  if ((status === "failed") !== Boolean(failureCode)) {
    throw new AppError("INVALID_INPUT", "Only failed exports can include a failure code.");
  }
  return {
    organizationId: requireId(value.organizationId, "Organization"),
    exportId: requireId(value.exportId, "Organization export"),
    requestedByUserId: requireId(value.requestedByUserId, "Export requester"),
    status,
    resourceTypes: [...EXPORT_RESOURCE_TYPES],
    recordCounts,
    artifactId,
    artifactHash,
    requestedAt,
    updatedAt,
    expiresAt,
    failureCode
  };
}

function authorizeCollaborationRecordAction(rawPrincipal, action, rawRecord, options = {}) {
  let record;
  let permission;
  let actorField;
  let projectId = null;
  if (action === "create_review") {
    record = normalizeReviewThread(rawRecord);
    if (record.status !== "open" || record.revision !== 1) {
      throw new AppError("INVALID_INPUT", "New reviews must start open at revision one.");
    }
    permission = COLLABORATION_PERMISSIONS.REVIEW_COMMENT;
    actorField = "createdByUserId";
    projectId = record.projectId;
  } else if (action === "create_comment") {
    record = normalizeReviewComment(rawRecord);
    permission = COLLABORATION_PERMISSIONS.REVIEW_COMMENT;
    actorField = "authorUserId";
    projectId = record.projectId;
  } else if (action === "create_assignment") {
    record = normalizeReviewAssignment(rawRecord);
    if (record.status !== "active") throw new AppError("INVALID_INPUT", "New assignments must start active.");
    permission = COLLABORATION_PERMISSIONS.REVIEW_ASSIGN;
    actorField = "assignedByUserId";
    projectId = record.projectId;
  } else if (action === "resolve_review") {
    record = normalizeReviewThread(rawRecord);
    if (record.status !== "resolved") throw new AppError("INVALID_INPUT", "Only a resolved review can complete this action.");
    permission = COLLABORATION_PERMISSIONS.REVIEW_RESOLVE;
    projectId = record.projectId;
  } else if (action === "request_export") {
    record = normalizeOrganizationExportManifest(rawRecord);
    if (record.status !== "requested") throw new AppError("INVALID_INPUT", "New organization exports must start requested.");
    permission = COLLABORATION_PERMISSIONS.ORGANIZATION_EXPORT;
    actorField = "requestedByUserId";
  } else if (action === "revoke_access") {
    record = normalizeRevocationRecord(rawRecord);
    permission = COLLABORATION_PERMISSIONS.ORGANIZATION_ADMIN;
    actorField = "revokedByUserId";
  } else {
    throw new AppError("INVALID_INPUT", "Collaboration record action is invalid.");
  }
  const authorization = assertCollaborationPermission(
    rawPrincipal,
    permission,
    { organizationId: record.organizationId, projectId },
    options
  );
  if (actorField && record[actorField] !== authorization.userId) {
    throw new AppError("COLLABORATION_FORBIDDEN", "The collaboration record actor does not match the authenticated user.");
  }
  return { authorization, record };
}

module.exports = {
  EXPORT_RESOURCE_TYPES,
  authorizeCollaborationRecordAction,
  normalizeOrganizationExportManifest,
  normalizeReviewAssignment,
  normalizeReviewComment,
  normalizeReviewThread,
  normalizeRevocationRecord
};
