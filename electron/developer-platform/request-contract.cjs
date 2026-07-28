const { AppError } = require("../errors.cjs");
const { boundedInteger, boundedString, normalizePlatforms, requireId } = require("../validation.cjs");
const { EXPORT_RESOURCE_TYPES } = require("../collaboration/records.cjs");
const { OPERATION_DEFINITIONS } = require("./api-contract.cjs");
const { WEBHOOK_EVENT_TYPES, normalizeWebhookUrl } = require("./webhook-contract.cjs");
const { creatorPlatformIdList } = require("../platforms/registry.cjs");

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HASH_SCHEMA_PATTERN = "^sha256:[a-f0-9]{64}$";
const ID_SCHEMA_PATTERN = "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$";
const MAX_REVISION = 2_147_483_647;

const REQUEST_SCHEMA_BY_OPERATION = Object.freeze({
  "projects:create": "ProjectCreateRequest",
  "projects:update": "ProjectUpdateRequest",
  "jobs:create": "JobCreateRequest",
  "jobs:cancel": "EmptyMutationRequest",
  "jobs:retry": "EmptyMutationRequest",
  "approvals:decide": "ApprovalDecisionRequest",
  "publishing:approve": "PublishingApprovalRequest",
  "organization_exports:create": "OrganizationExportRequest",
  "webhooks:create": "WebhookCreateRequest",
  "webhooks:update": "WebhookUpdateRequest",
  "webhooks:delete": "WebhookDeleteRequest"
});

function idSchema() {
  return { type: "string", minLength: 1, maxLength: 128, pattern: ID_SCHEMA_PATTERN };
}

function nullable(schema) {
  return { oneOf: [schema, { type: "null" }] };
}

function timestampSchema() {
  return { type: "string", format: "date-time", maxLength: 40 };
}

function strictObject(properties, required = Object.keys(properties), additions = {}) {
  return { type: "object", additionalProperties: false, properties, required, ...additions };
}

function platformListSchema() {
  const platformIds = creatorPlatformIdList();
  return {
    type: "array",
    maxItems: platformIds.length,
    uniqueItems: true,
    items: { type: "string", enum: platformIds }
  };
}

function tagListSchema() {
  return {
    type: "array",
    maxItems: 20,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 40 }
  };
}

function webhookEventListSchema() {
  return {
    type: "array",
    minItems: 1,
    maxItems: WEBHOOK_EVENT_TYPES.length,
    uniqueItems: true,
    items: { type: "string", enum: [...WEBHOOK_EVENT_TYPES] }
  };
}

function mutationRequestSchemas() {
  const projectMetadata = {
    title: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: "string", maxLength: 1000 },
    businessId: nullable(idSchema()),
    tags: tagListSchema(),
    collectionId: nullable(idSchema()),
    platforms: platformListSchema(),
    desiredLengths: {
      type: "array",
      maxItems: 5,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 40 }
    },
    instructions: { type: "string", maxLength: 2000 }
  };
  const webhookFields = {
    url: { type: "string", format: "uri", minLength: 1, maxLength: 2048 },
    eventTypes: webhookEventListSchema(),
    status: { type: "string", enum: ["active", "paused"] }
  };
  return {
    ProjectCreateRequest: strictObject(
      {
        sourceMediaId: idSchema(),
        ...projectMetadata
      },
      ["sourceMediaId", "title"]
    ),
    ProjectUpdateRequest: strictObject(
      {
        expectedRevision: { type: "integer", minimum: 1, maximum: MAX_REVISION },
        ...projectMetadata,
        favorite: { type: "boolean" }
      },
      ["expectedRevision"],
      {
        anyOf: Object.keys(projectMetadata)
          .concat("favorite")
          .map((field) => ({ required: [field] }))
      }
    ),
    JobCreateRequest: {
      oneOf: [
        strictObject(
          {
            jobType: { const: "project_prepare" },
            projectRevision: { type: "integer", minimum: 1, maximum: MAX_REVISION }
          },
          ["jobType", "projectRevision"]
        ),
        strictObject(
          {
            jobType: { const: "project_render" },
            projectRevision: { type: "integer", minimum: 1, maximum: MAX_REVISION },
            renderPlanHash: { type: "string", minLength: 71, maxLength: 71, pattern: HASH_SCHEMA_PATTERN },
            approvalId: idSchema()
          },
          ["jobType", "projectRevision", "renderPlanHash", "approvalId"]
        )
      ]
    },
    EmptyMutationRequest: strictObject({}, []),
    ApprovalDecisionRequest: strictObject({
      expectedStatus: { const: "pending" },
      decision: { type: "string", enum: ["approved", "rejected"] }
    }),
    PublishingApprovalRequest: strictObject({
      expectedStatus: { const: "needs_approval" },
      approvalPath: { type: "string", enum: ["manual_export", "official_api"] }
    }),
    OrganizationExportRequest: strictObject({
      resourceTypes: {
        type: "array",
        minItems: EXPORT_RESOURCE_TYPES.length,
        maxItems: EXPORT_RESOURCE_TYPES.length,
        uniqueItems: true,
        items: { type: "string", enum: [...EXPORT_RESOURCE_TYPES] }
      }
    }),
    WebhookCreateRequest: strictObject(webhookFields),
    WebhookUpdateRequest: strictObject(
      {
        expectedUpdatedAt: timestampSchema(),
        ...webhookFields,
        status: { type: "string", enum: ["active", "paused", "disabled"] }
      },
      ["expectedUpdatedAt"],
      {
        anyOf: Object.keys(webhookFields).map((field) => ({ required: [field] }))
      }
    ),
    WebhookDeleteRequest: strictObject({
      expectedUpdatedAt: timestampSchema()
    })
  };
}

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

