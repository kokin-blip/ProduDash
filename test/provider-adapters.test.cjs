const assert = require("node:assert/strict");
const test = require("node:test");
const { AnthropicProviderAdapter } = require("../electron/ai/adapters/anthropic.cjs");
const { OpenAIProviderAdapter } = require("../electron/ai/adapters/openai.cjs");
const { OpenAICompatibleProviderAdapter, parseConfiguredCapabilities } = require("../electron/ai/adapters/openai-compatible.cjs");
const { ElevenLabsProviderAdapter } = require("../electron/ai/adapters/elevenlabs.cjs");
const { createOriginLockedFetch, normalizeCustomEndpoint } = require("../electron/ai/endpoint-validation.cjs");

test("OpenAI adapter uses Responses structured output and normalizes tool calls", async () => {
  const calls = [];
  const adapter = new OpenAIProviderAdapter({
    clientFactory: () => ({
      responses: {
        create: async (input) => {
          calls.push(input);
          return input.tools
            ? {
                output_text: "Checking",
                output: [{ type: "function_call", call_id: "call-1", name: "lookup", arguments: '{"orderId":"42"}' }]
              }
            : { output_text: '{"reply":"Draft"}' };
        }
      }
    })
  });
  const structured = await adapter.generateStructured({
    credentials: { apiKey: "sk-private-key" },
    modelId: "gpt-5.6-terra",
    prompt: "Draft",
    schema: { type: "object" },
    schemaName: "draft reply"
  });
  assert.deepEqual(structured, { reply: "Draft" });
  assert.equal(calls[0].text.format.type, "json_schema");
  const tools = await adapter.generateWithTools({
    credentials: { apiKey: "sk-private-key" },
    modelId: "gpt-5.6-terra",
    prompt: "Check",
    tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }]
  });
  assert.deepEqual(tools.toolCalls, [{ id: "call-1", name: "lookup", input: { orderId: "42" } }]);
  assert.equal(JSON.stringify(calls).includes("sk-private-key"), false);
});

test("OpenAI adapter requests timestamped transcription without exposing credentials", async () => {
  let request;
  const adapter = new OpenAIProviderAdapter({
    clientFactory: () => ({
      audio: {
        transcriptions: {
          create: async (input) => {
            request = input;
            return { text: "hello", segments: [{ text: "hello", start: 0, end: 1 }] };
          }
        }
      }
    })
  });
  await adapter.transcribeAudio({
    credentials: { apiKey: "sk-private-key" },
    modelId: "whisper-1",
    audioPath: require.resolve("./provider-adapters.test.cjs")
  });
  assert.equal(request.response_format, "verbose_json");
  assert.deepEqual(request.timestamp_granularities, ["segment", "word"]);
});

test("OpenAI adapter generates bounded WAV speech with a built-in voice", async () => {
  let request;
  const wav = Buffer.alloc(64, 1);
  const adapter = new OpenAIProviderAdapter({
    clientFactory: () => ({
      audio: {
        speech: {
          create: async (input) => {
            request = input;
            return { arrayBuffer: async () => wav };
          }
        }
      }
    })
  });
  const audio = await adapter.generateSpeech({
    credentials: { apiKey: "sk-private-key" },
    modelId: "gpt-4o-mini-tts",
    input: "This is an AI-generated voice preview.",
    voice: "marin",
    instructions: "Speak clearly."
  });
  assert.deepEqual(audio, wav);
  assert.equal(request.response_format, "wav");
  assert.equal(request.voice, "marin");
  assert.equal(JSON.stringify(request).includes("sk-private-key"), false);
});

test("OpenAI adapter passes custom voices as id objects", async () => {
  let request;
  const adapter = new OpenAIProviderAdapter({
    clientFactory: () => ({
      audio: {
        speech: {
          create: async (input) => {
            request = input;
            return { arrayBuffer: async () => Buffer.alloc(64, 1) };
          }
        }
      }
    })
  });
  await adapter.generateSpeech({
    credentials: { apiKey: "sk-private-key" },
    modelId: "gpt-4o-mini-tts",
    input: "Synthetic likeness.",
    voice: "voice_1234",
    voiceType: "custom"
  });
  assert.deepEqual(request.voice, { id: "voice_1234" });
});

