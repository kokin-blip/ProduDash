const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { PublishingDispatchService } = require("../electron/publishing/dispatch-service.cjs");
const { POST_PLAN_STATUSES } = require("../electron/publishing/post-status.cjs");
const { RECEIPT_STATUSES } = require("../electron/publishing/receipt.cjs");
const {
  SESSION_STATUSES,
  UploadSessionStore,
  createUploadSession,
  isUsableSession,
  vaultKeyFor
} = require("../electron/publishing/upload-session.cjs");
const { ConnectorRegistry } = require("../electron/connectors.cjs");
const { CONNECTOR_CAPABILITIES } = require("../electron/connectors/contract.cjs");
const { CONNECTOR_ERROR_CATEGORIES, connectorError } = require("../electron/errors.cjs");
const { createDirectory, createHarness } = require("./helpers.cjs");

const VIDEO_BYTES = "0123456789abcdef";

// A resumable-upload connector whose provider-side state the test controls.
function resumableConnector({ providerHas = 0, sessionDead = false, onSend, onBegin } = {}) {
  const calls = { begin: 0, probe: 0, send: 0 };
  const state = { bytesHeld: providerHas, videoId: null, sessionDead, received: [] };
  return {
    calls,
    state,
    connector: {
      id: "youtube",
      capabilities: [CONNECTOR_CAPABILITIES.PUBLISH, CONNECTOR_CAPABILITIES.RESUMABLE_UPLOAD, CONNECTOR_CAPABILITIES.PUBLISHING_STATUS],
      getAuthorizationInstructions: () => ({}),
      validateConfiguration: () => ({ valid: true, missing: [] }),
      testConnection: async () => ({ status: "connected" }),
      publish: async () => ({ publicationId: "whole-file" }),
      beginUpload: async () => {
        calls.begin += 1;
        if (onBegin) await onBegin(calls.begin);
        return { uploadUri: `https://upload.example/session-${calls.begin}` };
      },
      probeUpload: async ({ contentLength }) => {
        calls.probe += 1;
        // The provider no longer recognizes the session and cannot say whether
        // it produced a video.
        if (state.sessionDead) return { unresolved: true };
        if (state.videoId) {
          return { completed: true, offset: contentLength, result: { publicationId: state.videoId, privacyStatus: "private" } };
        }
        return { completed: false, offset: state.bytesHeld };
      },
      sendUpload: async ({ body, offset }) => {
        calls.send += 1;
        // Reads the body the way a real transport does, so a stream that has
        // already been consumed shows up as the empty string rather than
        // silently passing.
        const chunks = [];
        for await (const chunk of body) chunks.push(chunk);
        state.received.push(Buffer.concat(chunks).toString());
        if (onSend) await onSend(calls.send, offset, state);
        state.videoId = state.videoId || `video-${calls.send}`;
        return { publicationId: state.videoId, privacyStatus: "private" };
      },
      getPublishingStatus: async () => ({ complete: true, failed: false })
    }
  };
}

