import { describe, expect, it } from "vitest";
import { summarizeChanges } from "../app/src/changes.ts";
import type { Timeline } from "../schema/timeline.ts";

const before: Timeline = {
  version: 1,
  fps: 25,
  sources: [{ id: "src1", path: "media/a.mp4", duration: 100 }],
  tracks: {
    main: [
      { id: "c1", sourceId: "src1", in: 0, out: 10, label: "Intro" },
      { id: "c2", sourceId: "src1", in: 20, out: 30 },
      { id: "c3", sourceId: "src1", in: 50, out: 60 },
    ],
  },
};

function change(edit: (tl: Timeline) => void): string[] {
  const after = structuredClone(before);
  edit(after);
  return summarizeChanges(before, after);
}

describe("summarizeChanges", () => {
  it("reports added and removed clips with timeline timecodes", () => {
    expect(change((tl) => tl.tracks.main.push({ id: "c9", sourceId: "src1", in: 70, out: 72.5 }))).toEqual([
      "Added c9 at 00:00:30:00 (2.5 s)",
      "Length 00:00:30:00 → 00:00:32:12",
    ]);
    expect(change((tl) => tl.tracks.main.splice(1, 1))).toEqual(["Removed c2 (was at 00:00:10:00, 10.0 s)", "Length 00:00:30:00 → 00:00:20:00"]);
  });

  it("reports trims, speed, volume, mute, label and note changes", () => {
    const lines = change((tl) => {
      const [c1, c2, c3] = tl.tracks.main;
      c1.in = 1.5;
      c2.speed = 1.25;
      c3.volume = 0.8;
      c3.muted = true;
      c2.label = "Answer";
      c1.note = "Keep";
    });
    expect(lines).toEqual([
      'Trimmed c1 "Intro" at 00:00:00:00: in 0.000 → 1.500 s',
      'Note on c1 "Intro" at 00:00:00:00: "Keep"',
      'Speed of c2 "Answer" at 00:00:08:12: 1× → 1.25×',
      'Label of c2 at 00:00:08:12 set to "Answer"',
      "Volume of c3 at 00:00:16:12: 100% → 80%",
      "Muted c3 at 00:00:16:12",
      "Length 00:00:30:00 → 00:00:26:12",
    ]);
  });

  it("notices reordering", () => {
    expect(change((tl) => tl.tracks.main.reverse())).toEqual(["Clips reordered"]);
  });

  it("describes music changes clip by clip", () => {
    const withMusic: Timeline = {
      ...before,
      tracks: { ...before.tracks, music: [{ id: "m1", sourceId: "src1", start: 2, in: 0, out: 10, volume: 0.3 }] },
    };
    const after = structuredClone(withMusic);
    after.tracks.music![0].start = 4;
    after.tracks.music![0].volume = 0.5;
    after.tracks.music!.push({ id: "m2", sourceId: "src1", start: 20, in: 0, out: 5, label: "Sting" });
    expect(summarizeChanges(withMusic, after)).toEqual([
      "Moved music m1: 00:00:02:00 → 00:00:04:00",
      "Volume of music m1: 30% → 50%",
      'Added music m2 "Sting" at 00:00:20:00 (5.0 s)',
    ]);
    const trimmedLeft = structuredClone(withMusic);
    Object.assign(trimmedLeft.tracks.music![0], { in: 1, start: 3 });
    expect(summarizeChanges(withMusic, trimmedLeft)).toEqual(["Trimmed music m1 at 00:00:03:00: 10.0 → 9.0 s"]);
    expect(summarizeChanges(withMusic, before)).toEqual(["Removed music m1 (was at 00:00:02:00)"]);
  });

  it("says when nothing in the edit changed", () => {
    expect(summarizeChanges(before, structuredClone(before))).toEqual(["No changes to the edit (only formatting)."]);
  });

  it("keeps long summaries short", () => {
    const lines = change((tl) => {
      for (let i = 0; i < 20; i++) tl.tracks.main.push({ id: `n${i}`, sourceId: "src1", in: i, out: i + 1 });
    });
    expect(lines).toHaveLength(9);
    expect(lines[7]).toBe("…and 13 more changes");
    expect(lines[8]).toMatch(/^Length /);
  });
});
