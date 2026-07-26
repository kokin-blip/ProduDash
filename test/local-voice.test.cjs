const assert = require("node:assert/strict");
const test = require("node:test");
const { buildLocalVoiceReport } = require("../electron/ai/local-voice-compatibility.cjs");

test("local voice compatibility stays coarse, private, and distinguishes installed from compatible", () => {
  const report = buildLocalVoiceReport(
    {
      platform: "darwin",
      architecture: "arm64",
      cpuCores: 10,
      memoryBytes: 16 * 1024 ** 3,
      accelerator: "Apple GPU / Metal"
    },
    { piper: true }
  );
  assert.equal(report.device.memoryGb, 16);
  assert.equal(report.engines.find((engine) => engine.id === "piper").status, "installed");
  assert.equal(report.engines.find((engine) => engine.id === "chatterbox").recommended, true);
  assert.equal(report.engines.find((engine) => engine.id === "rvc").kind, "voice_conversion");
  assert.equal(report.engines.find((engine) => engine.id === "tortoise").recommended, true);
  assert.match(report.privacy, /did not upload/);
  assert.equal(JSON.stringify(report).includes("serial"), false);
  assert.equal(JSON.stringify(report).includes("username"), false);
});

test("local voice compatibility does not recommend engines below their memory baseline", () => {
  const report = buildLocalVoiceReport(
    {
      platform: "linux",
      architecture: "x64",
      cpuCores: 2,
      memoryBytes: 4 * 1024 ** 3,
      accelerator: null
    },
    {}
  );
  assert.equal(report.engines.find((engine) => engine.id === "piper").compatible, true);
  assert.equal(report.engines.find((engine) => engine.id === "chatterbox").compatible, false);
  assert.equal(report.engines.find((engine) => engine.id === "xtts").status, "not_recommended");
  assert.equal(report.engines.find((engine) => engine.id === "rvc").status, "not_recommended");
  assert.equal(report.engines.find((engine) => engine.id === "tortoise").status, "not_recommended");
});

test("local voice compatibility detects matching RVC and Tortoise commands without conflating their roles", () => {
  const report = buildLocalVoiceReport(
    {
      platform: "win32",
      architecture: "x64",
      cpuCores: 16,
      memoryBytes: 32 * 1024 ** 3,
      accelerator: "NVIDIA GPU"
    },
    { "rvc-cli": true, "tortoise-tts": true }
  );
  const rvc = report.engines.find((engine) => engine.id === "rvc");
  const tortoise = report.engines.find((engine) => engine.id === "tortoise");
  assert.equal(rvc.status, "installed");
  assert.equal(rvc.kind, "voice_conversion");
  assert.equal(tortoise.status, "installed");
  assert.equal(tortoise.kind, "likeness");
});
