const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AppError } = require("../errors.cjs");
const { validateCandidateSelection, validateMediaJobPayload } = require("../validation.cjs");

const RETRYABLE_STATUSES = new Set(["failed", "interrupted", "canceled"]);
const PROGRESS_BUCKET = 10;

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function safeFolderName(value) {
  const result = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 _-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 64)
    .toLowerCase();
  return result || "clips";
}

async function createOutputDirectory(parentPath, title, jobId) {
  const base = `produdash-${safeFolderName(title)}-${jobId.slice(-8)}`;
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = path.join(parentPath, suffix ? `${base}-${suffix + 1}` : base);
    try {
      await fs.promises.mkdir(candidate, { recursive: false });
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new AppError("OUTPUT_UNAVAILABLE", "ProduDash could not create a job folder in the selected output location.");
      }
    }
  }
  throw new AppError("OUTPUT_COLLISION", "ProduDash could not create a collision-free output folder.");
}

function sanitizeArtifacts(artifacts) {
  return (Array.isArray(artifacts) ? artifacts : [])
    .filter((artifact) => artifact && ["video", "caption", "thumbnail", "manifest"].includes(artifact.kind))
    .map((artifact) => ({
      kind: artifact.kind,
      name: path.basename(String(artifact.name || "")).slice(0, 180)
    }))
    .filter((artifact) => artifact.name);
}

class MediaJobService {
  constructor({ store, mediaLibrary, credentialVault, runner, startAccessingBookmark, onEvent = () => {} }) {
    this.store = store;
    this.mediaLibrary = mediaLibrary;
    this.credentialVault = credentialVault;
    this.runner = runner;
    this.startAccessingBookmark = startAccessingBookmark;
    this.onEvent = onEvent;
    this.outputSelections = new Map();
    this.active = null;
    this.scheduling = false;
    this.clearing = false;
  }

  async initialize() {
    await this.store.interruptActiveMediaJobs();
    if (this.credentialVault) {
      for (const job of this.store.getAppState().mediaJobs.filter((item) => item.status === "completed")) {
        const values = this.credentialVault.get(`media-job-${job.id}`);
        if (values.tempPath) await fs.promises.rm(values.tempPath, { recursive: true, force: true }).catch(() => {});
      }
    }
    this.schedule();
  }

  rememberOutputSelection(selection) {
    if (!selection?.path) return null;
    let stopAccess = null;
    let canonicalPath;
    try {
      if (selection.bookmark && this.startAccessingBookmark) stopAccess = this.startAccessingBookmark(selection.bookmark);
      canonicalPath = fs.realpathSync(selection.path);
      const stat = fs.statSync(canonicalPath, { throwIfNoEntry: false });
      if (!stat?.isDirectory()) throw new AppError("OUTPUT_UNAVAILABLE", "The selected output folder is unavailable.");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("OUTPUT_UNAVAILABLE", "The selected output folder is unavailable.");
    } finally {
      if (typeof stopAccess === "function") stopAccess();
    }
    const id = createId("output");
    this.outputSelections.set(id, {
      path: canonicalPath,
      bookmark: selection.bookmark || null,
      expiresAt: Date.now() + 10 * 60 * 1000
    });
    return { id, name: path.basename(canonicalPath) || canonicalPath };
  }

  consumeOutputSelection(id) {
    const selection = this.outputSelections.get(id);
    this.outputSelections.delete(id);
    if (!selection || selection.expiresAt < Date.now()) {
      throw new AppError("OUTPUT_SELECTION_EXPIRED", "Choose the output folder again before creating this media job.");
    }
    return selection;
  }

