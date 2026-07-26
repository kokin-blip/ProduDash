const assert = require("node:assert/strict");
const test = require("node:test");
const { analyticsReportCsv, buildAnalyticsReport } = require("../electron/analytics-report.cjs");

function stateWithBusiness(overrides = {}) {
  return {
    businesses: [
      {
        id: "business-analytics",
        name: "Verified store",
        source: "shopify",
        connectionStatus: "connected",
        lastSync: "2026-07-25T10:00:00.000Z",
        currency: "USD",
        orders: [
          {
            id: "#1001",
            customer: "Private Customer",
            value: 40,
            fulfillmentStatus: "fulfilled",
            email: "private@example.com"
          },
          { id: "#1002", customer: "Another Customer", value: 60, fulfillmentStatus: "unfulfilled" }
        ],
        financeTrend: [
          { week: "Jul 20", revenue: 100 },
          { week: '=HYPERLINK("bad")', revenue: 1 }
        ],
        ...overrides
      }
    ]
  };
}

test("analytics reports derive only supported Shopify metrics with definitions and freshness", () => {
  const report = buildAnalyticsReport(stateWithBusiness(), "business-analytics", {
    now: new Date("2026-07-25T18:00:00.000Z")
  });
  assert.equal(report.source.name, "Shopify Admin API");
  assert.equal(report.source.freshness.status, "current");
  assert.deepEqual(
    report.metrics.map((metric) => [metric.id, metric.value]),
    [
      ["revenue", 100],
      ["orders", 2],
      ["average_order_value", 50],
      ["fulfillment_rate", 50]
    ]
  );
  assert.deepEqual(
    report.unavailableMetrics.map((metric) => metric.id),
    ["profit", "conversion", "social_performance"]
  );
  assert.doesNotMatch(JSON.stringify(report), /Private Customer|private@example.com|adminAccessToken/i);
});

test("analytics freshness distinguishes aging, stale, and unavailable snapshots", () => {
  assert.equal(
    buildAnalyticsReport(stateWithBusiness(), "business-analytics", { now: new Date("2026-07-27T10:00:00.000Z") }).source.freshness.status,
    "aging"
  );
  assert.equal(
    buildAnalyticsReport(stateWithBusiness(), "business-analytics", { now: new Date("2026-08-10T10:00:00.000Z") }).source.freshness.status,
    "stale"
  );
  const empty = buildAnalyticsReport({ businesses: [] }, null, { now: new Date("2026-07-25T18:00:00.000Z") });
  assert.equal(empty.status, "unavailable");
  assert.equal(empty.metrics.length, 0);
});

test("analytics compares equal validated windows against the verified sync time without causal claims", () => {
  const report = buildAnalyticsReport(
    stateWithBusiness({
      lastSync: "2026-07-25T10:00:00.000Z",
      orders: [
        { id: "#current-1", createdAt: "2026-07-24T10:00:00.000Z", value: 80, fulfillmentStatus: "fulfilled" },
        { id: "#current-2", createdAt: "2026-07-20T10:00:00.000Z", value: 40, fulfillmentStatus: "unfulfilled" },
        { id: "#previous", createdAt: "2026-07-15T10:00:00.000Z", value: 40, fulfillmentStatus: "unfulfilled" }
      ]
    }),
    "business-analytics",
    { now: new Date("2026-08-01T10:00:00.000Z"), rangeDays: 7 }
  );
  assert.equal(report.comparison.anchorAt, "2026-07-25T10:00:00.000Z");
  assert.equal(report.comparison.rangeDays, 7);
  assert.deepEqual(
    report.comparison.metrics.map((metric) => [metric.id, metric.current, metric.previous]),
    [
      ["revenue", 120, 40],
      ["orders", 2, 1],
      ["average_order_value", 60, 40],
      ["fulfillment_rate", 50, 0]
    ]
  );
  assert.equal(report.comparison.metrics[0].deltaPercent, 200);
  assert.match(report.comparison.observations[0], /based on 2 current and 1 preceding imported orders/);
  assert.doesNotMatch(report.comparison.observations.join(" "), /caused|forecast|will increase/i);
  assert.throws(() => buildAnalyticsReport(stateWithBusiness(), "business-analytics", { rangeDays: 14 }), {
    code: "INVALID_INPUT"
  });
});

test("analytics CSV is path-free, PII-free, and neutralizes spreadsheet formulas", () => {
  const report = buildAnalyticsReport(stateWithBusiness(), "business-analytics", {
    now: new Date("2026-07-25T18:00:00.000Z")
  });
  const csv = analyticsReportCsv(report);
  assert.match(csv, /record_type.*metric_id.*definition/);
  assert.match(csv, /comparison_current/);
  assert.match(csv, /observation/);
  assert.match(csv, /"'=HYPERLINK/);
  assert.doesNotMatch(csv, /Private Customer|private@example.com|sourcePath|outputPath|bookmark/i);
  assert.equal(csv.endsWith("\n"), true);
});

test("analytics rejects unknown business identifiers", () => {
  assert.throws(() => buildAnalyticsReport(stateWithBusiness(), "business-missing"), { code: "BUSINESS_NOT_FOUND" });
  assert.throws(() => buildAnalyticsReport(stateWithBusiness(), "../business"), { code: "INVALID_INPUT" });
  assert.throws(() => buildAnalyticsReport(stateWithBusiness({ source: "manual", shopifyShopId: null }), "business-analytics"), {
    code: "ANALYTICS_UNAVAILABLE"
  });
});
