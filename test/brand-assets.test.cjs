const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { BrandAssetStore } = require("../electron/projects/brand-asset-store.cjs");
const { getMediaBinaries } = require("../electron/media/binaries.cjs");
const { createMediaProtocolHandler } = require("../electron/media/media-protocol.cjs");
const { buildProjectRenderArgs, createContext, runMediaTask } = require("../electron/media/media-worker.cjs");

function fixtureDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "produdash-brand-assets-"));
}

function createFixtures(directory) {
  const { ffmpegPath } = getMediaBinaries();
  const logo = path.join(directory, "logo.png");
  const music = path.join(directory, "music.wav");
  const intro = path.join(directory, "intro.mp4");
  execFileSync(ffmpegPath, ["-nostdin", "-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", logo], {
    stdio: "ignore"
  });
  execFileSync(ffmpegPath, ["-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "pcm_s16le", music], {
    stdio: "ignore"
  });
  execFileSync(
    ffmpegPath,
    [
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:d=1",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      intro
    ],
    { stdio: "ignore" }
  );
  return { logo, music, intro };
}

test("brand assets are validated, copied, opaque, recoverable, and package-safe", async (t) => {
  const directory = fixtureDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixtures = createFixtures(directory);
  const store = new BrandAssetStore(directory);
  const logo = await store.import("logo", fixtures.logo);
  const music = await store.import("music", fixtures.music);
  const intro = await store.import("intro", fixtures.intro);
  const voiceover = await store.importGeneratedVoiceover(fs.readFileSync(fixtures.music), {
    name: "AI voice preview",
    projectId: "project-1",
    sourceId: "cue-1",
    textHash: "a".repeat(64),
    providerProfileId: "openai",
    modelId: "gpt-4o-mini-tts",
    voice: "marin"
  });
  assert.equal(store.list().length, 4);
  assert.equal(logo.status, "available");
  assert.match(logo.previewUrl, /^produdash-media:\/\/brand\/asset-/);
  assert.equal(JSON.stringify(store.list()).includes(directory), false);
  assert.equal(store.resolve(music.id, "music").asset.kind, "music");
  assert.throws(() => store.resolve(music.id, "logo"), { code: "BRAND_ASSET_TYPE_MISMATCH" });
  assert.equal(intro.duration, 1);
  assert.equal(voiceover.kind, "voiceover");
  assert.equal(voiceover.provenance.aiGenerated, true);
  assert.equal(JSON.stringify(voiceover).includes("AI voice preview"), true);

  const packaged = store.exportPackageAsset(logo.id);
  const imported = await store.importPackageAsset(packaged);
  assert.equal(imported.id, logo.id);
  await assert.rejects(() => store.importPackageAsset({ ...packaged, fingerprint: "0".repeat(64) }), {
    code: "INVALID_TEMPLATE_IMPORT"
  });

  const protocol = createMediaProtocolHandler({ resolveClipPath() {}, resolveThumbnailPath() {} }, store);
  const response = await protocol(new globalThis.Request(logo.previewUrl, { headers: { range: "bytes=0-7" } }));
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 8);
  assert.equal((await protocol(new globalThis.Request(voiceover.previewUrl))).status, 200);
  assert.equal([403, 404].includes((await protocol(new globalThis.Request("produdash-media://brand/../../private"))).status), true);
  fs.writeFileSync(path.join(directory, "produdash-brand-assets.json"), "{broken");
  const recovered = new BrandAssetStore(directory);
  assert.ok(recovered.list().length >= 1);
  assert.ok(recovered.getNotices().some((notice) => notice.code === "BRAND_ASSETS_RECOVERED"));
  await store.clearGeneratedVoiceovers();
  assert.equal(
    store.list().some((asset) => asset.kind === "voiceover"),
    false
  );
});

