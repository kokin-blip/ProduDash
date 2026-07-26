const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { getMediaBinaries } = require("../electron/media/binaries.cjs");
const {
  buildProjectRenderArgs,
  buildRenderArgs,
  createContext,
  generateCandidates,
  parseProgressBlock,
  runMediaTask,
  safeOutputName
} = require("../electron/media/media-worker.cjs");
const { createDirectory } = require("./helpers.cjs");

test("media worker helpers generate bounded candidates and shell-free argument arrays", () => {
  const candidates = generateCandidates({ duration: 45, scenes: [10, 20], targetDuration: 12, maxClips: 3 });
  assert.ok(candidates.length >= 3 && candidates.length <= 9);
  assert.ok(candidates.every((candidate) => candidate.duration >= 5 && candidate.duration <= 180));
  assert.ok(candidates.every((candidate) => candidate.start >= 0 && candidate.end <= 45));
  assert.equal(safeOutputName("../../ Launch! "), "launch");
  assert.equal(parseProgressBlock("out_time=00:00:05.000000\n", 10), 0.5);
  const args = buildRenderArgs({
    sourcePath: "/source.mp4",
    outputPath: "/output.mp4",
    candidate: candidates[0],
    settings: { targetAspect: "vertical", aspectTreatment: "fit_pad" },
    hasAudio: true
  });
  assert.deepEqual(args.slice(0, 5), ["-nostdin", "-y", "-ss", "0.000", "-i"]);
  assert.ok(args.includes("libx264"));
  assert.equal(args.includes("-shell"), false);
  const projectArgs = buildProjectRenderArgs({
    sourcePath: "/source.mp4",
    outputPath: "/output.mp4",
    candidate: {
      duration: 5,
      segments: [{ sourceStart: 0, sourceEnd: 5 }]
    },
    settings: {
      targetAspect: "vertical",
      aspectTreatment: "center_crop",
      composition: { overlays: [], music: null },
      intelligentTracks: {
        subject: [{ reviewed: true, keyframes: [{ x: 0.2, y: 0.7 }] }],
        audio: [{ reviewed: true, start: 0, end: 5, preset: "balanced", strength: 0.5 }]
      }
    },
    hasAudio: true
  });
  const filterGraph = projectArgs[projectArgs.indexOf("-filter_complex") + 1];
  assert.match(filterGraph, /crop=720:1280:\(iw-ow\)\*0\.200:\(ih-oh\)\*0\.700/);
  assert.match(filterGraph, /\[acat\]acompressor=.*\[aenhance0\]/);
});

test("Smart local cuts rank the full deterministic pool, penalize silence, and diversify selections", () => {
  const input = {
    duration: 120,
    scenes: [12, 28, 55, 82, 104],
    silences: [
      { start: 0, end: 8 },
      { start: 28, end: 40 },
      { start: 89, end: 92 }
    ],
    transcriptBoundaries: [12, 24, 55, 69, 104, 118],
    targetDuration: 14,
    maxClips: 4
  };
  const first = generateCandidates(input);
  const second = generateCandidates(input);
  assert.deepEqual(first, second);
  assert.ok(first.length >= 4 && first.length <= 12);
  assert.ok(new Set(first.map((candidate) => candidate.duration)).size >= 2);
  assert.ok(first.every((candidate) => candidate.scores.goalRelevance === 0));
  assert.ok(first.every((candidate) => /Semantic goal relevance was not scored/.test(candidate.rationale)));
  assert.ok(new Set(first.map((candidate) => Math.floor(candidate.start / 30))).size >= 3);
  for (let left = 0; left < first.length; left += 1) {
    for (let right = left + 1; right < first.length; right += 1) {
      const overlap = Math.max(0, Math.min(first[left].end, first[right].end) - Math.max(first[left].start, first[right].start));
      assert.ok(overlap <= Math.min(first[left].duration, first[right].duration) * 0.2);
    }
  }
  const quiet = generateCandidates({
    duration: 40,
    scenes: [],
    silences: [{ start: 0, end: 20 }],
    targetDuration: 10,
    maxClips: 1
  })[0];
  assert.ok(quiet.start >= 20);
  assert.equal(generateCandidates({ duration: 5, targetDuration: 30, maxClips: 3 }).length, 1);
});

