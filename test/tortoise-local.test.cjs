const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProbeWav } = require("../electron/ai/adapters/rvc-local.cjs");
const {
  TORTOISE_LOCAL_MODEL,
  TORTOISE_VOICE_ID,
  TortoiseLocalProviderAdapter,
  normalizePreset
} = require("../electron/ai/adapters/tortoise-local.cjs");

async function fixture() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "produdash-tortoise-test-"));
  const pythonPath = path.join(directory, "python");
  const modelsPath = path.join(directory, "models");
  const referencePath = path.join(directory, "authorized.wav");
  await fs.promises.mkdir(modelsPath);
  await fs.promises.writeFile(pythonPath, "runtime", { mode: 0o700 });
  await fs.promises.writeFile(referencePath, createProbeWav());
  return { directory, pythonPath, modelsPath, referencePath, preset: "fast" };
}

test("Tortoise runs its configured model folder without network access", async (context) => {
  const files = await fixture();
  context.after(() => fs.promises.rm(files.directory, { recursive: true, force: true }));
  const calls = [];
  const adapter = new TortoiseLocalProviderAdapter({
    wrapperPath: "/app/tortoise_local.py",
    runCommand: async (request) => {
      calls.push(request);
      await fs.promises.writeFile(request.outputPath, createProbeWav());
    }
  });

  assert.equal(await adapter.validate(files, TORTOISE_LOCAL_MODEL.id), true);
  const audio = await adapter.generateSpeech({
    credentials: files,
    modelId: TORTOISE_LOCAL_MODEL.id,
    input: "Authorized local Tortoise speech.",
    voice: TORTOISE_VOICE_ID
  });

  assert.equal(audio.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(calls[0].args.includes("--validate"), true);
  assert.equal(calls[1].args.includes("Authorized local Tortoise speech."), false);
  assert.equal(calls[1].input, "Authorized local Tortoise speech.");
  assert.deepEqual(calls[1].extraEnvironment, {
    TORTOISE_MODELS_DIR: files.modelsPath,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1"
  });
});

test("Tortoise rejects invalid presets, missing files, voices, and directions", async (context) => {
  const files = await fixture();
  context.after(() => fs.promises.rm(files.directory, { recursive: true, force: true }));
  assert.equal(normalizePreset("ULTRA_FAST"), "ultra_fast");
  assert.throws(() => normalizePreset("instant"), { code: "INVALID_TORTOISE_PRESET" });
  const adapter = new TortoiseLocalProviderAdapter({
    runCommand: async (request) => fs.promises.writeFile(request.outputPath, createProbeWav())
  });

  await assert.rejects(() => adapter.validate({ ...files, modelsPath: path.join(files.directory, "missing") }, TORTOISE_LOCAL_MODEL.id), {
    code: "TORTOISE_LOCAL_UNAVAILABLE"
  });
  await assert.rejects(
    () =>
      adapter.generateSpeech({
        credentials: files,
        modelId: TORTOISE_LOCAL_MODEL.id,
        input: "Text",
        voice: "different-voice"
      }),
    { code: "CUSTOM_VOICE_UNAVAILABLE" }
  );
  await assert.rejects(
    () =>
      adapter.generateSpeech({
        credentials: files,
        modelId: TORTOISE_LOCAL_MODEL.id,
        input: "Text",
        voice: TORTOISE_VOICE_ID,
        instructions: "Whisper."
      }),
    { code: "CAPABILITY_UNSUPPORTED" }
  );
});
