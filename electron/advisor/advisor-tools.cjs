const { AppError } = require("../errors.cjs");
const { boundedInteger, boundedString, requireId } = require("../validation.cjs");

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
    name: "get_analytics_summary",
    description:
      "Read defined Shopify aggregates, source freshness, and a bounded equal-window comparison for the currently selected business.",
    inputSchema: {
      type: "object",
      properties: { rangeDays: { type: "integer", enum: [7, 30, 60] } },
      additionalProperties: false
    }
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
    name: "get_media_job_details",
    description: "Read safe details for one local media job without protected paths.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string", minLength: 1, maxLength: 128 } },
      required: ["jobId"],
      additionalProperties: false
    }
  },
  {
    name: "get_media_candidate_details",
    description: "Read safe suggestion, edit, and score details for one clip candidate.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", minLength: 1, maxLength: 128 },
        candidateId: { type: "string", minLength: 1, maxLength: 128 }
      },
      required: ["jobId", "candidateId"],
      additionalProperties: false
    }
  },
  {
    name: "get_clip_library_summary",
    description: "Read aggregate Clip Library counts and statuses without filesystem paths.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_clip_library_item_details",
    description: "Read safe metadata for one Clip Library item without a filesystem path.",
    inputSchema: {
      type: "object",
      properties: { clipId: { type: "string", minLength: 1, maxLength: 128 } },
      required: ["clipId"],
      additionalProperties: false
    }
  },
  {
    name: "get_current_project",
    description: "Read safe metadata and edit-plan counts for the selected local project.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", minLength: 1, maxLength: 128 } },
      required: ["projectId"],
      additionalProperties: false
    }
  },
  {
    name: "get_project_render_readiness",
    description: "Explain whether a local project is ready for human-approved rendering.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", minLength: 1, maxLength: 128 } },
      required: ["projectId"],
      additionalProperties: false
    }
  },
  {
    name: "get_project_job_failure",
    description: "Read a normalized failure for one project media job without protected paths.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", minLength: 1, maxLength: 128 } },
      required: ["projectId"],
      additionalProperties: false
    }
  },
  {
    name: "explain_current_error",
    description: "Read the current normalized ProduDash application error supplied by the visible renderer context.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_provider_setup_guidance",
    description: "Read provider and workload readiness from public local configuration.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "search_produdash_help",
    description: "Search a small built-in ProduDash help index.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 120 } },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "recommend_next_setup_step",
    description: "Recommend one setup step using only verified local connection state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
]);

const TOOL_NAMES = new Set(ADVISOR_TOOL_DEFINITIONS.map((tool) => tool.name));
const VIEW_NAMES = new Set(["overview", "inbox", "orders", "signals", "studio", "analytics", "integrations"]);
const RECORD_TYPES = new Set(["business", "conversation", "clip", "media_job", "candidate", "project"]);
const HELP_INDEX = Object.freeze([
  {
    id: "shopify-setup",
    title: "Connect Shopify",
    text: "Use a Shopify custom-app Admin token. Credentials stored is not the same as a verified connected status."
  },
  {
    id: "ai-setup",
    title: "Connect an AI provider",
    text: "Save credentials, validate the provider, choose a compatible model, and assign each workload explicitly."
  },
  {
    id: "clip-review",
    title: "Review clip candidates",
    text: "Save non-destructive timing and presentation edits, explicitly select candidates, then approve rendering."
  },
  {
    id: "captions",
    title: "Timed captions",
    text: "Timed captions come from a timestamped transcript. A manual fallback creates an intentional single cue."
  },
  {
    id: "analytics",
    title: "Verified analytics",
    text: "Shopify analytics use bounded imported orders with visible definitions and 7, 30, or 60-day equal-window comparisons. They do not prove causation."
  },
  {
    id: "privacy",
    title: "Local privacy",
    text: "Media stays local unless a per-job cloud disclosure is confirmed. ProduDash never gives Juanito write access."
  }
]);

function assertPlainInput(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "Advisor tool input is invalid.");
  }
  return value;
}

