const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("../errors.cjs");
const { preserveFile, readJson, writeJsonAtomic } = require("../atomic-json.cjs");

const ADVISOR_HISTORY_VERSION = 1;
const ADVISOR_HISTORY_LIMIT = 50;
const ROLE_LIMITS = Object.freeze({ user: 4000, assistant: 12000 });
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function emptyAdvisorHistory() {
  return {
    schemaVersion: ADVISOR_HISTORY_VERSION,
    turns: [],
    updatedAt: new Date().toISOString()
  };
}

function normalizeIso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new AppError("INVALID_ADVISOR_HISTORY", "Advisor history contains an invalid date.");
  return date.toISOString();
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
    const count = Number(value[key]);
    if (Number.isInteger(count) && count >= 0 && count <= 10_000_000) result[key] = count;
  }
  return Object.keys(result).length ? result : null;
}

function normalizeTurn(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_ADVISOR_HISTORY", "Advisor history contains an invalid turn.");
  }
  const role = value.role;
  if (!Object.hasOwn(ROLE_LIMITS, role)) {
    throw new AppError("INVALID_ADVISOR_HISTORY", "Advisor history contains an invalid role.");
  }
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!text || text.length > ROLE_LIMITS[role]) {
    throw new AppError("INVALID_ADVISOR_HISTORY", "Advisor history contains invalid visible text.");
  }
  const id = String(value.id || "");
  if (!ID_PATTERN.test(id)) throw new AppError("INVALID_ADVISOR_HISTORY", "Advisor history contains an invalid identifier.");
  const tools = Array.isArray(value.tools)
    ? [...new Set(value.tools.filter((tool) => typeof tool === "string" && ID_PATTERN.test(tool)))].slice(0, 5)
    : [];
  return {
    id,
    role,
    text,
    at: normalizeIso(value.at),
    providerId: typeof value.providerId === "string" && ID_PATTERN.test(value.providerId) ? value.providerId : null,
    modelId: typeof value.modelId === "string" ? value.modelId.slice(0, 200) : null,
    usage: normalizeUsage(value.usage),
    tools
  };
}

function validateAdvisorHistory(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== ADVISOR_HISTORY_VERSION ||
    !Array.isArray(value.turns) ||
    value.turns.length > ADVISOR_HISTORY_LIMIT
  ) {
    throw new AppError("INVALID_ADVISOR_HISTORY", "The saved Advisor history is invalid.");
  }
  return {
    schemaVersion: ADVISOR_HISTORY_VERSION,
    turns: value.turns.map(normalizeTurn),
    updatedAt: normalizeIso(value.updatedAt)
  };
}

function loadAdvisorHistory(filePath) {
  const backupPath = `${filePath}.bak`;
  const notices = [];
  if (!fs.existsSync(filePath)) {
    const history = emptyAdvisorHistory();
    writeJsonAtomic(filePath, history, { backup: false });
    return { history, notices };
  }
  try {
    const raw = readJson(filePath);
    if (Number(raw?.schemaVersion) > ADVISOR_HISTORY_VERSION) {
      throw new AppError("FUTURE_ADVISOR_HISTORY", "This Advisor history was created by a newer ProduDash version.");
    }
    return { history: validateAdvisorHistory(raw), notices };
  } catch (error) {
    if (error instanceof AppError && error.code === "FUTURE_ADVISOR_HISTORY") throw error;
    preserveFile(filePath, "recovery");
    if (fs.existsSync(backupPath)) {
      try {
        const history = validateAdvisorHistory(readJson(backupPath));
        writeJsonAtomic(filePath, history, { backup: false });
        notices.push({
          code: "ADVISOR_HISTORY_RECOVERED",
          message: "ProduDash recovered visible Advisor history from its last known-good backup."
        });
        return { history, notices };
      } catch {
        preserveFile(backupPath, "recovery");
      }
    }
    const history = emptyAdvisorHistory();
    writeJsonAtomic(filePath, history, { backup: false });
    notices.push({
      code: "ADVISOR_HISTORY_RESET",
      message: "Damaged Advisor history was preserved and a clean history was opened."
    });
    return { history, notices };
  }
}

class AdvisorHistory {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.filePath = path.join(userDataPath, "produdash-advisor-history.json");
    const loaded = loadAdvisorHistory(this.filePath);
    this.history = loaded.history;
    this.notices = loaded.notices;
    this.mutationQueue = Promise.resolve();
  }

  enqueue(callback) {
    const run = this.mutationQueue.then(callback, callback);
    this.mutationQueue = run.catch(() => {});
    return run;
  }

  getNotices() {
    return structuredClone(this.notices);
  }

  list() {
    return structuredClone(this.history);
  }

  async append(turn) {
    return this.enqueue(async () => {
      this.history.turns.push(normalizeTurn(turn));
      this.history.turns = this.history.turns.slice(-ADVISOR_HISTORY_LIMIT);
      this.history.updatedAt = new Date().toISOString();
      writeJsonAtomic(this.filePath, this.history);
      return this.list();
    });
  }

  async clear(options = {}) {
    return this.enqueue(async () => {
      this.history = emptyAdvisorHistory();
      if (options.removeFiles) {
        const baseName = path.basename(this.filePath);
        if (fs.existsSync(this.userDataPath)) {
          for (const entry of fs.readdirSync(this.userDataPath)) {
            if (entry === baseName || entry === `${baseName}.bak` || entry.startsWith(`${baseName}.recovery-`)) {
              fs.unlinkSync(path.join(this.userDataPath, entry));
            }
          }
        }
      }
      if (!options.removeFiles) writeJsonAtomic(this.filePath, this.history, { backup: false });
      return this.list();
    });
  }
}

module.exports = {
  ADVISOR_HISTORY_LIMIT,
  ADVISOR_HISTORY_VERSION,
  AdvisorHistory,
  emptyAdvisorHistory,
  loadAdvisorHistory,
  normalizeTurn,
  validateAdvisorHistory
};
