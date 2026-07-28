const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { CHALLENGE_ENCODINGS, createCodeChallenge, createPkcePair, createState, safeStateEquals } = require("../electron/oauth/pkce.cjs");
const { LOOPBACK_HOST, createLoopbackListener } = require("../electron/oauth/loopback-server.cjs");
const { AUTHORIZATION_ENDPOINT, TOKEN_ENDPOINT, YouTubeConnector } = require("../electron/connectors/youtube.cjs");

// --- PKCE ------------------------------------------------------------------

test("code verifiers satisfy RFC 7636 and never repeat", () => {
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) {
    const { codeVerifier } = createPkcePair();
    assert.match(codeVerifier, /^[A-Za-z0-9\-._~]{43,128}$/);
    assert.equal(seen.has(codeVerifier), false, "verifiers must be unique per attempt");
    seen.add(codeVerifier);
  }
});

test("the challenge encoding is a parameter, because providers disagree", () => {
  const verifier = "a".repeat(43);
  const digest = crypto.createHash("sha256").update(verifier).digest();
  // Google: base64url per the RFC. TikTok desktop: hex of the same digest.
  assert.equal(createCodeChallenge(verifier, CHALLENGE_ENCODINGS.BASE64URL), digest.toString("base64url"));
  assert.equal(createCodeChallenge(verifier, CHALLENGE_ENCODINGS.HEX), digest.toString("hex"));
  assert.notEqual(createCodeChallenge(verifier, "base64url"), createCodeChallenge(verifier, "hex"));
  assert.throws(() => createCodeChallenge(verifier, "base64"), { code: "INVALID_PKCE_ENCODING" });
  assert.throws(() => createCodeChallenge("too-short", "hex"), { code: "INVALID_PKCE_VERIFIER" });
});

test("state comparison rejects mismatches without throwing on length", () => {
  const state = createState();
  assert.equal(safeStateEquals(state, state), true);
  assert.equal(safeStateEquals(state, `${state}x`), false);
  assert.equal(safeStateEquals(state, ""), false);
  assert.equal(safeStateEquals(state, null), false);
});

// --- Loopback listener -----------------------------------------------------

async function get(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}

test("the listener binds only to loopback on a random port", async () => {
  const listener = await createLoopbackListener({ expectedState: "s" });
  try {
    assert.match(listener.redirectUri, new RegExp(`^http://${LOOPBACK_HOST}:\\d+/callback$`));
    assert.ok(listener.port > 0);
    assert.equal(listener.server.address().address, LOOPBACK_HOST);
  } finally {
    listener.close();
  }
});

test("a valid callback yields the code and closes the listener", async () => {
  const listener = await createLoopbackListener({ expectedState: "expected-state" });
  const waiting = listener.waitForCallback();
  const response = await get(`${listener.redirectUri}?code=auth-code-1&state=expected-state`);
  assert.equal(response.status, 200);
  // The page must not echo the authorization code back into the browser.
  assert.equal(response.body.includes("auth-code-1"), false);
  assert.deepEqual(await waiting, { code: "auth-code-1" });
  assert.equal(listener.server, null, "listener closes itself after settling");
});

test("a mismatched state is rejected and no code is returned", async () => {
  const listener = await createLoopbackListener({ expectedState: "expected-state" });
  const waiting = listener.waitForCallback();
  const expectation = assert.rejects(() => waiting, { code: "OAUTH_STATE_MISMATCH" });
  const response = await get(`${listener.redirectUri}?code=should-not-be-used&state=wrong`);
  assert.equal(response.status, 400);
  await expectation;
});

test("unexpected paths are refused and do not settle the flow", async () => {
  const listener = await createLoopbackListener({ expectedState: "s", timeoutMs: 200 });
  const waiting = listener.waitForCallback();
  const probe = await get(`http://${LOOPBACK_HOST}:${listener.port}/not-the-callback?code=x&state=s`);
  assert.equal(probe.status, 404);
  // The flow is still open, and eventually times out rather than succeeding.
  await assert.rejects(() => waiting, { code: "OAUTH_TIMEOUT" });
});

test("a duplicate callback cannot overwrite the first result", async () => {
  const listener = await createLoopbackListener({ expectedState: "s" });
  const waiting = listener.waitForCallback();
  const first = await get(`${listener.redirectUri}?code=first&state=s`);
  assert.equal(first.status, 200);
  assert.deepEqual(await waiting, { code: "first" });
  // The server is closed, so a second callback cannot be delivered at all.
  await assert.rejects(() => get(`${listener.redirectUri}?code=second&state=s`));
});

