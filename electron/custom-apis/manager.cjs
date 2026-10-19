const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("../errors.cjs");
const { readJson, writeJsonAtomic } = require("../atomic-json.cjs");
const { CUSTOM_APIS } = require("./registry.cjs");

class CustomApiManager {
  constructor({ utilityProcess, userDataPath, supported = true, onEvent = () => {}, fetchImpl = fetch, startupTimeout = 30000 }) {
    Object.assign(this, { utilityProcess, userDataPath, supported, onEvent, fetchImpl, startupTimeout });
    this.file = path.join(userDataPath, "custom-api-config.json");
    this.config = {};
    this.configurationError = null;
    try {
      const saved = fs.existsSync(this.file) ? readJson(this.file) : {};
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error();
      this.config = saved;
    } catch {
      this.configurationError = "Saved custom API settings could not be read. Save the account again to repair them.";
    }
    this.runs = new Map();
  }
  definition(id) {
    if (!Object.hasOwn(CUSTOM_APIS, id)) throw new AppError("CUSTOM_API_UNKNOWN", "Unknown custom API.");
    return CUSTOM_APIS[id];
  }
  list() {
    return Object.values(CUSTOM_APIS).map((d) => {
      const run = this.runs.get(d.id);
      return {
        id: d.id,
        name: d.name,
        capabilities: [...d.capabilities],
        supported: this.supported,
        state: run?.state || "off",
        error: run?.error || this.configurationError,
        account: run?.account || null,
        configured: d.isConfigured(this.config[d.id]),
        ...d.publicConfiguration(this.config[d.id])
      };
    });
  }
  emit() {
    this.onEvent(this.list());
  }
  configure(id, input = {}) {
    const definition = this.definition(id);
    if (["starting", "running", "stopping"].includes(this.runs.get(id)?.state))
      throw new AppError("CUSTOM_API_BUSY", "Stop the API before changing its configuration.");
    this.config[id] = definition.configure(this.config[id] || {}, input);
    writeJsonAtomic(this.file, this.config, { mode: 0o600 });
    this.configurationError = null;
    this.emit();
    return this.list();
  }
  start(id) {
    const definition = this.definition(id);
    if (!this.supported) return Promise.reject(new AppError("CUSTOM_API_UNAVAILABLE", "Custom APIs are available in macOS builds only."));
    const previous = this.runs.get(id);
    if (previous?.state === "starting") return previous.startPromise;
    if (previous?.state === "running") return Promise.resolve(this.list());
    if (previous?.state === "stopping") return Promise.reject(new AppError("CUSTOM_API_STOPPING", "Wait for the API to stop."));
    const config = this.config[id];
    if (!definition.isConfigured(config))
      return Promise.reject(new AppError("CUSTOM_API_SETUP_REQUIRED", "Save the expected account first."));
    const dir = path.join(this.userDataPath, "custom-apis", id);
    fs.mkdirSync(path.join(dir, "media"), { recursive: true, mode: 0o700 });
    const run = { state: "starting", token: crypto.randomBytes(32).toString("hex"), account: null, pending: new Set() };
    this.runs.set(id, run);
    run.startPromise = new Promise((resolve, reject) => {
      let timer;
      const fail = () => {
        if (run.state === "off") return;
        clearTimeout(timer);
        run.state = "error";
        run.account = null;
        run.error = "The API stopped or could not start. Check dependencies and whether the dedicated browser profile is already in use.";
        run.child?.kill();
        this.emit();
        reject(new AppError("CUSTOM_API_FAILED", run.error));
      };
      try {
        run.child = this.utilityProcess.fork(path.join(__dirname, "worker.cjs"), [], {
          serviceName: definition.name,
          stdio: "ignore",
          env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
        });
        run.exitPromise = new Promise((done) => {
          run.resolveExit = done;
        });
        run.child.on("spawn", () =>
          run.child.postMessage({
            type: "start",
            entryPath: definition.entryPath,
            options: {
              apiKey: run.token,
              port: 0,
              runtimeDir: dir,
              ...definition.runtimeOptions(config, dir)
            }
          })
        );
        run.child.on("message", async (message) => {
          if (message?.type === "stopped") {
            run.state = "off";
            run.account = null;
            this.emit();
            return;
          }
          if (message?.type === "failed") {
            fail();
            return;
          }
          if (message?.type !== "ready" || run.state !== "starting") return;
          if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535) {
            fail();
            return;
          }
          run.port = message.port;
          try {
            const health = await this.rawRequest(run, "/v1/health");
            if (health.service !== id || health.protocol !== definition.protocol || health.ready !== true) throw new Error();
            clearTimeout(timer);
            run.state = "running";
            this.emit();
            resolve(this.list());
          } catch {
            fail();
          }
        });
        run.child.on("error", fail);
        run.child.on("exit", () => {
          if (run.state !== "off" && run.state !== "stopping" && run.state !== "error") fail();
          run.exited = true;
          run.resolveExit?.();
        });
        timer = setTimeout(fail, this.startupTimeout);
      } catch {
        fail();
      }
    });
    this.emit();
    return run.startPromise;
  }
  async rawRequest(run, route, body, key) {
    let response;
    try {
      response = await this.fetchImpl(`http://127.0.0.1:${run.port}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${run.token}`, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(body === undefined ? 30000 : 600000)
      });
      const data = await response.json();
      if (!response.ok) {
        const known = new Set([
          "account_mismatch",
          "browser_login_required",
          "recipient_ambiguous",
          "recipient_mismatch",
          "message_outcome_unknown",
          "outcome_unknown",
          "idempotency_conflict"
        ]);
        const code = known.has(data?.error?.code) ? data.error.code.toUpperCase() : "CUSTOM_API_REQUEST_FAILED";
        throw new AppError(
          code,
          code === "ACCOUNT_MISMATCH"
            ? "The browser is signed into a different account."
            : code === "BROWSER_LOGIN_REQUIRED"
              ? "Sign in using the dedicated browser, then check the account."
              : "The API operation failed. Refresh the selected account or inspect TikTok before retrying a write."
        );
      }
      return data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("CUSTOM_API_OUTCOME_UNKNOWN", "The API response was lost. Inspect TikTok before retrying a write.");
    }
  }
  async request(id, route, body, key) {
    this.definition(id);
    const run = this.runs.get(id);
    if (run?.state !== "running") throw new AppError("CUSTOM_API_OFF", "Start the API in Integrations first.");
    const task = this.rawRequest(run, route, body, key);
    run.pending.add(task);
    try {
      return await task;
    } catch (error) {
      if (["ACCOUNT_MISMATCH", "BROWSER_LOGIN_REQUIRED"].includes(error.code)) {
        run.account = null;
        this.emit();
      }
      throw error;
    } finally {
      run.pending.delete(task);
    }
  }
  async session(id, action) {
    if (!["open", "check"].includes(action)) throw new AppError("INVALID_INPUT", "Unknown session action.");
    const run = this.runs.get(id);
    try {
      const result = await this.request(id, `/v1/session/${action}`, {});
      if (action === "check") run.account = result.account;
      else run.account = null;
      this.emit();
      return this.list();
    } catch (error) {
      if (run) run.account = null;
      this.emit();
      throw error;
    }
  }
  account(id) {
    const run = this.runs.get(id);
    if (run?.state !== "running" || !run.account)
      throw new AppError("CUSTOM_API_ACCOUNT_REQUIRED", "Start the API and check its browser account in Integrations.");
    return run.account;
  }
  async stageMedia(id, filePath, key) {
    this.account(id);
    if (!/^[a-f0-9]{64}$/.test(key)) throw new AppError("INVALID_INPUT", "Invalid publication key.");
    const extension = path.extname(filePath).toLowerCase();
    if (![".mp4", ".mov", ".webm"].includes(extension)) throw new AppError("INVALID_INPUT", "TikTok requires MP4, MOV or WebM media.");
    const name = key + extension;
    const target = path.join(this.userDataPath, "custom-apis", id, "media", name);
    // Retrying a frozen approval must not silently stage a changed render.
    if (fs.existsSync(target)) {
      const digest = async (file) => {
        const hash = crypto.createHash("sha256");
        for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
        return hash.digest("hex");
      };
      if ((await digest(filePath)) !== (await digest(target)))
        throw new AppError("APPROVED_MEDIA_CHANGED", "The rendered file changed after staging. Inspect TikTok and create a new approval.");
    } else {
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.promises.copyFile(filePath, temporary, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, target);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
    return name;
  }
  stop(id) {
    this.definition(id);
    const run = this.runs.get(id);
    if (!run || ["off", "error"].includes(run.state)) return Promise.resolve(this.list());
    if (run.stopPromise) return run.stopPromise;
    run.stopPromise = (async () => {
      if (run.state === "starting") await run.startPromise.catch(() => {});
      if (run.state === "error" || run.exited) {
        run.state = "off";
        run.account = null;
        this.emit();
        return this.list();
      }
      run.state = "stopping";
      this.emit();
      await Promise.allSettled([...run.pending]);
      if (!run.exited) run.child.postMessage({ type: "stop" });
      await run.exitPromise;
      run.state = "off";
      run.account = null;
      run.token = null;
      this.emit();
      return this.list();
    })();
    return run.stopPromise;
  }
  async clear() {
    await Promise.all([...this.runs.keys()].map((id) => this.stop(id)));
    this.config = {};
    this.runs.clear();
    this.configurationError = null;
    fs.rmSync(path.join(this.userDataPath, "custom-apis"), { recursive: true, force: true });
    for (const file of [this.file, `${this.file}.bak`]) fs.rmSync(file, { force: true });
    // Externally selected dedicated profiles are user-owned and never removed.
    this.emit();
  }
  async shutdown(timeout = 10000) {
    const stop = Promise.allSettled([...this.runs.keys()].map((id) => this.stop(id)));
    let timer;
    await Promise.race([
      stop,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeout);
      })
    ]);
    clearTimeout(timer);
    for (const run of this.runs.values()) {
      if (!["off", "error"].includes(run.state)) run.child?.kill();
      run.state = "off";
      run.account = null;
      run.token = null;
    }
  }
}
module.exports = { CustomApiManager };
