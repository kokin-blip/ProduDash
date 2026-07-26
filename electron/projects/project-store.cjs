const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("../errors.cjs");
const { preserveFile, readJson, writeJsonAtomic } = require("../atomic-json.cjs");
const { boundedString, normalizePlatforms, requireId } = require("../validation.cjs");
const { createInitialRenderPlan, hashRenderPlan, normalizeRenderPlan } = require("./render-plan.cjs");

const PROJECT_STORE_VERSION = 1;
const PROJECT_DOCUMENT_VERSION = 1;
const VERSION_LIMIT = 50;

function clone(value) {
  return structuredClone(value);
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function recordAudit(project, type, detail) {
  project.audit = [
    {
      id: createId("projectaudit"),
      type,
      detail,
      at: new Date().toISOString()
    },
    ...(Array.isArray(project.audit) ? project.audit : [])
  ].slice(0, 500);
}

function emptyStore() {
  return { schemaVersion: PROJECT_STORE_VERSION, projects: [], collections: [], updatedAt: new Date().toISOString() };
}

function assertNoPrivateFields(value) {
  if (
    typeof value === "string" &&
    (/(?:^|\s)[A-Za-z]:\\/.test(value) || /(?:^|\s)\/(?:Users|home|private|tmp|var|opt|etc)\//.test(value))
  ) {
    throw new AppError("INVALID_PROJECT_STORE", "The saved ProduDash Projects data contains an absolute path.");
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/(path|bookmark|credential|secret|token|reasoning)$/i.test(key)) {
      throw new AppError("INVALID_PROJECT_STORE", "The saved ProduDash Projects data contains a private field.");
    }
    assertNoPrivateFields(child);
  }
}

function validateProjectStore(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== PROJECT_STORE_VERSION ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.collections)
  ) {
    throw new AppError("INVALID_PROJECT_STORE", "The saved ProduDash Projects data is invalid.");
  }
  assertNoPrivateFields(value);
  const collectionIds = new Set();
  value.collections = value.collections.map((collection) => {
    const id = requireId(collection?.id, "Project collection");
    if (collectionIds.has(id)) throw new AppError("INVALID_PROJECT_STORE", "Project collection identifiers must be unique.");
    collectionIds.add(id);
    return {
      id,
      name: boundedString(collection?.name, { label: "Collection name", min: 1, max: 80 }),
      createdAt: boundedString(collection?.createdAt, { label: "Collection creation time", min: 1, max: 40 })
    };
  });
  const projectIds = new Set();
  for (const project of value.projects) {
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw new AppError("INVALID_PROJECT_STORE", "The saved ProduDash Projects data contains an invalid record.");
    }
    requireId(project.id, "Project");
    if (projectIds.has(project.id)) throw new AppError("INVALID_PROJECT_STORE", "Project identifiers must be unique.");
    projectIds.add(project.id);
    requireId(project.source?.mediaId, "Project source");
    project.title = boundedString(project.title, { label: "Project title", min: 1, max: 120 });
    project.description = boundedString(project.description, { label: "Project description", max: 1_000 });
    project.businessId = project.businessId ? requireId(project.businessId, "Business") : null;
    project.source.name = boundedString(project.source.name, { label: "Project source name", min: 1, max: 255 });
    if (/[/\\]/.test(project.source.name) || !/^[a-f0-9]{64}$/.test(String(project.source.fingerprint || ""))) {
      throw new AppError("INVALID_PROJECT_STORE", "The saved project source metadata is invalid.");
    }
    if (!["active", "archived"].includes(project.status)) {
      throw new AppError("INVALID_PROJECT_STORE", "The saved project status is invalid.");
    }
    project.favorite = project.favorite === true;
    project.tags = normalizeTags(project.tags || []);
    project.collectionId = project.collectionId ? requireId(project.collectionId, "Project collection") : null;
    if (project.collectionId && !collectionIds.has(project.collectionId)) {
      throw new AppError("INVALID_PROJECT_STORE", "The saved project references an unknown collection.");
    }
    project.platforms = normalizePlatforms(project.platforms || []);
    project.desiredLengths = (Array.isArray(project.desiredLengths) ? project.desiredLengths : [])
      .slice(0, 5)
      .map((item) => boundedString(item, { label: "Desired length", min: 1, max: 40 }));
    project.instructions = boundedString(project.instructions, { label: "Project instructions", max: 2_000 });
    if (
      !Number.isInteger(project.revision) ||
      project.revision < 1 ||
      !Number.isInteger(project.savedRevision) ||
      project.savedRevision < 1 ||
      project.savedRevision > project.revision
    ) {
      throw new AppError("INVALID_PROJECT_STORE", "The saved project revision is invalid.");
    }
    const plan = normalizeRenderPlan(project.draft, {
      sourceMediaId: project.source.mediaId,
      sourceDuration: project.source.duration
    });
    project.draft = plan;
    project.versions = Array.isArray(project.versions) ? project.versions.slice(-VERSION_LIMIT) : [];
    project.versions = project.versions.map((version) => ({
      id: requireId(version?.id, "Project version"),
      revision: Number(version.revision),
      label: boundedString(version.label, { label: "Version label", min: 1, max: 120 }),
      hash: String(version.hash || ""),
      savedAt: boundedString(version.savedAt, { label: "Version save time", min: 1, max: 40 }),
      plan: normalizeRenderPlan(version.plan, {
        sourceMediaId: project.source.mediaId,
        sourceDuration: project.source.duration
      })
    }));
    if (project.versions.some((version) => version.hash !== hashRenderPlan(version.plan))) {
      throw new AppError("INVALID_PROJECT_STORE", "A saved project version hash is invalid.");
    }
    project.activity = (Array.isArray(project.activity) ? project.activity : []).slice(0, 200).map((item) => ({
      id: requireId(item?.id, "Project activity"),
      type: boundedString(item.type, { label: "Project activity type", min: 1, max: 40 }),
      detail: boundedString(item.detail, { label: "Project activity detail", min: 1, max: 500 }),
      at: boundedString(item.at, { label: "Project activity time", min: 1, max: 40 })
    }));
    project.audit = (Array.isArray(project.audit) ? project.audit : []).slice(0, 500).map((item) => ({
      id: requireId(item?.id, "Project audit"),
      type: boundedString(item.type, { label: "Project audit type", min: 1, max: 40 }),
      detail: boundedString(item.detail, { label: "Project audit detail", min: 1, max: 500 }),
      at: boundedString(item.at, { label: "Project audit time", min: 1, max: 40 })
    }));
    project.createdAt = boundedString(project.createdAt, { label: "Project creation time", min: 1, max: 40 });
    project.updatedAt = boundedString(project.updatedAt, { label: "Project update time", min: 1, max: 40 });
  }
  return value;
}

