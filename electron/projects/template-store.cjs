const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("../errors.cjs");
const { preserveFile, readJson, writeJsonAtomic } = require("../atomic-json.cjs");
const { boundedString, requireId } = require("../validation.cjs");

const TEMPLATE_STORE_VERSION = 1;
const TEMPLATE_DOCUMENT_VERSION = 1;
const TEMPLATE_VERSION_LIMIT = 50;

function clone(value) {
  return structuredClone(value);
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function color(value, fallback) {
  const result = String(value || fallback).toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(result)) throw new AppError("INVALID_TEMPLATE", "Template colors must use six-digit hexadecimal values.");
  return result;
}

function number(value, { label, min, max, fallback }) {
  const result = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new AppError("INVALID_TEMPLATE", `${label} is outside the supported range.`);
  }
  return Number(result.toFixed(3));
}

function optionalId(value, label) {
  return value ? requireId(value, label) : null;
}

function normalizeTemplateSettings(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_TEMPLATE", "The brand template settings are invalid.");
  }
  const presentation = value.presentation && typeof value.presentation === "object" ? value.presentation : {};
  const composition = value.composition && typeof value.composition === "object" ? value.composition : {};
  const overlays = Array.isArray(composition.overlays) ? composition.overlays : [];
  if (overlays.length > 20) throw new AppError("INVALID_TEMPLATE", "A brand template may contain at most 20 overlays.");
  const ids = new Set();
  return {
    presentation: {
      targetAspect: ["original", "vertical", "square", "landscape"].includes(presentation.targetAspect)
        ? presentation.targetAspect
        : "original",
      aspectTreatment: ["original", "fit_pad", "center_crop"].includes(presentation.aspectTreatment)
        ? presentation.aspectTreatment
        : "fit_pad",
      captionMode: ["off", "srt", "srt_burned"].includes(presentation.captionMode) ? presentation.captionMode : "off",
      captionStyle: ["clean", "contrast", "notebook", "brand"].includes(presentation.captionStyle) ? presentation.captionStyle : "brand",
      captionPosition: ["lower", "middle", "upper"].includes(presentation.captionPosition) ? presentation.captionPosition : "lower",
      captionSafeArea: ["standard", "social"].includes(presentation.captionSafeArea) ? presentation.captionSafeArea : "social",
      captionTextColor: color(presentation.captionTextColor, "#ffffff"),
      captionBackgroundColor: color(presentation.captionBackgroundColor, "#000000"),
      captionScale: number(presentation.captionScale, { label: "Caption scale", min: 0.5, max: 2.5, fallback: 1 })
    },
    composition: {
      transition: ["cut", "fade"].includes(composition.transition) ? composition.transition : "cut",
      transitionDuration: number(composition.transitionDuration, {
        label: "Transition duration",
        min: 0.05,
        max: 1.5,
        fallback: 0.25
      }),
      backgroundColor: color(composition.backgroundColor, "#000000"),
      music:
        composition.music && typeof composition.music === "object"
          ? {
              assetId: requireId(composition.music.assetId, "Music asset"),
              volume: number(composition.music.volume, { label: "Music volume", min: 0.05, max: 1, fallback: 0.25 }),
              fadeIn: number(composition.music.fadeIn, { label: "Music fade in", min: 0, max: 10, fallback: 0.5 }),
              fadeOut: number(composition.music.fadeOut, { label: "Music fade out", min: 0, max: 10, fallback: 0.5 })
            }
          : null,
      introAssetId: optionalId(composition.introAssetId, "Intro asset"),
      outroAssetId: optionalId(composition.outroAssetId, "Outro asset"),
      overlays: overlays.map((overlay, index) => {
        const id = overlay.id ? requireId(overlay.id, "Template overlay") : `overlay-${index + 1}`;
        if (ids.has(id)) throw new AppError("INVALID_TEMPLATE", "Template overlay identifiers must be unique.");
        ids.add(id);
        const type = ["text", "cta", "logo"].includes(overlay.type) ? overlay.type : null;
        if (!type) throw new AppError("INVALID_TEMPLATE", "This template overlay type is not supported.");
        const startRatio = number(overlay.startRatio, {
          label: "Overlay start",
          min: 0,
          max: 0.99,
          fallback: 0
        });
        const endRatio = number(overlay.endRatio, {
          label: "Overlay end",
          min: 0.01,
          max: 1,
          fallback: 1
        });
        if (endRatio <= startRatio) throw new AppError("INVALID_TEMPLATE", "Template overlay timing is invalid.");
        return {
          id,
          type,
          ...(type === "logo"
            ? { assetId: requireId(overlay.assetId, "Logo asset") }
            : {
                text: boundedString(overlay.text, {
                  label: type === "cta" ? "Call to action" : "Overlay text",
                  min: 1,
                  max: 240
                })
              }),
          startRatio,
          endRatio,
          x: number(overlay.x, { label: "Overlay horizontal position", min: 0, max: 1, fallback: 0.5 }),
          y: number(overlay.y, { label: "Overlay vertical position", min: 0, max: 1, fallback: 0.82 }),
          width: number(overlay.width, { label: "Overlay width", min: 0.05, max: 1, fallback: 0.72 }),
          opacity: number(overlay.opacity, { label: "Overlay opacity", min: 0.1, max: 1, fallback: 1 }),
          ...(type === "logo"
            ? {}
            : {
                fontScale: number(overlay.fontScale, { label: "Overlay text size", min: 0.5, max: 3, fallback: 1 }),
                textColor: color(overlay.textColor, "#ffffff"),
                backgroundColor: color(overlay.backgroundColor, type === "cta" ? "#101214" : "#000000")
              })
        };
      })
    }
  };
}

