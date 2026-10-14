import { describe, expect, it } from "vitest";
import { layoutMain } from "../schema/sequence.ts";
import type { Timeline } from "../schema/timeline.ts";
import {
  clipPlaying,
  parseTranscriptJson,
  wordIndexAt,
  wordsFor,
  wordsOnTimeline,
  wordTimelineStart,
  type Transcript,
  type Word,
} from "../schema/transcript.ts";
import { formatTranscript } from "../server/transcribe.ts";

const words: Word[] = [
  { text: "Hello", start: 0.1, end: 0.5 },
  { text: "there.", start: 0.6, end: 1.0 },
  { text: "Um,", start: 1.6, end: 2.0 },
  { text: "welcome", start: 2.6, end: 3.2 },
  { text: "back.", start: 3.3, end: 3.9 },
];
const transcript: Transcript = {
  version: 1,
  sources: { src1: { path: "media/a.mp4", model: "base", language: "en", createdAt: "2026-10-14T00:00:00Z", words } },
};
const tl: Timeline = {
  version: 1,
  sources: [{ id: "src1", path: "media/a.mp4", duration: 10 }],
  tracks: {
    main: [
      { id: "c1", sourceId: "src1", in: 0, out: 1.5 },
      { id: "c2", sourceId: "src1", in: 2.5, out: 4, speed: 2 }, // timeline 1.5–2.25
    ],
  },
};
const placed = layoutMain(tl);

describe("transcript.json", () => {
  it("accepts the empty placeholder and a full transcript", () => {
    expect(parseTranscriptJson("{}")).toEqual({ ok: true, transcript: {} });
    expect(parseTranscriptJson(JSON.stringify(transcript))).toEqual({ ok: true, transcript });
  });

  it("reports a broken file without throwing", () => {
    expect(parseTranscriptJson("{ nope")).toMatchObject({ ok: false, error: expect.stringMatching(/not valid JSON/) });
    const bad = parseTranscriptJson(JSON.stringify({ sources: { src1: { path: "x" } } }));
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/expected shape/) });
  });

  it("is written with one word per line and reads back the same", () => {
    const text = formatTranscript(transcript);
    expect(text.split("\n").filter((l) => l.includes('"text"'))).toHaveLength(words.length);
    expect(parseTranscriptJson(text)).toEqual({ ok: true, transcript });
  });

  it("ignores a transcript made from a different file", () => {
    expect(wordsFor(transcript, "src1", "media/a.mp4")).toBe(words);
    expect(wordsFor(transcript, "src1", "media/other.mp4")).toBeNull();
    expect(wordsFor(null, "src1", "media/a.mp4")).toBeNull();
  });
});

describe("words on the timeline", () => {
  it("knows which words are cut from the edit", () => {
    expect(words.map((w) => clipPlaying(placed, "src1", w)?.clip.id ?? null)).toEqual(["c1", "c1", null, "c2", "c2"]);
  });

  it("places words at timeline times, including speed changes", () => {
    expect(wordTimelineStart(placed, "src1", words[3])).toBeCloseTo(1.55, 9); // 1.5 + (2.6-2.5)/2
    expect(wordTimelineStart(placed, "src1", words[2])).toBeNull();
    const onTimeline = wordsOnTimeline(placed, { src1: words });
    expect(onTimeline.map((w) => [w.text, w.clipId, +w.timelineStart.toFixed(3), +w.timelineEnd.toFixed(3)])).toEqual([
      ["Hello", "c1", 0.1, 0.5],
      ["there.", "c1", 0.6, 1],
      ["welcome", "c2", 1.55, 1.85],
      ["back.", "c2", 1.9, 2.2],
    ]);
  });

  it("follows the clip order of the edit", () => {
    const reordered = layoutMain({ ...tl, tracks: { main: [tl.tracks.main[1], tl.tracks.main[0]] } });
    expect(wordsOnTimeline(reordered, { src1: words }).map((w) => w.text)).toEqual(["welcome", "back.", "Hello", "there."]);
  });
});

describe("wordIndexAt", () => {
  it.each([
    [0.0, -1], // before the first word
    [0.3, 0],
    [0.55, 0], // in the short pause after "Hello"
    [0.7, 1],
    [1.3, 1], // pause after "there.": kept until a second after it ends...
    [2.1, 2], // "Um," (1.6–2.0) is still the current word...
    [5.0, -1], // ...but not a second after the last word
    [3.25, 3],
    [10, -1],
  ])("at %s s gives %s", (t, index) => {
    expect(wordIndexAt(words, t)).toBe(index);
  });
});