async function scenario(t, connectorOptions = {}) {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const outputPath = createDirectory();
  t.after(() => fs.rmSync(outputPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outputPath, "launch.mp4"), VIDEO_BYTES);

  await harness.store.saveIntegrationCredentials("youtube", { clientId: "client-1", clientSecret: "secret-1" });
  await harness.store.saveIntegrationAuthorization("youtube", {
    accessToken: "ya29.token",
    refreshToken: "1//refresh",
    selectedAccount: { id: "UC-channel", name: "Channel" }
  });
  await harness.store.setIntegrationResult("youtube", { status: "connected" });
  harness.store.state.mediaJobs.push({
    id: "media-1",
    status: "completed",
    title: "Launch",
    outputFolderName: path.basename(outputPath),
    artifacts: [{ id: "artifact-1", kind: "video", name: "launch.mp4" }],
    thumbnailSelections: [],
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });

  let state = await harness.store.createPostPlan({ mediaJobId: "media-1", title: "Launch", caption: "Copy", platforms: ["youtube"] });
  const planId = state.postQueue[0].id;
  await harness.store.updatePostPlanDraft(planId, {
    platformPackages: [
      { platformId: "youtube", title: "Launch", caption: "Copy", options: { selfDeclaredMadeForKids: false, privacyStatus: "private" } }
    ]
  });
  state = await harness.store.approvePostPlan(planId, "official_api");
  const idempotencyKey = state.postQueue[0].approvalSnapshot.destinations[0].idempotencyKey;

  const built = resumableConnector(connectorOptions);
  const sessions = new UploadSessionStore(harness.vault);
  const service = new PublishingDispatchService({
    store: harness.store,
    connectorRegistry: new ConnectorRegistry([built.connector]),
    connections: {
      credentialsFor: (id) => harness.store.getIntegrationCredentials(id),
      withFreshAuthorization: (_id, operation) => operation("ya29.token")
    },
    mediaJobs: { getPrivatePaths: () => ({ sourcePath: "/src", outputPath, tempPath: "/tmp" }) },
    uploadSessions: sessions
  });
  return { harness, service, planId, idempotencyKey, sessions, ...built };
}

// A long-abandoned session record. Its age is deliberately extreme: nothing in
// the dispatcher may treat that as an answer in its own right.
function staleSession(harness, planId, idempotencyKey) {
  return createUploadSession({
    planId,
    platformId: "youtube",
    approvalHash: harness.store.getAppState().postQueue[0].approvalSnapshot.hash,
    idempotencyKey,
    uploadUri: "https://upload.example/stale",
    contentLength: VIDEO_BYTES.length,
    createdAt: "2020-01-01T00:00:00.000Z"
  });
}

test("the session URI is persisted before any bytes are sent", async (t) => {
  let sessionAtSendTime = null;
  const { service, planId, sessions, idempotencyKey } = await scenario(t, {
    onSend: async () => {
      // Read the durable record at the exact moment bytes start moving.
      sessionAtSendTime = sessions.get(idempotencyKey);
    }
  });
  await service.dispatch(planId);
  assert.ok(sessionAtSendTime, "a session must already be stored when the upload begins");
  assert.match(sessionAtSendTime.uploadUri, /session-1/);
  assert.equal(sessionAtSendTime.contentLength, VIDEO_BYTES.length);
});

test("a crash after session creation but before upload resumes the same session", async (t) => {
  const { service, planId, sessions, idempotencyKey, calls } = await scenario(t, {
    onSend: async (attempt) => {
      // First attempt dies mid-flight, leaving the session behind.
      if (attempt === 1) throw connectorError(CONNECTOR_ERROR_CATEGORIES.NETWORK, "YOUTUBE_UPLOAD_INTERRUPTED", "Interrupted.");
    }
  });
  await service.dispatch(planId);
  assert.ok(sessions.get(idempotencyKey), "the session survives a failed attempt so the retry can reconcile");

  await service.dispatch(planId);
  // One session, two send attempts -- never a second beginUpload.
  assert.equal(calls.begin, 1, "a retry must not open a second upload session");
  assert.equal(calls.probe, 1);
  assert.equal(calls.send, 2);
});

test("a partial upload resumes from the byte count the provider reports", async (t) => {
  const offsets = [];
  const { service, planId, state } = await scenario(t, {
    onSend: async (attempt, offset) => {
      offsets.push(offset);
      if (attempt === 1) {
        // The provider kept the first 6 bytes before the connection dropped.
        state.bytesHeld = 6;
        throw connectorError(CONNECTOR_ERROR_CATEGORIES.NETWORK, "YOUTUBE_UPLOAD_INTERRUPTED", "Interrupted.");
      }
    }
  });
  await service.dispatch(planId);
  await service.dispatch(planId);
  assert.deepEqual(offsets, [0, 6], "the second attempt resumes rather than restarting");
});

