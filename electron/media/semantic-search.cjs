const crypto = require("node:crypto");
const { AppError } = require("../errors.cjs");

const LOCAL_SEARCH_MODEL = "local-keywords-v1";
const SEARCH_DOCUMENT_VERSION = 1;
const MAX_TERMS = 160;
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
  const directTerms = tokenize([source.name, ...source.tags, source.codec, source.aspectRatio, source.extension].join(" "));
  return {
    version: SEARCH_DOCUMENT_VERSION,
    modelId,
    fingerprint: searchFingerprint(source),
    terms: expandTerms(directTerms),
    provenance: {
      source: "local_metadata",
      inputs: ["filename", "tags", "codec", "aspect_ratio", "extension"],
      generatedAt: new Date().toISOString()
    }
  };
}

function validateSearchDocument(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== SEARCH_DOCUMENT_VERSION ||
    value.modelId !== LOCAL_SEARCH_MODEL ||
    !/^[a-f0-9]{64}$/.test(String(value.fingerprint || "")) ||
    !Array.isArray(value.terms) ||
    value.terms.length > MAX_TERMS ||
    value.terms.some((term) => typeof term !== "string" || term.length < 2 || term.length > 40) ||
    value.provenance?.source !== "local_metadata" ||
    !Array.isArray(value.provenance?.inputs)
  ) {
    throw new AppError("INVALID_MEDIA_INDEX", "A saved local search document is invalid.");
  }
  return value;
}

function scoreSearchDocument(document, query) {
  const direct = [...new Set(tokenize(query))];
  if (!direct.length) return { score: 0, matchedTerms: [] };
  const expanded = expandTerms(direct);
  const indexed = new Set(document?.terms || []);
  const matchedTerms = direct.filter((term) => indexed.has(term));
  const semanticMatches = expanded.filter((term) => !direct.includes(term) && indexed.has(term));
  const coverage = matchedTerms.length / direct.length;
  const semanticCoverage = Math.min(1, semanticMatches.length / Math.max(1, direct.length * 2));
  return {
    score: Number(Math.min(1, coverage * 0.8 + semanticCoverage * 0.2).toFixed(3)),
    matchedTerms: [...matchedTerms, ...semanticMatches].slice(0, 12)
  };
}

module.exports = {
  LOCAL_SEARCH_MODEL,
  MAX_TERMS,
  SEARCH_DOCUMENT_VERSION,
  buildSearchDocument,
  scoreSearchDocument,
  tokenize,
  validateSearchDocument
};
