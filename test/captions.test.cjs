const assert = require("node:assert/strict");
const test = require("node:test");
const { deriveCaptionSegments, formatSrt, wrapCaptionText } = require("../electron/media/captions.cjs");
const { buildRenderArgs } = require("../electron/media/media-worker.cjs");

test("timed captions rebase, clip boundaries, wrap text, and remain monotonic", () => {
  const transcript = {
    segments: [
      { start: 2, end: 6, text: "Outside beginning but visible at the clip boundary." },
      {
        start: 7,
        end: 13,
        text: "This is a deliberately long sentence that should wrap into readable one or two line caption groups without an excessive cue."
      },
      { start: 14, end: 18, text: "Outside ending." }
    ]
  };
  const captions = deriveCaptionSegments(transcript, 4, 15);
  assert.equal(captions[0].start, 0);
  assert.equal(captions.at(-1).end, 11);
  assert.ok(captions.length > 3);
  assert.ok(captions.every((caption, index) => caption.start >= (captions[index - 1]?.end || 0)));
  assert.ok(captions.every((caption) => caption.text.split("\n").every((line) => line.length <= 42)));
  const srt = formatSrt(captions, 11);
  assert.match(srt, /00:00:00,000 -->/);
  assert.doesNotMatch(srt, /-->\s*-/);
});

test("caption helpers handle empty ranges, escaping, multiple cues, and invalid timestamps", () => {
  assert.deepEqual(deriveCaptionSegments({ segments: [{ start: 20, end: 22, text: "Later" }] }, 0, 10), []);
  assert.match(wrapCaptionText("word ".repeat(30)), /\n/);
  const srt = formatSrt(
    [
      { start: 0, end: 1.5, text: "First --> cue" },
      { start: 1.5, end: 3, text: "Second cue" }
    ],
    3
  );
  assert.match(srt, /First → cue/);
  assert.match(srt, /\n2\n/);
  assert.throws(() => deriveCaptionSegments({ segments: [{ start: NaN, end: 2, text: "Bad" }] }, 0, 4), {
    code: "TRANSCRIPT_INVALID"
  });
  assert.throws(() => formatSrt([{ start: 2, end: 1, text: "Bad" }], 3), { code: "CAPTION_TIMESTAMP_INVALID" });
});

test("burned caption arguments use allowlisted presentation and remain shell-free", () => {
  const args = buildRenderArgs({
    sourcePath: "/safe/source.mp4",
    outputPath: "/safe/output.mp4",
    candidate: { start: 1, duration: 8 },
    settings: {
      targetAspect: "vertical",
      aspectTreatment: "center_crop",
      captionStyle: "contrast",
      captionPosition: "upper",
      captionSafeArea: "social"
    },
    hasAudio: true,
    subtitlePath: "/safe/captions.srt"
  });
  const filter = args[args.indexOf("-vf") + 1];
  assert.match(filter, /subtitles=filename=/);
  assert.match(filter, /Alignment=8/);
  assert.match(filter, /MarginV=110/);
  assert.equal(args.includes("-shell"), false);
});
