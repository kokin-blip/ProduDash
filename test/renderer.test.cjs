const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("node:url");

const projectRoot = path.join(__dirname, "..");
let rendererModules;

async function setupRenderer() {
  const html = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "file:///produdash/index.html" });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  dom.window.requestAnimationFrame = (callback) => callback();
  rendererModules ||= Promise.all([
    import(pathToFileURL(path.join(projectRoot, "src/renderer/state.js")).href),
    import(pathToFileURL(path.join(projectRoot, "src/renderer/render.js")).href),
    import(pathToFileURL(path.join(projectRoot, "src/renderer/format.js")).href)
  ]);
  const [stateModule, renderModule, formatModule] = await rendererModules;
  stateModule.ui.activeSection = "overview";
  stateModule.ui.studioTab = "library";
  stateModule.ui.error = null;
  stateModule.ui.pending.clear();
  stateModule.ui.advisorOpen = false;
  stateModule.ui.advisorRequest = null;
  stateModule.ui.advisorStatus = "idle";
  stateModule.ui.advisorToolName = null;
  stateModule.ui.advisorError = null;
  stateModule.ui.mediaOutputSelection = null;
  stateModule.ui.localVoiceReport = null;
  stateModule.ui.analyticsReport = null;
  stateModule.ui.analyticsRangeDays = 30;
  stateModule.ui.brandAssets = [];
  stateModule.setAdvisorHistory({
    turns: [],
    status: { ready: false, providerId: null, modelId: null, consentedCategories: [] }
  });
  stateModule.ui.providerCatalog = [
    {
      id: "gemini",
      name: "Google Gemini",
      credentialFields: [{ key: "apiKey", label: "Gemini API key", placeholder: "AIza…", sensitive: true }]
    }
  ];
  stateModule.setClipLibrary({ folders: [], clips: [], total: 0, offset: 0, limit: 40, notices: [] });
  stateModule.setProjects({ projects: [], collections: [], total: 0, notices: [] });
  stateModule.setActiveProject(null);
  return { dom, ...stateModule, ...renderModule, ...formatModule };
}

function baseState(overrides = {}) {
  return {
    schemaVersion: 7,
    businesses: [],
    conversations: [],
    approvals: [],
    integrations: [],
    credentialSettings: [],
    aiProviders: [
      {
        id: "gemini",
        providerType: "gemini",
        name: "Google Gemini",
        status: "disconnected",
        credentialStatus: "missing",
        selectedModelId: "gemini-3.6-flash",
        models: [
          {
            id: "gemini-3.6-flash",
            name: "Gemini 3.6 Flash",
            capabilities: ["text_generation", "structured_output", "streaming"]
          }
        ]
      }
    ],
    aiWorkloads: {
      advisor: { mode: "provider", profileId: "gemini", modelId: "gemini-3.6-flash" },
      inboxDrafting: { mode: "provider", profileId: "gemini", modelId: "gemini-3.6-flash" },
      clipAnalysis: { mode: "same_as_advisor" },
      transcription: { mode: "unassigned" }
    },
    advisorSettings: { displayName: "Juanito" },
    creatorPlatforms: [],
    analyticsSources: [],
    clipperJobs: [],
    postQueue: [],
    auditLog: [],
    systemNotices: [],
    ...overrides
  };
}

function partialBusiness(overrides = {}) {
  return {
    id: "business-1",
    name: "Store",
    type: "Shopify store",
    category: "Connected",
    health: "Connected",
    connectionStatus: "connected",
    currency: "USD",
    metrics: {},
    financeTrend: [],
    orders: [],
    signals: [],
    ...overrides
  };
}

test("renderer shows a connection-required state with no businesses", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(baseState());
  renderer.renderApp();
  assert.equal(document.querySelector("#pageTitle").textContent, "Set up ProduDash");
  assert.match(document.querySelector("#viewRoot").textContent, /Connect the essentials/i);
  assert.match(document.querySelector("#viewRoot").textContent, /Human approval required/i);
  assert.equal(document.querySelector('[data-section="integrations"]:disabled').textContent.trim(), "Connect AI provider");
  assert.ok(document.querySelector("details.disclosure"));
});

test("partial business data and an empty finance trend do not crash", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(baseState({ businesses: [partialBusiness({ metrics: { revenue: 42, profit: null, conversion: null } })] }));
  renderer.renderApp();
  assert.match(document.querySelector("#viewRoot").textContent, /No dated revenue/i);
  assert.match(document.querySelector("#viewRoot").textContent, /Unavailable/i);
  assert.doesNotMatch(document.querySelector("#viewRoot").textContent, /\$0/);
});

test("inbox safely renders conversations without an order draft", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      businesses: [partialBusiness()],
      conversations: [
        {
          id: "conversation-1",
          businessId: "business-1",
          customer: "Customer",
          channel: "Instagram",
          intent: "Support",
          risk: "Human review",
          status: "open",
          messages: [],
          orderDraft: null
        }
      ]
    })
  );
  renderer.ui.activeSection = "inbox";
  renderer.renderApp();
  assert.match(document.querySelector("#viewRoot").textContent, /No order detected/i);
});

test("malicious connector strings render as text rather than elements", async () => {
  const renderer = await setupRenderer();
  const payload = `<img src=x onerror="window.pwned=true">`;
  renderer.setAppState(baseState({ businesses: [partialBusiness({ name: payload })] }));
  renderer.renderApp();
  assert.equal(document.querySelector("#viewRoot img, #businessStrip img"), null);
  assert.equal(window.pwned, undefined);
  assert.match(document.querySelector("#pageTitle").textContent, /<img src=x/);
});

test("invalid audit dates render a safe fallback", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      businesses: [partialBusiness()],
      auditLog: [{ id: "audit-1", at: "not-a-date", type: "test", detail: "Safe" }]
    })
  );
  renderer.ui.activeSection = "signals";
  renderer.renderApp();
  assert.match(document.querySelector("#viewRoot").textContent, /Unknown date/);
});

test("stored Shopify credentials remain distinct from a verified connection", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      integrations: [
        { id: "shopify", name: "Shopify", status: "disconnected" },
        { id: "gemini", name: "Gemini", status: "disconnected" }
      ],
      credentialSettings: [
        { id: "shopify", name: "Shopify", status: "stored", fields: [] },
        { id: "gemini", name: "Gemini", status: "missing", fields: [] }
      ]
    })
  );
  renderer.renderApp();
  assert.match(document.querySelector("#viewRoot").textContent, /Needs verification/i);
  assert.doesNotMatch(document.querySelector("#viewRoot").textContent, /Store identity and recent commerce data were verified/i);
});

test("assigned AI provider setup action unlocks only after Shopify is connected", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      integrations: [{ id: "shopify", name: "Shopify", status: "connected" }],
      credentialSettings: [{ id: "shopify", name: "Shopify", status: "stored", fields: [] }]
    })
  );
  renderer.renderApp();
  const providerStep = [...document.querySelectorAll(".setup-step")].find((item) => /Connect Google Gemini/i.test(item.textContent));
  assert.equal(providerStep.querySelector("button").disabled, false);
});

test("connected dashboard uses supported metrics, semantic orders, and a compact all-clear state", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      businesses: [
        partialBusiness({
          metrics: { revenue: 60, orderCount: 2, profit: null, conversion: null },
          financeTrend: [{ week: "Jul 1", revenue: 60 }],
          orders: [
            {
              id: "#1001",
              customer: "Alex",
              paymentStatus: "paid",
              fulfillmentStatus: "fulfilled",
              value: 20,
              currency: "USD"
            },
            {
              id: "#1002",
              customer: "Sam",
              paymentStatus: "paid",
              fulfillmentStatus: "unfulfilled",
              value: 40,
              currency: "USD"
            }
          ]
        })
      ]
    })
  );
  renderer.renderApp();
  assert.match(document.querySelector(".attention-section").textContent, /All clear/i);
  assert.equal(document.querySelectorAll(".metric-card").length, 4);
  assert.match(document.querySelector(".metric-grid").textContent, /Average order value/i);
  assert.equal(document.querySelectorAll("table tbody tr").length, 2);
  assert.match(document.querySelector(".availability-note").textContent, /Profit and conversion are unavailable/i);
});

