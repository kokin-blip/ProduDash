const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { _electron: electron } = require("playwright");
const { getMediaBinaries } = require("../electron/media/binaries.cjs");

test("Electron starts securely and shows the connection-first workflow", { timeout: 90_000 }, async (t) => {
  const projectRoot = path.join(__dirname, "..");
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "produdash-smoke-"));
  const fixturePath = path.join(userDataPath, "smoke-source.mp4");
  const logoPath = path.join(userDataPath, "smoke-logo.png");
  const mediaOutputPath = path.join(userDataPath, "generated");
  fs.mkdirSync(mediaOutputPath);
  createMediaFixture(fixturePath);
  createLogoFixture(logoPath);
  const sourceChecksum = crypto.createHash("sha256").update(fs.readFileSync(fixturePath)).digest("hex");
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
  assert.equal(
    await page.locator(".nav-list").evaluate((navigation) => {
      const iconPath = navigation.querySelector('[data-section="analytics"] .nav-icon path');
      return iconPath?.getAttribute("d") === "M4 19V11M10 19V6M16 19v-5M3 19h18M4 11l6-5 6 8 4-4";
    }),
    true
  );
  assert.ok((await page.evaluate(() => window.__viewTransitionStarts)) >= sections.length - 1);
  await page.waitForFunction(() => document.querySelector("#pageTitle").textContent.includes("Connections and local data"));
  assert.equal(await page.locator('[data-section="integrations"]').getAttribute("aria-current"), "page");
  assert.equal(await page.locator('[data-credentials-form="shopify"]').getAttribute("aria-busy"), "false");
  assert.equal(await page.locator('[data-credentials-form="instagram"]').count(), 0);
  assert.equal(await page.locator('[data-ai-provider-form="gemini"]').count(), 1);
  assert.equal(await page.locator('[data-workload-form="inboxDrafting"]').count(), 1);

  await page.click('[data-section="studio"]');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('[role="tab"]').count(), 5);
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
        { canceled: false, filePaths: [selections.mediaOutputPath], bookmarks: [] },
        { canceled: false, filePaths: [selections.logoPath], bookmarks: [] },
        { canceled: false, filePaths: [selections.mediaOutputPath], bookmarks: [] }
      ];
      dialog.showOpenDialog = async () => queue.shift() || { canceled: true, filePaths: [], bookmarks: [] };
    },
    { fixturePath, logoPath, mediaOutputPath }
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
    await page.locator('[data-media-job-form] select[name="captionMode"]').selectOption("srt_burned");
    await page.locator('[data-media-job-form] textarea[name="captionText"]').fill("Human-approved local caption");
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
    const smokeJobId = await page.locator("[data-candidate-review]").getAttribute("data-candidate-review");
    assert.equal(await page.locator('[data-media-candidates-form] input[name="candidateIds"]').isChecked(), false);
    assert.ok(await page.locator("[data-candidate-video]").getAttribute("src"));
    assert.match(await page.locator(".candidate-caption-preview").textContent(), /Human-approved local caption/);
    await page.locator("[data-candidate-edit-form] input[name='title']").fill("Smoke approved clip");
    await page.locator("[data-candidate-edit-form] input[name='start']").fill("0.25");
    await page.locator("[data-candidate-edit-form] input[name='end']").fill("5.75");
    await page.screenshot({ path: path.join(artifactPath, "candidate-editing-1440x960.png"), fullPage: true });
    await page.screenshot({ path: path.join(artifactPath, "caption-preview-1440x960.png"), fullPage: true });
    await resizeWindow(application, 1120, 760);
    assert.equal(await hasHorizontalOverflow(page), false);
    await page.screenshot({ path: path.join(artifactPath, "candidate-editing-1120x760.png"), fullPage: true });
    await resizeWindow(application, 1440, 960);
    await page.locator("[data-candidate-edit-form] button[type='submit']").click();
    await page.waitForFunction(() => !document.querySelector("[data-candidate-edit-form] .is-pending"));
    const candidateSaveError = await page.locator('[role="alert"]').allTextContents();
    assert.deepEqual(candidateSaveError, []);
    assert.equal(await page.locator("[data-candidate-edit-form] input[name='title']").inputValue(), "Smoke approved clip");
    await page.locator("[data-project-from-candidate]").click();
    await page.waitForSelector("[data-project-editor]");
    assert.equal(await page.locator('[data-studio-tab="projects"]').getAttribute("aria-selected"), "true");
    assert.match(await page.locator("[data-project-editor]").textContent(), /Smoke approved clip/);
    assert.match(await page.locator("[data-project-editor]").textContent(), /Recoverable draft/);
    await page.locator("[data-transcript-id]").fill("Transcript correction flushed before version save");
    await page.locator("[data-project-playhead]").fill("2");
    await page.locator("[data-project-split]").click();
    await page.waitForFunction(() => document.querySelectorAll(".timeline-segment").length === 2);
    await page.locator("[data-project-save-version]").click();
    await page.waitForFunction(() => document.querySelector("[data-project-editor]")?.textContent.includes("Saved version"));
    assert.equal(await page.locator("[data-transcript-id]").inputValue(), "Transcript correction flushed before version save");
    await page.click('[data-studio-tab="templates"]');
    await page.waitForSelector("[data-template-create-form]");
    await page.locator(".template-asset-workspace").locator("..").locator("summary").click();
    await page.click('[data-brand-asset-import="logo"]');
    await page.waitForSelector("[data-brand-asset-delete]", { state: "attached" });
    await page.locator(".template-asset-workspace").locator("..").locator("summary").click();
    await page.locator('[data-template-create-form] select[name="logoAssetId"]').selectOption({ index: 1 });
    await page.locator('[data-template-create-form] input[name="name"]').fill("Smoke brand");
    await page.locator('[data-template-create-form] input[name="description"]').fill("Local Phase 2 composition");
    await page.locator('[data-template-create-form] input[name="overlayText"]').fill("Shop the smoke launch");
    await page.locator('[data-template-create-form] select[name="transition"]').selectOption("fade");
    await page.locator("[data-template-create-form]").evaluate((form) => form.requestSubmit());
    await page.waitForSelector(".template-card");
    assert.match(await page.locator(".template-card").textContent(), /Smoke brand/);
    await page.screenshot({ path: path.join(artifactPath, "brand-templates-1440x960.png"), fullPage: true });
    await page.locator("[data-template-apply]").click();
    await page.click('[data-studio-tab="projects"]');
    await page.waitForSelector("[data-project-editor]");
    assert.match(await page.locator("[data-project-editor]").textContent(), /Shop the smoke launch/);
    assert.match(await page.locator("[data-project-editor]").textContent(), /template v1/);
    assert.equal(await page.locator(".project-preview-logo").count(), 1);
    await page.screenshot({ path: path.join(artifactPath, "project-editor-1440x960.png"), fullPage: true });
    await resizeWindow(application, 1120, 760);
    assert.equal(await hasHorizontalOverflow(page), false);
    await page.screenshot({ path: path.join(artifactPath, "project-editor-1120x760.png"), fullPage: true });
    await resizeWindow(application, 1440, 960);
    await page.locator("[data-project-prepare]").click();
    await page.waitForFunction(
      () => document.querySelector("[data-project-prepare]")?.textContent.includes("Rebuild local signals"),
      null,
      { timeout: 30_000 }
    );
    await page.locator("[data-project-choose-output]").click();
    await page.locator("[data-project-render]").click();
    const projectRenderIds = await waitForMediaJobIds(page, "project_render");
    assert.equal(projectRenderIds.length, 1);
    const [projectRenderId] = projectRenderIds;
    const projectRenderStatus = await waitForMediaJobTerminal(page, projectRenderId);
    assert.equal(projectRenderStatus, "completed");
    await page.screenshot({ path: path.join(artifactPath, "project-complete-1440x960.png"), fullPage: true });
    await page.click('[data-studio-tab="create"]');
    await page.waitForSelector("[data-candidate-select]");
    await page.locator("[data-candidate-select]").click();
    assert.equal(await page.locator('[data-media-candidates-form] input[name="candidateIds"]').isChecked(), true);
    await page.waitForTimeout(1850);
    await page.locator('[data-media-candidates-form] button[type="submit"]').click();
    await page.waitForTimeout(250);
    const approvalError = await page.locator('[role="alert"]').allTextContents();
    assert.deepEqual(approvalError, []);
    await waitForMediaJobTerminal(page, smokeJobId);
    assert.match(await page.locator(`[data-media-job="${smokeJobId}"]`).textContent(), /completed/);
    assert.equal(await page.locator(`[data-media-job="${smokeJobId}"] .artifact-list`).count(), 1);
    assert.ok(await page.locator("[data-advisor-celebration]").count());
    await page.screenshot({ path: path.join(artifactPath, "media-complete-1440x960.png"), fullPage: true });
    await page.evaluate(async () => {
      const reactions = await import("./src/renderer/advisor-reactions.js");
      reactions.reactToMediaJobUpdates([{ id: "smoke-warning", status: "processing" }], [{ id: "smoke-warning", status: "failed" }]);
    });
    assert.equal(await page.locator('[data-advisor-job-reaction="warning"]').count(), 1);
    await page.screenshot({ path: path.join(artifactPath, "media-warning-1440x960.png"), fullPage: true });
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
        consentedCategories: ["dashboard_summary", "commerce_aggregates", "integration_health", "media_summaries", "application_context"]
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
  assert.equal(
    await page.locator(".advisor-journal-sequence").evaluate((element) => window.getComputedStyle(element).animationName),
    "advisor-journal-appear"
  );
  assert.match(await page.locator(".advisor-art-stack").getAttribute("class"), /journal-cadence-(?:calm|patient|reflective)/);
  await page.evaluate(() => {
    for (const selector of [".advisor-idle-base", ".advisor-journal-sequence", ".advisor-journal-sprite"]) {
      const animation = document.querySelector(selector)?.getAnimations()[0];
      const duration = Number(animation?.effect.getTiming().duration);
      if (!animation || !Number.isFinite(duration)) continue;
      animation.currentTime = duration * 0.765;
      animation.pause();
    }
  });
  assert.equal(await page.locator(".advisor-idle-base").evaluate((element) => window.getComputedStyle(element).opacity), "0");
  assert.equal(await page.locator(".advisor-journal-sequence").evaluate((element) => window.getComputedStyle(element).opacity), "1");
  assert.match(
    await page.locator(".advisor-journal-sprite").evaluate((element) => window.getComputedStyle(element).backgroundPosition),
    /42\.8571%/
  );
  await page.screenshot({ path: path.join(artifactPath, "advisor-journal-1440x960.png"), fullPage: true });
  await page.waitForTimeout(1850);
  assert.equal(
    await page.evaluate(async () => {
      const advisor = await import("./src/renderer/advisor.js");
      return advisor.celebrateAdvisor();
    }),
    true
  );
  assert.match(await page.locator("[data-advisor-celebration]").getAttribute("data-advisor-celebration"), /^(?:hop|notebook)$/);
  assert.equal(
    await page.locator(".advisor-celebration-popover").evaluate((element) => window.getComputedStyle(element).animationName),
    "advisor-celebration-pop"
  );
  assert.equal(
    await page.locator(".advisor-celebration-sprite").evaluate((element) => window.getComputedStyle(element).animationName),
    "advisor-celebration-frames"
  );
  await page.evaluate(() => {
    for (const selector of [".advisor-celebration-popover", ".advisor-celebration-sprite"]) {
      const animation = document.querySelector(selector)?.getAnimations()[0];
      const duration = Number(animation?.effect.getTiming().duration);
      if (!animation || !Number.isFinite(duration)) continue;
      animation.currentTime = duration * 0.55;
      animation.pause();
    }
  });
  await page.screenshot({ path: path.join(artifactPath, "advisor-celebration-1440x960.png"), fullPage: true });
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
  assert.equal(
    await page.locator(".advisor-journal-sequence").evaluate((element) => window.getComputedStyle(element).animationName),
    "none"
  );
  assert.equal(
    await page.evaluate(async () => {
      const advisor = await import("./src/renderer/advisor.js");
      return advisor.celebrateAdvisor();
    }),
    false
  );
  assert.equal(await page.locator("[data-advisor-celebration]").count(), 0);
  await page.screenshot({ path: path.join(artifactPath, "reduced-motion-1120x760.png"), fullPage: true });
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
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(fixturePath)).digest("hex"), sourceChecksum);
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

