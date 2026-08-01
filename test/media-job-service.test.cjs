const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { AppError } = require("../electron/errors.cjs");
const { MediaJobService } = require("../electron/media/media-job-service.cjs");
const { ProjectStore } = require("../electron/projects/project-store.cjs");
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
    metadata: { duration: 30 },
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
  await jobs.updateCandidate(firstId, "candidate-1", {
    title: "Edited clip",
    start: 1,
    end: 9,
    captionSegments: [],
    manualCaptionText: "",
    captionStyle: "clean",
    captionPosition: "lower",
    captionSafeArea: "standard",
    aspectTreatment: "center_crop",
    targetAspect: "vertical"
  });
  assert.equal(harness.store.getMediaJob(firstId).candidates[0].original.start, 0);
  assert.equal(harness.store.getMediaJob(firstId).candidates[0].edit.start, 1);
  await assert.rejects(
    jobs.updateCandidate(firstId, "candidate-1", {
      title: "Invalid",
      start: 1,
      end: 300,
      captionSegments: []
    }),
    { code: "INVALID_CANDIDATE_EDIT" }
  );
  await jobs.approveCandidates(firstId, ["candidate-1"]);
  assert.equal(harness.store.getMediaJob(firstId).status, "render_queued");
  await assert.rejects(jobs.approveCandidates(firstId, ["candidate-other"]), { code: "MEDIA_JOB_TRANSITION_INVALID" });

  runner.starts[1].completion.resolve({ type: "canceled" });
  await waitFor(() => runner.starts.length === 3);
  assert.equal(runner.starts[2].job.id, firstId);
  assert.equal(runner.starts[2].job.mode, "render");
  assert.equal(runner.starts[2].job.candidates[0].edit.title, "Edited clip");
  const completedPaths = harness.vault.get(`media-job-${firstId}`);
  const thumbnailPath = path.join(completedPaths.outputPath, "clip-01-edited-clip-thumb-middle.jpg");
  fs.writeFileSync(thumbnailPath, "thumbnail");
  runner.starts[2].completion.resolve({
    type: "completed",
    artifacts: [
      { kind: "video", name: "clip.mp4", path: path.join(outputParent, "clip.mp4") },
      {
        kind: "thumbnail",
        name: path.basename(thumbnailPath),
        path: thumbnailPath,
        variant: { source: "local_render", positionRatio: 0.5 }
      },
      { kind: "manifest", name: "produdash-manifest.json", path: path.join(outputParent, "produdash-manifest.json") }
    ],
    warnings: []
  });
  await waitFor(() => harness.store.getMediaJob(firstId).status === "completed");
  const completed = harness.store.getMediaJob(firstId);
  assert.deepEqual(completed.artifacts, [
    { kind: "video", name: "clip.mp4" },
    {
      id: completed.artifacts[1].id,
      kind: "thumbnail",
      name: "clip-01-edited-clip-thumb-middle.jpg",
      source: "local_render",
      positionRatio: 0.5,
      groupId: completed.artifacts[1].groupId,
      previewUrl: `produdash-media://job-thumbnail/${completed.artifacts[1].id}`
    },
    { kind: "manifest", name: "produdash-manifest.json" }
  ]);
  assert.match(completed.artifacts[1].id, /^artifact-[a-f0-9]{24}$/);
  assert.match(completed.artifacts[1].groupId, /^thumbgroup-[a-f0-9]{20}$/);
  await jobs.selectThumbnail(firstId, completed.artifacts[1].id);
  const selected = harness.store.getMediaJob(firstId);
  assert.equal(selected.thumbnailSelections[0].artifactId, completed.artifacts[1].id);
  assert.equal(jobs.resolveThumbnailArtifact(completed.artifacts[1].id), thumbnailPath);
  await assert.rejects(jobs.selectThumbnail(firstId, "artifact-000000000000000000000000"), { code: "THUMBNAIL_NOT_FOUND" });
  const importedSource = path.join(harness.directory, "custom-thumbnail.png");
  const importedBytes = Buffer.alloc(600);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(importedBytes);
  fs.writeFileSync(importedSource, importedBytes);
  await jobs.importThumbnail(firstId, completed.artifacts[1].groupId, { path: importedSource });
  const importedJob = harness.store.getMediaJob(firstId);
  const importedArtifact = importedJob.artifacts.find((artifact) => artifact.source === "user_import");
  assert.ok(importedArtifact);
  assert.equal(importedArtifact.positionRatio, null);
  assert.equal(importedArtifact.groupId, completed.artifacts[1].groupId);
  assert.equal(importedJob.thumbnailSelections[0].artifactId, importedArtifact.id);
  assert.equal(path.dirname(jobs.resolveThumbnailArtifact(importedArtifact.id)), completedPaths.outputPath);
  assert.equal(JSON.stringify(importedJob).includes(importedSource), false);
  const invalidImage = path.join(harness.directory, "not-an-image.png");
  fs.writeFileSync(invalidImage, Buffer.alloc(600));
  await assert.rejects(jobs.importThumbnail(firstId, completed.artifacts[1].groupId, { path: invalidImage }), {
    code: "INVALID_THUMBNAIL"
  });
  fs.unlinkSync(thumbnailPath);
  fs.symlinkSync(sourcePath, thumbnailPath);
  assert.throws(() => jobs.resolveThumbnailArtifact(completed.artifacts[1].id), { code: "THUMBNAIL_NOT_FOUND" });
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

