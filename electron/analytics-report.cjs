const { AppError } = require("./errors.cjs");
const { requireId } = require("./validation.cjs");

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPARISON_WINDOWS = new Set([7, 30, 60]);

function finiteNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= 1_000_000_000_000 ? number : null;
}

function freshness(lastSync, now) {
  const syncedAt = Date.parse(lastSync);
  if (!Number.isFinite(syncedAt)) {
    return { status: "unknown", label: "Sync time unavailable", ageHours: null };
  }
  const ageMs = Math.max(0, now.getTime() - syncedAt);
  const ageHours = Number((ageMs / (60 * 60 * 1000)).toFixed(1));
  if (ageMs <= DAY_MS) return { status: "current", label: "Updated within 24 hours", ageHours };
  if (ageMs <= 7 * DAY_MS) return { status: "aging", label: "Updated within 7 days", ageHours };
  return { status: "stale", label: "Older than 7 days", ageHours };
}

function normalizeRangeDays(value) {
  const rangeDays = value === undefined || value === null || value === "" ? 30 : Number(value);
  if (!COMPARISON_WINDOWS.has(rangeDays)) {
    throw new AppError("INVALID_INPUT", "Analytics range must be 7, 30, or 60 days.");
  }
  return rangeDays;
}

function periodSummary(orders) {
  const revenue = orders.reduce((sum, order) => sum + order.value, 0);
  const fulfilled = orders.filter((order) => order.fulfillmentStatus === "fulfilled").length;
  return {
    revenue: Number(revenue.toFixed(2)),
    orders: orders.length,
    averageOrderValue: orders.length ? Number((revenue / orders.length).toFixed(2)) : null,
    fulfillmentRate: orders.length ? Number(((fulfilled / orders.length) * 100).toFixed(1)) : null
  };
}

function metricComparison(id, label, format, definition, current, previous) {
  const delta = current === null || previous === null ? null : Number((current - previous).toFixed(2));
  const deltaPercent = delta === null || previous === 0 ? null : Number(((delta / Math.abs(previous)) * 100).toFixed(1));
  return { id, label, format, definition, current, previous, delta, deltaPercent };
}

function buildComparison(orders, rangeDays, anchor) {
  const anchorAt = anchor.getTime();
  const currentStart = anchorAt - rangeDays * DAY_MS;
  const previousStart = currentStart - rangeDays * DAY_MS;
  const datedOrders = orders
    .map((order) => ({ ...order, timestamp: Date.parse(order.createdAt) }))
    .filter((order) => Number.isFinite(order.timestamp) && order.timestamp <= anchorAt && order.timestamp > previousStart);
  const current = periodSummary(datedOrders.filter((order) => order.timestamp > currentStart));
  const previous = periodSummary(datedOrders.filter((order) => order.timestamp <= currentStart));
  const metrics = [
    metricComparison(
      "revenue",
      "Imported revenue",
      "currency",
      "Current-window imported order totals compared with the immediately preceding equal window.",
      current.revenue,
      previous.revenue
    ),
    metricComparison(
      "orders",
      "Imported orders",
      "integer",
      "Current-window imported order count compared with the immediately preceding equal window.",
      current.orders,
      previous.orders
    ),
    metricComparison(
      "average_order_value",
      "Average order value",
      "currency",
      "Current-window imported revenue per order compared with the immediately preceding equal window.",
      current.averageOrderValue,
      previous.averageOrderValue
    ),
    metricComparison(
      "fulfillment_rate",
      "Fulfillment rate",
      "percent",
      "Current-window fulfilled share compared with the immediately preceding equal window.",
      current.fulfillmentRate,
      previous.fulfillmentRate
    )
  ];
  const observations = [];
  if (!current.orders) {
    observations.push(`No dated imported orders fell within the latest ${rangeDays}-day window.`);
  } else if (!previous.orders) {
    observations.push(`The preceding ${rangeDays}-day window contains no dated imported orders, so percentage changes are unavailable.`);
  } else {
    const revenue = metrics[0];
    const direction = revenue.delta > 0 ? "higher" : revenue.delta < 0 ? "lower" : "unchanged";
    observations.push(
      `Imported revenue was ${direction} in the latest ${rangeDays}-day window, based on ${current.orders} current and ${previous.orders} preceding imported orders.`
    );
    const fulfillment = metrics[3];
    if (fulfillment.delta !== 0) {
      observations.push(
        `The imported fulfilled-order share was ${fulfillment.delta > 0 ? "higher" : "lower"} than the preceding equal window.`
      );
    }
  }
  return {
    rangeDays,
    anchorAt: anchor.toISOString(),
    periods: {
      current: { start: new Date(currentStart).toISOString(), end: anchor.toISOString() },
      previous: { start: new Date(previousStart).toISOString(), end: new Date(currentStart).toISOString() }
    },
    datedOrderCount: datedOrders.length,
    undatedOrderCount: orders.filter((order) => !Number.isFinite(Date.parse(order.createdAt))).length,
    completeness: "bounded_snapshot",
    limitation: "Comparisons use only dated orders present in the bounded local snapshot and may not represent complete store history.",
    metrics,
    observations
  };
}