test("page header follows the active section", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(baseState());
  renderer.ui.activeSection = "analytics";
  renderer.renderApp();
  assert.equal(document.querySelector("#pageEyebrow").textContent, "Analytics");
  assert.equal(document.querySelector("#pageTitle").textContent, "Verified commerce reporting");
  assert.match(document.querySelector("#pageSubtitle").textContent, /supported Shopify metrics/i);
});

test("Analytics renders only evidence-backed Shopify metrics, freshness, and safe export controls", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      businesses: [partialBusiness({ id: "business-analytics", name: "Verified store", source: "shopify" })],
      analyticsSources: [{ id: "youtube", name: `<img src=x onerror="window.analyticsPwned=1">`, status: "planned", metrics: ["views"] }]
    })
  );
  renderer.ui.analyticsReport = {
    businessId: "business-analytics",
    businessName: `<script>unsafe()</script>`,
    status: "connected",
    currency: "USD",
    source: {
      name: "Shopify Admin API",
      status: "connected",
      syncedAt: "2026-07-25T10:00:00.000Z",
      freshness: { status: "current", label: "Updated within 24 hours" },
      windowNote: "Up to 100 recent orders."
    },
    metrics: [
      { id: "revenue", label: "Imported revenue", value: 100, format: "currency", definition: "Imported totals." },
      { id: "orders", label: "Imported orders", value: 2, format: "integer", definition: "Imported count." },
      { id: "average_order_value", label: "Average order value", value: 50, format: "currency", definition: "Revenue / orders." },
      { id: "fulfillment_rate", label: "Fulfillment rate", value: 50, format: "percent", definition: "Fulfilled share." }
    ],
    trend: [{ period: "Jul 20", revenue: 100 }],
    comparison: {
      rangeDays: 30,
      limitation: "Bounded local snapshot.",
      metrics: [
        {
          id: "revenue",
          label: "Imported revenue",
          current: 100,
          previous: 80,
          delta: 20,
          deltaPercent: 25,
          format: "currency"
        },
        { id: "orders", label: "Imported orders", current: 2, previous: 1, delta: 1, deltaPercent: 100, format: "integer" },
        {
          id: "average_order_value",
          label: "Average order value",
          current: 50,
          previous: 80,
          delta: -30,
          deltaPercent: -37.5,
          format: "currency"
        },
        {
          id: "fulfillment_rate",
          label: "Fulfillment rate",
          current: 50,
          previous: 0,
          delta: 50,
          deltaPercent: null,
          format: "percent"
        }
      ],
      observations: ["Imported revenue was higher based on bounded order records."]
    },
    unavailableMetrics: [
      { id: "profit", label: "Profit", reason: "Costs are not connected." },
      { id: "social_performance", label: "Social performance", reason: "Official connectors are not implemented." }
    ]
  };
  renderer.ui.activeSection = "analytics";
  renderer.renderApp();
  assert.equal(document.querySelectorAll(".analytics-metric").length, 4);
  assert.equal(document.querySelectorAll(".analytics-trend table tbody tr").length, 1);
  assert.ok(document.querySelector("[data-export-analytics='business-analytics']"));
  assert.equal(document.querySelector("[data-analytics-range-form] select").value, "30");
  assert.equal(document.querySelectorAll(".analytics-comparison tbody tr").length, 4);
  assert.match(document.querySelector(".analytics-observations").textContent, /not causal explanations or forecasts/i);
  assert.match(document.querySelector(".analytics-source-row").textContent, /Updated within 24 hours/);
  assert.match(document.querySelector(".availability-note").textContent, /Costs are not connected/);
  assert.equal(document.querySelector(".analytics-report script, .analytics-view img"), null);
  assert.equal(window.analyticsPwned, undefined);
  assert.doesNotMatch(document.querySelector(".analytics-report").textContent, /views|likes|followers/i);
});

test("navigation updates its persistent indicator and uses the no-API entry fallback", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(baseState());
  renderer.ui.activeSection = "analytics";
  renderer.renderApp({ animateView: true });
  assert.equal(document.querySelector(".nav-list").dataset.activeSection, "analytics");
  assert.equal(document.querySelector('[data-section="analytics"]').getAttribute("aria-current"), "page");
  assert.ok(document.querySelector("#viewRoot .view-transition.is-entering"));

  renderer.renderApp();
  assert.equal(document.querySelector("#viewRoot .view-transition.is-entering"), null);
});

test("rapid native view transitions skip stale renders and keep the latest section", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(baseState());
  renderer.renderApp();
  const updates = [];
  const transitions = [];
  document.startViewTransition = (update) => {
    const transition = {
      finished: Promise.resolve(),
      skipped: false,
      skipTransition() {
        this.skipped = true;
      }
    };
    updates.push(update);
    transitions.push(transition);
    return transition;
  };

  renderer.ui.activeSection = "analytics";
  renderer.renderApp({ animateView: true });
  renderer.ui.activeSection = "studio";
  renderer.renderApp({ animateView: true });
  assert.equal(transitions[0].skipped, true);

  updates[0]();
  assert.equal(document.querySelector("#pageTitle").textContent, "Set up ProduDash");
  updates[1]();
  assert.equal(document.querySelector("#pageTitle").textContent, "Local media workspace");
  assert.equal(document.querySelector(".nav-list").dataset.activeSection, "studio");
});

test("keyed setup status badges animate only when their real value changes", async () => {
  const renderer = await setupRenderer();
  const credentialSettings = [{ id: "shopify", name: "Shopify", status: "stored", fields: [] }];
  renderer.setAppState(
    baseState({
      integrations: [{ id: "shopify", name: "Shopify", status: "disconnected" }],
      credentialSettings
    })
  );
  renderer.renderApp();
  renderer.setAppState(
    baseState({
      integrations: [{ id: "shopify", name: "Shopify", status: "connected" }],
      credentialSettings
    })
  );
  renderer.renderApp();
  assert.ok(document.querySelector('[data-status-key="setup-shopify"]').classList.contains("status-changed"));
  assert.equal(document.querySelector('[data-status-key="setup-ai-provider"]').classList.contains("status-changed"), false);

  renderer.renderApp();
  assert.equal(document.querySelector('[data-status-key="setup-shopify"]').classList.contains("status-changed"), false);
});

test("integration forms expose busy state and planned providers never accept credentials", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      integrations: [
        { id: "shopify", name: "Shopify", status: "disconnected", detail: "Store", lastSync: "Never" },
        { id: "gemini", name: "Gemini", status: "disconnected", detail: "Drafts", lastSync: "Never" },
        { id: "instagram", name: "Instagram", status: "planned", detail: "Planned", lastSync: "Never" }
      ],
      credentialSettings: [
        {
          id: "shopify",
          name: "Shopify",
          status: "missing",
          fields: [{ key: "storeDomain", label: "Store domain", placeholder: "store.myshopify.com", sensitive: false }]
        },
        { id: "gemini", name: "Gemini", status: "missing", fields: [] },
        {
          id: "instagram",
          name: "Instagram",
          status: "missing",
          fields: [{ key: "secret", label: "Secret", placeholder: "Secret", sensitive: true }]
        }
      ]
    })
  );
  renderer.ui.activeSection = "integrations";
  renderer.ui.pending.add("credentials-shopify");
  renderer.renderApp();
  const shopifyForm = document.querySelector('[data-credentials-form="shopify"]');
  assert.equal(shopifyForm.getAttribute("aria-busy"), "true");
  assert.equal(shopifyForm.querySelector("button[type=submit]").disabled, true);
  assert.equal(document.querySelectorAll('[data-credentials-form="instagram"]').length, 0);
  assert.doesNotMatch(document.querySelector(".planned-list").textContent, /Secret/);
});

