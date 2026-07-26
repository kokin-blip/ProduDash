const { isDeepStrictEqual } = require("node:util");
const { AppError } = require("../errors.cjs");
const { API_VERSION, OPERATION_DEFINITIONS } = require("./api-contract.cjs");
const { REQUEST_SCHEMA_BY_OPERATION, mutationRequestSchemas } = require("./request-contract.cjs");
const { API_ERROR_DEFINITIONS } = require("./runtime-contract.cjs");

const OPENAPI_VERSION = "3.1.2";
const JSON_SCHEMA_DIALECT = "https://spec.openapis.org/oas/3.1/dialect/base";
const ID_PATTERN = "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$";
const HASH_PATTERN = "^sha256:[a-f0-9]{64}$";
const CURSOR_PATTERN = "^pdc_v1_[A-Za-z0-9_-]{2,171}_[A-Za-z0-9_-]{43}$";

function route(resourceType, operation, method, path, responseSchema, successStatus) {
  return Object.freeze({
    resourceType,
    operation,
    method,
    path,
    requestSchema: REQUEST_SCHEMA_BY_OPERATION[`${resourceType}:${operation}`] || null,
    responseSchema,
    successStatus
  });
}

const API_SURFACE = Object.freeze([
  route("projects", "list", "get", "/v1/projects", "ProjectSummary", 200),
  route("projects", "get", "get", "/v1/projects/{projectId}", "ProjectSummary", 200),
  route("projects", "create", "post", "/v1/projects", "ProjectSummary", 201),
  route("projects", "update", "patch", "/v1/projects/{projectId}", "ProjectSummary", 200),
  route("jobs", "list", "get", "/v1/projects/{projectId}/jobs", "JobSummary", 200),
  route("jobs", "get", "get", "/v1/projects/{projectId}/jobs/{jobId}", "JobSummary", 200),
  route("jobs", "create", "post", "/v1/projects/{projectId}/jobs", "JobSummary", 202),
  route("jobs", "cancel", "post", "/v1/projects/{projectId}/jobs/{jobId}/cancel", "JobSummary", 200),
  route("jobs", "retry", "post", "/v1/projects/{projectId}/jobs/{jobId}/retry", "JobSummary", 202),
  route("approvals", "list", "get", "/v1/projects/{projectId}/approvals", "ApprovalSummary", 200),
  route("approvals", "get", "get", "/v1/projects/{projectId}/approvals/{approvalId}", "ApprovalSummary", 200),
  route("approvals", "decide", "post", "/v1/projects/{projectId}/approvals/{approvalId}/decision", "ApprovalSummary", 200),
  route("publishing", "list", "get", "/v1/projects/{projectId}/publishing", "PublishingSummary", 200),
  route("publishing", "get", "get", "/v1/projects/{projectId}/publishing/{publishingId}", "PublishingSummary", 200),
  route("publishing", "approve", "post", "/v1/projects/{projectId}/publishing/{publishingId}/approval", "PublishingSummary", 200),
  route("analytics", "get", "get", "/v1/analytics", "AnalyticsSummary", 200),
  route("organization_exports", "create", "post", "/v1/organization-exports", "OrganizationExportSummary", 202),
  route("organization_exports", "get", "get", "/v1/organization-exports/{exportId}", "OrganizationExportSummary", 200),
  route("webhooks", "list", "get", "/v1/webhooks", "WebhookEndpointSummary", 200),
  route("webhooks", "create", "post", "/v1/webhooks", "WebhookEndpointSummary", 201),
  route("webhooks", "update", "patch", "/v1/webhooks/{webhookId}", "WebhookEndpointSummary", 200),
  route("webhooks", "delete", "delete", "/v1/webhooks/{webhookId}", "DeletionReceipt", 200)
]);

function idSchema() {
  return { type: "string", minLength: 1, maxLength: 128, pattern: ID_PATTERN };
}

function nullable(schema) {
  return { oneOf: [schema, { type: "null" }] };
}

function timestampSchema() {
  return { type: "string", format: "date-time", maxLength: 40 };
}

