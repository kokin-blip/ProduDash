const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createDirectory } = require("./helpers.cjs");
const { ProjectStore, VERSION_LIMIT } = require("../electron/projects/project-store.cjs");
const { createInitialRenderPlan, hashRenderPlan, normalizeRenderPlan, rebaseTranscript } = require("../electron/projects/render-plan.cjs");
const { TemplateStore, TEMPLATE_VERSION_LIMIT } = require("../electron/projects/template-store.cjs");
const { parseTranscriptText } = require("../electron/projects/transcript-import.cjs");
const { buildProjectRenderArgs } = require("../electron/media/media-worker.cjs");

function harness() {
  const directory = createDirectory("produdash-projects-");
  const clips = new Map([
    [
      "media-source",
      {
        id: "media-source",
        name: "Source.mp4",
        status: "available",
        duration: 60,
        previewable: true
      }
    ]
  ]);
  const jobs = [];
  const mediaLibrary = {
    getClipSummary(id) {
      const clip = clips.get(id);
      if (!clip) throw new Error("missing");
      return structuredClone(clip);
    }
  };
  const appStore = {
    getAppState: () => ({ mediaJobs: structuredClone(jobs) }),
    detachProjectMediaJobs: async (projectId) => {
      for (const job of jobs) if (job.projectId === projectId) job.projectId = null;
    }
  };
  const projects = new ProjectStore(directory, { mediaLibrary, appStore });
  return { directory, clips, jobs, mediaLibrary, appStore, projects };
}

test("Projects persist atomically with lifecycle, drafts, versions, recovery, and no paths", async (t) => {
  const context = harness();
  t.after(() => fs.rmSync(context.directory, { recursive: true, force: true }));
  const created = await context.projects.create({
    sourceMediaId: "media-source",
    title: "Local launch",
    description: "One source",
    tags: ["launch"],
    platforms: ["youtube"]
  });
  assert.equal(created.source.previewUrl, "produdash-media://clip/media-source");
  assert.equal(created.draft.segments.length, 1);
  assert.equal(created.draft.totalDuration, 60);
  assert.doesNotMatch(JSON.stringify(created), /\/Users\/|sourcePath|outputPath/);

  const editedPlan = normalizeRenderPlan(
    {
      ...created.draft,
      segments: [
        { id: "segment-a", sourceStart: 2, sourceEnd: 12 },
        { id: "segment-b", sourceStart: 30, sourceEnd: 42 }
      ]
    },
    { sourceMediaId: "media-source", sourceDuration: 60 }
  );
  const edited = await context.projects.saveDraft(created.id, editedPlan, created.revision);
  assert.equal(edited.revision, 2);
  assert.equal(edited.draft.segments[1].timelineStart, 10);
  const saved = await context.projects.commitVersion(created.id, "Approved structure");
  assert.equal(saved.savedRevision, 2);
  assert.equal(saved.versions.at(-1).label, "Approved structure");

  for (let index = 0; index < VERSION_LIMIT + 2; index += 1) {
    await context.projects.commitVersion(created.id, `Version ${index}`);
  }
  assert.equal(context.projects.get(created.id).versions.length, VERSION_LIMIT);
  await context.projects.update(created.id, { favorite: true, tags: ["launch", "local"] });
  assert.equal(context.projects.query({ query: "local" }).projects.length, 1);
  await context.projects.setStatus(created.id, "archived");
  assert.equal(context.projects.query({ status: "archived" }).projects.length, 1);

  fs.writeFileSync(path.join(context.directory, "produdash-projects.json"), "{bad");
  const recovered = new ProjectStore(context.directory, { mediaLibrary: context.mediaLibrary, appStore: context.appStore });
  assert.ok(recovered.getNotices().some((notice) => notice.code === "PROJECTS_RECOVERED"));
  assert.equal(recovered.query({}).projects.length, 1);
  assert.ok(fs.readdirSync(context.directory).some((name) => name.startsWith("produdash-projects.json.recovery-")));

  context.jobs.push({ id: "media-job", projectId: created.id });
  await recovered.remove(created.id);
  assert.equal(context.jobs[0].projectId, null);
});

