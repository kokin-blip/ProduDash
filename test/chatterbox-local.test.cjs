const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProbeWav } = require("../electron/ai/adapters/rvc-local.cjs");
const {
  CHATTERBOX_LOCAL_MODEL,
  CHATTERBOX_VOICE_ID,
  ChatterboxLocalProviderAdapter,
  normalizeOptions
} = require("../electron/ai/adapters/chatterbox-local.cjs");

async function fixture() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "produdash-chatterbox-test-"));
  const pythonPath = path.join(directory, "python");
  const modelCachePath = path.join(directory, "cache");
  const referencePath = path.join(directory, "authorized.wav");
  await fs.promises.mkdir(modelCachePath);
  await fs.promises.writeFile(pythonPath, "runtime", { mode: 0o700 });
  await fs.promises.writeFile(referencePath, createProbeWav());
  return {
    directory,
    pythonPath,
    modelCachePath,
    referencePath,
    variant: "nano",
    language: "en",
    device: "cpu"
  };
}

test("Chatterbox runs its selected local cache in forced offline mode", async (context) => {
  const files = await fixture();
  context.after(() => fs.promises.rm(files.directory, { recursive: true, force: true }));
  const calls = [];
  const adapter = new ChatterboxLocalProviderAdapter({
    wrapperPath: "/app/chatterbox_local.py",
    runCommand: async (request) => {
      calls.push(request);
      await fs.promises.writeFile(request.outputPath, createProbeWav());
    }
  });
  assert.equal(await adapter.validate(files, CHATTERBOX_LOCAL_MODEL.id), true);
  const audio = await adapter.generateSpeech({
    credentials: files,
    modelId: CHATTERBOX_LOCAL_MODEL.id,
    input: "Authorized Chatterbox speech.",
    voice: CHATTERBOX_VOICE_ID
  });
  assert.equal(audio.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(calls[0].args.includes("--validate"), true);
  assert.equal(calls[1].args.includes("Authorized Chatterbox speech."), false);
  assert.equal(calls[1].input, "Authorized Chatterbox speech.");
  assert.deepEqual(calls[1].extraEnvironment, {
    HF_HOME: files.modelCachePath,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1"
  });
});

test("Chatterbox validates variant, language, device, files, voice, and directions", async (context) => {
  const files = await fixture();
  context.after(() => fs.promises.rm(files.directory, { recursive: true, force: true }));
  assert.deepEqual(normalizeOptions(files), { variant: "nano", device: "cpu", language: "en" });
  assert.throws(() => normalizeOptions({ ...files, variant: "unknown" }), { code: "INVALID_CHATTERBOX_VARIANT" });
  assert.throws(() => normalizeOptions({ ...files, device: "metal" }), { code: "INVALID_CHATTERBOX_DEVICE" });
  assert.throws(() => normalizeOptions({ ...files, language: "fr" }), { code: "INVALID_CHATTERBOX_LANGUAGE" });
  const adapter = new ChatterboxLocalProviderAdapter({
    runCommand: async (request) => fs.promises.writeFile(request.outputPath, createProbeWav())
  });
  await assert.rejects(
    () => adapter.validate({ ...files, modelCachePath: path.join(files.directory, "missing") }, CHATTERBOX_LOCAL_MODEL.id),
    { code: "CHATTERBOX_LOCAL_UNAVAILABLE" }
  );
  await assert.rejects(
    () =>
      adapter.generateSpeech({
        credentials: files,
        modelId: CHATTERBOX_LOCAL_MODEL.id,
        input: "Text",
        voice: "different-voice"
      }),
    { code: "CUSTOM_VOICE_UNAVAILABLE" }
  );
  await assert.rejects(
    () =>
      adapter.generateSpeech({
        credentials: files,
        modelId: CHATTERBOX_LOCAL_MODEL.id,
        input: "Text",
        voice: CHATTERBOX_VOICE_ID,
        instructions: "Improvise."
      }),
    { code: "CAPABILITY_UNSUPPORTED" }
  );
});