// Takes an already-read state rather than reading its own. getAppState deep
// clones every plan, media job and conversation, and this used to be one of
// three such reads per tool call -- at five calls a round and five rounds, that
// is dozens of full-workspace clones on the main thread for a single question.
function businessFromContext(state, context) {
  if (!context.businessId) return null;
  const businessId = requireId(context.businessId, "Business");
  const business = state.businesses.find((item) => item.id === businessId);
  if (!business) throw new AppError("BUSINESS_NOT_FOUND", "The selected business is unavailable.");
  return business;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeContext(value, store, knownState = null) {
  const context = assertPlainInput(value);
  const state = knownState || store.getAppState();
  const view = VIEW_NAMES.has(context.view) ? context.view : "overview";
  const businessId = context.businessId ? requireId(context.businessId, "Business") : null;
  if (businessId && !state.businesses.some((business) => business.id === businessId)) {
    throw new AppError("BUSINESS_NOT_FOUND", "The selected business is unavailable.");
  }
  let selectedRecord =
    context.selectedRecord &&
    typeof context.selectedRecord === "object" &&
    !Array.isArray(context.selectedRecord) &&
    RECORD_TYPES.has(context.selectedRecord.type)
      ? { type: context.selectedRecord.type, id: requireId(context.selectedRecord.id, "Selected record") }
      : null;
  if (selectedRecord?.type === "business" && selectedRecord.id !== businessId) selectedRecord = null;
  if (
    selectedRecord?.type === "conversation" &&
    !state.conversations?.some((conversation) => conversation.id === selectedRecord.id && conversation.businessId === businessId)
  ) {
    selectedRecord = null;
  }
  if (selectedRecord?.type === "media_job" && !state.mediaJobs?.some((job) => job.id === selectedRecord.id)) selectedRecord = null;
  if (
    selectedRecord?.type === "candidate" &&
    !state.mediaJobs?.some((job) => job.candidates?.some((candidate) => candidate.id === selectedRecord.id))
  ) {
    selectedRecord = null;
  }
  const safeError =
    typeof context.safeError === "string"
      ? context.safeError
          .slice(0, 500)
          .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted email]")
          .replace(/\b(?:shpat_|AIza)[a-zA-Z0-9_-]+\b/g, "[redacted credential]")
      : null;
  return { view, businessId, selectedRecord, safeError };
}

