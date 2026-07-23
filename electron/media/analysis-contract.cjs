const { AppError } = require("../errors.cjs");
const { boundedString } = require("../validation.cjs");

const ANALYSIS_MODES = Object.freeze({
  LOCAL_HEURISTICS: "local_heuristics",
  TRANSCRIPT_ONLY: "transcript_only",
  TRANSCRIPT_FRAMES: "transcript_frames",
  NATIVE_VIDEO: "native_video"
});

const SCORE_DIMENSIONS = Object.freeze([
  "hook",
  "completeThought",
  "audioClarity",
  "visualContinuity",
  "goalRelevance",
  "duration",
  "platformFit",
  "novelty",
  "duplication",
  "silence",
  "unusableFrames"
]);

const SCORE_WEIGHTS = Object.freeze({
  hook: 0.16,
  completeThought: 0.14,
  audioClarity: 0.1,
  visualContinuity: 0.1,
  goalRelevance: 0.14,
  duration: 0.08,
  platformFit: 0.08,
  novelty: 0.08,
  duplication: -0.05,
  silence: -0.04,
  unusableFrames: -0.03
});

const CLIP_CANDIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          start: { type: "number", minimum: 0 },
          end: { type: "number", minimum: 0 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          scores: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(SCORE_DIMENSIONS.map((key) => [key, { type: "number", minimum: 0, maximum: 1 }])),
            required: SCORE_DIMENSIONS
          },
          rationale: { type: "string", minLength: 1, maxLength: 500 }
        },
        required: ["title", "start", "end", "confidence", "scores", "rationale"]
      }
    }
  },
  required: ["candidates"]
};

function unitScore(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new AppError("CANDIDATE_INVALID", `${label} must be between 0 and 1.`);
  }
  return Number(number.toFixed(3));
}

function scoreCandidate(scores) {
  let weighted = 0;
  let positiveWeight = 0;
  for (const dimension of SCORE_DIMENSIONS) {
    const value = unitScore(scores?.[dimension], dimension);
    const weight = SCORE_WEIGHTS[dimension];
    weighted += weight >= 0 ? value * weight : value * weight;
    if (weight > 0) positiveWeight += weight;
  }
  return Number(Math.max(0, Math.min(1, weighted / positiveWeight)).toFixed(3));
}

function nearestBoundary(value, boundaries) {
  let nearest = value;
  let distance = 1.501;
  for (const boundary of boundaries) {
    const candidateDistance = Math.abs(boundary - value);
    if (candidateDistance <= 1.5 && candidateDistance < distance) {
      nearest = boundary;
      distance = candidateDistance;
    }
  }
  return Number(nearest.toFixed(3));
}

function validateClipCandidates(input, options) {
  const duration = Number(options?.duration);
  if (!Number.isFinite(duration) || duration < 5) {
    throw new AppError("CANDIDATE_INVALID", "A valid source duration is required.");
  }
  const raw = Array.isArray(input?.candidates) ? input.candidates : input;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) {
    throw new AppError("CANDIDATE_INVALID", "AI analysis must return between 1 and 20 candidates.");
  }
  const boundaries = [
    ...(Array.isArray(options?.sceneBoundaries) ? options.sceneBoundaries : []),
    ...(Array.isArray(options?.transcriptBoundaries) ? options.transcriptBoundaries : [])
  ].filter((value) => Number.isFinite(value) && value >= 0 && value <= duration);
  const candidates = raw.map((candidate, index) => {
    const start = nearestBoundary(Number(candidate?.start), boundaries);
    const end = nearestBoundary(Number(candidate?.end), boundaries);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration || end - start < 5 || end - start > 180) {
      throw new AppError("CANDIDATE_INVALID", "Each clip must be 5–180 seconds and remain within the source duration.");
    }
    const scores = Object.fromEntries(
      SCORE_DIMENSIONS.map((dimension) => [dimension, unitScore(candidate?.scores?.[dimension], dimension)])
    );
    return {
      id: `candidate-${index + 1}`,
      title: boundedString(candidate?.title, { label: "Candidate title", min: 1, max: 120 }),
      start,
      end,
      duration: Number((end - start).toFixed(3)),
      confidence: unitScore(candidate?.confidence, "Candidate confidence"),
      scores,
      weightedScore: scoreCandidate(scores),
      rationale: boundedString(candidate?.rationale, { label: "Candidate rationale", min: 1, max: 500 })
    };
  });
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      if (Math.abs(left.start - right.start) < 1 && Math.abs(left.end - right.end) < 1) {
        throw new AppError("CANDIDATE_DUPLICATE", "AI analysis returned near-duplicate clip boundaries.");
      }
      const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
      if (overlap > Math.min(left.duration, right.duration) * 0.2) {
        throw new AppError("CANDIDATE_OVERLAP", "AI clip overlap cannot exceed 20% of the shorter candidate.");
      }
    }
  }
  return candidates.sort((left, right) => right.weightedScore - left.weightedScore);
}

module.exports = {
  ANALYSIS_MODES,
  CLIP_CANDIDATE_SCHEMA,
  SCORE_DIMENSIONS,
  SCORE_WEIGHTS,
  scoreCandidate,
  validateClipCandidates
};