test("AI provider profiles render verified capabilities and capability-compatible workloads", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      integrations: [{ id: "shopify", name: "Shopify", status: "disconnected" }],
      credentialSettings: [{ id: "shopify", name: "Shopify", status: "missing", fields: [] }]
    })
  );
  renderer.ui.activeSection = "integrations";
  renderer.renderApp();
  const providerForm = document.querySelector('[data-ai-provider-form="gemini"]');
  assert.ok(providerForm);
  assert.match(providerForm.textContent, /structured output/i);
  assert.equal(providerForm.querySelector('input[name="apiKey"]').type, "password");
  const inboxAssignment = document.querySelector('[data-workload-form="inboxDrafting"] select');
  assert.match(inboxAssignment.textContent, /Gemini 3.6 Flash/);
  const transcription = document.querySelector('[data-workload-form="transcription"] select');
  assert.doesNotMatch(transcription.textContent, /Gemini 3.6 Flash/);
  assert.match(transcription.textContent, /Unassigned/);
});

test("Integrations renders a private local voice compatibility report without invented readiness", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(baseState());
  renderer.ui.localVoiceReport = {
    scannedAt: "2026-07-24T00:00:00.000Z",
    device: {
      platform: "darwin",
      architecture: "arm64",
      cpuCores: 10,
      memoryGb: 16,
      accelerator: "Apple GPU / Metal"
    },
    bestEngineId: "chatterbox",
    privacy: "This compatibility scan ran locally. ProduDash did not upload device inventory.",
    engines: [
      {
        id: "chatterbox",
        name: "Chatterbox",
        kind: "likeness",
        description: "Local voice likeness generation.",
        status: "recommended",
        reason: "Hardware meets the baseline; install and configure the runtime separately."
      }
    ]
  };
  renderer.ui.activeSection = "integrations";
  renderer.renderApp();
  assert.ok(document.querySelector("[data-local-voice-scan]"));
  assert.match(document.querySelector("#viewRoot").textContent, /Best match/);
  assert.match(document.querySelector("#viewRoot").textContent, /did not upload device inventory/);
  assert.match(document.querySelector("#viewRoot").textContent, /install and configure the runtime separately/);
});

test("Content Studio keeps seven-row navigation and renders a safe read-only Clip Library", async () => {
  const renderer = await setupRenderer();
  const maliciousName = `<img src=x onerror="window.libraryPwned=true">.mp4`;
  renderer.setAppState(baseState());
  renderer.setClipLibrary({
    folders: [
      {
        id: "folder-1",
        name: "Campaign footage",
        status: "offline",
        clipCount: 1,
        lastScannedAt: "bad-date",
        error: "External drive is offline"
      }
    ],
    clips: [
      {
        id: "media-1",
        name: maliciousName,
        extension: "mp4",
        status: "missing",
        duration: null,
        size: 42,
        tags: ["launch"],
        previewUrl: null,
        thumbnailUrl: null,
        error: "File unavailable",
        search: {
          score: 0.875,
          matchedTerms: ["launch"],
          modelId: "local-keywords-v2",
          provenance: "local_metadata_transcript",
          timestampMatches: [
            {
              start: 12.5,
              end: 15,
              excerpt: `<img src=x onerror="window.transcriptPwned=true"> customer launch`,
              score: 0.875,
              matchedTerms: ["launch"]
            }
          ]
        }
      }
    ],
    total: 1,
    offset: 0,
    limit: 40,
    notices: []
  });
  renderer.ui.activeSection = "studio";
  renderer.ui.studioTab = "library";
  renderer.renderApp();
  assert.equal(document.querySelectorAll(".nav-item").length, 7);
  assert.equal(document.querySelectorAll('[role="tab"]').length, 5);
  assert.equal(document.querySelector('[data-studio-tab="projects"]').textContent, "Projects");
  assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim(), "Library");
  assert.match(document.querySelector(".clip-row").textContent, /<img src=x/);
  assert.equal(document.querySelector(".clip-row img"), null);
  assert.equal(window.libraryPwned, undefined);
  assert.match(document.querySelector(".clip-search-match").textContent, /0:13/);
  assert.match(document.querySelector(".clip-search-match").textContent, /<img src=x/);
  assert.equal(window.transcriptPwned, undefined);
  assert.match(document.querySelector(".clip-detail").textContent, /File unavailable/);
  assert.match(document.querySelector(".library-folders").textContent, /External drive is offline/);
  assert.equal(document.querySelector("[data-remove-clip]").textContent.trim(), "Remove from library");
});

test("Studio creates deterministic local jobs while preserving legacy plans as non-renderable", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      mediaJobs: [
        {
          id: "mediajob-ready",
          title: "Rendered clip",
          status: "completed",
          stage: "complete",
          progress: 100,
          settings: {},
          artifacts: [{ kind: "video", name: "clip.mp4" }],
          warnings: [],
          candidates: [],
          selectedCandidateIds: []
        }
      ],
      clipperJobs: [
        {
          id: "legacy-1",
          title: "Old plan",
          status: "legacy_plan",
          legacy: true,
          createdAt: "2026-07-23T00:00:00.000Z"
        }
      ]
    })
  );
  renderer.ui.activeSection = "studio";
  renderer.ui.studioTab = "create";
  renderer.renderApp();
  assert.ok(document.querySelector("[data-media-job-form]"));
  assert.match(document.querySelector(".legacy-plans").textContent, /Legacy plan/);
  assert.match(document.querySelector(".legacy-plans").textContent, /recreate with a library source to render/i);
  renderer.ui.studioTab = "publishing";
  renderer.renderApp();
  assert.ok(document.querySelector("[data-post-form]"));
  assert.equal(document.querySelector('[name="mediaJobId"] option:last-child').value, "mediajob-ready");
  assert.match(document.querySelector("#viewRoot").textContent, /does not connect accounts or publish/i);
});

test("Publishing renders immutable local export packages, schedule context, and cancellation without fake live state", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      creatorPlatforms: [{ id: "youtube", name: "YouTube Shorts" }],
      postQueue: [
        {
          id: "post-1",
          title: `<img src=x onerror="window.postPwned=1">`,
          caption: "Approved copy",
          platforms: ["youtube"],
          status: "approved_for_manual_export",
          schedule: {
            mode: "planned_local_only",
            scheduledFor: "2026-08-01T18:00:00.000Z",
            timeZone: "America/Phoenix"
          },
          mediaSnapshot: {
            videos: [{ name: "clip.mp4" }],
            outputFolderName: `safe"><script>bad()</script>`
          },
          approvalSnapshot: { hash: "a".repeat(64) },
          exportReceipt: null
        }
      ]
    })
  );
  renderer.ui.activeSection = "studio";
  renderer.ui.studioTab = "publishing";
  renderer.renderApp();
  assert.ok(document.querySelector("[data-export-post='post-1']"));
  assert.ok(document.querySelector("[data-cancel-post='post-1']"));
  assert.match(document.querySelector(".studio-item").textContent, /America\/Phoenix/);
  assert.match(document.querySelector(".studio-item").textContent, /safe"><script>bad/);
  assert.equal(document.querySelector(".studio-item img"), null);
  assert.equal(window.postPwned, undefined);
  assert.doesNotMatch(document.querySelector("#viewRoot").textContent, /published successfully/i);
});

