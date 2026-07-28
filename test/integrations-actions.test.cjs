const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("node:url");
const { buildPlatformCatalog } = require("../electron/platforms/catalog.cjs");
const { createAuthorizationRecord } = require("../electron/platforms/authorization.cjs");

// handlers.js binds document-level listeners once, so every test in this file
// shares one JSDOM. Creating a new document per test would leave the handlers
// attached to the previous one and silently swallow every click.
const projectRoot = path.join(__dirname, "..");
let booted;

async function boot() {
  if (booted) return booted;
  const html = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "file:///produdash/index.html" });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  dom.window.requestAnimationFrame = (callback) => callback();
  const load = (file) => import(pathToFileURL(path.join(projectRoot, file)).href);
  const [stateModule, renderModule, handlerModule] = await Promise.all([
    load("src/renderer/state.js"),
    load("src/renderer/render.js"),
    load("src/renderer/handlers.js")
  ]);
  stateModule.ui.providerCatalog = [];
  stateModule.setClipLibrary({ folders: [], clips: [], total: 0, offset: 0, limit: 40, notices: [] });
  stateModule.setProjects({ projects: [], collections: [], total: 0, notices: [] });
  stateModule.setAdvisorHistory({ turns: [], status: { ready: false, providerId: null, modelId: null, consentedCategories: [] } });
  handlerModule.bindHandlers();
  booted = { dom, ...stateModule, ...renderModule };
  return booted;
}

function appState({ youtube = {}, setting = {} } = {}) {
  const state = {
    businesses: [],
    conversations: [],
    approvals: [],
    integrations: [
      { id: "shopify", name: "Shopify", status: "disconnected", authorization: createAuthorizationRecord() },
      { id: "youtube", name: "YouTube", status: "disconnected", authorization: createAuthorizationRecord(), ...youtube }
    ],
    credentialSettings: [
      { id: "shopify", name: "Shopify", status: "missing", configuredFields: [], publicValues: {}, note: "Shopify", fields: [] },
      {
        id: "youtube",
        name: "YouTube",
        status: "missing",
        configuredFields: [],
        publicValues: {},
        note: "Google OAuth client",
        fields: [
          { key: "clientId", label: "OAuth client ID", placeholder: "Client ID", sensitive: false },
          { key: "clientSecret", label: "OAuth client secret", placeholder: "Client secret", sensitive: true }
        ],
        ...setting
      }
    ],
    aiProviders: [],
    aiWorkloads: {},
    advisorSettings: { displayName: "Juanito" },
    creatorPlatforms: [],
    analyticsSources: [],
    mediaJobs: [],
    clipperJobs: [],
    postQueue: [],
    auditLog: [],
    systemNotices: []
  };
  return { ...state, platformCatalog: buildPlatformCatalog(state) };
}

// Records what the renderer asked the main process to do.
function mockApi(overrides = {}) {
  const calls = [];
  const record =
    (name, result) =>
    async (...args) => {
      calls.push({ name, args });
      const handler = overrides[name];
      if (typeof handler === "function") return handler(...args);
      return result;
    };
  global.window.produdash = {
    getAppState: record("getAppState", { ok: true, data: appState() }),
    authorizeIntegration: record("authorizeIntegration", { ok: true, data: appState() }),
    disconnectIntegration: record("disconnectIntegration", { ok: true, data: appState() }),
    refreshIntegration: record("refreshIntegration", { ok: true, data: appState() }),
    removeIntegrationCredentials: record("removeIntegrationCredentials", { ok: true, data: appState() }),
    saveIntegrationCredentials: record("saveIntegrationCredentials", { ok: true, data: appState() })
  };
  return calls;
}