function cursorTokenSchema() {
  return { type: "string", minLength: 53, maxLength: 230, pattern: CURSOR_PATTERN };
}

function strictObject(properties, required = Object.keys(properties)) {
  return { type: "object", additionalProperties: false, properties, required };
}

function resourceSchemas() {
  const platform = { type: "string", enum: ["tiktok", "instagram", "youtube"] };
  return {
    ProjectSummary: strictObject({
      projectId: idSchema(),
      organizationId: idSchema(),
      businessId: nullable(idSchema()),
      title: { type: "string", minLength: 1, maxLength: 120 },
      description: { type: "string", maxLength: 1000 },
      status: { type: "string", enum: ["active", "archived"] },
      sourceStatus: { type: "string", enum: ["available", "missing", "offline", "corrupt", "unsupported"] },
      favorite: { type: "boolean" },
      tags: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } },
      platforms: { type: "array", maxItems: 3, uniqueItems: true, items: platform },
      revision: { type: "integer", minimum: 1 },
      savedRevision: { type: "integer", minimum: 1 },
      createdAt: timestampSchema(),
      updatedAt: timestampSchema()
    }),
    JobSummary: strictObject({
      jobId: idSchema(),
      organizationId: idSchema(),
      projectId: nullable(idSchema()),
      title: { type: "string", minLength: 1, maxLength: 120 },
      jobType: { type: "string", enum: ["clip_generation", "project_prepare", "project_render"] },
      status: {
        type: "string",
        enum: ["queued", "render_queued", "processing", "awaiting_review", "canceling", "canceled", "interrupted", "failed", "completed"]
      },
      stage: { type: "string", minLength: 1, maxLength: 80 },
      progress: { type: "integer", minimum: 0, maximum: 100 },
      warningCount: { type: "integer", minimum: 0, maximum: 1000 },
      artifactCount: { type: "integer", minimum: 0, maximum: 1000 },
      createdAt: timestampSchema(),
      updatedAt: timestampSchema()
    }),
    ApprovalSummary: strictObject({
      approvalId: idSchema(),
      organizationId: idSchema(),
      projectId: idSchema(),
      kind: { type: "string", enum: ["ai_draft", "publishing"] },
      status: { type: "string", enum: ["pending", "approved", "rejected"] },
      approvedDraftNotSent: { type: "boolean" },
      createdAt: timestampSchema(),
      decidedAt: nullable(timestampSchema())
    }),
    PublishingSummary: strictObject({
      publishingId: idSchema(),
      organizationId: idSchema(),
      projectId: idSchema(),
      title: { type: "string", minLength: 1, maxLength: 120 },
      platforms: { type: "array", maxItems: 3, uniqueItems: true, items: platform },
      status: {
        type: "string",
        enum: ["needs_approval", "approved_for_manual_export", "approved_for_official_api", "export_ready", "canceled"]
      },
      scheduleMode: { type: "string", enum: ["unscheduled", "planned_local_only"] },
      scheduledFor: nullable(timestampSchema()),
      approvedAt: nullable(timestampSchema()),
      externalDeliveryStatus: { const: "unavailable" }
    }),
    AnalyticsSummary: strictObject({
      organizationId: idSchema(),
      projectId: nullable(idSchema()),
      generatedAt: timestampSchema(),
      metrics: {
        type: "array",
        maxItems: 50,
        items: strictObject({
          metricId: idSchema(),
          value: nullable({ type: "number" }),
          unit: { type: "string", minLength: 1, maxLength: 40 },
          source: { type: "string", minLength: 1, maxLength: 80 },
          freshness: { type: "string", enum: ["fresh", "aging", "stale", "unavailable"] }
        })
      },
      limitations: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 300 } }
    }),
    OrganizationExportSummary: strictObject({
      exportId: idSchema(),
      organizationId: idSchema(),
      status: { type: "string", enum: ["queued", "processing", "completed", "failed", "expired"] },
      artifactId: nullable(idSchema()),
      checksum: nullable({ type: "string", minLength: 71, maxLength: 71, pattern: HASH_PATTERN }),
      createdAt: timestampSchema(),
      expiresAt: timestampSchema()
    }),
    WebhookEndpointSummary: strictObject({
      endpointId: idSchema(),
      organizationId: idSchema(),
      url: { type: "string", format: "uri", minLength: 1, maxLength: 2048 },
      eventTypes: { type: "array", minItems: 1, maxItems: 6, uniqueItems: true, items: { type: "string", maxLength: 80 } },
      status: { type: "string", enum: ["active", "paused", "disabled"] },
      createdAt: timestampSchema(),
      updatedAt: timestampSchema()
    }),
    DeletionReceipt: strictObject({
      resourceId: idSchema(),
      deleted: { const: true },
      deletedAt: timestampSchema()
    })
  };
}