test("ElevenLabs validates, creates an authorized clone, and returns bounded WAV speech", async () => {
  const calls = [];
  const adapter = new ElevenLabsProviderAdapter({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/v1/user")) return { ok: true };
      if (url.endsWith("/v1/voices/add")) {
        return { ok: true, json: async () => ({ voice_id: "voice-eleven" }) };
      }
      return { ok: true, arrayBuffer: async () => Buffer.alloc(80, 1) };
    }
  });
  const credentials = { apiKey: "eleven-private" };
  await adapter.validate(credentials, "eleven_multilingual_v2");
  const recording = {
    path: require.resolve("./provider-adapters.test.cjs"),
    name: "voice.wav",
    type: "audio/wav"
  };
  const created = await adapter.createCustomVoice({
    credentials,
    name: "Authorized",
    consentRecording: recording,
    sampleRecording: recording
  });
  assert.equal(created.id, "voice-eleven");
  assert.match(created.consentEvidenceHash, /^[a-f0-9]{64}$/);
  const wav = await adapter.generateSpeech({
    credentials,
    modelId: "eleven_multilingual_v2",
    input: "Synthetic speech.",
    voice: created.id
  });
  await adapter.deleteCustomVoice({ credentials, voiceId: created.id });
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(
    calls.some((call) => call.url.endsWith("/v1/voices/voice-eleven") && call.options.method === "DELETE"),
    true
  );
  assert.equal(
    calls.every((call) => call.options.headers["xi-api-key"] === "eleven-private"),
    true
  );
  assert.equal(JSON.stringify(calls.map((call) => call.options.body)).includes("eleven-private"), false);
});

test("Anthropic adapter uses structured output and normalizes Claude tool blocks", async () => {
  const requests = [];
  const adapter = new AnthropicProviderAdapter({
    clientFactory: () => ({
      messages: {
        create: async (request) => {
          requests.push(request);
          return request.tools
            ? { content: [{ type: "tool_use", id: "tool-1", name: "lookup", input: { id: "42" } }] }
            : { content: [{ type: "text", text: '{"reply":"Draft"}' }] };
        }
      }
    })
  });
  const result = await adapter.generateStructured({
    credentials: { apiKey: "sk-ant-private" },
    modelId: "claude-sonnet-5",
    prompt: "Draft",
    schema: { type: "object" }
  });
  assert.deepEqual(result, { reply: "Draft" });
  assert.equal(requests[0].output_config.format.type, "json_schema");
  const tools = await adapter.generateWithTools({
    credentials: { apiKey: "sk-ant-private" },
    modelId: "claude-sonnet-5",
    prompt: "Check",
    tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }]
  });
  assert.deepEqual(tools.toolCalls, [{ id: "tool-1", name: "lookup", input: { id: "42" } }]);
});

test("custom endpoint validation restricts schemes, credentials, and redirects", async () => {
  assert.equal(normalizeCustomEndpoint("https://models.example/v1/"), "https://models.example/v1");
  assert.equal(normalizeCustomEndpoint("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
  assert.equal(normalizeCustomEndpoint("http://[::1]:11434/v1"), "http://[::1]:11434/v1");
  for (const value of ["http://models.example/v1", "https://user:pass@models.example/v1", "https://models.example/v1#fragment"]) {
    assert.throws(
      () => normalizeCustomEndpoint(value),
      (error) => error.code === "INVALID_PROVIDER_ENDPOINT"
    );
  }
  const lockedFetch = createOriginLockedFetch("https://models.example/v1", async () => ({
    status: 302
  }));
  await assert.rejects(
    () => lockedFetch("https://models.example/v1/models"),
    (error) => error.code === "PROVIDER_REDIRECT_BLOCKED"
  );
  await assert.rejects(
    () => lockedFetch("https://evil.example/v1/models"),
    (error) => error.code === "PROVIDER_REDIRECT_BLOCKED"
  );
});

test("provider adapters normalize rate limits and timeouts without raw errors", async () => {
  const rateLimited = new OpenAIProviderAdapter({
    clientFactory: () => ({
      responses: { create: async () => Promise.reject(Object.assign(new Error("raw secret"), { status: 429 })) }
    })
  });
  await assert.rejects(
    () =>
      rateLimited.generateText({
        credentials: { apiKey: "sk-private-key" },
        modelId: "gpt-5.6-terra",
        prompt: "Hello"
      }),
    (error) => error.code === "PROVIDER_RATE_LIMITED" && !error.message.includes("raw secret")
  );
  const timedOut = new OpenAIProviderAdapter({
    timeoutMs: 5,
    clientFactory: () => ({ responses: { create: () => new Promise(() => {}) } })
  });
  await assert.rejects(
    () =>
      timedOut.generateText({
        credentials: { apiKey: "sk-private-key" },
        modelId: "gpt-5.6-terra",
        prompt: "Hello"
      }),
    (error) => error.code === "PROVIDER_TIMEOUT"
  );
});

test("custom profiles expose only explicitly configured capabilities", () => {
  assert.deepEqual(parseConfiguredCapabilities("text_generation, streaming,text_generation"), ["text_generation", "streaming"]);
  assert.throws(
    () => parseConfiguredCapabilities("text_generation,computer_use"),
    (error) => error.code === "INVALID_PROVIDER_CAPABILITIES"
  );
  const adapter = new OpenAICompatibleProviderAdapter({ clientFactory: () => ({}) });
  assert.deepEqual(
    adapter.listModels({
      publicValues: { modelId: "local-model", capabilities: "text_generation", voiceId: "local-voice" }
    }),
    [{ id: "local-model", name: "local-model", capabilities: ["text_generation"] }]
  );
  assert.equal(
    adapter.credentialFields.some((field) => field.key === "voiceId" && field.required === false),
    true
  );
});