test("a provider that already has the video is reconciled without a second upload", async (t) => {
  // The dangerous case: YouTube accepted everything and created the video, but
  // ProduDash exited before recording the id.
  const { service, planId, calls, state, harness } = await scenario(t, {
    onSend: async (attempt, _offset, providerState) => {
      if (attempt === 1) {
        providerState.videoId = "video-created-before-crash";
        throw connectorError(CONNECTOR_ERROR_CATEGORIES.NETWORK, "YOUTUBE_UPLOAD_INTERRUPTED", "Crashed after the provider committed.");
      }
    }
  });
  await service.dispatch(planId);
  assert.equal(state.videoId, "video-created-before-crash");

  await service.dispatch(planId);
  // The probe found a completed upload, so no second transfer happened at all.
  assert.equal(calls.send, 1, "the video already existed; uploading again would duplicate it");
  assert.equal(calls.begin, 1);
  const plan = harness.store.getAppState().postQueue[0];
  assert.equal(plan.status, POST_PLAN_STATUSES.PUBLISHED);
  assert.equal(plan.publicationReceipts[0].providerPublicationId, "video-created-before-crash");
});

test("a crash after the receipt is persisted does not upload again", async (t) => {
  const { service, planId, calls, harness } = await scenario(t);
  await service.dispatch(planId);
  // Force the plan back into a non-terminal state, keeping its receipts.
  harness.store.state.postQueue[0].status = POST_PLAN_STATUSES.DISPATCH_FAILED;
  await service.dispatch(planId);
  assert.equal(calls.send, 1, "an already-published receipt short-circuits before any upload");
  assert.equal(calls.begin, 1);
});

test("the session record is cleared once the upload succeeds", async (t) => {
  const { service, planId, sessions, idempotencyKey, harness } = await scenario(t);
  await service.dispatch(planId);
  assert.equal(sessions.get(idempotencyKey), null, "a completed upload leaves no session behind");
  assert.equal(harness.store.getAppState().postQueue[0].publicationReceipts[0].hasResumableSession, false);
});

test("an unusable session is not silently replaced", async (t) => {
  const { service, planId, sessions, idempotencyKey, calls, harness } = await scenario(t, { sessionDead: true });
  await sessions.save(staleSession(harness, planId, idempotencyKey));

  const state = await service.dispatch(planId);
  // The provider was asked and could not say. Opening a replacement session
  // could publish a duplicate, so the attempt stops and asks the user instead.
  assert.equal(calls.probe, 1, "the provider must be asked before anything is condemned");
  assert.equal(calls.begin, 0, "no replacement session may be opened while the outcome is unknown");
  assert.equal(calls.send, 0);
  const receipt = state.postQueue[0].publicationReceipts[0];
  assert.equal(receipt.status, RECEIPT_STATUSES.FAILED);
  assert.equal(receipt.errorCode, "UPLOAD_SESSION_UNRESOLVED");
  // The record is kept. Destroying it would make the very next dispatch look
  // like a first attempt and upload a duplicate.
  assert.ok(sessions.get(idempotencyKey), "the unresolved record must survive so later attempts keep refusing");
  // Retrying cannot be made safe by clicking again, so the receipt must not
  // claim otherwise.
  assert.equal(receipt.retryable, false);
  assert.equal(harness.store.getAppState().postQueue[0].status, POST_PLAN_STATUSES.DISPATCH_FAILED);
});

test("an authorization retry mid-upload sends a fresh stream, not a drained one", async (t) => {
  // A token can be revoked or expire while bytes are moving.
  // withFreshAuthorization answers that by re-invoking the operation once --
  // so anything the operation closes over has to survive being used twice.
  const { service, planId, state, calls } = await scenario(t, {
    onSend: async (attempt) => {
      if (attempt === 1) throw connectorError(CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION, "YOUTUBE_AUTH_FAILED", "Token rejected.");
    }
  });
  // Mirrors ConnectionService.withFreshAuthorization: one bounded retry when
  // the provider rejects the token.
  service.connections.withFreshAuthorization = async (_id, operation) => {
    try {
      return await operation("ya29.token");
    } catch (error) {
      if (error?.category !== "authentication") throw error;
      return operation("ya29.refreshed");
    }
  };

  await service.dispatch(planId);
  assert.equal(calls.send, 2, "the rejected attempt is retried once");
  // A reused stream would already be at EOF, so the retry would declare the
  // full Content-Length and then send nothing -- committing a truncated body
  // that the next probe reads back as a legitimate partial offset.
  assert.equal(state.received[1], VIDEO_BYTES, "the retry must send the whole file, not an exhausted stream");
});