function loadProjectStore(filePath) {
  const backupPath = `${filePath}.bak`;
  const notices = [];
  if (!fs.existsSync(filePath)) {
    const data = emptyStore();
    writeJsonAtomic(filePath, data, { backup: false });
    return { data, notices };
  }
  try {
    const raw = readJson(filePath);
    if (Number(raw?.schemaVersion) > PROJECT_STORE_VERSION) {
      throw new AppError("FUTURE_PROJECT_STORE", "These Projects were created by a newer ProduDash version.");
    }
    return { data: validateProjectStore(raw), notices };
  } catch (error) {
    if (error instanceof AppError && error.code === "FUTURE_PROJECT_STORE") throw error;
    preserveFile(filePath, "recovery");
    if (fs.existsSync(backupPath)) {
      try {
        const data = validateProjectStore(readJson(backupPath));
        writeJsonAtomic(filePath, data, { backup: false });
        notices.push({ code: "PROJECTS_RECOVERED", message: "ProduDash recovered Projects from the last known-good backup." });
        return { data, notices };
      } catch {
        preserveFile(backupPath, "recovery");
      }
    }
    const data = emptyStore();
    writeJsonAtomic(filePath, data, { backup: false });
    notices.push({ code: "PROJECTS_RESET", message: "Damaged Projects data was preserved and a clean Projects workspace was opened." });
    return { data, notices };
  }
}

function normalizeTags(value) {
  if (!Array.isArray(value)) throw new AppError("INVALID_INPUT", "Project tags must be a list.");
  return [...new Set(value.map((item) => boundedString(item, { label: "Project tag", min: 1, max: 40 })))].slice(0, 20).sort();
}

class ProjectStore {
  constructor(userDataPath, { mediaLibrary, appStore } = {}) {
    this.userDataPath = userDataPath;
    this.filePath = path.join(userDataPath, "produdash-projects.json");
    this.mediaLibrary = mediaLibrary;
    this.appStore = appStore;
    const loaded = loadProjectStore(this.filePath);
    this.data = loaded.data;
    this.notices = loaded.notices;
    this.queue = Promise.resolve();
  }

