const { AppError, CONNECTOR_ERROR_CATEGORIES, ConnectorError, connectorError } = require("../errors.cjs");
const { boundedString } = require("../validation.cjs");
const { getPlatform } = require("../platforms/registry.cjs");
const { CONNECTOR_CAPABILITIES } = require("./contract.cjs");
const { CHALLENGE_ENCODINGS, createPkcePair, createState } = require("../oauth/pkce.cjs");
const { createLoopbackListener } = require("../oauth/loopback-server.cjs");

// YouTube Data API v3 connector using Google's installed-application OAuth flow.
//
// Official documentation:
//   OAuth for native apps (loopback IP redirect, PKCE):
//     https://developers.google.com/identity/protocols/oauth2/native-app
//   Channel identity:
//     https://developers.google.com/youtube/v3/docs/channels/list
//
// The user supplies their own Google Cloud OAuth client. ProduDash ships no
// client id and no client secret. Per Google's native-app documentation
// client_secret is optional for desktop clients, so it is sent only when the
// user provided one.
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const CHANNELS_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels";
const UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos";
const VIDEOS_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";

// Google's resumable protocol answers a zero-length probe PUT with 308 and a
// Range header describing what it already has.
const RESUME_INCOMPLETE = 308;

// ProduDash never publishes publicly on the user's behalf without them saying
// so; private is the only default that cannot surprise anyone.
const PRIVACY_STATUSES = Object.freeze(new Set(["private", "unlisted", "public"]));

const DEFAULT_TIMEOUT_MS = 15_000;

function safeGoogleError(status, { duringUpload = false, duringTokenExchange = false } = {}) {
  // Google's token endpoint answers a revoked or expired grant with 400
  // invalid_grant, not 401. Letting that fall through to the validation default
  // meant the one failure that genuinely requires reauthorizing was reported as
  // a malformed request -- so nothing recorded the grant as dead and the
  // integration kept showing a green badge.
  if (status === 401 || (duringTokenExchange && status === 400)) {
    return connectorError(
      CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION,
      "YOUTUBE_AUTH_FAILED",
      "Google rejected the stored authorization. Reauthorize YouTube.",
      { platformId: "youtube" }
    );
  }
  if (status === 403) {
    return connectorError(
      CONNECTOR_ERROR_CATEGORIES.AUTHORIZATION,
      "YOUTUBE_FORBIDDEN",
      "The authorized Google account lacks the required YouTube permission or quota.",
      { platformId: "youtube" }
    );
  }
  if (status === 429) {
    return connectorError(CONNECTOR_ERROR_CATEGORIES.RATE_LIMIT, "YOUTUBE_RATE_LIMITED", "YouTube is rate limiting this project.", {
      platformId: "youtube"
    });
  }
  if (status >= 500) {
    return connectorError(
      duringUpload ? CONNECTOR_ERROR_CATEGORIES.UPLOAD : CONNECTOR_ERROR_CATEGORIES.PROCESSING,
      "YOUTUBE_SERVER_ERROR",
      "YouTube could not complete the request.",
      { platformId: "youtube" }
    );
  }
  return connectorError(CONNECTOR_ERROR_CATEGORIES.VALIDATION, "YOUTUBE_REQUEST_REJECTED", "YouTube rejected the request.", {
    platformId: "youtube"
  });
}

class YouTubeConnector {
  constructor(options = {}) {
    const platform = getPlatform("youtube");
    this.id = platform.id;
    this.platform = platform;
    this.capabilities = [
      CONNECTOR_CAPABILITIES.AUTHORIZE,
      CONNECTOR_CAPABILITIES.REFRESH,
      CONNECTOR_CAPABILITIES.PUBLISH,
      CONNECTOR_CAPABILITIES.RESUMABLE_UPLOAD,
      CONNECTOR_CAPABILITIES.PUBLISHING_STATUS,
      CONNECTOR_CAPABILITIES.DISCONNECT
    ];
    this.transport = options.transport || fetch;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    // Injected so tests never open a browser and never bind a socket.
    this.openExternal = options.openExternal || null;
    this.createListener = options.createListener || createLoopbackListener;
    this.now = options.now || (() => Date.now());
  }

