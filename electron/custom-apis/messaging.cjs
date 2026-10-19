const crypto = require("node:crypto");
const { AppError } = require("../errors.cjs");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
class TikTokMessagingService {
  constructor({ manager, store }) {
    this.manager = manager;
    this.store = store;
    this.pending = new Map();
  }
  initialize() {
    for (const item of this.store.state.messageDispatches || []) if (item.status === "sending") item.status = "outcome_unknown";
    this.store.persist();
  }
  thread(id) {
    const thread = this.store.getConversation(id);
    if (thread.source !== "tiktok" || thread.accountId !== this.manager.account("tiktok").id)
      throw new AppError("ACCOUNT_MISMATCH", "Select a conversation for the verified TikTok account.");
    return thread;
  }
  async refreshConversations() {
    const account = this.manager.account("tiktok");
    const result = await this.manager.request("tiktok", "/v1/conversations");
    if (!Array.isArray(result.conversations)) throw new AppError("CUSTOM_API_INVALID_RESPONSE", "The conversation snapshot was invalid.");
    return this.store.enqueueMutation(async () => {
      for (const entry of result.conversations.slice(0, 100)) {
        if (!/^[\d:]{1,128}$/.test(entry.id || "") || typeof entry.name !== "string" || !entry.name.trim()) continue;
        const id = `tiktok-${hash(`${account.id}:${entry.id}`).slice(0, 32)}`;
        const existing = this.store.state.conversations.find((item) => item.id === id);
        if (existing) existing.customer = entry.name.slice(0, 120);
        else
          this.store.state.conversations.push({
            id,
            businessId: null,
            source: "tiktok",
            accountId: account.id,
            externalId: entry.id,
            customer: entry.name.slice(0, 120),
            channel: "TikTok browser",
            status: "imported",
            coverage: "Currently loaded browser snapshot",
            messages: []
          });
      }
      this.store.persist();
      return this.store.getAppState();
    });
  }
  async refreshMessages(id) {
    const thread = this.thread(id);
    const snapshot = await this.manager.request("tiktok", `/v1/conversations/${thread.externalId}/messages`);
    if (snapshot.conversation_id !== thread.externalId || !Array.isArray(snapshot.messages))
      throw new AppError("CUSTOM_API_INVALID_RESPONSE", "The selected conversation changed.");
    return this.store.enqueueMutation(async () => {
      thread.messages = [
        ...snapshot.messages
          .slice(-50)
          .filter((m) => typeof m.text === "string")
          .map((m) => ({ role: "unknown", text: m.text.slice(0, 4000) })),
        ...thread.messages.filter((m) => m.role === "ai_draft")
      ];
      thread.snapshotAt = new Date().toISOString();
      this.store.persist();
      return this.store.getAppState();
    });
  }
  send({ conversationId, text, approvalId, operationId } = {}) {
    if (typeof operationId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(operationId))
      return Promise.reject(new AppError("INVALID_INPUT", "A stable send operation ID is required."));
    if (this.pending.has(operationId)) return this.pending.get(operationId);
    const task = this.dispatch({ conversationId, text, approvalId, operationId });
    this.pending.set(operationId, task);
    task.finally(() => this.pending.delete(operationId)).catch(() => {});
    return task;
  }
  async dispatch({ conversationId, text, approvalId, operationId }) {
    const thread = this.thread(conversationId);
    if (approvalId) {
      const approval = this.store.state.approvals.find((a) => a.id === approvalId);
      if (!approval || approval.status !== "approved" || approval.conversationId !== thread.id || approval.accountId !== thread.accountId)
        throw new AppError("MESSAGE_NOT_APPROVED", "Approve this exact conversation draft before sending it.");
      if (text !== undefined && text !== approval.draft)
        throw new AppError("MESSAGE_NOT_APPROVED", "An edited draft needs a new approval.");
      text = approval.draft;
    }
    if (typeof text !== "string" || !text.trim() || text.length > 1000)
      throw new AppError("INVALID_INPUT", "Messages must contain 1–1000 characters.");
    const fingerprint = hash(JSON.stringify([thread.accountId, thread.externalId, text, approvalId || null]));
    let record;
    await this.store.enqueueMutation(async () => {
      const prior = this.store.state.messageDispatches.find((r) => r.id === operationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new AppError("IDEMPOTENCY_CONFLICT", "This send operation already contains a different message.");
        record = prior;
        return;
      }
      const blocked = this.store.state.messageDispatches.some(
        (r) =>
          r.conversationId === thread.id &&
          (["sending", "outcome_unknown"].includes(r.status) || (approvalId && r.approvalId === approvalId))
      );
      if (blocked)
        throw new AppError(
          "MESSAGE_OUTCOME_UNRESOLVED",
          "Inspect the previous send before starting another. An approved draft can only be submitted once."
        );
      record = {
        id: operationId,
        fingerprint,
        idempotencyKey: hash(`tiktok-message:${operationId}`),
        accountId: thread.accountId,
        conversationId: thread.id,
        externalId: thread.externalId,
        text,
        approvalId: approvalId || null,
        status: "sending",
        createdAt: new Date().toISOString()
      };
      this.store.state.messageDispatches.push(record);
      this.store.persist();
    });
    if (record.status !== "sending" || record.owner) return this.store.getAppState();
    // In-memory ownership is not persisted; the durable 'sending' state becomes
    // unknown on recovery. This also serializes a second window's same intent.
    Object.defineProperty(record, "owner", { value: true, configurable: true });
    try {
      const result = await this.manager.request(
        "tiktok",
        "/v1/messages",
        { conversation_id: thread.externalId, text, dry_run: false },
        record.idempotencyKey
      );
      if (result.state !== "submitted" || result.conversation_id !== thread.externalId)
        throw new AppError("MESSAGE_OUTCOME_UNKNOWN", "The send acknowledgement was unavailable.");
      await this.finish(record, "submitted");
    } catch (error) {
      const beforeWrite = [
        "CUSTOM_API_OFF",
        "ACCOUNT_MISMATCH",
        "BROWSER_LOGIN_REQUIRED",
        "RECIPIENT_AMBIGUOUS",
        "RECIPIENT_MISMATCH"
      ].includes(error.code);
      await this.finish(record, beforeWrite ? "failed" : "outcome_unknown");
      throw error;
    }
    return this.store.getAppState();
  }
  finish(record, status) {
    return this.store.enqueueMutation(async () => {
      if (record.status === "sending") {
        record.status = status;
        record.updatedAt = new Date().toISOString();
        this.store.persist();
      }
    });
  }
  inspect(id) {
    return this.store.enqueueMutation(async () => {
      const record = this.store.state.messageDispatches.find((item) => item.id === id);
      if (!record || record.status !== "outcome_unknown") throw new AppError("INVALID_INPUT", "Only uncertain sends need inspection.");
      this.thread(record.conversationId);
      record.status = "inspected";
      this.store.persist();
      return this.store.getAppState();
    });
  }
  drain() {
    return Promise.allSettled([...this.pending.values()]);
  }
  interrupt() {
    for (const item of this.store.state.messageDispatches || []) if (item.status === "sending") item.status = "outcome_unknown";
    this.store.persist();
  }
}
module.exports = { TikTokMessagingService };