test("Publishing shows editable destination drafts and a truthful local schedule summary before approval", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      creatorPlatforms: [
        { id: "instagram", name: "Instagram Reels" },
        { id: "youtube", name: "YouTube Shorts" }
      ],
      postQueue: [
        {
          id: "post-pending",
          title: "Pending plan",
          caption: "Shared copy",
          platforms: ["instagram", "youtube"],
          platformPackages: [
            { platformId: "instagram", title: `<script>unsafe()</script>`, caption: "Instagram copy" },
            { platformId: "youtube", title: "YouTube version", caption: "YouTube copy" }
          ],
          status: "needs_approval",
          schedule: {
            mode: "planned_local_only",
            scheduledFor: "2099-08-01T18:00:00.000Z",
            timeZone: "America/Phoenix"
          },
          mediaSnapshot: null,
          approvalSnapshot: null,
          exportReceipt: null
        },
        {
          id: "post-locked",
          title: "Approved plan",
          caption: "",
          platforms: ["youtube"],
          platformPackages: [{ platformId: "youtube", title: "Locked title", caption: "Locked copy" }],
          status: "approved_for_manual_export",
          schedule: { mode: "unscheduled", scheduledFor: null, timeZone: null },
          mediaSnapshot: null,
          approvalSnapshot: { hash: "b".repeat(64) },
          exportReceipt: null
        }
      ]
    })
  );
  renderer.ui.activeSection = "studio";
  renderer.ui.studioTab = "publishing";
  renderer.renderApp();
  const draft = document.querySelector("[data-post-draft-form='post-pending']");
  assert.ok(draft);
  assert.equal(draft.querySelectorAll(".post-package-editor").length, 2);
  assert.equal(draft.querySelector('[name="platformTitle"]').value, "<script>unsafe()</script>");
  assert.equal(draft.querySelector("script"), null);
  assert.equal(document.querySelector("[data-post-draft-form='post-locked']"), null);
  assert.match(document.querySelector(".post-plan-locked").textContent, /Approved snapshot locked/);
  assert.match(document.querySelector(".publishing-summary").textContent, /Awaiting approval/);
  assert.match(document.querySelector(".publishing-summary").textContent, /Upcoming/);
  assert.match(document.querySelector(".publishing-schedule").textContent, /America\/Phoenix/);
  assert.doesNotMatch(document.querySelector("#viewRoot").textContent, /scheduled with youtube|published successfully/i);
});

test("Projects render escaped metadata, a semantic transcript editor, and bounded SVG timeline", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      creatorPlatforms: [{ id: "youtube", name: "YouTube" }],
      mediaJobs: [],
      aiProviders: [
        {
          id: "gemini",
          name: "Google Gemini",
          status: "connected",
          models: [
            {
              id: "gemini-3.6-flash",
              name: "Gemini 3.6 Flash",
              capabilities: ["text_generation", "structured_output"]
            }
          ]
        },
        {
          id: "openai",
          providerType: "openai",
          name: "OpenAI",
          status: "connected",
          models: [
            {
              id: "gpt-4o-mini-tts",
              name: "GPT-4o mini TTS",
              capabilities: ["speech_generation"]
            }
          ]
        },
        {
          id: "rvc-local",
          providerType: "rvc-local",
          name: "Local RVC",
          status: "connected",
          models: [
            {
              id: "rvc-local-model",
              name: "Configured RVC voice model",
              capabilities: ["voice_conversion"]
            }
          ]
        },
        {
          id: "xtts-local",
          providerType: "xtts-local",
          name: "Local XTTS",
          status: "connected",
          models: [
            {
              id: "xtts-local-model",
              name: "Configured local XTTS model",
              capabilities: ["speech_generation"]
            }
          ]
        }
      ],
      voiceLikeness: {
        acceptance: null,
        voices: [
          {
            id: "voice-authorized",
            name: "<img src=x onerror=window.voicePwned=true>",
            providerProfileId: "openai",
            providerType: "openai",
            createdAt: "2026-07-24T00:00:00.000Z"
          }
        ]
      }
    })
  );
  const summary = {
    id: "project-1",
    title: `<img src=x onerror="window.projectPwned=true">`,
    description: "Local project",
    businessId: null,
    source: {
      mediaId: "media-1",
      name: "Source.mp4",
      status: "available",
      duration: 60,
      previewUrl: "produdash-media://clip/media-1"
    },
    status: "active",
    favorite: false,
    tags: [],
    platforms: [],
    revision: 2,
    savedRevision: 1,
    segmentCount: 2,
    transcriptCount: 1,
    versionCount: 1,
    duration: 20,
    prepared: true,
    renderPlanHash: "a".repeat(64),
    jobs: [],
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z"
  };
  renderer.setProjects({
    projects: [summary],
    collections: [{ id: "collection-launch", name: "Launches" }],
    total: 1,
    notices: []
  });
  renderer.setActiveProject({
    ...summary,
    preparation: { waveform: [0.2, 0.8, 0.4], scenes: [5, 35] },
    draft: {
      version: 1,
      sourceMediaId: "media-1",
      sourceDuration: 60,
      totalDuration: 20,
      segments: [
        { id: "segment-a", sourceStart: 0, sourceEnd: 10, timelineStart: 0, duration: 10 },
        { id: "segment-b", sourceStart: 30, sourceEnd: 40, timelineStart: 10, duration: 10 }
      ],
      transcript: [{ id: "transcript-1", start: 1, end: 3, text: "Safe local cue", speaker: "Host" }],
      markers: [{ id: "marker-1", at: 4, text: "Hook" }],
      comments: [],
      composition: {
        transition: "cut",
        transitionDuration: 0.25,
        backgroundColor: "#000000",
        overlays: [],
        music: null,
        introAssetId: null,
        outroAssetId: null
      },
      intelligentTracks: {
        subject: [
          {
            id: "subject-reviewed",
            start: 0,
            end: 20,
            reviewed: true,
            mode: "keyframes",
            keyframes: [{ at: 0, x: 0.25, y: 0.5, scale: 1, confidence: 1 }]
          }
        ],
        audio: [
          {
            id: "audio-reviewed",
            start: 0,
            end: 20,
            reviewed: true,
            preset: "balanced",
            strength: 0.5
          }
        ],
        broll: [
          {
            id: "broll-reviewed",
            start: 2,
            end: 5,
            reviewed: true,
            mediaId: "media-broll",
            sourceStart: 0,
            sourceEnd: 3,
            fit: "fit_pad",
            opacity: 1,
            provenance: { source: "user_library", mediaId: "media-broll", fingerprint: "b".repeat(64) }
          }
        ],
        sfx: [
          {
            id: "sfx-reviewed",
            start: 5,
            end: 7,
            reviewed: true,
            assetId: "asset-sfx",
            volume: 0.4
          }
        ]
      },
      localization: {
        sourceLanguage: "en-US",
        activeVariantId: "language-es",
        variants: [
          {
            id: "language-es",
            language: "es-MX",
            label: "<img src=x onerror=window.localizedPwned=true>",
            status: "reviewed",
            cues: [{ sourceId: "transcript-1", text: "<script>Texto seguro</script>" }],
            provenance: { source: "manual", providerProfileId: null, modelId: null }
          }
        ],
        voiceovers: [
          {
            id: "voiceover-1",
            sourceId: "transcript-1",
            assetId: "asset-voiceover",
            start: 1,
            end: 2,
            status: "draft",
            originalAudio: "mix",
            volume: 1,
            provenance: {
              source: "provider",
              providerProfileId: "openai",
              modelId: "gpt-4o-mini-tts",
              voice: "marin",
              textHash: "a".repeat(64),
              aiGenerated: true
            }
          }
        ]
      },
      presentation: {
        targetAspect: "original",
        aspectTreatment: "fit_pad",
        enhancement: { mode: "resize_hd", reviewed: true },
        captionMode: "off",
        captionStyle: "clean",
        captionPosition: "lower",
        captionSafeArea: "standard"
      }
    },
    versions: [{ id: "version-1", revision: 1, label: "Initial version", savedAt: "2026-07-24T00:00:00.000Z" }],
    activity: []
  });
  renderer.ui.activeSection = "studio";
  renderer.ui.studioTab = "projects";
  renderer.ui.brandAssets = [
    { id: "asset-voiceover", kind: "voiceover", previewUrl: "produdash-media://brand/asset-voiceover", status: "available" }
  ];
  renderer.renderApp();
  assert.equal(document.querySelectorAll(".nav-item").length, 7);
  assert.equal(document.querySelector("[data-project-editor] img"), null);
  assert.equal(window.projectPwned, undefined);
  assert.equal(document.querySelectorAll(".timeline-segment").length, 2);
  assert.equal(document.querySelectorAll(".timeline-intelligent-subject").length, 1);
  assert.equal(document.querySelectorAll(".timeline-intelligent-audio").length, 1);
  assert.equal(document.querySelectorAll(".timeline-intelligent-broll").length, 1);
  assert.equal(document.querySelectorAll(".timeline-intelligent-sfx").length, 1);
  assert.ok(document.querySelector(".project-waveform path"));
  assert.equal(document.querySelectorAll("[data-transcript-id]").length, 1);
  assert.equal(document.querySelector("[data-project-render]").disabled, true);
  assert.ok(document.querySelector("[data-project-settings-form]"));
  assert.equal(document.querySelector('[name="subjectReviewed"]').checked, true);
  assert.equal(document.querySelector('[name="audioReviewed"]').checked, true);
  assert.equal(document.querySelector('[name="enhancementMode"]').value, "resize_hd");
  assert.equal(document.querySelector('[name="enhancementReviewed"]').checked, true);
  assert.match(document.querySelector("[data-project-settings-form]").textContent, /does not recover missing detail/i);
  assert.equal(document.querySelector('[name="brollReviewed"]').checked, true);
  assert.equal(document.querySelector('[name="sfxReviewed"]').checked, true);
  assert.ok(document.querySelector("[data-project-localization-create]"));
  assert.ok(document.querySelector("[data-project-localization-translate]"));
  assert.match(document.querySelector("[data-project-localization-translate]").textContent, /Google Gemini · Gemini 3.6 Flash/);
  assert.match(document.querySelector(".localization-consent").textContent, /transcript text/);
  assert.ok(document.querySelector("[data-project-voiceover-create]"));
  assert.ok(document.querySelector("[data-custom-voice-open]"));
  assert.ok(document.querySelector('[data-custom-voice-remove="voice-authorized"]'));
  assert.match(document.querySelector('[data-custom-voice-remove="voice-authorized"]').closest(".compact-row").textContent, /<img src=x/);
  assert.equal(window.voicePwned, undefined);
  assert.ok(document.querySelector("[data-custom-voice-dialog]"));
  assert.match(document.querySelector("[data-custom-voice-dialog]").textContent, /I am the owner of this voice/);
  assert.match(document.querySelector("[data-custom-voice-dialog]").textContent, /impersonation, fraud, deception/);
  assert.equal(document.querySelector("[data-rvc-voiceover-open]").disabled, false);
  assert.match(document.querySelector("[data-rvc-voiceover-dialog]").textContent, /original preview remains unchanged/i);
  assert.match(document.querySelector("[data-rvc-voiceover-dialog]").textContent, /privacy, publicity, biometric/i);
  assert.match(document.querySelector("[data-rvc-voiceover-dialog]").textContent, /Local RVC/);
  assert.equal(document.querySelector("[data-local-likeness-open]").disabled, false);
  assert.match(document.querySelector("[data-local-likeness-dialog]").textContent, /retains its encrypted path, not a copy/i);
  assert.match(document.querySelector("[data-local-likeness-dialog]").textContent, /Local XTTS/);
  assert.match(document.querySelector("[data-project-voiceover-create]").textContent, /GPT-4o mini TTS/);
  assert.equal(document.querySelector("[data-project-voiceover-create] [name='providerSelection']"), null);
  assert.match(document.querySelector("[data-project-voiceover-create] [name='voiceSelection']").textContent, /marin — built-in/);
  assert.ok(document.querySelector("[data-project-speaker-voiceovers]"));
  assert.match(document.querySelector("[data-project-speaker-voiceovers]").textContent, /Host/);
  assert.match(document.querySelector("[data-project-speaker-voiceovers]").textContent, /requiring individual review/);
  assert.equal(
    document.querySelector("[data-project-voiceover-form] audio").getAttribute("src"),
    "produdash-media://brand/asset-voiceover"
  );
  assert.match(document.querySelector(".project-voiceovers").textContent, /AI-generated voice/);
  assert.equal(document.querySelectorAll("[data-project-localization-form]").length, 1);
  assert.match(document.querySelector(".project-localization").textContent, /<img src=x/);
  assert.equal(window.localizedPwned, undefined);
  assert.equal(document.querySelector("[data-localized-source-id]").value, "<script>Texto seguro</script>");
  assert.ok(document.querySelector("[data-project-collection-form]"));
  assert.ok(document.querySelector('[data-project-preview-mode="source"]'));
  assert.ok(document.querySelector("[data-project-comment-form]"));
  assert.match(document.querySelector(".project-editor").textContent, /Source\.mp4/);
  assert.match(document.querySelector(".project-editor").textContent, /Recoverable draft/);
});