  async create(payload) {
    if (!this.credentialVault) {
      throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure storage is required before ProduDash can remember local media job paths.");
    }
    const input = validateMediaJobPayload(payload);
    const clip = this.mediaLibrary.getClipSummary(input.sourceMediaId);
    if (clip.status !== "available") throw new AppError("SOURCE_UNAVAILABLE", "The selected library video is unavailable.");
    const sourcePath = this.mediaLibrary.resolveClipPath(input.sourceMediaId);
    const selection = this.consumeOutputSelection(input.outputSelectionId);
    const jobId = createId("mediajob");
    let stopOutputAccess = null;
    let outputPath;
    try {
      if (selection.bookmark && this.startAccessingBookmark) stopOutputAccess = this.startAccessingBookmark(selection.bookmark);
      outputPath = await createOutputDirectory(selection.path, input.title, jobId);
    } finally {
      if (typeof stopOutputAccess === "function") stopOutputAccess();
    }
    const tempPath = path.join(outputPath, ".produdash-job");
    await this.credentialVault.replace(`media-job-${jobId}`, {
      sourcePath,
      outputPath,
      tempPath,
      outputBookmark: selection.bookmark || ""
    });
    const now = new Date().toISOString();
    try {
      const state = await this.store.createMediaJobSummary({
        id: jobId,
        title: input.title,
        goal: input.goal,
        sourceMediaId: input.sourceMediaId,
        sourceName: clip.name,
        outputFolderName: path.basename(outputPath),
        status: "queued",
        stage: "queued",
        progress: 0,
        settings: {
          maxClips: input.maxClips,
          targetDuration: input.targetDuration,
          captionMode: input.captionMode,
          captionText: input.captionText,
          aspectTreatment: input.aspectTreatment,
          targetAspect: input.targetAspect,
          platforms: input.platforms
        },
        candidates: [],
        selectedCandidateIds: [],
        warnings: [],
        artifacts: [],
        error: null,
        retryable: false,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null
      });
      this.schedule();
      return state;
    } catch (error) {
      await this.credentialVault.remove(`media-job-${jobId}`);
      await fs.promises.rm(outputPath, { recursive: true, force: true });
      throw error;
    }
  }

  async approveCandidates(jobId, candidateIds) {
    const job = this.store.getMediaJob(jobId);
    if (job.status === "render_queued" || job.status === "completed" || (job.status === "processing" && job.selectedCandidateIds.length)) {
      const normalized = validateCandidateSelection(candidateIds);
      if (JSON.stringify(normalized) === JSON.stringify(job.selectedCandidateIds)) return this.store.getAppState();
      throw new AppError("MEDIA_JOB_TRANSITION_INVALID", "This media job already has an approved candidate selection.");
    }
    if (job.status !== "awaiting_review") {
      throw new AppError("MEDIA_JOB_TRANSITION_INVALID", "Candidates can only be approved while a media job awaits review.");
    }
    const normalized = validateCandidateSelection(candidateIds);
    const knownIds = new Set(job.candidates.map((candidate) => candidate.id));
    if (normalized.some((id) => !knownIds.has(id))) {
      throw new AppError("CANDIDATE_NOT_FOUND", "One or more selected clip candidates are unavailable.");
    }
    const state = await this.store.updateMediaJobSummary(
      jobId,
      {
        selectedCandidateIds: normalized,
        status: "render_queued",
        stage: "queued",
        progress: 75,
        error: null,
        retryable: false
      },
      `Approved ${normalized.length} deterministic clip candidate${normalized.length === 1 ? "" : "s"} for rendering.`
    );
    this.schedule();
    return state;
  }

  async cancel(jobId) {
    const job = this.store.getMediaJob(jobId);
    if (job.status === "canceled") return this.store.getAppState();
    if (job.status === "completed") throw new AppError("MEDIA_JOB_TRANSITION_INVALID", "A completed media job cannot be canceled.");
    if (this.active?.jobId === jobId) {
      const state = await this.store.updateMediaJobSummary(jobId, {
        status: "canceling",
        stage: "canceling",
        error: null
      });
      this.active.handle.cancel();
      return state;
    }
    if (!["queued", "render_queued", "awaiting_review", "failed", "interrupted"].includes(job.status)) {
      throw new AppError("MEDIA_JOB_TRANSITION_INVALID", "This media job cannot be canceled from its current state.");
    }
    return this.store.updateMediaJobSummary(
      jobId,
      { status: "canceled", stage: "canceled", error: null, retryable: true },
      `Canceled media job: ${job.title}.`
    );
  }

