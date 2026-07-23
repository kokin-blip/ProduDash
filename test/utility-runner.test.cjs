const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { MediaUtilityRunner, workerEnvironment } = require("../electron/media/utility-runner.cjs");

test("utility runner passes a minimal environment and resolves normalized worker events", async () => {
  class FakeChild extends EventEmitter {
    postMessage(message) {
      this.sent = message;
    }
    kill() {
      this.killed = true;
    }
  }
  const child = new FakeChild();
  let options;
  const utilityProcess = {
    fork(_workerPath, _args, receivedOptions) {
      options = receivedOptions;
      return child;
    }
  };
  const progress = [];
  const runner = new MediaUtilityRunner({
    utilityProcess,
    environment: { PATH: "/bin", TMPDIR: "/tmp", SHOPIFY_TOKEN: "secret", GEMINI_API_KEY: "secret" }
  });
  const handle = runner.start({ id: "job-1" }, (message) => progress.push(message));
  child.emit("spawn");
  assert.deepEqual(child.sent, { type: "run", job: { id: "job-1" } });
  assert.deepEqual(options.env, { PATH: "/bin", TMPDIR: "/tmp" });
  child.emit("message", { type: "progress", stage: "rendering", progress: 50 });
  child.emit("message", { type: "completed", artifacts: [] });
  assert.equal((await handle.result).type, "completed");
  assert.equal(child.killed, true);
  assert.equal(progress.length, 1);
});

test("worker environment excludes provider credentials", () => {
  assert.deepEqual(workerEnvironment({ PATH: "/bin", OPENAI_API_KEY: "nope", TEMP: "tmp" }), {
    PATH: "/bin",
    TEMP: "tmp"
  });
});
