const { AppError } = require("../errors.cjs");

function timestamp(value) {
  const normalized = String(value || "")
    .trim()
    .replace(",", ".");
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d{1,3})?)$/.exec(normalized);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds >= 60) return null;
  return Number((hours * 3600 + minutes * 60 + seconds).toFixed(3));
}

function parseTranscriptText(text, extension, sourceDuration) {
  const input = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  if (input.length > 2_000_000) throw new AppError("TRANSCRIPT_TOO_LARGE", "The transcript file is too large.");
  const blocks = input
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (extension === "vtt" && lines[0]?.trim() === "WEBVTT") continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startText, endTextWithSettings] = lines[timingIndex].split("-->").map((item) => item.trim());
    const endText = endTextWithSettings?.split(/\s+/)[0];
    const start = timestamp(startText);
    const end = timestamp(endText);
    const cueText = lines
      .slice(timingIndex + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > sourceDuration || !cueText) {
      throw new AppError("INVALID_TRANSCRIPT", "The transcript contains invalid or out-of-range cues.");
    }
    if (segments.length && start < segments.at(-1).start) {
      throw new AppError("INVALID_TRANSCRIPT", "Transcript cues must be ordered.");
    }
    segments.push({ id: `transcript-${segments.length + 1}`, start, end, text: cueText.slice(0, 2_000), speaker: "" });
    if (segments.length > 2_000) throw new AppError("TRANSCRIPT_TOO_LARGE", "The transcript contains too many cues.");
  }
  if (!segments.length) throw new AppError("INVALID_TRANSCRIPT", "No valid SRT or VTT cues were found.");
  return segments;
}

module.exports = { parseTranscriptText, timestamp };
