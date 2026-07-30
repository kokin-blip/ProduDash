const fs = require("node:fs");
const path = require("node:path");
const { AppError, ConnectorError, asAppError } = require("../errors.cjs");
const { CONNECTOR_CAPABILITIES, connectorSupports } = require("../connectors/contract.cjs");
const { getPlatform } = require("../platforms/registry.cjs");
const { RECEIPT_STATUSES, createReceipt, isAlreadyPublished } = require("./receipt.cjs");
const { UploadSessionStore, createUploadSession, isUsableSession } = require("./upload-session.cjs");

// An unresolved session is a local error, but unlike every other local error
// the previous attempt did reach the provider. Retrying cannot be made safe
// until a human has checked the destination, so the receipt must not offer it.
const NEVER_RETRYABLE = Object.freeze(new Set(["UPLOAD_SESSION_UNRESOLVED", "APPROVAL_PREDATES_REQUIRED_OPTIONS"]));

// Dispatches an approved post plan to real connectors.
//
// This is the seam the official-API approval path was always missing:
// approvePostPlan verified readiness and then stopped, leaving
// approved_for_official_api a terminal dead end. Dispatch consumes the
// idempotency keys the approval snapshot already generates rather than minting
// new ones, so a repeated click or a restart mid-flight cannot double-post.
class PublishingDispatchService {
  constructor({ store, connectorRegistry, connections, mediaJobs, credentialVault, uploadSessions }) {
    this.store = store;
    this.connectorRegistry = connectorRegistry;
    this.connections = connections;
    this.mediaJobs = mediaJobs;
    // Session URIs are capabilities, so they live in the encrypted vault beside
    // tokens rather than anywhere the renderer can reach.
    this.sessions = uploadSessions || new UploadSessionStore(credentialVault);
  }

