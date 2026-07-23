const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { AppError } = require("../electron/errors.cjs");
const { MediaJobService } = require("../electron/media/media-job-service.cjs");
const { validateState } = require("../electron/state-schema.cjs");
const { createHarness } = require("./helpers.cjs");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(check, timeout = 2_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for media job state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createFakeRunner() {
  const starts = [];
  return {
    starts,
    start(job, onMessage) {
      const completion = deferred();
      const record = {
        job,
        onMessage,
        completion,
        canceled: false
      };
      starts.push(record);
      return {
        result: completion.promise,
        cancel() {
          record.canceled = true;
          completion.resolve({ type: "canceled" });
        }
      };
    }
  };
}

test("media jobs keep paths encrypted, run one at a time, and require approval before rendering", async (context) => {
  const harness = await createHarness();
  context.after(harness.cleanup);
  const sourcePath = path.join(harness.directory, "source.mp4");
  const outputParent = path.join(harness.directory, "outputs");
  fs.writeFileSync(sourcePath, "fixture");
  fs.mkdirSync(outputParent);
  const runner = createFakeRunner();
  const mediaLibrary = {
    getClipSummary: (id) => ({ id, name: "Source.mp4", status: "available" }),
    resolveClipPath: () => sourcePath,
    startClipAccess: () => null,
    addFiles: async () => ({})
  };
  const events = [];
  const jobs = new MediaJobService({
    store: harness.store,
    mediaLibrary,
    credentialVault: harness.vault,
    runner,
    onEvent: (event) => events.push(event)
  });
  await jobs.initialize();
  const create = async (title) => {
    const selection = jobs.rememberOutputSelection({ path: outputParent });
    return jobs.create({
      sourceMediaId: "media-source",
      outputSelectionId: selection.id,
      title,
      goal: "",
      maxClips: 1,
      targetDuration: 8,
      captionMode: "off",
      captionText: "",
      aspectTreatment: "fit_pad",
      targetAspect: "vertical",
      platforms: ["tiktok"]
    });
  };
  await create("First");
  await create("Second");
  await waitFor(() => runner.starts.length === 1);
  assert.equal(runner.starts[0].job.mode, "analyze");
  assert.equal(harness.store.getAppState().mediaJobs.filter((job) => job.status === "processing").length, 1);
  const stateText = fs.readFileSync(harness.store.filePath, "utf8");
  assert.doesNotMatch(stateText, /source\.mp4|outputs|sourcePath|outputPath/);

  const firstId = runner.starts[0].job.id;
  runner.starts[0].onMessage({ type: "progress", stage: "metadata", progress: 10, detail: "Inspecting." });
  runner.starts[0].completion.resolve({
    type: "awaiting_review",
    candidates: [
      {
        id: "candidate-1",
        title: "Clip 1",
        start: 0,
        end: 8,
        duration: 8,
        confidence: 0.8,
        scores: {},
        rationale: "Local interval"
      }
    ],
    warnings: []
  });
  await waitFor(() => runner.starts.length === 2);
  assert.equal(harness.store.getMediaJob(firstId).status, "awaiting_review");
  await jobs.approveCandidates(firstId, ["candidate-1"]);
  assert.equal(harness.store.getMediaJob(firstId).status, "render_queued");
  await assert.rejects(jobs.approveCandidates(firstId, ["candidate-other"]), { code: "MEDIA_JOB_TRANSITION_INVALID" });

  runner.starts[1].completion.resolve({ type: "canceled" });
  await waitFor(() => runner.starts.length === 3);
  assert.equal(runner.starts[2].job.id, firstId);
  assert.equal(runner.starts[2].job.mode, "render");
  runner.starts[2].completion.resolve({
    type: "completed",
    artifacts: [
      { kind: "video", name: "clip.mp4", path: path.join(outputParent, "clip.mp4") },
      { kind: "manifest", name: "produdash-manifest.json", path: path.join(outputParent, "produdash-manifest.json") }
    ],
    warnings: []
  });
  await waitFor(() => harness.store.getMediaJob(firstId).status === "completed");
  const completed = harness.store.getMediaJob(firstId);
  assert.deepEqual(completed.artifacts, [
    { kind: "video", name: "clip.mp4" },
    { kind: "manifest", name: "produdash-manifest.json" }
  ]);
  assert.doesNotThrow(() => validateState(harness.store.getAppState()));
  assert.equal(JSON.stringify(completed).includes(outputParent), false);
  assert.ok(events.some((event) => event.jobId === firstId && event.terminal));
});

test("restart interruption, cancellation, retry, and clear preserve user-owned output files", async (context) => {
  const harness = await createHarness();
  context.after(harness.cleanup);
  const sourcePath = path.join(harness.directory, "source.mp4");
  const outputParent = path.join(harness.directory, "outputs");
  fs.writeFileSync(sourcePath, "fixture");
  fs.mkdirSync(outputParent);
  const runner = createFakeRunner();
  const jobs = new MediaJobService({
    store: harness.store,
    mediaLibrary: {
      getClipSummary: (id) => ({ id, name: "Source.mp4", status: "available" }),
      resolveClipPath: () => sourcePath,
      startClipAccess: () => null,
      addFiles: async () => ({})
    },
    credentialVault: harness.vault,
    runner
  });
  const selection = jobs.rememberOutputSelection({ path: outputParent });
  const state = await jobs.create({
    sourceMediaId: "media-source",
    outputSelectionId: selection.id,
    title: "Cancelable",
    maxClips: 1,
    targetDuration: 8,
    captionMode: "off",
    aspectTreatment: "fit_pad",
    targetAspect: "original",
    platforms: []
  });
  const jobId = state.mediaJobs[0].id;
  await waitFor(() => runner.starts.length === 1);
  await jobs.cancel(jobId);
  await waitFor(() => harness.store.getMediaJob(jobId).status === "canceled");
  assert.equal(runner.starts[0].canceled, true);
  await jobs.retry(jobId);
  await waitFor(() => runner.starts.length === 2);
  const privatePaths = harness.vault.get(`media-job-${jobId}`);
  fs.mkdirSync(privatePaths.tempPath, { recursive: true });
  fs.writeFileSync(path.join(privatePaths.tempPath, "partial"), "temporary");
  const userOutput = path.join(privatePaths.outputPath, "keep.mp4");
  fs.writeFileSync(userOutput, "owned");
  await jobs.clear();
  assert.equal(fs.existsSync(privatePaths.tempPath), false);
  assert.equal(fs.existsSync(userOutput), true);
  assert.deepEqual(harness.vault.get(`media-job-${jobId}`), {});
});

test("cloud media jobs invoke only the selected analysis path and never fall back to local candidates", async (context) => {
  const harness = await createHarness();
  context.after(harness.cleanup);
  const sourcePath = path.join(harness.directory, "source.mp4");
  const outputParent = path.join(harness.directory, "outputs");
  fs.writeFileSync(sourcePath, "fixture");
  fs.mkdirSync(outputParent);
  const runner = createFakeRunner();
  let analysisCalls = 0;
  const jobs = new MediaJobService({
    store: harness.store,
    mediaLibrary: {
      getClipSummary: (id) => ({ id, name: "Source.mp4", status: "available" }),
      resolveClipPath: () => sourcePath,
      startClipAccess: () => null,
      addFiles: async () => ({})
    },
    credentialVault: harness.vault,
    runner,
    analysisService: {
      async analyze() {
        analysisCalls += 1;
        throw new AppError("PROVIDER_RATE_LIMITED", "The selected provider is temporarily rate limited.");
      }
    }
  });
  const selection = jobs.rememberOutputSelection({ path: outputParent });
  const state = await jobs.create({
    sourceMediaId: "media-source",
    outputSelectionId: selection.id,
    title: "Cloud analysis",
    maxClips: 1,
    targetDuration: 8,
    captionMode: "off",
    aspectTreatment: "fit_pad",
    targetAspect: "original",
    analysisMode: "native_video",
    cloudConsent: {
      confirmed: true,
      providerId: "gemini",
      modelId: "gemini-3.6-flash",
      dataCategories: ["complete_video"]
    },
    platforms: []
  });
  const jobId = state.mediaJobs[0].id;
  await waitFor(() => runner.starts.length === 1);
  runner.starts[0].completion.resolve({
    type: "awaiting_review",
    metadata: { duration: 30 },
    candidates: [{ id: "local-candidate", start: 0, end: 8 }],
    warnings: []
  });
  await waitFor(() => harness.store.getMediaJob(jobId).status === "failed");
  const failed = harness.store.getMediaJob(jobId);
  assert.equal(analysisCalls, 1);
  assert.equal(failed.candidates.length, 0);
  assert.match(failed.error, /selected provider is temporarily rate limited/i);
  assert.equal(failed.retryable, true);
});