test("a user-canceled authorization is reported as canceled, not as an error", async () => {
  const listener = await createLoopbackListener({ expectedState: "s" });
  const waiting = listener.waitForCallback();
  const expectation = assert.rejects(() => waiting, { code: "OAUTH_CANCELED" });
  await get(`${listener.redirectUri}?error=access_denied&state=s`);
  await expectation;
});

test("a callback that arrives before anyone awaits is buffered, not lost", async () => {
  // The connector opens the browser between starting the listener and awaiting
  // it. If the outcome were pushed straight into a promise, a callback landing
  // in that window would be an unhandled rejection, which Node treats as fatal.
  const listener = await createLoopbackListener({ expectedState: "s" });
  const response = await get(`${listener.redirectUri}?code=early&state=s`);
  assert.equal(response.status, 200);
  assert.deepEqual(await listener.waitForCallback(), { code: "early" });
});

test("an early failure is also buffered rather than rejecting into the void", async () => {
  const listener = await createLoopbackListener({ expectedState: "s" });
  await get(`${listener.redirectUri}?error=access_denied&state=s`);
  await assert.rejects(() => listener.waitForCallback(), { code: "OAUTH_CANCELED" });
});

test("the listener times out instead of waiting forever", async () => {
  const listener = await createLoopbackListener({ expectedState: "s", timeoutMs: 100 });
  await assert.rejects(() => listener.waitForCallback(), { code: "OAUTH_TIMEOUT" });
  assert.equal(listener.server, null);
});

// --- YouTube connector -----------------------------------------------------

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// A listener stub so tests never bind a socket or open a browser.
function fakeListener(callbackResult = { code: "code-1" }) {
  return {
    redirectUri: "http://127.0.0.1:12345/callback",
    waitForCallback: async () => callbackResult,
    close() {
      this.closed = true;
    },
    closed: false
  };
}

