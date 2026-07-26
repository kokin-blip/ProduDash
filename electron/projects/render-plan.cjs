const crypto = require("node:crypto");
const { AppError } = require("../errors.cjs");
const { boundedString, requireId } = require("../validation.cjs");

const RENDER_PLAN_VERSION = 6;
const MAX_SEGMENTS = 100;
const MAX_TRANSCRIPT_SEGMENTS = 2_000;
const MAX_TRANSCRIPT_WORDS = 20_000;
const MAX_MARKERS = 200;
const MAX_COMMENTS = 200;
const MAX_OVERLAYS = 40;
const MAX_INTELLIGENT_TRACK_ITEMS = 100;
const MAX_LANGUAGE_VARIANTS = 10;
const MAX_LOCALIZED_CHARACTERS = 100_000;

function boundedNumber(value, { label, min, max, fallback }) {
  const number = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new AppError("INVALID_RENDER_PLAN", `${label} is outside the supported range.`);
  }
  return Number(number.toFixed(3));
}

function colorValue(value, fallback) {
  const color = String(value || fallback);
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new AppError("INVALID_RENDER_PLAN", "Composition colors must use six-digit hexadecimal values.");
  }
  return color.toLowerCase();
}

function normalizeTemplateRef(value) {
  if (!value) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_RENDER_PLAN", "The brand template reference is invalid.");
  }
  const hash = String(value.hash || "");
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isInteger(Number(value.version)) || Number(value.version) < 1) {
    throw new AppError("INVALID_RENDER_PLAN", "The brand template version reference is invalid.");
  }
  return {
    id: requireId(value.id, "Brand template"),
    version: Number(value.version),
    hash
  };
}

function normalizeAssetCue(value, label, totalDuration) {
  if (!value) return null;
  const start = boundedNumber(value.start, { label: `${label} start`, min: 0, max: totalDuration, fallback: 0 });
  const end = boundedNumber(value.end, {
    label: `${label} end`,
    min: 0.04,
    max: totalDuration,
    fallback: totalDuration
  });
  if (end <= start) throw new AppError("INVALID_RENDER_PLAN", `${label} must end after it starts.`);
  return {
    assetId: requireId(value.assetId, `${label} asset`),
    start,
    end,
    volume: boundedNumber(value.volume, { label: `${label} volume`, min: 0, max: 1, fallback: 0.35 }),
    fadeIn: boundedNumber(value.fadeIn, { label: `${label} fade in`, min: 0, max: 5, fallback: 0 }),
    fadeOut: boundedNumber(value.fadeOut, { label: `${label} fade out`, min: 0, max: 5, fallback: 0 })
  };
}

function normalizeOverlay(value, index, totalDuration) {
  const type = ["text", "cta", "logo"].includes(value?.type) ? value.type : null;
  if (!type) throw new AppError("INVALID_RENDER_PLAN", `Overlay ${index + 1} has an unsupported type.`);
  const start = boundedNumber(value.start, { label: `Overlay ${index + 1} start`, min: 0, max: totalDuration, fallback: 0 });
  const end = boundedNumber(value.end, {
    label: `Overlay ${index + 1} end`,
    min: 0.04,
    max: totalDuration,
    fallback: totalDuration
  });
  if (end <= start) throw new AppError("INVALID_RENDER_PLAN", "Overlay timing must remain inside the edited timeline.");
  const result = {
    id: value.id ? requireId(value.id, "Composition overlay") : `overlay-${index + 1}`,
    type,
    start,
    end,
    x: boundedNumber(value.x, { label: "Overlay horizontal position", min: 0, max: 1, fallback: 0.5 }),
    y: boundedNumber(value.y, { label: "Overlay vertical position", min: 0, max: 1, fallback: 0.82 }),
    width: boundedNumber(value.width, { label: "Overlay width", min: 0.05, max: 1, fallback: 0.72 }),
    opacity: boundedNumber(value.opacity, { label: "Overlay opacity", min: 0.1, max: 1, fallback: 1 })
  };
  if (type === "logo") {
    result.assetId = requireId(value.assetId, "Logo asset");
  } else {
    result.text = boundedString(value.text, { label: type === "cta" ? "Call to action" : "Overlay text", min: 1, max: 240 });
    result.textColor = colorValue(value.textColor, "#ffffff");
    result.backgroundColor = colorValue(value.backgroundColor, type === "cta" ? "#101214" : "#000000");
    result.fontScale = boundedNumber(value.fontScale, { label: "Overlay text size", min: 0.5, max: 3, fallback: 1 });
  }
  return result;
}

