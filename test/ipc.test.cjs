const assert = require("node:assert/strict");
const test = require("node:test");
const { createHandlers } = require("../electron/ipc.cjs");

function fixtures(isTrustedSender) {
  const state = { schemaVersion: 4 };
  const store = {
    getAppState: () => state,
    approveAiAction: async () => state,
    rejectAiAction: async () => state,
    completeCommand: async () => state,
    resetDashboardData: async () => state,
    deleteAllLocalData: async () => state,
    saveIntegrationCredentials: async () => ({ credentialSettings: [] }),
    removeIntegrationCredentials: async () => state,
    createClipJob: async () => state,
    createPostPlan: async () => state,
    approvePostPlan: async () => state,
    markPostExported: async () => state
  };
  const connections = {
    draftAiReply: async () => ({ state }),
    refreshIntegration: async () => state,
    refreshConnections: async () => state
  };
  return createHandlers({ store, connections, isTrustedSender, chooseSourceVideo: async () => null });
}

test("IPC rejects untrusted senders before invoking privileged handlers", async () => {
  const handlers = fixtures(() => false);
  const response = await handlers["produdash:getAppState"]({});
  assert.deepEqual(response, {
    ok: false,
    error: {
      code: "UNTRUSTED_IPC_SENDER",
      message: "The request did not come from the ProduDash application."
    }
  });
});

test("IPC returns normalized success envelopes", async () => {
  const handlers = fixtures(() => true);
  const response = await handlers["produdash:getAppState"]({});
  assert.deepEqual(response, { ok: true, data: { schemaVersion: 4 } });
});

test("dashboard reset and delete-all clear only ProduDash library metadata", async () => {
  const events = [];
  const state = { schemaVersion: 4 };
  const handlers = createHandlers({
    store: {
      resetDashboardData: async () => {
        events.push("reset-state");
        return state;
      },
      deleteAllLocalData: async () => {
        events.push("delete-state");
        return state;
      }
    },
    connections: {},
    providers: {},
    mediaLibrary: {
      clear: async (options) => events.push(options?.removeIndex ? "remove-index" : "clear-index")
    },
    isTrustedSender: () => true
  });
  assert.equal((await handlers["produdash:resetDashboardData"]({})).ok, true);
  assert.deepEqual(events, ["clear-index", "reset-state"]);
  events.length = 0;
  assert.equal((await handlers["produdash:deleteAllLocalData"]({})).ok, true);
  assert.deepEqual(events, ["remove-index", "delete-state"]);
});

test("IPC returns controlled errors without stacks or secrets", async () => {
  const handlers = createHandlers({
    store: {
      getAppState() {
        throw Object.assign(new Error("raw token shpat_secret"), { stack: "secret stack" });
      }
    },
    connections: {},
    isTrustedSender: () => true,
    chooseSourceVideo: async () => null
  });
  const response = await handlers["produdash:getAppState"]({});
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INTERNAL_ERROR");
  assert.equal(JSON.stringify(response).includes("shpat_secret"), false);
  assert.equal(JSON.stringify(response).includes("stack"), false);
});