function surfaceKey(resourceType, operation) {
  return `${resourceType}:${operation}`;
}

function validateApiSurfaceManifest(surface = API_SURFACE) {
  if (!Array.isArray(surface)) throw new AppError("INVALID_OPENAPI_CONTRACT", "The API surface manifest is invalid.");
  const expected = new Map();
  for (const [resourceType, operations] of Object.entries(OPERATION_DEFINITIONS)) {
    for (const operation of Object.keys(operations)) expected.set(surfaceKey(resourceType, operation), operations[operation]);
  }
  const seenOperations = new Set();
  const seenRoutes = new Set();
  const responseSchemaNames = new Set(Object.keys(resourceSchemas()));
  const requestSchemaNames = new Set(Object.keys(mutationRequestSchemas()));
  const routeKeys = new Set(["resourceType", "operation", "method", "path", "requestSchema", "responseSchema", "successStatus"]);
  for (const item of surface) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AppError("INVALID_OPENAPI_CONTRACT", "The API surface manifest contains an invalid route.");
    }
    const key = surfaceKey(item.resourceType, item.operation);
    const definition = expected.get(key);
    const routeKey = `${item.method}:${item.path}`;
    if (
      !definition ||
      seenOperations.has(key) ||
      seenRoutes.has(routeKey) ||
      Object.keys(item).some((field) => !routeKeys.has(field)) ||
      !["get", "post", "patch", "delete"].includes(item.method) ||
      !/^\/v1(?:\/[a-z0-9-]+|\/\{[a-zA-Z][a-zA-Z0-9]*\})*$/.test(item.path) ||
      !responseSchemaNames.has(item.responseSchema) ||
      (definition.mutation && (!requestSchemaNames.has(item.requestSchema) || item.requestSchema !== REQUEST_SCHEMA_BY_OPERATION[key])) ||
      (!definition.mutation && item.requestSchema !== null) ||
      !Number.isInteger(item.successStatus) ||
      item.successStatus < 200 ||
      item.successStatus > 299 ||
      (definition.mutation && item.method === "get") ||
      (!definition.mutation && item.method !== "get")
    ) {
      throw new AppError("INVALID_OPENAPI_CONTRACT", "The API surface manifest contains an incompatible route.");
    }
    const parameters = [...item.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const hasProject = parameters.includes("projectId");
    const resourceParameters = parameters.filter((parameter) => parameter !== "projectId");
    if (
      (definition.projectId === "required" && !hasProject) ||
      (definition.projectId === "forbidden" && hasProject) ||
      (definition.resourceId === "required" && item.resourceType !== "projects" && resourceParameters.length !== 1) ||
      (definition.resourceId === "forbidden" && resourceParameters.length)
    ) {
      throw new AppError("INVALID_OPENAPI_CONTRACT", "The API route scope does not match its operation.");
    }
    seenOperations.add(key);
    seenRoutes.add(routeKey);
  }
  if (seenOperations.size !== expected.size) {
    throw new AppError("INVALID_OPENAPI_CONTRACT", "The API surface manifest is incomplete.");
  }
  return surface;
}

