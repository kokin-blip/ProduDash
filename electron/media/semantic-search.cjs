const crypto = require("node:crypto");
const { AppError } = require("../errors.cjs");

const LOCAL_SEARCH_MODEL = "local-keywords-v2";
const SEARCH_DOCUMENT_VERSION = 2;
const MAX_TERMS = 160;
const MAX_SEARCH_SEGMENTS = 300;
const MAX_SEGMENT_TERMS = 60;
const MAX_EXCERPT_LENGTH = 240;
const SYNONYMS = Object.freeze({
  ad: ["advertisement", "campaign", "promo", "promotion"],
  advertisement: ["ad", "campaign", "promo"],
  audio: ["sound", "voice", "music"],
  behind: ["backstage", "process", "making"],
  customer: ["buyer", "client", "testimonial"],
  demo: ["demonstration", "tutorial", "walkthrough", "howto"],
  funny: ["comedy", "humor", "laugh"],
  howto: ["tutorial", "guide", "demo", "walkthrough"],
  interview: ["conversation", "question", "answer", "testimonial"],
  launch: ["announcement", "release", "debut"],
  music: ["audio", "song", "sound"],
  product: ["item", "merchandise", "demo"],
  promo: ["promotion", "campaign", "advertisement", "ad"],
  review: ["testimonial", "reaction", "opinion"],
  short: ["clip", "reel", "vertical"],
  social: ["reel", "short", "vertical", "post"],
  testimonial: ["customer", "review", "interview"],
  tutorial: ["howto", "guide", "demo", "walkthrough"],
  vertical: ["portrait", "reel", "short"],
  walkthrough: ["tutorial", "guide", "demo", "howto"]
});

function tokenize(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 1 && term.length <= 40)
    .slice(0, MAX_TERMS);
}

function expandTerms(terms) {
  const expanded = new Set();
  for (const term of terms) {
    expanded.add(term);
    for (const synonym of SYNONYMS[term] || []) expanded.add(synonym);
  }
  return [...expanded].slice(0, MAX_TERMS);
}

function searchFingerprint(input) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function normalizeTranscriptSegments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AppError("INVALID_SEARCH_TRANSCRIPT", "Local transcript search data must be a list.");
  }
  let previousStart = -1;
  return value.slice(0, MAX_SEARCH_SEGMENTS).map((segment) => {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start < previousStart) {
      throw new AppError("INVALID_SEARCH_TRANSCRIPT", "Local transcript search timestamps must be finite and ordered.");
    }
    previousStart = start;
    const excerpt = String(segment?.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_EXCERPT_LENGTH);
    if (!excerpt) {
      throw new AppError("INVALID_SEARCH_TRANSCRIPT", "Local transcript search segments cannot be empty.");
    }
    return {
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      excerpt,
      terms: expandTerms(tokenize(excerpt)).slice(0, MAX_SEGMENT_TERMS)
    };
  });
}

function buildSearchDocument(clip, options = {}) {
  const modelId = options.modelId || LOCAL_SEARCH_MODEL;
  if (modelId !== LOCAL_SEARCH_MODEL) throw new AppError("SEARCH_MODEL_UNAVAILABLE", "The selected local search model is unavailable.");
  const source = {
    name: String(clip.name || "").slice(0, 220),
    tags: Array.isArray(clip.tags) ? clip.tags.slice(0, 20).map(String) : [],
    codec: String(clip.codec || "").slice(0, 80),
    aspectRatio: String(clip.aspectRatio || "").slice(0, 32),
    extension: String(clip.extension || "").slice(0, 20)
  };
  const segments = normalizeTranscriptSegments(options.transcriptSegments);
  const directTerms = tokenize([source.name, ...source.tags, source.codec, source.aspectRatio, source.extension].join(" "));
  return {
    version: SEARCH_DOCUMENT_VERSION,
    modelId,
    fingerprint: searchFingerprint({ source, segments }),
    terms: expandTerms(directTerms),
    segments,
    provenance: {
      source: segments.length ? "local_metadata_transcript" : "local_metadata",
      inputs: ["filename", "tags", "codec", "aspect_ratio", "extension", ...(segments.length ? ["project_transcript_segments"] : [])],
      generatedAt: new Date().toISOString()
    }
  };
}

