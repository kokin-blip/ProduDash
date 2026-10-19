const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { _electron: electron } = require("playwright");

test(
  "custom API controls run a real worker, keep secrets private, preserve drafts and render both appearances",
  { timeout: 90000 },
  async (t) => {
    const root = path.join(__dirname, "..");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "produdash-api-ui-"));
    const screenshots = path.join(root, "test-results", "custom-apis");
    fs.mkdirSync(screenshots, { recursive: true });
    let application;
    t.after(async () => {
      if (application) await application.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    application = await electron.launch({ args: [root, `--user-data-dir=${dir}`] });
    const page = await application.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.waitForSelector("#viewRoot");
    await page.locator('.nav-item[data-section="integrations"]').click();
    const form = page.locator('[data-custom-api-form="tiktok"]');
    await form.waitFor();
    assert.match(await form.textContent(), /Off/);
    await form.locator('input[name="expectedUsername"]').fill("jamftest");
    await form.getByRole("button", { name: "Save account", exact: true }).click();
    if (process.platform !== "darwin") {
      assert.match(await form.textContent(), /Available in macOS builds only/);
      assert.equal(await form.getByRole("button", { name: "Start API", exact: true }).isDisabled(), true);
      assert.equal((await page.evaluate(() => window.produdash.startCustomApi("tiktok"))).ok, false);
      assert.deepEqual(errors, []);
      return;
    }
    await form.getByRole("button", { name: "Start API", exact: true }).waitFor({ state: "visible" });
    await form.getByRole("button", { name: "Start API", exact: true }).focus();
    await page.keyboard.press("Enter");
    await form.getByRole("button", { name: "Stop API", exact: true }).waitFor({ timeout: 35000 });
    const result = await page.evaluate(() => window.produdash.listCustomApis());
    assert.equal(result.ok, true);
    assert.equal(result.data[0].state, "running");
    assert.equal(result.data[0].account, null);
    assert.doesNotMatch(JSON.stringify(result), /token|profileDir|entryPath|127\.0\.0\.1/);
    await form.scrollIntoViewIfNeeded();
    for (const theme of ["light", "dark"]) {
      await page.locator("#appearanceSelect").selectOption(theme);
      await page.screenshot({ path: path.join(screenshots, `integrations-${theme}.png`) });
    }
    await form.getByRole("button", { name: "Stop API", exact: true }).click();
    await form.getByRole("button", { name: "Start API", exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.produdash.listCustomApis())).data[0].state, "off");
    await page.evaluate(async () => {
      const { ui, setAppState } = await import("./src/renderer/state.js");
      const { renderApp } = await import("./src/renderer/render.js");
      setAppState({
        ...ui.appState,
        customApis: [{ id: "tiktok", state: "running", account: { id: "jamftest" }, expectedUsername: "jamftest" }],
        conversations: [
          {
            id: "tiktok-fixture",
            source: "tiktok",
            businessId: null,
            accountId: "jamftest",
            externalId: "0:1:123:123",
            customer: "jamftest",
            channel: "TikTok browser",
            status: "imported",
            messages: [{ role: "unknown", text: "A loaded browser snapshot for this test." }]
          }
        ]
      });
      ui.activeSection = "inbox";
      renderApp();
    });
    const composer = page.locator("#tiktokMessage");
    await composer.fill("Keep this draft while service status updates.");
    await page.evaluate(async () => {
      const { renderApp } = await import("./src/renderer/render.js");
      renderApp();
    });
    assert.equal(await composer.inputValue(), "Keep this draft while service status updates.");
    for (const theme of ["light", "dark"]) {
      await page.locator("#appearanceSelect").selectOption(theme);
      assert.equal(await composer.inputValue(), "Keep this draft while service status updates.");
      await page.screenshot({ path: path.join(screenshots, `inbox-${theme}.png`) });
    }
    // Renderer-only fixtures cannot authorize a main-process send.
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.locator('[role="alert"]').waitFor();
    assert.equal((await page.evaluate(() => window.produdash.listCustomApis())).data[0].state, "off");
    assert.deepEqual(errors, []);
  }
);
