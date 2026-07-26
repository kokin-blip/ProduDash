const assert = require("node:assert/strict");
const test = require("node:test");
const { validateCandidateEdits } = require("../electron/validation.cjs");

function candidate(id, start, end) {
  return { id, start, end, edit: null };
}

test("candidate edits normalize explicit timing, captions, and presentation", () => {
  const edit = validateCandidateEdits(
    {
      title: "  Approved moment  ",
      start: "2.125",
      end: "12.125",
      captionSegments: [
        { id: "caption-1", start: 0, end: 4, text: " First line " },
        { id: "caption-2", start: 4, end: 10, text: "Second line" }
      ],
      captionStyle: "notebook",
      captionPosition: "upper",
      captionSafeArea: "social",
      aspectTreatment: "center_crop",
      targetAspect: "vertical"
    },
    { sourceDuration: 30, candidates: [candidate("candidate-1", 2, 12)], candidateId: "candidate-1" }
  );
  assert.equal(edit.title, "Approved moment");
  assert.equal(edit.duration, 10);
  assert.equal(edit.captionSegments.length, 2);
  assert.equal(edit.captionStyle, "notebook");
});

test("candidate edits reject non-finite, reversed, out-of-range, oversized, overlapping, and invalid captions", () => {
  const options = {
    sourceDuration: 30,
    candidates: [candidate("candidate-1", 0, 10), candidate("candidate-2", 15, 25)],
    candidateId: "candidate-1"
  };
  const base = {
    title: "Edited",
    start: 0,
    end: 10,
    captionSegments: [],
    captionStyle: "clean",
    captionPosition: "lower",
    captionSafeArea: "standard",
    aspectTreatment: "fit_pad",
    targetAspect: "original"
  };
  for (const values of [
    { ...base, start: NaN },
    { ...base, start: 10, end: 9 },
    { ...base, end: 31 },
    { ...base, start: 0, end: 4 },
    { ...base, start: 10, end: 20 },
    { ...base, captionSegments: [{ id: "caption-1", start: 3, end: 2, text: "Bad" }] }
  ]) {
    assert.throws(
      () => validateCandidateEdits(values, options),
      (error) => ["INVALID_CANDIDATE_EDIT", "CANDIDATE_OVERLAP"].includes(error.code)
    );
  }
});
