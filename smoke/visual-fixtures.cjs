const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { getMediaBinaries } = require("../electron/media/binaries.cjs");
const { buildPlatformCatalog } = require("../electron/platforms/catalog.cjs");
const { createAuthorizationRecord } = require("../electron/platforms/authorization.cjs");

function createMediaFixture(filePath) {
  const { ffmpegPath } = getMediaBinaries();
  const result = spawnSync(
    ffmpegPath,
    [
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:sample_rate=48000",
      "-t",
      "6",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      filePath
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
}

function createLogoFixture(filePath) {
  const { ffmpegPath } = getMediaBinaries();
  const result = spawnSync(
    ffmpegPath,
    ["-nostdin", "-y", "-f", "lavfi", "-i", "color=c=0x7aa2f7:s=128x64", "-frames:v", "1", "-update", "1", filePath],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
}

async function renderConnectedFixture(page) {
  // The derived catalog is produced by the same main-process builder the real
  // app uses, so this fixture cannot drift from deriveConnectionState.
  const platformCatalog = buildPlatformCatalog({
    integrations: [{ id: "shopify", name: "Shopify", status: "connected", authorization: createAuthorizationRecord() }],
    credentialSettings: [{ id: "shopify", name: "Shopify", status: "stored", fields: [] }]
  });
  return page.evaluate(async (platformCatalog) => {
    const state = await import("./src/renderer/state.js");
    const render = await import("./src/renderer/render.js");
    const fixture = {
      schemaVersion: 6,
      selectedBusinessId: "business-1",
      businesses: [
        {
          id: "business-1",
          name: "Northstar Supply",
          type: "Shopify store",
          category: "Outdoor goods",
          health: "Connected",
          connectionStatus: "connected",
          currency: "USD",
          metrics: { revenue: 6840, orderCount: 2, profit: null, conversion: null },
          financeTrend: [
            { week: "Jun 30", revenue: 920 },
            { week: "Jul 7", revenue: 1510 },
            { week: "Jul 14", revenue: 1890 },
            { week: "Jul 21", revenue: 2520 }
          ],
          orders: [
            {
              id: "#1042",
              customer: "Avery Chen",
              paymentStatus: "paid",
              fulfillmentStatus: "fulfilled",
              value: 2640,
              currency: "USD"
            },
            {
              id: "#1041",
              customer: "Morgan Lee",
              paymentStatus: "paid",
              fulfillmentStatus: "unfulfilled",
              value: 4200,
              currency: "USD"
            }
          ],
          signals: [{ id: "signal-1", level: "high", title: "Order #1041 awaits fulfillment", detail: "Payment is verified." }]
        }
      ],
      conversations: [
        {
          id: "conversation-1",
          businessId: "business-1",
          customer: "Taylor Brooks",
          channel: "Instagram",
          intent: "Product question",
          risk: "Human review",
          status: "open",
          messages: []
        }
      ],
      approvals: [
        {
          id: "approval-1",
          businessId: "business-1",
          conversationId: "conversation-1",
          type: "reply",
          status: "pending",
          nextAction: "Review product reply",
          draft: "A concise draft is ready for review."
        }
      ],
      integrations: [
        {
          id: "shopify",
          name: "Shopify",
          status: "connected",
          detail: "Store identity and recent commerce data verified.",
          lastSync: "Just now"
        }
      ],
      credentialSettings: [{ id: "shopify", name: "Shopify", status: "stored", fields: [] }],
      aiProviders: [
        {
          id: "gemini",
          providerType: "gemini",
          name: "Google Gemini",
          status: "connected",
          credentialStatus: "stored",
          selectedModelId: "gemini-3.6-flash",
          models: [
            {
              id: "gemini-3.6-flash",
              name: "Gemini 3.6 Flash",
              capabilities: ["text_generation", "structured_output", "tool_calling"]
            }
          ]
        }
      ],
      aiWorkloads: {
        advisor: { mode: "provider", profileId: "gemini", modelId: "gemini-3.6-flash" },
        inboxDrafting: { mode: "provider", profileId: "gemini", modelId: "gemini-3.6-flash" },
        clipAnalysis: { mode: "same_as_advisor" },
        transcription: { mode: "unassigned" }
      },
      advisorSettings: { displayName: "Juanito" },
      creatorPlatforms: [],
      analyticsSources: [],
      clipperJobs: [],
      postQueue: [],
      auditLog: [{ id: "audit-1", at: new Date().toISOString(), type: "shopify_sync", detail: "Shopify snapshot refreshed." }],
      systemNotices: [],
      platformCatalog
    };
    state.setAppState(fixture);
    state.ui.activeSection = "overview";
    state.ui.error = null;
    state.ui.pending.clear();
    render.renderApp();
    document.activeElement.blur();
    return fixture;
  }, platformCatalog);
}

module.exports = { createMediaFixture, createLogoFixture, renderConnectedFixture };
