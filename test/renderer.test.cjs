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
  return { dom, ...stateModule, ...renderModule, ...formatModule };
}

function baseState(overrides = {}) {
  return {
    schemaVersion: 4,
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
    advisorSettings: { displayName: "Advisor" },
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
  assert.equal(document.querySelector("#pageTitle").textContent, "Official sources required");
  assert.match(document.querySelector("#pageSubtitle").textContent, /approved connectors/i);
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
        error: "File unavailable"
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
  assert.equal(document.querySelectorAll('[role="tab"]').length, 3);
  assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim(), "Library");
  assert.match(document.querySelector(".clip-row").textContent, /<img src=x/);
  assert.equal(document.querySelector(".clip-row img"), null);
  assert.equal(window.libraryPwned, undefined);
  assert.match(document.querySelector(".clip-detail").textContent, /File unavailable/);
  assert.match(document.querySelector(".library-folders").textContent, /External drive is offline/);
  assert.equal(document.querySelector("[data-remove-clip]").textContent.trim(), "Remove from library");
});

test("Studio creates deterministic local jobs while preserving legacy plans as non-renderable", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
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
  assert.match(modes.textContent, /Local heuristics/);
  assert.match(modes.textContent, /Native video analysis/);
  assert.match(modes.textContent, /Transcript-only analysis/);
  assert.match(modes.textContent, /Transcript \+ sampled frames/);
  const frames = modes.querySelector('option[value="transcript_frames"]');
  assert.equal(frames.dataset.providerId, "gemini");
  assert.equal(frames.dataset.transcriptionProviderId, "openai");
  assert.equal(frames.dataset.categories, "audio,transcript,frames");
  assert.match(document.querySelector(".cloud-consent-check").textContent, /Consent for this job only/);
});

test("local whisper configuration uses native file selectors and never renders protected paths", async () => {
  const renderer = await setupRenderer();
  renderer.ui.providerCatalog.push({
    id: "whisper-cpp",
    name: "Local whisper.cpp",
    credentialFields: [
      { key: "executablePath", label: "whisper.cpp executable", type: "native-file", sensitive: true },
      { key: "modelPath", label: "Whisper model file", type: "native-file", sensitive: true }
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
  renderer.setAppState(state);
  renderer.ui.activeSection = "integrations";
  renderer.renderApp();
  const form = document.querySelector('[data-ai-provider-form="whisper-cpp"]');
  assert.equal(form.querySelectorAll("[data-local-whisper-file]").length, 2);
  assert.equal(form.querySelector('input[name="executablePath"]'), null);
  assert.doesNotMatch(form.textContent, /Users\/owner/);
  assert.match(form.textContent, /never downloads models/i);
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
          outputFolderName: "safe-output",
          status: "awaiting_review",
          stage: "candidate_review",
          progress: 75,
          settings: {},
          candidates: [
            {
              id: "candidate-1",
              title: "<svg onload=bad()>",
              start: 0,
              end: 8,
              confidence: 0.8,
              rationale: "<script>not markup</script>"
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
  assert.equal(document.querySelectorAll("[data-media-candidates-form] input").length, 1);
  assert.equal(document.querySelector("progress").value, 75);
  assert.match(document.querySelector(".artifact-list").textContent, /partial\.mp4/);
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

  document.querySelector("[data-delete-all]").click();
  await Promise.resolve();
  assert.equal(deleteCalls, 0);
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
      consentedCategories: ["dashboard_summary", "commerce_aggregates", "integration_health", "media_summaries"]
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
  assert.match(document.querySelector(".advisor-state-art").getAttribute("src"), /advisor-idle\.png$/);
  assert.equal(document.querySelector(".advisor-state-art").dataset.advisorArtState, "idle");
  renderer.renderApp();
  assert.equal(document.querySelector(".advisor-state-art").classList.contains("is-reacting"), false);
  for (const state of ["thinking", "success", "warning"]) {
    renderer.ui.advisorStatus = state;
    renderer.renderApp();
    const art = document.querySelector(".advisor-state-art");
    assert.match(art.getAttribute("src"), new RegExp(`advisor-${state}\\.png$`));
    assert.equal(art.dataset.advisorArtState, state);
    assert.equal(art.classList.contains("is-reacting"), true);
  }
  for (const asset of ["idle", "thinking", "success", "warning", "avatar"]) {
    assert.equal(fs.existsSync(path.join(projectRoot, `assets/advisor/states/advisor-${asset}.png`)), true);
  }
  const css = fs.readFileSync(path.join(projectRoot, "src/styles.css"), "utf8");
  assert.match(css, /\.advisor-panel/);
  for (const animation of [
    "advisor-avatar-react",
    "advisor-idle-arrive",
    "advisor-thinking-react",
    "advisor-success-react",
    "advisor-warning-react"
  ]) {
    assert.match(css, new RegExp(`@keyframes ${animation}`));
  }
  assert.doesNotMatch(css, /advisor-(?:avatar|idle|thinking|success|warning)[^{]*\{[^}]*animation:[^;}]*infinite/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.advisor-state-art[\s\S]*animation: none !important/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.advisor-panel/);
  assert.doesNotMatch(css, /transition:\s*all/);
});
