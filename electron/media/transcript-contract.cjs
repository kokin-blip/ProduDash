const { AppError } = require("../errors.cjs");
const { boundedString } = require("../validation.cjs");

const MAX_SEGMENTS = 10_000;
const MAX_WORDS = 100_000;

function finiteTimestamp(value, label, duration) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > duration) {
    throw new AppError("TRANSCRIPT_INVALID", `${label} must be a finite timestamp within the source duration.`);
  }
  return Number(number.toFixed(3));
}

function normalizeTranscript(input, sourceDuration) {
  const duration = Number(sourceDuration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AppError("TRANSCRIPT_INVALID", "A valid source duration is required to validate a transcript.");
  }
  const rawSegments = Array.isArray(input?.segments) ? input.segments : [];
  if (!rawSegments.length || rawSegments.length > MAX_SEGMENTS) {
    throw new AppError("TRANSCRIPT_INVALID", `A transcript must contain between 1 and ${MAX_SEGMENTS} timestamped segments.`);
  }
  let previousEnd = 0;
  let wordCount = 0;
  const segments = rawSegments.map((segment, index) => {
    const start = finiteTimestamp(segment?.start, `Transcript segment ${index + 1} start`, duration);
    const end = finiteTimestamp(segment?.end, `Transcript segment ${index + 1} end`, duration);
    if (end <= start || start < previousEnd) {
      throw new AppError("TRANSCRIPT_INVALID", "Transcript segments must be ordered, non-overlapping, and have positive duration.");
    }
    previousEnd = end;
    const words = Array.isArray(segment?.words)
      ? segment.words.map((word, wordIndex) => {
          wordCount += 1;
          if (wordCount > MAX_WORDS) throw new AppError("TRANSCRIPT_INVALID", "The transcript contains too many timestamped words.");
          const wordStart = finiteTimestamp(word?.start, `Word ${wordIndex + 1} start`, duration);
          const wordEnd = finiteTimestamp(word?.end, `Word ${wordIndex + 1} end`, duration);
          if (wordEnd <= wordStart || wordStart < start || wordEnd > end) {
            throw new AppError("TRANSCRIPT_INVALID", "Transcript word timestamps must stay within their segment.");
          }
          return {
            text: boundedString(word?.text ?? word?.word, { label: "Transcript word", min: 1, max: 200 }),
            start: wordStart,
            end: wordEnd
          };
        })
      : [];
    for (let wordIndex = 1; wordIndex < words.length; wordIndex += 1) {
      if (words[wordIndex].start < words[wordIndex - 1].end) {
        throw new AppError("TRANSCRIPT_INVALID", "Transcript words must be ordered and non-overlapping.");
      }
    }
    return {
      id: `segment-${index + 1}`,
      text: boundedString(segment?.text, { label: "Transcript segment", min: 1, max: 10_000 }),
      start,
      end,
      ...(words.length ? { words } : {})
    };
  });
  const fullText = boundedString(input?.text || segments.map((segment) => segment.text).join(" "), {
    label: "Transcript text",
    min: 1,
    max: 500_000
  });
  return { version: 1, language: String(input?.language || "").slice(0, 20) || null, duration, text: fullText, segments };
}

function normalizeOpenAiTranscript(input, duration) {
  const words = Array.isArray(input?.words) ? input.words : [];
  const segments = (Array.isArray(input?.segments) ? input.segments : []).map((segment) => ({
    text: segment.text,
    start: segment.start,
    end: segment.end,
    words: words.filter((word) => Number(word.start) >= Number(segment.start) && Number(word.end) <= Number(segment.end))
  }));
  return normalizeTranscript({ text: input?.text, language: input?.language, segments }, duration);
}

module.exports = { MAX_SEGMENTS, MAX_WORDS, normalizeOpenAiTranscript, normalizeTranscript };
