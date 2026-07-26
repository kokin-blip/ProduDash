const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createDirectory } = require("./helpers.cjs");
const { KOKORO_LOCAL_MODEL, KokoroLocalProviderAdapter, normalizeVoiceId } = require("../electron/ai/adapters/kokoro-local.cjs");

function wavFixture() {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(48000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  return buffer;
}

test("Kokoro local adapter uses its documented non-playing batch WAV contract", async (context) => {
  const directory = createDirectory("produdash-kokoro-");
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executablePath = path.join(directory, "kokoro-tts");
  fs.writeFileSync(executablePath, "test");
  fs.chmodSync(executablePath, 0o700);
  let request;
  const adapter = new KokoroLocalProviderAdapter({
    runCommand: async (value) => {
      request = value;
      fs.writeFileSync(value.outputPath, wavFixture());
    }
  });
  const credentials = { executablePath, voiceId: "af_heart" };
  assert.equal(await adapter.validate(credentials, KOKORO_LOCAL_MODEL.id), true);
  const audio = await adapter.generateSpeech({
    credentials,
    modelId: KOKORO_LOCAL_MODEL.id,
    input: "Kokoro stays local.",
    voice: "af_heart"
  });
  assert.equal(audio.subarray(0, 4).toString("ascii"), "RIFF");
  assert.deepEqual(request.args.slice(0, 2), ["--no-play", "--batch"]);
  assert.equal(request.args.at(-1), "af_heart");
  assert.equal(request.input, "Kokoro stays local.");
});

test("Kokoro local adapter restricts voice IDs and fails closed on incompatible choices", async (context) => {
  const directory = createDirectory("produdash-kokoro-invalid-");
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executablePath = path.join(directory, "kokoro-tts");
  fs.writeFileSync(executablePath, "test");
  fs.chmodSync(executablePath, 0o700);
  const adapter = new KokoroLocalProviderAdapter({
    runCommand: async (value) => fs.writeFileSync(value.outputPath, wavFixture())
  });
  assert.equal(normalizeVoiceId("af_heart"), "af_heart");
  assert.throws(() => normalizeVoiceId("../../voice"), { code: "INVALID_KOKORO_VOICE" });
  await assert.rejects(
    adapter.generateSpeech({
      credentials: { executablePath, voiceId: "af_heart" },
      modelId: KOKORO_LOCAL_MODEL.id,
      input: "Hello",
      voice: "am_adam"
    }),
    { code: "CUSTOM_VOICE_UNAVAILABLE" }
  );
});
