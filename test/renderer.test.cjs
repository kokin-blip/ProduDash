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
  stateModule.ui.error = null;
  stateModule.ui.pending.clear();
  return { dom, ...stateModule, ...renderModule, ...formatModule };
}

function baseState(overrides = {}) {
  return {
    schemaVersion: 3,
    businesses: [],
    conversations: [],
    approvals: [],
    integrations: [],
    credentialSettings: [],
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
  assert.equal(document.querySelector('[data-section="integrations"]:disabled').textContent.trim(), "Connect Gemini");
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
  assert.equal(document.querySelector("img"), null);
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

test("Gemini setup action unlocks only after Shopify is connected", async () => {
  const renderer = await setupRenderer();
  renderer.setAppState(
    baseState({
      integrations: [
        { id: "shopify", name: "Shopify", status: "connected" },
        { id: "gemini", name: "Gemini", status: "disconnected" }
      ],
      credentialSettings: [
        { id: "shopify", name: "Shopify", status: "stored", fields: [] },
        { id: "gemini", name: "Gemini", status: "missing", fields: [] }
      ]
    })
  );
  renderer.renderApp();
  const geminiStep = [...document.querySelectorAll(".setup-step")].find((item) => /Connect Gemini/i.test(item.textContent));
  assert.equal(geminiStep.querySelector("button").disabled, false);
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
  assert.equal(document.querySelector("#pageTitle").textContent, "Local planning only");
  assert.equal(document.querySelector(".nav-list").dataset.activeSection, "studio");
});

test("keyed setup status badges animate only when their real value changes", async () => {
  const renderer = await setupRenderer();
  const credentialSettings = [
    { id: "shopify", name: "Shopify", status: "stored", fields: [] },
    { id: "gemini", name: "Gemini", status: "missing", fields: [] }
  ];
  renderer.setAppState(
    baseState({
      integrations: [
        { id: "shopify", name: "Shopify", status: "disconnected" },
        { id: "gemini", name: "Gemini", status: "disconnected" }
      ],
      credentialSettings
    })
  );
  renderer.renderApp();
  renderer.setAppState(
    baseState({
      integrations: [
        { id: "shopify", name: "Shopify", status: "connected" },
        { id: "gemini", name: "Gemini", status: "disconnected" }
      ],
      credentialSettings
    })
  );
  renderer.renderApp();
  assert.ok(document.querySelector('[data-status-key="setup-shopify"]').classList.contains("status-changed"));
  assert.equal(document.querySelector('[data-status-key="setup-gemini"]').classList.contains("status-changed"), false);

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