async function waitForMediaJobIds(page, jobType, timeout = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const ids = await page.evaluate(async (type) => {
      const response = await window.produdash.getAppState();
      return response.data.mediaJobs.filter((job) => job.jobType === type).map((job) => job.id);
    }, jobType);
    if (ids.length) return ids;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for a ${jobType} media job.`);
}

async function waitForMediaJobTerminal(page, jobId, timeout = 45_000) {
  const startedAt = Date.now();
  let lastStatus = "missing";
  while (Date.now() - startedAt < timeout) {
    const status = await page.evaluate(async (id) => {
      const response = await window.produdash.getAppState();
      return response.data.mediaJobs.find((job) => job.id === id)?.status || "missing";
    }, jobId);
    lastStatus = status;
    if (["completed", "failed"].includes(status)) return status;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for media job ${jobId}; last status was ${lastStatus}.`);
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

function createLogoFixture(filePath) {
  const { ffmpegPath } = getMediaBinaries();
  const result = spawnSync(
    ffmpegPath,
    ["-nostdin", "-y", "-f", "lavfi", "-i", "color=c=0x7aa2f7:s=128x64", "-frames:v", "1", "-update", "1", filePath],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
}

async function renderConnectedFixture(page) {
  await page.evaluate(async () => {
    const state = await import("./src/renderer/state.js");
    const render = await import("./src/renderer/render.js");
    const fixture = {
      schemaVersion: 6,
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
      advisorSettings: { displayName: "Juanito" },
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
