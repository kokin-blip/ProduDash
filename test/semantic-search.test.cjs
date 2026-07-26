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
  assert.deepEqual(first.segments, []);
  assert.ok(first.terms.includes("tutorial"));
  assert.ok(first.terms.length <= 160);
  assert.doesNotMatch(JSON.stringify(first), /path|bookmark|credential|token/i);
  assert.deepEqual(validateSearchDocument(first), first);
  const result = scoreSearchDocument(first, "tutorial buyer");
  assert.ok(result.score > 0);
  assert.ok(result.matchedTerms.includes("tutorial") || result.matchedTerms.includes("customer"));
});

test("local transcript search returns bounded timestamp matches without private fields", () => {
  const document = buildSearchDocument(
    { name: "Founder interview.mp4", tags: [], codec: "h264", aspectRatio: "16:9", extension: "mp4" },
    {
      transcriptSegments: [
        { start: 4.25, end: 9.5, text: "We launched the blue notebook after listening to customers." },
        { start: 14, end: 18, text: `<img src=x onerror="steal()"> Customer stories made the campaign work.` }
      ]
    }
  );
  assert.equal(document.provenance.source, "local_metadata_transcript");
  assert.deepEqual(document.provenance.inputs.at(-1), "project_transcript_segments");
  assert.doesNotMatch(JSON.stringify(document), /path|bookmark|credential|token/i);
  assert.deepEqual(validateSearchDocument(document), document);

  const result = scoreSearchDocument(document, "blue notebook");
  assert.ok(result.score > 0);
  assert.equal(result.timestampMatches[0].start, 4.25);
  assert.match(result.timestampMatches[0].excerpt, /blue notebook/);
  assert.ok(result.timestampMatches.length <= 5);
});

test("local transcript search rejects invalid timestamps and bounds excerpts", () => {
  assert.throws(() => buildSearchDocument({ name: "clip.mp4" }, { transcriptSegments: [{ start: 2, end: 1, text: "Invalid" }] }), {
    code: "INVALID_SEARCH_TRANSCRIPT"
  });
  const document = buildSearchDocument({ name: "clip.mp4" }, { transcriptSegments: [{ start: 0, end: 2, text: "a".repeat(500) }] });
  assert.equal(document.segments[0].excerpt.length, 240);
});

test("media-index v1 migrates sequentially to validated v3 local search provenance", () => {
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
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.clips[0].searchDocument.modelId, LOCAL_SEARCH_MODEL);
  assert.deepEqual(migrateMediaIndex(migrated), migrated);
  assert.deepEqual(validateMediaIndex(migrated), migrated);
});

test("media-index v2 rebuilds legacy search documents during the v3 migration", () => {
  const original = {
    schemaVersion: 2,
    folders: [],
    clips: [
      {
        id: "media-two",
        name: "Legacy search document.mp4",
        searchDocument: {
          version: 1,
          modelId: "local-keywords-v1",
          fingerprint: "a".repeat(64),
          terms: ["legacy"],
          provenance: {
            source: "local_metadata",
            inputs: ["filename"],
            generatedAt: new Date().toISOString()
          }
        }
      }
    ],
    updatedAt: new Date().toISOString()
  };
  const migrated = migrateMediaIndex(original);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.clips[0].searchDocument.modelId, LOCAL_SEARCH_MODEL);
  assert.equal(migrated.clips[0].searchDocument.version, 2);
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
  assert.deepEqual(await current, {
    modelId: LOCAL_SEARCH_MODEL,
    indexed: 250,
    transcriptIndexed: 0,
    source: "local_metadata"
  });
});

test("the Clip Library searches current project transcripts by timestamp without persisting paths", async (context) => {
  const directory = createDirectory("produdash-search-provider-");
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const library = new MediaLibrary(directory);
  library.index.clips = [
    {
      id: "media-one",
      name: "Untitled.mp4",
      tags: [],
      codec: "h264",
      aspectRatio: "16:9",
      extension: "mp4",
      locations: [],
      searchDocument: buildSearchDocument({ name: "Untitled.mp4" })
    }
  ];
  library.setTranscriptSearchProvider(() => [{ start: 12.5, end: 15, text: "The customer loved the notebook." }]);
  const result = library.query({ query: "buyer notebook" });
  assert.equal(result.total, 1);
  assert.equal(result.clips[0].search.provenance, "local_metadata_transcript");
  assert.equal(result.clips[0].search.timestampMatches[0].start, 12.5);
  assert.doesNotMatch(JSON.stringify(result), /absolutePath|bookmark|credential|token/i);
});