function hashSettings(settings) {
  return crypto.createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

function emptyStore() {
  return { schemaVersion: TEMPLATE_STORE_VERSION, templates: [], updatedAt: new Date().toISOString() };
}

function assertPortableDocument(value) {
  if (
    typeof value === "string" &&
    (value.includes("../") || value.includes("..\\") || /^[A-Za-z]:\\/.test(value) || value.startsWith("/"))
  ) {
    throw new AppError("INVALID_TEMPLATE_IMPORT", "Template imports cannot contain filesystem paths.");
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/(path|bookmark|credential|secret|token)$/i.test(key)) {
      throw new AppError("INVALID_TEMPLATE_IMPORT", "Template imports cannot contain private fields.");
    }
    assertPortableDocument(child);
  }
}

function validateTemplateStore(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== TEMPLATE_STORE_VERSION ||
    !Array.isArray(value.templates)
  ) {
    throw new AppError("INVALID_TEMPLATE_STORE", "The saved brand templates are invalid.");
  }
  const ids = new Set();
  value.templates = value.templates.map((template) => {
    const id = requireId(template?.id, "Brand template");
    if (ids.has(id)) throw new AppError("INVALID_TEMPLATE_STORE", "Brand template identifiers must be unique.");
    ids.add(id);
    const settings = normalizeTemplateSettings(template.settings);
    const version = Number(template.version);
    if (!Number.isInteger(version) || version < 1) throw new AppError("INVALID_TEMPLATE_STORE", "A template version is invalid.");
    const versions = (Array.isArray(template.versions) ? template.versions : []).slice(-TEMPLATE_VERSION_LIMIT).map((item) => {
      const itemSettings = normalizeTemplateSettings(item.settings);
      const itemHash = hashSettings(itemSettings);
      if (itemHash !== item.hash) throw new AppError("INVALID_TEMPLATE_STORE", "A template version hash is invalid.");
      return {
        version: Number(item.version),
        hash: itemHash,
        savedAt: boundedString(item.savedAt, { label: "Template save time", min: 1, max: 40 }),
        settings: itemSettings
      };
    });
    return {
      id,
      name: boundedString(template.name, { label: "Template name", min: 1, max: 100 }),
      description: boundedString(template.description, { label: "Template description", max: 500 }),
      version,
      hash: hashSettings(settings),
      settings,
      versions,
      createdAt: boundedString(template.createdAt, { label: "Template creation time", min: 1, max: 40 }),
      updatedAt: boundedString(template.updatedAt, { label: "Template update time", min: 1, max: 40 })
    };
  });
  return value;
}

