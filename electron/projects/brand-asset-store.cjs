const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { AppError } = require("../errors.cjs");
const { preserveFile, readJson, writeJsonAtomic } = require("../atomic-json.cjs");
const { getMediaBinaries } = require("../media/binaries.cjs");
const { boundedString, requireId } = require("../validation.cjs");

const execFileAsync = promisify(execFile);
const STORE_VERSION = 1;
const ASSET_LIMIT = 500;
const KIND_RULES = {
  logo: {
    extensions: new Set([".png", ".jpg", ".jpeg", ".webp"]),
    maxBytes: 20 * 1024 * 1024,
    stream: "video"
  },
  music: {
    extensions: new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]),
    maxBytes: 200 * 1024 * 1024,
    stream: "audio"
  },
  voiceover: {
    extensions: new Set([".wav"]),
    maxBytes: 50 * 1024 * 1024,
    stream: "audio"
  },
  intro: {
    extensions: new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]),
    maxBytes: 1024 * 1024 * 1024,
    stream: "video"
  },
  outro: {
    extensions: new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]),
    maxBytes: 1024 * 1024 * 1024,
    stream: "video"
  }
};

function clone(value) {
  return structuredClone(value);
}

function emptyStore() {
  return { schemaVersion: STORE_VERSION, assets: [], updatedAt: new Date().toISOString() };
}

function normalizeKind(value) {
  if (!Object.hasOwn(KIND_RULES, value)) throw new AppError("INVALID_BRAND_ASSET", "Choose a supported brand asset type.");
  return value;
}

function normalizeAsset(value) {
  const kind = normalizeKind(value?.kind);
  const extension = String(value?.extension || "").toLowerCase();
  if (!KIND_RULES[kind].extensions.has(extension)) {
    throw new AppError("INVALID_BRAND_ASSET_STORE", "A saved brand asset has an unsupported file type.");
  }
  const size = Number(value.size);
  const duration = value.duration === null ? null : Number(value.duration);
  const width = value.width === null ? null : Number(value.width);
  const height = value.height === null ? null : Number(value.height);
  if (!Number.isSafeInteger(size) || size < 1 || size > KIND_RULES[kind].maxBytes) {
    throw new AppError("INVALID_BRAND_ASSET_STORE", "A saved brand asset has an invalid size.");
  }
  if (duration !== null && (!Number.isFinite(duration) || duration < 0 || duration > 24 * 60 * 60)) {
    throw new AppError("INVALID_BRAND_ASSET_STORE", "A saved brand asset has an invalid duration.");
  }
  if (["intro", "outro"].includes(kind) && (duration === null || duration < 0.1 || duration > 60)) {
    throw new AppError("INVALID_BRAND_ASSET_STORE", "Intro and outro assets must be between 0.1 and 60 seconds.");
  }
  const asset = {
    id: requireId(value.id, "Brand asset"),
    kind,
    name: boundedString(value.name, { label: "Brand asset name", min: 1, max: 140 }),
    extension,
    fingerprint:
      String(value.fingerprint || "").match(/^[a-f0-9]{64}$/)?.[0] ||
      (() => {
        throw new AppError("INVALID_BRAND_ASSET_STORE", "A saved brand asset fingerprint is invalid.");
      })(),
    size,
    duration,
    width: Number.isInteger(width) && width > 0 && width <= 16384 ? width : null,
    height: Number.isInteger(height) && height > 0 && height <= 16384 ? height : null,
    codec: boundedString(value.codec, { label: "Brand asset codec", max: 80 }),
    hasAudio: Boolean(value.hasAudio),
    relativeName: path.basename(boundedString(value.relativeName, { label: "Brand asset file", min: 1, max: 220 })),
    createdAt: boundedString(value.createdAt, { label: "Brand asset creation time", min: 1, max: 40 })
  };
  if (kind === "voiceover") {
    const provenance = value.provenance;
    if (!provenance || provenance.source !== "provider" || provenance.aiGenerated !== true) {
      throw new AppError("INVALID_BRAND_ASSET_STORE", "A generated voiceover is missing safe provenance.");
    }
    const textHash = String(provenance.textHash || "");
    if (!/^[a-f0-9]{64}$/.test(textHash)) {
      throw new AppError("INVALID_BRAND_ASSET_STORE", "A generated voiceover text fingerprint is invalid.");
    }
    asset.provenance = {
      source: "provider",
      projectId: requireId(provenance.projectId, "Voiceover project"),
      sourceId: requireId(provenance.sourceId, "Voiceover transcript cue"),
      textHash,
      providerProfileId: requireId(provenance.providerProfileId, "Voiceover provider"),
      modelId: boundedString(provenance.modelId, { label: "Voiceover model", min: 1, max: 200 }),
      voice: boundedString(provenance.voice, { label: "Voice", min: 1, max: 200 }),
      voiceType: provenance.voiceType === "custom" ? "custom" : "built_in",
      aiGenerated: true,
      disclosure:
        provenance.voiceType === "custom"
          ? "Synthetic voice likeness; not the original speaker recording."
          : "AI-generated voice; not a human recording."
    };
  }
  return asset;
}

