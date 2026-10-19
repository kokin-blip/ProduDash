const { AppError, ConnectorError } = require("../errors.cjs");
const { CONNECTOR_CAPABILITIES } = require("./contract.cjs");
class TikTokConnector {
  constructor(manager) {
    this.id = "tiktok";
    this.transport = "browser";
    this.manager = manager;
    this.capabilities = [CONNECTOR_CAPABILITIES.PUBLISH];
  }
  getAuthorizationInstructions() {
    return { instructions: "Start TikTok browser API in Integrations, sign in, and check the expected account." };
  }
  validateConfiguration() {
    if (!this.manager) throw new AppError("CUSTOM_API_UNAVAILABLE", "The browser API is unavailable.");
    return true;
  }
  async testConnection() {
    this.validateConfiguration();
    await this.manager.session("tiktok", "check");
    return { status: "connected", syncedAt: new Date().toISOString(), auditDetail: "Verified TikTok browser account." };
  }
  async publish({
    filePath,
    idempotencyKey,
    expectedAccountId,
    description,
    privacyLevel = "SELF_ONLY",
    allowComments = true,
    allowReuse = false,
    isAigc = false
  }) {
    this.validateConfiguration();
    if (!expectedAccountId || this.manager.account("tiktok").id !== expectedAccountId)
      throw new AppError("APPROVED_ACCOUNT_CHANGED", "The approved TikTok account changed. Create a new approval.");
    const videoPath = await this.manager.stageMedia("tiktok", filePath, idempotencyKey);
    try {
      const data = await this.manager.request(
        "tiktok",
        "/v1/posts",
        {
          provider: "browser",
          video_path: videoPath,
          title: description || "",
          privacy_level: privacyLevel,
          disable_comment: !allowComments,
          disable_duet: !allowReuse,
          disable_stitch: !allowReuse,
          brand_content_toggle: false,
          brand_organic_toggle: false,
          is_aigc: isAigc,
          consent: true,
          dry_run: false
        },
        idempotencyKey
      );
      if (typeof data.item_id !== "string" || !/^\d+$/.test(data.item_id) || data.state !== "submitted") throw new Error();
      return {
        publicationId: data.item_id,
        uploadStatus: "submitted",
        verification: "upstream_acknowledgement",
        publicationUrl: `https://www.tiktok.com/@${expectedAccountId}/video/${data.item_id}`
      };
    } catch (error) {
      throw new ConnectorError(
        error instanceof AppError ? error.code : "CUSTOM_API_OUTCOME_UNKNOWN",
        error instanceof AppError ? error.message : "The submission outcome is uncertain. Inspect TikTok before retrying.",
        { category: "upload", retryable: false, platformId: "tiktok" }
      );
    }
  }
}
module.exports = { TikTokConnector };