function createConnector({ responses = [], listener = fakeListener(), openExternal = async () => {}, now = () => 1_700_000_000_000 } = {}) {
  const requests = [];
  const connector = new YouTubeConnector({
    transport: async (url, options) => {
      requests.push({ url, options });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request to ${url}`);
      return next;
    },
    openExternal,
    createListener: async () => listener,
    now
  });
  return { connector, requests, listener };
}

test("authorization is opened in the system browser with PKCE and a state", async () => {
  let openedUrl = null;
  const { connector } = createConnector({
    openExternal: async (url) => {
      openedUrl = url;
    },
    responses: [jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "a b" })]
  });

  const result = await connector.authorize({ clientId: "client-1" });
  const url = new URL(openedUrl);
  assert.equal(`${url.origin}${url.pathname}`, AUTHORIZATION_ENDPOINT);
  assert.equal(url.searchParams.get("client_id"), "client-1");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.ok(url.searchParams.get("state"));
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:12345/callback");
  // Required to receive a refresh token at all.
  assert.equal(url.searchParams.get("access_type"), "offline");
  // Scopes come from the registry, not from a literal here.
  assert.equal(url.searchParams.get("scope").split(" ").length, 2);

  assert.equal(result.accessToken, "at");
  assert.equal(result.refreshToken, "rt");
  assert.deepEqual(result.grantedScopes, ["a", "b"]);
  assert.ok(result.tokenExpiresAt);
});

test("the client secret is sent only when the user supplied one", async () => {
  const withoutSecret = createConnector({ responses: [jsonResponse({ access_token: "at", expires_in: 60 })] });
  await withoutSecret.connector.authorize({ clientId: "c" });
  assert.equal(new URLSearchParams(withoutSecret.requests[0].options.body).has("client_secret"), false);

  const withSecret = createConnector({ responses: [jsonResponse({ access_token: "at", expires_in: 60 })] });
  await withSecret.connector.authorize({ clientId: "c", clientSecret: "s" });
  assert.equal(new URLSearchParams(withSecret.requests[0].options.body).get("client_secret"), "s");
});

test("the exchange sends the verifier that matches the challenge that was sent", async () => {
  let openedUrl = null;
  const { connector, requests } = createConnector({
    openExternal: async (url) => {
      openedUrl = url;
    },
    responses: [jsonResponse({ access_token: "at", expires_in: 60 })]
  });
  await connector.authorize({ clientId: "c" });
  const sentChallenge = new URL(openedUrl).searchParams.get("code_challenge");
  const sentVerifier = new URLSearchParams(requests[0].options.body).get("code_verifier");
  assert.equal(createCodeChallenge(sentVerifier, CHALLENGE_ENCODINGS.BASE64URL), sentChallenge);
  assert.equal(requests[0].url, TOKEN_ENDPOINT);
});

test("the listener is closed even when authorization fails", async () => {
  const listener = fakeListener();
  listener.waitForCallback = async () => {
    throw Object.assign(new Error("canceled"), { code: "OAUTH_CANCELED" });
  };
  const { connector } = createConnector({ listener });
  await assert.rejects(() => connector.authorize({ clientId: "c" }));
  assert.equal(listener.closed, true);
});

test("authorization requires a configured client id and a real browser", async () => {
  const { connector } = createConnector();
  await assert.rejects(() => connector.authorize({}), { code: "CONNECTOR_NOT_CONFIGURED" });

  const headless = new YouTubeConnector({ transport: async () => jsonResponse({}), openExternal: null });
  await assert.rejects(() => headless.authorize({ clientId: "c" }), { code: "OAUTH_BROWSER_UNAVAILABLE" });
});

test("testConnection identifies the channel before reporting connected", async () => {
  const { connector } = createConnector({
    responses: [jsonResponse({ items: [{ id: "UC-abc", snippet: { title: "My channel" } }] })]
  });
  const result = await connector.testConnection({ clientId: "c", oauthAccessToken: "at" });
  assert.equal(result.status, "connected");
  assert.deepEqual(result.authorizationUpdate.selectedAccount, { id: "UC-abc", name: "My channel" });
});

test("an account with no channel is an authorization failure, not a connection", async () => {
  const { connector } = createConnector({ responses: [jsonResponse({ items: [] })] });
  await assert.rejects(() => connector.testConnection({ clientId: "c", oauthAccessToken: "at" }), { code: "YOUTUBE_NO_CHANNEL" });
});

test("testConnection refuses to run before an authorization exists", async () => {
  const { connector } = createConnector();
  await assert.rejects(() => connector.testConnection({ clientId: "c" }), { code: "YOUTUBE_NOT_AUTHORIZED" });
});

test("an expired token is refreshed proactively", async () => {
  const now = () => Date.parse("2026-07-27T12:00:00.000Z");
  const { connector, requests } = createConnector({
    now,
    responses: [
      jsonResponse({ access_token: "fresh", expires_in: 3600, scope: "a" }),
      jsonResponse({ items: [{ id: "UC-1", snippet: { title: "Chan" } }] })
    ]
  });
  const result = await connector.testConnection({
    clientId: "c",
    oauthAccessToken: "stale",
    oauthRefreshToken: "rt",
    tokenExpiresAt: "2026-07-27T11:59:00.000Z"
  });
  assert.equal(requests[0].url, TOKEN_ENDPOINT);
  assert.equal(new URLSearchParams(requests[0].options.body).get("grant_type"), "refresh_token");
  // The channel request uses the refreshed token, not the stale one.
  assert.equal(requests[1].options.headers.Authorization, "Bearer fresh");
  assert.equal(result.authorizationUpdate.accessToken, "fresh");
});

test("a rejected token is refreshed reactively, exactly once", async () => {
  const { connector, requests } = createConnector({
    responses: [
      jsonResponse({}, 401),
      jsonResponse({ access_token: "fresh", expires_in: 3600 }),
      jsonResponse({ items: [{ id: "UC-1", snippet: { title: "Chan" } }] })
    ]
  });
  const result = await connector.testConnection({ clientId: "c", oauthAccessToken: "stale", oauthRefreshToken: "rt" });
  assert.equal(requests.length, 3);
  assert.equal(result.status, "connected");
});

test("a rejected token with no refresh token fails without a retry loop", async () => {
  const { connector, requests } = createConnector({ responses: [jsonResponse({}, 401)] });
  await assert.rejects(() => connector.testConnection({ clientId: "c", oauthAccessToken: "stale" }), { code: "YOUTUBE_AUTH_FAILED" });
  assert.equal(requests.length, 1);
});

test("refreshing without a stored refresh token is an explicit failure", async () => {
  const { connector } = createConnector();
  await assert.rejects(() => connector.refreshAuthorization({ clientId: "c" }), { code: "YOUTUBE_NO_REFRESH_TOKEN" });
});

test("provider failures are categorized with honest retryability", async () => {
  const cases = [
    [401, "YOUTUBE_AUTH_FAILED", "authentication", false],
    [403, "YOUTUBE_FORBIDDEN", "authorization", false],
    [429, "YOUTUBE_RATE_LIMITED", "rate_limit", true],
    [503, "YOUTUBE_SERVER_ERROR", "processing", true],
    [400, "YOUTUBE_REQUEST_REJECTED", "validation", false]
  ];
  for (const [status, code, category, retryable] of cases) {
    const { connector } = createConnector({ responses: [jsonResponse({}, status)] });
    await assert.rejects(
      () => connector.testConnection({ clientId: "c", oauthAccessToken: "at" }),
      (error) => {
        assert.equal(error.code, code, `status ${status}`);
        assert.equal(error.category, category);
        assert.equal(error.retryable, retryable);
        return true;
      }
    );
  }
});

test("errors never carry the token or the client secret", async () => {
  const { connector } = createConnector({ responses: [jsonResponse({ error: "invalid_grant", token: "ya29.leak" }, 401)] });
  await assert.rejects(
    () => connector.testConnection({ clientId: "c", clientSecret: "super-secret", oauthAccessToken: "ya29.leak" }),
    (error) => {
      const serialized = `${error.code} ${error.message}`;
      assert.equal(serialized.includes("ya29.leak"), false);
      assert.equal(serialized.includes("super-secret"), false);
      return true;
    }
  );
});

test("disconnect revokes at Google and tolerates an already-invalid token", async () => {
  const revoked = createConnector({ responses: [jsonResponse({})] });
  assert.deepEqual(await revoked.connector.disconnect({ oauthRefreshToken: "rt" }), { revoked: true });
  assert.equal(revoked.requests[0].url, "https://oauth2.googleapis.com/revoke");

  const stale = createConnector({ responses: [jsonResponse({}, 400)] });
  assert.deepEqual(await stale.connector.disconnect({ oauthAccessToken: "at" }), { revoked: false, reason: "already_invalid" });

  const nothing = createConnector();
  assert.deepEqual(await nothing.connector.disconnect({}), { revoked: false, reason: "no_token" });
});

// --- Upload ----------------------------------------------------------------

function uploadResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body
  };
}

test("publishing opens a resumable session then uploads the bytes", async () => {
  const { connector, requests } = createConnector({
    responses: [
      uploadResponse({}, { headers: { location: "https://upload.example/session-1" } }),
      uploadResponse({ id: "vid-1", status: { privacyStatus: "private", uploadStatus: "uploaded" } }, { status: 201 })
    ]
  });
  const result = await connector.publish({
    accessToken: "at",
    title: "Title",
    description: "Body",
    privacyStatus: "private",
    media: { body: "bytes", contentLength: 5, contentType: "video/mp4" }
  });

  const initiate = new URL(requests[0].url);
  assert.equal(initiate.searchParams.get("uploadType"), "resumable");
  assert.equal(initiate.searchParams.get("part"), "snippet,status");
  assert.equal(requests[0].options.headers["X-Upload-Content-Length"], "5");
  assert.equal(requests[0].options.headers["X-Upload-Content-Type"], "video/mp4");
  assert.deepEqual(JSON.parse(requests[0].options.body).snippet, { title: "Title", description: "Body" });

  // Bytes go to the session URI from the Location header, not the API endpoint.
  assert.equal(requests[1].url, "https://upload.example/session-1");
  assert.equal(requests[1].options.method, "PUT");
  assert.equal(result.publicationId, "vid-1");
});

test("privacy defaults to private and reports what YouTube actually applied", async () => {
  const { connector, requests } = createConnector({
    responses: [
      uploadResponse({}, { headers: { location: "https://upload.example/s" } }),
      // An unaudited project has its uploads forced to private regardless.
      uploadResponse({ id: "vid-2", status: { privacyStatus: "private" } }, { status: 201 })
    ]
  });
  const result = await connector.publish({
    accessToken: "at",
    title: "T",
    privacyStatus: "public",
    media: { body: "b", contentLength: 1 }
  });
  assert.equal(result.requestedPrivacyStatus, "public");
  assert.equal(result.privacyStatus, "private");

  // An unrecognized privacy value falls back to private, never to public.
  const fallback = createConnector({
    responses: [uploadResponse({}, { headers: { location: "https://u/s" } }), uploadResponse({ id: "v" }, { status: 201 })]
  });
  await fallback.connector.publish({ accessToken: "at", title: "T", privacyStatus: "everyone", media: { body: "b", contentLength: 1 } });
  assert.equal(JSON.parse(fallback.requests[0].options.body).status.privacyStatus, "private");
  assert.equal(requests.length, 2);
});

test("a session that Google refuses to open is an upload failure", async () => {
  const { connector } = createConnector({ responses: [uploadResponse({}, { headers: {} })] });
  await assert.rejects(() => connector.publish({ accessToken: "at", title: "T", media: { body: "b", contentLength: 1 } }), {
    code: "YOUTUBE_NO_UPLOAD_SESSION"
  });
});

test("publishing refuses unreadable media and missing authorization", async () => {
  const { connector } = createConnector();
  await assert.rejects(() => connector.publish({ title: "T", media: { body: "b", contentLength: 1 } }), {
    code: "YOUTUBE_NOT_AUTHORIZED"
  });
  await assert.rejects(() => connector.publish({ accessToken: "at", title: "T", media: { body: null, contentLength: 0 } }), {
    code: "YOUTUBE_MEDIA_UNREADABLE"
  });
});

test("an aborted upload reports cancellation and keeps the session for resuming", async () => {
  const controller = new AbortController();
  controller.abort();
  const { connector } = createConnector({
    responses: [uploadResponse({}, { headers: { location: "https://upload.example/resume-me" } })]
  });
  await assert.rejects(
    () =>
      connector.publish({
        accessToken: "at",
        title: "T",
        media: { body: "b", contentLength: 1 },
        signal: controller.signal
      }),
    (error) => {
      assert.equal(error.code, "YOUTUBE_UPLOAD_CANCELED");
      assert.equal(error.category, "upload");
      return true;
    }
  );
});

test("an interrupted upload resumes from the byte count Google reports", async () => {
  const { connector } = createConnector({
    responses: [uploadResponse({}, { status: 308, headers: { range: "bytes=0-999" } })]
  });
  const probe = await connector.probeUploadOffset("https://upload.example/s", "at", 5000);
  assert.deepEqual(probe, { completed: false, offset: 1000 });

  const finished = createConnector({ responses: [uploadResponse({ id: "vid-9" }, { status: 200 })] });
  const done = await finished.connector.probeUploadOffset("https://upload.example/s", "at", 5000);
  assert.equal(done.completed, true);
});

test("publication status never claims public until YouTube says so", async () => {
  const processing = createConnector({
    responses: [
      uploadResponse({
        items: [{ status: { uploadStatus: "uploaded", privacyStatus: "private" }, processingDetails: { processingStatus: "processing" } }]
      })
    ]
  });
  const pending = await processing.connector.getPublishingStatus({ accessToken: "at", publicationId: "v1" });
  assert.equal(pending.complete, false);
  assert.equal(pending.failed, false);
  assert.equal(pending.privacyStatus, "private");

  const done = createConnector({
    responses: [uploadResponse({ items: [{ status: { uploadStatus: "processed", privacyStatus: "public" } }] })]
  });
  assert.equal((await done.connector.getPublishingStatus({ accessToken: "at", publicationId: "v1" })).complete, true);

  const rejected = createConnector({ responses: [uploadResponse({ items: [{ status: { uploadStatus: "rejected" } }] })] });
  assert.equal((await rejected.connector.getPublishingStatus({ accessToken: "at", publicationId: "v1" })).failed, true);

  const gone = createConnector({ responses: [uploadResponse({ items: [] })] });
  await assert.rejects(() => gone.connector.getPublishingStatus({ accessToken: "at", publicationId: "v1" }), {
    code: "YOUTUBE_VIDEO_NOT_FOUND"
  });
});

test("setup instructions state the audit limitation up front", () => {
  const { connector } = createConnector();
  const instructions = connector.getAuthorizationInstructions();
  assert.equal(instructions.platformId, "youtube");
  assert.ok(instructions.steps.length > 0);
  assert.ok(instructions.limitations.some((line) => /private/i.test(line) && /audit/i.test(line)));
  assert.ok(/never supplies its own Google credentials/i.test(instructions.limitations.join(" ")));
});
