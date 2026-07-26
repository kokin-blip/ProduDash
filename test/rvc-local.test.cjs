const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { RVC_LOCAL_MODEL, RvcLocalProviderAdapter, createProbeWav } = require("../electron/ai/adapters/rvc-local.cjs");

async function fixture() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "produdash-rvc-test-"));
  const executablePath = path.join(directory, "rvc");
  const modelPath = path.join(directory, "voice.pth");
  await fs.promises.writeFile(executablePath, "runtime", { mode: 0o700 });
  await fs.promises.writeFile(modelPath, "model");
  return { directory, executablePath, modelPath };
}

test("RVC uses fixed shell-free conversion arguments and returns bounded WAV audio", async (context) => {
  const files = await fixture();
  context.after(() => fs.promises.rm(files.directory, { recursive: true, force: true }));
  const calls = [];
  const adapter = new RvcLocalProviderAdapter({
    runCommand: async (request) => {
      calls.push(request);
      const inputPath = request.args[request.args.indexOf("-i") + 1];
      await fs.promises.copyFile(inputPath, request.outputPath);
    }
  });
  const audio = await adapter.convertVoice({
    credentials: files,
    modelId: RVC_LOCAL_MODEL.id,
    inputAudio: createProbeWav()
  });
  assert.equal(audio.subarray(0, 4).toString("ascii"), "RIFF");
  assert.deepEqual(calls[0].args.slice(0, 3), ["infer", "-m", files.modelPath]);
  assert.equal(calls[0].args.includes("-i"), true);
  assert.equal(calls[0].args.includes("-o"), true);
  assert.equal(calls[0].command, files.executablePath);
  assert.equal(calls[0].runtimeName, "RVC");
});

test("RVC validation performs a real bounded local conversion probe", async (context) => {
  const files = await fixture();
  context.after(() => fs.promises.rm(files.directory, { recursive: true, force: true }));
  let probe;
  const adapter = new RvcLocalProviderAdapter({
    runCommand: async (request) => {
      const inputPath = request.args[request.args.indexOf("-i") + 1];
      probe = await fs.promises.readFile(inputPath);
      await fs.promises.copyFile(inputPath, request.outputPath);
    }
  });
  assert.equal(await adapter.validate(files, RVC_LOCAL_MODEL.id), true);
  assert.equal(probe.subarray(8, 12).toString("ascii"), "WAVE");
});

test("RVC rejects missing models and invalid input audio", async (context) => {
  const files = await fixture();
  context.after(() => fs.promises.rm(files.directory, { recursive: true, force: true }));
  const adapter = new RvcLocalProviderAdapter();
  await assert.rejects(
    () =>
      adapter.convertVoice({
        credentials: { ...files, modelPath: path.join(files.directory, "missing.pth") },
        modelId: RVC_LOCAL_MODEL.id,
        inputAudio: createProbeWav()
      }),
    { code: "RVC_LOCAL_UNAVAILABLE" }
  );
  await assert.rejects(
    () =>
      adapter.convertVoice({
        credentials: files,
        modelId: RVC_LOCAL_MODEL.id,
        inputAudio: Buffer.alloc(44)
      }),
    { code: "INVALID_VOICE_AUDIO" }
  );
});
