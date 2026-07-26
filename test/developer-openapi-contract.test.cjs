const assert = require("node:assert/strict");
const test = require("node:test");
const { OPERATION_DEFINITIONS } = require("../electron/developer-platform/api-contract.cjs");
const {
  API_SURFACE,
  JSON_SCHEMA_DIALECT,
  OPENAPI_VERSION,
  buildOpenApiContract,
  validateApiSurfaceManifest,
  validateOpenApiContract
} = require("../electron/developer-platform/openapi-contract.cjs");

test("API surface manifest covers every allowlisted operation exactly once", () => {
  assert.equal(validateApiSurfaceManifest().length, API_SURFACE.length);
  const expectedCount = Object.values(OPERATION_DEFINITIONS).reduce((total, operations) => total + Object.keys(operations).length, 0);
  assert.equal(API_SURFACE.length, expectedCount);
  assert.equal(new Set(API_SURFACE.map((item) => `${item.resourceType}:${item.operation}`)).size, expectedCount);
  assert.equal(new Set(API_SURFACE.map((item) => `${item.method}:${item.path}`)).size, expectedCount);
  assert.equal(
    API_SURFACE.some((item) => /\/(?:publish|dispatch)(?:\/|$)/.test(item.path)),
    false
  );
  for (const item of API_SURFACE) {
    const definition = OPERATION_DEFINITIONS[item.resourceType][item.operation];
    assert.equal(item.method === "get", definition.mutation === false);
    assert.equal(typeof item.requestSchema === "string", definition.mutation);
  }
});

test("surface validation rejects missing, duplicate, and scope-incompatible routes", () => {
  for (const invalid of [
    API_SURFACE.slice(1),
    [...API_SURFACE, API_SURFACE[0]],
    API_SURFACE.map((item, index) => (index === 0 ? { ...item, path: "/v1/projects/{projectId}" } : item)),
    API_SURFACE.map((item, index) => (index === 4 ? { ...item, path: "/v1/jobs" } : item)),
    API_SURFACE.map((item, index) => (index === 2 ? { ...item, method: "get" } : item)),
    API_SURFACE.map((item, index) => (index === 0 ? { ...item, responseSchema: "RawFilesystemRecord" } : item)),
    API_SURFACE.map((item, index) => (index === 0 ? { ...item, secret: "must-not-persist" } : item))
  ]) {
    assert.throws(
      () => validateApiSurfaceManifest(invalid),
      (error) => error.code === "INVALID_OPENAPI_CONTRACT"
    );
  }
});

test("OpenAPI draft uses official 3.1 metadata, bearer security, and internal references only", () => {
  const document = validateOpenApiContract(buildOpenApiContract());
  assert.equal(document.openapi, OPENAPI_VERSION);
  assert.equal(document.openapi, "3.1.2");
  assert.equal(document.jsonSchemaDialect, JSON_SCHEMA_DIALECT);
  assert.equal(document["x-produdash-production-ready"], false);
  assert.equal(Object.hasOwn(document, "servers"), false);
  assert.equal(document.components.securitySchemes.bearerAuth.scheme, "bearer");
  for (const item of API_SURFACE) {
    const operation = document.paths[item.path][item.method];
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    assert.equal(
      operation["x-produdash-request-schema-status"],
      OPERATION_DEFINITIONS[item.resourceType][item.operation].mutation ? "defined_internal" : "not_applicable"
    );
    if (OPERATION_DEFINITIONS[item.resourceType][item.operation].mutation) {
      assert.deepEqual(operation.requestBody, {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${item.requestSchema}` }
          }
        }
      });
    } else {
      assert.equal(Object.hasOwn(operation, "requestBody"), false);
    }
  }
  assert.equal(Object.hasOwn(document.components.parameters, "CursorId"), false);
  assert.equal(document.components.parameters.CursorToken.name, "cursor");
  assert.match(document.components.parameters.CursorToken.schema.pattern, /pdc_v1/);
  assert.deepEqual(
    document.paths["/v1/projects"].get.responses[200].content["application/json"].schema.properties.meta.properties.nextCursor.oneOf[1],
    { type: "null" }
  );
  const serialized = JSON.stringify(document);
  assert.equal(serialized.includes("produdash-media://"), false);
  assert.equal(serialized.includes("/Users/"), false);
  assert.equal(serialized.includes("sourcePath"), false);
});

test("OpenAPI response schemas are strict, bounded, truthful projections", () => {
  const schemas = buildOpenApiContract().components.schemas;
  for (const name of [
    "ProjectSummary",
    "JobSummary",
    "ApprovalSummary",
    "PublishingSummary",
    "AnalyticsSummary",
    "OrganizationExportSummary",
    "WebhookEndpointSummary",
    "DeletionReceipt",
    "ErrorEnvelope"
  ]) {
    assert.equal(schemas[name].additionalProperties, false);
  }
  assert.deepEqual(schemas.PublishingSummary.properties.externalDeliveryStatus, { const: "unavailable" });
  assert.equal(schemas.AnalyticsSummary.properties.metrics.maxItems, 50);
  assert.equal(schemas.WebhookEndpointSummary.properties.url.maxLength, 2048);
  assert.equal(Object.hasOwn(schemas.OrganizationExportSummary.properties, "url"), false);
  assert.equal(Object.hasOwn(schemas.OrganizationExportSummary.properties, "path"), false);
});

test("OpenAPI mutation schemas are strict, bounded, and preserve approval gates", () => {
  const schemas = buildOpenApiContract().components.schemas;
  for (const name of new Set(API_SURFACE.map((item) => item.requestSchema).filter(Boolean))) {
    const variants = schemas[name].oneOf || [schemas[name]];
    for (const variant of variants) assert.equal(variant.additionalProperties, false);
  }
  assert.deepEqual(schemas.JobCreateRequest.oneOf[1].properties.jobType, { const: "project_render" });
  assert.equal(schemas.JobCreateRequest.oneOf[1].required.includes("approvalId"), true);
  assert.deepEqual(schemas.ApprovalDecisionRequest.properties.expectedStatus, { const: "pending" });
  assert.deepEqual(schemas.PublishingApprovalRequest.properties.expectedStatus, { const: "needs_approval" });
  assert.equal(Object.hasOwn(schemas.ProjectCreateRequest.properties, "sourcePath"), false);
  assert.equal(Object.hasOwn(schemas.WebhookCreateRequest.properties, "secret"), false);
});

test("OpenAPI validation rejects production claims, external references, unsafe fields, and extra routes", () => {
  const production = buildOpenApiContract();
  production["x-produdash-production-ready"] = true;
  const externalReference = buildOpenApiContract();
  externalReference.components.schemas.ProjectSummary.properties.extra = { $ref: "https://example.com/schema.json" };
  const unsafeField = buildOpenApiContract();
  unsafeField.components.schemas.ProjectSummary.properties.sourcePath = { type: "string" };
  const extraRoute = buildOpenApiContract();
  extraRoute.paths["/v1/publish"] = { post: {} };
  const server = buildOpenApiContract();
  server.servers = [{ url: "https://api.example.com" }];
  const noSecurity = buildOpenApiContract();
  noSecurity.paths["/v1/projects"].get.security = [];
  const weakenedSchema = buildOpenApiContract();
  weakenedSchema.components.schemas.ProjectSummary.additionalProperties = true;
  for (const invalid of [production, externalReference, unsafeField, extraRoute, server, noSecurity, weakenedSchema]) {
    assert.throws(
      () => validateOpenApiContract(invalid),
      (error) => error.code === "INVALID_OPENAPI_CONTRACT"
    );
  }
});
