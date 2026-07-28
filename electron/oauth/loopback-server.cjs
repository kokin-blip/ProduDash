const http = require("node:http");
const { AppError } = require("../errors.cjs");
const { safeStateEquals } = require("./pkce.cjs");

// A single-use loopback listener for an OAuth authorization code.
//
// Deliberately narrow: it binds only to 127.0.0.1, accepts exactly one callback
// on exactly one path, validates `state` in constant time, times out, and closes
// itself in every exit path. The authorization code is never logged, never
// echoed into the browser response, and never stored on the instance after it is
// handed to the caller.
const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_PATH = "/callback";

// Kept deliberately plain: no scripts, no external references, no request data
// reflected back into the page.
const SUCCESS_BODY =
  "<!doctype html><meta charset=utf-8><title>ProduDash</title>" +
  "<p>Authorization received. You can close this tab and return to ProduDash.</p>";
const FAILURE_BODY =
  "<!doctype html><meta charset=utf-8><title>ProduDash</title>" + "<p>Authorization failed. Return to ProduDash for details.</p>";

class LoopbackAuthorizationListener {
  constructor(options = {}) {
    this.path = options.path || DEFAULT_PATH;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.expectedState = options.expectedState || "";
    this.server = null;
    this.port = null;
    this.settled = false;
    this.timer = null;
    this.pending = null;
    this.outcome = null;
  }

  get redirectUri() {
    if (!this.port) throw new AppError("OAUTH_LISTENER_NOT_STARTED", "The authorization listener is not running.");
    return `http://${LOOPBACK_HOST}:${this.port}${this.path}`;
  }

  // Port 0 asks the OS for an available port; binding to 127.0.0.1 keeps the
  // listener off every other interface.
  async start() {
    if (this.server) throw new AppError("OAUTH_LISTENER_RUNNING", "The authorization listener is already running.");
    this.server = http.createServer((request, response) => this.handleRequest(request, response));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, LOOPBACK_HOST, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    this.port = this.server.address().port;
    // The clock starts as soon as the socket is open, so an authorization that
    // is never awaited still closes itself.
    this.timer = setTimeout(() => {
      this.settle(new AppError("OAUTH_TIMEOUT", "The authorization window expired before it completed."));
    }, this.timeoutMs);
    // A pending timer must not hold the app open.
    this.timer.unref?.();
    return { port: this.port, redirectUri: this.redirectUri };
  }

  handleRequest(request, response) {
    let url;
    try {
      url = new URL(request.url, `http://${LOOPBACK_HOST}:${this.port}`);
    } catch {
      return this.rejectRequest(response, 400);
    }
    // Anything other than the exact callback path is not part of this flow.
    if (url.pathname !== this.path) return this.rejectRequest(response, 404);
    // A second callback must not be able to overwrite the first result.
    if (this.settled) return this.rejectRequest(response, 409);

    const params = url.searchParams;
    const providerError = params.get("error");
    const state = params.get("state");
    const code = params.get("code");

    // Check state before anything else so a mismatched callback cannot even
    // reveal whether a code was present.
    if (!safeStateEquals(this.expectedState, state || "")) {
      this.respond(response, 400, FAILURE_BODY);
      return this.settle(new AppError("OAUTH_STATE_MISMATCH", "The authorization response did not match this request."));
    }
    if (providerError) {
      this.respond(response, 400, FAILURE_BODY);
      const denied = providerError === "access_denied";
      return this.settle(
        new AppError(
          denied ? "OAUTH_CANCELED" : "OAUTH_PROVIDER_ERROR",
          denied ? "Authorization was canceled." : "The provider refused the authorization request."
        )
      );
    }
    if (!code) {
      this.respond(response, 400, FAILURE_BODY);
      return this.settle(new AppError("OAUTH_NO_CODE", "The authorization response contained no code."));
    }
    this.respond(response, 200, SUCCESS_BODY);
    return this.settle(null, code);
  }

  rejectRequest(response, status) {
    this.respond(response, status, FAILURE_BODY);
  }

  respond(response, status, body) {
    response.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      // The page is inert, but say so explicitly.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer"
    });
    response.end(body);
  }

  // The outcome is buffered rather than pushed straight into a promise. A
  // callback can arrive before the caller starts awaiting -- if the rejection
  // were created at that moment it would briefly be an unhandled rejection,
  // which Node treats as fatal by default.
  settle(error, code) {
    if (this.settled) return undefined;
    this.settled = true;
    this.outcome = error ? { error } : { code };
    this.close();
    if (this.pending) this.deliver();
    return undefined;
  }

  deliver() {
    const pending = this.pending;
    this.pending = null;
    const outcome = this.outcome;
    // The code is handed straight to the caller and never retained here.
    this.outcome = outcome.error ? outcome : { code: null };
    if (outcome.error) pending.reject(outcome.error);
    else pending.resolve({ code: outcome.code });
  }

  // Resolves with the authorization code, or rejects with a specific reason:
  // canceled, state mismatch, provider error, or timeout. Safe to call either
  // before or after the callback arrives.
  waitForCallback() {
    if (this.pending) throw new AppError("OAUTH_LISTENER_RUNNING", "The authorization listener is already awaited.");
    if (!this.server && !this.outcome) {
      throw new AppError("OAUTH_LISTENER_NOT_STARTED", "The authorization listener is not running.");
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      if (this.outcome) this.deliver();
    });
  }

  close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.server) {
      this.server.close();
      this.server.closeAllConnections?.();
      this.server = null;
    }
  }
}

async function createLoopbackListener(options = {}) {
  const listener = new LoopbackAuthorizationListener(options);
  await listener.start();
  return listener;
}

module.exports = { DEFAULT_PATH, DEFAULT_TIMEOUT_MS, LOOPBACK_HOST, LoopbackAuthorizationListener, createLoopbackListener };