function normalizeComposition(value, totalDuration) {
  const composition = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const overlays = Array.isArray(composition.overlays) ? composition.overlays : [];
  if (overlays.length > MAX_OVERLAYS) {
    throw new AppError("INVALID_RENDER_PLAN", `A project may contain at most ${MAX_OVERLAYS} composition overlays.`);
  }
  const ids = new Set();
  const normalizedOverlays = overlays.map((overlay, index) => {
    const normalized = normalizeOverlay(overlay, index, totalDuration);
    if (ids.has(normalized.id)) throw new AppError("INVALID_RENDER_PLAN", "Composition overlay identifiers must be unique.");
    ids.add(normalized.id);
    return normalized;
  });
  return {
    transition: ["cut", "fade"].includes(composition.transition) ? composition.transition : "cut",
    transitionDuration: boundedNumber(composition.transitionDuration, {
      label: "Transition duration",
      min: 0.05,
      max: 1.5,
      fallback: 0.25
    }),
    backgroundColor: colorValue(composition.backgroundColor, "#000000"),
    overlays: normalizedOverlays,
    music: normalizeAssetCue(composition.music, "Music", totalDuration),
    introAssetId: composition.introAssetId ? requireId(composition.introAssetId, "Intro asset") : null,
    outroAssetId: composition.outroAssetId ? requireId(composition.outroAssetId, "Outro asset") : null
  };
}

function normalizeProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.source !== "user_library") {
    throw new AppError("INVALID_RENDER_PLAN", "B-roll provenance must identify a user-owned Library source.");
  }
  const fingerprint = String(value.fingerprint || "");
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new AppError("INVALID_RENDER_PLAN", "B-roll provenance fingerprint is invalid.");
  }
  return {
    source: "user_library",
    mediaId: requireId(value.mediaId, "B-roll source"),
    fingerprint
  };
}

function normalizeIntelligentTracks(value, totalDuration) {
  const tracks = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalizeTimed = (items, kind) => {
    if (!Array.isArray(items)) return [];
    if (items.length > MAX_INTELLIGENT_TRACK_ITEMS) {
      throw new AppError("INVALID_RENDER_PLAN", `A project may contain at most ${MAX_INTELLIGENT_TRACK_ITEMS} ${kind} items.`);
    }
    return items.map((item, index) => {
      const start = boundedNumber(item.start, { label: `${kind} start`, min: 0, max: totalDuration, fallback: 0 });
      const end = boundedNumber(item.end, { label: `${kind} end`, min: 0.04, max: totalDuration, fallback: totalDuration });
      if (end <= start) throw new AppError("INVALID_RENDER_PLAN", `${kind} timing is invalid.`);
      return {
        id: item.id ? requireId(item.id, `${kind} item`) : `${kind.toLowerCase().replaceAll(" ", "-")}-${index + 1}`,
        start,
        end,
        reviewed: Boolean(item.reviewed)
      };
    });
  };
  const subject = normalizeTimed(tracks.subject, "Subject").map((item, index) => {
    const source = tracks.subject[index];
    const keyframes = Array.isArray(source.keyframes) ? source.keyframes : [];
    if (keyframes.length > 200) throw new AppError("INVALID_RENDER_PLAN", "A subject track contains too many keyframes.");
    return {
      ...item,
      mode: ["center", "keyframes"].includes(source.mode) ? source.mode : "center",
      keyframes: keyframes.map((keyframe) => ({
        at: boundedNumber(keyframe.at, { label: "Subject keyframe time", min: item.start, max: item.end, fallback: item.start }),
        x: boundedNumber(keyframe.x, { label: "Subject horizontal position", min: 0, max: 1, fallback: 0.5 }),
        y: boundedNumber(keyframe.y, { label: "Subject vertical position", min: 0, max: 1, fallback: 0.5 }),
        scale: boundedNumber(keyframe.scale, { label: "Subject scale", min: 1, max: 3, fallback: 1 }),
        confidence: boundedNumber(keyframe.confidence, { label: "Subject confidence", min: 0, max: 1, fallback: 0 })
      }))
    };
  });
  const audio = normalizeTimed(tracks.audio, "Audio").map((item, index) => {
    const source = tracks.audio[index];
    return {
      ...item,
      preset: ["voice_cleanup", "balanced", "enhance"].includes(source.preset) ? source.preset : "balanced",
      strength: boundedNumber(source.strength, { label: "Audio enhancement strength", min: 0, max: 1, fallback: 0.5 })
    };
  });
  const broll = normalizeTimed(tracks.broll, "B-roll").map((item, index) => {
    const source = tracks.broll[index];
    const sourceStart = boundedNumber(source.sourceStart, { label: "B-roll source start", min: 0, max: 21_600, fallback: 0 });
    const sourceEnd = boundedNumber(source.sourceEnd, { label: "B-roll source end", min: 0.04, max: 21_600, fallback: 5 });
    if (sourceEnd <= sourceStart) throw new AppError("INVALID_RENDER_PLAN", "B-roll source timing is invalid.");
    if (sourceEnd - sourceStart < item.end - item.start) {
      throw new AppError("INVALID_RENDER_PLAN", "B-roll source timing must cover its complete project interval.");
    }
    return {
      ...item,
      mediaId: requireId(source.mediaId, "B-roll media"),
      sourceStart,
      sourceEnd,
      fit: ["fit_pad", "center_crop"].includes(source.fit) ? source.fit : "fit_pad",
      opacity: boundedNumber(source.opacity, { label: "B-roll opacity", min: 0.1, max: 1, fallback: 1 }),
      provenance: normalizeProvenance(source.provenance)
    };
  });
  const sfx = normalizeTimed(tracks.sfx, "Sound effect").map((item, index) => ({
    ...item,
    assetId: requireId(tracks.sfx[index].assetId, "Sound effect asset"),
    volume: boundedNumber(tracks.sfx[index].volume, { label: "Sound effect volume", min: 0, max: 1, fallback: 0.5 })
  }));
  return { subject, audio, broll, sfx };
}