  getAuthorizationInstructions() {
    return {
      platformId: this.id,
      authType: this.platform.authType,
      summary: "Create your own Google Cloud OAuth client of type Desktop app, then authorize your YouTube channel.",
      steps: [
        "In Google Cloud Console, create a project and enable the YouTube Data API v3.",
        "Configure the OAuth consent screen and add your Google account as a test user.",
        "Create an OAuth client ID of type Desktop app.",
        "Paste the client ID here. A client secret is optional for desktop clients.",
        "Choose Connect to authorize in your browser."
      ],
      scopes: [...this.platform.scopes],
      reviewRequirement: this.platform.reviewRequirement,
      docsUrl: this.platform.docsUrl,
      // Stated up front rather than discovered after a confusing upload.
      limitations: [
        "ProduDash never supplies its own Google credentials. Quota and audit status belong to your Google Cloud project.",
        "Uploads from a project that has not passed a YouTube API compliance audit are locked to private viewing."
      ]
    };
  }

  validateConfiguration(credentials = {}) {
    const missing = [];
    if (!credentials.clientId) missing.push("clientId");
    if (missing.length) {
      throw connectorError(
        CONNECTOR_ERROR_CATEGORIES.VALIDATION,
        "CONNECTOR_NOT_CONFIGURED",
        "Add your Google OAuth client ID before connecting YouTube.",
        { platformId: this.id }
      );
    }
    return { valid: true, missing: [] };
  }

  async request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.transport(url, { ...options, signal: controller.signal });
      if (!response.ok) throw safeGoogleError(response.status, options);
      // Google's revocation endpoint answers a successful revoke with 200 and an
      // empty body. Calling response.json() on that throws, and the throw is
      // indistinguishable here from a transport failure -- so a revocation that
      // genuinely succeeded was reported as "could not reach YouTube", and the
      // local cleanup that follows a disconnect never ran. The integration kept
      // showing a connection whose token Google had already destroyed.
      if (options.expectNoContent) return null;
      return await response.json();
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (error?.name === "AbortError") {
        throw connectorError(CONNECTOR_ERROR_CATEGORIES.NETWORK, "YOUTUBE_TIMEOUT", "YouTube did not respond in time.", {
          platformId: this.id
        });
      }
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.NETWORK, "YOUTUBE_NETWORK_ERROR", "ProduDash could not reach YouTube.", {
        platformId: this.id,
        cause: error
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async exchangeToken(body) {
    return this.request(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      duringTokenExchange: true
    });
  }

  buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge, codeChallengeMethod }) {
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.platform.scopes.join(" "));
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", codeChallengeMethod);
    url.searchParams.set("state", state);
    // Required to receive a refresh token; without it ProduDash would silently
    // lose access when the access token expires.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return url.toString();
  }

  expiresAt(expiresInSeconds) {
    const seconds = Number(expiresInSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return new Date(this.now() + seconds * 1000).toISOString();
  }

  // Opens the system browser -- never an embedded login view, which would let
  // ProduDash observe the user's Google password.
  async authorize(credentials = {}) {
    this.validateConfiguration(credentials);
    if (typeof this.openExternal !== "function") {
      throw new AppError("OAUTH_BROWSER_UNAVAILABLE", "ProduDash could not open a browser for authorization.");
    }
    const state = createState();
    const { codeVerifier, codeChallenge, codeChallengeMethod } = createPkcePair(
      this.platform.pkceChallengeEncoding || CHALLENGE_ENCODINGS.BASE64URL
    );
    const listener = await this.createListener({ expectedState: state });
    try {
      const authorizationUrl = this.buildAuthorizationUrl({
        clientId: credentials.clientId,
        redirectUri: listener.redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod
      });
      const waiting = listener.waitForCallback();
      await this.openExternal(authorizationUrl);
      const { code } = await waiting;

      const body = {
        client_id: credentials.clientId,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: listener.redirectUri
      };
      // Optional for desktop clients per Google's native-app documentation.
      if (credentials.clientSecret) body.client_secret = credentials.clientSecret;
      const token = await this.exchangeToken(body);
      if (!token.access_token) {
        throw connectorError(CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION, "YOUTUBE_NO_ACCESS_TOKEN", "Google returned no access token.", {
          platformId: this.id
        });
      }
      return {
        accessToken: token.access_token,
        refreshToken: token.refresh_token || null,
        tokenExpiresAt: this.expiresAt(token.expires_in),
        // Record what Google actually granted, not what ProduDash asked for.
        grantedScopes: typeof token.scope === "string" ? token.scope.split(" ").filter(Boolean) : []
      };
    } finally {
      listener.close();
    }
  }

  async refreshAuthorization(credentials = {}) {
    this.validateConfiguration(credentials);
    if (!credentials.oauthRefreshToken) {
      throw connectorError(
        CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION,
        "YOUTUBE_NO_REFRESH_TOKEN",
        "No refresh token is stored. Reauthorize YouTube.",
        { platformId: this.id }
      );
    }
    const body = {
      client_id: credentials.clientId,
      grant_type: "refresh_token",
      refresh_token: credentials.oauthRefreshToken
    };
    if (credentials.clientSecret) body.client_secret = credentials.clientSecret;
    const token = await this.exchangeToken(body);
    if (!token.access_token) {
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION, "YOUTUBE_NO_ACCESS_TOKEN", "Google returned no access token.", {
        platformId: this.id
      });
    }
    return {
      accessToken: token.access_token,
      // A refresh response usually omits the refresh token; keep the stored one.
      refreshToken: token.refresh_token || null,
      tokenExpiresAt: this.expiresAt(token.expires_in),
      grantedScopes: typeof token.scope === "string" ? token.scope.split(" ").filter(Boolean) : []
    };
  }

  // Returns the channel the stored authorization actually controls. The
  // connector reports connected only after this succeeds -- holding a token is
  // not the same as having a usable channel.
  async fetchChannel(accessToken) {
    const url = new URL(CHANNELS_ENDPOINT);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");
    const body = await this.request(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const channel = Array.isArray(body.items) ? body.items[0] : null;
    if (!channel?.id) {
      throw connectorError(
        CONNECTOR_ERROR_CATEGORIES.AUTHORIZATION,
        "YOUTUBE_NO_CHANNEL",
        "The authorized Google account has no YouTube channel.",
        { platformId: this.id }
      );
    }
    return { id: String(channel.id), name: boundedString(channel.snippet?.title || "", { label: "Channel", max: 200 }) };
  }

  async testConnection(credentials = {}) {
    this.validateConfiguration(credentials);
    if (!credentials.oauthAccessToken) {
      throw connectorError(
        CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION,
        "YOUTUBE_NOT_AUTHORIZED",
        "Authorize YouTube before testing the connection.",
        { platformId: this.id }
      );
    }
    // Token freshness is the connection service's job. Handing that to a single
    // refresh-aware path is what keeps publishing, status polling, and this
    // check from each implementing their own -- and from racing each other for
    // the same refresh token.
    const channel = await this.fetchChannel(credentials.oauthAccessToken);
    return {
      status: "connected",
      error: null,
      syncedAt: new Date(this.now()).toISOString(),
      auditDetail: `Verified the YouTube channel ${channel.name || channel.id} through the official Data API.`,
      authorizationUpdate: { selectedAccount: channel }
    };
  }

  // Opens a resumable session and returns its upload URI. Documented at
  // https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
  async createUploadSession({ accessToken, metadata, contentLength, contentType }) {
    const url = new URL(UPLOAD_ENDPOINT);
    url.searchParams.set("uploadType", "resumable");
    url.searchParams.set("part", "snippet,status");
    const response = await this.transport(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(contentLength),
        "X-Upload-Content-Type": contentType
      },
      body: JSON.stringify(metadata)
    });
    if (!response.ok) throw safeGoogleError(response.status, { duringUpload: true });
    const uploadUri = response.headers?.get?.("location");
    if (!uploadUri) {
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.UPLOAD, "YOUTUBE_NO_UPLOAD_SESSION", "YouTube did not open an upload session.", {
        platformId: this.id
      });
    }
    return uploadUri;
  }

  // Asks Google how many bytes it already holds, so an interrupted upload
  // resumes instead of restarting.
  async probeUploadOffset(uploadUri, accessToken, contentLength) {
    const response = await this.transport(uploadUri, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Range": `bytes */${contentLength}`,
        "Content-Length": "0"
      }
    });
    if (response.status === RESUME_INCOMPLETE) {
      const range = response.headers?.get?.("range");
      const match = /bytes=0-(\d+)$/.exec(range || "");
      return { completed: false, offset: match ? Number(match[1]) + 1 : 0 };
    }
    if (response.ok) return { completed: true, body: await response.json() };
    // The session is gone. This does NOT establish that no video was created:
    // an upload that completed before ProduDash recorded the id would expire
    // into the same 404 as one that never finished. Report it as undetermined
    // and let the caller decide, rather than guessing in either direction.
    if (response.status === 404 || response.status === 410) return { dead: true };
    throw safeGoogleError(response.status, { duringUpload: true });
  }

  buildVideoMetadata(request) {
    // The audience declaration is a legal statement by the uploader. Coercing a
    // missing value to false would be ProduDash declaring it on their behalf,
    // so an absent or non-boolean value is refused outright.
    if (typeof request.selfDeclaredMadeForKids !== "boolean") {
      throw connectorError(
        CONNECTOR_ERROR_CATEGORIES.VALIDATION,
        "YOUTUBE_AUDIENCE_DECLARATION_REQUIRED",
        "YouTube requires an explicit made-for-kids declaration for this upload.",
        { platformId: this.id }
      );
    }
    // An unrecognized visibility falls back to private, never to public.
    const privacyStatus = PRIVACY_STATUSES.has(request.privacyStatus) ? request.privacyStatus : "private";
    return {
      snippet: {
        title: boundedString(request.title, { label: "Video title", min: 1, max: 100 }),
        description: boundedString(request.description || "", { label: "Video description", max: 5000 })
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: request.selfDeclaredMadeForKids
      }
    };
  }

  // Uploads one rendered video. The caller supplies the bytes; this connector
  // never resolves a filesystem path itself.
  async publish(request = {}) {
    const accessToken = request.accessToken;
    if (!accessToken) {
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION, "YOUTUBE_NOT_AUTHORIZED", "Authorize YouTube before publishing.", {
        platformId: this.id
      });
    }
    const { body, contentLength, contentType = "video/*" } = request.media || {};
    if (!body || !Number.isFinite(contentLength) || contentLength <= 0) {
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.VALIDATION, "YOUTUBE_MEDIA_UNREADABLE", "The rendered video could not be read.", {
        platformId: this.id
      });
    }

    const metadata = this.buildVideoMetadata(request);
    // Single-shot: opens a session and sends the whole file. A caller that needs
    // to survive an interruption uses beginUpload/probeUpload/sendUpload below,
    // which let it persist the session URI before any bytes leave.
    const uploadUri = await this.createUploadSession({ accessToken, metadata, contentLength, contentType });
    const video = await this.uploadBytes({ accessToken, uploadUri, body, contentLength, contentType, signal: request.signal });
    return this.describePublication(video, metadata);
  }

  // Sends the bytes for an already-open session. Split out from publish() so a
  // caller can durably persist the session URI in between.
  async uploadBytes({ accessToken, uploadUri, body, contentLength, contentType = "video/*", offset = 0, signal }) {
    // A resume position outside the file would silently upload the wrong bytes,
    // so it is refused rather than clamped.
    if (!Number.isInteger(offset) || offset < 0 || offset >= contentLength) {
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.UPLOAD, "YOUTUBE_UPLOAD_OFFSET_INVALID", "The resume position is out of bounds.", {
        platformId: this.id
      });
    }
    if (signal?.aborted) {
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.UPLOAD, "YOUTUBE_UPLOAD_CANCELED", "The upload was canceled.", {
        platformId: this.id
      });
    }

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": contentType,
      "Content-Length": String(contentLength - offset)
    };
    // Only sent when resuming; a fresh upload has no range.
    if (offset > 0) headers["Content-Range"] = `bytes ${offset}-${contentLength - 1}/${contentLength}`;

    let response;
    try {
      response = await this.transport(uploadUri, { method: "PUT", headers, body, signal });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw connectorError(CONNECTOR_ERROR_CATEGORIES.UPLOAD, "YOUTUBE_UPLOAD_CANCELED", "The upload was canceled.", {
          platformId: this.id
        });
      }
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.NETWORK, "YOUTUBE_UPLOAD_INTERRUPTED", "The upload was interrupted.", {
        platformId: this.id,
        cause: error
      });
    }
    // A session can die between the probe and the send. Left to the default
    // mapping this became a VALIDATION error, which is non-retryable -- so the
    // destination was blocked with a live session record and no route out.
    // It is the same "the provider has forgotten this" condition probeUploadOffset
    // already recognizes, and it is reported the same way.
    if (response.status === 404 || response.status === 410) {
      throw connectorError(
        CONNECTOR_ERROR_CATEGORIES.UPLOAD,
        "YOUTUBE_UPLOAD_SESSION_GONE",
        "YouTube no longer recognizes this upload session.",
        { platformId: this.id }
      );
    }
    if (!response.ok) throw safeGoogleError(response.status, { duringUpload: true });
    return response.json();
  }

  // --- resumable upload capability ----------------------------------------
  //
  // Three steps rather than one call, so the dispatcher can persist the session
  // URI before any bytes leave and reconcile an interrupted transfer instead of
  // opening a second session.

  async beginUpload({ accessToken, request, contentLength, contentType = "video/*" }) {
    const metadata = this.buildVideoMetadata(request);
    const uploadUri = await this.createUploadSession({ accessToken, metadata, contentLength, contentType });
    return { uploadUri };
  }

  // Asks the provider what it actually holds. `completed` means a video already
  // exists for this session and must not be uploaded again.
  async probeUpload({ accessToken, uploadUri, contentLength, request }) {
    const probe = await this.probeUploadOffset(uploadUri, accessToken, contentLength);
    if (probe.dead) return { unresolved: true };
    if (probe.completed) {
      // The provider has already created this video, so recording its id is the
      // only thing that matters here. Re-deriving the requested privacy status
      // is a nicety, and a validation error in it must never be allowed to
      // throw away a publication that genuinely exists.
      let metadata = null;
      try {
        metadata = this.buildVideoMetadata(request);
      } catch {
        metadata = null;
      }
      return { completed: true, offset: contentLength, result: this.describePublication(probe.body, metadata) };
    }
    // Google can answer 308 with the full range while it is still committing.
    // Nothing is left to send, and forwarding this offset would be rejected as
    // out of bounds and stall the destination forever. It is a wait, not a
    // failure, so it is reported as retryable processing.
    if (probe.offset >= contentLength) {
      throw connectorError(
        CONNECTOR_ERROR_CATEGORIES.PROCESSING,
        "YOUTUBE_UPLOAD_COMMIT_PENDING",
        "YouTube has the whole video and is still finalizing it.",
        { platformId: this.id }
      );
    }
    return { completed: false, offset: probe.offset };
  }

  async sendUpload({ accessToken, uploadUri, body, contentLength, contentType = "video/*", offset = 0, signal, request }) {
    const video = await this.uploadBytes({ accessToken, uploadUri, body, contentLength, contentType, offset, signal });
    // Same reasoning as probeUpload, and for the same moment: the bytes are
    // delivered and YouTube has made the video. Re-deriving the requested
    // privacy status is a nicety, and letting a validation error in it throw
    // would discard the id of a video that is live on someone's channel --
    // leaving ProduDash no record of it and no way to reconcile.
    let metadata = null;
    try {
      metadata = this.buildVideoMetadata(request);
    } catch {
      metadata = null;
    }
    return this.describePublication(video, metadata);
  }

  describePublication(video, metadata) {
    if (!video?.id) {
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.PROCESSING, "YOUTUBE_NO_VIDEO_ID", "YouTube did not return a video id.", {
        platformId: this.id
      });
    }
    return {
      publicationId: String(video.id),
      // Report what YouTube actually set, which is not necessarily what was
      // requested: an unaudited project has its uploads forced to private.
      privacyStatus: video.status?.privacyStatus || null,
      uploadStatus: video.status?.uploadStatus || null,
      requestedPrivacyStatus: metadata?.status?.privacyStatus || null
    };
  }

  // Coarse status only. Never claims a video is public until YouTube says so.
  async getPublishingStatus({ accessToken, publicationId } = {}) {
    if (!accessToken || !publicationId) {
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.VALIDATION, "YOUTUBE_STATUS_UNAVAILABLE", "A video id is required.", {
        platformId: this.id
      });
    }
    const url = new URL(VIDEOS_ENDPOINT);
    url.searchParams.set("part", "status,processingDetails");
    url.searchParams.set("id", publicationId);
    const body = await this.request(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const video = Array.isArray(body.items) ? body.items[0] : null;
    if (!video) {
      throw connectorError(CONNECTOR_ERROR_CATEGORIES.PROCESSING, "YOUTUBE_VIDEO_NOT_FOUND", "YouTube no longer reports that video.", {
        platformId: this.id
      });
    }
    const uploadStatus = video.status?.uploadStatus || null;
    return {
      publicationId,
      uploadStatus,
      privacyStatus: video.status?.privacyStatus || null,
      processingStatus: video.processingDetails?.processingStatus || null,
      // "processed" is the only value that means YouTube finished with it.
      complete: uploadStatus === "processed",
      failed: uploadStatus === "failed" || uploadStatus === "rejected"
    };
  }

  // Revokes at Google before ProduDash forgets the token locally, so access is
  // actually withdrawn rather than merely hidden.
  async disconnect(credentials = {}) {
    const token = credentials.oauthRefreshToken || credentials.oauthAccessToken;
    if (!token) return { revoked: false, reason: "no_token" };
    try {
      await this.request(REVOCATION_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
        // A successful revoke carries no body; nothing here reads one.
        expectNoContent: true
      });
      return { revoked: true };
    } catch (error) {
      // An already-invalid token is not a failure to disconnect.
      if (error instanceof ConnectorError && error.category === CONNECTOR_ERROR_CATEGORIES.VALIDATION) {
        return { revoked: false, reason: "already_invalid" };
      }
      throw error;
    }
  }
}

module.exports = {
  AUTHORIZATION_ENDPOINT,
  CHANNELS_ENDPOINT,
  REVOCATION_ENDPOINT,
  TOKEN_ENDPOINT,
  YouTubeConnector,
  safeGoogleError
};