function validateStore(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== STORE_VERSION || !Array.isArray(value.assets)) {
    throw new AppError("INVALID_BRAND_ASSET_STORE", "The saved brand assets are invalid.");
  }
  if (value.assets.length > ASSET_LIMIT) throw new AppError("INVALID_BRAND_ASSET_STORE", "Too many brand assets are saved.");
  const ids = new Set();
  value.assets = value.assets.map((asset) => {
    const normalized = normalizeAsset(asset);
    if (ids.has(normalized.id)) throw new AppError("INVALID_BRAND_ASSET_STORE", "Brand asset identifiers must be unique.");
    ids.add(normalized.id);
    return normalized;
  });
  return value;
}

function loadStore(filePath) {
  const backupPath = `${filePath}.bak`;
  const notices = [];
  if (!fs.existsSync(filePath)) {
    const data = emptyStore();
    writeJsonAtomic(filePath, data, { backup: false });
    return { data, notices };
  }
  try {
    const raw = readJson(filePath);
    if (Number(raw?.schemaVersion) > STORE_VERSION) {
      throw new AppError("FUTURE_BRAND_ASSET_STORE", "These brand assets were created by a newer ProduDash version.");
    }
    return { data: validateStore(raw), notices };
  } catch (error) {
    if (error instanceof AppError && error.code === "FUTURE_BRAND_ASSET_STORE") throw error;
    preserveFile(filePath, "recovery");
    if (fs.existsSync(backupPath)) {
      try {
        const data = validateStore(readJson(backupPath));
        writeJsonAtomic(filePath, data, { backup: false });
        notices.push({ code: "BRAND_ASSETS_RECOVERED", message: "ProduDash recovered brand assets from backup." });
        return { data, notices };
      } catch {
        preserveFile(backupPath, "recovery");
      }
    }
    const data = emptyStore();
    writeJsonAtomic(filePath, data, { backup: false });
    notices.push({ code: "BRAND_ASSETS_RESET", message: "Damaged brand-asset metadata was preserved and reset." });
    return { data, notices };
  }
}

async function fingerprint(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function inspect(filePath) {
  const { ffprobePath } = getMediaBinaries();
  try {
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    });
    return JSON.parse(stdout);
  } catch {
    throw new AppError("BRAND_ASSET_INSPECTION_FAILED", "ProduDash could not read this brand asset.");
  }
}

function publicAsset(asset, available) {
  const safe = { ...asset };
  delete safe.relativeName;
  return {
    ...safe,
    status: available ? "available" : "missing",
    previewUrl: available ? `produdash-media://brand/${asset.id}` : null
  };
}

class BrandAssetStore {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.filePath = path.join(userDataPath, "produdash-brand-assets.json");
    this.assetDirectory = path.join(userDataPath, "brand-assets");
    fs.mkdirSync(this.assetDirectory, { recursive: true, mode: 0o700 });
    const loaded = loadStore(this.filePath);
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