test("Brand templates render local composition controls without exposing injected markup", async () => {
  const renderer = await setupRenderer();
  renderer.ui.activeSection = "studio";
  renderer.ui.studioTab = "templates";
  renderer.ui.brandTemplates = [
    {
      id: "template-one",
      name: '<img src=x onerror="window.templatePwned=true">',
      description: "Local launch template",
      version: 2,
      settings: {
        presentation: { targetAspect: "vertical", captionStyle: "brand" },
        composition: { transition: "fade", overlays: [{ id: "cta", type: "cta", text: "Shop" }] }
      }
    }
  ];
  renderer.ui.brandAssets = [
    {
      id: "asset-logo",
      kind: "logo",
      name: '<img src=x onerror="window.assetPwned=true">',
      status: "available",
      previewUrl: "produdash-media://brand/asset-logo",
      duration: null
    }
  ];
  renderer.renderApp();
  assert.equal(document.querySelector('[data-studio-tab="templates"]').getAttribute("aria-selected"), "true");
  assert.equal(document.querySelectorAll(".template-card img").length, 0);
  assert.match(document.querySelector(".template-card").textContent, /<img src=x/);
  assert.equal(window.templatePwned, undefined);
  assert.equal(window.assetPwned, undefined);
  assert.match(document.querySelector(".template-asset-workspace").textContent, /<img src=x/);
  assert.ok(document.querySelector('[data-brand-asset-import="logo"]'));
  assert.ok(document.querySelector('select[name="logoAssetId"] option[value="asset-logo"]'));
  assert.ok(document.querySelector("[data-template-create-form]"));
  assert.ok(document.querySelector('[inputmode="none"]') === null);
});

test("Studio exposes only connected capability-compatible cloud modes with per-job consent", async () => {
  const renderer = await setupRenderer();
  const state = baseState();
  state.aiProviders[0] = {
    ...state.aiProviders[0],
    status: "connected",
    models: [
      {
        id: "gemini-3.6-flash",
        name: "Gemini 3.6 Flash",
        capabilities: ["text_generation", "structured_output", "image_understanding", "native_video_understanding"]
      }
    ]
  };
  state.aiProviders.push({
    id: "openai",
    providerType: "openai",
    name: "OpenAI",
    status: "connected",
    credentialStatus: "stored",
    selectedModelId: "whisper-1",
    models: [{ id: "whisper-1", name: "Whisper 1", capabilities: ["audio_transcription"] }]
  });
  state.aiWorkloads.transcription = { mode: "provider", profileId: "openai", modelId: "whisper-1" };
  renderer.setAppState(state);
  renderer.setClipLibrary({
    folders: [],
    clips: [{ id: "media-1", name: "Source.mp4", status: "available" }],
    total: 1,
    offset: 0,
    limit: 40,
    notices: []
  });
  renderer.ui.activeSection = "studio";
  renderer.ui.studioTab = "create";
  renderer.renderApp();
  const modes = document.querySelector('[name="analysisMode"]');
  assert.match(modes.textContent, /Smart local cuts/);
  assert.match(modes.textContent, /Native video analysis/);
  assert.match(modes.textContent, /Transcript-only analysis/);
  assert.match(modes.textContent, /Transcript \+ sampled frames/);
  const frames = modes.querySelector('option[value="transcript_frames"]');
  assert.equal(frames.dataset.providerId, "gemini");
  assert.equal(frames.dataset.transcriptionProviderId, "openai");
  assert.equal(frames.dataset.categories, "audio,transcript,frames");
  assert.match(document.querySelector(".cloud-consent-check").textContent, /Consent for this job only/);
});

