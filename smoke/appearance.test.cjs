const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { _electron: electron } = require("playwright");
const { renderConnectedFixture } = require("./visual-fixtures.cjs");

test("solid and glass appearances stay selectable, readable and persistent in Electron", { timeout: 90_000 }, async (t) => {
  const projectRoot = path.join(__dirname, "..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "produdash-appearance-"));
  const artifacts = path.join(projectRoot, "test-results", "appearance");
  fs.mkdirSync(artifacts, { recursive: true });
  let application = await electron.launch({ args: [projectRoot, `--user-data-dir=${directory}`] });
  t.after(async () => {
    await application.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".setup-steps");
  await renderConnectedFixture(page);
  const manifest = [];
  for (const theme of ["light", "dark", "glass-light", "glass-dark"]) {
    // Explicit choices must win even when the OS has the opposite appearance.
    await page.emulateMedia({ colorScheme: theme.endsWith("dark") ? "light" : "dark" });
    await page.selectOption("#appearanceSelect", theme);
    const material = theme.startsWith("glass-") ? "glass" : "solid";
    assert.equal(await page.locator("html").getAttribute("data-material"), material);
    assert.equal(await page.locator("html").getAttribute("data-appearance"), theme.endsWith("dark") ? "dark" : "light");
    assert.equal(
      await page.locator("html").evaluate((el) => window.getComputedStyle(el).colorScheme),
      theme.endsWith("dark") ? "dark" : "light"
    );
    const iconFilter = await page
      .locator(".kit-icon img")
      .first()
      .evaluate((el) => window.getComputedStyle(el).filter);
    assert.equal(iconFilter, theme.endsWith("dark") ? "none" : "brightness(0.45)");
    const blur = await page.locator(".sidebar").evaluate((el) => window.getComputedStyle(el).backdropFilter);
    assert.equal(blur, material === "glass" ? "blur(11.25px)" : "none");
    for (const [width, height] of [
      [1440, 960],
      [1120, 760]
    ]) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
      const sections =
        material === "glass" ? ["overview", "inbox", "orders", "signals", "studio", "analytics", "integrations"] : ["overview"];
      for (const section of sections) {
        await page.evaluate(async (section) => {
          const { ui } = await import("./src/renderer/state.js");
          const { renderApp } = await import("./src/renderer/render.js");
          ui.activeSection = section;
          renderApp();
          window.scrollTo(0, 0);
        }, section);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
        const select = await page.locator("#appearanceSelect").boundingBox();
        const launcher = await page.locator(".advisor-launcher").boundingBox();
        assert.ok(
          select.y + select.height < launcher.y || launcher.y + launcher.height < select.y,
          "Appearance and Juanito remain separately accessible"
        );
        await page.mouse.move(0, 0);
        const file = `${theme}-${width}x${height}-${section}.png`;
        await page.screenshot({ path: path.join(artifacts, file), fullPage: true, animations: "disabled" });
        manifest.push({ file, theme, dimensions: `${width}x${height}`, section });
      }
    }
  }
  await page.evaluate(() => window.localStorage.setItem("appearance-unrelated-test", "retained"));
  await application.close();
  application = await electron.launch({ args: [projectRoot, `--user-data-dir=${directory}`] });
  page = await application.firstWindow();
  await page.waitForSelector(".setup-steps");
  assert.equal(await page.locator("#appearanceSelect").inputValue(), "glass-dark");
  assert.equal(await page.locator("html").getAttribute("data-material"), "glass");
  assert.equal(await page.evaluate(() => window.localStorage.getItem("appearance-unrelated-test")), "retained");
  await page.selectOption("#appearanceSelect", "system");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.appearance === "light");
  assert.equal(await page.locator("html").getAttribute("data-appearance"), "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.appearance === "dark");
  assert.equal(await page.locator("html").getAttribute("data-appearance"), "dark");
  assert.equal(await page.locator("html").getAttribute("data-material"), "solid");
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(artifacts, "manifest.json"), JSON.stringify(manifest, null, 2));
});