test("project preparation and approved rendering reuse the queue and keep an immutable plan snapshot", async (context) => {
  const harness = await createHarness();
  context.after(harness.cleanup);
  const sourcePath = path.join(harness.directory, "project-source.mp4");
  const outputParent = path.join(harness.directory, "project-outputs");
  fs.writeFileSync(sourcePath, "fixture");
  fs.mkdirSync(outputParent);
  const runner = createFakeRunner();
  const mediaLibrary = {
    getClipSummary: (id) => ({
      id,
      name: "Project source.mp4",
      status: "available",
      duration: 30,
      previewable: true,
      fingerprint: "a".repeat(64)
    }),
    resolveClipPath: () => sourcePath,
    startClipAccess: () => null,
    addFiles: async () => ({})
  };
  const projects = new ProjectStore(harness.directory, {
    mediaLibrary,
    appStore: harness.store
  });
  const jobs = new MediaJobService({
    store: harness.store,
    mediaLibrary,
    credentialVault: harness.vault,
    runner,
    projects
  });
  const created = await projects.create({ sourceMediaId: "media-source", title: "Queue parity" });
  const edited = await projects.saveDraft(
    created.id,
    {
      ...created.draft,
      segments: [
        { id: "segment-a", sourceStart: 1, sourceEnd: 7 },
        { id: "segment-b", sourceStart: 14, sourceEnd: 21 }
      ]
    },
    created.revision
  );
  await jobs.createProjectPreparation(edited.id);
  await waitFor(() => runner.starts.length === 1);
  assert.equal(runner.starts[0].job.mode, "analyze");
  runner.starts[0].completion.resolve({
    type: "awaiting_review",
    metadata: { duration: 30 },
    preparation: { scenes: [7, 14], waveform: [0.2, 0.8] },
    warnings: []
  });
  await waitFor(() => projects.get(edited.id).prepared);
  const cachePath = path.join(harness.directory, "project-cache", edited.id);
  fs.writeFileSync(path.join(cachePath, "metadata.json"), JSON.stringify({ duration: 30, hasAudio: true }));
  fs.writeFileSync(path.join(cachePath, "analysis.json"), JSON.stringify({ analysisMode: "local_heuristics" }));
  const selection = jobs.rememberOutputSelection({ path: outputParent });
  await jobs.createProjectRender(edited.id, selection.id);
  await waitFor(() => runner.starts.length === 2);
  const renderStart = runner.starts[1];
  assert.equal(renderStart.job.mode, "render");
  assert.equal(renderStart.job.candidates[0].edit.segments.length, 2);
  const queuedHash = harness.store.getAppState().mediaJobs.find((job) => job.jobType === "project_render").renderPlanHash;
  await projects.saveDraft(
    edited.id,
    { ...projects.get(edited.id).draft, segments: [{ id: "segment-new", sourceStart: 2, sourceEnd: 10 }] },
    projects.get(edited.id).revision
  );
  assert.equal(renderStart.job.candidates[0].edit.segments.length, 2);
  assert.notEqual(projects.get(edited.id).renderPlanHash, queuedHash);
});