  async retry(jobId) {
    const job = this.store.getMediaJob(jobId);
    if (!RETRYABLE_STATUSES.has(job.status)) {
      throw new AppError("MEDIA_JOB_TRANSITION_INVALID", "Only failed, interrupted, or canceled media jobs can be retried.");
    }
    if (!job.retryable && job.status !== "canceled") {
      throw new AppError("MEDIA_JOB_NOT_RETRYABLE", "This media job cannot be retried with its current source and settings.");
    }
    const nextStatus = job.selectedCandidateIds.length ? "render_queued" : "queued";
    const state = await this.store.updateMediaJobSummary(
      jobId,
      { status: nextStatus, stage: "queued", error: null, retryable: false },
      `Retried media job: ${job.title}.`
    );
    this.schedule();
    return state;
  }

  revealOutput(jobId, showItemInFolder) {
    const job = this.store.getMediaJob(jobId);
    const paths = this.getPrivatePaths(jobId);
    showItemInFolder(paths.outputPath);
    return { jobId: job.id };
  }

  getPrivatePaths(jobId) {
    if (!this.credentialVault) throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure media job paths are unavailable.");
    const values = this.credentialVault.get(`media-job-${jobId}`);
    if (!values.sourcePath || !values.outputPath || !values.tempPath) {
      throw new AppError("MEDIA_JOB_PATHS_MISSING", "The protected paths for this media job are unavailable.");
    }
    return values;
  }

  schedule() {
    if (this.scheduling || this.active || this.clearing) return;
    this.scheduling = true;
    Promise.resolve()
      .then(async () => {
        if (this.active || this.clearing) return;
        const state = this.store.getAppState();
        const next = state.mediaJobs
          .filter((job) => job.status === "queued" || job.status === "render_queued")
          .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
        if (next) await this.start(next);
      })
      .finally(() => {
        this.scheduling = false;
        if (
          !this.active &&
          !this.clearing &&
          this.store.getAppState().mediaJobs.some((job) => job.status === "queued" || job.status === "render_queued")
        ) {
          this.schedule();
        }
      })
      .catch(() => {});
  }

  async start(job) {
    let paths;
    let stopSourceAccess = null;
    let stopOutputAccess = null;
    let resolveFinished = null;
    try {
      paths = this.getPrivatePaths(job.id);
      stopSourceAccess = this.mediaLibrary.startClipAccess(job.sourceMediaId);
      if (paths.outputBookmark && this.startAccessingBookmark) stopOutputAccess = this.startAccessingBookmark(paths.outputBookmark);
      const mode = job.status === "render_queued" ? "render" : "analyze";
      const startedAt = job.startedAt || new Date().toISOString();
      await this.store.updateMediaJobSummary(job.id, {
        status: "processing",
        stage: mode === "render" ? "rendering" : "validation",
        error: null,
        retryable: false,
        startedAt
      });
      let lastStage = "";
      let lastBucket = -1;
      const handle = this.runner.start(
        {
          id: job.id,
          mode,
          sourcePath: paths.sourcePath,
          outputPath: paths.outputPath,
          tempPath: paths.tempPath,
          settings: job.settings,
          selectedCandidateIds: job.selectedCandidateIds,
          warnings: job.warnings,
          existingArtifactNames: job.artifacts.map((artifact) => artifact.name)
        },
        (message) => {
          const bucket = Math.floor(Number(message.progress || 0) / PROGRESS_BUCKET);
          this.onEvent({ jobId: job.id, stage: message.stage, progress: message.progress, detail: message.detail });
          if (message.stage === lastStage && bucket === lastBucket) return;
          lastStage = message.stage;
          lastBucket = bucket;
          void this.store.updateMediaJobSummary(job.id, {
            stage: message.stage,
            progress: message.progress
          });
        }
      );
      const finished = new Promise((resolve) => {
        resolveFinished = resolve;
      });
      this.active = { jobId: job.id, handle, finished };
      let result;
      try {
        result = await handle.result;
      } catch (error) {
        result = {
          type: "error",
          error: {
            code: error instanceof AppError ? error.code : "MEDIA_WORKER_FAILED",
            message: error instanceof AppError ? error.message : "The local media worker failed."
          },
          retryable: true
        };
      }
      await this.finish(job.id, result);
    } catch (error) {
      const current = this.store.getMediaJob(job.id);
      if (!["completed", "failed", "canceled"].includes(current.status)) {
        await this.store.updateMediaJobSummary(
          job.id,
          {
            status: "failed",
            stage: "failed",
            error: error instanceof AppError ? error.message : "ProduDash could not start this local media job.",
            retryable: true
          },
          `Media job needs attention: ${job.title}.`
        );
      }
    } finally {
      if (typeof stopOutputAccess === "function") stopOutputAccess();
      if (typeof stopSourceAccess === "function") stopSourceAccess();
      if (resolveFinished) resolveFinished();
      this.active = null;
    }
  }