test("an approval made before the provider required choices is refused, not guessed at", async (t) => {
  const { service, planId, calls, harness } = await scenario(t);
  // A v1 approval snapshot: its payload predates per-destination options, so
  // nobody was ever asked for an audience declaration. The snapshot is
  // immutable, and inventing the answer would be ProduDash making a legal
  // statement on the user's behalf.
  delete harness.store.state.postQueue[0].approvalSnapshot.payload.platformPackages[0].options;

  const state = await service.dispatch(planId);
  assert.equal(calls.begin, 0, "nothing may be opened against an approval that never captured the choices");
  assert.equal(calls.send, 0);
  const receipt = state.postQueue[0].publicationReceipts[0];
  assert.equal(receipt.errorCode, "APPROVAL_PREDATES_REQUIRED_OPTIONS");
  // Retrying re-reads the same frozen snapshot, so it can only fail again.
  assert.equal(receipt.retryable, false);
});

test("age alone never condemns a session -- the provider is asked", async (t) => {
  // The regression behind this: a session older than an arbitrary cutoff used
  // to be declared unusable without asking, forcing a restart of an upload the
  // provider was still perfectly willing to resume.
  const { service, planId, sessions, idempotencyKey, calls, harness } = await scenario(t, { providerHas: 6 });
  await sessions.save(staleSession(harness, planId, idempotencyKey));

  const state = await service.dispatch(planId);
  assert.equal(calls.probe, 1);
  assert.equal(calls.begin, 0, "an old but live session is resumed, not replaced");
  assert.equal(calls.send, 1);
  assert.equal(state.postQueue[0].publicationReceipts[0].status, RECEIPT_STATUSES.PUBLISHED);
});

test("a crash between the upload and the receipt does not upload again", async (t) => {
  // The window the whole module exists to close, in its last hiding place: the
  // provider has committed the video and returned its id, but ProduDash dies
  // before that id is durably recorded. If the session was already cleared, the
  // next dispatch sees no receipt and no session -- a first attempt -- and
  // publishes a duplicate.
  const { service, planId, sessions, idempotencyKey, calls, harness } = await scenario(t);
  const record = harness.store.recordPublicationReceipt.bind(harness.store);
  let crashOnPublished = true;
  harness.store.recordPublicationReceipt = async (id, receipt) => {
    if (crashOnPublished && receipt.status === RECEIPT_STATUSES.PUBLISHED) throw new Error("process died");
    return record(id, receipt);
  };

  await service.dispatch(planId);
  assert.equal(calls.send, 1, "the bytes went up");
  assert.ok(sessions.get(idempotencyKey), "the session must outlive the upload, not the receipt");

  crashOnPublished = false;
  await service.dispatch(planId);
  assert.equal(calls.begin, 1, "the recovered session must be reused, never replaced");
  assert.equal(calls.send, 1, "the provider already has the video; sending again would duplicate it");
  const receipt = harness.store.getAppState().postQueue[0].publicationReceipts[0];
  assert.equal(receipt.status, RECEIPT_STATUSES.PUBLISHED);
  assert.equal(receipt.providerPublicationId, "video-1");
  assert.equal(sessions.get(idempotencyKey), null, "only now is the session finished with");
});

test("an unresolved session keeps refusing however often it is retried", async (t) => {
  // The regression this module exists for: a refusal that clears the record
  // turns the next attempt back into a first attempt, and the duplicate that
  // was just prevented gets published anyway.
  const { service, planId, sessions, idempotencyKey, calls, harness } = await scenario(t, { sessionDead: true });
  await sessions.save(staleSession(harness, planId, idempotencyKey));

  await service.dispatch(planId);
  const state = await service.dispatch(planId);

  assert.equal(calls.begin, 0, "a second retry must not open a replacement session either");
  assert.equal(calls.send, 0, "nothing may be uploaded while the earlier outcome is unknown");
  assert.ok(sessions.get(idempotencyKey), "the record still survives");
  const receipt = state.postQueue[0].publicationReceipts[0];
  assert.equal(receipt.errorCode, "UPLOAD_SESSION_UNRESOLVED");
  assert.equal(receipt.retryable, false);
});