test("local provider configuration uses native file selectors and never renders protected paths", async () => {
  const renderer = await setupRenderer();
  renderer.ui.providerCatalog.push({
    id: "whisper-cpp",
    name: "Local whisper.cpp",
    credentialFields: [
      { key: "executablePath", label: "whisper.cpp executable", type: "native-file", sensitive: true },
      { key: "modelPath", label: "Whisper model file", type: "native-file", sensitive: true }
    ]
  });
  renderer.ui.providerCatalog.push({
    id: "xtts-local",
    name: "Local XTTS",
    credentialFields: [
      { key: "pythonPath", label: "XTTS Python executable", type: "native-file", sensitive: true },
      { key: "modelPath", label: "Local XTTS model folder", type: "native-folder", sensitive: true },
      { key: "language", label: "XTTS language code", type: "text", sensitive: false }
    ]
  });
  const state = baseState();
  state.aiProviders.push({
    id: "whisper-cpp",
    providerType: "whisper-cpp",
    name: "Local whisper.cpp",
    status: "disconnected",
    credentialStatus: "missing",
    selectedModelId: "local-whisper",
    models: [{ id: "local-whisper", name: "Local whisper.cpp", capabilities: ["audio_transcription"] }]
  });
  state.aiProviders.push({
    id: "xtts-local",
    providerType: "xtts-local",
    name: "Local XTTS",
    status: "disconnected",
    credentialStatus: "missing",
    selectedModelId: "xtts-local-model",
    publicValues: { language: "en" },
    models: [{ id: "xtts-local-model", name: "Configured local XTTS model", capabilities: ["speech_generation"] }]
  });
  renderer.setAppState(state);
  renderer.ui.activeSection = "integrations";
  renderer.renderApp();
  const form = document.querySelector('[data-ai-provider-form="whisper-cpp"]');
  assert.equal(form.querySelectorAll("[data-local-provider-file]").length, 2);
  assert.equal(form.querySelector('input[name="executablePath"]'), null);
  assert.doesNotMatch(form.textContent, /Users\/owner/);
  assert.match(form.textContent, /never downloads models/i);
  const xttsForm = document.querySelector('[data-ai-provider-form="xtts-local"]');
  assert.match(xttsForm.querySelector('[data-local-provider-file="modelPath"]').textContent, /Choose folder/);
  assert.equal(xttsForm.querySelector('input[name="modelPath"]'), null);
});

test("Studio safely renders durable job progress, candidate approval, and partial artifacts", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      creatorPlatforms: [{ id: "tiktok", name: "TikTok" }],
      mediaJobs: [
        {
          id: "mediajob-1",
          title: `<img src=x onerror="window.mediaPwned=1">`,
          sourceMediaId: "media-1",
          sourceName: `source"><script>bad()</script>.mp4`,
          sourcePreviewUrl: "produdash-media://clip/media-1",
          sourceDuration: 30,
          outputFolderName: "safe-output",
          status: "awaiting_review",
          stage: "candidate_review",
          progress: 75,
          settings: { captionMode: "srt_burned", aspectTreatment: "fit_pad", targetAspect: "vertical" },
          candidates: [
            {
              id: "candidate-1",
              title: "<svg onload=bad()>",
              start: 0,
              end: 8,
              confidence: 0.8,
              rationale: "<script>not markup</script>",
              scores: { audioClarity: 0.8, silence: 0.1 },
              original: { title: "<svg onload=bad()>", start: 0, end: 8, duration: 8 },
              edit: {
                title: "Edited candidate",
                start: 1,
                end: 9,
                duration: 8,
                captionSegments: [{ id: "caption-1", start: 0, end: 4, text: "<img src=x onerror=bad()>" }],
                manualCaptionText: "",
                captionStyle: "clean",
                captionPosition: "lower",
                captionSafeArea: "social",
                aspectTreatment: "fit_pad",
                targetAspect: "vertical"
              }
            }
          ],
          selectedCandidateIds: [],
          warnings: ["Local warning"],
          artifacts: [{ kind: "video", name: "partial.mp4" }],
          error: null
        }
      ]
    })
  );
  renderer.setClipLibrary({
    folders: [],
    clips: [{ id: "media-1", name: "Source.mp4", status: "available" }],
    total: 1,
    offset: 0,
    limit: 40,
    notices: []
  });
  renderer.ui.activeSection = "studio";
  renderer.ui.studioTab = "create";
  renderer.renderApp();
  assert.equal(document.querySelector(".media-job img"), null);
  assert.equal(window.mediaPwned, undefined);
  assert.match(document.querySelector(".media-job").textContent, /<img src=x/);
  assert.ok(document.querySelector("[data-candidate-video]"));
  assert.equal(document.querySelector("[data-candidate-video]").getAttribute("src"), "produdash-media://clip/media-1");
  assert.equal(document.querySelector("[data-media-candidates-form] input[name='candidateIds']").checked, false);
  assert.ok(document.querySelector("[data-candidate-play]"));
  assert.ok(document.querySelector("[data-candidate-reset]"));
  assert.ok(document.querySelector("[data-candidate-reject]"));
  assert.equal(document.querySelector("[data-candidate-edit-form] [name='start']").value, "1");
  assert.equal(document.querySelector(".candidate-caption-preview img"), null);
  assert.match(document.querySelector(".candidate-caption-preview").textContent, /<img src=x/);
  assert.match(document.querySelector(".candidate-score-details").textContent, /Audio clarity/i);
  assert.equal(document.querySelector("progress").value, 75);
  assert.match(document.querySelector(".artifact-list").textContent, /partial\.mp4/);
});

test("completed media jobs show only allowlisted local thumbnail previews and one preferred choice per clip", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      creatorPlatforms: [
        { id: "tiktok", name: "TikTok" },
        { id: "youtube", name: "YouTube Shorts" }
      ],
      mediaJobs: [
        {
          id: "mediajob-1",
          title: "Finished clip",
          sourceMediaId: "media-1",
          sourceName: "source.mp4",
          outputFolderName: "safe-output",
          status: "completed",
          stage: "complete",
          progress: 100,
          settings: { analysisMode: "local_heuristics", platforms: ["tiktok", "youtube"] },
          candidates: [],
          selectedCandidateIds: [],
          warnings: [],
          thumbnailSelections: [
            {
              groupId: "thumbgroup-1234567890abcdef1234",
              artifactId: "artifact-1234567890abcdef12345678",
              selectedAt: "2026-07-24T00:00:00.000Z"
            }
          ],
          artifacts: [
            {
              id: "artifact-1234567890abcdef12345678",
              kind: "thumbnail",
              name: "clip-01-safe-thumb-early.jpg",
              source: "local_render",
              positionRatio: 0.2,
              groupId: "thumbgroup-1234567890abcdef1234",
              previewUrl: "produdash-media://job-thumbnail/artifact-1234567890abcdef12345678"
            },
            {
              id: "artifact-abcdef1234567890abcdef12",
              kind: "thumbnail",
              name: "custom-thumbnail-safe.png",
              source: "user_import",
              positionRatio: null,
              groupId: "thumbgroup-1234567890abcdef1234",
              previewUrl: "produdash-media://job-thumbnail/artifact-abcdef1234567890abcdef12"
            },
            {
              id: "artifact-ffffffffffffffffffffffff",
              kind: "thumbnail",
              name: `<img src=x onerror="window.thumbnailPwned=1">`,
              source: "local_render",
              positionRatio: 0.5,
              groupId: "thumbgroup-1234567890abcdef1234",
              previewUrl: `javascript:window.thumbnailPwned=1`
            },
            { kind: "video", name: "clip-01-safe.mp4" }
          ],
          error: null
        }
      ]
    })
  );
  renderer.ui.activeSection = "studio";
  renderer.ui.studioTab = "create";
  renderer.renderApp();
  const choices = document.querySelectorAll("[data-select-job-thumbnail]");
  assert.equal(choices.length, 2);
  assert.equal(choices[0].getAttribute("aria-pressed"), "true");
  assert.equal(choices[0].querySelector("img").getAttribute("src"), "produdash-media://job-thumbnail/artifact-1234567890abcdef12345678");
  assert.match(document.querySelector(".thumbnail-review").textContent, /does not edit, upload, or publish/i);
  assert.match(document.querySelector(".thumbnail-review").textContent, /Preferred/);
  assert.match(document.querySelector(".thumbnail-review").textContent, /Custom/);
  assert.ok(document.querySelector("[data-add-job-thumbnail]"));
  assert.equal(document.querySelectorAll(".thumbnail-platform-card").length, 2);
  assert.match(document.querySelector(".thumbnail-platform-review").textContent, /not an official publishing preview/i);
  assert.equal(window.thumbnailPwned, undefined);
});