function finiteTime(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new AppError("INVALID_RENDER_PLAN", `${label} must be a finite timestamp.`);
  return Number(number.toFixed(3));
}

function normalizeTextRecord(value, index, kind) {
  const at = finiteTime(value?.at, `${kind} ${index + 1} position`);
  return {
    id: value?.id ? requireId(value.id, kind) : `${kind.toLowerCase()}-${index + 1}`,
    at,
    text: boundedString(value?.text, { label: kind, min: 1, max: kind === "Comment" ? 500 : 120 })
  };
}

function normalizeTranscript(value, sourceDuration) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TRANSCRIPT_SEGMENTS) {
    throw new AppError("INVALID_RENDER_PLAN", `A project transcript may contain at most ${MAX_TRANSCRIPT_SEGMENTS} segments.`);
  }
  let previousStart = -1;
  let wordCount = 0;
  return value.map((segment, index) => {
    const start = finiteTime(segment?.start, `Transcript segment ${index + 1} start`);
    const end = finiteTime(segment?.end, `Transcript segment ${index + 1} end`);
    if (start < 0 || end <= start || end > sourceDuration || start < previousStart) {
      throw new AppError("INVALID_RENDER_PLAN", "Transcript timings must be ordered and remain within the source.");
    }
    previousStart = start;
    let previousWordStart = start;
    const words = (Array.isArray(segment?.words) ? segment.words : []).map((word, wordIndex) => {
      const wordStart = finiteTime(word?.start, `Transcript word ${wordIndex + 1} start`);
      const wordEnd = finiteTime(word?.end, `Transcript word ${wordIndex + 1} end`);
      if (wordStart < start || wordEnd <= wordStart || wordEnd > end || wordStart < previousWordStart) {
        throw new AppError("INVALID_RENDER_PLAN", "Transcript word timings must be ordered inside their segment.");
      }
      previousWordStart = wordStart;
      wordCount += 1;
      if (wordCount > MAX_TRANSCRIPT_WORDS) {
        throw new AppError("INVALID_RENDER_PLAN", `A project transcript may contain at most ${MAX_TRANSCRIPT_WORDS} words.`);
      }
      return {
        start: wordStart,
        end: wordEnd,
        text: boundedString(word?.text, { label: "Transcript word", min: 1, max: 200 })
      };
    });
    return {
      id: segment?.id ? requireId(segment.id, "Transcript segment") : `transcript-${index + 1}`,
      start,
      end,
      text: boundedString(segment?.text, { label: `Transcript segment ${index + 1}`, min: 1, max: 2_000 }),
      speaker: boundedString(segment?.speaker, { label: "Speaker", max: 80 }),
      words
    };
  });
}

