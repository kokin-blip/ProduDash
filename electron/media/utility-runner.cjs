const path = require("node:path");
const { AppError } = require("../errors.cjs");

const TERMINAL_TYPES = new Set(["awaiting_review", "completed", "canceled", "error"]);

function workerEnvironment(environment = process.env) {
  const allowed = ["PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "PRODUDASH_PACKAGED", "PRODUDASH_RESOURCES_PATH"];
  return Object.fromEntries(allowed.filter((key) => environment[key]).map((key) => [key, environment[key]]));
}

class MediaUtilityRunner {
  constructor({ utilityProcess, workerPath = path.join(__dirname, "media-worker.cjs"), environment } = {}) {
    this.utilityProcess = utilityProcess;
    this.workerPath = workerPath;
    this.environment = workerEnvironment(environment);
  }

  start(job, onMessage = () => {}) {
    if (!this.utilityProcess?.fork) {
      throw new AppError("MEDIA_TOOLS_UNAVAILABLE", "The isolated local media worker is unavailable.");
    }
    const child = this.utilityProcess.fork(this.workerPath, [], {
      serviceName: "ProduDash Media Worker",
      stdio: "ignore",
      env: this.environment
    });
    let terminal = false;
    let forceTimer = null;
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const stop = () => {
      if (forceTimer) clearTimeout(forceTimer);
      forceTimer = null;
      child.kill();
    };
    child.on("spawn", () => child.postMessage({ type: "run", job }));
    child.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "progress") {
        onMessage(message);
        return;
      }
      if (!TERMINAL_TYPES.has(message.type) || terminal) return;
      terminal = true;
      resolveResult(message);
      stop();
    });
    child.on("error", () => {
      if (terminal) return;
      terminal = true;
      rejectResult(new AppError("MEDIA_WORKER_FAILED", "The isolated local media worker could not be started."));
    });
    child.on("exit", () => {
      if (terminal) return;
      terminal = true;
      rejectResult(new AppError("MEDIA_WORKER_INTERRUPTED", "The isolated local media worker stopped unexpectedly."));
    });
    return {
      result,
      cancel() {
        if (terminal) return;
        child.postMessage({ type: "cancel" });
        forceTimer = setTimeout(() => {
          if (!terminal) child.kill();
        }, 5_000);
      }
    };
  }
}

module.exports = { MediaUtilityRunner, TERMINAL_TYPES, workerEnvironment };
