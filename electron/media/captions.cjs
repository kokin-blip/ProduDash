const { AppError } = require("../errors.cjs");

const MAX_LINE_LENGTH = 42;
const MAX_CUE_CHARACTERS = 84;

function wrapCaptionText(value, lineLength = MAX_LINE_LENGTH) {
  const words = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (word.length > lineLength) {
      if (line) lines.push(line);
      for (let offset = 0; offset < word.length; offset += lineLength) lines.push(word.slice(offset, offset + lineLength));
      line = "";
    } else if (!line || `${line} ${word}`.length <= lineLength) {
      line = line ? `${line} ${word}` : word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function chunkText(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return [];
  const phrases = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  for (const phrase of phrases) {
    const words = phrase.split(" ");
    let chunk = "";
    for (const word of words) {
      if (chunk && `${chunk} ${word}`.length > MAX_CUE_CHARACTERS) {
        chunks.push(chunk);
        chunk = word;
      } else {
        chunk = chunk ? `${chunk} ${word}` : word;
      }
    }
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

function deriveCaptionSegments(transcript, clipStart, clipEnd) {
  const start = Number(clipStart);
  const end = Number(clipEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new AppError("CAPTION_RANGE_INVALID", "A valid clip range is required to derive captions.");
  }
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  const output = [];
  for (const segment of segments) {
    const sourceStart = Number(segment?.start);
    const sourceEnd = Number(segment?.end);
    if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceEnd <= sourceStart) {
      throw new AppError("TRANSCRIPT_INVALID", "Caption source timestamps are invalid.");
    }
    const boundedStart = Math.max(start, sourceStart);
    const boundedEnd = Math.min(end, sourceEnd);
    if (boundedEnd <= boundedStart) continue;
    const chunks = chunkText(segment.text);
    if (!chunks.length) continue;
    const sliceDuration = boundedEnd - boundedStart;
    chunks.forEach((chunk, index) => {
      const cueStart = boundedStart - start + (sliceDuration * index) / chunks.length;
      const cueEnd = boundedStart - start + (sliceDuration * (index + 1)) / chunks.length;
      output.push({
        id: `caption-${output.length + 1}`,
        start: Number(Math.max(0, cueStart).toFixed(3)),
        end: Number(Math.min(end - start, cueEnd).toFixed(3)),
        text: wrapCaptionText(chunk)
      });
    });
  }
  return output;
}

function srtTimestamp(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) throw new AppError("CAPTION_TIMESTAMP_INVALID", "Caption timestamps must be finite.");
  const milliseconds = Math.round(value * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(
    3,
    "0"
  )}`;
}

function formatSrt(segments, duration) {
  const clipDuration = Number(duration);
  if (!Number.isFinite(clipDuration) || clipDuration <= 0) throw new AppError("CAPTION_RANGE_INVALID", "Caption duration is invalid.");
  let previousEnd = 0;
  return (Array.isArray(segments) ? segments : [])
    .map((segment, index) => {
      const start = Number(segment?.start);
      const end = Number(segment?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd || end <= start || end > clipDuration) {
        throw new AppError("CAPTION_TIMESTAMP_INVALID", "Caption cues must be monotonic and remain inside the rendered clip.");
      }
      previousEnd = end;
      const text = String(segment.text || "")
        .replace(/-->/g, "→")
        .replace(/\r/g, "")
        .trim();
      if (!text) throw new AppError("CAPTION_TEXT_INVALID", "Caption cues cannot be empty.");
      return `${index + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${text}\n`;
    })
    .join("\n");
}

module.exports = { deriveCaptionSegments, formatSrt, srtTimestamp, wrapCaptionText };