test("project stores block future versions and relink only an exact safe source fingerprint", async (t) => {
  const context = harness();
  t.after(() => fs.rmSync(context.directory, { recursive: true, force: true }));
  context.clips.get("media-source").fingerprint = "a".repeat(64);
  const created = await context.projects.create({ sourceMediaId: "media-source", title: "Relink safety" });
  context.clips.set("media-match", {
    ...context.clips.get("media-source"),
    id: "media-match",
    name: "Renamed source.mp4"
  });
  const relinked = await context.projects.relink(created.id, "media-match");
  assert.equal(relinked.source.mediaId, "media-match");
  assert.equal(relinked.draft.sourceMediaId, "media-match");
  assert.ok(relinked.versions.every((version) => version.plan.sourceMediaId === "media-match"));
  context.clips.set("media-wrong", {
    ...context.clips.get("media-source"),
    id: "media-wrong",
    fingerprint: "b".repeat(64)
  });
  await assert.rejects(context.projects.relink(created.id, "media-wrong"), { code: "SOURCE_MISMATCH" });

  const futureDirectory = createDirectory("produdash-project-future-");
  t.after(() => fs.rmSync(futureDirectory, { recursive: true, force: true }));
  const futurePath = path.join(futureDirectory, "produdash-projects.json");
  const futureText = JSON.stringify({ schemaVersion: 99, projects: [], collections: [] });
  fs.writeFileSync(futurePath, futureText);
  assert.throws(
    () => new ProjectStore(futureDirectory, { mediaLibrary: context.mediaLibrary, appStore: context.appStore }),
    (error) => error.code === "FUTURE_PROJECT_STORE"
  );
  assert.equal(fs.readFileSync(futurePath, "utf8"), futureText);
});

test("render plans validate multi-segment edits and rebase imported captions", () => {
  const initial = createInitialRenderPlan({ mediaId: "media-source", duration: 60 });
  const transcript = parseTranscriptText(
    `1\n00:00:02,000 --> 00:00:05,000\nFirst cue\n\n2\n00:00:31.000 --> 00:00:34.000\n<script>alert(1)</script> Second cue`,
    "srt",
    60
  );
  const plan = normalizeRenderPlan(
    {
      ...initial,
      segments: [
        { id: "segment-a", sourceStart: 1, sourceEnd: 10 },
        { id: "segment-b", sourceStart: 30, sourceEnd: 40 }
      ],
      transcript,
      intelligentTracks: {
        subject: [
          {
            id: "subject-reviewed",
            start: 0,
            end: 19,
            reviewed: true,
            mode: "keyframes",
            keyframes: [{ at: 0, x: 0.25, y: 0.5, scale: 1, confidence: 1 }]
          }
        ],
        audio: [
          {
            id: "audio-reviewed",
            start: 0,
            end: 19,
            reviewed: true,
            preset: "voice_cleanup",
            strength: 0.6
          }
        ]
      },
      localization: {
        sourceLanguage: "en-US",
        activeVariantId: "language-es",
        variants: [
          {
            id: "language-es",
            language: "es-MX",
            label: "Spanish (Mexico)",
            status: "reviewed",
            cues: [
              { sourceId: "transcript-1", text: "Primer corte" },
              { sourceId: "transcript-2", text: "Segundo corte" }
            ],
            provenance: { source: "manual" }
          }
        ]
      }
    },
    { sourceMediaId: "media-source", sourceDuration: 60 }
  );
  assert.equal(plan.totalDuration, 19);
  assert.equal(plan.transcript[1].text, "alert(1) Second cue");
  assert.deepEqual(
    rebaseTranscript(plan).map((cue) => [cue.start, cue.end]),
    [
      [1, 4],
      [10, 13]
    ]
  );
  assert.match(hashRenderPlan(plan), /^[a-f0-9]{64}$/);
  assert.equal(plan.version, 6);
  assert.equal(plan.intelligentTracks.subject[0].keyframes[0].x, 0.25);
  assert.equal(plan.intelligentTracks.audio[0].preset, "voice_cleanup");
  assert.deepEqual(plan.intelligentTracks.broll, []);
  assert.deepEqual(plan.intelligentTracks.sfx, []);
  assert.equal(plan.localization.activeVariantId, "language-es");
  assert.deepEqual(
    rebaseTranscript(plan).map((cue) => cue.text),
    ["Primer corte", "Segundo corte"]
  );
  assert.deepEqual(plan.composition.overlays, []);
  assert.equal(plan.presentation.captionScale, 1);
  assert.deepEqual(plan.presentation.enhancement, { mode: "off", reviewed: false });
  assert.throws(
    () =>
      normalizeRenderPlan(
        { ...plan, segments: [{ id: "segment-a", sourceStart: -1, sourceEnd: 2 }] },
        { sourceMediaId: "media-source", sourceDuration: 60 }
      ),
    /inside the source/
  );
  assert.throws(
    () =>
      normalizeRenderPlan(
        {
          ...plan,
          intelligentTracks: {
            ...plan.intelligentTracks,
            broll: [
              {
                id: "broll-one",
                start: 0,
                end: 4,
                mediaId: "media-broll",
                sourceStart: 0,
                sourceEnd: 4,
                provenance: { source: "generated", mediaId: "media-broll", fingerprint: "a".repeat(64) }
              }
            ]
          }
        },
        { sourceMediaId: "media-source", sourceDuration: 60 }
      ),
    /user-owned Library source/
  );
  assert.throws(
    () =>
      normalizeRenderPlan(
        {
          ...plan,
          localization: {
            ...plan.localization,
            variants: plan.localization.variants.map((variant) => ({ ...variant, status: "draft" }))
          }
        },
        { sourceMediaId: "media-source", sourceDuration: 60 }
      ),
    /Only a reviewed language variant/
  );
});