test("discarding an unresolved session is what unblocks a fresh upload", async (t) => {
  const { service, planId, sessions, idempotencyKey, calls, state, harness } = await scenario(t, { sessionDead: true });
  await sessions.save(staleSession(harness, planId, idempotencyKey));
  await service.dispatch(planId);
  assert.equal(calls.begin, 0);

  // The user has checked the destination and states nothing was published --
  // the one claim ProduDash cannot make for itself.
  const afterDiscard = await service.discardUploadSession(planId, "youtube");
  assert.equal(sessions.get(idempotencyKey), null, "the dead record is gone");
  const discarded = afterDiscard.postQueue[0].publicationReceipts[0];
  assert.equal(discarded.hasResumableSession, false);
  assert.equal(discarded.retryable, true, "the block was the unknown outcome, and it has been resolved");
  // The renderer keys its warning and its discard control off this code, so a
  // record still saying UNRESOLVED would make the action look like a no-op.
  assert.equal(discarded.errorCode, "UPLOAD_SESSION_DISCARDED");
  assert.equal(discarded.status, RECEIPT_STATUSES.FAILED, "the attempt did fail, and the record keeps saying so");

  state.sessionDead = false;
  const republished = await service.dispatch(planId);
  assert.equal(calls.begin, 1, "only now may a fresh session be opened");
  assert.equal(republished.postQueue[0].publicationReceipts[0].status, RECEIPT_STATUSES.PUBLISHED);
});

test("a session whose file has since changed size is refused rather than resumed", async (t) => {
  const { service, planId, sessions, idempotencyKey, calls, harness } = await scenario(t);
  // The approval hash covers media names and sources, not bytes, so re-running
  // the media job keeps this idempotency key while changing the file. Resuming
  // would splice two different renders together into one corrupt video.
  await sessions.save(
    createUploadSession({
      planId,
      platformId: "youtube",
      approvalHash: harness.store.getAppState().postQueue[0].approvalSnapshot.hash,
      idempotencyKey,
      uploadUri: "https://upload.example/older-render",
      contentLength: VIDEO_BYTES.length + 40
    })
  );

  const state = await service.dispatch(planId);
  assert.equal(calls.probe, 0, "a session recorded against a different file must not even be probed");
  assert.equal(calls.send, 0);
  assert.equal(calls.begin, 0);
  const receipt = state.postQueue[0].publicationReceipts[0];
  assert.equal(receipt.errorCode, "UPLOAD_SESSION_UNRESOLVED");
  assert.equal(receipt.retryable, false);
});

test("an unresolved record is not reported as a resumable session", async (t) => {
  const { service, planId, sessions, idempotencyKey, harness } = await scenario(t, { sessionDead: true });
  await sessions.save(staleSession(harness, planId, idempotencyKey));
  const state = await service.dispatch(planId);
  const receipt = state.postQueue[0].publicationReceipts[0];
  // A dead record still exists in the vault, but claiming it is resumable while
  // also refusing to retry would be two contradictory statements in one receipt.
  assert.ok(sessions.get(idempotencyKey), "the record is retained");
  assert.equal(receipt.hasResumableSession, false);
  assert.equal(receipt.retryable, false);
});

test("what makes a record unusable is its status, never its age", () => {
  const base = {
    planId: "p",
    platformId: "youtube",
    approvalHash: "a".repeat(64),
    idempotencyKey: "b".repeat(64),
    uploadUri: "https://upload.example/s",
    contentLength: 10
  };
  assert.equal(isUsableSession(createUploadSession(base)), true);
  // Old is not the same as dead, and only the provider can tell them apart.
  assert.equal(isUsableSession(createUploadSession({ ...base, createdAt: "2020-01-01T00:00:00.000Z" })), true);
  assert.equal(isUsableSession(null), false);
  assert.equal(isUsableSession({ ...createUploadSession(base), status: SESSION_STATUSES.UNRESOLVED }), false);
  assert.equal(isUsableSession({ ...createUploadSession(base), uploadUri: "" }), false);
});

