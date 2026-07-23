const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { _electron: electron } = require("playwright");
const { getMediaBinaries } = require("../electron/media/binaries.cjs");

test("Electron starts securely and shows the connection-first workflow", { timeout: 60_000 }, async (t) => {
  const projectRoot = path.join(__dirname, "..");
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "produdash-smoke-"));
  const fixturePath = path.join(userDataPath, "smoke-source.mp4");
  const mediaOutputPath = path.join(userDataPath, "generated");
  fs.mkdirSync(mediaOutputPath);
  createMediaFixture(fixturePath);
  const artifactPath = path.join(projectRoot, "test-results", "smoke");
  fs.mkdirSync(artifactPath, { recursive: true });
  let application;
  t.after(async () => {
    if (application) await application.close();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });

  application = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataPath}`],
    env: {
      ...process.env,
      ELECTRON_ENABLE_SECURITY_WARNINGS: "true"
    }
  });
  const page = await application.firstWindow();
  const consoleProblems = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) consoleProblems.push(message.text());
  });
  page.on("pageerror", (error) => consoleProblems.push(error.message));

  await page.waitForSelector("#viewRoot");
  await assert.doesNotReject(() =>
    page.waitForFunction(() => document.querySelector("#pageTitle").textContent.includes("Set up ProduDash"))
  );
  assert.equal(await page.locator('[data-section="overview"]').getAttribute("aria-current"), "page");
  await page.screenshot({ path: path.join(artifactPath, "empty-1440x960.png") });
  await page.click("[data-advisor-toggle]");
  assert.equal(await page.locator("[data-advisor-toggle]").getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("#advisorPanel").getAttribute("aria-hidden"), "false");
  assert.match(await page.locator("#advisorPanel").textContent(), /Connection required/i);
  await page.locator(".advisor-privacy > summary").click();
  assert.equal(await page.locator(".advisor-privacy").getAttribute("open"), "");
  assert.match(await page.locator(".advisor-privacy .disclosure-content").textContent(), /50 visible turns/i);
  await page.screenshot({ path: path.join(artifactPath, "advisor-empty-1440x960.png") });
  await page.click("[data-advisor-close]");
  assert.equal(await page.locator("[data-advisor-toggle]").getAttribute("aria-expanded"), "false");
  assert.equal(await page.evaluate(() => document.activeElement.matches("[data-advisor-toggle]")), true);

  await resizeWindow(application, 1120, 760);
  assert.equal(await hasHorizontalOverflow(page), false);
  await page.click("[data-advisor-toggle]");
  assert.equal(await hasHorizontalOverflow(page), false);
  await page.screenshot({ path: path.join(artifactPath, "advisor-empty-1120x760.png") });
  await page.click("[data-advisor-close]");
  await page.screenshot({ path: path.join(artifactPath, "empty-1120x760.png") });

  await resizeWindow(application, 1440, 960);
  await page.evaluate(() => {
    const nativeStartViewTransition = document.startViewTransition.bind(document);
    window.__viewTransitionStarts = 0;
    document.startViewTransition = (update) => {
      window.__viewTransitionStarts += 1;
      return nativeStartViewTransition(update);
    };
  });
  const sections = ["overview", "inbox", "orders", "signals", "studio", "analytics", "integrations"];
  for (const section of sections) {
    await page.click(`[data-section="${section}"]`);
    await page.waitForFunction(
      (activeSection) => document.querySelector(`[data-section="${activeSection}"]`).getAttribute("aria-current") === "page",
      section
    );
    assert.equal(await page.locator(`[data-section="${section}"]`).getAttribute("aria-current"), "page");
    assert.equal(await page.locator(".nav-list").getAttribute("data-active-section"), section);
  }
  assert.ok((await page.evaluate(() => window.__viewTransitionStarts)) >= sections.length - 1);
  await page.waitForFunction(() => document.querySelector("#pageTitle").textContent.includes("Connections and local data"));
  assert.equal(await page.locator('[data-section="integrations"]').getAttribute("aria-current"), "page");
  assert.equal(await page.locator('[data-credentials-form="shopify"]').getAttribute("aria-busy"), "false");
  assert.equal(await page.locator('[data-credentials-form="instagram"]').count(), 0);
  assert.equal(await page.locator('[data-ai-provider-form="gemini"]').count(), 1);
  assert.equal(await page.locator('[data-workload-form="inboxDrafting"]').count(), 1);

  await page.click('[data-section="studio"]');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('[role="tab"]').count(), 3);
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').textContent(), "Library");
  assert.match(await page.locator(".studio-tab-panel").textContent(), /No matching videos/);
  assert.equal(await hasHorizontalOverflow(page), false);
  await page.screenshot({ path: path.join(artifactPath, "library-empty-1440x960.png"), fullPage: true });
  await resizeWindow(application, 1120, 760);
  assert.equal(await hasHorizontalOverflow(page), false);
  await page.screenshot({ path: path.join(artifactPath, "library-empty-1120x760.png"), fullPage: true });
  await resizeWindow(application, 1440, 960);
  await application.evaluate(
    ({ dialog }, selections) => {
      const queue = [
        { canceled: false, filePaths: [selections.fixturePath], bookmarks: [] },
        { canceled: false, filePaths: [selections.mediaOutputPath], bookmarks: [] }
      ];
      dialog.showOpenDialog = async () => queue.shift() || { canceled: true, filePaths: [], bookmarks: [] };
    },
    { fixturePath, mediaOutputPath }
  );
  await page.click("[data-add-clip-files]");
  await page.waitForSelector(".clip-row");
  await page.click('[data-studio-tab="create"]');
  assert.equal(await page.locator("[data-media-job-form]").count(), 1);
  const secureStorageUnavailable = await page.evaluate(async () => {
    const response = await window.produdash.getAppState();
    return response.data.systemNotices.some((notice) => notice.code === "SECURE_STORAGE_UNAVAILABLE");
  });
  if (!secureStorageUnavailable) {
    await page.click("[data-choose-media-output]");
    await page.locator('[data-media-job-form] select[name="sourceMediaId"]').selectOption({ index: 1 });
    await page.locator('[data-media-job-form] input[name="title"]').fill("Smoke clip");
    await page.locator('[data-media-job-form] input[name="targetDuration"]').fill("5");
    await page.locator("[data-media-job-form]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(
      () => {
        const status = document.querySelector(".media-job .status-badge")?.textContent || "";
        return status.includes("awaiting review") || status.includes("failed");
      },
      null,
      { timeout: 30_000 }
    );
    assert.match(await page.locator(".media-job").textContent(), /awaiting review/);
    await page.screenshot({ path: path.join(artifactPath, "media-review-1440x960.png"), fullPage: true });
    await page.locator('[data-media-candidates-form] button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector(".media-job .status-badge")?.textContent.includes("completed"), null, {
      timeout: 30_000
    });
    assert.equal(await page.locator(".artifact-list").count(), 1);
    await page.screenshot({ path: path.join(artifactPath, "media-complete-1440x960.png"), fullPage: true });
    const generatedJobPath = path.join(mediaOutputPath, fs.readdirSync(mediaOutputPath)[0]);
    assert.equal(fs.existsSync(path.join(generatedJobPath, "produdash-manifest.json")), true);
    assert.equal(fs.existsSync(path.join(generatedJobPath, ".produdash-job")), false);
  }
  await page.click('[data-studio-tab="publishing"]');
  assert.equal(await page.locator("[data-post-form]").count(), 1);
  await page.click('[data-section="integrations"]');

  await page.locator("#viewRoot details.disclosure:not(.danger-zone) > summary").click();
  assert.equal(await page.locator("#viewRoot details.disclosure:not(.danger-zone)").getAttribute("open"), "");
  assert.match(
    await page.locator("#viewRoot details.disclosure:not(.danger-zone) .disclosure-content").textContent(),
    /Official connections only/
  );
  await page.locator("#viewRoot details.disclosure:not(.danger-zone) > summary").click();
  assert.equal(await page.locator("#viewRoot details.disclosure:not(.danger-zone)").getAttribute("open"), null);
  await page.locator("details.danger-zone > summary").click();
  assert.equal(await page.locator("details.danger-zone").getAttribute("open"), "");
  await page.locator("details.danger-zone [data-delete-all]").waitFor({ state: "visible" });
  await page.locator("details.danger-zone > summary").click();
  assert.equal(await page.locator("details.danger-zone").getAttribute("open"), null);

  await page.focus('[data-section="overview"]');
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-section="overview"]').getAttribute("aria-current") === "page");
  assert.equal(await page.locator('[data-section="overview"]').getAttribute("aria-current"), "page");
  await page.focus('[data-section="inbox"]');
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector('[data-section="inbox"]').getAttribute("aria-current") === "page");
  assert.equal(await page.locator('[data-section="inbox"]').getAttribute("aria-current"), "page");
  await page.evaluate(() => {
    ["studio", "orders", "analytics", "signals", "integrations"].forEach((section) => {
      document.querySelector(`[data-section="${section}"]`).click();
    });
  });
  await page.waitForFunction(
    () =>
      document.querySelector(".nav-list").dataset.activeSection === "integrations" &&
      document.querySelector('[data-section="integrations"]').getAttribute("aria-current") === "page" &&
      document.querySelector("#pageTitle").textContent.includes("Connections and local data")
  );

  await page.evaluate(() => {
    window.__pendingPresentationObserved = false;
    const observer = new window.MutationObserver(() => {
      if (
        document.querySelector('[data-credentials-form="shopify"][aria-busy="true"]') &&
        document.querySelector('[data-credentials-form="shopify"] .button-spinner')
      ) {
        window.__pendingPresentationObserved = true;
        observer.disconnect();
      }
    });
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
  });
  await page.locator('[data-credentials-form="shopify"] input[name="storeDomain"]').fill("invalid.example.com");
  await page.locator('[data-credentials-form="shopify"] input[type="password"]').fill("shpat_smoke_test_secret");
  await page.evaluate(() => {
    const form = document.querySelector('[data-credentials-form="shopify"]');
    form.requestSubmit(form.querySelector('button[type="submit"]'));
  });
  await page.locator('[role="alert"]').waitFor({ timeout: 10_000 });
  assert.equal(await page.evaluate(() => window.__pendingPresentationObserved), true);
  assert.equal(await page.locator('[data-credentials-form="shopify"]').getAttribute("aria-busy"), "false");
  assert.equal(await page.locator('[data-credentials-form="shopify"] .button-spinner').count(), 0);
  assert.equal(await page.locator('[data-credentials-form="shopify"] button[type="submit"]').isEnabled(), true);
  await page.evaluate(async () => {
    const response = await window.produdash.deleteAllLocalData();
    if (!response.ok) throw new Error(response.error.message);
    const state = await import("./src/renderer/state.js");
    const render = await import("./src/renderer/render.js");
    state.setAppState({ ...response.data, systemNotices: [] });
    state.ui.activeSection = "integrations";
    state.ui.error = null;
    render.renderApp();
  });
  await page.screenshot({ path: path.join(artifactPath, "integrations-1440x960.png"), fullPage: true });

  await resizeWindow(application, 1120, 760);
  assert.equal(await hasHorizontalOverflow(page), false);
  await page.screenshot({ path: path.join(artifactPath, "integrations-1120x760.png"), fullPage: true });

  await page.focus('[data-section="overview"]');
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.section), "inbox");
  const focusOutline = await page.locator('[data-section="inbox"]').evaluate((element) => window.getComputedStyle(element).outlineStyle);
  assert.notEqual(focusOutline, "none");

  await resizeWindow(application, 1440, 960);
  await renderConnectedFixture(page);
  await page.waitForFunction(() => document.querySelector("#pageTitle").textContent.includes("Northstar Supply"));
  assert.equal(await hasHorizontalOverflow(page), false);
  assert.equal(await page.locator("table tbody tr").count(), 2);
  await page.screenshot({ path: path.join(artifactPath, "connected-1440x960.png"), fullPage: true });
  await page.evaluate(async () => {
    const state = await import("./src/renderer/state.js");
    const advisor = await import("./src/renderer/advisor.js");
    state.setAdvisorHistory({
      turns: [
        {
          id: "advisor-user-fixture",
          role: "user",
          text: "What needs my attention today?",
          at: new Date().toISOString(),
          providerId: "gemini",
          modelId: "gemini-3.6-flash",
          usage: null,
          tools: []
        },
        {
          id: "advisor-reply-fixture",
          role: "assistant",
          text: "One paid order still awaits fulfillment, and one reply draft needs human approval. Profit and conversion remain unavailable.",
          at: new Date().toISOString(),
          providerId: "gemini",
          modelId: "gemini-3.6-flash",
          usage: { totalTokens: 84 },
          tools: ["get_attention_items", "get_business_overview"]
        }
      ],
      status: {
        ready: true,
        providerId: "gemini",
        modelId: "gemini-3.6-flash",
        consentedCategories: ["dashboard_summary", "commerce_aggregates", "integration_health", "media_summaries"]
      }
    });
    state.ui.advisorOpen = true;
    state.ui.advisorStatus = "success";
    advisor.renderAdvisor();
  });
  assert.equal(await page.locator("[data-advisor-form]").getAttribute("aria-busy"), "false");
  assert.match(await page.locator("#advisorPanel").textContent(), /one reply draft needs human approval/i);
  assert.match(await page.locator(".advisor-state-art").getAttribute("src"), /advisor-success\.png$/);
  assert.equal(await page.locator(".advisor-art-stack").getAttribute("data-advisor-art-state"), "success");
  assert.equal(
    await page.locator(".advisor-art-reaction").evaluate((element) => window.getComputedStyle(element).animationName),
    "advisor-success-react"
  );
  await page.screenshot({ path: path.join(artifactPath, "advisor-connected-1440x960.png"), fullPage: true });
  await page.evaluate(async () => {
    const state = await import("./src/renderer/state.js");
    const advisor = await import("./src/renderer/advisor.js");
    state.ui.advisorStatus = "idle";
    advisor.renderAdvisor();
  });
  assert.match(
    await page.locator(".advisor-art-stack").evaluate((element) => window.getComputedStyle(element).animationName),
    /advisor-idle-breathe/
  );
  assert.equal(
    await page.locator(".advisor-idle-blink").evaluate((element) => window.getComputedStyle(element).animationName),
    "advisor-blink"
  );
  await page.click("[data-advisor-close]");

  await resizeWindow(application, 1120, 760);
  assert.equal(await hasHorizontalOverflow(page), false);
  await page.screenshot({ path: path.join(artifactPath, "connected-1120x760.png"), fullPage: true });

  await setZoomFactor(application, 1.25);
  assert.equal(await hasHorizontalOverflow(page), false);
  await setZoomFactor(application, 1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches), true);
  await page.click("[data-advisor-toggle]");
  assert.equal(await page.locator("#advisorPanel").evaluate((element) => window.getComputedStyle(element).transitionDuration), "0s");
  assert.equal(await page.locator(".advisor-art-stack").evaluate((element) => window.getComputedStyle(element).animationName), "none");
  assert.equal(await page.locator(".advisor-art-reaction").evaluate((element) => window.getComputedStyle(element).animationName), "none");
  await page.click("[data-advisor-close]");
  const reducedMotionTransitionCount = await page.evaluate(() => window.__viewTransitionStarts);
  await page.click('[data-section="studio"]');
  assert.equal(await page.locator('[data-section="studio"]').getAttribute("aria-current"), "page");
  assert.equal(await page.evaluate(() => window.__viewTransitionStarts), reducedMotionTransitionCount);

  await page.evaluate(async () => {
    const state = await import("./src/renderer/state.js");
    const render = await import("./src/renderer/render.js");
    state.ui.activeSection = "integrations";
    state.ui.error = "The provider could not be validated. Check the connection details and try again.";
    state.ui.pending.add("credentials-shopify");
    render.renderApp();
  });
  assert.equal(await page.locator('[role="alert"]').getAttribute("tabindex"), "-1");
  assert.equal(await page.locator('[data-credentials-form="shopify"]').getAttribute("aria-busy"), "true");
  await page.screenshot({ path: path.join(artifactPath, "interaction-states-1120x760.png"), fullPage: true });

  const stateResponse = await page.evaluate(() => window.produdash.getAppState());
  assert.equal(stateResponse.ok, true);
  const secretFieldHasValue = stateResponse.data.credentialSettings.some((setting) =>
    setting.fields.some((field) => field.sensitive && Object.hasOwn(field, "value"))
  );
  assert.equal(secretFieldHasValue, false);
  assert.equal(JSON.stringify(stateResponse).includes("ciphertext"), false);
  assert.equal(
    consoleProblems.some((message) => /Content Security Policy|Electron Security Warning|Uncaught/i.test(message)),
    false,
    consoleProblems.join("\n")
  );
});

async function resizeWindow(application, width, height) {
  await application.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setSize(size.width, size.height);
    },
    { width, height }
  );
}

async function setZoomFactor(application, factor) {
  await application.evaluate(({ BrowserWindow }, zoomFactor) => {
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoomFactor);
  }, factor);
}

async function hasHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

function createMediaFixture(filePath) {
  const { ffmpegPath } = getMediaBinaries();
  const result = spawnSync(
    ffmpegPath,
    [
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:sample_rate=48000",
      "-t",
      "6",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      filePath
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
}

async function renderConnectedFixture(page) {
  await page.evaluate(async () => {
    const state = await import("./src/renderer/state.js");
    const render = await import("./src/renderer/render.js");
    const fixture = {
      schemaVersion: 4,
      selectedBusinessId: "business-1",
      businesses: [
        {
          id: "business-1",
          name: "Northstar Supply",
          type: "Shopify store",
          category: "Outdoor goods",
          health: "Connected",
          connectionStatus: "connected",
          currency: "USD",
          metrics: { revenue: 6840, orderCount: 2, profit: null, conversion: null },
          financeTrend: [
            { week: "Jun 30", revenue: 920 },
            { week: "Jul 7", revenue: 1510 },
            { week: "Jul 14", revenue: 1890 },
            { week: "Jul 21", revenue: 2520 }
          ],
          orders: [
            {
              id: "#1042",
              customer: "Avery Chen",
              paymentStatus: "paid",
              fulfillmentStatus: "fulfilled",
              value: 2640,
              currency: "USD"
            },
            {
              id: "#1041",
              customer: "Morgan Lee",
              paymentStatus: "paid",
              fulfillmentStatus: "unfulfilled",
              value: 4200,
              currency: "USD"
            }
          ],
          signals: [{ id: "signal-1", level: "high", title: "Order #1041 awaits fulfillment", detail: "Payment is verified." }]
        }
      ],
      conversations: [
        {
          id: "conversation-1",
          businessId: "business-1",
          customer: "Taylor Brooks",
          channel: "Instagram",
          intent: "Product question",
          risk: "Human review",
          status: "open",
          messages: []
        }
      ],
      approvals: [
        {
          id: "approval-1",
          businessId: "business-1",
          conversationId: "conversation-1",
          type: "reply",
          status: "pending",
          nextAction: "Review product reply",
          draft: "A concise draft is ready for review."
        }
      ],
      integrations: [
        {
          id: "shopify",
          name: "Shopify",
          status: "connected",
          detail: "Store identity and recent commerce data verified.",
          lastSync: "Just now"
        }
      ],
      credentialSettings: [{ id: "shopify", name: "Shopify", status: "stored", fields: [] }],
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
              capabilities: ["text_generation", "structured_output", "tool_calling"]
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
      auditLog: [{ id: "audit-1", at: new Date().toISOString(), type: "shopify_sync", detail: "Shopify snapshot refreshed." }],
      systemNotices: []
    };
    state.setAppState(fixture);
    state.ui.activeSection = "overview";
    state.ui.error = null;
    state.ui.pending.clear();
    render.renderApp();
    document.activeElement.blur();
  });
}
