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
  rendererModules ||= Promise.all([
    import(pathToFileURL(path.join(projectRoot, "src/renderer/state.js")).href),
    import(pathToFileURL(path.join(projectRoot, "src/renderer/render.js")).href)
  ]);
  const [stateModule, renderModule] = await rendererModules;
  stateModule.ui.activeSection = "overview";
  stateModule.ui.error = null;
  return { dom, ...stateModule, ...renderModule };
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
  assert.match(document.querySelector("#viewRoot").textContent, /waiting for real accounts/i);
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
  assert.equal(document.querySelector("#viewRoot img"), null);
  assert.equal(window.pwned, undefined);
  assert.match(document.querySelector("#viewRoot").textContent, /<img src=x/);
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