  async finish(jobId, result) {
    const job = this.store.getMediaJob(jobId);
    if (result.type === "awaiting_review") {
      await this.store.updateMediaJobSummary(
        jobId,
        {
          status: "awaiting_review",
          stage: "candidate_review",
          progress: 75,
          candidates: result.candidates,
          warnings: result.warnings || [],
          error: null,
          retryable: false
        },
        `Prepared deterministic candidates for review: ${job.title}.`
      );
    } else if (result.type === "completed") {
      const videos = (result.artifacts || []).filter((artifact) => artifact.kind === "video" && artifact.path);
      const warnings = [...(result.warnings || [])];
      if (videos.length) {
        try {
          await this.mediaLibrary.addFiles(videos.map((artifact) => ({ path: artifact.path })));
        } catch {
          warnings.push("Generated clips were saved, but ProduDash could not add them to the Clip Library automatically.");
        }
      }
      await this.store.updateMediaJobSummary(
        jobId,
        {
          status: "completed",
          stage: "complete",
          progress: 100,
          artifacts: sanitizeArtifacts(result.artifacts),
          warnings,
          error: null,
          retryable: false,
          completedAt: new Date().toISOString()
        },
        `Completed deterministic media job: ${job.title}.`
      );
      try {
        const paths = this.getPrivatePaths(jobId);
        await fs.promises.rm(paths.tempPath, { recursive: true, force: true });
      } catch {
        // A completed job remains truthful; stale hidden work is retried during startup cleanup.
      }
    } else if (result.type === "canceled") {
      const partialArtifacts = sanitizeArtifacts(result.artifacts);
      const warnings = [...job.warnings];
      if (partialArtifacts.length && !warnings.includes("Some generated files remain in the output folder and will be reused on retry.")) {
        warnings.push("Some generated files remain in the output folder and will be reused on retry.");
      }
      await this.store.updateMediaJobSummary(
        jobId,
        {
          status: "canceled",
          stage: "canceled",
          error: null,
          retryable: true,
          artifacts: partialArtifacts.length ? partialArtifacts : job.artifacts,
          warnings
        },
        `Canceled media job: ${job.title}.`
      );
    } else {
      const error = result.error || {};
      const partialArtifacts = sanitizeArtifacts(result.artifacts);
      const warnings = [...job.warnings];
      if (partialArtifacts.length && !warnings.includes("Some generated files remain in the output folder and will be reused on retry.")) {
        warnings.push("Some generated files remain in the output folder and will be reused on retry.");
      }
      await this.store.updateMediaJobSummary(
        jobId,
        {
          status: "failed",
          stage: "failed",
          error: String(error.message || "Local media processing failed.").slice(0, 300),
          retryable: Boolean(result.retryable),
          artifacts: partialArtifacts.length ? partialArtifacts : job.artifacts,
          warnings
        },
        `Media job needs attention: ${job.title}.`
      );
    }
    this.onEvent({ jobId, terminal: true });
  }

  async clear() {
    this.clearing = true;
    this.outputSelections.clear();
    while (this.scheduling && !this.active) {
      await new Promise((resolve) => process.nextTick(resolve));
    }
    if (this.active) {
      const active = this.active;
      active.handle.cancel();
      await active.finished;
    }
    const jobs = this.store.getAppState().mediaJobs;
    for (const job of jobs) {
      if (!this.credentialVault) continue;
      const values = this.credentialVault.get(`media-job-${job.id}`);
      if (values.tempPath) await fs.promises.rm(values.tempPath, { recursive: true, force: true }).catch(() => {});
      await this.credentialVault.remove(`media-job-${job.id}`);
    }
  }

  resume() {
    this.clearing = false;
    this.schedule();
  }
}

module.exports = {
  MediaJobService,
  createOutputDirectory,
  safeFolderName,
  sanitizeArtifacts
};
