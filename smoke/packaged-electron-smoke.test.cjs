const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { _electron: electron } = require("playwright");

test("packaged ProduDash starts with secure local resources", { timeout: 90_000 }, async (t) => {
  const executablePath = process.env.PRODUDASH_PACKAGED_EXECUTABLE;
  assert.ok(executablePath, "PRODUDASH_PACKAGED_EXECUTABLE is required.");
  assert.equal(fs.statSync(executablePath, { throwIfNoEntry: false })?.isFile(), true, "Packaged executable is missing.");
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ProduDash packaged ñ "));
  const userDataPath = path.join(parent, "User data with spaces");
  fs.mkdirSync(userDataPath);
  let application;
  let page;
  let completed = false;
  const consoleProblems = [];
  t.after(async () => {
    // Report what the page looked like when an assertion failed. Without this the
    // collected console output is discarded and the failure gives no cause.
    if (!completed && page) {
      let details = "(page state unavailable)";
      try {
        details = await page.evaluate(() => ({
          sections: Array.from(document.querySelectorAll("[data-section]")).map(
            (node) => `${node.dataset.section}=${node.getAttribute("aria-current")}`
          ),
          navigation: document.querySelector(".nav-list")?.outerHTML?.slice(0, 1500) || "(no .nav-list)",
          viewRoot: document.querySelector("#viewRoot")?.innerHTML?.slice(0, 1500) || "(no #viewRoot)"
        }));
      } catch (error) {
        details = `(page state unavailable: ${error.message})`;
      }
      process.stderr.write(
        [
          "",
          "--- packaged smoke diagnostics ---",
          `console problems: ${consoleProblems.length ? `\n  ${consoleProblems.join("\n  ")}` : "(none)"}`,
          `sections: ${Array.isArray(details.sections) ? details.sections.join(", ") : details}`,
          `nav-list: ${details.navigation || details}`,
          `viewRoot: ${details.viewRoot || details}`,
          "--- end packaged smoke diagnostics ---",
          ""
        ].join("\n")
      );
    }
    if (application) await application.close();
    if (process.env.PRODUDASH_SMOKE_KEEP_USER_DATA !== "1") fs.rmSync(parent, { recursive: true, force: true });
  });

  application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataPath}`],
    env: {
      ...process.env,
      ELECTRON_ENABLE_SECURITY_WARNINGS: "true"
    }
  });
  page = await application.firstWindow();
  const outboundRequests = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) consoleProblems.push(message.text());
  });
  page.on("pageerror", (error) => consoleProblems.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/i.test(request.url())) outboundRequests.push(request.url());
  });

  await page.waitForSelector("#viewRoot");
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  await page.waitForFunction(() => document.querySelector('[data-section="overview"]')?.getAttribute("aria-current") === "page");
  assert.equal(await page.locator('[data-section="overview"]').getAttribute("aria-current"), "page");
  await page.click('[data-section="analytics"]');
  await page.waitForFunction(() => document.querySelector('[data-section="analytics"]').getAttribute("aria-current") === "page");
  assert.equal(
    await page.locator(".nav-list").evaluate((navigation) => {
      const iconPath = navigation.querySelector('[data-section="analytics"] .nav-icon path');
      return iconPath?.getAttribute("d") === "M4 19V11M10 19V6M16 19v-5M3 19h18M4 11l6-5 6 8 4-4";
    }),
    true
  );
  await page.click('[data-section="studio"]');
  await page.waitForSelector('[role="tab"][aria-selected="true"]');
  assert.equal(await page.locator('[role="tab"]').count(), 5);
  await page.click("[data-advisor-toggle]");
  await page.locator(".advisor-state-art").waitFor();
  assert.equal(await page.locator(".advisor-state-art").evaluate((image) => image.complete && image.naturalWidth > 0), true);

  const stateResponse = await page.evaluate(() => window.produdash.getAppState());
  assert.equal(stateResponse.ok, true);
  assert.equal(JSON.stringify(stateResponse).includes(userDataPath), false);
  assert.equal(
    stateResponse.data.credentialSettings.some((setting) =>
      setting.fields.some((field) => field.sensitive && Object.hasOwn(field, "value"))
    ),
    false
  );
  assert.deepEqual(outboundRequests, []);
  assert.equal(
    consoleProblems.some((message) => /Content Security Policy|Electron Security Warning|Uncaught/i.test(message)),
    false,
    consoleProblems.join("\n")
  );
  completed = true;
});
