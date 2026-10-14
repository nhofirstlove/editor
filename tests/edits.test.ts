import { describe, expect, it } from "vitest";
import {
  cutRange,
  cutSourceRange,
  moveClip,
  moveAudio,
  removeAudio,
  rippleDelete,
  splitAt,
  trimClip,
  trimAudio,
  updateClip,
  updateAudio,
} from "../app/src/edits.ts";
import { layoutMain, totalDuration } from "../schema/sequence.ts";
import { validateTimeline, type Timeline } from "../schema/timeline.ts";

const base: Timeline = {
  version: 1,
  fps: 25,
  sources: [{ id: "src1", path: "media/a.mp4", duration: 100, fps: 25 }],
  tracks: {
    main: [
      { id: "c1", sourceId: "src1", in: 0, out: 10, speed: 1, volume: 1, muted: false, label: "Intro" },
      { id: "c2", sourceId: "src1", in: 20, out: 30, speed: 2, volume: 1, muted: false }, // 10-15 on the timeline
      { id: "c3", sourceId: "src1", in: 50, out: 60, note: "Keep this answer" }, // 15-25
    ],
  },
};

const clips = (tl: Timeline | null) => tl!.tracks.main.map((c) => [c.id, c.in, c.out]);
const duration = (tl: Timeline | null) => totalDuration(layoutMain(tl!));
const valid = (tl: Timeline | null) => expect(validateTimeline(tl).ok).toBe(true);

describe("split", () => {
  it("splits the clip under the playhead; the first part keeps the id", () => {
    const tl = splitAt(base, 4.2);
    expect(clips(tl)).toEqual([["c1", 0, 4.2], ["c4", 4.2, 10], ["c2", 20, 30], ["c3", 50, 60]]);
    expect(tl!.tracks.main[1]).toMatchObject({ label: "Intro", speed: 1 });
    expect(duration(tl)).toBe(25);
    valid(tl);
  });

  it("converts timeline time to source time inside sped-up clips", () => {
    expect(clips(splitAt(base, 12))!.slice(1, 3)).toEqual([["c2", 20, 24], ["c4", 24, 30]]);
  });

  it("rounds the split point to 3 decimals", () => {
    expect(splitAt(base, 1 / 3)!.tracks.main[0].out).toBe(0.333);
  });

  it("does nothing at a cut, within a frame of one, or past the end", () => {
    expect(splitAt(base, 10)).toBeNull();
    expect(splitAt(base, 10.01)).toBeNull();
    expect(splitAt(base, 30)).toBeNull();
  });

  it("does not modify the original timeline", () => {
    const before = structuredClone(base);
    splitAt(base, 4);
    expect(base).toEqual(before);
  });
});

describe("ripple delete", () => {
  it("removes the clip and closes the gap", () => {
    const tl = rippleDelete(base, "c2");
    expect(clips(tl)).toEqual([["c1", 0, 10], ["c3", 50, 60]]);
    expect(duration(tl)).toBe(20);
  });

  it("returns null for an unknown clip", () => {
    expect(rippleDelete(base, "nope")).toBeNull();
  });
});

describe("trim", () => {
  it("moves in and out points", () => {
    expect(clips(trimClip(base, "c1", "in", 2.5))![0]).toEqual(["c1", 2.5, 10]);
    expect(clips(trimClip(base, "c1", "out", 8.1234))![0]).toEqual(["c1", 0, 8.123]);
  });

  it("keeps the clip inside its source and at least one frame long", () => {
    expect(trimClip(base, "c1", "in", -5)).toBeNull(); // already at 0: no change
    expect(clips(trimClip(base, "c3", "out", 500))![2]).toEqual(["c3", 50, 100]);
    expect(clips(trimClip(base, "c1", "in", 50))![0]).toEqual(["c1", 9.96, 10]);
    expect(clips(trimClip(base, "c1", "out", 0))![0]).toEqual(["c1", 0, 0.04]);
  });

  it("changes the timeline length of later clips' positions (ripple)", () => {
    expect(duration(trimClip(base, "c1", "out", 5))).toBe(20);
  });
});

describe("clip settings", () => {
  it("sets speed and volume within their limits", () => {
    const tl = updateClip(base, "c1", { speed: 1.25, volume: 0.8 });
    expect(tl!.tracks.main[0]).toMatchObject({ speed: 1.25, volume: 0.8 });
    expect(duration(tl)).toBe(23);
    expect(updateClip(base, "c1", { speed: 10, volume: 5 })!.tracks.main[0]).toMatchObject({ speed: 4, volume: 2 });
    expect(updateClip(base, "c1", { speed: 0.1, volume: -1 })!.tracks.main[0]).toMatchObject({ speed: 0.25, volume: 0 });
  });

  it("mutes, and removes empty labels and notes", () => {
    const tl = updateClip(base, "c3", { muted: true, note: "", label: "Answer" });
    expect(tl!.tracks.main[2]).toEqual({ id: "c3", sourceId: "src1", in: 50, out: 60, muted: true, label: "Answer" });
  });
});

describe("reorder", () => {
  it("moves a clip to a new position in the array", () => {
    expect(clips(moveClip(base, 0, 3))!.map((c) => c[0])).toEqual(["c2", "c3", "c1"]);
    expect(clips(moveClip(base, 2, 0))!.map((c) => c[0])).toEqual(["c3", "c1", "c2"]);
    expect(clips(moveClip(base, 0, 2))!.map((c) => c[0])).toEqual(["c2", "c1", "c3"]);
  });

  it("returns null when the clip wouldn't move", () => {
    expect(moveClip(base, 1, 1)).toBeNull();
    expect(moveClip(base, 1, 2)).toBeNull();
  });
});

