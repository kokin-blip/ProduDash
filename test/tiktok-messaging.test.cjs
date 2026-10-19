const test = require("node:test");
const assert = require("node:assert/strict");
const { TikTokMessagingService } = require("../electron/custom-apis/messaging.cjs");
const { createHarness } = require("./helpers.cjs");
async function fixture(t) {
  const h = await createHarness();
  t.after(h.cleanup);
  let account = "jamftest";
  const calls = [];
  const manager = {
    account: () => ({ id: account }),
    request: async (_id, route, body, key) => {
      calls.push({ route, body, key });
      if (route === "/v1/conversations")
        return {
          conversations: [
            { id: "0:1:123:123", name: "jamftest" },
            { id: "0:1:123:456", name: "Same nickname" }
          ]
        };
      if (route.endsWith("/messages") && !body) return { conversation_id: "0:1:123:123", messages: [{ text: "Hello" }] };
      assert.equal(h.store.state.messageDispatches[0].status, "sending", "intent persisted before HTTP");
      return { state: "submitted", conversation_id: body.conversation_id };
    }
  };
  const service = new TikTokMessagingService({ manager, store: h.store });
  service.initialize();
  await service.refreshConversations();
  return {
    ...h,
    manager,
    service,
    calls,
    setAccount: (value) => {
      account = value;
    },
    thread: h.store.state.conversations.find((c) => c.source === "tiktok")
  };
}
test("TikTok chats load without a commerce business and can read a bounded selected snapshot", async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.state.businesses.length, 0);
  await f.service.refreshMessages(f.thread.id);
  assert.equal(f.thread.messages[0].text, "Hello");
  f.setAccount("other");
  await assert.rejects(f.service.refreshMessages(f.thread.id), { code: "ACCOUNT_MISMATCH" });
});
test("manual sends persist intent, deduplicate a double click, and replay without a second HTTP send", async (t) => {
  const f = await fixture(t);
  const input = { conversationId: f.thread.id, text: "API fixture test", operationId: "manual-test-001" };
  const a = f.service.send(input),
    b = f.service.send(input);
  assert.equal(a, b);
  await a;
  await f.service.send(input);
  assert.equal(f.calls.filter((c) => c.body).length, 1);
  assert.equal(f.store.state.messageDispatches[0].status, "submitted");
  await assert.rejects(f.service.send({ ...input, text: "changed" }), { code: "IDEMPOTENCY_CONFLICT" });
});
test("approved drafts require exact approval and never resend under a new operation ID", async (t) => {
  const f = await fixture(t);
  f.store.state.approvals.push({
    id: "approval-test",
    accountId: "jamftest",
    conversationId: f.thread.id,
    status: "pending",
    draft: "Approved text"
  });
  const input = { conversationId: f.thread.id, approvalId: "approval-test", operationId: "approved-test-01" };
  await assert.rejects(f.service.send(input), { code: "MESSAGE_NOT_APPROVED" });
  f.store.state.approvals[0].status = "approved";
  await assert.rejects(f.service.send({ ...input, text: "edited" }), { code: "MESSAGE_NOT_APPROVED" });
  await f.service.send(input);
  await assert.rejects(f.service.send({ ...input, operationId: "approved-test-02" }), { code: "MESSAGE_OUTCOME_UNRESOLVED" });
});
test("unknown sends block fresh keys until inspection and interrupted records recover as unknown", async (t) => {
  const f = await fixture(t);
  f.manager.request = async () => {
    throw new Error("lost response");
  };
  const input = { conversationId: f.thread.id, text: "Unknown test", operationId: "unknown-test-01" };
  await assert.rejects(f.service.send(input));
  assert.equal(f.store.state.messageDispatches[0].status, "outcome_unknown");
  await assert.rejects(f.service.send({ ...input, operationId: "unknown-test-02" }), { code: "MESSAGE_OUTCOME_UNRESOLVED" });
  await f.service.inspect(input.operationId);
  assert.equal(f.store.state.messageDispatches[0].status, "inspected");
  f.store.state.messageDispatches[0].status = "sending";
  f.service.initialize();
  assert.equal(f.store.state.messageDispatches[0].status, "outcome_unknown");
});