test(
  "real bundled media tools analyze, render H.264/AAC, write safe artifacts, and never overwrite",
  { timeout: 60_000 },
  async (context) => {
    const directory = createDirectory("produdash-worker-");
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { ffmpegPath, ffprobePath } = getMediaBinaries();
    const sourcePath = path.join(directory, "source.mp4");
    const outputPath = path.join(directory, "output");
    const tempPath = path.join(outputPath, ".produdash-job");
    fs.mkdirSync(outputPath);
    const fixture = spawnSync(
      ffmpegPath,
      [
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=24",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:sample_rate=48000",
        "-t",
        "12",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        sourcePath
      ],
      { encoding: "utf8" }
    );
    assert.equal(fixture.status, 0, fixture.stderr);
    const settings = {
      maxClips: 2,
      targetDuration: 5,
      captionMode: "srt_burned",
      captionText: "A local caption",
      aspectTreatment: "fit_pad",
      targetAspect: "vertical",
      platforms: ["tiktok"]
    };
    const progress = [];
    const analyzed = await runMediaTask(
      { mode: "analyze", sourcePath, outputPath, tempPath, settings },
      { context: createContext((message) => progress.push(message)), binaries: { ffmpegPath, ffprobePath } }
    );
    assert.equal(analyzed.type, "awaiting_review");
    assert.equal(analyzed.candidates.length, 2);
    assert.ok(progress.some((message) => message.stage === "scene_detection"));
    assert.ok(fs.existsSync(path.join(tempPath, "metadata.json")));
    const collisionPath = path.join(outputPath, "clip-01-clip-1.mp4");
    fs.writeFileSync(collisionPath, "do not overwrite");
    await assert.rejects(
      runMediaTask(
        {
          mode: "render",
          sourcePath,
          outputPath,
          tempPath,
          settings,
          selectedCandidateIds: [analyzed.candidates[0].id],
          warnings: analyzed.warnings,
          existingArtifactNames: []
        },
        { context: createContext(), binaries: { ffmpegPath, ffprobePath } }
      ),
      { code: "OUTPUT_COLLISION" }
    );
    assert.equal(fs.readFileSync(collisionPath, "utf8"), "do not overwrite");
    fs.unlinkSync(collisionPath);
    const secondCollisionPath = path.join(outputPath, "clip-02-clip-2.mp4");
    fs.writeFileSync(secondCollisionPath, "second collision");
    await assert.rejects(
      runMediaTask(
        {
          mode: "render",
          sourcePath,
          outputPath,
          tempPath,
          settings,
          selectedCandidateIds: analyzed.candidates.map((candidate) => candidate.id),
          warnings: analyzed.warnings,
          existingArtifactNames: []
        },
        { context: createContext(), binaries: { ffmpegPath, ffprobePath } }
      ),
      { code: "OUTPUT_COLLISION" }
    );
    const durablePartial = JSON.parse(fs.readFileSync(path.join(tempPath, "render-state.json"), "utf8"));
    assert.ok(durablePartial.artifacts.some((artifact) => artifact.name === "clip-01-clip-1.mp4"));
    fs.unlinkSync(secondCollisionPath);
    const rendered = await runMediaTask(
      {
        mode: "render",
        sourcePath,
        outputPath,
        tempPath,
        settings,
        selectedCandidateIds: analyzed.candidates.map((candidate) => candidate.id),
        warnings: analyzed.warnings,
        existingArtifactNames: ["clip-01-clip-1.mp4"]
      },
      { context: createContext(), binaries: { ffmpegPath, ffprobePath } }
    );
    assert.equal(rendered.type, "completed");
    assert.equal(fs.existsSync(tempPath), true);
    const video = rendered.artifacts.find((artifact) => artifact.kind === "video");
    const caption = rendered.artifacts.find((artifact) => artifact.kind === "caption");
    assert.equal(rendered.artifacts.filter((artifact) => artifact.kind === "thumbnail").length, 6);
    assert.ok(fs.existsSync(video.path));
    assert.ok(fs.existsSync(caption.path));
    const probe = spawnSync(ffprobePath, ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", video.path], {
      encoding: "utf8"
    });
    const streams = JSON.parse(probe.stdout).streams;
    assert.ok(streams.some((stream) => stream.codec_type === "video" && stream.codec_name === "h264"));
    assert.ok(streams.some((stream) => stream.codec_type === "audio" && stream.codec_name === "aac"));
    const manifestText = fs.readFileSync(path.join(outputPath, "produdash-manifest.json"), "utf8");
    assert.doesNotMatch(manifestText, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(manifestText, /sourcePath|outputPath|apiKey|reasoning/i);
    fs.rmSync(tempPath, { recursive: true, force: true });
    await assert.rejects(
      runMediaTask(
        {
          mode: "render",
          sourcePath,
          outputPath,
          tempPath,
          settings,
          selectedCandidateIds: [analyzed.candidates[0].id],
          warnings: [],
          existingArtifactNames: []
        },
        { context: createContext(), binaries: { ffmpegPath, ffprobePath } }
      ),
      { code: "DURABLE_ARTIFACT_MISSING" }
    );
  }
);