test("status tones are allowlisted and errors receive focus", async () => {
  const renderer = await setupRenderer();
  assert.equal(renderer.statusTone("connected"), "success");
  assert.equal(renderer.statusTone("degraded"), "warning");
  assert.equal(renderer.statusTone(`danger" onclick="bad`), "neutral");
  renderer.setAppState(baseState());
  renderer.ui.error = "Safe visible error";
  renderer.renderApp();
  assert.equal(document.activeElement.getAttribute("role"), "alert");
  assert.match(document.activeElement.textContent, /Safe visible error/);
});

test("pending actions expose loading state and destructive controls require confirmation", async () => {
  const renderer = await setupRenderer();
  const state = baseState({
    integrations: [
      { id: "shopify", name: "Shopify", status: "connected", detail: "Store", lastSync: "Now" },
      { id: "gemini", name: "Gemini", status: "disconnected", detail: "Drafts", lastSync: "Never" }
    ],
    credentialSettings: [
      { id: "shopify", name: "Shopify", status: "stored", fields: [] },
      { id: "gemini", name: "Gemini", status: "missing", fields: [] }
    ]
  });
  let refreshCalls = 0;
  let finishRefresh;
  let deleteCalls = 0;
  window.produdash = {
    refreshConnections: () => {
      refreshCalls += 1;
      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    },
    getAnalyticsReport: async () => ({ ok: true, data: null }),
    deleteAllLocalData: async () => {
      deleteCalls += 1;
      return { ok: true, data: state };
    }
  };
  window.confirm = () => false;
  renderer.setAppState(state);
  renderer.ui.activeSection = "integrations";
  renderer.renderApp();
  const handlers = await import(`${pathToFileURL(path.join(projectRoot, "src/renderer/handlers.js")).href}?pending-actions`);
  handlers.bindHandlers();

  const syncButton = document.querySelector("#syncButton");
  syncButton.getBoundingClientRect = () => ({ width: 164 });
  syncButton.click();
  syncButton.click();
  await Promise.resolve();
  assert.equal(refreshCalls, 1);
  assert.equal(syncButton.disabled, true);
  assert.equal(syncButton.textContent, "Refreshing…");
  assert.equal(syncButton.getAttribute("aria-busy"), "true");
  assert.equal(syncButton.getAttribute("aria-label"), "Refreshing…");
  assert.equal(syncButton.style.inlineSize, "164px");
  assert.ok(syncButton.querySelector(".button-spinner"));
  finishRefresh({ ok: true, data: state });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.querySelector("#syncButton").disabled, false);
  assert.equal(document.querySelector("#syncButton").getAttribute("aria-busy"), null);
  assert.equal(document.querySelector("#syncButton").style.inlineSize, "");
  assert.equal(document.querySelector("#syncButton .button-spinner"), null);
  assert.equal(document.querySelector("[data-advisor-celebration]"), null);

  document.querySelector("[data-delete-all]").click();
  await Promise.resolve();
  assert.equal(deleteCalls, 0);

  const analyticsButton = document.querySelector('.nav-item[data-section="analytics"]');
  assert.ok(analyticsButton.querySelector(".nav-icon path"));
  analyticsButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(document.querySelector('.nav-item[data-section="analytics"] .nav-icon path'));
  assert.equal(document.querySelector('.nav-item[data-section="analytics"] span').textContent, "Analytics");
});

