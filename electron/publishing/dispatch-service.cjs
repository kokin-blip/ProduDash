const fs = require("node:fs");
const path = require("node:path");
const { AppError, ConnectorError, asAppError } = require("../errors.cjs");
const { CONNECTOR_CAPABILITIES, connectorSupports } = require("../connectors/contract.cjs");
const { getPlatform } = require("../platforms/registry.cjs");
const { RECEIPT_STATUSES, createReceipt, isAlreadyPublished } = require("./receipt.cjs");

// Dispatches an approved post plan to real connectors.
//
// This is the seam the official-API approval path was always missing:
// approvePostPlan verified readiness and then stopped, leaving
// approved_for_official_api a terminal dead end. Dispatch consumes the
// idempotency keys the approval snapshot already generates rather than minting
// new ones, so a repeated click or a restart mid-flight cannot double-post.
class PublishingDispatchService {
  constructor({ store, connectorRegistry, connections, mediaJobs }) {
    this.store = store;
    this.connectorRegistry = connectorRegistry;
    this.connections = connections;
    this.mediaJobs = mediaJobs;
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
    const { filePath, contentLength } = this.resolveMediaFile(plan);
    const body = fs.createReadStream(filePath);
    // createReadStream opens lazily, and a stream with no error listener turns
    // a failed open into an uncaught exception. If the file disappears between
    // the stat above and the upload, the publish call surfaces that properly.
    body.on("error", () => {});
    try {
      // A short-lived access token can expire between approval and upload, so
      // it is acquired through the one refresh-aware path rather than read
      // straight from storage.
      const result = await this.connections.withFreshAuthorization(destination.platformId, (accessToken) =>
        connector.publish({
          accessToken,
          title: pack.title,
          description: pack.caption,
          // Every per-destination choice comes from the immutable approved
          // snapshot, never from current draft state or a default chosen here.
          // The connector reports back what the provider actually applied.
          ...(pack.options || {}),
          media: { body, contentLength, contentType: "video/*" }
        })
      );
      return { result, accountId: integration?.authorization?.selectedAccount?.id || null };
    } catch (error) {
      // A connector that failed before consuming the body would otherwise leave
      // the file handle open until GC.
      body.destroy();
      throw error;
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
          errorCode: null,
          retryable: false,
          attempts: [...receipt.attempts.slice(0, -1), { startedAt, endedAt, outcome: RECEIPT_STATUSES.PUBLISHED }]
        });
      } catch (error) {
        const safe = asAppError(error, "PUBLISH_FAILED", "The destination could not be published.");
        const endedAt = new Date().toISOString();
        await this.store.recordPublicationReceipt(planId, {
          ...receipt,
          status: RECEIPT_STATUSES.FAILED,
          errorCode: safe.code,
          // Honest retryability: only a connector that said so, or an error
          // that never reached the provider at all.
          retryable: error instanceof ConnectorError ? error.retryable : true,
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