test("real multi-segment project rendering preserves cut duration and rebased captions", { timeout: 60_000 }, async (context) => {
  const directory = createDirectory("produdash-project-render-");
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { ffmpegPath, ffprobePath } = getMediaBinaries();
  const sourcePath = path.join(directory, "source.mp4");
  const outputPath = path.join(directory, "output");
  const tempPath = path.join(outputPath, ".produdash-job");
  fs.mkdirSync(outputPath);
  const fixture = spawnSync(
    ffmpegPath,
    [
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:sample_rate=48000",
      "-t",
      "9",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      sourcePath
    ],
    { encoding: "utf8" }
  );
  assert.equal(fixture.status, 0, fixture.stderr);
  const settings = {
    maxClips: 1,
    targetDuration: 5,
    captionMode: "srt_burned",
    captionText: "",
    aspectTreatment: "fit_pad",
    targetAspect: "original",
    platforms: [],
    analysisMode: "local_heuristics"
  };
  await runMediaTask(
    { mode: "analyze", sourcePath, outputPath, tempPath, settings },
    { context: createContext(), binaries: { ffmpegPath, ffprobePath } }
  );
  const projectCandidate = {
    id: "project-edit",
    title: "Project edit",
    start: 0,
    end: 5,
    duration: 5,
    confidence: 1,
    scores: {},
    rationale: "Human-edited project render plan.",
    edit: {
      title: "Project edit",
      start: 0,
      end: 5,
      duration: 5,
      segments: [
        { id: "segment-a", sourceStart: 0, sourceEnd: 2, timelineStart: 0, duration: 2 },
        { id: "segment-b", sourceStart: 5, sourceEnd: 8, timelineStart: 2, duration: 3 }
      ],
      captionSegments: [
        { start: 0.5, end: 1.5, text: "First cut" },
        { start: 2.5, end: 4.5, text: "Second cut" }
      ],
      captionStyle: "clean",
      captionPosition: "lower",
      captionSafeArea: "standard",
      captionTextColor: "#ffffff",
      captionBackgroundColor: "#101214",
      captionScale: 1.1,
      aspectTreatment: "fit_pad",
      targetAspect: "vertical",
      enhancement: { mode: "resize_hd", reviewed: true },
      composition: {
        transition: "fade",
        transitionDuration: 0.15,
        backgroundColor: "#101214",
        overlays: [
          {
            id: "overlay-one",
            type: "cta",
            text: "Shop now",
            start: 0.25,
            end: 4.75,
            x: 0.5,
            y: 0.2,
            width: 0.7,
            opacity: 1,
            fontScale: 0.8,
            textColor: "#ffffff",
            backgroundColor: "#101214"
          }
        ],
        music: null,
        introAssetId: null,
        outroAssetId: null
      },
      intelligentTracks: {
        subject: [
          {
            id: "subject-reviewed",
            start: 0,
            end: 5,
            reviewed: true,
            mode: "keyframes",
            keyframes: [{ at: 0, x: 0.25, y: 0.5, scale: 1, confidence: 1 }]
          }
        ],
        audio: [
          {
            id: "audio-reviewed",
            start: 0,
            end: 5,
            reviewed: true,
            preset: "voice_cleanup",
            strength: 0.6
          }
        ],
        broll: [
          {
            id: "broll-reviewed",
            start: 1,
            end: 2,
            reviewed: true,
            mediaId: "media-broll",
            sourceStart: 0,
            sourceEnd: 1,
            fit: "fit_pad",
            opacity: 1,
            provenance: { source: "user_library", mediaId: "media-broll", fingerprint: "b".repeat(64) }
          }
        ],
        sfx: [
          {
            id: "sfx-reviewed",
            start: 2,
            end: 3,
            reviewed: true,
            assetId: "media-sfx",
            volume: 0.25
          }
        ]
      }
    }
  };
  const rendered = await runMediaTask(
    {
      mode: "render",
      sourcePath,
      outputPath,
      tempPath,
      settings,
      candidates: [projectCandidate],
      selectedCandidateIds: ["project-edit"],
      warnings: [],
      assetPaths: { "media-broll": sourcePath, "media-sfx": sourcePath },
      existingArtifactNames: []
    },
    { context: createContext(), binaries: { ffmpegPath, ffprobePath } }
  );
  const video = rendered.artifacts.find((artifact) => artifact.kind === "video");
  const caption = rendered.artifacts.find((artifact) => artifact.kind === "caption");
  assert.equal(rendered.artifacts.filter((artifact) => artifact.kind === "thumbnail").length, 3);
  const manifestArtifact = rendered.artifacts.find((artifact) => artifact.kind === "manifest");
  const manifest = JSON.parse(fs.readFileSync(manifestArtifact.path, "utf8"));
  assert.deepEqual(
    manifest.thumbnailVariants.map((variant) => variant.positionRatio),
    [0.2, 0.5, 0.8]
  );
  assert.ok(manifest.thumbnailVariants.every((variant) => variant.source === "local_render"));
  assert.equal(manifest.analysis.candidates[0].approved.enhancement.mode, "resize_hd");
  assert.equal(manifest.analysis.candidates[0].approved.enhancement.reviewed, true);
  assert.equal(manifest.analysis.candidates[0].approved.enhancement.outputWidth, 1080);
  assert.equal(manifest.analysis.candidates[0].approved.enhancement.outputHeight, 1920);
  assert.match(manifest.analysis.candidates[0].approved.enhancement.detailClaim, /does not recover/);
  assert.ok(video && caption);
  const probe = spawnSync(ffprobePath, ["-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json", video.path], {
    encoding: "utf8"
  });
  const probeData = JSON.parse(probe.stdout);
  assert.ok(Math.abs(Number(probeData.format.duration) - 5) < 0.25);
  assert.equal(probeData.streams[0].width, 1080);
  assert.equal(probeData.streams[0].height, 1920);
  const captions = fs.readFileSync(caption.path, "utf8");
  assert.match(captions, /00:00:00,500 --> 00:00:01,500/);
  assert.match(captions, /00:00:02,500 --> 00:00:04,500/);
});