function buildAnalyticsReport(state, businessId, options = {}) {
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  const rangeDays = normalizeRangeDays(options.rangeDays);
  if (!businessId) {
    return {
      generatedAt: now.toISOString(),
      businessId: null,
      businessName: null,
      status: "unavailable",
      source: null,
      metrics: [],
      trend: [],
      unavailableMetrics: [
        { id: "profit", label: "Profit", reason: "Real product costs are not connected." },
        { id: "conversion", label: "Conversion", reason: "Real traffic and session data are not connected." }
      ]
    };
  }
  const id = requireId(businessId, "Business");
  const business = state.businesses.find((item) => item.id === id);
  if (!business) throw new AppError("BUSINESS_NOT_FOUND", "Business not found.");
  if (business.source !== "shopify" && !business.shopifyShopId) {
    throw new AppError("ANALYTICS_UNAVAILABLE", "This business does not have a verified Shopify snapshot.");
  }

  const orders = Array.isArray(business.orders) ? business.orders.slice(0, 100) : [];
  const revenueValues = orders.map((order) => finiteNumber(order?.value)).filter((value) => value !== null);
  const revenue = revenueValues.reduce((sum, value) => sum + value, 0);
  const orderCount = orders.length;
  const fulfilledCount = orders.filter((order) => order?.fulfillmentStatus === "fulfilled").length;
  const currency = typeof business.currency === "string" && /^[A-Z]{3}$/.test(business.currency) ? business.currency : "USD";
  const lastSync = typeof business.lastSync === "string" ? business.lastSync : null;
  const connectionStatus = ["connected", "degraded"].includes(business.connectionStatus) ? business.connectionStatus : "disconnected";
  const anchor = Number.isFinite(Date.parse(lastSync)) ? new Date(lastSync) : now;
  const trend = (Array.isArray(business.financeTrend) ? business.financeTrend : [])
    .map((point) => ({
      period: typeof point?.week === "string" ? point.week.slice(0, 80) : "",
      revenue: finiteNumber(point?.revenue)
    }))
    .filter((point) => point.period && point.revenue !== null)
    .slice(-60);

  return {
    generatedAt: now.toISOString(),
    businessId: id,
    businessName: String(business.name || "Shopify store").slice(0, 120),
    status: connectionStatus,
    source: {
      id: "shopify",
      name: "Shopify Admin API",
      status: connectionStatus,
      syncedAt: lastSync,
      freshness: freshness(lastSync, now),
      recordLimit: 100,
      windowNote:
        "This local snapshot contains up to 100 recent orders. Shopify normally limits custom apps to the latest 60 days unless older-order access is approved."
    },
    currency,
    metrics: [
      {
        id: "revenue",
        label: "Imported revenue",
        value: Number(revenue.toFixed(2)),
        format: "currency",
        definition: "Sum of current order totals returned in the latest Shopify snapshot."
      },
      {
        id: "orders",
        label: "Imported orders",
        value: orderCount,
        format: "integer",
        definition: "Count of recent orders returned in the latest Shopify snapshot."
      },
      {
        id: "average_order_value",
        label: "Average order value",
        value: orderCount ? Number((revenue / orderCount).toFixed(2)) : null,
        format: "currency",
        definition: "Imported revenue divided by imported order count."
      },
      {
        id: "fulfillment_rate",
        label: "Fulfillment rate",
        value: orderCount ? Number(((fulfilledCount / orderCount) * 100).toFixed(1)) : null,
        format: "percent",
        definition: "Share of imported orders whose latest Shopify fulfillment status is fulfilled."
      }
    ],
    trend,
    comparison: buildComparison(
      orders.map((order) => ({
        createdAt: order?.createdAt,
        value: finiteNumber(order?.value) ?? 0,
        fulfillmentStatus: order?.fulfillmentStatus
      })),
      rangeDays,
      anchor
    ),
    unavailableMetrics: [
      { id: "profit", label: "Profit", reason: "Real product costs are not connected." },
      { id: "conversion", label: "Conversion", reason: "Real traffic and session data are not connected." },
      { id: "social_performance", label: "Social performance", reason: "Official social reporting connectors are not implemented." }
    ]
  };
}

function csvCell(value) {
  if (typeof value === "number") return String(value);
  let text = String(value ?? "").replace(/[\r\n]+/g, " ");
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function analyticsReportCsv(report) {
  const header = ["record_type", "metric_id", "label", "period", "value", "currency", "definition", "source", "synced_at"];
  const rows = report.metrics.map((metric) => [
    "metric",
    metric.id,
    metric.label,
    "",
    metric.value,
    report.currency,
    metric.definition,
    report.source?.name || "",
    report.source?.syncedAt || ""
  ]);
  for (const point of report.trend) {
    rows.push([
      "trend",
      "revenue",
      "Imported revenue",
      point.period,
      point.revenue,
      report.currency,
      "Weekly total from imported recent Shopify orders.",
      report.source?.name || "",
      report.source?.syncedAt || ""
    ]);
  }
  for (const metric of report.comparison?.metrics || []) {
    rows.push([
      "comparison_current",
      metric.id,
      metric.label,
      `${report.comparison.rangeDays} days`,
      metric.current,
      metric.format === "currency" ? report.currency : "",
      metric.definition,
      report.source?.name || "",
      report.source?.syncedAt || ""
    ]);
    rows.push([
      "comparison_previous",
      metric.id,
      metric.label,
      `preceding ${report.comparison.rangeDays} days`,
      metric.previous,
      metric.format === "currency" ? report.currency : "",
      metric.definition,
      report.source?.name || "",
      report.source?.syncedAt || ""
    ]);
  }
  for (const observation of report.comparison?.observations || []) {
    rows.push([
      "observation",
      "",
      "Bounded comparison observation",
      `${report.comparison.rangeDays} days`,
      "",
      "",
      observation,
      report.source?.name || "",
      report.source?.syncedAt || ""
    ]);
  }
  for (const metric of report.unavailableMetrics) {
    rows.push([
      "unavailable",
      metric.id,
      metric.label,
      "",
      "",
      "",
      metric.reason,
      report.source?.name || "",
      report.source?.syncedAt || ""
    ]);
  }
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

module.exports = { analyticsReportCsv, buildAnalyticsReport };
