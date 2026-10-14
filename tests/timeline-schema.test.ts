import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildJsonSchema } from "../schema/json-schema.ts";
import { parseTimelineJson, validateTimeline, type Timeline } from "../schema/timeline.ts";

// The example from SPEC.md section 5.
const example: Timeline = {
  version: 1,
  project: "client-interview-oct",
  fps: 25,
  resolution: { width: 1920, height: 1080 },
  sources: [
    { id: "src1", path: "media/interview_take2.mp4", duration: 742.36, fps: 25 },
    { id: "src2", path: "media/music_bed.mp3", duration: 95.0 },
  ],
  tracks: {
    main: [
      { id: "c1", sourceId: "src1", in: 0.0, out: 12.4, speed: 1.0, volume: 1.0, muted: false, label: "Intro" },
      { id: "c2", sourceId: "src1", in: 15.8, out: 42.1, speed: 1.25, volume: 1.0, muted: false },
      { id: "c3", sourceId: "src1", in: 50.0, out: 63.5, speed: 1.0, volume: 0.8, muted: false, note: "Keep this answer" },
    ],
    music: [{ id: "m1", sourceId: "src2", start: 0.0, in: 0.0, out: 30.0, volume: 0.3, fadeIn: 1.0, fadeOut: 2.0 }],
  },
};

function errorsFor(change: (tl: any) => void): string[] {
  const tl = structuredClone(example);
  change(tl);
  const result = validateTimeline(tl);
  return result.ok ? [] : result.errors;
}

describe("timeline validation", () => {
  it("accepts the example from the spec", () => {
    expect(validateTimeline(example)).toEqual({ ok: true, timeline: example });
  });

  it("accepts a minimal empty timeline", () => {
    expect(validateTimeline({ version: 1, sources: [], tracks: { main: [] } }).ok).toBe(true);
  });

  it("does not add defaults to the parsed timeline", () => {
    const tl = { version: 1, sources: [{ id: "s", path: "media/a.mp4" }], tracks: { main: [{ id: "c", sourceId: "s", in: 0, out: 1 }] } };
    const result = validateTimeline(tl);
    expect(result.ok && result.timeline).toEqual(tl);
  });

  it.each([
    ["in >= out", (tl: any) => (tl.tracks.main[1].in = 50), `tracks.main[1] (clip "c2"): "in" (50) must be less than "out" (42.1)`],
    ["out past source end", (tl: any) => (tl.tracks.main[0].out = 800), `tracks.main[0] (clip "c1"): "out" (800) is past the end of source "src1" (742.36 s long)`],
    ["speed too high", (tl: any) => (tl.tracks.main[1].speed = 5), `tracks.main[1] (clip "c2"): "speed" must be between 0.25 and 4.0 (found 5)`],
    ["speed too low", (tl: any) => (tl.tracks.main[1].speed = 0.1), `tracks.main[1] (clip "c2"): "speed" must be between 0.25 and 4.0 (found 0.1)`],
    ["volume too high", (tl: any) => (tl.tracks.main[2].volume = 3), `tracks.main[2] (clip "c3"): "volume" must be between 0.0 and 2.0 (found 3)`],
    ["negative in", (tl: any) => (tl.tracks.main[0].in = -1), `tracks.main[0] (clip "c1"): "in" must be 0 or more (found -1)`],
    ["too many decimals", (tl: any) => (tl.tracks.main[0].out = 12.4567), `tracks.main[0] (clip "c1"): "out" must be rounded to 3 decimals (for example 12.345) (found 12.4567)`],
    ["unknown sourceId", (tl: any) => (tl.tracks.main[0].sourceId = "src9"), `tracks.main[0] (clip "c1"): "sourceId" "src9" does not match any source in "sources"`],
    ["duplicate clip id across tracks", (tl: any) => (tl.tracks.music[0].id = "c1"), `tracks.music[0] (clip "c1"): "id" "c1" is used by more than one clip; every clip needs a unique id`],
    ["duplicate source id", (tl: any) => tl.sources.push({ ...tl.sources[0] }), `sources[2] (source "src1"): "id" "src1" is used by more than one source; every source needs its own id`],
    ["missing field", (tl: any) => delete tl.tracks.main[0].out, `tracks.main[0] (clip "c1"): "out" is missing`],
    ["misspelled field", (tl: any) => (tl.tracks.main[0].Out = 1), `tracks.main[0] (clip "c1"): unknown field "Out"; check the spelling or remove it`],
    ["start on a main clip", (tl: any) => (tl.tracks.main[0].start = 3), `tracks.main[0] (clip "c1"): main-track clips must not have "start"; their position comes from clip order`],
    ["wrong type", (tl: any) => (tl.tracks.main[0].muted = "yes"), `tracks.main[0] (clip "c1"): "muted" must be true or false (found "yes")`],
    ["wrong version", (tl: any) => (tl.version = 3), `"version" must be 1 or 2 (found 3)`],
    ["path outside media", (tl: any) => (tl.sources[0].path = "media/../secret.mp4"), `sources[0] (source "src1"): "path" must be a path inside media/ using forward slashes (for example "media/interview.mp4") (found "media/../secret.mp4")`],
    ["main is not a list", (tl: any) => (tl.tracks.main = {}), `tracks: "main" must be a list (found {})`],
  ])("reports %s clearly", (_name, change, message) => {
    expect(errorsFor(change)).toEqual([message]);
  });

  it("reports several problems at once", () => {
    const errors = errorsFor((tl) => {
      tl.tracks.main[0].speed = 9;
      tl.tracks.main[2].volume = -1;
    });
    expect(errors).toHaveLength(2);
  });
});

describe("parseTimelineJson", () => {
  it("points at the line and column of a JSON syntax error", () => {
    const result = parseTimelineJson('{\n  "version": 1,\n  "sources": []\n  "tracks": {}\n}');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors[0]).toMatch(/^The file is not valid JSON near line 4, column 3 \(.+\)\. Look for a missing comma/);
  });

  it("accepts a file saved with a byte-order mark", () => {
    expect(parseTimelineJson('﻿{"version":1,"sources":[],"tracks":{"main":[]}}').ok).toBe(true);
  });

  it("never throws, even on empty input", () => {
    expect(parseTimelineJson("").ok).toBe(false);
    expect(parseTimelineJson("null").ok).toBe(false);
  });
});

describe("schema/timeline.schema.json", () => {
  it("matches the zod schema (run `npm run schema` if this fails)", () => {
    const onDisk = JSON.parse(readFileSync(new URL("../schema/timeline.schema.json", import.meta.url), "utf8"));
    expect(onDisk).toEqual(buildJsonSchema());
  });
});