function normalizeLanguage(value, label, fallback = "und") {
  const input = boundedString(value, { label, min: 2, max: 35, fallback });
  try {
    return Intl.getCanonicalLocales(input)[0];
  } catch {
    throw new AppError("INVALID_RENDER_PLAN", `${label} must be a valid language tag.`);
  }
}

function normalizeLocalization(value, transcript, totalDuration) {
  const localization = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const variants = Array.isArray(localization.variants) ? localization.variants : [];
  if (variants.length > MAX_LANGUAGE_VARIANTS) {
    throw new AppError("INVALID_RENDER_PLAN", `A project may contain at most ${MAX_LANGUAGE_VARIANTS} language variants.`);
  }
  const transcriptIds = new Set(transcript.map((cue) => cue.id));
  const variantIds = new Set();
  let characterCount = 0;
  const normalizedVariants = variants.map((variant, index) => {
    const id = variant?.id ? requireId(variant.id, "Language variant") : `language-${index + 1}`;
    if (variantIds.has(id)) throw new AppError("INVALID_RENDER_PLAN", "Language variant identifiers must be unique.");
    variantIds.add(id);
    const cues = Array.isArray(variant?.cues) ? variant.cues : [];
    if (cues.length !== transcript.length) {
      throw new AppError("INVALID_RENDER_PLAN", "Every language variant must include one cue for each source transcript cue.");
    }
    const cueIds = new Set();
    const normalizedCues = cues.map((cue) => {
      const sourceId = requireId(cue?.sourceId, "Localized source cue");
      if (!transcriptIds.has(sourceId) || cueIds.has(sourceId)) {
        throw new AppError("INVALID_RENDER_PLAN", "Localized cues must reference unique source transcript cues.");
      }
      cueIds.add(sourceId);
      const text = boundedString(cue?.text, { label: "Localized caption", min: 1, max: 2_000 });
      characterCount += text.length;
      if (characterCount > MAX_LOCALIZED_CHARACTERS) {
        throw new AppError("INVALID_RENDER_PLAN", "Localized captions exceed the supported project size.");
      }
      return { sourceId, text };
    });
    const provenanceSource = ["manual", "provider"].includes(variant?.provenance?.source) ? variant.provenance.source : "manual";
    const provenance = {
      source: provenanceSource,
      providerProfileId: provenanceSource === "provider" ? requireId(variant.provenance.providerProfileId, "Translation provider") : null,
      modelId:
        provenanceSource === "provider" ? boundedString(variant.provenance.modelId, { label: "Translation model", min: 1, max: 200 }) : null
    };
    return {
      id,
      language: normalizeLanguage(variant?.language, "Variant language"),
      label: boundedString(variant?.label, { label: "Language variant label", min: 1, max: 80 }),
      status: variant?.status === "reviewed" ? "reviewed" : "draft",
      cues: normalizedCues,
      provenance
    };
  });
  const activeVariantId = localization.activeVariantId ? requireId(localization.activeVariantId, "Active language variant") : null;
  if (activeVariantId && !normalizedVariants.some((variant) => variant.id === activeVariantId && variant.status === "reviewed")) {
    throw new AppError("INVALID_RENDER_PLAN", "Only a reviewed language variant can be selected for rendering.");
  }
  const voiceovers = Array.isArray(localization.voiceovers) ? localization.voiceovers : [];
  if (voiceovers.length > MAX_TRANSCRIPT_SEGMENTS) {
    throw new AppError("INVALID_RENDER_PLAN", "The project contains too many voiceover previews.");
  }
  const voiceoverIds = new Set();
  const normalizedVoiceovers = voiceovers.map((voiceover) => {
    const id = requireId(voiceover?.id, "Voiceover");
    if (voiceoverIds.has(id)) throw new AppError("INVALID_RENDER_PLAN", "Voiceover identifiers must be unique.");
    voiceoverIds.add(id);
    const sourceId = requireId(voiceover?.sourceId, "Voiceover transcript cue");
    if (!transcriptIds.has(sourceId)) {
      throw new AppError("INVALID_RENDER_PLAN", "Voiceovers must reference an existing transcript cue.");
    }
    const start = boundedNumber(voiceover.start, { label: "Voiceover start", min: 0, max: totalDuration, fallback: 0 });
    const end = boundedNumber(voiceover.end, {
      label: "Voiceover end",
      min: 0.04,
      max: totalDuration,
      fallback: start
    });
    if (end <= start) throw new AppError("INVALID_RENDER_PLAN", "Voiceover timing is invalid.");
    return {
      id,
      sourceId,
      assetId: requireId(voiceover?.assetId, "Voiceover audio"),
      start,
      end,
      status: voiceover?.status === "reviewed" ? "reviewed" : "draft",
      originalAudio: ["mix", "replace"].includes(voiceover?.originalAudio) ? voiceover.originalAudio : "mix",
      volume: boundedNumber(voiceover?.volume, { label: "Voiceover volume", min: 0, max: 1, fallback: 1 }),
      provenance: {
        source: "provider",
        providerProfileId: requireId(voiceover?.provenance?.providerProfileId, "Voiceover provider"),
        modelId: boundedString(voiceover?.provenance?.modelId, { label: "Voiceover model", min: 1, max: 200 }),
        voice: boundedString(voiceover?.provenance?.voice, { label: "Voice", min: 1, max: 200 }),
        voiceType: voiceover?.provenance?.voiceType === "custom" ? "custom" : "built_in",
        textHash:
          String(voiceover?.provenance?.textHash || "").match(/^[a-f0-9]{64}$/)?.[0] ||
          (() => {
            throw new AppError("INVALID_RENDER_PLAN", "Voiceover text provenance is invalid.");
          })(),
        aiGenerated: true
      }
    };
  });
  return {
    sourceLanguage: normalizeLanguage(localization.sourceLanguage, "Source language"),
    activeVariantId,
    variants: normalizedVariants,
    voiceovers: normalizedVoiceovers
  };
}