test("the session URI never reaches app state, receipts, or exports", async (t) => {
  const { service, planId, harness, sessions, idempotencyKey } = await scenario(t, {
    onSend: async (attempt) => {
      if (attempt === 1) throw connectorError(CONNECTOR_ERROR_CATEGORIES.NETWORK, "YOUTUBE_UPLOAD_INTERRUPTED", "Interrupted.");
    }
  });
  await service.dispatch(planId);

  const stored = sessions.get(idempotencyKey);
  assert.ok(stored.uploadUri, "the URI is retained privately");
  const serializedState = JSON.stringify(harness.store.getAppState());
  assert.equal(serializedState.includes(stored.uploadUri), false, "the session URI must not appear in app state");
  assert.equal(serializedState.includes("upload.example"), false);

  // It lives in the encrypted vault, under its own key.
  assert.ok(harness.vault.get(vaultKeyFor(idempotencyKey)).session);

  // Public state says only that a session exists.
  const receipt = harness.store.getAppState().postQueue[0].publicationReceipts[0];
  assert.equal(receipt.hasResumableSession, true);
  assert.equal(Object.hasOwn(receipt, "uploadUri"), false);
});

test("discarding is refused unless the destination is actually unresolved", async (t) => {
  // The IPC channel accepts any plan and platform, so a stale button in an old
  // render -- or a second window -- must not be able to clear the session of an
  // upload that is still running. That record is the only thing standing
  // between an interrupted upload and a duplicate.
  const { service, planId, sessions, idempotencyKey } = await scenario(t, {
    onSend: async () => {
      await assert.rejects(service.discardUploadSession(planId, "youtube"), { code: "UPLOAD_SESSION_NOT_DISCARDABLE" });
      assert.ok(sessions.get(idempotencyKey), "the in-flight session must survive the attempt");
    }
  });
  await service.dispatch(planId);

  // And once published there is nothing to discard either.
  await assert.rejects(service.discardUploadSession(planId, "youtube"), { code: "UPLOAD_SESSION_NOT_DISCARDABLE" });
});

test("a crash between discarding and clearing cannot produce a duplicate", async (t) => {
  const { service, planId, sessions, idempotencyKey, calls, harness } = await scenario(t, { sessionDead: true });
  await sessions.save(staleSession(harness, planId, idempotencyKey));
  await service.dispatch(planId);

  // Die between the two writes. Clearing first would already have destroyed the
  // session by this point; recording first has not touched it yet.
  const realRecord = harness.store.recordPublicationReceipt.bind(harness.store);
  harness.store.recordPublicationReceipt = async () => {
    throw new Error("process died");
  };
  await assert.rejects(service.discardUploadSession(planId, "youtube"));
  harness.store.recordPublicationReceipt = realRecord;

  // The session survived, so the next dispatch still reconciles rather than
  // starting over. Clearing first would have left no session and no receipt
  // change -- a fresh upload, and a second video.
  assert.ok(sessions.get(idempotencyKey), "the session must outlive a failed discard");
  await service.dispatch(planId);
  assert.equal(calls.begin, 0, "no fresh session may be opened after a half-finished discard");
  assert.equal(calls.send, 0);
});