async function show(state) {
  const renderer = await boot();
  renderer.ui.activeSection = "integrations";
  renderer.ui.pending.clear();
  renderer.ui.error = null;
  renderer.setAppState(state);
  renderer.renderApp();
  return renderer;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// The Stage 5 publish button shipped broken because preload.cjs exposed
// dispatchPostPlan but src/renderer/api.js never wrapped it, so the call threw
// "client().dispatchPostPlan is not a function" at runtime. Nothing caught it
// because no test crossed that boundary. This pins the two together.
test("every preload method has a matching renderer api wrapper", () => {
  const read = (file) => fs.readFileSync(path.join(projectRoot, file), "utf8");
  const preload = read("electron/preload.cjs");
  const api = read("src/renderer/api.js");

  // Subscription factories are intentionally not part of the request api.
  const subscriptions = new Set(["onAdvisorEvent", "onMediaJobEvent"]);
  const exposed = [...preload.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*\(/gm)].map((match) => match[1]);
  assert.ok(exposed.length > 50, "expected to find the preload surface");

  const wrapped = new Set([...api.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*\(/gm)].map((match) => match[1]));
  const missing = exposed.filter((name) => !subscriptions.has(name) && !wrapped.has(name));
  assert.deepEqual(missing, [], `renderer api.js is missing wrappers for: ${missing.join(", ")}`);
});

test("YouTube renders as a live connection while platforms without connectors stay planned", async () => {
  await show(appState());
  assert.ok(document.querySelector('[data-credentials-form="youtube"]'), "YouTube must have a real connection form");
  assert.ok(document.querySelector('[data-credentials-form="shopify"]'));
  // No connector, so no form -- only a planned row.
  for (const id of ["tiktok", "instagram", "facebook", "stripe"]) {
    assert.equal(document.querySelectorAll(`[data-credentials-form="${id}"]`).length, 0, `${id} must not accept credentials`);
  }
  assert.match(document.querySelector(".planned-list").textContent, /Instagram/);
  assert.match(document.querySelector(".planned-list").textContent, /TikTok/);
});

test("the YouTube form shows its state and never renders a stored secret", async () => {
  await show(
    appState({ setting: { status: "stored", configuredFields: ["clientId", "clientSecret"], publicValues: { clientId: "abc.apps" } } })
  );
  const form = document.querySelector('[data-credentials-form="youtube"]');
  assert.equal(form.dataset.connectionState, "authorization_required");

  const secret = form.querySelector('input[name="clientSecret"]');
  assert.equal(secret.type, "password");
  // Blank value plus a placeholder telling the user it is stored; submitting it
  // unchanged preserves the stored secret in the main process.
  assert.equal(secret.value, "");
  assert.match(secret.placeholder, /stored securely/i);
  // The non-sensitive client id round-trips so the user can see what is saved.
  assert.equal(form.querySelector('input[name="clientId"]').value, "abc.apps");
});

test("required scopes and the audit limitation are disclosed", async () => {
  await show(appState({ setting: { status: "stored" } }));
  const disclosure = document.querySelector('[data-scope-disclosure="youtube"]');
  assert.ok(disclosure);
  assert.match(disclosure.textContent, /youtube\.upload/);
  assert.match(disclosure.textContent, /youtube\.readonly/);
  // The unaudited-project restriction has to be visible before publishing.
  assert.match(disclosure.textContent, /locked to private/i);
});

test("Connect calls authorizeIntegration for YouTube", async () => {
  await show(appState({ setting: { status: "stored" } }));
  const calls = mockApi();
  const connect = document.querySelector('[data-authorize-integration="youtube"]');
  assert.ok(connect);
  assert.equal(connect.disabled, false);
  connect.click();
  await flush();
  assert.deepEqual(
    calls.map((call) => call.name),
    ["authorizeIntegration"]
  );
  assert.deepEqual(calls[0].args, ["youtube"]);
});

test("Connect is disabled with an explanation before configuration is saved", async () => {
  await show(appState());
  const connect = document.querySelector('[data-authorize-integration="youtube"]');
  assert.equal(connect.disabled, true);
  assert.match(connect.dataset.disabledReason, /Save this platform's configuration first/i);
});

test("Disconnect revokes and is distinct from removing configuration", async () => {
  await show(
    appState({
      setting: { status: "stored" },
      youtube: { status: "connected", authorization: { ...createAuthorizationRecord(), hasAccessToken: true } }
    })
  );
  const calls = mockApi({
    // Disconnecting revokes the authorization but deliberately keeps the user's
    // own application configuration, so they can reauthorize without
    // re-entering their client id and secret.
    disconnectIntegration: async () => ({ ok: true, data: appState({ setting: { status: "stored" } }) })
  });
  global.window.confirm = () => true;

  document.querySelector('[data-disconnect-integration="youtube"]').click();
  await flush();
  assert.deepEqual(
    calls.map((call) => call.name),
    ["disconnectIntegration"]
  );

  // Configuration survived, so it is still separately removable.
  const form = document.querySelector('[data-credentials-form="youtube"]');
  assert.equal(form.dataset.connectionState, "authorization_required");
  document.querySelector('[data-remove-credentials="youtube"]').click();
  await flush();
  assert.deepEqual(
    calls.map((call) => call.name),
    ["disconnectIntegration", "removeIntegrationCredentials"]
  );
});

test("a destructive action is abandoned when the confirmation is declined", async () => {
  await show(
    appState({
      setting: { status: "stored" },
      youtube: { status: "connected", authorization: { ...createAuthorizationRecord(), hasAccessToken: true } }
    })
  );
  const calls = mockApi();
  global.window.confirm = () => false;
  document.querySelector('[data-disconnect-integration="youtube"]').click();
  await flush();
  assert.deepEqual(calls, []);
});

test("Test connection calls refreshIntegration", async () => {
  await show(appState({ setting: { status: "stored" } }));
  const calls = mockApi();
  document.querySelector('[data-refresh-integration="youtube"]').click();
  await flush();
  assert.deepEqual(
    calls.map((call) => call.name),
    ["refreshIntegration"]
  );
});

test("a repeated click cannot start a second authorization", async () => {
  await show(appState({ setting: { status: "stored" } }));
  let resolveAuthorize;
  const calls = mockApi({
    authorizeIntegration: () => new Promise((resolve) => (resolveAuthorize = () => resolve({ ok: true, data: appState() })))
  });
  const connect = document.querySelector('[data-authorize-integration="youtube"]');
  connect.click();
  await flush();
  // Second and third clicks land while the first is still in flight.
  connect.click();
  connect.click();
  await flush();
  assert.equal(calls.filter((call) => call.name === "authorizeIntegration").length, 1);
  resolveAuthorize();
  await flush();
});

test("a failed authorization surfaces a safe message and no raw provider detail", async () => {
  await show(appState({ setting: { status: "stored" } }));
  const renderer = await boot();
  mockApi({
    authorizeIntegration: async () => ({
      ok: false,
      error: { code: "OAUTH_CANCELED", message: "Authorization was canceled." }
    })
  });
  document.querySelector('[data-authorize-integration="youtube"]').click();
  await flush();
  assert.equal(renderer.ui.error, "Authorization was canceled.");
  assert.doesNotMatch(document.body.textContent, /ya29\.|client_secret|stack/i);
});
