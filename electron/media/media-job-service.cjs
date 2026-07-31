const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AppError } = require("../errors.cjs");
const { validateCandidateEdits, validateCandidateSelection, validateMediaJobPayload } = require("../validation.cjs");
const { deriveCaptionSegments, wrapCaptionText } = require("./captions.cjs");
const { hashRenderPlan, rebaseTranscript } = require("../projects/render-plan.cjs");

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

function artifactId(jobId, kind, name) {
  if (!jobId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(jobId)) return null;
  return `artifact-${crypto.createHash("sha256").update(`${jobId}:${kind}:${name}`).digest("hex").slice(0, 24)}`;
}

function thumbnailGroupId(jobId, name) {
  const stem = path
    .basename(name, path.extname(name))
    .replace(/-thumb-(early|middle|late)$/i, "")
    .slice(0, 180);
  return `thumbgroup-${crypto.createHash("sha256").update(`${jobId}:${stem}`).digest("hex").slice(0, 20)}`;
}

function hasSupportedImageSignature(filePath, extension) {
  const bytes = Buffer.alloc(12);
  const file = fs.openSync(filePath, "r");
  try {
    fs.readSync(file, bytes, 0, bytes.length, 0);
  } finally {
    fs.closeSync(file);
  }
  if ([".jpg", ".jpeg"].includes(extension)) return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === ".png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === ".webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

function sanitizeArtifacts(artifacts, jobId = null) {
  return (Array.isArray(artifacts) ? artifacts : [])
    .filter((artifact) => artifact && ["video", "caption", "thumbnail", "manifest"].includes(artifact.kind))
    .map((artifact) => {
      const name = path.basename(String(artifact.name || "")).slice(0, 180);
      const id = artifactId(jobId, artifact.kind, name);
      const positionRatio = Number(artifact.variant?.positionRatio);
      if (artifact.kind !== "thumbnail" || !id) return { kind: artifact.kind, name };
      const source = artifact.variant?.source === "user_import" ? "user_import" : "local_render";
      const groupId = /^thumbgroup-[a-f0-9]{20}$/.test(String(artifact.variant?.groupId || ""))
        ? artifact.variant.groupId
        : thumbnailGroupId(jobId, name);
      return {
        id,
        kind: artifact.kind,
        name,
        source,
        positionRatio:
          source === "local_render" && Number.isFinite(positionRatio) && positionRatio >= 0 && positionRatio <= 1 ? positionRatio : null,
        groupId,
        previewUrl: `produdash-media://job-thumbnail/${id}`
      };
    })
    .filter((artifact) => artifact.name);
}

function readTranscript(tempPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tempPath, "transcript.json"), "utf8"));
  } catch {
    return null;
  }
}

function editableCandidates(candidates, job, sourceDuration, transcript) {
  return (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const original = Object.freeze({
      title: candidate.title,
      start: candidate.start,
      end: candidate.end,
      duration: Number((candidate.end - candidate.start).toFixed(3))
    });
    const transcriptCaptions = transcript ? deriveCaptionSegments(transcript, candidate.start, candidate.end) : [];
    const manualCaptionText = transcriptCaptions.length ? "" : job.settings.captionText || "";
    const captionSegments =
      transcriptCaptions.length || !manualCaptionText
        ? transcriptCaptions
        : [
            {
              id: "caption-1",
              start: 0,
              end: original.duration,
              text: wrapCaptionText(manualCaptionText)
            }
          ];
    return {
      ...candidate,
      original,
      edit: {
        ...original,
        captionSegments,
        manualCaptionText,
        captionSource: transcriptCaptions.length ? "transcript" : manualCaptionText ? "manual" : "none",
        captionStyle: "clean",
        captionPosition: "lower",
        captionSafeArea: "standard",
        aspectTreatment: job.settings.aspectTreatment,
        targetAspect: job.settings.targetAspect,
        updatedAt: null
      },
      sourceDuration
    };
  });
}

class MediaJobService {
  constructor({
    store,
    mediaLibrary,
    projects = null,
    brandAssets = null,
    credentialVault,
    runner,
    analysisService = null,
    startAccessingBookmark,
    onEvent = () => {}
  }) {
    this.store = store;
    this.mediaLibrary = mediaLibrary;
    this.projects = projects;
    this.brandAssets = brandAssets;
    this.credentialVault = credentialVault;
    this.runner = runner;
    this.analysisService = analysisService;
    this.startAccessingBookmark = startAccessingBookmark;
    this.onEvent = onEvent;
    this.outputSelections = new Map();
    this.active = null;
    // The job schedule() has committed to but start() has not finished wiring
    // up. `active` cannot cover this: it needs the runner handle, which does not
    // exist until two awaits later, and a cancel arriving in between was
    // silently dropped while the render carried on to completion.
    this.claimed = null;
    this.cancelRequested = new Set();
    this.scheduling = false;
    this.clearing = false;
  }