function successEnvelopeSchema(item) {
  const list = item.operation === "list";
  return strictObject({
    apiVersion: { const: API_VERSION },
    requestId: idSchema(),
    data: list
      ? { type: "array", maxItems: 100, items: { $ref: `#/components/schemas/${item.responseSchema}` } }
      : { $ref: `#/components/schemas/${item.responseSchema}` },
    meta: strictObject({
      dataHash: { type: "string", minLength: 71, maxLength: 71, pattern: HASH_PATTERN },
      resultCount: { type: "integer", minimum: 0, maximum: list ? 100 : 1 },
      nextCursor: list ? nullable(cursorTokenSchema()) : { type: "null" }
    }),
    completedAt: timestampSchema()
  });
}

function errorEnvelopeSchema() {
  return strictObject({
    apiVersion: { const: API_VERSION },
    requestId: idSchema(),
    statusCode: { type: "integer", minimum: 400, maximum: 599 },
    error: strictObject({
      code: { type: "string", enum: Object.keys(API_ERROR_DEFINITIONS) },
      message: { type: "string", minLength: 1, maxLength: 200 },
      retryable: { type: "boolean" },
      retryAfterSeconds: nullable({ type: "integer", minimum: 1, maximum: 3600 })
    }),
    completedAt: timestampSchema()
  });
}

function parameterForPath(name) {
  return {
    name,
    in: "path",
    required: true,
    schema: idSchema()
  };
}

function operationParameters(item) {
  const parameters = [...item.path.matchAll(/\{([^}]+)\}/g)].map((match) => parameterForPath(match[1]));
  parameters.push({ $ref: "#/components/parameters/RequestId" }, { $ref: "#/components/parameters/RequestTimestamp" });
  if (item.operation === "list") {
    parameters.push(
      { $ref: "#/components/parameters/PageLimit" },
      { $ref: "#/components/parameters/CursorToken" },
      { $ref: "#/components/parameters/QueryHash" }
    );
  }
  if (item.resourceType === "analytics") {
    parameters.push({
      name: "project_id",
      in: "query",
      required: false,
      schema: idSchema()
    });
  }
  if (OPERATION_DEFINITIONS[item.resourceType][item.operation].mutation) {
    parameters.push({ $ref: "#/components/parameters/IdempotencyKey" }, { $ref: "#/components/parameters/ContentHash" });
  }
  return parameters;
}