function uniqueTextList(value, { label, maxItems, itemMax }) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  }
  const normalized = value.map((item) => boundedString(item, { label, min: 1, max: itemMax }));
  if (new Set(normalized).size !== normalized.length) {
    throw new AppError("INVALID_INPUT", `${label} cannot contain duplicates.`);
  }
  return normalized;
}

function optionalId(value, label) {
  return value === null || value === undefined || value === "" ? null : requireId(value, label);
}

function isoTimestamp(value, label) {
  const text = boundedString(value, { label, min: 1, max: 40 });
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new AppError("INVALID_INPUT", `${label} is invalid.`);
  return new Date(timestamp).toISOString();
}

function normalizeProjectMetadata(value, { partial }) {
  const allowed = new Set([
    "title",
    "description",
    "businessId",
    "tags",
    "collectionId",
    "platforms",
    "desiredLengths",
    "instructions",
    ...(partial ? ["favorite", "expectedRevision"] : ["sourceMediaId"])
  ]);
  onlyKeys(value, allowed, partial ? "Project update request" : "Project creation request");
  const result = {};
  if (!partial || Object.hasOwn(value, "title")) {
    result.title = boundedString(value.title, { label: "Project title", min: 1, max: 120 });
  }
  if (!partial || Object.hasOwn(value, "description")) {
    result.description = boundedString(value.description, { label: "Project description", max: 1000 });
  }
  for (const [field, label] of [
    ["businessId", "Business"],
    ["collectionId", "Project collection"]
  ]) {
    if (!partial || Object.hasOwn(value, field)) result[field] = optionalId(value[field], label);
  }
  if (!partial || Object.hasOwn(value, "tags")) {
    result.tags = uniqueTextList(value.tags || [], { label: "Project tags", maxItems: 20, itemMax: 40 });
  }
  if (!partial || Object.hasOwn(value, "platforms")) result.platforms = normalizePlatforms(value.platforms || []);
  if (!partial || Object.hasOwn(value, "desiredLengths")) {
    result.desiredLengths = uniqueTextList(value.desiredLengths || [], {
      label: "Desired lengths",
      maxItems: 5,
      itemMax: 40
    });
  }
  if (!partial || Object.hasOwn(value, "instructions")) {
    result.instructions = boundedString(value.instructions, { label: "Project instructions", max: 2000 });
  }
  if (partial) {
    result.expectedRevision = boundedInteger(value.expectedRevision, {
      label: "Expected project revision",
      min: 1,
      max: MAX_REVISION
    });
    if (Object.hasOwn(value, "favorite")) {
      if (typeof value.favorite !== "boolean") throw new AppError("INVALID_INPUT", "Project favorite must be true or false.");
      result.favorite = value.favorite;
    }
    if (Object.keys(result).length === 1) {
      throw new AppError("INVALID_INPUT", "Project update request has no changes.");
    }
  } else {
    result.sourceMediaId = requireId(value.sourceMediaId, "Source media");
  }
  return result;
}

function normalizeJobCreate(value) {
  const jobType = boundedString(value.jobType, { label: "API job type", min: 1, max: 40 });
  const projectRevision = boundedInteger(value.projectRevision, {
    label: "Project revision",
    min: 1,
    max: MAX_REVISION
  });
  if (jobType === "project_prepare") {
    onlyKeys(value, new Set(["jobType", "projectRevision"]), "Job creation request");
    return { jobType, projectRevision };
  }
  if (jobType === "project_render") {
    onlyKeys(value, new Set(["jobType", "projectRevision", "renderPlanHash", "approvalId"]), "Job creation request");
    const renderPlanHash = boundedString(value.renderPlanHash, { label: "Render-plan hash", min: 71, max: 71 });
    if (!HASH_PATTERN.test(renderPlanHash)) throw new AppError("INVALID_INPUT", "Render-plan hash is invalid.");
    return {
      jobType,
      projectRevision,
      renderPlanHash,
      approvalId: requireId(value.approvalId, "Render approval")
    };
  }
  throw new AppError("INVALID_INPUT", "API job type is invalid.");
}

