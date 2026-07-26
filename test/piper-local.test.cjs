const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { createDirectory } = require("./helpers.cjs");
const {
  PIPER_LOCAL_MODEL,
  PIPER_VOICE_ID,
  PiperLocalProviderAdapter,
  isWav,
  runPiperCommand
} = require("../electron/ai/adapters/piper-local.cjs");

function wavFixture() {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(22050, 24);
  buffer.writeUInt32LE(44100, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(0, 40);
  return buffer;
}

function createPiperFiles(directory) {
  const executablePath = path.join(directory, "piper");
  const modelPath = path.join(directory, "voice.onnx");
  fs.writeFileSync(executablePath, "test");
  fs.chmodSync(executablePath, 0o700);
  fs.writeFileSync(modelPath, "model");
  fs.writeFileSync(`${modelPath}.json`, "{}");
  return { executablePath, modelPath };
}

test("Piper local validation uses fixed shell-free arguments and produces bounded WAV audio", async (context) => {
  const directory = createDirectory("produdash-piper-");
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = { ...createPiperFiles(directory), speakerId: "2" };
  const calls = [];
  const adapter = new PiperLocalProviderAdapter({
    runCommand: async (request) => {
      calls.push(request);
      fs.writeFileSync(request.outputPath, wavFixture());
    }
  });
  assert.equal(await adapter.validate(credentials, PIPER_LOCAL_MODEL.id), true);
  const audio = await adapter.generateSpeech({
    credentials,
    modelId: PIPER_LOCAL_MODEL.id,
    input: "Local speech stays on this computer.",
    voice: PIPER_VOICE_ID
  });
  assert.equal(isWav(audio), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.slice(0, 2), ["--model", credentials.modelPath]);
  assert.ok(calls[1].args.includes("--output_file"));
  assert.deepEqual(calls[1].args.slice(-2), ["--speaker", "2"]);
  assert.equal(calls[1].input, "Local speech stays on this computer.");
  assert.equal(Object.hasOwn(calls[1], "shell"), false);
});

test("Piper command execution never uses a shell and receives text through stdin", async () => {
  let invocation;
  const spawnProcess = (command, args, options) => {
    invocation = { command, args, options, input: "" };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on("data", (chunk) => {
      invocation.input += chunk.toString("utf8");
    });
    child.stdin.on("finish", () => process.nextTick(() => child.emit("close", 0)));
    return child;
  };
  await runPiperCommand(
    {
      command: "/safe/piper",
      args: ["--model", "/safe/model.onnx", "--output_file", "/safe/output.wav"],
      input: "No shell interpolation; $(ignored)."
    },
    spawnProcess
  );
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.args, ["--model", "/safe/model.onnx", "--output_file", "/safe/output.wav"]);
  assert.equal(invocation.input, "No shell interpolation; $(ignored).");
  assert.ok(Object.keys(invocation.options.env).every((key) => ["PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"].includes(key)));
  assert.equal(Object.hasOwn(invocation.options.env, "OPENAI_API_KEY"), false);
});

test("Piper local adapter rejects missing configs, invalid speakers, directions, and malformed output", async (context) => {
  const directory = createDirectory("produdash-piper-invalid-");
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = createPiperFiles(directory);
  const adapter = new PiperLocalProviderAdapter({
    runCommand: async (request) => fs.writeFileSync(request.outputPath, "not-wave")
  });
  await assert.rejects(
    adapter.generateSpeech({
      credentials,
      modelId: PIPER_LOCAL_MODEL.id,
      input: "Hello",
      voice: PIPER_VOICE_ID
    }),
    { code: "LOCAL_SPEECH_INVALID" }
  );
  await assert.rejects(
    adapter.generateSpeech({
      credentials: { ...credentials, speakerId: "-1" },
      modelId: PIPER_LOCAL_MODEL.id,
      input: "Hello",
      voice: PIPER_VOICE_ID
    }),
    { code: "INVALID_PIPER_SPEAKER" }
  );
  await assert.rejects(
    adapter.generateSpeech({
      credentials,
      modelId: PIPER_LOCAL_MODEL.id,
      input: "Hello",
      voice: PIPER_VOICE_ID,
      instructions: "Whisper"
    }),
    { code: "CAPABILITY_UNSUPPORTED" }
  );
  fs.unlinkSync(`${credentials.modelPath}.json`);
  await assert.rejects(adapter.validate(credentials, PIPER_LOCAL_MODEL.id), { code: "PIPER_LOCAL_UNAVAILABLE" });
});