test("an authorization retry asks the provider where to resume", async (t) => {
  // A token can be rejected *after* the provider has already accepted bytes, so
  // its cursor has moved. Replaying the range computed before that attempt is a
  // bad Content-Range, which the provider rejects as a validation error -- and
  // validation errors are not retryable, so the destination would be written off
  // as permanently failed while its session was still perfectly resumable.
  const offsets = [];
  const { service, planId, calls } = await scenario(t, {
    onSend: async (attempt, offset, providerState) => {
      offsets.push(offset);
      if (attempt === 1) {
        providerState.bytesHeld = 9;
        throw connectorError(CONNECTOR_ERROR_CATEGORIES.AUTHENTICATION, "YOUTUBE_AUTH_FAILED", "Token rejected.");
      }
    }
  });
  // Mirrors ConnectionService.withFreshAuthorization: one bounded retry when the
  // provider rejects the token.
  service.connections.withFreshAuthorization = async (_id, operation) => {
    try {
      return await operation("ya29.token");
    } catch (error) {
      if (error?.category !== "authentication") throw error;
      return operation("ya29.refreshed");
    }
  };

  await service.dispatch(planId);
  assert.deepEqual(offsets, [0, 9], "the retry must resume where the provider actually is");
  assert.equal(calls.probe, 1, "which means asking it, not reusing the offset from before the failure");
});

test("a record from a different build is asked about, not written off", async (t) => {
  // SESSION_VERSION exists to be bumped. Refusing on it alone meant the next
  // bump would tell everyone with an interrupted upload that it could not be
  // reconciled with the provider -- without ever asking the provider, and while
  // the session URI was still valid.
  const { service, planId, sessions, idempotencyKey, calls, harness } = await scenario(t, { providerHas: 6 });
  await sessions.save({ ...staleSession(harness, planId, idempotencyKey), version: 99 });

  const state = await service.dispatch(planId);
  assert.equal(calls.probe, 1, "the provider decides, not the version number");
  assert.equal(calls.begin, 0, "and the existing session is reused rather than replaced");
  assert.equal(state.postQueue[0].publicationReceipts[0].status, RECEIPT_STATUSES.PUBLISHED);
});

test("a structurally unusable record is refused without being probed", () => {
  const base = {
    planId: "p",
    platformId: "youtube",
    approvalHash: "a".repeat(64),
    idempotencyKey: "b".repeat(64),
    uploadUri: "https://upload.example/s",
    contentLength: 10
  };
  assert.equal(isUsableSession(createUploadSession(base)), true);
  // The two fields the provider actually acts on have to be there and sane.
  assert.equal(isUsableSession({ ...createUploadSession(base), uploadUri: "" }), false);
  assert.equal(isUsableSession({ ...createUploadSession(base), contentLength: 0 }), false);
  assert.equal(isUsableSession({ ...createUploadSession(base), contentLength: undefined }), false);
  assert.equal(isUsableSession({ ...createUploadSession(base), status: SESSION_STATUSES.UNRESOLVED }), false);
  assert.equal(isUsableSession(null), false);
});

test("abandoning a plan releases the upload sessions it orphans", async (t) => {
  // A record is addressed by its destination's idempotency key. Once the plan
  // carrying that destination is gone there is nothing left to reconstruct the
  // key from, so the record becomes permanently unreachable -- while still
  // holding a URI that can append bytes to a real upload.
  const { service, planId, sessions, idempotencyKey, harness } = await scenario(t, { sessionDead: true });
  await sessions.save(staleSession(harness, planId, idempotencyKey));
  await service.dispatch(planId);
  assert.ok(sessions.get(idempotencyKey), "the session is still there while the plan is");

  await harness.store.cancelPostPlan(planId);
  await service.releaseSessionsForPlan(planId);
  assert.equal(sessions.get(idempotencyKey), null);
  assert.equal(harness.vault.get(vaultKeyFor(idempotencyKey)).session, undefined, "and it is gone from the vault, not just from view");
});

test("a reset releases every session, including ones it can no longer name", async (t) => {
  const { service, planId, sessions, idempotencyKey, harness } = await scenario(t);
  await sessions.save(staleSession(harness, planId, idempotencyKey));
  // A record whose plan has already been discarded: nothing can address it.
  const orphan = "f".repeat(64);
  await sessions.save({ ...staleSession(harness, planId, idempotencyKey), idempotencyKey: orphan });

  await service.releaseAllSessions();
  assert.equal(sessions.get(idempotencyKey), null);
  assert.equal(sessions.get(orphan), null);
});