function normalizeRenderPlan(value, { sourceMediaId, sourceDuration }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_RENDER_PLAN", "The project render plan is invalid.");
  }
  const duration = finiteTime(sourceDuration, "Source duration");
  if (duration <= 0) throw new AppError("INVALID_RENDER_PLAN", "The project source duration is unavailable.");
  const planSourceId = requireId(value.sourceMediaId || sourceMediaId, "Project source");
  if (planSourceId !== sourceMediaId) throw new AppError("INVALID_RENDER_PLAN", "The render plan references a different source.");
  if (!Array.isArray(value.segments) || !value.segments.length || value.segments.length > MAX_SEGMENTS) {
    throw new AppError("INVALID_RENDER_PLAN", `A render plan must contain between 1 and ${MAX_SEGMENTS} segments.`);
  }
  let timelineStart = 0;
  const ids = new Set();
  const segments = value.segments.map((segment, index) => {
    const id = segment?.id ? requireId(segment.id, "Timeline segment") : `segment-${index + 1}`;
    if (ids.has(id)) throw new AppError("INVALID_RENDER_PLAN", "Timeline segment identifiers must be unique.");
    ids.add(id);
    const sourceStart = finiteTime(segment?.sourceStart, `Segment ${index + 1} start`);
    const sourceEnd = finiteTime(segment?.sourceEnd, `Segment ${index + 1} end`);
    if (sourceStart < 0 || sourceEnd <= sourceStart || sourceEnd > duration || sourceEnd - sourceStart < 0.04) {
      throw new AppError("INVALID_RENDER_PLAN", "Timeline segments must be positive and remain inside the source.");
    }
    const result = {
      id,
      sourceStart,
      sourceEnd,
      timelineStart: Number(timelineStart.toFixed(3)),
      duration: Number((sourceEnd - sourceStart).toFixed(3))
    };
    timelineStart += result.duration;
    return result;
  });
  const totalDuration = Number(timelineStart.toFixed(3));
  if (totalDuration < 0.1 || totalDuration > 21_600) {
    throw new AppError("INVALID_RENDER_PLAN", "The edited timeline duration is outside the supported range.");
  }
  const markers = Array.isArray(value.markers) ? value.markers.map((item, index) => normalizeTextRecord(item, index, "Marker")) : [];
  const comments = Array.isArray(value.comments) ? value.comments.map((item, index) => normalizeTextRecord(item, index, "Comment")) : [];
  if (markers.length > MAX_MARKERS || comments.length > MAX_COMMENTS) {
    throw new AppError("INVALID_RENDER_PLAN", "The project contains too many markers or comments.");
  }
  if ([...markers, ...comments].some((item) => item.at < 0 || item.at > totalDuration)) {
    throw new AppError("INVALID_RENDER_PLAN", "Markers and comments must remain inside the edited timeline.");
  }
  const presentation = value.presentation && typeof value.presentation === "object" ? value.presentation : {};
  const targetAspect = ["original", "vertical", "square", "landscape"].includes(presentation.targetAspect)
    ? presentation.targetAspect
    : "original";
  const aspectTreatment = ["original", "fit_pad", "center_crop"].includes(presentation.aspectTreatment)
    ? presentation.aspectTreatment
    : "fit_pad";
  const captionMode = ["off", "srt", "srt_burned"].includes(presentation.captionMode) ? presentation.captionMode : "off";
  const transcript = normalizeTranscript(value.transcript, duration);
  return {
    version: RENDER_PLAN_VERSION,
    sourceMediaId: planSourceId,
    sourceDuration: duration,
    segments,
    totalDuration,
    transcript,
    markers,
    comments,
    templateRef: normalizeTemplateRef(value.templateRef),
    composition: normalizeComposition(value.composition, totalDuration),
    intelligentTracks: normalizeIntelligentTracks(value.intelligentTracks, totalDuration),
    localization: normalizeLocalization(value.localization, transcript, totalDuration),
    presentation: {
      targetAspect,
      aspectTreatment,
      enhancement: {
        mode: presentation.enhancement?.mode === "resize_hd" ? "resize_hd" : "off",
        reviewed: presentation.enhancement?.mode === "resize_hd" && presentation.enhancement?.reviewed === true
      },
      captionMode,
      captionStyle: ["clean", "contrast", "notebook", "brand"].includes(presentation.captionStyle) ? presentation.captionStyle : "clean",
      captionPosition: ["lower", "middle", "upper"].includes(presentation.captionPosition) ? presentation.captionPosition : "lower",
      captionSafeArea: ["standard", "social"].includes(presentation.captionSafeArea) ? presentation.captionSafeArea : "standard",
      captionTextColor: colorValue(presentation.captionTextColor, "#ffffff"),
      captionBackgroundColor: colorValue(presentation.captionBackgroundColor, "#000000"),
      captionScale: boundedNumber(presentation.captionScale, {
        label: "Caption scale",
        min: 0.5,
        max: 2.5,
        fallback: 1
      })
    }
  };
}

