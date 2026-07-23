const { AppError } = require("../errors.cjs");
const { boundedInteger, requireId } = require("../validation.cjs");

const ADVISOR_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "get_current_view_context",
    description: "Read the current ProduDash section and selected business identifier.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_business_overview",
    description: "Read bounded commerce totals and supported metrics for the currently selected business.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_recent_orders_summary",
    description: "Read a bounded order-status summary without customer identity or address data.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
      additionalProperties: false
    }
  },
  {
    name: "get_attention_items",
    description: "Read bounded approval and operational attention counts without raw customer messages.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_integration_health",
    description: "Read public connection status and validation timestamps without credentials or raw provider errors.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_media_job_summary",
    description: "Read bounded local media-job statuses for the current workspace.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
      additionalProperties: false
    }
  },
  {
    name: "get_clip_library_summary",
    description: "Read aggregate Clip Library counts and statuses without filesystem paths.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
]);

const TOOL_NAMES = new Set(ADVISOR_TOOL_DEFINITIONS.map((tool) => tool.name));
const VIEW_NAMES = new Set(["overview", "inbox", "orders", "signals", "studio", "analytics", "integrations"]);

function assertPlainInput(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "Advisor tool input is invalid.");
  }
  return value;
}

function businessFromContext(store, context) {
  if (!context.businessId) return null;
  const businessId = requireId(context.businessId, "Business");
  const business = store.getAppState().businesses.find((item) => item.id === businessId);
  if (!business) throw new AppError("BUSINESS_NOT_FOUND", "The selected business is unavailable.");
  return business;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeContext(value, store) {
  const context = assertPlainInput(value);
  const view = VIEW_NAMES.has(context.view) ? context.view : "overview";
  const businessId = context.businessId ? requireId(context.businessId, "Business") : null;
  if (businessId && !store.getAppState().businesses.some((business) => business.id === businessId)) {
    throw new AppError("BUSINESS_NOT_FOUND", "The selected business is unavailable.");
  }
  return { view, businessId };
}

function createAdvisorTools({ store, mediaLibrary }) {
  async function execute(name, rawInput, rawContext) {
    if (!TOOL_NAMES.has(name)) throw new AppError("ADVISOR_TOOL_NOT_ALLOWED", "That Advisor tool is not allowed.");
    const input = assertPlainInput(rawInput);
    const context = normalizeContext(rawContext, store);
    const state = store.getAppState();
    const business = businessFromContext(store, context);

    if (name === "get_current_view_context") {
      if (Object.keys(input).length) throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "This Advisor tool accepts no input.");
      return { view: context.view, businessId: context.businessId, businessSelected: Boolean(business) };
    }

    if (name === "get_business_overview") {
      if (Object.keys(input).length) throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "This Advisor tool accepts no input.");
      if (!business) return { businessSelected: false, message: "No connected business is selected." };
      return {
        businessSelected: true,
        businessId: business.id,
        connectionStatus: business.connectionStatus || "unknown",
        currency: typeof business.currency === "string" ? business.currency.slice(0, 3) : "USD",
        metrics: {
          revenue: safeNumber(business.metrics?.revenue),
          orders: safeNumber(business.metrics?.orderCount),
          averageOrderValue:
            safeNumber(business.metrics?.orderCount) > 0 && safeNumber(business.metrics?.revenue) !== null
              ? safeNumber(business.metrics.revenue) / safeNumber(business.metrics.orderCount)
              : null,
          profit: null,
          conversion: null
        }
      };
    }

    if (name === "get_recent_orders_summary") {
      const limit = boundedInteger(input.limit, { label: "Order limit", min: 1, max: 20, fallback: 10 });
      if (Object.keys(input).some((key) => key !== "limit")) {
        throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "Order summary input is invalid.");
      }
      const orders = Array.isArray(business?.orders) ? business.orders.slice(0, limit) : [];
      return {
        businessId: business?.id || null,
        count: orders.length,
        orders: orders.map((order) => ({
          id: typeof order.id === "string" ? order.id.slice(0, 128) : "unknown",
          total: safeNumber(order.value),
          currency: typeof order.currency === "string" ? order.currency.slice(0, 3) : business?.currency || "USD",
          paymentStatus: String(order.paymentStatus || "unknown").slice(0, 80),
          fulfillmentStatus: String(order.fulfillmentStatus || "unknown").slice(0, 80),
          createdAt: typeof order.createdAt === "string" ? order.createdAt.slice(0, 40) : null
        }))
      };
    }

    if (name === "get_attention_items") {
      if (Object.keys(input).length) throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "This Advisor tool accepts no input.");
      const approvals = state.approvals.filter((item) => item.businessId === context.businessId && item.status === "pending");
      const signals = Array.isArray(business?.signals) ? business.signals : [];
      const signalLevels = {};
      for (const signal of signals.slice(0, 100)) {
        const level = String(signal.level || "warning")
          .toLowerCase()
          .slice(0, 40);
        signalLevels[level] = (signalLevels[level] || 0) + 1;
      }
      return {
        businessId: context.businessId,
        pendingApprovals: approvals.length,
        signalCount: signals.length,
        signalLevels
      };
    }

    if (name === "get_integration_health") {
      if (Object.keys(input).length) throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "This Advisor tool accepts no input.");
      return {
        integrations: state.integrations.slice(0, 20).map((integration) => ({
          id: integration.id,
          name: String(integration.name || integration.id).slice(0, 100),
          status: String(integration.status || "unknown").slice(0, 40),
          lastSync: typeof integration.lastSync === "string" ? integration.lastSync.slice(0, 80) : null
        })),
        providers: state.aiProviders.slice(0, 20).map((profile) => ({
          id: profile.id,
          name: String(profile.name || profile.id).slice(0, 100),
          status: String(profile.status || "unknown").slice(0, 40),
          modelId: typeof profile.selectedModelId === "string" ? profile.selectedModelId.slice(0, 200) : null,
          lastValidatedAt: typeof profile.lastValidatedAt === "string" ? profile.lastValidatedAt.slice(0, 40) : null
        }))
      };
    }

    if (name === "get_media_job_summary") {
      const limit = boundedInteger(input.limit, { label: "Media job limit", min: 1, max: 20, fallback: 10 });
      if (Object.keys(input).some((key) => key !== "limit")) {
        throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "Media job summary input is invalid.");
      }
      return {
        count: state.mediaJobs.length,
        jobs: state.mediaJobs.slice(0, limit).map((job) => ({
          id: job.id,
          status: String(job.status || "unknown").slice(0, 40),
          stage: String(job.stage || "unknown").slice(0, 40),
          progress: Math.max(0, Math.min(100, safeNumber(job.progress) || 0)),
          warningCount: Array.isArray(job.warnings) ? job.warnings.length : 0
        }))
      };
    }

    const library = await mediaLibrary.query({ offset: 0, limit: 1 });
    if (Object.keys(input).length) throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "This Advisor tool accepts no input.");
    const statusCounts = {};
    for (const clip of mediaLibrary.index?.clips || []) {
      const status = String(clip.status || "unknown").slice(0, 40);
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }
    return {
      clipCount: Number(library.total) || 0,
      folderCount: Array.isArray(library.folders) ? library.folders.length : 0,
      statusCounts
    };
  }

  return { definitions: structuredClone(ADVISOR_TOOL_DEFINITIONS), execute, normalizeContext };
}

module.exports = { ADVISOR_TOOL_DEFINITIONS, TOOL_NAMES, createAdvisorTools, normalizeContext };
