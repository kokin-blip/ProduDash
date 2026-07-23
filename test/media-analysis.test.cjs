const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { AI_CAPABILITIES } = require("../electron/ai/capabilities.cjs");
const { WhisperCppProviderAdapter } = require("../electron/ai/adapters/whisper-cpp.cjs");
const { validateClipCandidates } = require("../electron/media/analysis-contract.cjs");
const { validateCloudMediaConsent } = require("../electron/media/cloud-consent.cjs");
const { MediaAnalysisService, boundedTranscriptContext } = require("../electron/media/media-analysis-service.cjs");
const { normalizeOpenAiTranscript, normalizeTranscript } = require("../electron/media/transcript-contract.cjs");
const { TranscriptionService, whisperTimestamp } = require("../electron/media/transcription-service.cjs");

const scores = {
  hook: 0.9,
  completeThought: 0.8,
  audioClarity: 0.8,
  visualContinuity: 0.7,
  goalRelevance: 0.9,
  duration: 0.8,
  platformFit: 0.8,
  novelty: 0.7,
  duplication: 0.1,
  silence: 0.1,
  unusableFrames: 0
};

test("timestamped transcripts require finite monotonic bounds", () => {
  const transcript = normalizeTranscript(
    {
      text: "One two",
      segments: [
        { text: "One", start: 0, end: 2, words: [{ text: "One", start: 0, end: 1 }] },
        { text: "two", start: 2, end: 4 }
      ]
    },
    5
  );
  assert.equal(transcript.segments.length, 2);
  assert.throws(
    () => normalizeTranscript({ segments: [{ text: "Bad", start: 3, end: 6 }] }, 5),
    (error) => error.code === "TRANSCRIPT_INVALID"
  );
  assert.throws(
    () =>
      normalizeTranscript(
        {
          segments: [
            { text: "Bad", start: 0, end: 2 },
            { text: "Overlap", start: 1, end: 3 }
          ]
        },
        5
      ),
    (error) => error.code === "TRANSCRIPT_INVALID"
  );
});

test("OpenAI transcript normalization assigns words to bounded segments", () => {
  const result = normalizeOpenAiTranscript(
    {
      text: "Hello world",
      language: "en",
      segments: [{ text: "Hello world", start: 0, end: 2 }],
      words: [
        { word: "Hello", start: 0, end: 0.8 },
        { word: "world", start: 1, end: 1.8 }
      ]
    },
    3
  );
  assert.equal(result.segments[0].words[1].text, "world");
  assert.equal(whisperTimestamp("00:01:02,500"), 62.5);
});

test("candidate validation snaps nearby boundaries, calculates explicit scores, and sorts", () => {
  const candidates = validateClipCandidates(
    {
      candidates: [
        { title: "Second", start: 30.9, end: 41, confidence: 0.7, scores: { ...scores, hook: 0.4 }, rationale: "Complete segment." },
        { title: "First", start: 0.8, end: 11.1, confidence: 0.9, scores, rationale: "Strong opening." }
      ]
    },
    { duration: 60, sceneBoundaries: [0, 30], transcriptBoundaries: [11, 41] }
  );
  assert.equal(candidates[0].title, "First");
  assert.equal(candidates[0].start, 0);
  assert.equal(candidates[0].end, 11);
  assert.deepEqual(Object.keys(candidates[0].scores), Object.keys(scores));
  assert.ok(candidates[0].weightedScore > candidates[1].weightedScore);
});

test("candidate validation rejects duplicate, excessive overlap, range, and score violations", () => {
  const candidate = { title: "One", start: 0, end: 10, confidence: 0.8, scores, rationale: "Reason." };
  for (const [input, code] of [
    [{ candidates: [candidate, { ...candidate, title: "Two", start: 0.4, end: 10.4 }] }, "CANDIDATE_DUPLICATE"],
    [{ candidates: [candidate, { ...candidate, title: "Two", start: 7.9, end: 17.9 }] }, "CANDIDATE_OVERLAP"],
    [{ candidates: [{ ...candidate, end: 4 }] }, "CANDIDATE_INVALID"],
    [{ candidates: [{ ...candidate, scores: { ...scores, hook: 2 } }] }, "CANDIDATE_INVALID"]
  ]) {
    assert.throws(
      () => validateClipCandidates(input, { duration: 60 }),
      (error) => error.code === code
    );
  }
});