  // Resolves the rendered file. Absolute paths live in the encrypted vault and
  // never enter app state, so they are read here and never returned.
  resolveMediaFile(plan) {
    const snapshot = plan.mediaSnapshot;
    const videoName = snapshot?.videos?.[0]?.name;
    if (!plan.mediaJobId || !videoName) {
      throw new AppError("MEDIA_JOB_NOT_READY", "This plan has no rendered video to publish.");
    }
    const { outputPath } = this.mediaJobs.getPrivatePaths(plan.mediaJobId);
    // basename defends against a crafted snapshot escaping the output folder.
    const filePath = path.join(outputPath, path.basename(videoName));
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      throw new AppError("MEDIA_FILE_MISSING", "The rendered video for this plan could not be found.");
    }
    if (!stats.isFile() || stats.size <= 0) {
      throw new AppError("MEDIA_FILE_MISSING", "The rendered video for this plan is empty or unreadable.");
    }
    return { filePath, contentLength: stats.size };
  }

  packageFor(plan, platformId) {
    const approved = plan.approvalSnapshot?.payload;
    const pack = approved?.platformPackages?.find((item) => item.platformId === platformId);
    if (!pack) throw new AppError("INVALID_TRANSITION", "The approved plan has no copy for that destination.");
    return pack;
  }

  async publishDestination(plan, destination) {
    const platform = getPlatform(destination.platformId);
    const connector = this.connectorRegistry.find(destination.platformId);
    if (!connector || !connectorSupports(connector, CONNECTOR_CAPABILITIES.PUBLISH)) {
      throw new AppError("PUBLISHING_UNSUPPORTED", `${platform.displayName} cannot publish from ProduDash yet.`);
    }
    const state = this.store.getAppState();
    const integration = state.integrations.find((item) => item.id === destination.platformId);
    const pack = this.packageFor(plan, destination.platformId);
    // An approval made before this platform declared per-destination options
    // carries none: nobody was ever asked. Choosing an audience declaration on
    // the user's behalf is not available to ProduDash, and the snapshot is
    // immutable by design, so the only honest move is to ask for a new one.
    if (platform.publishingOptions && !pack.options) {
      throw new AppError(
        "APPROVAL_PREDATES_REQUIRED_OPTIONS",
        `${platform.displayName} requires publishing choices this approval never captured. Cancel this plan and create it again to choose them.`
      );
    }
    const { filePath, contentLength } = this.resolveMediaFile(plan);
    const accountId = integration?.authorization?.selectedAccount?.id || null;
    const metadata = { title: pack.title, description: pack.caption, ...(pack.options || {}) };

    // A connector without resumable support uploads in one call. It cannot be
    // reconciled after a crash, and that limitation is real rather than hidden.
    if (!connectorSupports(connector, CONNECTOR_CAPABILITIES.RESUMABLE_UPLOAD)) {
      const result = await this.sendWholeFile({ connector, destination, filePath, contentLength, metadata });
      return { result, accountId };
    }

    const existing = this.sessions.get(destination.idempotencyKey);
    if (existing) {
      // The session expired or is otherwise unusable, and we cannot tell
      // whether it created a video. Opening a replacement could duplicate the
      // upload, so this requires an explicit decision from the user instead.
      if (!isUsableSession(existing)) await this.refuseUnresolved(destination.idempotencyKey);
      // The approval hash covers media names and sources, not bytes, so
      // re-rendering the media job produces a different file under the same
      // idempotency key. Resuming would append the new render's bytes to what
      // the provider already holds of the old one and publish a corrupt video.
      if (contentLength !== existing.contentLength) await this.refuseUnresolved(destination.idempotencyKey);
      const result = await this.resumeSession({ connector, destination, session: existing, filePath, metadata });
      return { result, accountId };
    }

    // Order matters: open the session, persist its URI, and only then send
    // bytes. Persisting afterwards would leave the exact gap this prevents.
    const opened = await this.connections.withFreshAuthorization(destination.platformId, (accessToken) =>
      connector.beginUpload({ accessToken, request: metadata, contentLength, contentType: "video/*" })
    );
    const session = await this.sessions.save(
      createUploadSession({
        planId: plan.id,
        platformId: destination.platformId,
        approvalHash: plan.approvalSnapshot.hash,
        idempotencyKey: destination.idempotencyKey,
        uploadUri: opened.uploadUri,
        contentLength
      })
    );

    const result = await this.sendBytes({ connector, destination, session, filePath, metadata, offset: 0 });
    return { result, accountId };
  }

  // Refuses an attempt whose predecessor cannot be accounted for. The session
  // record is retained, not cleared: clearing it would make the next dispatch
  // look like a first attempt and upload the duplicate this prevents.
  async refuseUnresolved(idempotencyKey) {
    await this.sessions.markUnresolved(idempotencyKey);
    throw new AppError(
      "UPLOAD_SESSION_UNRESOLVED",
      "A previous upload attempt could not be reconciled with the provider. Check the destination before retrying."
    );
  }

  // The explicit decision an unresolved session asks for. The user has checked
  // the destination themselves and is stating that no publication came of the
  // earlier attempt, which is a claim only they can make: the provider has
  // already said it cannot tell us. Discarding the record lets the next
  // dispatch start cleanly.
  async discardUploadSession(planId, platformId) {
    const plan = this.store.getAppState().postQueue.find((item) => item.id === planId);
    if (!plan) throw new AppError("POST_PLAN_NOT_FOUND", "Post plan not found.");
    const destination = (plan.approvalSnapshot?.destinations || []).find((item) => item.platformId === platformId);
    if (!destination) throw new AppError("PUBLICATION_NOT_FOUND", "That destination is not part of the approved plan.");

    // Only an unresolved destination may be discarded. The IPC channel accepts
    // any plan and platform, so without this a stale button in an old render --
    // or a second window -- could clear the session of an upload that is still
    // running, destroying the one record whose purpose is to survive exactly
    // that moment.
    const receipt = plan.publicationReceipts.find((item) => item.idempotencyKey === destination.idempotencyKey);
    if (receipt?.errorCode !== "UPLOAD_SESSION_UNRESOLVED") {
      throw new AppError("UPLOAD_SESSION_NOT_DISCARDABLE", "That destination has no unresolved upload to discard.");
    }

    // Receipt first, session second -- the same ordering the dispatcher uses,
    // and for the same reason. Clearing first meant a crash in between left the
    // session gone while the receipt still read UNRESOLVED: the next dispatch
    // would see no session, treat itself as a first attempt, and publish the
    // duplicate this module exists to prevent. This way round the worst case is
    // that the user is asked to discard a second time.
    await this.store.recordPublicationReceipt(planId, {
      ...receipt,
      hasResumableSession: false,
      // Still a failed attempt -- that is the truth and the record keeps it.
      // But it is no longer *unresolved*, and the code has to say so: the
      // renderer decides whether to warn and offer the discard control by
      // reading this exact field, so leaving it would make the action appear
      // to do nothing and invite the user to discard a second time.
      errorCode: "UPLOAD_SESSION_DISCARDED",
      // The block was the unknown outcome, and the user has resolved it.
      retryable: true
    });
    await this.sessions.clear(destination.idempotencyKey);
    return this.store.getAppState();
  }

  // Opens the file for a single upload attempt.
  //
  // A body must never be shared between attempts. withFreshAuthorization
  // re-invokes its operation once when the provider rejects the token, and a
  // stream that has already been read is at EOF: the retry would declare the
  // full Content-Length and then send nothing. Every attempt therefore opens
  // its own stream, and all of them are closed when the call is over.
  openBody(streams, filePath, start = 0) {
    // createReadStream opens lazily, and a stream with no error listener turns
    // a failed open into an uncaught exception. If the file disappears between
    // the stat above and the upload, the publish call surfaces that properly.
    const body = fs.createReadStream(filePath, start > 0 ? { start } : undefined);
    body.on("error", () => {});
    streams.push(body);
    return body;
  }

  // Single-call upload for connectors that do not expose a resumable session.
  async sendWholeFile({ connector, destination, filePath, contentLength, metadata }) {
    const streams = [];
    try {
      return await this.connections.withFreshAuthorization(destination.platformId, (accessToken) =>
        connector.publish({
          accessToken,
          ...metadata,
          media: { body: this.openBody(streams, filePath), contentLength, contentType: "video/*" }
        })
      );
    } finally {
      // A connector that failed before consuming a body, and any body abandoned
      // by a retry, would otherwise hold the handle open until GC.
      for (const stream of streams) stream.destroy();
    }
  }

  // Reconciles an interrupted upload with the provider before doing anything
  // that could create a second video.
  async resumeSession({ connector, destination, session, filePath, metadata }) {
    const probe = await this.connections.withFreshAuthorization(destination.platformId, (accessToken) =>
      connector.probeUpload({ accessToken, uploadUri: session.uploadUri, contentLength: session.contentLength, request: metadata })
    );
    // The provider no longer recognizes the session and cannot say whether it
    // produced a video. Restarting might duplicate one; resuming is impossible.
    if (probe.unresolved) await this.refuseUnresolved(destination.idempotencyKey);
    if (probe.completed) {
      // The provider already has the whole thing and returned the resource.
      // Recording its id is the only correct action; uploading again would
      // publish a duplicate. The session is retired by dispatch() once that id
      // is durably written, not here.
      return probe.result;
    }
    // The provider is authoritative about how much it holds, so its answer is
    // used directly rather than any offset we might have recorded ourselves.
    return this.sendBytes({ connector, destination, session, filePath, metadata, offset: probe.offset });
  }

  async sendBytes({ connector, destination, session, filePath, metadata, offset }) {
    const streams = [];
    try {
      // Streaming from the offset means a resumed upload re-sends only what the
      // provider is missing, and never loads the file into memory.
      const result = await this.connections.withFreshAuthorization(destination.platformId, (accessToken) =>
        connector.sendUpload({
          accessToken,
          uploadUri: session.uploadUri,
          body: this.openBody(streams, filePath, offset),
          contentLength: session.contentLength,
          contentType: "video/*",
          offset,
          request: metadata
        })
      );
      // Deliberately NOT cleared here. Between this line and the receipt being
      // written, the provider holds a video whose id ProduDash has not recorded
      // -- exactly the crash window this module exists to close. The session is
      // what lets the next dispatch reconcile instead of uploading again, so it
      // survives until dispatch() has the id safely on disk.
      return result;
    } finally {
      // The session record is deliberately kept on failure so the next attempt
      // can reconcile rather than restart; only the file handles are released.
      for (const stream of streams) stream.destroy();
    }
  }

  async dispatch(planId) {
    await this.store.beginPostPlanDispatch(planId);
    const plan = this.store.getAppState().postQueue.find((item) => item.id === planId);
    const destinations = plan.approvalSnapshot?.destinations || [];

    for (const destination of destinations) {
      const existing = plan.publicationReceipts.find((item) => item.idempotencyKey === destination.idempotencyKey);
      // Already published under this exact approved content -- skipping is what
      // makes a second click and a restart mid-dispatch safe.
      if (isAlreadyPublished(existing)) continue;

      const startedAt = new Date().toISOString();
      const receipt = {
        ...(existing ||
          createReceipt({
            planId,
            platformId: destination.platformId,
            accountId: null,
            approvedContentHash: plan.approvalSnapshot.hash,
            idempotencyKey: destination.idempotencyKey
          })),
        status: RECEIPT_STATUSES.UPLOADING,
        hasResumableSession: isUsableSession(this.sessions.get(destination.idempotencyKey)),
        attempts: [...(existing?.attempts || []), { startedAt, endedAt: null, outcome: RECEIPT_STATUSES.UPLOADING }]
      };
      await this.store.recordPublicationReceipt(planId, receipt);

      try {
        const { result, accountId } = await this.publishDestination(plan, destination);
        const endedAt = new Date().toISOString();
        await this.store.recordPublicationReceipt(planId, {
          ...receipt,
          accountId,
          providerPublicationId: result.publicationId,
          status: RECEIPT_STATUSES.PUBLISHED,
          hasResumableSession: false,
          errorCode: null,
          retryable: false,
          attempts: [...receipt.attempts.slice(0, -1), { startedAt, endedAt, outcome: RECEIPT_STATUSES.PUBLISHED }]
        });
        // The publication id is now durable, so a crash can no longer lose it.
        // Only at this point has the session finished its job.
        await this.sessions.clear(destination.idempotencyKey);
      } catch (error) {
        const safe = asAppError(error, "PUBLISH_FAILED", "The destination could not be published.");
        const endedAt = new Date().toISOString();
        await this.store.recordPublicationReceipt(planId, {
          ...receipt,
          status: RECEIPT_STATUSES.FAILED,
          // Kept truthful: a surviving session is what makes the next attempt a
          // reconciliation rather than a fresh upload.
          hasResumableSession: isUsableSession(this.sessions.get(destination.idempotencyKey)),
          errorCode: safe.code,
          // Honest retryability: only a connector that said so, or an error
          // that never reached the provider at all -- with the one exception
          // whose whole point is that an earlier attempt did.
          retryable: error instanceof ConnectorError ? error.retryable : !NEVER_RETRYABLE.has(safe.code),
          attempts: [...receipt.attempts.slice(0, -1), { startedAt, endedAt, outcome: RECEIPT_STATUSES.FAILED }]
        });
      }
    }

    return this.store.completePostPlanDispatch(planId);
  }

  // Re-checks a published destination with the provider. Nothing here claims a
  // video is public; only the provider's own answer does.
  async refreshPublicationStatus(planId, platformId) {
    const plan = this.store.getAppState().postQueue.find((item) => item.id === planId);
    if (!plan) throw new AppError("POST_PLAN_NOT_FOUND", "Post plan not found.");
    const receipt = plan.publicationReceipts.find((item) => item.platformId === platformId);
    if (!receipt?.providerPublicationId) {
      throw new AppError("PUBLICATION_NOT_FOUND", "That destination has no recorded publication.");
    }
    const connector = this.connectorRegistry.find(platformId);
    if (!connector || !connectorSupports(connector, CONNECTOR_CAPABILITIES.PUBLISHING_STATUS)) {
      throw new AppError("PUBLISHING_UNSUPPORTED", "That destination cannot report publication status.");
    }
    // Status checks are long-lived reads that often run well after the upload,
    // so they need the same refresh-aware path.
    return this.connections.withFreshAuthorization(platformId, (accessToken) =>
      connector.getPublishingStatus({ accessToken, publicationId: receipt.providerPublicationId })
    );
  }
}

module.exports = { PublishingDispatchService };