function createInitialRenderPlan(source) {
  return normalizeRenderPlan(
    {
      sourceMediaId: source.mediaId,
      segments: [{ id: "segment-1", sourceStart: 0, sourceEnd: source.duration }],
      transcript: [],
      markers: [],
      comments: [],
      templateRef: null,
      composition: {},
      intelligentTracks: {},
      localization: {},
      presentation: {}
    },
    { sourceMediaId: source.mediaId, sourceDuration: source.duration }
  );
}

function hashRenderPlan(plan) {
  return crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function rebaseTranscript(plan, variantId = plan.localization?.activeVariantId) {
  const variant = variantId ? plan.localization?.variants?.find((item) => item.id === variantId && item.status === "reviewed") : null;
  const localized = new Map((variant?.cues || []).map((cue) => [cue.sourceId, cue.text]));
  const cues = [];
  for (const timelineSegment of plan.segments) {
    for (const transcriptSegment of plan.transcript) {
      const start = Math.max(timelineSegment.sourceStart, transcriptSegment.start);
      const end = Math.min(timelineSegment.sourceEnd, transcriptSegment.end);
      if (end <= start) continue;
      cues.push({
        id: `cue-${cues.length + 1}`,
        sourceId: transcriptSegment.id,
        start: Number((timelineSegment.timelineStart + start - timelineSegment.sourceStart).toFixed(3)),
        end: Number((timelineSegment.timelineStart + end - timelineSegment.sourceStart).toFixed(3)),
        text: localized.get(transcriptSegment.id) || transcriptSegment.text
      });
    }
  }
  return cues;
}

module.exports = {
  MAX_INTELLIGENT_TRACK_ITEMS,
  MAX_LANGUAGE_VARIANTS,
  MAX_SEGMENTS,
  RENDER_PLAN_VERSION,
  createInitialRenderPlan,
  hashRenderPlan,
  normalizeRenderPlan,
  rebaseTranscript
};