test("cloud consent is per job and exact about provider, model, and data categories", () => {
  const result = validateCloudMediaConsent(
    {
      confirmed: true,
      providerId: "openai",
      modelId: "gpt-5.6-terra",
      dataCategories: ["frames", "transcript", "audio"]
    },
    {
      mode: "transcript_frames",
      providerId: "openai",
      modelId: "gpt-5.6-terra",
      cloudTranscription: true
    }
  );
  assert.deepEqual(result.dataCategories, ["audio", "frames", "transcript"]);
  assert.throws(
    () =>
      validateCloudMediaConsent(
        { confirmed: true, providerId: "openai", modelId: "wrong", dataCategories: ["complete_video"] },
        { mode: "native_video", providerId: "openai", modelId: "gpt-5.6-terra" }
      ),
    (error) => error.code === "CLOUD_MEDIA_CONSENT_REQUIRED"
  );
});

test("cloud transcript analysis uses only the selected provider and persists normalized candidates", async (t) => {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), "produdash-analysis-"));
  t.after(() => fs.rmSync(tempPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempPath, "analysis.json"), JSON.stringify({ scenes: [0, 20], silences: [], candidates: [] }));
  fs.writeFileSync(path.join(tempPath, "audio.wav"), "audio");
  const calls = [];
  const providerService = {
    resolveWorkload(workloadId) {
      if (workloadId === "transcription") {
        return {
          profile: { id: "openai", providerType: "openai", name: "OpenAI" },
          model: { id: "whisper-1", capabilities: [AI_CAPABILITIES.AUDIO_TRANSCRIPTION] }
        };
      }
      return {
        profile: { id: "anthropic", providerType: "anthropic", name: "Anthropic Claude" },
        model: {
          id: "claude-sonnet-5",
          capabilities: [AI_CAPABILITIES.TEXT_GENERATION, AI_CAPABILITIES.STRUCTURED_OUTPUT]
        },
        credentials: { apiKey: "secret" },
        adapter: {
          generateStructured: async (request) => {
            calls.push(request);
            return {
              candidates: [
                {
                  title: "Candidate",
                  start: 0.4,
                  end: 10,
                  confidence: 0.9,
                  scores,
                  rationale: "A complete, relevant moment."
                }
              ]
            };
          }
        }
      };
    }
  };
  const service = new MediaAnalysisService({
    providerService,
    transcriptionService: {
      transcribeCloud: async () => ({
        version: 1,
        duration: 30,
        text: "Transcript",
        segments: [{ id: "segment-1", text: "Transcript", start: 0, end: 10 }]
      })
    }
  });
  const result = await service.analyze({
    job: {
      goal: "Find a clear answer",
      settings: {
        analysisMode: "transcript_only",
        maxClips: 3,
        targetDuration: 30,
        platforms: ["youtube"],
        cloudConsent: {
          confirmed: true,
          providerId: "anthropic",
          modelId: "claude-sonnet-5",
          transcriptionProviderId: "openai",
          transcriptionModelId: "whisper-1",
          dataCategories: ["audio", "transcript"]
        }
      }
    },
    paths: { tempPath, sourcePath: path.join(tempPath, "source.mp4") },
    localResult: { type: "awaiting_review", candidates: [], warnings: [], metadata: { duration: 30 } }
  });
  assert.equal(result.candidates[0].start, 0);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls).includes("secret"), true);
  const persisted = JSON.parse(fs.readFileSync(path.join(tempPath, "analysis.json"), "utf8"));
  assert.deepEqual(persisted.provider, { profileId: "anthropic", modelId: "claude-sonnet-5" });
  assert.equal(JSON.stringify(persisted).includes("secret"), false);
});