test("brand templates persist versions, recover, import safely, and apply immutable snapshots", async (t) => {
  const context = harness();
  t.after(() => fs.rmSync(context.directory, { recursive: true, force: true }));
  const templates = new TemplateStore(context.directory);
  const created = await templates.create({
    name: "Launch brand",
    description: "Vertical launch treatment",
    settings: {
      presentation: {
        targetAspect: "vertical",
        aspectTreatment: "fit_pad",
        captionMode: "srt_burned",
        captionStyle: "brand",
        captionTextColor: "#ffffff",
        captionBackgroundColor: "#101214"
      },
      composition: {
        transition: "fade",
        transitionDuration: 0.2,
        backgroundColor: "#101214",
        overlays: [
          {
            id: "launch-cta",
            type: "cta",
            text: "Shop the launch",
            startRatio: 0.7,
            endRatio: 1,
            y: 0.82
          }
        ]
      }
    }
  });
  assert.equal(created.version, 1);
  assert.match(created.hash, /^[a-f0-9]{64}$/);
  const project = await context.projects.create({ sourceMediaId: "media-source", title: "Template target" });
  const applied = await context.projects.applyTemplate(project.id, created);
  assert.deepEqual(applied.draft.templateRef, { id: created.id, version: 1, hash: created.hash });
  assert.equal(applied.draft.composition.overlays[0].start, 42);
  assert.equal(applied.draft.composition.overlays[0].end, 60);
  const portable = context.projects.exportDocument(project.id);
  assert.doesNotMatch(JSON.stringify(portable), /\/Users\/|sourcePath|outputPath|bookmark|credential/);
  const importedProject = await context.projects.importDocument({
    ...portable,
    project: { ...portable.project, title: "Imported project" }
  });
  assert.equal(importedProject.source.status, "missing");
  assert.equal(importedProject.workflowStatus, "needs_relink");
  assert.equal(importedProject.draft.version, 6);
  await assert.rejects(
    context.projects.importDocument({ ...portable, project: { ...portable.project, sourcePath: "/Users/private/source.mp4" } }),
    (error) => error.code === "INVALID_PROJECT_IMPORT"
  );

  let updated = created;
  for (let index = 0; index < TEMPLATE_VERSION_LIMIT + 2; index += 1) {
    updated = await templates.update(created.id, {
      name: "Launch brand",
      settings: { ...updated.settings, composition: { ...updated.settings.composition, transitionDuration: 0.2 + index / 100 } }
    });
  }
  assert.equal(updated.versions.length, TEMPLATE_VERSION_LIMIT);
  assert.equal(applied.draft.templateRef.version, 1);

  const document = templates.exportDocument(created.id);
  const imported = await templates.importDocument({ ...document, name: "Imported launch brand" });
  assert.equal(imported.name, "Imported launch brand");
  await assert.rejects(
    templates.importDocument({ ...document, path: "/Users/private/template.json" }),
    (error) => error.code === "INVALID_TEMPLATE_IMPORT"
  );

  fs.writeFileSync(path.join(context.directory, "produdash-templates.json"), "{bad");
  const recovered = new TemplateStore(context.directory);
  assert.ok(recovered.getNotices().some((notice) => notice.code === "TEMPLATES_RECOVERED"));
});