  enqueue(callback) {
    const run = this.queue.then(callback, callback);
    this.queue = run.catch(() => {});
    return run;
  }

  persist() {
    this.data.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.filePath, this.data);
  }

  getNotices() {
    return clone(this.notices);
  }

  getTranscriptSearchSegments(mediaId) {
    requireId(mediaId, "Clip");
    const project = this.data.projects
      .filter((item) => item.status === "active" && item.source.mediaId === mediaId && item.draft.transcript.length)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    if (!project) return [];
    return project.draft.transcript.map((segment) => ({
      start: segment.start,
      end: segment.end,
      text: segment.text
    }));
  }

  sourceStatus(project) {
    try {
      const clip = this.mediaLibrary.getClipSummary(project.source.mediaId);
      return { status: clip.status, previewUrl: clip.previewable ? `produdash-media://clip/${clip.id}` : null };
    } catch {
      return { status: "missing", previewUrl: null };
    }
  }

  summary(project) {
    const source = this.sourceStatus(project);
    const jobs = this.appStore
      ? this.appStore
          .getAppState()
          .mediaJobs.filter((job) => job.projectId === project.id)
          .map((job) => ({
            id: job.id,
            jobType: job.jobType,
            status: job.status,
            progress: job.progress,
            renderPlanHash: job.renderPlanHash,
            updatedAt: job.updatedAt
          }))
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      : [];
    const latestJob = jobs[0] || null;
    return {
      id: project.id,
      title: project.title,
      description: project.description,
      businessId: project.businessId,
      source: { ...clone(project.source), ...source },
      status: project.status,
      workflowStatus: source.status !== "available" ? "needs_relink" : latestJob?.status || (project.preparation ? "ready" : "draft"),
      progress: latestJob ? Math.max(0, Math.min(100, Number(latestJob.progress) || 0)) : project.preparation ? 75 : 0,
      favorite: project.favorite,
      tags: clone(project.tags),
      collectionId: project.collectionId,
      platforms: clone(project.platforms),
      desiredLengths: clone(project.desiredLengths),
      instructions: project.instructions,
      revision: project.revision,
      savedRevision: project.savedRevision,
      renderPlanHash: hashRenderPlan(project.draft),
      duration: project.draft.totalDuration,
      segmentCount: project.draft.segments.length,
      transcriptCount: project.draft.transcript.length,
      prepared: Boolean(project.preparation),
      versionCount: project.versions.length,
      jobs,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    };
  }

  query(options = {}) {
    const query = String(options.query || "")
      .trim()
      .toLowerCase()
      .slice(0, 200);
    const status = ["active", "archived"].includes(options.status) ? options.status : "";
    const sort = ["updated_desc", "created_desc", "title"].includes(options.sort) ? options.sort : "updated_desc";
    const collectionId = options.collectionId ? requireId(options.collectionId, "Project collection") : "";
    let projects = this.data.projects.filter((project) => {
      if (query && !`${project.title} ${project.description} ${project.tags.join(" ")}`.toLowerCase().includes(query)) return false;
      if (status && project.status !== status) return false;
      if (collectionId && project.collectionId !== collectionId) return false;
      return true;
    });
    projects = projects.sort((left, right) => {
      if (sort === "title") return left.title.localeCompare(right.title);
      if (sort === "created_desc") return Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return Number(right.favorite) - Number(left.favorite) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
    return {
      projects: projects.map((project) => this.summary(project)),
      collections: clone(this.data.collections),
      total: projects.length,
      notices: clone(this.notices)
    };
  }

  get(projectId) {
    requireId(projectId, "Project");
    const project = this.data.projects.find((item) => item.id === projectId);
    if (!project) throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
    return {
      ...this.summary(project),
      draft: clone(project.draft),
      preparation: clone(project.preparation || null),
      versions: clone(project.versions),
      activity: clone(project.activity),
      audit: clone(project.audit)
    };
  }

  async create(input) {
    const sourceMediaId = requireId(input?.sourceMediaId, "Project source");
    const clip = this.mediaLibrary.getClipSummary(sourceMediaId);
    if (clip.status !== "available" || !Number.isFinite(Number(clip.duration)) || Number(clip.duration) <= 0) {
      throw new AppError("SOURCE_UNAVAILABLE", "Choose an available Clip Library video.");
    }
    const now = new Date().toISOString();
    const collectionId = input?.collectionId ? requireId(input.collectionId, "Project collection") : null;
    if (collectionId && !this.data.collections.some((collection) => collection.id === collectionId)) {
      throw new AppError("PROJECT_COLLECTION_NOT_FOUND", "Project collection not found.");
    }
    const source = {
      mediaId: clip.id,
      name: clip.name,
      fingerprint: clip.fingerprint || crypto.createHash("sha256").update(clip.id).digest("hex"),
      duration: Number(Number(clip.duration).toFixed(3))
    };
    const project = {
      id: createId("project"),
      title: boundedString(input?.title, { label: "Project title", min: 1, max: 120, fallback: clip.name }),
      description: boundedString(input?.description, { label: "Project description", max: 1_000 }),
      businessId: input?.businessId ? requireId(input.businessId, "Business") : null,
      source,
      status: "active",
      favorite: false,
      tags: normalizeTags(input?.tags || []),
      collectionId,
      platforms: normalizePlatforms(input?.platforms || []),
      desiredLengths: Array.isArray(input?.desiredLengths)
        ? input.desiredLengths.slice(0, 5).map((item) => boundedString(item, { label: "Desired length", min: 1, max: 40 }))
        : [],
      instructions: boundedString(input?.instructions, { label: "Project instructions", max: 2_000 }),
      revision: 1,
      savedRevision: 1,
      draft: createInitialRenderPlan(source),
      preparation: null,
      versions: [],
      activity: [{ id: createId("activity"), type: "created", detail: "Created local project.", at: now }],
      audit: [],
      createdAt: now,
      updatedAt: now
    };
    project.versions.push({
      id: createId("version"),
      revision: 1,
      label: "Initial version",
      hash: hashRenderPlan(project.draft),
      savedAt: now,
      plan: clone(project.draft)
    });
    recordAudit(project, "project_created", "Created project metadata and its initial local render plan.");
    return this.enqueue(async () => {
      this.data.projects.unshift(project);
      this.persist();
      return this.get(project.id);
    });
  }

  exportDocument(projectId) {
    const project = this.data.projects.find((item) => item.id === requireId(projectId, "Project"));
    if (!project) throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
    const portableSourceId = "portable-source";
    return {
      format: "produdash-project",
      version: PROJECT_DOCUMENT_VERSION,
      project: {
        title: project.title,
        description: project.description,
        tags: clone(project.tags),
        platforms: clone(project.platforms),
        desiredLengths: clone(project.desiredLengths),
        instructions: project.instructions,
        source: {
          name: project.source.name,
          fingerprint: project.source.fingerprint,
          duration: project.source.duration
        },
        renderPlan: {
          ...clone(project.draft),
          sourceMediaId: portableSourceId
        }
      }
    };
  }

  async importDocument(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.format !== "produdash-project" ||
      value.version !== PROJECT_DOCUMENT_VERSION ||
      Object.keys(value).some((key) => !["format", "version", "project"].includes(key))
    ) {
      throw new AppError("INVALID_PROJECT_IMPORT", "The selected file is not a supported ProduDash project.");
    }
    try {
      assertNoPrivateFields(value);
    } catch {
      throw new AppError("INVALID_PROJECT_IMPORT", "Project imports cannot contain filesystem paths or private fields.");
    }
    const input = value.project;
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !["title", "description", "tags", "platforms", "desiredLengths", "instructions", "source", "renderPlan"].includes(key)
      )
    ) {
      throw new AppError("INVALID_PROJECT_IMPORT", "The imported project fields are invalid.");
    }
    const sourceName = boundedString(input.source?.name, { label: "Project source name", min: 1, max: 255 });
    const sourceDuration = Number(input.source?.duration);
    const fingerprint = String(input.source?.fingerprint || "");
    if (
      /[/\\]/.test(sourceName) ||
      !Number.isFinite(sourceDuration) ||
      sourceDuration <= 0 ||
      sourceDuration > 86_400 ||
      !/^[a-f0-9]{64}$/.test(fingerprint)
    ) {
      throw new AppError("INVALID_PROJECT_IMPORT", "The imported project source metadata is invalid.");
    }
    const sourceMediaId = `missing-${crypto.randomUUID()}`;
    const draft = normalizeRenderPlan({ ...input.renderPlan, sourceMediaId }, { sourceMediaId, sourceDuration });
    const now = new Date().toISOString();
    const project = {
      id: createId("project"),
      title: boundedString(input.title, { label: "Project title", min: 1, max: 120 }),
      description: boundedString(input.description, { label: "Project description", max: 1_000 }),
      businessId: null,
      source: { mediaId: sourceMediaId, name: sourceName, fingerprint, duration: Number(sourceDuration.toFixed(3)) },
      status: "active",
      favorite: false,
      tags: normalizeTags(input.tags || []),
      collectionId: null,
      platforms: normalizePlatforms(input.platforms || []),
      desiredLengths: (Array.isArray(input.desiredLengths) ? input.desiredLengths : [])
        .slice(0, 5)
        .map((item) => boundedString(item, { label: "Desired length", min: 1, max: 40 })),
      instructions: boundedString(input.instructions, { label: "Project instructions", max: 2_000 }),
      revision: 1,
      savedRevision: 1,
      draft,
      preparation: null,
      versions: [
        {
          id: createId("version"),
          revision: 1,
          label: "Imported version",
          hash: hashRenderPlan(draft),
          savedAt: now,
          plan: clone(draft)
        }
      ],
      activity: [
        {
          id: createId("activity"),
          type: "imported",
          detail: "Imported portable project metadata. Source relinking is required.",
          at: now
        }
      ],
      audit: [],
      createdAt: now,
      updatedAt: now
    };
    recordAudit(project, "project_imported", "Imported a path-free project document with a missing source.");
    return this.enqueue(async () => {
      this.data.projects.unshift(project);
      this.persist();
      return this.get(project.id);
    });
  }

  async update(projectId, input) {
    return this.enqueue(async () => {
      const project = this.data.projects.find((item) => item.id === requireId(projectId, "Project"));
      if (!project) throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
      const allowed = new Set([
        "title",
        "description",
        "businessId",
        "favorite",
        "tags",
        "collectionId",
        "platforms",
        "desiredLengths",
        "instructions"
      ]);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))) {
        throw new AppError("INVALID_INPUT", "The project update is invalid.");
      }
      if (Object.hasOwn(input, "title")) project.title = boundedString(input.title, { label: "Project title", min: 1, max: 120 });
      if (Object.hasOwn(input, "description"))
        project.description = boundedString(input.description, { label: "Project description", max: 1_000 });
      if (Object.hasOwn(input, "businessId")) project.businessId = input.businessId ? requireId(input.businessId, "Business") : null;
      if (Object.hasOwn(input, "favorite")) project.favorite = input.favorite === true;
      if (Object.hasOwn(input, "tags")) project.tags = normalizeTags(input.tags);
      if (Object.hasOwn(input, "collectionId")) {
        const collectionId = input.collectionId ? requireId(input.collectionId, "Project collection") : null;
        if (collectionId && !this.data.collections.some((collection) => collection.id === collectionId)) {
          throw new AppError("PROJECT_COLLECTION_NOT_FOUND", "Project collection not found.");
        }
        project.collectionId = collectionId;
      }
      if (Object.hasOwn(input, "platforms")) project.platforms = normalizePlatforms(input.platforms);
      if (Object.hasOwn(input, "desiredLengths")) {
        if (!Array.isArray(input.desiredLengths) || input.desiredLengths.length > 5) {
          throw new AppError("INVALID_INPUT", "Desired lengths must be a short list.");
        }
        project.desiredLengths = input.desiredLengths.map((item) => boundedString(item, { label: "Desired length", min: 1, max: 40 }));
      }
      if (Object.hasOwn(input, "instructions"))
        project.instructions = boundedString(input.instructions, { label: "Project instructions", max: 2_000 });
      project.updatedAt = new Date().toISOString();
      recordAudit(project, "metadata_updated", "Updated bounded project metadata.");
      this.persist();
      return this.get(project.id);
    });
  }

  async saveDraft(projectId, value, expectedRevision) {
    return this.enqueue(async () => {
      const project = this.data.projects.find((item) => item.id === requireId(projectId, "Project"));
      if (!project) throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
      if (expectedRevision !== undefined && Number(expectedRevision) !== project.revision) {
        throw new AppError("PROJECT_REVISION_CONFLICT", "This project changed in another operation. Reload it before saving.");
      }
      project.draft = normalizeRenderPlan(value, {
        sourceMediaId: project.source.mediaId,
        sourceDuration: project.source.duration
      });
      project.revision += 1;
      project.updatedAt = new Date().toISOString();
      recordAudit(project, "draft_saved", `Saved recoverable draft revision ${project.revision}.`);
      this.persist();
      return this.get(project.id);
    });
  }

  async replaceTranscript(projectId, transcript) {
    const project = this.get(projectId);
    if (project.draft.localization?.variants?.length) {
      throw new AppError(
        "LOCALIZATION_DEPENDENCY_EXISTS",
        "Remove existing language variants before replacing the complete source transcript."
      );
    }
    return this.saveDraft(
      projectId,
      {
        ...project.draft,
        transcript
      },
      project.revision
    );
  }

  async applyTemplate(projectId, template) {
    if (!template || typeof template !== "object") throw new AppError("TEMPLATE_NOT_FOUND", "Brand template not found.");
    return this.enqueue(async () => {
      const project = this.data.projects.find((item) => item.id === requireId(projectId, "Project"));
      if (!project) throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
      const duration = project.draft.totalDuration;
      const templateOverlays = Array.isArray(template.settings?.composition?.overlays)
        ? template.settings.composition.overlays.map((overlay, index) => ({
            id: `template-${template.id}-${index + 1}`,
            type: overlay.type,
            ...(overlay.type === "logo" ? { assetId: overlay.assetId } : { text: overlay.text }),
            start: Number((duration * overlay.startRatio).toFixed(3)),
            end: Number((duration * overlay.endRatio).toFixed(3)),
            x: overlay.x,
            y: overlay.y,
            width: overlay.width,
            opacity: overlay.opacity,
            ...(overlay.type === "logo"
              ? {}
              : {
                  fontScale: overlay.fontScale,
                  textColor: overlay.textColor,
                  backgroundColor: overlay.backgroundColor
                })
          }))
        : [];
      project.draft = normalizeRenderPlan(
        {
          ...project.draft,
          templateRef: { id: template.id, version: template.version, hash: template.hash },
          presentation: { ...project.draft.presentation, ...template.settings.presentation },
          composition: {
            ...project.draft.composition,
            ...template.settings.composition,
            music: template.settings.composition.music ? { ...template.settings.composition.music, start: 0, end: duration } : null,
            overlays: templateOverlays
          }
        },
        { sourceMediaId: project.source.mediaId, sourceDuration: project.source.duration }
      );
      project.revision += 1;
      project.updatedAt = new Date().toISOString();
      project.activity.unshift({
        id: createId("activity"),
        type: "template_applied",
        detail: `Applied ${template.name} version ${template.version} as a local composition snapshot.`,
        at: project.updatedAt
      });
      project.activity = project.activity.slice(0, 200);
      recordAudit(project, "template_applied", `Applied immutable template ${template.id} version ${template.version}.`);
      this.persist();
      return this.get(project.id);
    });
  }

  async setPreparation(projectId, value) {
    return this.enqueue(async () => {
      const project = this.data.projects.find((item) => item.id === requireId(projectId, "Project"));
      if (!project) throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
      const boundedNumbers = (items, limit) =>
        (Array.isArray(items) ? items : [])
          .map(Number)
          .filter((item) => Number.isFinite(item) && item >= 0 && item <= project.source.duration)
          .slice(0, limit);
      project.preparation = {
        scenes: boundedNumbers(value?.scenes, 1_000),
        waveform: boundedNumbers(value?.waveform, 500).map((item) => Math.min(1, item)),
        preparedAt: new Date().toISOString()
      };
      project.updatedAt = project.preparation.preparedAt;
      recordAudit(project, "preparation_saved", "Saved local waveform and scene preparation metadata.");
      this.persist();
      return this.get(project.id);
    });
  }

  async createFromMediaJob(job, candidateId) {
    if (!job || job.jobType !== "clip_generation") {
      throw new AppError("INVALID_INPUT", "Only an existing clip-generation job can become a project.");
    }
    const candidate = job.candidates.find((item) => item.id === requireId(candidateId, "Clip candidate"));
    if (!candidate) throw new AppError("CANDIDATE_NOT_FOUND", "Clip candidate not found.");
    const edit = candidate.edit || candidate;
    const created = await this.create({
      sourceMediaId: job.sourceMediaId,
      title: edit.title || candidate.title,
      description: `Created from ${job.title}.`,
      platforms: job.settings?.platforms || [],
      instructions: job.goal || ""
    });
    const transcript = (Array.isArray(edit.captionSegments) ? edit.captionSegments : []).map((segment, index) => ({
      id: `transcript-${index + 1}`,
      start: Number((Number(edit.start ?? candidate.start) + Number(segment.start)).toFixed(3)),
      end: Number((Number(edit.start ?? candidate.start) + Number(segment.end)).toFixed(3)),
      text: segment.text,
      speaker: ""
    }));
    if (!transcript.length && edit.manualCaptionText) {
      transcript.push({
        id: "transcript-1",
        start: Number(edit.start ?? candidate.start),
        end: Number(edit.end ?? candidate.end),
        text: edit.manualCaptionText,
        speaker: ""
      });
    }
    return this.saveDraft(
      created.id,
      {
        ...created.draft,
        segments: [
          {
            id: "segment-1",
            sourceStart: Number(edit.start ?? candidate.start),
            sourceEnd: Number(edit.end ?? candidate.end)
          }
        ],
        transcript,
        presentation: {
          targetAspect: edit.targetAspect || job.settings?.targetAspect,
          aspectTreatment: edit.aspectTreatment || job.settings?.aspectTreatment,
          captionMode: job.settings?.captionMode,
          captionStyle: edit.captionStyle,
          captionPosition: edit.captionPosition,
          captionSafeArea: edit.captionSafeArea
        }
      },
      created.revision
    );
  }

  async commitVersion(projectId, label = "") {
    return this.enqueue(async () => {
      const project = this.data.projects.find((item) => item.id === requireId(projectId, "Project"));
      if (!project) throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
      const now = new Date().toISOString();
      project.savedRevision = project.revision;
      project.versions.push({
        id: createId("version"),
        revision: project.revision,
        label: boundedString(label, { label: "Version label", max: 120, fallback: `Version ${project.versions.length + 1}` }),
        hash: hashRenderPlan(project.draft),
        savedAt: now,
        plan: clone(project.draft)
      });
      project.versions = project.versions.slice(-VERSION_LIMIT);
      project.activity.unshift({ id: createId("activity"), type: "saved", detail: "Saved an explicit project version.", at: now });
      project.activity = project.activity.slice(0, 200);
      project.updatedAt = now;
      recordAudit(project, "version_committed", `Committed immutable project version at revision ${project.revision}.`);
      this.persist();
      return this.get(project.id);
    });
  }

  async restoreVersion(projectId, versionId) {
    return this.enqueue(async () => {
      const project = this.data.projects.find((item) => item.id === requireId(projectId, "Project"));
      if (!project) throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
      const version = project.versions.find((item) => item.id === requireId(versionId, "Project version"));
      if (!version) throw new AppError("PROJECT_VERSION_NOT_FOUND", "Project version not found.");
      project.draft = clone(version.plan);
      project.revision += 1;
      project.updatedAt = new Date().toISOString();
      project.activity.unshift({
        id: createId("activity"),
        type: "restored",
        detail: `Restored ${version.label} as a new draft revision.`,
        at: project.updatedAt
      });
      recordAudit(project, "version_restored", `Restored a saved version as draft revision ${project.revision}.`);
      this.persist();
      return this.get(project.id);
    });
  }

  async setStatus(projectId, status) {
    if (!["active", "archived"].includes(status)) throw new AppError("INVALID_INPUT", "Project status is invalid.");
    return this.enqueue(async () => {
      const project = this.data.projects.find((item) => item.id === requireId(projectId, "Project"));
      if (!project) throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
      if (project.status === status) return this.get(project.id);
      project.status = status;
      project.updatedAt = new Date().toISOString();
      recordAudit(project, "status_changed", `Changed project status to ${status}.`);
      this.persist();
      return this.get(project.id);
    });
  }

  async recordRenderApproval(projectId, jobId, planHash) {
    return this.enqueue(async () => {
      const project = this.data.projects.find((item) => item.id === requireId(projectId, "Project"));
      if (!project) throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
      requireId(jobId, "Media job");
      if (!/^[a-f0-9]{64}$/.test(String(planHash || ""))) {
        throw new AppError("INVALID_RENDER_PLAN", "The approved project revision hash is invalid.");
      }
      const at = new Date().toISOString();
      project.activity.unshift({
        id: createId("activity"),
        type: "render_approved",
        detail: "Approved an immutable project revision for local rendering.",
        at
      });
      project.activity = project.activity.slice(0, 200);
      recordAudit(project, "render_approved", `Approved revision ${project.revision} for local media job ${jobId}.`);
      project.updatedAt = at;
      this.persist();
      return this.get(project.id);
    });
  }

  async duplicate(projectId) {
    return this.enqueue(async () => {
      const original = this.data.projects.find((item) => item.id === requireId(projectId, "Project"));
      if (!original) throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
      const now = new Date().toISOString();
      const duplicatedPlan = clone(original.draft);
      if (duplicatedPlan.localization) duplicatedPlan.localization.voiceovers = [];
      const project = {
        ...clone(original),
        id: createId("project"),
        title: `${original.title} copy`.slice(0, 120),
        status: "active",
        favorite: false,
        revision: 1,
        savedRevision: 1,
        draft: duplicatedPlan,
        preparation: null,
        versions: [
          {
            id: createId("version"),
            revision: 1,
            label: "Duplicated version",
            hash: hashRenderPlan(duplicatedPlan),
            savedAt: now,
            plan: clone(duplicatedPlan)
          }
        ],
        activity: [{ id: createId("activity"), type: "created", detail: "Created as an independent local duplicate.", at: now }],
        audit: [],
        createdAt: now,
        updatedAt: now
      };
      recordAudit(project, "project_duplicated", "Created this project as an independent local duplicate.");
      this.data.projects.unshift(project);
      this.persist();
      return this.get(project.id);
    });
  }

  async remove(projectId) {
    return this.enqueue(async () => {
      const id = requireId(projectId, "Project");
      const index = this.data.projects.findIndex((item) => item.id === id);
      if (index < 0) throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
      this.data.projects.splice(index, 1);
      this.persist();
      if (this.appStore?.detachProjectMediaJobs) await this.appStore.detachProjectMediaJobs(id);
      return this.query({});
    });
  }

  async createCollection(name) {
    return this.enqueue(async () => {
      const collection = {
        id: createId("collection"),
        name: boundedString(name, { label: "Collection name", min: 1, max: 80 }),
        createdAt: new Date().toISOString()
      };
      this.data.collections.push(collection);
      this.persist();
      return this.query({});
    });
  }

  async relink(projectId, sourceMediaId) {
    const clip = this.mediaLibrary.getClipSummary(requireId(sourceMediaId, "Project source"));
    if (clip.status !== "available" || !Number.isFinite(Number(clip.duration))) {
      throw new AppError("SOURCE_UNAVAILABLE", "Choose an available Clip Library video.");
    }
    return this.enqueue(async () => {
      const project = this.data.projects.find((item) => item.id === requireId(projectId, "Project"));
      if (!project) throw new AppError("PROJECT_NOT_FOUND", "Project not found.");
      if (Math.abs(Number(clip.duration) - Number(project.source.duration)) > 0.25) {
        throw new AppError("SOURCE_MISMATCH", "The replacement source duration does not match this project.");
      }
      const replacementFingerprint = clip.fingerprint || crypto.createHash("sha256").update(clip.id).digest("hex");
      if (replacementFingerprint !== project.source.fingerprint) {
        throw new AppError("SOURCE_MISMATCH", "The replacement source fingerprint does not match this project.");
      }
      project.source.mediaId = clip.id;
      project.source.name = clip.name;
      project.draft.sourceMediaId = clip.id;
      project.versions = project.versions.map((version) => {
        const plan = { ...version.plan, sourceMediaId: clip.id };
        return { ...version, plan, hash: hashRenderPlan(plan) };
      });
      project.updatedAt = new Date().toISOString();
      recordAudit(project, "source_relinked", "Relinked the project to an exact fingerprint-matched Library source.");
      this.persist();
      return this.get(project.id);
    });
  }

  async clear({ removeFiles = false } = {}) {
    return this.enqueue(async () => {
      this.data = emptyStore();
      if (removeFiles) {
        for (const entry of fs.readdirSync(this.userDataPath, { withFileTypes: true })) {
          if (
            entry.isFile() &&
            (entry.name === path.basename(this.filePath) || entry.name.startsWith(`${path.basename(this.filePath)}.`))
          ) {
            fs.unlinkSync(path.join(this.userDataPath, entry.name));
          }
        }
      }
      this.persist();
      return this.query({});
    });
  }

  async clearPreparation() {
    return this.enqueue(async () => {
      for (const project of this.data.projects) {
        project.preparation = null;
        if (project.draft.localization?.voiceovers?.length) {
          project.draft.localization.voiceovers = [];
          project.revision += 1;
        }
        recordAudit(project, "preparation_cleared", "Dashboard reset cleared local preparation metadata; project edits were retained.");
      }
      this.persist();
      await fs.promises.rm(path.join(this.userDataPath, "project-cache"), { recursive: true, force: true });
      return this.query({});
    });
  }
}

module.exports = {
  PROJECT_DOCUMENT_VERSION,
  PROJECT_STORE_VERSION,
  ProjectStore,
  VERSION_LIMIT,
  emptyStore,
  loadProjectStore,
  validateProjectStore
};