function validateSearchDocument(value) {
  const validSource = ["local_metadata", "local_metadata_transcript"].includes(value?.provenance?.source);
  const validSegments =
    Array.isArray(value?.segments) &&
    value.segments.length <= MAX_SEARCH_SEGMENTS &&
    value.segments.every(
      (segment, index, segments) =>
        Number.isFinite(segment?.start) &&
        Number.isFinite(segment?.end) &&
        segment.start >= 0 &&
        segment.end > segment.start &&
        (index === 0 || segment.start >= segments[index - 1].start) &&
        typeof segment.excerpt === "string" &&
        segment.excerpt.length >= 1 &&
        segment.excerpt.length <= MAX_EXCERPT_LENGTH &&
        Array.isArray(segment.terms) &&
        segment.terms.length <= MAX_SEGMENT_TERMS &&
        segment.terms.every((term) => typeof term === "string" && term.length >= 2 && term.length <= 40)
    );
  const hasTranscript = Boolean(value?.segments?.length);
  const validProvenance =
    validSource &&
    value.provenance.source === (hasTranscript ? "local_metadata_transcript" : "local_metadata") &&
    Array.isArray(value.provenance.inputs) &&
    value.provenance.inputs.length <= 6 &&
    value.provenance.inputs.every((input) => typeof input === "string" && input.length <= 40) &&
    Number.isFinite(Date.parse(value.provenance.generatedAt));
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== SEARCH_DOCUMENT_VERSION ||
    value.modelId !== LOCAL_SEARCH_MODEL ||
    !/^[a-f0-9]{64}$/.test(String(value.fingerprint || "")) ||
    !Array.isArray(value.terms) ||
    value.terms.length > MAX_TERMS ||
    value.terms.some((term) => typeof term !== "string" || term.length < 2 || term.length > 40) ||
    !validSegments ||
    !validProvenance
  ) {
    throw new AppError("INVALID_MEDIA_INDEX", "A saved local search document is invalid.");
  }
  return value;
}

function scoreTerms(indexedTerms, direct, expanded) {
  const indexed = new Set(indexedTerms || []);
  const matchedTerms = direct.filter((term) => indexed.has(term));
  const semanticMatches = expanded.filter((term) => !direct.includes(term) && indexed.has(term));
  const coverage = matchedTerms.length / direct.length;
  const semanticCoverage = Math.min(1, semanticMatches.length / Math.max(1, direct.length * 2));
  return {
    score: Math.min(1, coverage * 0.8 + semanticCoverage * 0.2),
    matchedTerms: [...matchedTerms, ...semanticMatches].slice(0, 12)
  };
}

function scoreSearchDocument(document, query) {
  const direct = [...new Set(tokenize(query))];
  if (!direct.length) return { score: 0, matchedTerms: [], timestampMatches: [] };
  const expanded = expandTerms(direct);
  const metadata = scoreTerms(document?.terms, direct, expanded);
  const timestampMatches = (document?.segments || [])
    .map((segment) => {
      const match = scoreTerms(segment.terms, direct, expanded);
      return {
        start: segment.start,
        end: segment.end,
        excerpt: segment.excerpt,
        score: Number(match.score.toFixed(3)),
        matchedTerms: match.matchedTerms
      };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.start - right.start)
    .slice(0, 5);
  const transcript = timestampMatches[0] || { score: 0, matchedTerms: [] };
  const bestScore = Math.max(metadata.score, transcript.score);
  return {
    score: Number(bestScore.toFixed(3)),
    matchedTerms: [...new Set([...metadata.matchedTerms, ...transcript.matchedTerms])].slice(0, 12),
    timestampMatches
  };
}

module.exports = {
  LOCAL_SEARCH_MODEL,
  MAX_EXCERPT_LENGTH,
  MAX_SEARCH_SEGMENTS,
  MAX_TERMS,
  SEARCH_DOCUMENT_VERSION,
  buildSearchDocument,
  scoreSearchDocument,
  tokenize,
  validateSearchDocument
};