test("focused theme removes glass effects and keeps the restrictive CSP", () => {
  const css = fs.readFileSync(path.join(projectRoot, "src/styles.css"), "utf8");
  const html = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
  assert.match(css, /--bg: #101214/);
  assert.match(css, /--accent: #7aa2f7/);
  assert.doesNotMatch(css, /(?:linear|radial)-gradient|backdrop-filter|glassDrift|surfaceSheen/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
  assert.match(html, /img-src 'self' data: produdash-media:/);
  assert.match(html, /media-src 'self' produdash-media:/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /class="logo-p"/);
  assert.match(html, /class="logo-d"/);
  assert.doesNotMatch(html, /linearGradient/);
});

test("motion CSS uses explicit restrained transitions and complete reduced-motion overrides", () => {
  const css = fs.readFileSync(path.join(projectRoot, "src/styles.css"), "utf8");
  const html = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
  assert.match(css, /--motion-instant: 100ms/);
  assert.match(css, /--motion-control: 140ms/);
  assert.match(css, /--motion-view: 190ms/);
  assert.match(css, /--motion-surface: 240ms/);
  assert.match(css, /--ease-out: cubic-bezier\(0\.2, 0, 0, 1\)/);
  assert.doesNotMatch(css, /transition\s*:\s*all/);
  assert.match(css, /::details-content/);
  assert.match(css, /interpolate-size: allow-keywords/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.button-spinner\s*\{[\s\S]*animation: none !important/);
  assert.match(html, /class="nav-active-indicator"/);
  assert.match(html, /data-active-section="overview"/);
});

test("Advisor panel is accessible, provider-scoped, escaped, and reduced-motion safe", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      aiProviders: [
        {
          id: "gemini",
          providerType: "gemini",
          name: "Google Gemini",
          status: "connected",
          credentialStatus: "stored",
          selectedModelId: "gemini-3.6-flash",
          models: [
            {
              id: "gemini-3.6-flash",
              name: "Gemini 3.6 Flash",
              capabilities: ["text_generation", "tool_calling"]
            }
          ]
        }
      ]
    })
  );
  renderer.setAdvisorHistory({
    turns: [
      {
        id: "turn-1",
        role: "assistant",
        text: `<img src=x onerror="window.advisorPwned=true">`,
        at: new Date().toISOString(),
        providerId: "gemini",
        modelId: "gemini-3.6-flash",
        tools: ["get_business_overview"]
      }
    ],
    status: {
      ready: true,
      providerId: "gemini",
      modelId: "gemini-3.6-flash",
      consentedCategories: ["dashboard_summary", "commerce_aggregates", "integration_health", "media_summaries", "application_context"]
    }
  });
  renderer.ui.advisorOpen = true;
  renderer.renderApp();
  assert.equal(document.querySelector("[data-advisor-toggle]").getAttribute("aria-expanded"), "true");
  assert.equal(document.querySelector("#advisorPanel").getAttribute("aria-hidden"), "false");
  assert.equal(document.querySelector("[data-advisor-form]").getAttribute("aria-busy"), "false");
  assert.match(document.querySelector("#advisorPanel").textContent, /Responses are advisory/i);
  assert.match(document.querySelector("#advisorPanel").textContent, /50 visible turns/i);
  assert.equal(window.advisorPwned, undefined);
  assert.equal(document.querySelector('#advisorPanel img[src="x"]'), null);
  assert.match(document.querySelector(".advisor-launcher-avatar").getAttribute("src"), /advisor-avatar\.png$/);
  assert.match(document.querySelector(".advisor-avatar-blink").getAttribute("src"), /advisor-avatar-blink\.png$/);
  assert.match(document.querySelector("[data-advisor-toggle]").textContent, /Juanito/);
  assert.match(document.querySelector("[data-advisor-form] button[type='submit']").textContent, /Ask Juanito/);
  assert.match(document.querySelector(".advisor-state-art").getAttribute("src"), /advisor-idle\.png$/);
  assert.match(document.querySelector(".advisor-idle-blink").getAttribute("src"), /advisor-idle-blink\.png$/);
  assert.ok(document.querySelector(".advisor-journal-sprite"));
  assert.equal(document.querySelector(".advisor-journal-sprite").hasAttribute("style"), false);
  assert.match(document.querySelector(".advisor-art-stack").className, /journal-cadence-(?:calm|patient|reflective)/);
  assert.equal(document.querySelector(".advisor-art-stack").dataset.advisorArtState, "idle");
  assert.equal(document.querySelector(".advisor-art-stack").classList.contains("is-idle"), true);
  renderer.renderApp();
  assert.equal(document.querySelector(".advisor-art-reaction").classList.contains("is-reacting"), false);
  for (const state of ["thinking", "success", "warning"]) {
    renderer.ui.advisorStatus = state;
    renderer.renderApp();
    const art = document.querySelector(".advisor-state-art");
    assert.match(art.getAttribute("src"), new RegExp(`advisor-${state}\\.png$`));
    assert.equal(document.querySelector(".advisor-art-stack").dataset.advisorArtState, state);
    assert.equal(document.querySelector(".advisor-art-reaction").classList.contains("is-reacting"), true);
    assert.equal(document.querySelector(".advisor-idle-blink"), null);
    assert.equal(document.querySelector(".advisor-journal-sequence"), null);
  }
  for (const asset of ["idle", "idle-blink", "thinking", "success", "warning", "avatar", "avatar-blink"]) {
    assert.equal(fs.existsSync(path.join(projectRoot, `assets/advisor/states/advisor-${asset}.png`)), true);
  }
  assert.equal(fs.existsSync(path.join(projectRoot, "assets/advisor/states/juanito-journal-strip.png")), true);
  assert.equal(fs.existsSync(path.join(projectRoot, "assets/advisor/states/juanito-celebrate-hop-strip.png")), true);
  assert.equal(fs.existsSync(path.join(projectRoot, "assets/advisor/states/juanito-celebrate-notebook-strip.png")), true);
  const css = fs.readFileSync(path.join(projectRoot, "src/styles.css"), "utf8");
  assert.match(css, /\.advisor-panel/);
  for (const animation of [
    "advisor-avatar-react",
    "advisor-idle-arrive",
    "advisor-idle-breathe",
    "advisor-blink",
    "advisor-idle-yield",
    "advisor-journal-appear",
    "advisor-journal-write",
    "advisor-celebration-frames",
    "advisor-celebration-pop",
    "advisor-thinking-react",
    "advisor-success-react",
    "advisor-warning-react"
  ]) {
    assert.match(css, new RegExp(`@keyframes ${animation}`));
  }
  assert.match(css, /\.advisor-art-stack\.is-idle[\s\S]*advisor-idle-breathe[^;]*infinite/);
  assert.match(css, /\.advisor-art-stack\.is-idle \.advisor-idle-blink[\s\S]*advisor-blink[^;]*infinite/);
  assert.match(css, /\.advisor-journal-sequence[\s\S]*advisor-journal-appear[^;]*infinite/);
  assert.match(css, /\.advisor-journal-sprite[\s\S]*juanito-journal-strip\.png[\s\S]*advisor-journal-write[^;]*infinite/);
  assert.match(css, /\.celebration-hop \.advisor-celebration-sprite[\s\S]*juanito-celebrate-hop-strip\.png/);
  assert.match(css, /\.celebration-notebook \.advisor-celebration-sprite[\s\S]*juanito-celebrate-notebook-strip\.png/);
  assert.doesNotMatch(css, /advisor-(?:thinking|success|warning)-react[^;]*infinite/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.advisor-journal-sequence[\s\S]*animation: none !important/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.advisor-celebration-popover[\s\S]*opacity: 0 !important/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.advisor-panel/);
  assert.doesNotMatch(css, /transition:\s*all/);
});

test("Juanito celebrations alternate, cool down, and bypass reduced motion", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(baseState());
  renderer.renderApp();
  const advisor = await import(pathToFileURL(path.join(projectRoot, "src/renderer/advisor.js")).href);
  const originalNow = Date.now;
  const originalMatchMedia = window.matchMedia;
  let now = 10_000;
  Date.now = () => now;
  window.matchMedia = () => ({ matches: false });

  try {
    assert.equal(advisor.celebrateAdvisor(), true);
    const first = document.querySelector("[data-advisor-celebration]");
    assert.equal(first.dataset.advisorCelebration, "hop");
    assert.match(first.className, /celebration-hop/);
    assert.equal(first.hasAttribute("style"), false);

    now += 1_000;
    assert.equal(advisor.celebrateAdvisor(), false);
    assert.equal(document.querySelector("[data-advisor-celebration]").dataset.advisorCelebration, "hop");

    now += 1_000;
    assert.equal(advisor.celebrateAdvisor(), true);
    assert.equal(document.querySelector("[data-advisor-celebration]").dataset.advisorCelebration, "notebook");

    renderer.renderApp();
    window.matchMedia = () => ({ matches: true });
    now += 2_000;
    assert.equal(advisor.celebrateAdvisor(), false);
    assert.equal(document.querySelector("[data-advisor-celebration]"), null);
  } finally {
    Date.now = originalNow;
    window.matchMedia = originalMatchMedia;
  }
});

test("Juanito reacts once to genuine media transitions and removes completed reaction DOM", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(baseState());
  renderer.renderApp();
  const reactions = await import(pathToFileURL(path.join(projectRoot, "src/renderer/advisor-reactions.js")).href);
  reactions.resetAdvisorReactionStateForTests();
  const originalNow = Date.now;
  const originalMatchMedia = window.matchMedia;
  let now = 20_000;
  Date.now = () => now;
  window.matchMedia = () => ({ matches: false });
  const job = (status) => ({ id: "mediajob-1", status });
  try {
    assert.deepEqual(reactions.reactToMediaJobUpdates([job("queued")], [job("processing")]), {
      kind: "working",
      jobId: "mediajob-1"
    });
    const working = document.querySelector('[data-advisor-job-reaction="working"]');
    assert.ok(working);
    reactions.reactToMediaJobUpdates([job("processing")], [job("processing")]);
    assert.equal(document.querySelector('[data-advisor-job-reaction="working"]'), working);

    reactions.reactToMediaJobUpdates([job("processing")], [job("failed")]);
    assert.ok(document.querySelector('[data-advisor-job-reaction="warning"]'));

    reactions.reactToMediaJobUpdates([job("processing")], [job("completed")]);
    const completed = document.querySelector("[data-advisor-celebration]");
    assert.ok(completed);
    completed.dispatchEvent(new window.Event("animationend"));
    assert.equal(document.querySelector("[data-advisor-celebration]"), null);

    now += 1_000;
    reactions.reactToMediaJobUpdates([job("processing")], [job("completed")]);
    assert.equal(document.querySelector("[data-advisor-celebration]"), null);

    window.matchMedia = () => ({ matches: true });
    reactions.reactToMediaJobUpdates([job("processing")], [job("interrupted")]);
    assert.equal(document.querySelector("[data-advisor-reaction]"), null);
  } finally {
    Date.now = originalNow;
    window.matchMedia = originalMatchMedia;
  }
});