  async initialize() {
    await this.store.interruptActiveMediaJobs();
    if (this.credentialVault) {
      for (const job of this.store
        .getAppState()
        .mediaJobs.filter((item) => item.status === "completed" && item.jobType !== "project_prepare")) {
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
        jobType: "clip_generation",
        projectId: null,
        renderPlanVersion: null,
        renderPlanHash: null,
        title: input.title,
        goal: input.goal,
        sourceMediaId: input.sourceMediaId,
        sourceName: clip.name,
        sourcePreviewUrl: clip.previewable ? `produdash-media://clip/${clip.id}` : null,
        sourceDuration: Number.isFinite(Number(clip.duration)) ? Number(clip.duration) : null,
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
          analysisMode: input.analysisMode,
          cloudConsent: input.cloudConsent,
          platforms: input.platforms
        },
        candidates: [],
        selectedCandidateIds: [],
        warnings: [],
        artifacts: [],
        thumbnailSelections: [],
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

  async createProjectPreparation(projectId) {
    if (!this.projects) throw new AppError("PROJECTS_UNAVAILABLE", "Projects are unavailable.");
    if (!this.credentialVault) {
      throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure storage is required before preparing a project.");
    }
    const project = this.projects.get(projectId);
    if (project.source.status !== "available") throw new AppError("SOURCE_UNAVAILABLE", "Relink the project source before preparing it.");
    const existing = this.store.getAppState().mediaJobs.find((job) => job.projectId === projectId && job.jobType === "project_prepare");
    if (existing && ["queued", "processing", "completed"].includes(existing.status)) return this.store.getAppState();
    if (existing && RETRYABLE_STATUSES.has(existing.status)) return this.retry(existing.id);
    const jobId = createId("mediajob");
    const sourcePath = this.mediaLibrary.resolveClipPath(project.source.mediaId);
    const cachePath = path.join(this.projects.userDataPath, "project-cache", project.id);
    await fs.promises.mkdir(cachePath, { recursive: true });
    await this.credentialVault.replace(`media-job-${jobId}`, {
      sourcePath,
      outputPath: cachePath,
      tempPath: cachePath,
      outputBookmark: ""
    });
    const now = new Date().toISOString();
    const state = await this.store.createMediaJobSummary({
      id: jobId,
      jobType: "project_prepare",
      projectId: project.id,
      renderPlanVersion: project.draft.version,
      renderPlanHash: project.renderPlanHash,
      title: `Prepare ${project.title}`,
      goal: "Local editor preparation",
      sourceMediaId: project.source.mediaId,
      sourceName: project.source.name,
      sourcePreviewUrl: project.source.previewUrl,
      sourceDuration: project.source.duration,
      outputFolderName: "Local project cache",
      status: "queued",
      stage: "queued",
      progress: 0,
      settings: {
        maxClips: 1,
        targetDuration: Math.max(5, Math.min(180, Math.round(project.source.duration))),
        captionMode: "off",
        captionText: "",
        aspectTreatment: "fit_pad",
        targetAspect: "original",
        analysisMode: "local_heuristics",
        cloudConsent: null,
        platforms: project.platforms
      },
      candidates: [],
      selectedCandidateIds: [],
      warnings: [],
      artifacts: [],
      thumbnailSelections: [],
      error: null,
      retryable: false,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null
    });
    this.schedule();
    return state;
  }

  async createProjectRender(projectId, outputSelectionId) {
    if (!this.projects) throw new AppError("PROJECTS_UNAVAILABLE", "Projects are unavailable.");
    if (!this.credentialVault) {
      throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure storage is required before rendering a project.");
    }
    const project = this.projects.get(projectId);
    if (project.source.status !== "available") throw new AppError("SOURCE_UNAVAILABLE", "Relink the project source before rendering.");
    if (!project.preparation) throw new AppError("PROJECT_NOT_PREPARED", "Prepare the project before rendering.");
    if (project.draft.totalDuration < 5 || project.draft.totalDuration > 21_600) {
      throw new AppError("INVALID_RENDER_PLAN", "The edited project must be between 5 seconds and 6 hours.");
    }
    if (
      this.store
        .getAppState()
        .mediaJobs.some(
          (job) =>
            job.projectId === project.id &&
            job.jobType === "project_render" &&
            ["queued", "render_queued", "processing"].includes(job.status)
        )
    ) {
      throw new AppError("PROJECT_RENDER_ALREADY_QUEUED", "This project already has an active approved render.");
    }
    const selection = this.consumeOutputSelection(outputSelectionId);
    const jobId = createId("mediajob");
    let stopOutputAccess = null;
    let outputPath;
    try {
      if (selection.bookmark && this.startAccessingBookmark) stopOutputAccess = this.startAccessingBookmark(selection.bookmark);
      outputPath = await createOutputDirectory(selection.path, project.title, jobId);
    } finally {
      if (typeof stopOutputAccess === "function") stopOutputAccess();
    }
    const tempPath = path.join(outputPath, ".produdash-job");
    await fs.promises.mkdir(tempPath, { recursive: true });
    const assetPaths = {};
    const assetSnapshots = {};
    const composition = project.draft.composition || {};
    const brollTracks = (project.draft.intelligentTracks?.broll || []).filter((item) => item.reviewed);
    const voiceovers = (project.draft.localization?.voiceovers || []).filter((item) => item.status === "reviewed");
    const references = [
      ...(composition.overlays || [])
        .filter((overlay) => overlay.type === "logo")
        .map((overlay) => ({ id: overlay.assetId, kinds: "logo" })),
      ...(composition.music ? [{ id: composition.music.assetId, kinds: "music" }] : []),
      ...(composition.introAssetId ? [{ id: composition.introAssetId, kinds: "intro" }] : []),
      ...(composition.outroAssetId ? [{ id: composition.outroAssetId, kinds: "outro" }] : []),
      ...(project.draft.intelligentTracks?.sfx || []).filter((item) => item.reviewed).map((item) => ({ id: item.assetId, kinds: "music" })),
      ...voiceovers.map((item) => ({ id: item.assetId, kinds: "voiceover", voiceover: item }))
    ];
    if (references.length && !this.brandAssets) {
      throw new AppError("BRAND_ASSETS_UNAVAILABLE", "Brand assets are unavailable.");
    }
    const assetDirectory = path.join(tempPath, "assets");
    if (references.length) await fs.promises.mkdir(assetDirectory, { recursive: true });
    for (const reference of references) {
      if (assetPaths[reference.id]) continue;
      const resolved = this.brandAssets.resolve(reference.id, reference.kinds);
      if (reference.voiceover) {
        const sourceCue = project.draft.transcript.find((cue) => cue.id === reference.voiceover.sourceId);
        const activeVariant = project.draft.localization?.activeVariantId
          ? project.draft.localization.variants.find((variant) => variant.id === project.draft.localization.activeVariantId)
          : null;
        const text = activeVariant?.cues?.find((cue) => cue.sourceId === reference.voiceover.sourceId)?.text || sourceCue?.text || "";
        const textHash = crypto.createHash("sha256").update(text).digest("hex");
        if (
          resolved.asset.provenance?.textHash !== textHash ||
          reference.voiceover.provenance.textHash !== textHash ||
          resolved.asset.provenance?.providerProfileId !== reference.voiceover.provenance.providerProfileId ||
          resolved.asset.provenance?.modelId !== reference.voiceover.provenance.modelId ||
          resolved.asset.provenance?.voice !== reference.voiceover.provenance.voice
        ) {
          throw new AppError("VOICEOVER_SOURCE_CHANGED", "A reviewed voiceover no longer matches the selected transcript text.");
        }
      }
      const snapshotPath = path.join(assetDirectory, `${reference.id}${path.extname(resolved.filePath).toLowerCase()}`);
      await fs.promises.copyFile(resolved.filePath, snapshotPath);
      assetPaths[reference.id] = snapshotPath;
      assetSnapshots[reference.id] = {
        id: resolved.asset.id,
        kind: resolved.asset.kind,
        name: resolved.asset.name,
        fingerprint: resolved.asset.fingerprint,
        duration: resolved.asset.duration,
        hasAudio: resolved.asset.hasAudio
      };
    }
    for (const track of brollTracks) {
      const summary = this.mediaLibrary.getClipSummary(track.mediaId);
      if (summary.status !== "available" || summary.fingerprint !== track.provenance.fingerprint) {
        throw new AppError("BROLL_SOURCE_CHANGED", "A reviewed B-roll source is unavailable or has changed.");
      }
      let stopAccess = null;
      const source = this.mediaLibrary.resolveClipPath(track.mediaId);
      const snapshotPath = path.join(assetDirectory, `${track.mediaId}${path.extname(source).toLowerCase()}`);
      try {
        stopAccess = this.mediaLibrary.startClipAccess(track.mediaId);
        await fs.promises.mkdir(assetDirectory, { recursive: true });
        await fs.promises.copyFile(source, snapshotPath);
      } finally {
        if (typeof stopAccess === "function") stopAccess();
      }
      assetPaths[track.mediaId] = snapshotPath;
      assetSnapshots[track.mediaId] = {
        id: track.mediaId,
        kind: "broll",
        name: summary.name,
        fingerprint: summary.fingerprint,
        duration: summary.duration
      };
    }
    const projectCache = path.join(this.projects.userDataPath, "project-cache", project.id);
    for (const artifact of ["metadata.json", "analysis.json"]) {
      await fs.promises.copyFile(path.join(projectCache, artifact), path.join(tempPath, artifact)).catch(() => {
        throw new AppError("PROJECT_NOT_PREPARED", "Validated project preparation artifacts are unavailable.");
      });
    }
    const sourcePath = this.mediaLibrary.resolveClipPath(project.source.mediaId);
    await this.credentialVault.replace(`media-job-${jobId}`, {
      sourcePath,
      outputPath,
      tempPath,
      assetPaths,
      outputBookmark: selection.bookmark || ""
    });
    const now = new Date().toISOString();
    const planHash = hashRenderPlan(project.draft);
    const captionSegments = rebaseTranscript(project.draft);
    const selectedLanguageVariant = project.draft.localization?.activeVariantId
      ? project.draft.localization.variants.find((variant) => variant.id === project.draft.localization.activeVariantId)
      : null;
    const candidate = {
      id: "project-edit",
      title: project.title,
      start: 0,
      end: project.draft.totalDuration,
      duration: project.draft.totalDuration,
      confidence: 1,
      scores: {},
      rationale: "Human-edited project render plan.",
      original: { title: project.title, start: 0, end: project.draft.totalDuration, duration: project.draft.totalDuration },
      edit: {
        title: project.title,
        start: 0,
        end: project.draft.totalDuration,
        duration: project.draft.totalDuration,
        segments: project.draft.segments,
        captionSegments,
        manualCaptionText: "",
        captionSource: captionSegments.length ? "transcript" : "none",
        captionStyle: project.draft.presentation.captionStyle,
        captionPosition: project.draft.presentation.captionPosition,
        captionSafeArea: project.draft.presentation.captionSafeArea,
        captionTextColor: project.draft.presentation.captionTextColor,
        captionBackgroundColor: project.draft.presentation.captionBackgroundColor,
        captionScale: project.draft.presentation.captionScale,
        aspectTreatment: project.draft.presentation.aspectTreatment,
        targetAspect: project.draft.presentation.targetAspect,
        enhancement: project.draft.presentation.enhancement,
        templateRef: project.draft.templateRef,
        composition: project.draft.composition,
        intelligentTracks: project.draft.intelligentTracks,
        voiceovers,
        languageVariant: selectedLanguageVariant
          ? {
              id: selectedLanguageVariant.id,
              language: selectedLanguageVariant.language,
              label: selectedLanguageVariant.label,
              provenance: selectedLanguageVariant.provenance
            }
          : null,
        assetSnapshots,
        updatedAt: now
      }
    };
    try {
      const state = await this.store.createMediaJobSummary({
        id: jobId,
        jobType: "project_render",
        projectId: project.id,
        renderPlanVersion: project.draft.version,
        renderPlanHash: planHash,
        title: project.title,
        goal: project.instructions,
        sourceMediaId: project.source.mediaId,
        sourceName: project.source.name,
        sourcePreviewUrl: project.source.previewUrl,
        sourceDuration: project.source.duration,
        outputFolderName: path.basename(outputPath),
        status: "render_queued",
        stage: "queued",
        progress: 75,
        settings: {
          maxClips: 1,
          targetDuration: Math.max(5, Math.min(180, Math.round(project.draft.totalDuration))),
          captionMode: project.draft.presentation.captionMode,
          captionText: "",
          aspectTreatment: project.draft.presentation.aspectTreatment,
          targetAspect: project.draft.presentation.targetAspect,
          enhancement: project.draft.presentation.enhancement,
          templateRef: project.draft.templateRef,
          analysisMode: "local_heuristics",
          cloudConsent: null,
          platforms: project.platforms
        },
        candidates: [candidate],
        selectedCandidateIds: [candidate.id],
        warnings: [],
        artifacts: [],
        thumbnailSelections: [],
        error: null,
        retryable: false,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null
      });
      await this.projects.recordRenderApproval(project.id, jobId, planHash).catch(() => {});
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
    if (normalized.length > job.settings.maxClips) {
      throw new AppError("CANDIDATE_LIMIT_EXCEEDED", `Choose no more than ${job.settings.maxClips} final clips for this job.`);
    }
    const knownIds = new Set(job.candidates.map((candidate) => candidate.id));
    if (normalized.some((id) => !knownIds.has(id))) {
      throw new AppError("CANDIDATE_NOT_FOUND", "One or more selected clip candidates are unavailable.");
    }
    const selected = normalized.map((id) => job.candidates.find((candidate) => candidate.id === id));
    for (let left = 0; left < selected.length; left += 1) {
      for (let right = left + 1; right < selected.length; right += 1) {
        const leftStart = Number(selected[left].edit?.start ?? selected[left].start);
        const leftEnd = Number(selected[left].edit?.end ?? selected[left].end);
        const rightStart = Number(selected[right].edit?.start ?? selected[right].start);
        const rightEnd = Number(selected[right].edit?.end ?? selected[right].end);
        const overlap = Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
        const shorter = Math.min(leftEnd - leftStart, rightEnd - rightStart);
        if (shorter > 0 && overlap / shorter > 0.2) {
          throw new AppError("CANDIDATE_OVERLAP", "Approved clips cannot overlap by more than 20% of the shorter clip.");
        }
      }
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

  async updateCandidate(jobId, candidateId, values) {
    const job = this.store.getMediaJob(jobId);
    if (job.status !== "awaiting_review") {
      throw new AppError("MEDIA_JOB_TRANSITION_INVALID", "Candidate edits are allowed only while a media job awaits review.");
    }
    const candidate = job.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new AppError("CANDIDATE_NOT_FOUND", "The selected clip candidate is unavailable.");
    const edit = validateCandidateEdits(values, {
      sourceDuration: job.sourceDuration,
      candidates: [],
      candidateId
    });
    const candidates = job.candidates.map((item) =>
      item.id === candidateId
        ? {
            ...item,
            edit: {
              ...item.edit,
              ...edit,
              captionSource: edit.captionSegments.length
                ? item.edit?.captionSource || "manual"
                : edit.manualCaptionText
                  ? "manual"
                  : "none",
              updatedAt: new Date().toISOString()
            }
          }
        : item
    );
    return this.store.updateMediaJobSummary(jobId, { candidates }, `Saved non-destructive edits for clip candidate: ${candidate.title}.`);
  }

  async cancel(jobId) {
    const job = this.store.getMediaJob(jobId);
    if (job.status === "canceled") return this.store.getAppState();
    if (job.status === "completed") throw new AppError("MEDIA_JOB_TRANSITION_INVALID", "A completed media job cannot be canceled.");
    if (this.active?.jobId === jobId || this.claimed === jobId) {
      // Recorded before the await, not after. A job that finished while the
      // status write was queued would otherwise have had start()'s cleanup run
      // first, leaving this entry behind on an idle job -- and the next run for
      // the same id would cancel itself immediately.
      //
      // Recorded as well as acted on, because a job that is claimed but still
      // starting has no handle yet; start() applies this once it has one.
      this.cancelRequested.add(jobId);
      this.active?.handle?.cancel();
      return this.store.updateMediaJobSummary(jobId, {
        status: "canceling",
        stage: "canceling",
        error: null
      });
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

  // Rendering reuses the validated analysis artifacts in the job's temp folder.
  // Once candidates were approved, retry always went back to rendering -- so if
  // those artifacts were gone or truncated, every retry failed on the same read,
  // forever. The error even said "Retry analysis before rendering", which no
  // path could do. Checking here is what makes that instruction true.
  // "readable", "unreadable", or "unknown".
  //
  // The distinction matters because retry() discards the user's approved
  // candidate selections when it falls back to analysis. A bare catch treated
  // secure storage being unavailable, or a momentary EACCES, exactly like a
  // truncated file -- silently destroying those selections over a condition
  // that would have cleared by itself.
  analysisArtifactState(jobId) {
    let tempPath;
    try {
      ({ tempPath } = this.getPrivatePaths(jobId));
    } catch {
      return "unknown";
    }
    for (const name of ["metadata.json", "analysis.json"]) {
      const file = path.join(tempPath, name);
      if (!fs.existsSync(file)) return "unreadable";
      try {
        JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        // Filesystem errors carry a code; a parse failure does not.
        if (error?.code) return "unknown";
        return "unreadable";
      }
    }
    return "readable";
  }

  async retry(jobId) {
    const job = this.store.getMediaJob(jobId);
    if (!RETRYABLE_STATUSES.has(job.status)) {
      throw new AppError("MEDIA_JOB_TRANSITION_INVALID", "Only failed, interrupted, or canceled media jobs can be retried.");
    }
    if (!job.retryable && job.status !== "canceled") {
      throw new AppError("MEDIA_JOB_NOT_RETRYABLE", "This media job cannot be retried with its current source and settings.");
    }
    // Only a positive finding that the artifacts are gone sends an approved job
    // back to analysis. If we could not tell, the render is re-queued: it may
    // fail again, but it keeps the selections the user made.
    const artifacts = job.selectedCandidateIds.length ? this.analysisArtifactState(jobId) : "unreadable";
    const resumable = artifacts !== "unreadable";
    const state = await this.store.updateMediaJobSummary(
      jobId,
      {
        status: resumable ? "render_queued" : "queued",
        stage: "queued",
        error: null,
        retryable: false,
        thumbnailSelections: [],
        // Analysis regenerates candidates, so selections made against the old
        // ones would refer to nothing.
        ...(resumable ? {} : { selectedCandidateIds: [] })
      },
      job.selectedCandidateIds.length && !resumable
        ? `Retried media job from analysis after its validated artifacts were lost, discarding approved clips: ${job.title}.`
        : `Retried media job: ${job.title}.`
    );
    this.schedule();
    return state;
  }

  async selectThumbnail(jobId, thumbnailId) {
    const job = this.store.getMediaJob(jobId);
    if (job.status !== "completed") {
      throw new AppError("MEDIA_JOB_TRANSITION_INVALID", "A preferred thumbnail can be selected only after rendering completes.");
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(String(thumbnailId || ""))) {
      throw new AppError("INVALID_INPUT", "The selected thumbnail is invalid.");
    }
    const artifact = job.artifacts.find((item) => item.kind === "thumbnail" && item.id === thumbnailId);
    if (!artifact?.groupId) throw new AppError("THUMBNAIL_NOT_FOUND", "The selected thumbnail is unavailable.");
    const existing = Array.isArray(job.thumbnailSelections) ? job.thumbnailSelections : [];
    if (existing.some((item) => item.groupId === artifact.groupId && item.artifactId === artifact.id)) {
      return this.store.getAppState();
    }
    const thumbnailSelections = [
      ...existing.filter((item) => item.groupId !== artifact.groupId),
      {
        groupId: artifact.groupId,
        artifactId: artifact.id,
        selectedAt: new Date().toISOString()
      }
    ];
    return this.store.updateMediaJobSummary(
      jobId,
      { thumbnailSelections },
      `Selected a preferred local thumbnail for media job: ${job.title}.`
    );
  }

  async importThumbnail(jobId, groupId, selection) {
    const job = this.store.getMediaJob(jobId);
    if (job.status !== "completed") {
      throw new AppError("MEDIA_JOB_TRANSITION_INVALID", "A custom thumbnail can be added only after rendering completes.");
    }
    if (!/^thumbgroup-[a-f0-9]{20}$/.test(String(groupId || ""))) {
      throw new AppError("INVALID_INPUT", "The selected thumbnail group is invalid.");
    }
    if (!job.artifacts.some((artifact) => artifact.kind === "thumbnail" && artifact.groupId === groupId)) {
      throw new AppError("THUMBNAIL_NOT_FOUND", "The rendered clip for this thumbnail is unavailable.");
    }
    if (job.artifacts.filter((artifact) => artifact.kind === "thumbnail" && artifact.source === "user_import").length >= 12) {
      throw new AppError("THUMBNAIL_LIMIT_REACHED", "This media job already has the maximum of 12 custom thumbnails.");
    }
    if (!selection?.path) throw new AppError("THUMBNAIL_IMPORT_CANCELED", "Custom thumbnail selection was canceled.");
    let stopAccess = null;
    let sourcePath;
    let outputPath;
    try {
      if (selection.bookmark && this.startAccessingBookmark) stopAccess = this.startAccessingBookmark(selection.bookmark);
      sourcePath = fs.realpathSync(selection.path);
      outputPath = fs.realpathSync(this.getPrivatePaths(jobId).outputPath);
      const stat = fs.statSync(sourcePath);
      const extension = path.extname(sourcePath).toLowerCase();
      if (
        !stat.isFile() ||
        stat.size < 512 ||
        stat.size > 20 * 1024 * 1024 ||
        ![".jpg", ".jpeg", ".png", ".webp"].includes(extension) ||
        !hasSupportedImageSignature(sourcePath, extension)
      ) {
        throw new AppError("INVALID_THUMBNAIL", "Choose a valid JPG, PNG, or WebP image up to 20 MB.");
      }
      const normalizedExtension = extension === ".jpeg" ? ".jpg" : extension;
      const name = `custom-thumbnail-${groupId.slice(-8)}-${crypto.randomBytes(4).toString("hex")}${normalizedExtension}`;
      const destinationPath = path.join(outputPath, name);
      await fs.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
      const [artifact] = sanitizeArtifacts([{ kind: "thumbnail", name, variant: { source: "user_import", groupId } }], jobId);
      const thumbnailSelections = [
        ...(Array.isArray(job.thumbnailSelections) ? job.thumbnailSelections : []).filter((item) => item.groupId !== groupId),
        { groupId, artifactId: artifact.id, selectedAt: new Date().toISOString() }
      ];
      try {
        return await this.store.updateMediaJobSummary(
          jobId,
          { artifacts: [...job.artifacts, artifact], thumbnailSelections },
          `Added and selected a custom local thumbnail for media job: ${job.title}.`
        );
      } catch (error) {
        await fs.promises.unlink(destinationPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("THUMBNAIL_IMPORT_FAILED", "ProduDash could not safely copy the selected thumbnail.");
    } finally {
      if (typeof stopAccess === "function") stopAccess();
    }
  }

  resolveThumbnailArtifact(thumbnailId) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(String(thumbnailId || ""))) {
      throw new AppError("THUMBNAIL_NOT_FOUND", "The requested thumbnail is unavailable.");
    }
    const job = this.store
      .getAppState()
      .mediaJobs.find(
        (item) =>
          item.status === "completed" && item.artifacts.some((artifact) => artifact.kind === "thumbnail" && artifact.id === thumbnailId)
      );
    const artifact = job?.artifacts.find((item) => item.kind === "thumbnail" && item.id === thumbnailId);
    if (!job || !artifact || artifact.name !== path.basename(artifact.name)) {
      throw new AppError("THUMBNAIL_NOT_FOUND", "The requested thumbnail is unavailable.");
    }
    let outputPath;
    let filePath;
    try {
      outputPath = fs.realpathSync(this.getPrivatePaths(job.id).outputPath);
      filePath = fs.realpathSync(path.join(outputPath, artifact.name));
    } catch {
      throw new AppError("THUMBNAIL_NOT_FOUND", "The requested thumbnail is unavailable.");
    }
    const relative = path.relative(outputPath, filePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new AppError("THUMBNAIL_NOT_FOUND", "The requested thumbnail is unavailable.");
    }
    if (![".jpg", ".jpeg", ".png", ".webp"].includes(path.extname(filePath).toLowerCase())) {
      throw new AppError("THUMBNAIL_NOT_FOUND", "The requested thumbnail is unavailable.");
    }
    return filePath;
  }

  revealOutput(jobId, showItemInFolder) {
    const job = this.store.getMediaJob(jobId);
    if (job.jobType === "project_prepare") {
      throw new AppError("OUTPUT_UNAVAILABLE", "Project preparation does not create user-facing output.");
    }
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
    if (this.scheduling || this.active || this.claimed || this.clearing) return;
    this.scheduling = true;
    Promise.resolve()
      .then(async () => {
        if (this.active || this.claimed || this.clearing) return;
        const state = this.store.getAppState();
        const next = state.mediaJobs
          .filter((job) => job.status === "queued" || job.status === "render_queued")
          .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
        if (!next) return;
        // Claimed here, with no await in between, so a cancel can never arrive
        // while this job looks unclaimed to cancel().
        this.claimed = next.id;
        await this.start(next);
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
          jobType: job.jobType || "clip_generation",
          mode,
          sourcePath: paths.sourcePath,
          outputPath: paths.outputPath,
          tempPath: paths.tempPath,
          settings: job.settings,
          candidates: job.candidates,
          selectedCandidateIds: job.selectedCandidateIds,
          warnings: job.warnings,
          existingArtifactNames: job.artifacts.map((artifact) => artifact.name),
          assetPaths: paths.assetPaths || {}
        },
        (message) => {
          const bucket = Math.floor(Number(message.progress || 0) / PROGRESS_BUCKET);
          this.onEvent({ jobId: job.id, stage: message.stage, progress: message.progress, detail: message.detail });
          if (message.stage === lastStage && bucket === lastBucket) return;
          lastStage = message.stage;
          lastBucket = bucket;
          // Deliberately not awaited -- progress must not throttle the worker --
          // but a rejection still needs an owner. updateMediaJobSummary throws
          // MEDIA_JOB_NOT_FOUND if the job was cleared mid-run, and an unhandled
          // rejection there takes down the whole main process. Losing one
          // progress tick for a job that no longer exists costs nothing.
          this.store
            .updateMediaJobSummary(job.id, {
              stage: message.stage,
              progress: message.progress
            })
            .catch(() => {});
        }
      );
      const finished = new Promise((resolve) => {
        resolveFinished = resolve;
      });
      this.active = { jobId: job.id, handle, finished };
      // A cancel that arrived while this job was starting had no handle to act
      // on. Applying it here is what stops the run continuing to completion
      // after the user has already cancelled it.
      if (this.cancelRequested.has(job.id)) handle.cancel();
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
        this.onEvent({ jobId: job.id, terminal: true });
      }
    } finally {
      if (typeof stopOutputAccess === "function") stopOutputAccess();
      if (typeof stopSourceAccess === "function") stopSourceAccess();
      if (resolveFinished) resolveFinished();
      this.cancelRequested.delete(job.id);
      this.claimed = null;
      this.active = null;
    }
  }

  async finish(jobId, result) {
    const job = this.store.getMediaJob(jobId);
    if (job.jobType === "project_prepare") {
      if (result.type === "awaiting_review") {
        await this.projects.setPreparation(job.projectId, result.preparation || {});
        await this.store.updateMediaJobSummary(
          jobId,
          {
            status: "completed",
            stage: "complete",
            progress: 100,
            warnings: result.warnings || [],
            error: null,
            retryable: false,
            sourceDuration: result.metadata?.duration || job.sourceDuration,
            completedAt: new Date().toISOString()
          },
          `Prepared local editor signals for project ${job.projectId}.`
        );
        this.onEvent({ jobId, terminal: true });
        return;
      }
    }
    if (result.type === "awaiting_review" && (job.settings.analysisMode || "local_heuristics") !== "local_heuristics") {
      if (this.cancelRequested.has(jobId)) {
        // Cancelled while the local pass was finishing. Starting a cloud call
        // now would send this person's media to a provider after they had
        // already stopped the job.
        result = { type: "canceled" };
      } else if (!this.analysisService) {
        result = {
          type: "error",
          error: { code: "ANALYSIS_MODE_UNAVAILABLE", message: "The selected cloud analysis mode is unavailable." },
          retryable: true
        };
      } else {
        try {
          result = await this.analysisService.analyze({ job, paths: this.getPrivatePaths(jobId), localResult: result });
          // The request itself cannot be called back: analyze() takes no signal,
          // and threading one through the provider and transcription chain is a
          // much larger change than this. But a cancel during it used to do
          // nothing at all -- the runner had already gone terminal, so
          // handle.cancel() was a no-op, and the job reappeared as
          // awaiting_review or sat in "canceling", which has no action left in
          // the UI. It now ends where the user put it.
          if (this.cancelRequested.has(jobId)) result = { type: "canceled" };
        } catch (error) {
          result = {
            type: "error",
            error: {
              code: error instanceof AppError ? error.code : "CLOUD_ANALYSIS_FAILED",
              message: error instanceof AppError ? error.message : "The selected cloud analysis could not complete."
            },
            retryable: true
          };
        }
      }
    }
    if (result.type === "awaiting_review") {
      const method =
        (job.settings.analysisMode || "local_heuristics") === "local_heuristics" ? "local heuristics" : "the selected AI provider";
      const sourceDuration = Number(
        result.metadata?.duration ||
          job.sourceDuration ||
          Math.max(...(Array.isArray(result.candidates) ? result.candidates.map((candidate) => Number(candidate.end) || 0) : [0]))
      );
      const transcript = readTranscript(this.getPrivatePaths(jobId).tempPath);
      const candidates = editableCandidates(result.candidates, job, sourceDuration, transcript);
      await this.store.updateMediaJobSummary(
        jobId,
        {
          status: "awaiting_review",
          stage: "candidate_review",
          progress: 75,
          candidates,
          sourceDuration,
          warnings: result.warnings || [],
          error: null,
          retryable: false
        },
        `Prepared candidates with ${method} for review: ${job.title}.`
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
          artifacts: sanitizeArtifacts(result.artifacts, jobId),
          thumbnailSelections: [],
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
      const partialArtifacts = sanitizeArtifacts(result.artifacts, jobId);
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
      const partialArtifacts = sanitizeArtifacts(result.artifacts, jobId);
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