test("project render arguments add only snapshotted logo and music inputs without a shell", () => {
  const args = buildProjectRenderArgs({
    sourcePath: "/safe/source.mp4",
    outputPath: "/safe/output.mp4",
    hasAudio: true,
    candidate: {
      duration: 5,
      segments: [{ sourceStart: 0, sourceEnd: 5 }]
    },
    settings: {
      targetAspect: "square",
      aspectTreatment: "fit_pad",
      composition: {
        transition: "cut",
        overlays: [{ type: "logo", assetId: "asset-logo", start: 0, end: 5, x: 0.8, y: 0.1, width: 0.15, opacity: 0.9 }],
        music: { assetId: "asset-music", start: 0, end: 5, volume: 0.2, fadeIn: 0.5, fadeOut: 0.5 }
      }
    },
    assetPaths: {
      "asset-logo": "/safe/logo.png",
      "asset-music": "/safe/music.wav"
    }
  });
  assert.equal(Array.isArray(args), true);
  assert.equal(args.includes("/safe/logo.png"), true);
  assert.equal(args.includes("/safe/music.wav"), true);
  assert.match(args[args.indexOf("-filter_complex") + 1], /overlay=.*amix=/);
  assert.equal(
    args.some((argument) => argument.includes("; rm ") || argument.includes("&&")),
    false
  );
});

test("real project rendering applies snapshotted logo, music, intro, and outro assets", { timeout: 60_000 }, async (t) => {
  const directory = fixtureDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { ffmpegPath, ffprobePath } = getMediaBinaries();
  const fixtures = createFixtures(directory);
  const sourcePath = path.join(directory, "source.mp4");
  const outputPath = path.join(directory, "output");
  const tempPath = path.join(outputPath, ".produdash-job");
  fs.mkdirSync(outputPath);
  execFileSync(
    ffmpegPath,
    [
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:sample_rate=48000",
      "-t",
      "5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      sourcePath
    ],
    { stdio: "ignore" }
  );
  const settings = {
    maxClips: 1,
    targetDuration: 5,
    captionMode: "off",
    aspectTreatment: "fit_pad",
    targetAspect: "original",
    platforms: [],
    analysisMode: "local_heuristics"
  };
  await runMediaTask(
    { mode: "analyze", sourcePath, outputPath, tempPath, settings },
    { context: createContext(), binaries: { ffmpegPath, ffprobePath } }
  );
  const composition = {
    transition: "cut",
    transitionDuration: 0.25,
    backgroundColor: "#000000",
    overlays: [{ id: "logo", type: "logo", assetId: "logo", start: 0, end: 5, x: 0.8, y: 0.1, width: 0.15, opacity: 0.8 }],
    music: { assetId: "music", start: 0, end: 5, volume: 0.15, fadeIn: 0.2, fadeOut: 0.2 },
    introAssetId: "intro",
    outroAssetId: "outro"
  };
  const candidate = {
    id: "project-edit",
    title: "Branded edit",
    start: 0,
    end: 5,
    duration: 5,
    confidence: 1,
    scores: {},
    rationale: "Human approved.",
    edit: {
      title: "Branded edit",
      start: 0,
      end: 5,
      duration: 5,
      segments: [{ id: "segment-1", sourceStart: 0, sourceEnd: 5, timelineStart: 0, duration: 5 }],
      captionSegments: [],
      aspectTreatment: "fit_pad",
      targetAspect: "original",
      composition,
      voiceovers: [
        {
          id: "voiceover-1",
          sourceId: "cue-1",
          assetId: "voiceover",
          start: 1,
          end: 2,
          status: "reviewed",
          originalAudio: "replace",
          volume: 0.8,
          provenance: {
            providerProfileId: "openai",
            modelId: "gpt-4o-mini-tts",
            voice: "marin",
            textHash: "a".repeat(64),
            aiGenerated: true
          }
        }
      ],
      assetSnapshots: {
        intro: { duration: 1, hasAudio: true },
        outro: { duration: 1, hasAudio: true }
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
      candidates: [candidate],
      selectedCandidateIds: [candidate.id],
      warnings: [],
      existingArtifactNames: [],
      assetPaths: {
        logo: fixtures.logo,
        music: fixtures.music,
        voiceover: fixtures.music,
        intro: fixtures.intro,
        outro: fixtures.intro
      }
    },
    { context: createContext(), binaries: { ffmpegPath, ffprobePath } }
  );
  const video = rendered.artifacts.find((artifact) => artifact.kind === "video");
  assert.ok(video);
  const manifest = JSON.parse(fs.readFileSync(rendered.artifacts.find((artifact) => artifact.kind === "manifest").path, "utf8"));
  assert.equal(manifest.analysis.candidates[0].approved.voiceovers[0].voice, "marin");
  assert.match(manifest.analysis.candidates[0].approved.voiceovers[0].disclosure, /not a human recording/);
  const duration = Number(
    execFileSync(
      ffprobePath,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", video.path],
      { encoding: "utf8" }
    ).trim()
  );
  assert.ok(duration > 6.7 && duration < 7.3);
});
