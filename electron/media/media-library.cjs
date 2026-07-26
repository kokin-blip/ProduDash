const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AppError } = require("../errors.cjs");
const { boundedString, requireId } = require("../validation.cjs");
const { writeJsonAtomic } = require("../atomic-json.cjs");
const { getMediaBinaries } = require("./binaries.cjs");
const { createEmptyMediaIndex, loadMediaIndex } = require("./media-index.cjs");
const { LOCAL_SEARCH_MODEL, buildSearchDocument, scoreSearchDocument } = require("./semantic-search.cjs");

const SUPPORTED_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const UNSUPPORTED_VIDEO_EXTENSIONS = new Set([".avi", ".wmv", ".flv", ".mpeg", ".mpg"]);
const MAX_QUERY_LIMIT = 100;
const MAX_TAGS = 20;

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function sourceKey(filePath) {
  return crypto.createHash("sha256").update(filePath).digest("hex");
}

function mediaFingerprint(clip) {
  const signature = [
    Number(clip.size) || 0,
    Number(Number(clip.duration).toFixed(3)) || 0,
    Number(clip.width) || 0,
    Number(clip.height) || 0,
    String(clip.codec || "")
  ].join(":");
  return crypto.createHash("sha256").update(signature).digest("hex");
}

function simplifyAspect(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return "Unknown";
  const gcd = (left, right) => (right ? gcd(right, left % right) : left);
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function runCommand(command, args, { timeoutMs = 20_000, maxOutput = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputSize = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(new AppError("MEDIA_TOOL_TIMEOUT", "A local media inspection timed out."));
    }, timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };
    const collect = (target) => (chunk) => {
      outputSize += chunk.length;
      if (outputSize > maxOutput) {
        child.kill();
        finish(new AppError("MEDIA_TOOL_OUTPUT_LIMIT", "A local media tool returned too much data."));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", () => finish(new AppError("MEDIA_TOOLS_UNAVAILABLE", "Bundled FFmpeg tools could not be started.")));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new AppError("INVALID_MEDIA", "The selected video could not be inspected."));
        return;
      }
      finish(null, {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

async function inspectMedia(filePath, binaries = getMediaBinaries()) {
  const stat = await fs.promises.stat(filePath);
  const extension = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return {
      status: "unsupported",
      duration: null,
      width: null,
      height: null,
      aspectRatio: "Unknown",
      codec: "Unsupported",
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      previewable: false
    };
  }
  const result = await runCommand(binaries.ffprobePath, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath
  ]);
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    throw new AppError("INVALID_MEDIA", "FFprobe returned invalid media metadata.");
  }
  const video = Array.isArray(output.streams) ? output.streams.find((stream) => stream.codec_type === "video") : null;
  const duration = Number(output.format?.duration ?? video?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0) {
    throw new AppError("INVALID_MEDIA", "The selected file does not contain a supported video stream.");
  }
  const width = Number(video.width);
  const height = Number(video.height);
  return {
    status: "available",
    duration,
    width: Number.isInteger(width) ? width : null,
    height: Number.isInteger(height) ? height : null,
    aspectRatio: simplifyAspect(width, height),
    codec: String(video.codec_name || "Unknown").slice(0, 80),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    previewable: extension !== ".mkv"
  };
}

async function createThumbnail(filePath, outputPath, duration, binaries = getMediaBinaries()) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const seek = Math.max(0, Math.min(Number(duration) * 0.1, 5));
  await runCommand(
    binaries.ffmpegPath,
    ["-y", "-ss", seek.toFixed(3), "-i", filePath, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", outputPath],
    { timeoutMs: 30_000, maxOutput: 1_000_000 }
  );
  return outputPath;
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

async function walkDirectory(rootPath) {
  const files = [];
  const queue = [rootPath];
  while (queue.length) {
    const directory = queue.shift();
    const handle = await fs.promises.opendir(directory);
    for await (const entry of handle) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(entryPath);
      else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(extension) || UNSUPPORTED_VIDEO_EXTENSIONS.has(extension)) files.push(entryPath);
      }
    }
  }
  return files;
}