  list() {
    return this.data.assets.map((asset) => publicAsset(asset, fs.existsSync(path.join(this.assetDirectory, asset.relativeName))));
  }

  get(assetId) {
    const asset = this.data.assets.find((item) => item.id === requireId(assetId, "Brand asset"));
    if (!asset) throw new AppError("BRAND_ASSET_NOT_FOUND", "Brand asset not found.");
    return asset;
  }

  resolve(assetId, expectedKinds = null) {
    const asset = this.get(assetId);
    const allowed = expectedKinds ? (Array.isArray(expectedKinds) ? expectedKinds : [expectedKinds]) : null;
    if (allowed && !allowed.includes(asset.kind)) {
      throw new AppError("BRAND_ASSET_TYPE_MISMATCH", "This brand asset cannot be used in that position.");
    }
    const filePath = path.join(this.assetDirectory, asset.relativeName);
    if (!fs.existsSync(filePath)) throw new AppError("BRAND_ASSET_MISSING", "A referenced brand asset is missing.");
    return { filePath, asset: publicAsset(asset, true) };
  }

  async import(kindValue, sourcePath, options = {}) {
    const kind = normalizeKind(kindValue);
    const rule = KIND_RULES[kind];
    const extension = path.extname(String(sourcePath || "")).toLowerCase();
    if (!rule.extensions.has(extension)) throw new AppError("INVALID_BRAND_ASSET", "This file type is not supported for that asset.");
    const stat = await fs.promises.stat(sourcePath).catch(() => null);
    if (!stat?.isFile() || stat.size < 1 || stat.size > rule.maxBytes) {
      throw new AppError("INVALID_BRAND_ASSET", "The selected asset is unavailable or exceeds the size limit.");
    }
    const probe = await inspect(sourcePath);
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const primary = streams.find((stream) => stream.codec_type === rule.stream);
    if (!primary) throw new AppError("INVALID_BRAND_ASSET", `This ${kind} file does not contain supported ${rule.stream} media.`);
    const durationValue = Number(probe.format?.duration || primary.duration);
    const duration = Number.isFinite(durationValue) ? Number(durationValue.toFixed(3)) : null;
    if (["intro", "outro"].includes(kind) && (duration === null || duration < 0.1 || duration > 60)) {
      throw new AppError("INVALID_BRAND_ASSET", "Intro and outro assets must be between 0.1 and 60 seconds.");
    }
    const digest = await fingerprint(sourcePath);
    const existing = kind === "voiceover" ? null : this.data.assets.find((asset) => asset.kind === kind && asset.fingerprint === digest);
    if (existing) return publicAsset(existing, fs.existsSync(path.join(this.assetDirectory, existing.relativeName)));
    if (this.data.assets.length >= ASSET_LIMIT) throw new AppError("BRAND_ASSET_LIMIT", "Remove an asset before adding another.");
    const id = `asset-${crypto.randomUUID()}`;
    const relativeName = `${id}${extension}`;
    const destination = path.join(this.assetDirectory, relativeName);
    const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
    await fs.promises.copyFile(sourcePath, temporary, fs.constants.COPYFILE_EXCL);
    const handle = await fs.promises.open(temporary, "r+");
    try {
      await handle.sync();
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporary, destination);
    const asset = normalizeAsset({
      id,
      kind,
      name: path.basename(sourcePath),
      extension,
      fingerprint: digest,
      size: stat.size,
      duration,
      width: primary.width || null,
      height: primary.height || null,
      codec: primary.codec_name || "",
      hasAudio: streams.some((stream) => stream.codec_type === "audio"),
      relativeName,
      createdAt: new Date().toISOString(),
      ...(kind === "voiceover" ? { provenance: options.provenance } : {})
    });
    return this.enqueue(async () => {
      this.data.assets.unshift(asset);
      this.persist();
      return publicAsset(asset, true);
    });
  }

