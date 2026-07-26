const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProbeWav } = require("../electron/ai/adapters/rvc-local.cjs");
const { XTTS_LOCAL_MODEL, XTTS_VOICE_ID, XttsLocalProviderAdapter, normalizeLanguage } = require("../electron/ai/adapters/xtts-local.cjs");

async function fixture() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "produdash-xtts-test-"));
  const pythonPath = path.join(directory, "python");
  const modelPath = path.join(directory, "model");
  const configPath = path.join(modelPath, "config.json");
  const referencePath = path.join(directory, "authorized.wav");
  await fs.promises.mkdir(modelPath);
  await fs.promises.writeFile(pythonPath, "runtime", { mode: 0o700 });
  await fs.promises.writeFile(configPath, "{}");
  await fs.promises.writeFile(referencePath, createProbeWav());
  return { directory, pythonPath, modelPath, configPath, referencePath, language: "en" };
}

test("XTTS uses its bundled offline wrapper with protected local inputs", async (context) => {
  const files = await fixture();
  context.after(() => fs.promises.rm(files.directory, { recursive: true, force: true }));
  const calls = [];
  const adapter = new XttsLocalProviderAdapter({
    wrapperPath: "/app/xtts_local.py",
    runCommand: async (request) => {
      calls.push(request);
      await fs.promises.writeFile(request.outputPath, createProbeWav());
    }
  });
  assert.equal(await adapter.validate(files, XTTS_LOCAL_MODEL.id), true);
  const audio = await adapter.generateSpeech({
    credentials: files,
    modelId: XTTS_LOCAL_MODEL.id,
    input: "Authorized local speech.",
    voice: XTTS_VOICE_ID
  });
  assert.equal(audio.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(calls[0].args.includes("--validate"), true);
  assert.equal(calls[1].args.includes("--reference-path"), true);
  assert.equal(calls[1].args.includes("--language"), true);
  assert.equal(calls[1].args.includes("Authorized local speech."), false);
  assert.equal(calls[1].input, "Authorized local speech.");
  assert.deepEqual(calls[1].extraEnvironment, {
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1"
  });
});

test("XTTS rejects unsupported languages, missing local files, voices, and directions", async (context) => {
  const files = await fixture();
  context.after(() => fs.promises.rm(files.directory, { recursive: true, force: true }));
  assert.throws(() => normalizeLanguage("xx"), { code: "INVALID_XTTS_LANGUAGE" });
  const adapter = new XttsLocalProviderAdapter({
    runCommand: async (request) => fs.promises.writeFile(request.outputPath, createProbeWav())
  });
  await assert.rejects(() => adapter.validate({ ...files, modelPath: path.join(files.directory, "missing") }, XTTS_LOCAL_MODEL.id), {
    code: "XTTS_LOCAL_UNAVAILABLE"
  });
  await assert.rejects(
    () =>
      adapter.generateSpeech({
        credentials: files,
        modelId: XTTS_LOCAL_MODEL.id,
        input: "Text",
        voice: "different-voice"
      }),
    { code: "CUSTOM_VOICE_UNAVAILABLE" }
  );
  await assert.rejects(
    () =>
      adapter.generateSpeech({
        credentials: files,
        modelId: XTTS_LOCAL_MODEL.id,
        input: "Text",
        voice: XTTS_VOICE_ID,
        instructions: "Whisper."
      }),
    { code: "CAPABILITY_UNSUPPORTED" }
  );
});