test("a cancel that arrives while a job is starting is not discarded", async (context) => {
  // schedule() commits to a job, but this.active is not assigned until after two
  // awaits. A cancel arriving in that window found no active job, wrote
  // "canceled", and start() then carried on regardless -- rendering the clips
  // and finishing as "completed". The user's cancel vanished and files were
  // written to their output folder anyway.
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
    runner,
    onEvent: () => {}
  });
  await jobs.initialize();

  // Fire the cancel from inside the "processing" write, which is the exact
  // moment the job is claimed but not yet cancellable through its handle.
  const realUpdate = harness.store.updateMediaJobSummary.bind(harness.store);
  let fired = false;
  harness.store.updateMediaJobSummary = async (id, patch, audit) => {
    if (patch.status === "processing" && !fired) {
      fired = true;
      await jobs.cancel(id);
    }
    return realUpdate(id, patch, audit);
  };

  const selection = jobs.rememberOutputSelection({ path: outputParent });
  const created = await jobs.create({
    sourceMediaId: "media-source",
    outputSelectionId: selection.id,
    title: "Cancelled while starting",
    goal: "",
    maxClips: 1,
    targetDuration: 8,
    captionMode: "off",
    captionText: "",
    aspectTreatment: "fit_pad",
    targetAspect: "vertical",
    platforms: ["tiktok"]
  });
  const jobId = created.mediaJobs[0].id;

  await waitFor(() => runner.starts.length === 1);
  assert.ok(fired, "the cancel has to land inside the starting window for this to mean anything");
  // If the cancel was dropped, the run proceeds to a normal finish.
  if (!runner.starts[0].canceled) {
    runner.starts[0].completion.resolve({ type: "awaiting_review", metadata: { duration: 30 }, candidates: [], warnings: [] });
  }

  await waitFor(() => !["queued", "processing", "canceling"].includes(harness.store.getMediaJob(jobId).status));
  assert.equal(harness.store.getMediaJob(jobId).status, "canceled", "the job the user cancelled must not finish anyway");
});

test("retrying a render whose analysis artifacts are unreadable goes back to analysis", async (context) => {
  // Rendering reuses validated artifacts from the job's temp folder. Once
  // candidates were approved, retry always re-queued the render -- so a
  // truncated metadata.json failed the same read on every attempt, forever,
  // while telling the user to "Retry analysis before rendering".
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
    runner,
    onEvent: () => {}
  });
  await jobs.initialize();
  const selection = jobs.rememberOutputSelection({ path: outputParent });
  const created = await jobs.create({
    sourceMediaId: "media-source",
    outputSelectionId: selection.id,
    title: "Corrupt artifacts",
    goal: "",
    maxClips: 1,
    targetDuration: 8,
    captionMode: "off",
    captionText: "",
    aspectTreatment: "fit_pad",
    targetAspect: "vertical",
    platforms: ["tiktok"]
  });
  const jobId = created.mediaJobs[0].id;
  await waitFor(() => runner.starts.length === 1);
  runner.starts[0].completion.resolve({
    type: "awaiting_review",
    metadata: { duration: 30 },
    candidates: [{ id: "candidate-1", title: "Clip 1", start: 0, end: 8, duration: 8, confidence: 0.8, scores: {}, rationale: "Local" }],
    warnings: []
  });
  await waitFor(() => harness.store.getMediaJob(jobId).status === "awaiting_review");
  await jobs.approveCandidates(jobId, ["candidate-1"]);
  await waitFor(() => runner.starts.length === 2);

  // The render fails on an unreadable durable artifact.
  runner.starts[1].completion.resolve({
    type: "error",
    error: { code: "DURABLE_ARTIFACT_MISSING", message: "Validated analysis artifacts are unreadable." },
    retryable: true
  });
  await waitFor(() => harness.store.getMediaJob(jobId).status === "failed");

  // The temp folder holds nothing readable, so a retry must redo analysis
  // rather than queue the same failing render again.
  const state = await jobs.retry(jobId);
  const retried = state.mediaJobs.find((item) => item.id === jobId);
  assert.equal(retried.status, "queued", "a render with no usable analysis has to start from analysis");
  assert.deepEqual(retried.selectedCandidateIds, [], "selections against regenerated candidates would refer to nothing");
});