function normalizeWebhookEvents(value) {
  const eventTypes = uniqueTextList(value, {
    label: "Webhook event types",
    maxItems: WEBHOOK_EVENT_TYPES.length,
    itemMax: 80
  });
  if (!eventTypes.length || eventTypes.some((eventType) => !WEBHOOK_EVENT_TYPES.includes(eventType))) {
    throw new AppError("INVALID_INPUT", "Webhook event types are invalid.");
  }
  return eventTypes;
}

function normalizeWebhookCreate(value) {
  onlyKeys(value, new Set(["url", "eventTypes", "status"]), "Webhook creation request");
  const status = boundedString(value.status, { label: "Webhook status", min: 1, max: 40 });
  if (!["active", "paused"].includes(status)) throw new AppError("INVALID_INPUT", "Webhook status is invalid.");
  return {
    url: normalizeWebhookUrl(value.url),
    eventTypes: normalizeWebhookEvents(value.eventTypes),
    status
  };
}

function normalizeWebhookUpdate(value) {
  onlyKeys(value, new Set(["expectedUpdatedAt", "url", "eventTypes", "status"]), "Webhook update request");
  const result = {
    expectedUpdatedAt: isoTimestamp(value.expectedUpdatedAt, "Expected webhook update time")
  };
  if (Object.hasOwn(value, "url")) result.url = normalizeWebhookUrl(value.url);
  if (Object.hasOwn(value, "eventTypes")) result.eventTypes = normalizeWebhookEvents(value.eventTypes);
  if (Object.hasOwn(value, "status")) {
    const status = boundedString(value.status, { label: "Webhook status", min: 1, max: 40 });
    if (!["active", "paused", "disabled"].includes(status)) {
      throw new AppError("INVALID_INPUT", "Webhook status is invalid.");
    }
    result.status = status;
  }
  if (Object.keys(result).length === 1) throw new AppError("INVALID_INPUT", "Webhook update request has no changes.");
  return result;
}

function normalizeApiMutationRequest(resourceType, operation, raw) {
  const definition = OPERATION_DEFINITIONS[resourceType]?.[operation];
  const schemaName = REQUEST_SCHEMA_BY_OPERATION[`${resourceType}:${operation}`];
  if (!definition?.mutation || !schemaName) {
    throw new AppError("INVALID_INPUT", "API resource and mutation are incompatible.");
  }
  const value = plainObject(raw, "API mutation request");
  if (resourceType === "projects" && operation === "create") {
    return normalizeProjectMetadata(value, { partial: false });
  }
  if (resourceType === "projects" && operation === "update") {
    return normalizeProjectMetadata(value, { partial: true });
  }
  if (resourceType === "jobs" && operation === "create") return normalizeJobCreate(value);
  if (resourceType === "jobs" && ["cancel", "retry"].includes(operation)) {
    onlyKeys(value, new Set(), "Job action request");
    return {};
  }
  if (resourceType === "approvals" && operation === "decide") {
    onlyKeys(value, new Set(["expectedStatus", "decision"]), "Approval decision request");
    if (value.expectedStatus !== "pending" || !["approved", "rejected"].includes(value.decision)) {
      throw new AppError("INVALID_INPUT", "Approval decision request is invalid.");
    }
    return { expectedStatus: "pending", decision: value.decision };
  }
  if (resourceType === "publishing" && operation === "approve") {
    onlyKeys(value, new Set(["expectedStatus", "approvalPath"]), "Publishing approval request");
    if (value.expectedStatus !== "needs_approval" || !["manual_export", "official_api"].includes(value.approvalPath)) {
      throw new AppError("INVALID_INPUT", "Publishing approval request is invalid.");
    }
    return { expectedStatus: "needs_approval", approvalPath: value.approvalPath };
  }
  if (resourceType === "organization_exports" && operation === "create") {
    onlyKeys(value, new Set(["resourceTypes"]), "Organization export request");
    const resourceTypes = uniqueTextList(value.resourceTypes, {
      label: "Organization export resource types",
      maxItems: EXPORT_RESOURCE_TYPES.length,
      itemMax: 40
    });
    if (
      resourceTypes.length !== EXPORT_RESOURCE_TYPES.length ||
      EXPORT_RESOURCE_TYPES.some((resourceType) => !resourceTypes.includes(resourceType))
    ) {
      throw new AppError("INVALID_INPUT", "Organization exports must include every supported resource type.");
    }
    return { resourceTypes };
  }
  if (resourceType === "webhooks" && operation === "create") return normalizeWebhookCreate(value);
  if (resourceType === "webhooks" && operation === "update") return normalizeWebhookUpdate(value);
  if (resourceType === "webhooks" && operation === "delete") {
    onlyKeys(value, new Set(["expectedUpdatedAt"]), "Webhook deletion request");
    return { expectedUpdatedAt: isoTimestamp(value.expectedUpdatedAt, "Expected webhook update time") };
  }
  throw new AppError("INVALID_INPUT", "API resource and mutation are incompatible.");
}

module.exports = {
  REQUEST_SCHEMA_BY_OPERATION,
  mutationRequestSchemas,
  normalizeApiMutationRequest
};
