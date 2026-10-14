import { describe, expect, it } from "vitest";
import { layoutMain, locate, musicGainAt, timelineTimeOf, totalDuration } from "../schema/sequence.ts";
import type { Timeline } from "../schema/timeline.ts";

const tl: Timeline = {
  version: 1,
  sources: [{ id: "src1", path: "media/a.mp4", duration: 100, fps: 25 }],
  tracks: {
    main: [
      { id: "c1", sourceId: "src1", in: 0, out: 10 }, // 0-10
      { id: "c2", sourceId: "src1", in: 20, out: 30, speed: 2 }, // 10-15
      { id: "c3", sourceId: "src1", in: 50, out: 55, speed: 0.5 }, // 15-25
    ],
  },
};

describe("sequence timing", () => {
  const placed = layoutMain(tl);

  it("places clips back to back, with duration = (out - in) / speed", () => {
    expect(placed.map((p) => [p.clip.id, p.start, p.end])).toEqual([
      ["c1", 0, 10],
      ["c2", 10, 15],
      ["c3", 15, 25],
    ]);
    expect(totalDuration(placed)).toBe(25);
    expect(totalDuration(layoutMain({ ...tl, tracks: { main: [] } }))).toBe(0);
  });

  it("maps timeline time to source time, including speed changes", () => {
    const at = (t: number) => {
      const hit = locate(placed, t);
      return hit && [hit.placed.clip.id, hit.sourceTime];
    };
    expect(at(0)).toEqual(["c1", 0]);
    expect(at(4.5)).toEqual(["c1", 4.5]);
    expect(at(12)).toEqual(["c2", 24]); // 2 s into a 2x clip = 4 s of source
    expect(at(17)).toEqual(["c3", 51]); // 2 s into a 0.5x clip = 1 s of source
  });

  it("picks the later clip exactly at a cut, and the last clip at the very end", () => {
    expect(locate(placed, 10)?.placed.clip.id).toBe("c2");
    expect(locate(placed, 25)).toMatchObject({ placed: { clip: { id: "c3" } }, sourceTime: 55 });
    expect(locate(placed, 25.5)).toBeNull();
    expect(locate(placed, -1)).toBeNull();
  });

  it("maps source time back to timeline time", () => {
    expect(timelineTimeOf(placed[1], 24)).toBe(12);
    expect(timelineTimeOf(placed[2], 51)).toBe(17);
  });
});

describe("musicGainAt", () => {
  const m = { id: "m1", sourceId: "song", start: 10, in: 0, out: 10, volume: 0.5, fadeIn: 2, fadeOut: 4 };
  it.each([
    [-0.1, 0], // before the clip
    [0, 0], // start of the fade-in
    [1, 0.25], // halfway up
    [2, 0.5], // full volume
    [5, 0.5],
    [8, 0.25], // halfway down the fade-out
    [10, 0], // after the clip
  ])("%s s into the clip gives %s", (local, gain) => {
    expect(musicGainAt(m, local)).toBeCloseTo(gain, 9);
  });
});