class MediaLibrary {
  constructor(userDataPath, options = {}) {
    this.userDataPath = userDataPath;
    this.filePath = path.join(userDataPath, "produdash-media-index.json");
    this.cachePath = path.join(userDataPath, "produdash-media-cache");
    this.credentialVault = options.credentialVault || null;
    this.startAccessingBookmark = options.startAccessingBookmark || null;
    this.binaries = options.binaries || getMediaBinaries();
    const loaded = loadMediaIndex(this.filePath);
    this.index = loaded.index;
    this.notices = loaded.notices;
    this.mutationQueue = Promise.resolve();
    this.searchIndexGeneration = 0;
    this.transcriptSearchProvider = null;
  }

  getNotices() {
    return structuredClone(this.notices);
  }

  enqueue(callback) {
    const run = this.mutationQueue.then(callback, callback);
    this.mutationQueue = run.catch(() => {});
    return run;
  }

  persist() {
    for (const clip of this.index.clips) {
      if (!clip.searchDocument) clip.searchDocument = buildSearchDocument(clip);
    }
    this.index.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.filePath, this.index);
  }

  setTranscriptSearchProvider(provider) {
    if (provider !== null && typeof provider !== "function") {
      throw new AppError("INVALID_SEARCH_PROVIDER", "The local transcript search provider is invalid.");
    }
    this.transcriptSearchProvider = provider;
  }

  searchDocumentFor(clip) {
    if (!this.transcriptSearchProvider) return clip.searchDocument;
    try {
      const transcriptSegments = this.transcriptSearchProvider(clip.id);
      return buildSearchDocument(clip, { transcriptSegments });
    } catch {
      return clip.searchDocument;
    }
  }

  async saveBookmark(recordId, bookmark) {
    if (!bookmark) return false;
    if (!this.credentialVault) {
      throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure storage is required for persistent folder permission.");
    }
    await this.credentialVault.save(`media-bookmark-${recordId}`, { bookmark });
    return true;
  }

  async withFolderAccess(folder, callback) {
    let stop = null;
    if (folder.bookmarkStored && this.credentialVault && this.startAccessingBookmark) {
      const bookmark = this.credentialVault.get(`media-bookmark-${folder.id}`).bookmark;
      if (bookmark) stop = this.startAccessingBookmark(bookmark);
    }
    try {
      return await callback();
    } finally {
      if (typeof stop === "function") stop();
    }
  }

  async addFolders(selections) {
    if (!Array.isArray(selections) || !selections.length) return this.query({});
    return this.enqueue(async () => {
      for (const selection of selections) {
        const selectedPath = boundedString(selection?.path, { label: "Clip folder", min: 1, max: 4096 });
        let canonicalPath;
        try {
          canonicalPath = await fs.promises.realpath(selectedPath);
        } catch {
          throw new AppError("CLIP_FOLDER_UNAVAILABLE", "The selected clip folder is unavailable.");
        }
        let folder = this.index.folders.find((item) => item.path === canonicalPath);
        if (!folder) {
          folder = {
            id: createId("folder"),
            name: path.basename(canonicalPath),
            path: canonicalPath,
            status: "pending",
            addedAt: new Date().toISOString(),
            lastScannedAt: null,
            error: null,
            bookmarkStored: false
          };
          folder.bookmarkStored = await this.saveBookmark(folder.id, selection.bookmark);
          this.index.folders.push(folder);
          this.persist();
        }
        await this.scanFolder(folder.id);
      }
      return this.query({});
    });
  }

  async addFiles(selections) {
    if (!Array.isArray(selections) || !selections.length) return this.query({});
    return this.enqueue(async () => {
      for (const selection of selections) {
        const selectedPath = boundedString(selection?.path, { label: "Clip file", min: 1, max: 4096 });
        let canonicalPath;
        try {
          canonicalPath = await fs.promises.realpath(selectedPath);
        } catch {
          continue;
        }
        let clip = this.index.clips.find((item) => item.sourceKey === sourceKey(canonicalPath));
        if (!clip) {
          clip = await this.inspectClip(canonicalPath, null, path.basename(canonicalPath));
          this.index.clips.push(clip);
        }
        clip.loosePath = canonicalPath;
        if (selection.bookmark) {
          clip.bookmarkStored = await this.saveBookmark(clip.id, selection.bookmark);
        }
      }
      this.persist();
      return this.query({});
    });
  }

  async inspectClip(filePath, folderId, relativePath, existing = null) {
    const previousMedia = existing
      ? {
          size: existing.size,
          modifiedAt: existing.modifiedAt,
          thumbnailAvailable: existing.thumbnailAvailable
        }
      : null;
    const clip = existing || {
      id: createId("media"),
      tags: [],
      locations: [],
      loosePath: null,
      bookmarkStored: false
    };
    const realPath = await fs.promises.realpath(filePath);
    clip.sourceKey = sourceKey(realPath);
    clip.name = path.basename(filePath);
    clip.extension = path.extname(filePath).toLowerCase().slice(1);
    if (folderId && !clip.locations.some((location) => location.folderId === folderId)) {
      clip.locations.push({ folderId, relativePath });
    } else if (folderId) {
      clip.locations = clip.locations.map((location) => (location.folderId === folderId ? { folderId, relativePath } : location));
    }
    try {
      const metadata = await inspectMedia(filePath, this.binaries);
      Object.assign(clip, metadata);
      if (clip.status === "available") {
        const thumbnailPath = path.join(this.cachePath, `${clip.id}.jpg`);
        const cached =
          previousMedia?.thumbnailAvailable &&
          previousMedia.size === metadata.size &&
          previousMedia.modifiedAt === metadata.modifiedAt &&
          fs.existsSync(thumbnailPath);
        try {
          if (!cached) await createThumbnail(filePath, thumbnailPath, clip.duration, this.binaries);
          clip.thumbnailAvailable = true;
        } catch {
          clip.thumbnailAvailable = false;
        }
      }
      clip.error = null;
    } catch (error) {
      const stat = await fs.promises.stat(filePath).catch(() => null);
      Object.assign(clip, {
        status: "corrupt",
        duration: null,
        width: null,
        height: null,
        aspectRatio: "Unknown",
        codec: "Unknown",
        size: stat?.size || 0,
        modifiedAt: stat?.mtime?.toISOString() || null,
        previewable: false,
        thumbnailAvailable: false,
        error: error instanceof AppError ? error.message : "The video could not be inspected."
      });
    }
    clip.searchDocument = buildSearchDocument(clip);
    return clip;
  }

  async rescanFolder(folderId) {
    requireId(folderId, "Clip folder");
    return this.enqueue(async () => {
      await this.scanFolder(folderId);
      return this.query({});
    });
  }

  async scanFolder(folderId) {
    const folder = this.index.folders.find((item) => item.id === folderId);
    if (!folder) throw new AppError("CLIP_FOLDER_NOT_FOUND", "Clip folder not found.");
    folder.status = "scanning";
    folder.error = null;
    this.persist();
    try {
      await this.withFolderAccess(folder, async () => {
        const files = await walkDirectory(folder.path);
        const foundRelativePaths = new Set();
        const matchedClipIds = new Set();
        await mapConcurrent(files, 3, async (filePath) => {
          const relativePath = path.relative(folder.path, filePath);
          foundRelativePaths.add(relativePath);
          const canonicalPath = await fs.promises.realpath(filePath);
          const stat = await fs.promises.stat(canonicalPath);
          const key = sourceKey(canonicalPath);
          const byLocation = this.index.clips.find((clip) =>
            clip.locations?.some((location) => location.folderId === folderId && location.relativePath === relativePath)
          );
          const byPath = this.index.clips.find((clip) => clip.sourceKey === key);
          const renamed = this.index.clips.find(
            (clip) =>
              !matchedClipIds.has(clip.id) &&
              clip.locations?.some((location) => location.folderId === folderId) &&
              clip.size === stat.size &&
              clip.modifiedAt === stat.mtime.toISOString()
          );
          const existing = byLocation || byPath || renamed;
          if (existing) matchedClipIds.add(existing.id);
          const clip = await this.inspectClip(filePath, folderId, relativePath, existing);
          if (!existing) this.index.clips.push(clip);
        });
        for (const clip of this.index.clips) {
          clip.locations = (clip.locations || []).filter(
            (location) => location.folderId !== folderId || foundRelativePaths.has(location.relativePath)
          );
        }
        this.index.clips = this.index.clips.filter((clip) => clip.loosePath || clip.locations.length);
      });
      folder.status = "available";
      folder.lastScannedAt = new Date().toISOString();
    } catch (error) {
      folder.status = error?.code === "EACCES" ? "permission_denied" : "offline";
      folder.error =
        folder.status === "permission_denied"
          ? "ProduDash no longer has permission to read this folder."
          : "The folder is unavailable. Reconnect its drive or relocate it.";
      for (const clip of this.index.clips.filter((item) => item.locations?.some((location) => location.folderId === folderId))) {
        clip.status = folder.status === "offline" ? "missing" : "permission_denied";
      }
    }
    this.persist();
  }

  async relocateFolder(folderId, selection) {
    requireId(folderId, "Clip folder");
    const selectedPath = boundedString(selection?.path, { label: "Clip folder", min: 1, max: 4096 });
    const canonicalPath = await fs.promises.realpath(selectedPath).catch(() => {
      throw new AppError("CLIP_FOLDER_UNAVAILABLE", "The selected replacement folder is unavailable.");
    });
    return this.enqueue(async () => {
      const folder = this.index.folders.find((item) => item.id === folderId);
      if (!folder) throw new AppError("CLIP_FOLDER_NOT_FOUND", "Clip folder not found.");
      const hadBookmark = folder.bookmarkStored;
      folder.path = canonicalPath;
      folder.name = path.basename(canonicalPath);
      folder.bookmarkStored = await this.saveBookmark(folder.id, selection.bookmark);
      if (hadBookmark && !folder.bookmarkStored && this.credentialVault) {
        await this.credentialVault.remove(`media-bookmark-${folder.id}`);
      }
      await this.scanFolder(folderId);
      return this.query({});
    });
  }

  async removeFolder(folderId) {
    requireId(folderId, "Clip folder");
    return this.enqueue(async () => {
      const folderIndex = this.index.folders.findIndex((item) => item.id === folderId);
      if (folderIndex < 0) throw new AppError("CLIP_FOLDER_NOT_FOUND", "Clip folder not found.");
      const [folder] = this.index.folders.splice(folderIndex, 1);
      for (const clip of this.index.clips) {
        clip.locations = (clip.locations || []).filter((location) => location.folderId !== folderId);
      }
      const removed = this.index.clips.filter((clip) => !clip.loosePath && !clip.locations.length);
      this.index.clips = this.index.clips.filter((clip) => clip.loosePath || clip.locations.length);
      for (const clip of removed) {
        await fs.promises.unlink(path.join(this.cachePath, `${clip.id}.jpg`)).catch(() => {});
      }
      if (folder.bookmarkStored && this.credentialVault) {
        await this.credentialVault.remove(`media-bookmark-${folderId}`);
      }
      this.persist();
      return this.query({});
    });
  }

  async updateTags(clipId, tags) {
    requireId(clipId, "Clip");
    if (!Array.isArray(tags)) throw new AppError("INVALID_INPUT", "Clip tags must be a list.");
    const normalized = [...new Set(tags.map((tag) => boundedString(tag, { label: "Clip tag", min: 1, max: 30 }).toLowerCase()))].slice(
      0,
      MAX_TAGS
    );
    return this.enqueue(async () => {
      const clip = this.index.clips.find((item) => item.id === clipId);
      if (!clip) throw new AppError("CLIP_NOT_FOUND", "Clip not found.");
      clip.tags = normalized;
      clip.searchDocument = buildSearchDocument(clip);
      this.persist();
      return this.query({});
    });
  }

  async removeClip(clipId) {
    requireId(clipId, "Clip");
    return this.enqueue(async () => {
      const index = this.index.clips.findIndex((item) => item.id === clipId);
      if (index < 0) throw new AppError("CLIP_NOT_FOUND", "Clip not found.");
      const [clip] = this.index.clips.splice(index, 1);
      if (clip.bookmarkStored && this.credentialVault) {
        await this.credentialVault.remove(`media-bookmark-${clip.id}`);
      }
      await fs.promises.unlink(path.join(this.cachePath, `${clip.id}.jpg`)).catch(() => {});
      this.persist();
      return this.query({});
    });
  }

  query(options = {}) {
    const query = String(options.query || "")
      .trim()
      .toLowerCase()
      .slice(0, 200);
    const folderId = options.folderId ? String(options.folderId) : "";
    const status = options.status ? String(options.status) : "";
    const sort = ["name", "modified_desc", "duration_desc", "size_desc"].includes(options.sort) ? options.sort : "modified_desc";
    const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    const limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, Number.parseInt(options.limit, 10) || 40));
    let clips = this.index.clips
      .map((clip) => {
        const searchDocument = this.searchDocumentFor(clip);
        return {
          clip,
          searchDocument,
          search: query ? scoreSearchDocument(searchDocument, query) : { score: 0, matchedTerms: [], timestampMatches: [] }
        };
      })
      .filter(({ clip, search }) => {
        if (query && search.score <= 0) return false;
        if (folderId && !clip.locations?.some((location) => location.folderId === folderId)) return false;
        if (status && clip.status !== status) return false;
        return true;
      });
    const compareText = (left, right) => String(left || "").localeCompare(String(right || ""));
    clips = clips.sort((leftEntry, rightEntry) => {
      const left = leftEntry.clip;
      const right = rightEntry.clip;
      if (query && rightEntry.search.score !== leftEntry.search.score) return rightEntry.search.score - leftEntry.search.score;
      if (sort === "name") return compareText(left.name, right.name);
      if (sort === "duration_desc") return Number(right.duration || 0) - Number(left.duration || 0);
      if (sort === "size_desc") return Number(right.size || 0) - Number(left.size || 0);
      return Date.parse(right.modifiedAt || 0) - Date.parse(left.modifiedAt || 0);
    });
    return {
      folders: this.index.folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        status: folder.status,
        lastScannedAt: folder.lastScannedAt,
        error: folder.error,
        clipCount: this.index.clips.filter((clip) => clip.locations?.some((location) => location.folderId === folder.id)).length
      })),
      clips: clips.slice(offset, offset + limit).map(({ clip, search, searchDocument }) => ({
        id: clip.id,
        name: clip.name,
        extension: clip.extension,
        status: clip.status,
        duration: clip.duration,
        width: clip.width,
        height: clip.height,
        aspectRatio: clip.aspectRatio,
        codec: clip.codec,
        size: clip.size,
        modifiedAt: clip.modifiedAt,
        previewable: clip.previewable,
        fingerprint: mediaFingerprint(clip),
        tags: structuredClone(clip.tags || []),
        error: clip.error,
        previewUrl: clip.previewable ? `produdash-media://clip/${clip.id}` : null,
        thumbnailUrl: clip.thumbnailAvailable ? `produdash-media://thumbnail/${clip.id}` : null,
        search: query
          ? {
              score: search.score,
              matchedTerms: search.matchedTerms,
              timestampMatches: search.timestampMatches,
              modelId: searchDocument.modelId,
              provenance: searchDocument.provenance.source
            }
          : null
      })),
      total: clips.length,
      offset,
      limit,
      notices: structuredClone(this.notices)
    };
  }

  async rebuildSearchIndex({ modelId = LOCAL_SEARCH_MODEL } = {}) {
    const generation = ++this.searchIndexGeneration;
    return this.enqueue(async () => {
      let indexed = 0;
      let transcriptIndexed = 0;
      for (const clip of this.index.clips) {
        if (generation !== this.searchIndexGeneration) {
          throw new AppError("SEARCH_INDEX_CANCELED", "The previous local search-index rebuild was canceled.");
        }
        const transcriptSegments = this.transcriptSearchProvider ? this.transcriptSearchProvider(clip.id) : [];
        clip.searchDocument = buildSearchDocument(clip, { modelId, transcriptSegments });
        if (clip.searchDocument.segments.length) transcriptIndexed += 1;
        indexed += 1;
        if (indexed % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (generation !== this.searchIndexGeneration) {
        throw new AppError("SEARCH_INDEX_CANCELED", "The previous local search-index rebuild was canceled.");
      }
      this.persist();
      return {
        modelId,
        indexed,
        transcriptIndexed,
        source: transcriptIndexed ? "local_metadata_transcript" : "local_metadata"
      };
    });
  }

  cancelSearchIndexRebuild() {
    this.searchIndexGeneration += 1;
    return { canceled: true };
  }

  getClipSummary(clipId) {
    requireId(clipId, "Clip");
    const clip = this.index.clips.find((item) => item.id === clipId);
    if (!clip) throw new AppError("CLIP_NOT_FOUND", "Clip not found.");
    return {
      id: clip.id,
      name: clip.name,
      status: clip.status,
      duration: clip.duration,
      previewable: clip.previewable,
      fingerprint: mediaFingerprint(clip)
    };
  }

  resolveClipPath(clipId) {
    requireId(clipId, "Clip");
    const clip = this.index.clips.find((item) => item.id === clipId);
    if (!clip) throw new AppError("CLIP_NOT_FOUND", "Clip not found.");
    if (clip.loosePath) return clip.loosePath;
    for (const location of clip.locations || []) {
      const folder = this.index.folders.find((item) => item.id === location.folderId);
      if (folder) {
        const folderPath = path.resolve(folder.path);
        const candidate = path.resolve(folderPath, location.relativePath);
        if (candidate.startsWith(`${folderPath}${path.sep}`)) return candidate;
      }
    }
    throw new AppError("CLIP_UNAVAILABLE", "The clip file is unavailable.");
  }

  startClipAccess(clipId) {
    requireId(clipId, "Clip");
    const clip = this.index.clips.find((item) => item.id === clipId);
    if (!clip) throw new AppError("CLIP_NOT_FOUND", "Clip not found.");
    if (!this.credentialVault || !this.startAccessingBookmark) return null;
    let bookmarkId = null;
    if (clip.loosePath && clip.bookmarkStored) bookmarkId = clip.id;
    if (!bookmarkId) {
      const location = (clip.locations || []).find((item) => {
        const folder = this.index.folders.find((candidate) => candidate.id === item.folderId);
        return folder?.bookmarkStored;
      });
      bookmarkId = location?.folderId || null;
    }
    if (!bookmarkId) return null;
    const bookmark = this.credentialVault.get(`media-bookmark-${bookmarkId}`).bookmark;
    return bookmark ? this.startAccessingBookmark(bookmark) : null;
  }

  resolveThumbnailPath(clipId) {
    requireId(clipId, "Clip");
    const clip = this.index.clips.find((item) => item.id === clipId);
    if (!clip?.thumbnailAvailable) throw new AppError("THUMBNAIL_NOT_FOUND", "Clip thumbnail not found.");
    return path.join(this.cachePath, `${clip.id}.jpg`);
  }

  async clear({ removeIndex = false } = {}) {
    return this.enqueue(async () => {
      if (this.credentialVault) {
        const bookmarkIds = [
          ...this.index.folders.filter((item) => item.bookmarkStored).map((folder) => `media-bookmark-${folder.id}`),
          ...this.index.clips.filter((item) => item.bookmarkStored).map((clip) => `media-bookmark-${clip.id}`)
        ];
        if (bookmarkIds.length) await this.credentialVault.removeMany(bookmarkIds);
      }
      await fs.promises.rm(this.cachePath, { recursive: true, force: true });
      this.index = createEmptyMediaIndex();
      this.notices = [];
      const baseName = path.basename(this.filePath);
      if (fs.existsSync(this.userDataPath)) {
        for (const entry of fs.readdirSync(this.userDataPath)) {
          if (entry === baseName || entry === `${baseName}.bak` || entry.startsWith(`${baseName}.recovery-`)) {
            await fs.promises.unlink(path.join(this.userDataPath, entry)).catch(() => {});
          }
        }
      }
      if (!removeIndex) writeJsonAtomic(this.filePath, this.index, { backup: false });
      return this.query({});
    });
  }
}

module.exports = {
  MAX_QUERY_LIMIT,
  MediaLibrary,
  SUPPORTED_EXTENSIONS,
  createThumbnail,
  inspectMedia,
  runCommand,
  walkDirectory
};