test("render-plan v2 validates composition bounds and escapes into shell-free filters", () => {
  const plan = normalizeRenderPlan(
    {
      version: 1,
      sourceMediaId: "media-source",
      segments: [
        { id: "one", sourceStart: 0, sourceEnd: 10 },
        { id: "two", sourceStart: 20, sourceEnd: 30 }
      ],
      presentation: { targetAspect: "vertical", captionStyle: "brand", captionScale: 1.2 },
      composition: {
        transition: "fade",
        transitionDuration: 0.25,
        backgroundColor: "#101214",
        overlays: [
          {
            id: "overlay-one",
            type: "cta",
            text: "Shop 'now': 50%",
            start: 2,
            end: 18,
            x: 0.5,
            y: 0.82,
            width: 0.7,
            opacity: 1,
            fontScale: 1,
            textColor: "#ffffff",
            backgroundColor: "#101214"
          }
        ]
      }
    },
    { sourceMediaId: "media-source", sourceDuration: 60 }
  );
  const args = buildProjectRenderArgs({
    sourcePath: "/private/source.mp4",
    outputPath: "/private/output.mp4",
    candidate: { duration: 20, segments: plan.segments },
    settings: { ...plan.presentation, composition: plan.composition },
    hasAudio: true
  });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /fade=t=in/);
  assert.match(graph, /drawtext=/);
  assert.equal(graph.includes(";sh"), false);
  assert.equal(graph.includes("$("), false);
  assert.throws(
    () =>
      normalizeRenderPlan(
        {
          ...plan,
          composition: {
            ...plan.composition,
            overlays: [{ ...plan.composition.overlays[0], end: 99 }]
          }
        },
        { sourceMediaId: "media-source", sourceDuration: 60 }
      ),
    /outside the supported range/
  );
});

test("project rendering uses a shell-free multi-segment FFmpeg filter graph", () => {
  const args = buildProjectRenderArgs({
    sourcePath: "/private/source.mp4",
    outputPath: "/private/output.mp4",
    candidate: {
      duration: 20,
      segments: [
        { sourceStart: 1, sourceEnd: 11 },
        { sourceStart: 30, sourceEnd: 40 }
      ]
    },
    settings: { targetAspect: "vertical", aspectTreatment: "fit_pad" },
    hasAudio: true
  });
  assert.ok(args.includes("-filter_complex"));
  assert.match(args[args.indexOf("-filter_complex") + 1], /concat=n=2:v=1:a=1/);
  assert.equal(args.includes("sh"), false);
  assert.equal(args.includes("-c:v"), true);
});

test("renderer project operations preserve source timing and ripple timeline positions", async () => {
  const editor = await import("../src/renderer/project-editor.js");
  const plan = normalizeRenderPlan(
    {
      sourceMediaId: "media-source",
      segments: [{ id: "segment-a", sourceStart: 0, sourceEnd: 20 }],
      transcript: [],
      markers: [],
      comments: []
    },
    { sourceMediaId: "media-source", sourceDuration: 60 }
  );
  const split = editor.splitSegment(plan, "segment-a", 8);
  assert.deepEqual(
    split.segments.map((segment) => [segment.sourceStart, segment.sourceEnd, segment.timelineStart]),
    [
      [0, 8, 0],
      [8, 20, 8]
    ]
  );
  const moved = editor.moveSegment(split, split.segments[1].id, -1);
  assert.deepEqual(
    moved.segments.map((segment) => segment.sourceStart),
    [8, 0]
  );
  const duplicated = editor.duplicateSegment(moved, moved.segments[0].id);
  assert.equal(duplicated.segments.length, 3);
  const deleted = editor.deleteSegment(duplicated, duplicated.segments[1].id);
  assert.equal(deleted.segments[1].timelineStart, deleted.segments[0].duration);
});