function buildOpenApiContract() {
  validateApiSurfaceManifest();
  const paths = {};
  for (const item of API_SURFACE) {
    const definition = OPERATION_DEFINITIONS[item.resourceType][item.operation];
    paths[item.path] ||= {};
    const operation = {
      operationId: `${item.resourceType}_${item.operation}`,
      tags: [item.resourceType],
      security: [{ bearerAuth: [] }],
      parameters: operationParameters(item),
      responses: {
        [item.successStatus]: {
          description: "Successful response metadata and a safe resource projection.",
          content: {
            "application/json": {
              schema: successEnvelopeSchema(item)
            }
          }
        },
        default: {
          description: "Normalized safe error.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" }
            }
          }
        }
      },
      "x-produdash-scope": definition.scope,
      "x-produdash-mutation": definition.mutation,
      "x-produdash-request-schema-status": definition.mutation ? "defined_internal" : "not_applicable"
    };
    if (definition.mutation) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${item.requestSchema}` }
          }
        }
      };
    }
    paths[item.path][item.method] = operation;
  }
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "ProduDash Developer API",
      version: API_VERSION,
      description: "Internal contract draft. ProduDash does not currently expose a hosted API."
    },
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "ProduDash API token"
        }
      },
      parameters: {
        RequestId: {
          name: "X-Request-Id",
          in: "header",
          required: true,
          schema: idSchema()
        },
        RequestTimestamp: {
          name: "X-Request-Timestamp",
          in: "header",
          required: true,
          schema: timestampSchema()
        },
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: idSchema()
        },
        ContentHash: {
          name: "X-Content-SHA256",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 71, maxLength: 71, pattern: HASH_PATTERN }
        },
        PageLimit: {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 100, default: 50 }
        },
        CursorToken: {
          name: "cursor",
          in: "query",
          required: false,
          schema: cursorTokenSchema()
        },
        QueryHash: {
          name: "query_hash",
          in: "query",
          required: true,
          schema: { type: "string", minLength: 71, maxLength: 71, pattern: HASH_PATTERN }
        }
      },
      schemas: {
        ...resourceSchemas(),
        ...mutationRequestSchemas(),
        ErrorEnvelope: errorEnvelopeSchema()
      }
    },
    "x-produdash-production-ready": false
  };
}

function visit(value, callback) {
  const pending = [value];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (seen.size > 50_000) throw new AppError("INVALID_OPENAPI_CONTRACT", "The OpenAPI contract is too large.");
    callback(current);
    pending.push(...Object.values(current));
  }
}

function validateOpenApiContract(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError("INVALID_OPENAPI_CONTRACT", "The OpenAPI contract is invalid.");
  }
  if (
    raw.openapi !== OPENAPI_VERSION ||
    raw.info?.version !== API_VERSION ||
    raw.jsonSchemaDialect !== JSON_SCHEMA_DIALECT ||
    raw["x-produdash-production-ready"] !== false ||
    Object.hasOwn(raw, "servers")
  ) {
    throw new AppError("INVALID_OPENAPI_CONTRACT", "The OpenAPI contract metadata is invalid.");
  }
  validateApiSurfaceManifest();
  const expectedRoutes = new Set();
  for (const item of API_SURFACE) {
    expectedRoutes.add(`${item.method}:${item.path}`);
    const operation = raw.paths?.[item.path]?.[item.method];
    const definition = OPERATION_DEFINITIONS[item.resourceType][item.operation];
    if (
      !operation ||
      operation.operationId !== `${item.resourceType}_${item.operation}` ||
      operation["x-produdash-scope"] !== definition.scope ||
      operation["x-produdash-mutation"] !== definition.mutation ||
      operation["x-produdash-request-schema-status"] !== (definition.mutation ? "defined_internal" : "not_applicable") ||
      (definition.mutation &&
        operation.requestBody?.content?.["application/json"]?.schema?.$ref !== `#/components/schemas/${item.requestSchema}`) ||
      (!definition.mutation && Object.hasOwn(operation, "requestBody")) ||
      JSON.stringify(operation.security) !== JSON.stringify([{ bearerAuth: [] }])
    ) {
      throw new AppError("INVALID_OPENAPI_CONTRACT", "An OpenAPI operation does not match the API surface.");
    }
  }
  const actualRoutes = new Set();
  for (const [path, pathItem] of Object.entries(raw.paths || {})) {
    for (const method of Object.keys(pathItem)) actualRoutes.add(`${method}:${path}`);
    if (/(?:^|\/)(?:publish|dispatch)(?:\/|$)/.test(path)) {
      throw new AppError("INVALID_OPENAPI_CONTRACT", "The OpenAPI contract contains an unsupported external action.");
    }
  }
  if (actualRoutes.size !== expectedRoutes.size || [...actualRoutes].some((item) => !expectedRoutes.has(item))) {
    throw new AppError("INVALID_OPENAPI_CONTRACT", "The OpenAPI route set is incomplete or unsupported.");
  }
  if (raw.components?.securitySchemes?.bearerAuth?.scheme !== "bearer") {
    throw new AppError("INVALID_OPENAPI_CONTRACT", "The OpenAPI security scheme is invalid.");
  }
  const forbiddenKeys = /^(?:sourcePath|outputPath|localPath|bookmark|credential|secret|tokenDigest|authorization|headers|stack)$/i;
  visit(raw, (value) => {
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.test(key)) {
        throw new AppError("INVALID_OPENAPI_CONTRACT", "The OpenAPI contract contains a sensitive field.");
      }
      if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#/components/"))) {
        throw new AppError("INVALID_OPENAPI_CONTRACT", "The OpenAPI contract contains an external reference.");
      }
    }
  });
  if (!isDeepStrictEqual(raw, buildOpenApiContract())) {
    throw new AppError("INVALID_OPENAPI_CONTRACT", "The OpenAPI contract differs from the reviewed internal draft.");
  }
  return raw;
}

module.exports = {
  API_SURFACE,
  JSON_SCHEMA_DIALECT,
  OPENAPI_VERSION,
  buildOpenApiContract,
  validateApiSurfaceManifest,
  validateOpenApiContract
};
