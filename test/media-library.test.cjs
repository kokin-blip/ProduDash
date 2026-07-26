const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { writeJsonAtomic } = require("../electron/atomic-json.cjs");
const { getMediaBinaries } = require("../electron/media/binaries.cjs");
const { MediaLibrary, runCommand } = require("../electron/media/media-library.cjs");
const { createMediaProtocolHandler, parseRange } = require("../electron/media/media-protocol.cjs");
const { createDirectory, createHarness } = require("./helpers.cjs");
const { Request } = globalThis;

async function createVideo(filePath) {
  const { ffmpegPath } = getMediaBinaries();
  await runCommand(
    ffmpegPath,
    ["-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", filePath],
    { timeoutMs: 30_000 }
  );
}

test("Clip Library scans recursively, skips hidden paths and symlinks, deduplicates, and preserves tags", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const folder = path.join(harness.directory, "videos");
  const nested = path.join(folder, "nested");
  const hidden = path.join(folder, ".hidden");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(hidden, { recursive: true });
  const video = path.join(nested, "clip.mp4");
  await createVideo(video);
  fs.copyFileSync(video, path.join(hidden, "ignored.mp4"));
  fs.symlinkSync(video, path.join(folder, "linked.mp4"));
  fs.writeFileSync(path.join(folder, "broken.mp4"), "not-video");
  fs.writeFileSync(path.join(folder, "legacy.avi"), "not-video");

  const library = new MediaLibrary(harness.directory, { credentialVault: harness.vault });
  let result = await library.addFolders([{ path: folder }]);
  assert.equal(result.total, 3);
  assert.equal(
    result.clips.some((clip) => clip.name === "ignored.mp4"),
    false
  );
  assert.equal(
    result.clips.some((clip) => clip.name === "linked.mp4"),
    false
  );
  assert.equal(result.clips.find((clip) => clip.name === "clip.mp4").status, "available");
  assert.ok(result.clips.find((clip) => clip.name === "clip.mp4").thumbnailUrl);
  assert.equal(result.clips.find((clip) => clip.name === "broken.mp4").status, "corrupt");
  assert.equal(result.clips.find((clip) => clip.name === "legacy.avi").status, "unsupported");

  const clip = result.clips.find((item) => item.name === "clip.mp4");
  const thumbnailPath = path.join(library.cachePath, `${clip.id}.jpg`);
  const cachedTime = new Date("2000-01-01T00:00:00.000Z");
  fs.utimesSync(thumbnailPath, cachedTime, cachedTime);
  result = await library.updateTags(clip.id, ["Favorite", "favorite", "Launch"]);
  assert.deepEqual(result.clips.find((item) => item.id === clip.id).tags, ["favorite", "launch"]);
  const renamedVideo = path.join(nested, "renamed.mp4");
  fs.renameSync(video, renamedVideo);
  result = await library.rescanFolder(result.folders[0].id);
  assert.equal(result.clips.find((item) => item.id === clip.id).name, "renamed.mp4");
  assert.deepEqual(result.clips.find((item) => item.id === clip.id).tags, ["favorite", "launch"]);
  assert.equal(fs.statSync(thumbnailPath).mtime.toISOString(), cachedTime.toISOString());
  result = await library.addFiles([{ path: renamedVideo }]);
  assert.equal(result.total, 3);
  result = await library.rescanFolder(result.folders[0].id);
  assert.deepEqual(result.clips.find((item) => item.id === clip.id).tags, ["favorite", "launch"]);

  await library.removeFolder(result.folders[0].id);
  result = await library.removeClip(clip.id);
  assert.equal(
    result.clips.some((item) => item.id === clip.id),
    false
  );
  assert.equal(fs.existsSync(renamedVideo), true);
});

test("media index recovers from a corrupt primary and blocks future versions", () => {
  const directory = createDirectory("produdash-media-index-");
  const library = new MediaLibrary(directory);
  library.index.clips.push({ id: "first", tags: [], locations: [] });
  library.persist();
  library.index.clips.push({ id: "second", tags: [], locations: [] });
  library.persist();
  fs.writeFileSync(library.filePath, "{broken");
  const recovered = new MediaLibrary(directory);
  assert.equal(recovered.index.clips.length, 1);
  assert.ok(recovered.getNotices().some((notice) => notice.code === "MEDIA_INDEX_RECOVERED"));
  assert.ok(fs.readdirSync(directory).some((entry) => entry.includes(".recovery-")));

  writeJsonAtomic(recovered.filePath, { schemaVersion: 99, folders: [], clips: [] }, { backup: false });
  assert.throws(
    () => new MediaLibrary(directory),
    (error) => error.code === "FUTURE_MEDIA_INDEX"
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test("library reset clears metadata and caches without deleting source media", async (t) => {
  const directory = createDirectory("produdash-media-clear-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.mp4");
  fs.writeFileSync(source, "owned-by-user");
  const library = new MediaLibrary(directory);
  library.index.clips.push({
    id: "media-clear",
    name: "source.mp4",
    loosePath: source,
    tags: [],
    locations: [],
    thumbnailAvailable: false
  });
  library.persist();
  await library.clear();
  assert.equal(library.query({}).total, 0);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(library.filePath), true);
  await library.clear({ removeIndex: true });
  assert.equal(fs.existsSync(library.filePath), false);
  assert.equal(fs.existsSync(source), true);
});

test("opaque media protocol enforces IDs and supports bounded byte ranges", async (t) => {
  const directory = createDirectory("produdash-media-protocol-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "clip.mp4");
  fs.writeFileSync(filePath, "0123456789");
  let accessReleased = false;
  const handler = createMediaProtocolHandler({
    resolveClipPath: (clipId) => {
      assert.equal(clipId, "media-1");
      return filePath;
    },
    resolveThumbnailPath: () => filePath,
    startClipAccess: () => () => {
      accessReleased = true;
    }
  });
  const response = await handler(new Request("produdash-media://clip/media-1", { headers: { Range: "bytes=2-5" } }));
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "2345");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(accessReleased, true);
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.equal(parseRange("bytes=99-100", 10), null);
  const rejected = await handler(new Request("produdash-media://clip/../../etc/passwd"));
  assert.equal(rejected.status, 404);
  const jobThumbnailHandler = createMediaProtocolHandler(
    {
      resolveClipPath: () => filePath,
      resolveThumbnailPath: () => filePath,
      startClipAccess: () => null
    },
    null,
    {
      resolveThumbnailArtifact: (id) => {
        assert.equal(id, "artifact-1234567890abcdef12345678");
        return filePath;
      }
    }
  );
  assert.equal((await jobThumbnailHandler(new Request("produdash-media://job-thumbnail/artifact-1234567890abcdef12345678"))).status, 200);
  assert.equal((await handler(new Request("produdash-media://job-thumbnail/artifact-1234567890abcdef12345678"))).status, 404);
});

test("indexed folder records cannot escape their allowlisted root", () => {
  const directory = createDirectory("produdash-media-traversal-");
  const library = new MediaLibrary(directory);
  library.index.folders.push({ id: "folder-safe", path: path.join(directory, "safe") });
  library.index.clips.push({
    id: "media-traversal",
    loosePath: null,
    locations: [{ folderId: "folder-safe", relativePath: "../../secret.txt" }]
  });
  assert.throws(
    () => library.resolveClipPath("media-traversal"),
    (error) => error.code === "CLIP_UNAVAILABLE"
  );
  fs.rmSync(directory, { recursive: true, force: true });
});