test("cloud analysis never falls back after the selected provider fails", async () => {
  const providerService = {
    resolveWorkload() {
      return {
        profile: { id: "anthropic", providerType: "anthropic", name: "Claude" },
        model: { id: "claude-video", capabilities: [AI_CAPABILITIES.NATIVE_VIDEO_UNDERSTANDING] },
        credentials: {},
        adapter: {
          analyzeVideo: async () => {
            throw Object.assign(new Error("rate"), { code: "PROVIDER_RATE_LIMITED" });
          }
        }
      };
    }
  };
  const service = new MediaAnalysisService({ providerService, transcriptionService: {} });
  await assert.rejects(
    () =>
      service.analyze({
        job: {
          settings: {
            analysisMode: "native_video",
            cloudConsent: {
              confirmed: true,
              providerId: "anthropic",
              modelId: "claude-video",
              dataCategories: ["complete_video"]
            }
          }
        },
        paths: { sourcePath: "source.mp4" },
        localResult: { metadata: { duration: 30 } }
      }),
    (error) => error.code === "PROVIDER_RATE_LIMITED"
  );
});

test("bounded transcript context limits provider payload size", () => {
  const context = boundedTranscriptContext({
    segments: Array.from({ length: 4_000 }, (_, index) => ({
      start: index,
      end: index + 0.5,
      text: "x".repeat(200)
    }))
  });
  assert.ok(context.length <= 120_000);
  assert.equal(context.includes("[0.000–0.500]"), true);
});

test("cloud transcription requires an exact per-job provider and audio consent", async () => {
  let calls = 0;
  const providerService = {
    resolveWorkload() {
      return {
        profile: { id: "openai", providerType: "openai" },
        model: { id: "whisper-1", capabilities: [AI_CAPABILITIES.AUDIO_TRANSCRIPTION] },
        credentials: { apiKey: "secret" },
        adapter: {
          transcribeAudio: async () => {
            calls += 1;
            return { text: "Hello", segments: [{ text: "Hello", start: 0, end: 1 }] };
          }
        }
      };
    }
  };
  const service = new TranscriptionService({ providerService });
  await assert.rejects(
    () =>
      service.transcribeCloud({
        audioPath: "audio.wav",
        duration: 2,
        consent: { confirmed: true, providerId: "openai", modelId: "wrong", dataCategories: ["audio"] }
      }),
    (error) => error.code === "CLOUD_MEDIA_CONSENT_REQUIRED"
  );
  const transcript = await service.transcribeCloud({
    audioPath: "audio.wav",
    duration: 2,
    consent: { confirmed: true, providerId: "openai", modelId: "whisper-1", dataCategories: ["audio"] }
  });
  assert.equal(calls, 1);
  assert.equal(transcript.segments[0].text, "Hello");
});

test("configured whisper.cpp transcription stays local and never downloads a model", async (t) => {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), "produdash-whisper-"));
  t.after(() => fs.rmSync(tempPath, { recursive: true, force: true }));
  const executablePath = path.join(tempPath, "whisper-cli");
  const modelPath = path.join(tempPath, "model.bin");
  const audioPath = path.join(tempPath, "audio.wav");
  for (const filePath of [executablePath, modelPath, audioPath]) fs.writeFileSync(filePath, "fixture");
  const spawnProcess = (_command, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    const prefix = args[args.indexOf("-of") + 1];
    process.nextTick(() => {
      fs.writeFileSync(
        `${prefix}.json`,
        JSON.stringify({
          text: "Local words",
          transcription: [{ text: "Local words", timestamps: { from: "00:00:00,000", to: "00:00:01,500" } }]
        })
      );
      child.emit("close", 0);
    });
    return child;
  };
  let accessStarts = 0;
  let accessStops = 0;
  const adapter = new WhisperCppProviderAdapter({
    spawnProcess,
    startAccessingBookmark: () => {
      accessStarts += 1;
      return () => {
        accessStops += 1;
      };
    }
  });
  const providerService = {
    resolveWorkload() {
      return {
        profile: { id: "whisper-cpp", providerType: "whisper-cpp" },
        model: { id: "local-whisper", capabilities: [AI_CAPABILITIES.AUDIO_TRANSCRIPTION] },
        credentials: {
          executablePath,
          modelPath,
          executablePathBookmark: "bookmark-one",
          modelPathBookmark: "bookmark-two"
        },
        adapter
      };
    }
  };
  const service = new TranscriptionService({ providerService });
  const transcript = await service.transcribeCloud({
    audioPath,
    duration: 2,
    consent: null
  });
  assert.equal(transcript.text, "Local words");
  assert.equal(transcript.segments[0].end, 1.5);
  assert.equal(accessStarts, 2);
  assert.equal(accessStops, 2);
});