function loadTemplateStore(filePath) {
  const backupPath = `${filePath}.bak`;
  const notices = [];
  if (!fs.existsSync(filePath)) {
    const data = emptyStore();
    writeJsonAtomic(filePath, data, { backup: false });
    return { data, notices };
  }
  try {
    const raw = readJson(filePath);
    if (Number(raw?.schemaVersion) > TEMPLATE_STORE_VERSION) {
      throw new AppError("FUTURE_TEMPLATE_STORE", "These brand templates were created by a newer ProduDash version.");
    }
    return { data: validateTemplateStore(raw), notices };
  } catch (error) {
    if (error instanceof AppError && error.code === "FUTURE_TEMPLATE_STORE") throw error;
    preserveFile(filePath, "recovery");
    if (fs.existsSync(backupPath)) {
      try {
        const data = validateTemplateStore(readJson(backupPath));
        writeJsonAtomic(filePath, data, { backup: false });
        notices.push({ code: "TEMPLATES_RECOVERED", message: "ProduDash recovered brand templates from backup." });
        return { data, notices };
      } catch {
        preserveFile(backupPath, "recovery");
      }
    }
    const data = emptyStore();
    writeJsonAtomic(filePath, data, { backup: false });
    notices.push({ code: "TEMPLATES_RESET", message: "Damaged brand-template data was preserved and reset." });
    return { data, notices };
  }
}

class TemplateStore {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.filePath = path.join(userDataPath, "produdash-templates.json");
    const loaded = loadTemplateStore(this.filePath);
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
    return this.data.templates.map((template) => clone(template));
  }

  get(templateId) {
    const template = this.data.templates.find((item) => item.id === requireId(templateId, "Brand template"));
    if (!template) throw new AppError("TEMPLATE_NOT_FOUND", "Brand template not found.");
    return clone(template);
  }

  async create(input) {
    const settings = normalizeTemplateSettings(input?.settings);
    const now = new Date().toISOString();
    const template = {
      id: createId("template"),
      name: boundedString(input?.name, { label: "Template name", min: 1, max: 100 }),
      description: boundedString(input?.description, { label: "Template description", max: 500 }),
      version: 1,
      hash: hashSettings(settings),
      settings,
      versions: [{ version: 1, hash: hashSettings(settings), savedAt: now, settings: clone(settings) }],
      createdAt: now,
      updatedAt: now
    };
    return this.enqueue(async () => {
      this.data.templates.unshift(template);
      this.persist();
      return this.get(template.id);
    });
  }

  async update(templateId, input) {
    return this.enqueue(async () => {
      const template = this.data.templates.find((item) => item.id === requireId(templateId, "Brand template"));
      if (!template) throw new AppError("TEMPLATE_NOT_FOUND", "Brand template not found.");
      template.name = boundedString(input?.name, { label: "Template name", min: 1, max: 100, fallback: template.name });
      template.description = boundedString(input?.description, {
        label: "Template description",
        max: 500,
        fallback: template.description
      });
      template.settings = normalizeTemplateSettings(input?.settings || template.settings);
      template.version += 1;
      template.hash = hashSettings(template.settings);
      template.updatedAt = new Date().toISOString();
      template.versions.push({
        version: template.version,
        hash: template.hash,
        savedAt: template.updatedAt,
        settings: clone(template.settings)
      });
      template.versions = template.versions.slice(-TEMPLATE_VERSION_LIMIT);
      this.persist();
      return this.get(template.id);
    });
  }

  async remove(templateId) {
    return this.enqueue(async () => {
      const id = requireId(templateId, "Brand template");
      const index = this.data.templates.findIndex((item) => item.id === id);
      if (index < 0) throw new AppError("TEMPLATE_NOT_FOUND", "Brand template not found.");
      this.data.templates.splice(index, 1);
      this.persist();
      return this.list();
    });
  }

  exportDocument(templateId) {
    const template = this.get(templateId);
    return {
      format: "produdash-brand-template",
      version: TEMPLATE_DOCUMENT_VERSION,
      name: template.name,
      description: template.description,
      settings: template.settings
    };
  }

  async importDocument(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.format !== "produdash-brand-template" ||
      value.version !== TEMPLATE_DOCUMENT_VERSION ||
      Object.keys(value).some((key) => !["format", "version", "name", "description", "settings"].includes(key))
    ) {
      throw new AppError("INVALID_TEMPLATE_IMPORT", "The selected file is not a supported ProduDash brand template.");
    }
    assertPortableDocument(value);
    return this.create(value);
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
      return [];
    });
  }
}

module.exports = {
  TEMPLATE_DOCUMENT_VERSION,
  TEMPLATE_STORE_VERSION,
  TEMPLATE_VERSION_LIMIT,
  TemplateStore,
  assertPortableDocument,
  emptyStore,
  hashSettings,
  loadTemplateStore,
  normalizeTemplateSettings,
  validateTemplateStore
};
