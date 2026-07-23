const assert = require("node:assert/strict");
const test = require("node:test");
const { AI_CAPABILITIES } = require("../electron/ai/capabilities.cjs");
const { invokeCapability, requireCapability } = require("../electron/ai/provider-contract.cjs");
const { ProviderRegistry } = require("../electron/ai/provider-registry.cjs");
const { ProviderService } = require("../electron/ai/provider-service.cjs");
const { createHarness } = require("./helpers.cjs");

function fakeAdapter(overrides = {}) {
  return {
    id: "gemini",
    name: "Test Gemini",
    credentialFields: [{ key: "apiKey", label: "API key", sensitive: true, required: true }],
    listModels: () => [
      {
        id: "gemini-3.6-flash",
        name: "Gemini 3.6 Flash",
        capabilities: [AI_CAPABILITIES.TEXT_GENERATION, AI_CAPABILITIES.STRUCTURED_OUTPUT]
      }
    ],
    validate: async () => true,
    generateStructured: async ({ prompt }) => ({ prompt }),
    ...overrides
  };
}

test("capability contracts reject unknown, undeclared, and unimplemented operations uniformly", async () => {
  const model = { id: "model", capabilities: [AI_CAPABILITIES.STRUCTURED_OUTPUT, AI_CAPABILITIES.STREAMING] };
  assert.throws(
    () => requireCapability(model, AI_CAPABILITIES.EMBEDDINGS),
    (error) => error.code === "CAPABILITY_UNSUPPORTED"
  );
  assert.throws(
    () => requireCapability(model, "made_up_capability"),
    (error) => error.code === "CAPABILITY_UNSUPPORTED"
  );
  await assert.rejects(
    () => invokeCapability({}, model, AI_CAPABILITIES.STREAMING, {}),
    (error) => error.code === "CAPABILITY_UNSUPPORTED"
  );
  const result = await invokeCapability(
    { generateStructured: async ({ modelId }) => modelId },
    model,
    AI_CAPABILITIES.STRUCTURED_OUTPUT,
    {}
  );
  assert.equal(result, "model");
});

test("provider initialization refreshes public model metadata without exposing credentials", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const adapter = fakeAdapter();
  const providers = new ProviderService({ store: harness.store, registry: new ProviderRegistry([adapter]) });
  await providers.initialize();
  await harness.store.saveAiProviderCredentials("gemini", { apiKey: "AIza-private-key" }, adapter.credentialFields);
  const state = await providers.testConnection("gemini");
  const profile = state.aiProviders[0];
  assert.equal(profile.name, "Test Gemini");
  assert.deepEqual(profile.models, adapter.listModels());
  assert.equal(profile.status, "connected");
  assert.equal(JSON.stringify(state).includes("AIza-private-key"), false);
});

test("workload assignments enforce capabilities and same-as-advisor compatibility", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const providers = new ProviderService({
    store: harness.store,
    registry: new ProviderRegistry([fakeAdapter()])
  });
  await providers.initialize();
  const state = await providers.setWorkload("clipAnalysis", { mode: "same_as_advisor" });
  assert.equal(state.aiWorkloads.clipAnalysis.mode, "same_as_advisor");
  await assert.rejects(
    () =>
      providers.setWorkload("transcription", {
        mode: "provider",
        profileId: "gemini",
        modelId: "gemini-3.6-flash"
      }),
    (error) => error.code === "CAPABILITY_UNSUPPORTED"
  );
  const unassigned = await providers.setWorkload("transcription", { mode: "unassigned" });
  assert.equal(unassigned.aiWorkloads.transcription.mode, "unassigned");
});
