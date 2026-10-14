import { describe, expect, it } from "vitest";
import { formatTimecode, frameAt, frameTime } from "../schema/timecode.ts";

describe("formatTimecode", () => {
  it.each([
    [0, 25, "00:00:00:00"],
    [1.04, 25, "00:00:01:01"],
    [12.96, 25, "00:00:12:24"],
    [3725.5, 25, "01:02:05:12"],
    [0.999, 29.97, "00:00:00:29"],
    [-3, 25, "00:00:00:00"],
    [NaN, 25, "00:00:00:00"],
  ])("formats %s s at %s fps as %s", (t, fps, expected) => {
    expect(formatTimecode(t, fps)).toBe(expected);
  });
});

describe("frame math", () => {
  it("seeks to the middle of a frame and reads the same frame back", () => {
    for (const fps of [24, 25, 29.97, 30, 60]) {
      for (const frame of [0, 1, 7, 249, 17999]) {
        expect(frameAt(frameTime(frame, fps), fps)).toBe(frame);
      }
    }
  });

  it("treats exact frame boundaries as the start of that frame", () => {
    expect(frameAt(0.04 * 3, 25)).toBe(3);
  });
});
