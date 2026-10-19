const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { CustomApiManager } = require("../electron/custom-apis/manager.cjs");
function fixture(t, { ready = true, fetchImpl, timeout = 1000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "produdash-api-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const children = [];
  const utilityProcess = {
    fork() {
      const child = new EventEmitter();
      children.push(child);
      child.kill = () => queueMicrotask(() => child.emit("exit", 1));
      child.postMessage = (message) => {
        child.last = message;
        if (message.type === "start" && ready) queueMicrotask(() => child.emit("message", { type: "ready", port: 12345 }));
        if (message.type === "stop")
          queueMicrotask(() => {
            child.emit("message", { type: "stopped" });
            child.emit("exit", 0);
          });
      };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }
  };
  const manager = new CustomApiManager({
    utilityProcess,
    userDataPath: dir,
    startupTimeout: timeout,
    fetchImpl: fetchImpl || (async () => ({ ok: true, json: async () => ({ service: "tiktok", protocol: 1, ready: true }) }))
  });
  t.after(() => manager.shutdown(20));
  manager.configure("tiktok", { expectedUsername: "jamftest" });
  return { manager, children, dir };
}
test("custom APIs default off; duplicate starts share one authenticated worker; restart stays off", async (t) => {
  const { manager, children, dir } = fixture(t);
  const a = manager.start("tiktok"),
    b = manager.start("tiktok");
  assert.equal(a, b);
  await a;
  assert.equal(children.length, 1);
  assert.equal(manager.list()[0].state, "running");
  assert.doesNotMatch(JSON.stringify(manager.list()), /token|12345|entryPath|profileDir/);
  assert.equal(children[0].last.options.port, 0);
  await manager.stop("tiktok");
  assert.equal(manager.list()[0].state, "off");
  const other = new CustomApiManager({ userDataPath: dir });
  assert.equal(other.list()[0].state, "off");
});
test("startup failure, mismatched health and crashes never restart automatically", async (t) => {
  const { manager, children } = fixture(t, { ready: false, timeout: 10 });
  await assert.rejects(manager.start("tiktok"), { code: "CUSTOM_API_FAILED" });
  assert.equal(children.length, 1);
  assert.equal(manager.list()[0].state, "error");
  const invalid = fixture(t, { fetchImpl: async () => ({ ok: true, json: async () => ({ service: "other", protocol: 1, ready: true }) }) });
  await assert.rejects(invalid.manager.start("tiktok"), { code: "CUSTOM_API_FAILED" });
  const valid = fixture(t);
  await valid.manager.start("tiktok");
  valid.children[0].emit("exit", 1);
  assert.equal(valid.manager.list()[0].state, "error");
});
test("Stop drains active requests, blocks new work, and stopping during startup completes", async (t) => {
  let release;
  const { manager } = fixture(t, {
    fetchImpl: async (url) => {
      if (!url.endsWith("health"))
        await new Promise((done) => {
          release = done;
        });
      return { ok: true, json: async () => ({ service: "tiktok", protocol: 1, ready: true }) };
    }
  });
  await manager.start("tiktok");
  const request = manager.request("tiktok", "/v1/conversations");
  const stop = manager.stop("tiktok");
  assert.equal(manager.list()[0].state, "stopping");
  await assert.rejects(manager.request("tiktok", "/v1/conversations"), { code: "CUSTOM_API_OFF" });
  release();
  await request;
  await stop;
  const other = fixture(t);
  const starting = other.manager.start("tiktok");
  const stopping = other.manager.stop("tiktok");
  await starting;
  await stopping;
  assert.equal(other.manager.list()[0].state, "off");
});
test("unknown definitions, regular browser profiles and raw server errors fail closed", async (t) => {
  const { manager } = fixture(t, {
    fetchImpl: async (url) =>
      url.endsWith("health")
        ? { ok: true, json: async () => ({ service: "tiktok", protocol: 1, ready: true }) }
        : { ok: false, json: async () => ({ error: { code: "raw", message: "sessionid=PRIVATE" } }) }
  });
  assert.throws(() => manager.start("../../shell"), { code: "CUSTOM_API_UNKNOWN" });
  await manager.start("tiktok");
  await assert.rejects(manager.request("tiktok", "/v1/conversations"), (e) => !e.message.includes("PRIVATE"));
});

test("shutdown has a bounded deadline and clears runtime credentials without auto-restart", async (t) => {
  let release;
  const { manager, children } = fixture(t, {
    fetchImpl: async (url) => {
      if (!url.endsWith("health"))
        await new Promise((done) => {
          release = done;
        });
      return { ok: true, json: async () => ({ service: "tiktok", protocol: 1, ready: true }) };
    }
  });
  await manager.start("tiktok");
  const pending = manager.request("tiktok", "/v1/conversations");
  await manager.shutdown(5);
  assert.equal(manager.list()[0].state, "off");
  assert.equal(manager.runs.get("tiktok").token, null);
  assert.equal(children.length, 1);
  release();
  await pending;
});
test("damaged API configuration cannot prevent the workspace from opening, and save repairs it", async (t) => {
  const { manager, dir } = fixture(t);
  fs.writeFileSync(path.join(dir, "custom-api-config.json"), "invalid JSON");
  const recovered = new CustomApiManager({ userDataPath: dir });
  assert.match(recovered.list()[0].error, /could not be read/);
  assert.equal(recovered.list()[0].state, "off");
  recovered.configure("tiktok", { expectedUsername: "jamftest" });
  assert.equal(recovered.list()[0].error, null);
  assert.equal(manager.list()[0].state, "off");
});
test("clear removes owned runtime state but retains a selected external browser profile", async (t) => {
  const { manager, dir } = fixture(t);
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "produdash-external-profile-"));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  fs.writeFileSync(path.join(external, "owner.txt"), "external profile");
  manager.configure("tiktok", { expectedUsername: "jamftest", profileDir: external });
  fs.mkdirSync(path.join(dir, "custom-apis", "tiktok"), { recursive: true });
  await manager.clear();
  assert.equal(fs.existsSync(path.join(external, "owner.txt")), true);
  assert.equal(fs.existsSync(path.join(dir, "custom-apis")), false);
  assert.equal(manager.list()[0].configured, false);
});