  async importGeneratedVoiceover(buffer, metadata) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.length > KIND_RULES.voiceover.maxBytes) {
      throw new AppError("INVALID_VOICEOVER_AUDIO", "The provider returned invalid voiceover audio.");
    }
    const temporary = path.join(this.assetDirectory, `.voiceover-${crypto.randomUUID()}.wav`);
    await fs.promises.writeFile(temporary, buffer, { flag: "wx", mode: 0o600 });
    try {
      const provenance = {
        source: "provider",
        projectId: metadata?.projectId,
        sourceId: metadata?.sourceId,
        textHash: metadata?.textHash,
        providerProfileId: metadata?.providerProfileId,
        modelId: metadata?.modelId,
        voice: metadata?.voice,
        voiceType: metadata?.voiceType,
        aiGenerated: true,
        disclosure: "AI-generated voice; not a human recording."
      };
      const imported = await this.import("voiceover", temporary, { provenance });
      return this.enqueue(async () => {
        const asset = this.data.assets.find((item) => item.id === imported.id);
        asset.name = boundedString(metadata?.name, { label: "Voiceover name", min: 1, max: 140 });
        asset.provenance = provenance;
        const normalized = normalizeAsset(asset);
        Object.assign(asset, normalized);
        this.persist();
        return publicAsset(asset, true);
      });
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  }

  async clearGeneratedVoiceovers() {
    const ids = this.data.assets.filter((asset) => asset.kind === "voiceover").map((asset) => asset.id);
    for (const id of ids) await this.remove(id);
    return this.list();
  }

  exportPackageAsset(assetId) {
    const { filePath, asset } = this.resolve(assetId);
    return {
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      extension: asset.extension,
      fingerprint: asset.fingerprint,
      data: fs.readFileSync(filePath).toString("base64")
    };
  }

  async importPackageAsset(value) {
    const kind = normalizeKind(value?.kind);
    const extension = String(value?.extension || "").toLowerCase();
    const expectedFingerprint = String(value?.fingerprint || "");
    if (!KIND_RULES[kind].extensions.has(extension) || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
      throw new AppError("INVALID_TEMPLATE_IMPORT", "A packaged brand asset is invalid.");
    }
    const data = Buffer.from(String(value?.data || ""), "base64");
    if (!data.length || data.length > KIND_RULES[kind].maxBytes) {
      throw new AppError("INVALID_TEMPLATE_IMPORT", "A packaged brand asset exceeds its safe size limit.");
    }
    if (crypto.createHash("sha256").update(data).digest("hex") !== expectedFingerprint) {
      throw new AppError("INVALID_TEMPLATE_IMPORT", "A packaged brand asset failed integrity validation.");
    }
    const temporaryPath = path.join(this.assetDirectory, `.package-${crypto.randomUUID()}${extension}`);
    await fs.promises.writeFile(temporaryPath, data, { mode: 0o600, flag: "wx" });
    try {
      const imported = await this.import(kind, temporaryPath);
      const stored = this.data.assets.find((asset) => asset.id === imported.id);
      if (stored) {
        stored.name = boundedString(value?.name, { label: "Brand asset name", min: 1, max: 140 });
        this.persist();
      }
      return publicAsset(stored, true);
    } finally {
      await fs.promises.unlink(temporaryPath).catch(() => {});
    }
  }

  async remove(assetId) {
    return this.enqueue(async () => {
      const asset = this.get(assetId);
      this.data.assets = this.data.assets.filter((item) => item.id !== asset.id);
      this.persist();
      await fs.promises.unlink(path.join(this.assetDirectory, asset.relativeName)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      return { id: asset.id };
    });
  }

  async deleteAll() {
    return this.enqueue(async () => {
      for (const asset of this.data.assets) {
        await fs.promises.unlink(path.join(this.assetDirectory, asset.relativeName)).catch(() => {});
      }
      this.data = emptyStore();
      this.persist();
    });
  }
}

module.exports = { BrandAssetStore, KIND_RULES, validateStore };