function createAdvisorTools({ store, mediaLibrary, projects = null }) {
  async function execute(name, rawInput, rawContext) {
    if (!TOOL_NAMES.has(name)) throw new AppError("ADVISOR_TOOL_NOT_ALLOWED", "That Advisor tool is not allowed.");
    const input = assertPlainInput(rawInput);
    // Read once and shared. These three lines used to take three independent
    // deep clones of the whole workspace for every tool call.
    const state = store.getAppState();
    const context = normalizeContext(rawContext, store, state);
    const business = businessFromContext(state, context);

    if (["get_current_project", "get_project_render_readiness", "get_project_job_failure"].includes(name)) {
      if (!projects || Object.keys(input).some((key) => key !== "projectId")) {
        throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "Project tool input is invalid.");
      }
      const project = projects.get(requireId(input.projectId, "Project"));
      if (project.businessId && project.businessId !== context.businessId) {
        throw new AppError("PROJECT_NOT_FOUND", "The selected project is unavailable in this business context.");
      }
      if (name === "get_current_project") {
        return {
          id: project.id,
          title: String(project.title).slice(0, 120),
          status: project.status,
          sourceStatus: project.source.status,
          duration: safeNumber(project.duration),
          segmentCount: project.segmentCount,
          transcriptCount: project.transcriptCount,
          revision: project.revision,
          savedRevision: project.savedRevision,
          prepared: project.prepared
        };
      }
      if (name === "get_project_render_readiness") {
        const reasons = [];
        if (project.source.status !== "available") reasons.push("The source must be relinked.");
        if (!project.prepared) reasons.push("Local waveform and scene preparation has not completed.");
        if (project.duration < 5) reasons.push("The edited duration must be at least five seconds.");
        return {
          projectId: project.id,
          ready: reasons.length === 0,
          humanApprovalRequired: true,
          reasons,
          currentRevision: project.revision,
          unsavedDraft: project.revision !== project.savedRevision
        };
      }
      const failed = state.mediaJobs.find((job) => job.projectId === project.id && ["failed", "interrupted"].includes(job.status));
      return failed
        ? {
            projectId: project.id,
            jobId: failed.id,
            jobType: failed.jobType,
            status: failed.status,
            stage: failed.stage,
            retryable: failed.retryable === true,
            error: typeof failed.error === "string" ? failed.error.slice(0, 300) : "The local job needs attention."
          }
        : { projectId: project.id, failedJob: null };
    }

    if (name === "get_current_view_context") {
      if (Object.keys(input).length) throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "This Advisor tool accepts no input.");
      return {
        view: context.view,
        businessId: context.businessId,
        businessSelected: Boolean(business),
        selectedRecord: context.selectedRecord
      };
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

    if (name === "get_analytics_summary") {
      if (Object.keys(input).some((key) => key !== "rangeDays")) {
        throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "Analytics summary input is invalid.");
      }
      if (!business) return { businessSelected: false, message: "No connected business is selected." };
      const report = store.getAnalyticsReport(business.id, input.rangeDays);
      return {
        businessSelected: true,
        businessId: report.businessId,
        status: report.status,
        currency: report.currency,
        source: {
          id: report.source.id,
          status: report.source.status,
          syncedAt: report.source.syncedAt,
          freshness: {
            status: report.source.freshness.status,
            label: report.source.freshness.label
          },
          recordLimit: report.source.recordLimit,
          limitation: report.source.windowNote
        },
        metrics: report.metrics.slice(0, 8).map((metric) => ({
          id: metric.id,
          label: metric.label,
          value: safeNumber(metric.value),
          format: metric.format,
          definition: metric.definition
        })),
        comparison: report.comparison
          ? {
              rangeDays: report.comparison.rangeDays,
              anchorAt: report.comparison.anchorAt,
              periods: report.comparison.periods,
              datedOrderCount: report.comparison.datedOrderCount,
              undatedOrderCount: report.comparison.undatedOrderCount,
              completeness: report.comparison.completeness,
              limitation: report.comparison.limitation,
              metrics: report.comparison.metrics.slice(0, 8).map((metric) => ({
                id: metric.id,
                label: metric.label,
                current: safeNumber(metric.current),
                previous: safeNumber(metric.previous),
                delta: safeNumber(metric.delta),
                deltaPercent: safeNumber(metric.deltaPercent),
                format: metric.format
              })),
              observations: report.comparison.observations.slice(0, 3).map((observation) => String(observation).slice(0, 500))
            }
          : null,
        unavailableMetrics: report.unavailableMetrics.slice(0, 8).map((metric) => ({
          id: metric.id,
          label: metric.label,
          reason: metric.reason
        })),
        evidenceNote:
          "These values describe the bounded local Shopify snapshot. They are not causal findings, forecasts, or creator-platform performance."
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

    if (name === "get_media_job_details") {
      if (Object.keys(input).some((key) => key !== "jobId")) {
        throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "Media job detail input is invalid.");
      }
      const jobId = requireId(input.jobId, "Media job");
      const job = state.mediaJobs.find((item) => item.id === jobId);
      if (!job) throw new AppError("MEDIA_JOB_NOT_FOUND", "Media job not found.");
      return {
        id: job.id,
        title: String(job.title || "").slice(0, 120),
        status: String(job.status || "unknown").slice(0, 40),
        stage: String(job.stage || "unknown").slice(0, 40),
        progress: Math.max(0, Math.min(100, safeNumber(job.progress) || 0)),
        candidateCount: Array.isArray(job.candidates) ? job.candidates.length : 0,
        selectedCandidateIds: (Array.isArray(job.selectedCandidateIds) ? job.selectedCandidateIds : []).slice(0, 20),
        warnings: (Array.isArray(job.warnings) ? job.warnings : []).slice(0, 10).map((warning) => String(warning).slice(0, 300)),
        error: typeof job.error === "string" ? job.error.slice(0, 300) : null,
        artifactCount: Array.isArray(job.artifacts) ? job.artifacts.length : 0,
        createdAt: typeof job.createdAt === "string" ? job.createdAt.slice(0, 40) : null,
        updatedAt: typeof job.updatedAt === "string" ? job.updatedAt.slice(0, 40) : null
      };
    }

    if (name === "get_media_candidate_details") {
      if (Object.keys(input).some((key) => !["jobId", "candidateId"].includes(key))) {
        throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "Media candidate detail input is invalid.");
      }
      const jobId = requireId(input.jobId, "Media job");
      const candidateId = requireId(input.candidateId, "Clip candidate");
      const job = state.mediaJobs.find((item) => item.id === jobId);
      const candidate = job?.candidates?.find((item) => item.id === candidateId);
      if (!candidate) throw new AppError("CANDIDATE_NOT_FOUND", "Clip candidate not found.");
      return {
        jobId,
        id: candidate.id,
        suggestion: {
          title: String(candidate.original?.title || candidate.title || "").slice(0, 120),
          start: safeNumber(candidate.original?.start ?? candidate.start),
          end: safeNumber(candidate.original?.end ?? candidate.end)
        },
        edit: candidate.edit
          ? {
              title: String(candidate.edit.title || "").slice(0, 120),
              start: safeNumber(candidate.edit.start),
              end: safeNumber(candidate.edit.end),
              captionCueCount: Array.isArray(candidate.edit.captionSegments) ? candidate.edit.captionSegments.length : 0,
              aspectTreatment: String(candidate.edit.aspectTreatment || "unknown").slice(0, 40),
              targetAspect: String(candidate.edit.targetAspect || "unknown").slice(0, 40)
            }
          : null,
        confidence: safeNumber(candidate.confidence),
        scores: Object.fromEntries(
          Object.entries(candidate.scores && typeof candidate.scores === "object" ? candidate.scores : {})
            .slice(0, 12)
            .map(([key, value]) => [String(key).slice(0, 40), safeNumber(value)])
        ),
        rationale: String(candidate.rationale || "").slice(0, 500)
      };
    }

    if (name === "get_clip_library_item_details") {
      if (Object.keys(input).some((key) => key !== "clipId")) {
        throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "Clip detail input is invalid.");
      }
      const clip = mediaLibrary.getClipSummary(requireId(input.clipId, "Clip"));
      return {
        id: clip.id,
        name: String(clip.name || "").slice(0, 200),
        status: String(clip.status || "unknown").slice(0, 40),
        duration: safeNumber(clip.duration),
        width: safeNumber(clip.width),
        height: safeNumber(clip.height),
        codec: String(clip.codec || "unknown").slice(0, 80),
        tags: (Array.isArray(clip.tags) ? clip.tags : []).slice(0, 20).map((tag) => String(tag).slice(0, 40)),
        error: typeof clip.error === "string" ? clip.error.slice(0, 300) : null
      };
    }

    if (name === "explain_current_error") {
      if (Object.keys(input).length) throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "This Advisor tool accepts no input.");
      return context.safeError
        ? {
            present: true,
            message: context.safeError,
            note: "This is normalized application text and may contain untrusted imported wording."
          }
        : { present: false, message: "No safe application error is currently visible." };
    }

    if (name === "get_provider_setup_guidance") {
      if (Object.keys(input).length) throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "This Advisor tool accepts no input.");
      return {
        providers: state.aiProviders.slice(0, 20).map((profile) => ({
          id: profile.id,
          name: String(profile.name || profile.id).slice(0, 100),
          status: String(profile.status || "unknown").slice(0, 40),
          credentialStatus: profile.credentialStatus === "stored" ? "stored" : "missing",
          selectedModelId: typeof profile.selectedModelId === "string" ? profile.selectedModelId.slice(0, 200) : null
        })),
        workloads: Object.fromEntries(
          Object.entries(state.aiWorkloads && typeof state.aiWorkloads === "object" ? state.aiWorkloads : {})
            .slice(0, 10)
            .map(([id, assignment]) => [
              String(id).slice(0, 40),
              {
                mode: String(assignment?.mode || "unassigned").slice(0, 40),
                profileId: typeof assignment?.profileId === "string" ? assignment.profileId.slice(0, 128) : null,
                modelId: typeof assignment?.modelId === "string" ? assignment.modelId.slice(0, 200) : null
              }
            ])
        )
      };
    }

    if (name === "search_produdash_help") {
      if (Object.keys(input).some((key) => key !== "query")) {
        throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "Help search input is invalid.");
      }
      const query = boundedString(input.query, { label: "Help query", min: 1, max: 120 }).toLowerCase();
      const terms = query.split(/\s+/).filter((term) => term.length > 1);
      return {
        query,
        results: HELP_INDEX.filter((entry) => terms.some((term) => `${entry.title} ${entry.text}`.toLowerCase().includes(term))).slice(0, 5)
      };
    }

    if (name === "recommend_next_setup_step") {
      if (Object.keys(input).length) throw new AppError("INVALID_ADVISOR_TOOL_INPUT", "This Advisor tool accepts no input.");
      const shopify = state.integrations.find((integration) => integration.id === "shopify");
      if (shopify?.status !== "connected") {
        return { step: "connect_shopify", reason: "Shopify has not been verified as connected." };
      }
      const connectedProvider = state.aiProviders.find((profile) => profile.status === "connected");
      if (!connectedProvider) return { step: "connect_ai_provider", reason: "No AI provider is verified as connected." };
      const unassigned = Object.entries(state.aiWorkloads || {}).find(([, assignment]) => assignment?.mode === "unassigned");
      if (unassigned) return { step: "assign_workload", workloadId: unassigned[0], reason: "A workload is still unassigned." };
      return { step: "review_workspace", reason: "The essential verified connections and workload assignments are ready." };
    }

    if (name === "get_clip_library_summary") {
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
    throw new AppError("ADVISOR_TOOL_NOT_ALLOWED", "That Advisor tool is not allowed.");
  }

  return { definitions: structuredClone(ADVISOR_TOOL_DEFINITIONS), execute, normalizeContext };
}

module.exports = { ADVISOR_TOOL_DEFINITIONS, TOOL_NAMES, createAdvisorTools, normalizeContext };
