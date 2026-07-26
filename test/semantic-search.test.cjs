const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { MediaLibrary } = require("../electron/media/media-library.cjs");
const { migrateMediaIndex, validateMediaIndex } = require("../electron/media/media-index.cjs");
const { createDirectory } = require("./helpers.cjs");
const {
  LOCAL_SEARCH_MODEL,
  buildSearchDocument,
  scoreSearchDocument,
  validateSearchDocument
} = require("../electron/media/semantic-search.cjs");

test("local smart-search documents are deterministic, bounded, and provenance-bearing", () => {
  const clip = {
    name: "Customer launch walkthrough.mp4",
    tags: ["testimonial", "product"],
    codec: "h264",
    aspectRatio: "9:16",
    extension: "mp4"
  };
  const first = buildSearchDocument(clip);
  const second = buildSearchDocument(clip);
  assert.equal(first.modelId, LOCAL_SEARCH_MODEL);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.provenance.source, "local_metadata");
  assert.ok(first.terms.includes("tutorial"));
  assert.ok(first.terms.length <= 160);
  assert.doesNotMatch(JSON.stringify(first), /path|bookmark|credential|token/i);
  assert.deepEqual(validateSearchDocument(first), first);
  const result = scoreSearchDocument(first, "tutorial buyer");
  assert.ok(result.score > 0);
  assert.ok(result.matchedTerms.includes("tutorial") || result.matchedTerms.includes("customer"));
});

test("media-index v1 migrates once to validated v2 local search provenance", () => {
  const original = {
    schemaVersion: 1,
    folders: [],
    clips: [
      {
        id: "media-one",
        name: "Product demo.mp4",
        tags: ["launch"],
        codec: "h264",
        aspectRatio: "16:9",
        extension: "mp4"
      }
    ],
    updatedAt: new Date().toISOString()
  };
  const migrated = migrateMediaIndex(original);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.clips[0].searchDocument.modelId, LOCAL_SEARCH_MODEL);
  assert.deepEqual(migrateMediaIndex(migrated), migrated);
  assert.deepEqual(validateMediaIndex(migrated), migrated);
});

test("a newer local search rebuild cancels the stale queued rebuild deterministically", async (context) => {
  const directory = createDirectory("produdash-search-");
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const library = new MediaLibrary(directory);
  library.index.clips = Array.from({ length: 250 }, (_value, index) => ({
    id: `media-${index}`,
    name: `Tutorial ${index}.mp4`,
    tags: [],
    codec: "h264",
    aspectRatio: "16:9",
    extension: "mp4",
    searchDocument: buildSearchDocument({ name: `Old ${index}.mp4` })
  }));
  const stale = library.rebuildSearchIndex();
  const current = library.rebuildSearchIndex();
  await assert.rejects(stale, { code: "SEARCH_INDEX_CANCELED" });
  assert.deepEqual(await current, { modelId: LOCAL_SEARCH_MODEL, indexed: 250, source: "local_metadata" });
});