test("an approval missing only a newly required choice is refused with the message that helps", async (t) => {
  // A snapshot approved when the platform declared fewer options carries a
  // truthy options object that is missing the newest one. Testing only that the
  // object existed let that reach the connector, which raised a non-retryable
  // validation error -- leaving a locked plan and a message about a missing
  // declaration that never said what to do about it.
  const { service, planId, calls, harness } = await scenario(t);
  delete harness.store.state.postQueue[0].approvalSnapshot.payload.platformPackages[0].options.selfDeclaredMadeForKids;

  const state = await service.dispatch(planId);
  assert.equal(calls.begin, 0);
  const receipt = state.postQueue[0].publicationReceipts[0];
  assert.equal(receipt.errorCode, "APPROVAL_PREDATES_REQUIRED_OPTIONS");
  assert.equal(receipt.retryable, false);
});

test("a destination declared unretryable is not re-attempted by a stale click", async (t) => {
  // The renderer withholds the control, but it cannot bind a second window or a
  // DOM that predates the receipt. Every accepted click appended an attempt,
  // and the history is capped -- so repeated clicks evicted the record of what
  // actually went wrong.
  const { service, planId, sessions, idempotencyKey, calls, harness } = await scenario(t, { sessionDead: true });
  await sessions.save(staleSession(harness, planId, idempotencyKey));
  await service.dispatch(planId);
  const before = harness.store.getAppState().postQueue[0].publicationReceipts[0];
  assert.equal(before.retryable, false);
  const attemptsBefore = before.attempts.length;

  await service.dispatch(planId);
  await service.dispatch(planId);
  const after = harness.store.getAppState().postQueue[0].publicationReceipts[0];
  assert.equal(calls.probe, 1, "the provider is not asked again on a refused destination");
  assert.equal(calls.begin, 0);
  assert.equal(after.attempts.length, attemptsBefore, "and no attempt is appended to push out the real history");
});

test("any blocked destination can be cleared, not only an unresolved one", async (t) => {
  // The escape started as a way out of UPLOAD_SESSION_UNRESOLVED alone. Every
  // other route into a non-retryable receipt reached the same dead end with
  // nothing able to clear it, so blocking became a one-way door.
  // Fails before a session exists, so nothing about the upload is resumable and
  // the destination is genuinely blocked rather than merely interrupted.
  let refuse = true;
  const { service, planId, calls, harness } = await scenario(t, {
    onBegin: async () => {
      if (refuse) throw connectorError(CONNECTOR_ERROR_CATEGORIES.VALIDATION, "YOUTUBE_REQUEST_REJECTED", "Rejected.");
    }
  });
  await service.dispatch(planId);
  const blocked = harness.store.getAppState().postQueue[0].publicationReceipts[0];
  assert.equal(blocked.retryable, false, "a validation failure with nothing to resume is not retryable");
  assert.notEqual(blocked.errorCode, "UPLOAD_SESSION_UNRESOLVED");

  const after = await service.discardUploadSession(planId, "youtube");
  assert.equal(after.postQueue[0].publicationReceipts[0].retryable, true, "clearing it has to make another attempt possible");

  // And that attempt actually runs.
  refuse = false;
  await service.dispatch(planId);
  assert.equal(calls.begin, 2, "a cleared destination is attempted again");
});

test("a destination that already published cannot have its record cleared", async (t) => {
  // The provider id is the only thing stopping a retry from duplicating a video
  // that exists, so it must not be discardable however the receipt reads.
  const { service, planId, harness } = await scenario(t);
  await service.dispatch(planId);
  const receipt = harness.store.getAppState().postQueue[0].publicationReceipts[0];
  assert.ok(receipt.providerPublicationId);
  harness.store.state.postQueue[0].publicationReceipts[0].status = RECEIPT_STATUSES.FAILED;
  harness.store.state.postQueue[0].publicationReceipts[0].retryable = false;

  await assert.rejects(service.discardUploadSession(planId, "youtube"), { code: "PUBLICATION_ALREADY_EXISTS" });
});
