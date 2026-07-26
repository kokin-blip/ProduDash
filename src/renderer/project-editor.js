function clone(value) {
  return globalThis.structuredClone(value);
}

function normalizeTimeline(plan) {
  const next = clone(plan);
  let cursor = 0;
  next.segments = next.segments.map((segment) => {
    const result = {
      ...segment,
      sourceStart: Number(Number(segment.sourceStart).toFixed(3)),
      sourceEnd: Number(Number(segment.sourceEnd).toFixed(3)),
      timelineStart: Number(cursor.toFixed(3)),
      duration: Number((Number(segment.sourceEnd) - Number(segment.sourceStart)).toFixed(3))
    };
    cursor += result.duration;
    return result;
  });
  next.totalDuration = Number(cursor.toFixed(3));
  return next;
}

function boundaries(project) {
  const values = [0, Number(project.source.duration), Number(project.draft.totalDuration), Number(project.playhead || 0)];
  for (const segment of project.draft.segments) values.push(segment.sourceStart, segment.sourceEnd);
  for (const scene of project.preparation?.scenes || []) values.push(Number(scene));
  for (const cue of project.draft.transcript || []) {
    values.push(Number(cue.start), Number(cue.end));
    for (const word of cue.words || []) values.push(Number(word.start), Number(word.end));
  }
  return values.filter(Number.isFinite);
}

export function snapTime(value, project, tolerance = 0.15) {
  const number = Number(value);
  if (!Number.isFinite(number)) return number;
  const nearest = boundaries(project).reduce(
    (best, candidate) => (Math.abs(candidate - number) < Math.abs(best - number) ? candidate : best),
    number
  );
  return Math.abs(nearest - number) <= tolerance ? Number(nearest.toFixed(3)) : Number(number.toFixed(3));
}

export function editSegment(plan, segmentId, values) {
  const next = clone(plan);
  next.segments = next.segments.map((segment) => (segment.id === segmentId ? { ...segment, ...values } : segment));
  return normalizeTimeline(next);
}

export function splitSegment(plan, segmentId, sourceTime) {
  const next = clone(plan);
  const index = next.segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) return next;
  const segment = next.segments[index];
  const split = Number(sourceTime);
  if (!Number.isFinite(split) || split <= segment.sourceStart + 0.04 || split >= segment.sourceEnd - 0.04) return next;
  next.segments.splice(
    index,
    1,
    { ...segment, sourceEnd: split },
    {
      ...segment,
      id: `segment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      sourceStart: split
    }
  );
  return normalizeTimeline(next);
}

export function duplicateSegment(plan, segmentId) {
  const next = clone(plan);
  const index = next.segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0 || next.segments.length >= 100) return next;
  next.segments.splice(index + 1, 0, {
    ...next.segments[index],
    id: `segment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  });
  return normalizeTimeline(next);
}

export function moveSegment(plan, segmentId, direction) {
  const next = clone(plan);
  const index = next.segments.findIndex((segment) => segment.id === segmentId);
  const target = index + Number(direction);
  if (index < 0 || target < 0 || target >= next.segments.length) return next;
  [next.segments[index], next.segments[target]] = [next.segments[target], next.segments[index]];
  return normalizeTimeline(next);
}

export function deleteSegment(plan, segmentId) {
  if (plan.segments.length <= 1) return clone(plan);
  const next = clone(plan);
  next.segments = next.segments.filter((segment) => segment.id !== segmentId);
  return normalizeTimeline(next);
}

export function sourceTimeAtPlayhead(plan, playhead) {
  const time = Math.max(0, Math.min(Number(plan.totalDuration), Number(playhead) || 0));
  const segment =
    plan.segments.find((item) => time >= item.timelineStart && time <= item.timelineStart + item.duration) || plan.segments.at(-1);
  return {
    segment,
    sourceTime: Number((segment.sourceStart + Math.max(0, time - segment.timelineStart)).toFixed(3))
  };
}

export function updateTranscript(plan, changes) {
  const next = clone(plan);
  const byId = new Map(changes.map((item) => [item.id, item.text]));
  next.transcript = next.transcript.map((segment) => (byId.has(segment.id) ? { ...segment, text: byId.get(segment.id) } : segment));
  if (next.localization?.variants?.length) {
    next.localization = {
      ...next.localization,
      activeVariantId: null,
      variants: next.localization.variants.map((variant) => ({ ...variant, status: "draft" })),
      voiceovers: (next.localization.voiceovers || []).map((voiceover) => ({ ...voiceover, status: "draft" }))
    };
  }
  return next;
}

export function addMarker(plan, at, text) {
  const next = clone(plan);
  next.markers = [
    ...(next.markers || []),
    { id: `marker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at: Number(at), text }
  ].slice(0, 200);
  return next;
}

export function addComment(plan, at, text) {
  const next = clone(plan);
  next.comments = [
    ...(next.comments || []),
    { id: `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at: Number(at), text }
  ].slice(0, 200);
  return next;
}

export { normalizeTimeline };
