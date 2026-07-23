const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { getMediaBinaries } = require("../electron/media/binaries.cjs");
const {
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
  assert.equal(candidates.length, 3);
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