test("cancelling during cloud analysis ends the job cancelled, not reviewed", async (context) => {
  // Once the local worker has gone terminal, handle.cancel() is a no-op, so a
  // cancel during the cloud call did nothing: the job either reappeared as
  // awaiting_review or sat in "canceling", which offers no action at all.
  const harness = await createHarness();
  context.after(harness.cleanup);
  const sourcePath = path.join(harness.directory, "source.mp4");
  const outputParent = path.join(harness.directory, "outputs");
  fs.writeFileSync(sourcePath, "fixture");
  fs.mkdirSync(outputParent);
  const runner = createFakeRunner();
  let jobs;
  const analysisService = {
    analyze: async ({ job, localResult }) => {
      // The user cancels while the provider request is in flight.
      await jobs.cancel(job.id);
      return localResult;
    }
  };
  jobs = new MediaJobService({
    store: harness.store,
    mediaLibrary: {
      getClipSummary: (id) => ({ id, name: "Source.mp4", status: "available" }),
      resolveClipPath: () => sourcePath,
      startClipAccess: () => null,
      addFiles: async () => ({})
    },
    credentialVault: harness.vault,
    runner,
    analysisService,
    onEvent: () => {}
  });
  await jobs.initialize();
  const selection = jobs.rememberOutputSelection({ path: outputParent });
  const created = await jobs.create({
    sourceMediaId: "media-source",
    outputSelectionId: selection.id,
    title: "Cancelled during analysis",
    goal: "",
    maxClips: 1,
    targetDuration: 8,
    captionMode: "off",
    captionText: "",
    aspectTreatment: "fit_pad",
    targetAspect: "vertical",
    platforms: ["tiktok"]
  });
  const jobId = created.mediaJobs[0].id;
  await waitFor(() => runner.starts.length === 1);
  // Put the job on a cloud analysis path so finish() takes the analyze branch.
  harness.store.state.mediaJobs.find((item) => item.id === jobId).settings.analysisMode = "transcript_only";

  runner.starts[0].completion.resolve({ type: "awaiting_review", metadata: { duration: 30 }, candidates: [], warnings: [] });

  await waitFor(() => !["queued", "processing", "canceling"].includes(harness.store.getMediaJob(jobId).status));
  assert.equal(harness.store.getMediaJob(jobId).status, "canceled");
});

test("retrying keeps approved clips when the artifacts cannot be checked", async (context) => {
  // Falling back to analysis discards the user's approved selections, so it has
  // to be reserved for a positive finding that the artifacts are gone. A bare
  // catch treated secure storage being unavailable, or a momentary EACCES,
  // exactly like a truncated file.
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
    runner,
    onEvent: () => {}
  });
  await jobs.initialize();
  const selection = jobs.rememberOutputSelection({ path: outputParent });
  const created = await jobs.create({
    sourceMediaId: "media-source",
    outputSelectionId: selection.id,
    title: "Unknown artifacts",
    goal: "",
    maxClips: 1,
    targetDuration: 8,
    captionMode: "off",
    captionText: "",
    aspectTreatment: "fit_pad",
    targetAspect: "vertical",
    platforms: ["tiktok"]
  });
  const jobId = created.mediaJobs[0].id;
  await waitFor(() => runner.starts.length === 1);
  runner.starts[0].completion.resolve({
    type: "awaiting_review",
    metadata: { duration: 30 },
    candidates: [{ id: "candidate-1", title: "Clip 1", start: 0, end: 8, duration: 8, confidence: 0.8, scores: {}, rationale: "Local" }],
    warnings: []
  });
  await waitFor(() => harness.store.getMediaJob(jobId).status === "awaiting_review");
  await jobs.approveCandidates(jobId, ["candidate-1"]);
  await waitFor(() => runner.starts.length === 2);
  runner.starts[1].completion.resolve({ type: "error", error: { code: "MEDIA_JOB_FAILED", message: "Failed." }, retryable: true });
  await waitFor(() => harness.store.getMediaJob(jobId).status === "failed");

  // Cannot look: this says nothing about whether the artifacts are intact.
  const realGetPaths = jobs.getPrivatePaths.bind(jobs);
  jobs.getPrivatePaths = () => {
    throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure storage is unavailable.");
  };
  const state = await jobs.retry(jobId);
  jobs.getPrivatePaths = realGetPaths;

  const retried = state.mediaJobs.find((item) => item.id === jobId);
  assert.deepEqual(retried.selectedCandidateIds, ["candidate-1"], "approved clips must survive a check that could not run");
  assert.equal(retried.status, "render_queued");
});
