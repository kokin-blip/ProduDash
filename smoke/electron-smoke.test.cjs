const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { _electron: electron } = require("playwright");

test("Electron starts securely and shows the connection-first workflow", { timeout: 60_000 }, async (t) => {
  const projectRoot = path.join(__dirname, "..");
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "produdash-smoke-"));
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
    page.waitForFunction(() => document.querySelector("#viewRoot").textContent.includes("waiting for real accounts"))
  );
  await page.click('[data-section="integrations"]');
  await page.waitForFunction(() => document.querySelector("#viewRoot").textContent.includes("Verified connection state"));

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