describe("cut a marked range", () => {
  it("cuts inside one clip, leaving two parts", () => {
    const tl = cutRange(base, 2, 4);
    expect(clips(tl)).toEqual([["c1", 0, 2], ["c4", 4, 10], ["c2", 20, 30], ["c3", 50, 60]]);
    expect(duration(tl)).toBe(23);
    valid(tl);
  });

  it("cuts across clips, trimming the ends and removing clips fully inside", () => {
    // 8-17: the last 2 s of c1, all of c2 (10-15), and the first 2 s of c3
    const tl = cutRange(base, 8, 17);
    expect(clips(tl)).toEqual([["c1", 0, 8], ["c3", 52, 60]]);
    expect(duration(tl)).toBe(16);
  });

  it("respects speed inside the range", () => {
    expect(clips(cutRange(base, 11, 12))![1]).toEqual(["c2", 20, 22]);
  });

  it("drops leftovers shorter than a frame", () => {
    expect(clips(cutRange(base, 0.01, 10))).toEqual([["c2", 20, 30], ["c3", 50, 60]]);
  });

  it("returns null for an empty or out-of-range selection", () => {
    expect(cutRange(base, 5, 5)).toBeNull();
    expect(cutRange(base, 30, 40)).toBeNull();
  });
});

describe("cut a source range (deleting words)", () => {
  it("cuts inside a clip, leaving two parts", () => {
    const tl = cutSourceRange(base, "src1", 52, 55);
    expect(clips(tl)).toEqual([["c1", 0, 10], ["c2", 20, 30], ["c3", 50, 52], ["c4", 55, 60]]);
    valid(tl);
  });

  it("trims a clip when the range touches its start or end", () => {
    expect(clips(cutSourceRange(base, "src1", 45, 51))![2]).toEqual(["c3", 51, 60]);
    expect(clips(cutSourceRange(base, "src1", 8, 12))![0]).toEqual(["c1", 0, 8]);
  });

  it("removes a clip entirely inside the range, and works whatever the clip order", () => {
    const reordered = moveClip(base, 2, 0)!;
    expect(clips(cutSourceRange(reordered, "src1", 19, 31))).toEqual([["c3", 50, 60], ["c1", 0, 10]]);
  });

  it("only touches clips of that source", () => {
    const twoSources: Timeline = {
      ...base,
      sources: [...base.sources, { id: "src2", path: "media/b.mp4", duration: 100 }],
      tracks: { main: [...base.tracks.main, { id: "c9", sourceId: "src2", in: 0, out: 10 }] },
    };
    expect(clips(cutSourceRange(twoSources, "src2", 2, 3))!.map((c) => c[0])).toEqual(["c1", "c2", "c3", "c9", "c10"]);
    expect(cutSourceRange(twoSources, "src1", 35, 45)).toBeNull();
  });
});

describe("music track", () => {
  const withMusic: Timeline = {
    ...base,
    sources: [...base.sources, { id: "song", path: "media/song.mp3", duration: 60, audioChannels: 2 }],
    tracks: { ...base.tracks, music: [{ id: "m1", sourceId: "song", start: 2, in: 5, out: 20, volume: 0.3, fadeIn: 1, fadeOut: 2 }] },
  };
  const m1 = (tl: Timeline | null) => tl!.tracks.music![0];

  it("moves a music clip, not before the start of the timeline", () => {
    expect(m1(moveAudio(withMusic, "music", "m1", 7.25))).toMatchObject({ start: 7.25, in: 5, out: 20 });
    expect(m1(moveAudio(withMusic, "music", "m1", -3))).toMatchObject({ start: 0 });
    expect(moveAudio(withMusic, "music", "m1", 2)).toBeNull();
  });

  it("trims the left edge without moving the music that stays", () => {
    // Later in point, later start: the remaining music plays at the same timeline time.
    expect(m1(trimAudio(withMusic, "music", "m1", "in", 8))).toMatchObject({ in: 8, start: 5, out: 20 });
    // Earlier in point is limited by timeline 0 (start 2 → 0 means in can go back to 3).
    expect(m1(trimAudio(withMusic, "music", "m1", "in", 0))).toMatchObject({ in: 3, start: 0 });
  });

  it("trims the right edge within the source", () => {
    expect(m1(trimAudio(withMusic, "music", "m1", "out", 12))).toMatchObject({ out: 12 });
    expect(m1(trimAudio(withMusic, "music", "m1", "out", 500))).toMatchObject({ out: 60 });
  });

  it("keeps fades within a shortened clip", () => {
    expect(m1(trimAudio(withMusic, "music", "m1", "out", 7))).toMatchObject({ in: 5, out: 7, fadeIn: 1, fadeOut: 1 });
  });

  it("sets volume and fades, removing zero fades", () => {
    const tl = updateAudio(withMusic, "music", "m1", { volume: 3, fadeIn: 0, fadeOut: 4.5, label: "Bed" });
    expect(m1(tl)).toEqual({ id: "m1", sourceId: "song", start: 2, in: 5, out: 20, volume: 2, fadeOut: 4.5, label: "Bed" });
    valid(tl);
  });

  it("removes a music clip without moving anything else", () => {
    const tl = removeAudio(withMusic, "music", "m1");
    expect(tl!.tracks.music).toEqual([]);
    expect(tl!.tracks.main).toEqual(withMusic.tracks.main);
  });

  it("leaves music in place when main-track clips are cut", () => {
    expect(rippleDelete(withMusic, "c1")!.tracks.music).toEqual(withMusic.tracks.music);
  });
});
