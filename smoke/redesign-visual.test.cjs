const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { _electron: electron } = require("playwright");
const { buildAnalyticsReport } = require("../electron/analytics-report.cjs");
const { createMediaFixture, renderConnectedFixture } = require("./visual-fixtures.cjs");

// Fixture values exist only in this isolated test process/renderer. External
// providers are never contacted, and no credentials or customer workspace is used.
test("redesign covers both appearances, minimum window size, keyboard access and background updates", { timeout: 180_000 }, async (t) => {
  const projectRoot = path.join(__dirname, "..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "produdash-visual-"));
  const source = path.join(directory, "Product demonstration.mp4");
  const output = path.join(directory, "output");
  const artifacts = path.join(projectRoot, "test-results", "redesign");
  fs.mkdirSync(output);
  fs.mkdirSync(artifacts, { recursive: true });
  createMediaFixture(source);
  let application = await electron.launch({ args: [projectRoot, `--user-data-dir=${directory}`] });
  t.after(async () => {
    await application.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".setup-steps");
  const manifest = [];
  let appearance;
  let dimensions;
  async function size(width, height) {
    dimensions = `${width}x${height}`;
    await application.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setSize(...bounds), [width, height]);
  }
  async function shot(name, { fullPage = true } = {}) {
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.mouse.move(0, 0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflow, false, `${name} overflow at ${dimensions} (${appearance})`);
    const file = `${appearance}-${dimensions}-${name}.png`;
    await page.screenshot({ path: path.join(artifacts, file), fullPage, animations: "disabled" });
    manifest.push({ file, appearance, dimensions, state: name });
  }
  async function waitForJob(status, id = null) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const job = await page.evaluate(
        async ({ status, id }) => {
          const response = await window.produdash.getAppState();
          return (
            response.data.mediaJobs.find(
              (item) =>
                (!id || item.id === id) &&
                item.status === status &&
                (status !== "completed" || item.artifacts.some((artifact) => artifact.kind === "video"))
            ) || null
          );
        },
        { status, id }
      );
      if (job) return job;
      await page.waitForTimeout(100);
    }
    throw new Error(`Local fixture did not reach ${status} with the expected artifacts.`);
  }
  async function view(section, tab) {
    await page.evaluate(
      async ({ section, tab }) => {
        const { ui } = await import("./src/renderer/state.js");
        const { renderApp } = await import("./src/renderer/render.js");
        ui.activeSection = section;
        if (tab) ui.studioTab = tab;
        ui.error = null;
        ui.pending.clear();
        renderApp();
      },
      { section, tab }
    );
  }
  for (appearance of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: appearance });
    for (const [width, height] of [
      [1440, 960],
      [1120, 760]
    ]) {
      await size(width, height);
      await shot("disconnected");
    }
  }
  await size(1440, 960);
  await view("studio", "library");
  await application.evaluate(
    ({ dialog }, paths) => {
      const selections = [paths.source, paths.output];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selections.shift()], bookmarks: [] });
    },
    { source, output }
  );
  await page.click("[data-add-clip-files]");
  await page.waitForSelector(".clip-row");
  await page.evaluate(async () => {
    const { api } = await import("./src/renderer/api.js");
    const state = await import("./src/renderer/state.js");
    const library = await api.getClipLibrary();
    state.setClipLibrary(library);
    let project = await api.createProject({
      title: "Spring collection · product film",
      sourceMediaId: library.clips[0].id,
      description: "Local product footage for the seasonal launch.",
      instructions: "Keep the introduction concise.",
      desiredLengths: ["15s"],
      platforms: ["youtube"]
    });
    project = await api.saveProjectDraft(
      project.id,
      {
        ...project.draft,
        transcript: [
          { id: "cue-1", start: 0, end: 3, text: "Meet the new collection, designed for everyday use.", speaker: "Presenter", words: [] },
          { id: "cue-2", start: 3, end: 5.8, text: "Explore the details in our store.", speaker: "Presenter", words: [] }
        ]
      },
      project.revision
    );
    state.setProjects(await api.getProjects());
    state.setActiveProject(project);
    await api.saveProjectVersion(project.id, "First review");
    const selection = await api.chooseMediaOutputFolder();
    await api.createMediaJob({
      sourceMediaId: library.clips[0].id,
      outputSelectionId: selection.id,
      title: "Collection highlight",
      goal: "Show the product clearly",
      maxClips: 1,
      targetDuration: 5,
      captionMode: "srt",
      captionText: "A new collection for everyday use.",
      aspectTreatment: "fit_pad",
      targetAspect: "vertical",
      analysisMode: "local_heuristics",
      platforms: ["youtube"]
    });
  });
  await waitForJob("awaiting_review");
  await page.evaluate(async () => {
    const { api } = await import("./src/renderer/api.js");
    const { setAppState } = await import("./src/renderer/state.js");
    setAppState(await api.getAppState());
  });
  for (appearance of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: appearance });
    for (const [width, height] of [
      [1440, 960],
      [1120, 760]
    ]) {
      await size(width, height);
      for (const tab of ["library", "projects", "templates", "create", "publishing"]) {
        await view("studio", tab);
        await shot(`studio-${tab}`);
      }
      await view("studio", "projects");
      await page.locator("details").evaluateAll((details) =>
        details.forEach((element) => {
          element.open = true;
        })
      );
      await shot("studio-project-inspectors");
      const dialog = page.locator("[data-custom-voice-dialog]");
      assert.equal(await page.locator(".project-timeline").getAttribute("role"), "group");
      assert.equal(await page.locator(".timeline-tick").count(), 9);
      const originalSegmentWidth = (await page.locator("[data-timeline-segment]").first().boundingBox()).width;
      await page.locator("[data-project-zoom]").fill("2");
      await page.locator("[data-project-zoom]").dispatchEvent("input");
      assert.equal(await page.locator(".project-timeline").getAttribute("width"), "2000");
      assert.ok((await page.locator("[data-timeline-segment]").first().boundingBox()).width > originalSegmentWidth * 1.8);
      assert.equal(await page.locator(".project-timeline-scroll").evaluate((el) => el.scrollWidth > el.clientWidth), true);
      await page.locator("[data-project-zoom]").fill("1");
      await page.locator("[data-project-zoom]").dispatchEvent("input");
      await page.locator("#studio-tab-projects").focus();
      await dialog.evaluate((element) => element.showModal());
      await shot("voice-consent-dialog", { fullPage: false });
      await page.keyboard.press("Escape");
      assert.equal(await dialog.evaluate((element) => element.open), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), "studio-tab-projects");
    }
  }
  await view("studio", "projects");
  // Metadata-only preload intentionally stays idle. Decode the isolated test
  // fixture before visual acceptance so the viewer evidence contains media.
  await page.locator("[data-project-video]").scrollIntoViewIfNeeded();
  await page.locator("[data-project-video]").evaluate(async (element) => {
    await element.play();
    element.pause();
    await new Promise((resolve) => {
      element.requestVideoFrameCallback(resolve);
      element.currentTime = 1.5;
    });
  });
  assert.equal(await page.locator("[data-project-video]").evaluate((element) => element.readyState >= 2 && element.videoWidth > 0), true);
  for (const theme of ["light", "dark", "glass-light", "glass-dark"]) {
    appearance = theme;
    await page.selectOption("#appearanceSelect", theme);
    for (const [width, height] of [
      [1440, 960],
      [1120, 760]
    ]) {
      await size(width, height);
      await shot("studio-editor-expansion");
    }
  }
  await page.selectOption("#appearanceSelect", "system");
  appearance = "dark";
  // Verify the element Chromium is actually playing survives a job update.
  await view("studio", "projects");
  const video = page.locator("[data-project-video]");
  await video.evaluate(async (element) => {
    await element.play();
    element.pause();
    element.currentTime = 1.5;
    window.__visualVideo = element;
  });
  await page.locator("[data-project-transcript-form] textarea").first().fill("Unsubmitted correction survives job progress");
  await page.evaluate(async () => {
    const { renderApp } = await import("./src/renderer/render.js");
    renderApp();
  });
  assert.equal(await video.evaluate((element) => element === window.__visualVideo && element.currentTime >= 1.4), true);
  assert.equal(
    await page.locator("[data-project-transcript-form] textarea").first().inputValue(),
    "Unsubmitted correction survives job progress"
  );
  for (const theme of ["glass-light", "glass-dark", "light", "dark", "system"]) {
    await page.selectOption("#appearanceSelect", theme);
    assert.equal(await video.evaluate((element) => element === window.__visualVideo && element.currentTime >= 1.4), true);
    assert.equal(
      await page.locator("[data-project-transcript-form] textarea").first().inputValue(),
      "Unsubmitted correction survives job progress"
    );
  }
  const textUndoIntercepted = await page.evaluate(() => {
    const field = document.querySelector("[data-project-transcript-form] textarea");
    const event = new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    field.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(textUndoIntercepted, false, "Project shortcuts must leave native text undo available");
  await page.locator("#studio-tab-projects").focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector("#studio-tab-library").getAttribute("aria-selected") === "true");
  assert.equal(await page.locator("#studio-tab-library").getAttribute("tabindex"), "0");

  const localState = await page.evaluate(async () => {
    const { api } = await import("./src/renderer/api.js");
    const snapshot = await api.getAppState();
    const job = snapshot.mediaJobs.find((item) => item.status === "awaiting_review");
    await api.approveMediaCandidates(job.id, [job.candidates[0].id]);
    return { jobId: job.id };
  });
  await waitForJob("completed", localState.jobId);
  const publishing = await page.evaluate(async (jobId) => {
    const { api } = await import("./src/renderer/api.js");
    const check = await api.getAppState();
    const completed = check.mediaJobs.find((job) => job.id === jobId);
    if (!completed?.artifacts.some((artifact) => artifact.kind === "video")) {
      throw new Error("The completed local fixture has no video attachment.");
    }
    const first = await api.createPostPlan({
      mediaJobId: jobId,
      title: "Collection preview",
      caption: "A closer look at the new collection.",
      platforms: ["instagram"],
      scheduledFor: "2026-10-20T17:00:00Z",
      timeZone: "America/Phoenix"
    });
    await api.approvePostPlan(first.postQueue[0].id, "manual_export");
    await api.createPostPlan({
      mediaJobId: jobId,
      title: "Launch day film",
      caption: "Review the destination copy before approval.",
      platforms: ["youtube", "instagram"],
      scheduledFor: "2026-10-21T17:00:00Z",
      timeZone: "America/Phoenix"
    });
    return api.getAppState();
  }, localState.jobId);
  const fixture = await renderConnectedFixture(page);
  fixture.appVersion = publishing.appVersion;
  fixture.mediaJobs = publishing.mediaJobs;
  fixture.postQueue = publishing.postQueue;
  fixture.creatorPlatforms = publishing.creatorPlatforms;
  fixture.businesses[0].source = "shopify";
  fixture.businesses[0].lastSync = "2026-10-18T12:00:00Z";
  fixture.businesses[0].orders[0].createdAt = "2026-10-17T12:00:00Z";
  fixture.businesses[0].orders[1].createdAt = "2026-09-05T12:00:00Z";
  fixture.integrations[0].lastSync = "2026-10-18T12:00:00Z";
  const report = buildAnalyticsReport(fixture, "business-1", { now: new Date("2026-10-18T16:00:00Z") });
  await page.evaluate(
    async ({ fixture, report }) => {
      const state = await import("./src/renderer/state.js");
      fixture.conversations[0].messages = [
        { role: "customer", text: "Does the new collection ship this week?" },
        { role: "ai_draft", text: "I’ll verify the latest availability before confirming." }
      ];
      state.setAppState(fixture);
      state.setAnalyticsReport(report);
    },
    { fixture, report }
  );
  for (appearance of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: appearance });
    for (const [width, height] of [
      [1440, 960],
      [1120, 760]
    ]) {
      await size(width, height);
      for (const section of ["overview", "inbox", "orders", "signals", "studio", "analytics", "integrations"]) {
        await view(section, "library");
        await shot(section);
      }
      await view("studio", "publishing");
      await shot("publishing-approval-outbox");
      await view("inbox");
      await page.click("[data-advisor-toggle]");
      await shot("juanito-consent");
      const unobscured = await page.evaluate(() => {
        const panel = document.querySelector("#advisorPanel").getBoundingClientRect();
        const content = document.querySelector("#viewRoot").getBoundingClientRect();
        return panel.bottom <= content.top + 1 || panel.left >= content.right - 1;
      });
      assert.equal(unobscured, true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("[data-advisor-toggle]").getAttribute("aria-expanded"), "false");
    }
  }
  await view("studio", "library");
  const availableLibrary = await page.evaluate(async () => {
    const { ui } = await import("./src/renderer/state.js");
    return ui.clipLibrary;
  });
  for (const status of ["missing", "offline", "corrupt", "unsupported"]) {
    await page.evaluate(
      async ({ library, status }) => {
        const { setClipLibrary } = await import("./src/renderer/state.js");
        const { renderApp } = await import("./src/renderer/render.js");
        setClipLibrary({
          ...library,
          clips: [
            {
              ...library.clips[0],
              status,
              previewUrl: null,
              thumbnailUrl: null,
              error: `This source is ${status}. Review the file or reconnect its folder.`
            }
          ],
          total: 1
        });
        renderApp();
      },
      { library: availableLibrary, status }
    );
    await shot(`media-${status}`);
  }
  await page.evaluate(async (library) => {
    const { setClipLibrary } = await import("./src/renderer/state.js");
    setClipLibrary(library);
  }, availableLibrary);
  await view("analytics");
  const stale = buildAnalyticsReport(fixture, "business-1", { now: new Date("2026-10-30T16:00:00Z") });
  await page.evaluate(async (report) => {
    const { setAnalyticsReport } = await import("./src/renderer/state.js");
    const { renderApp } = await import("./src/renderer/render.js");
    setAnalyticsReport(report);
    renderApp();
  }, stale);
  await shot("analytics-stale");
  await page.evaluate(async () => {
    const { renderRevenueBars } = await import("./src/renderer/ui-patterns.js");
    const fixture = Array.from({ length: 60 }, (_, index) => ({ period: `2026-W${index + 1}`, revenue: 123_456_789 + index }));
    document
      .querySelector(".analytics-view")
      .insertAdjacentHTML(
        "beforeend",
        `<section class="dense-chart-fixture"><h3>Isolated long-series fixture</h3>${renderRevenueBars(fixture)}</section>`
      );
  });
  assert.ok((await page.locator(".dense-chart-fixture svg").boundingBox()).width >= 5800);
  assert.equal(await page.locator(".dense-chart-fixture .revenue-chart-scroll").evaluate((el) => el.scrollWidth > el.clientWidth), true);
  await shot("analytics-dense-series-expansion");
  await view("studio", "templates");
  for (const theme of ["light", "dark", "glass-light", "glass-dark"]) {
    appearance = theme;
    await page.selectOption("#appearanceSelect", theme);
    for (const [width, height] of [
      [1440, 960],
      [1120, 760]
    ]) {
      await size(width, height);
      await shot("template-properties-expansion");
    }
  }
  await page.selectOption("#appearanceSelect", "system");
  appearance = "dark";
  await page.emulateMedia({ colorScheme: "dark" });
  await view("integrations");
  await page.evaluate(async () => {
    const { ui } = await import("./src/renderer/state.js");
    const { renderApp } = await import("./src/renderer/render.js");
    ui.error = "Connection validation was interrupted. Review the settings and try again.";
    ui.pending.add("credentials-shopify");
    renderApp();
  });
  await shot("pending-error-disabled");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25));
  await shot("zoom-reduced-motion");
  const brokenKitAssets = await page
    .locator(".kit-icon img")
    .evaluateAll((images) => images.some((image) => !image.complete || !image.naturalWidth));
  assert.equal(brokenKitAssets, false);
  async function durableSnapshot() {
    return page.evaluate(async () => {
      const { api } = await import("./src/renderer/api.js");
      const projects = await api.getProjects();
      const project = await api.getProject(projects.projects[0].id);
      const state = await api.getAppState();
      return {
        project: { id: project.id, revision: project.revision, draft: project.draft, versions: project.versions },
        approvals: state.postQueue.map((plan) => ({ id: plan.id, status: plan.status, approvalSnapshot: plan.approvalSnapshot }))
      };
    });
  }
  const savedWorkspace = await durableSnapshot();
  await application.close();
  application = await electron.launch({ args: [projectRoot, `--user-data-dir=${directory}`] });
  page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".setup-steps");
  assert.deepEqual(
    await durableSnapshot(),
    savedWorkspace,
    "Saved projects, versions and frozen approvals survive a real Electron restart"
  );
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(artifacts, "manifest.json"),
    JSON.stringify([...new Map(manifest.map((entry) => [entry.file, entry])).values()], null, 2)
  );
});
