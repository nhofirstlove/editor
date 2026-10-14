// The .otio hand-off for DaVinci Resolve. The structure is checked here; where Python
// has OpenTimelineIO (point OTIO_PYTHON at it), the file is also loaded with the real
// OTIO library and every clip's position on the timeline is compared.

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { layoutMain } from "../schema/sequence.ts";
import type { Timeline } from "../schema/timeline.ts";
import { buildOtio, writeOtio } from "../server/handoff.ts";

const projectDir = path.resolve("/studio/projects/demo");
const tl: Timeline = {
  version: 1,
  project: "demo",
  fps: 25,
  resolution: { width: 1920, height: 1080 },
  sources: [
    { id: "src1", path: "media/interview take 2.mp4", duration: 600, fps: 25, audioChannels: 2 },
    { id: "src2", path: "media/broll.mov", duration: 30, fps: 25, audioChannels: 0 },
    { id: "song", path: "media/song.mp3", duration: 180, audioChannels: 2 },
  ],
  tracks: {
    main: [
      { id: "c1", sourceId: "src1", in: 0, out: 12.4, label: "Intro" },
      { id: "c2", sourceId: "src1", in: 15.8, out: 42.1, speed: 1.25 },
      { id: "c3", sourceId: "src2", in: 2, out: 6 },
      { id: "c4", sourceId: "src1", in: 50, out: 63.5, muted: true, note: "Keep this answer" },
    ],
    music: [
      { id: "m1", sourceId: "song", start: 0, in: 10, out: 40, volume: 0.3, fadeIn: 1, fadeOut: 2, label: "Bed" },
      { id: "m2", sourceId: "song", start: 20, in: 0, out: 5 }, // overlaps m1: second music track
      { id: "m3", sourceId: "song", start: 45, in: 0, out: 10 }, // after m1 ends: first music track; cut at the end
      { id: "m4", sourceId: "song", start: 60, in: 0, out: 10 }, // after the main track ends: left out
    ],
  },
};

// Loosely typed: the tests read deep into the generated JSON.
type Json = Record<string, any>;
const otio = buildOtio(tl, projectDir) as Json;
const tracks = otio.tracks.children as Json[];
const frames = (item: Json) => item.source_range.duration.value as number;

describe("OTIO hand-off", () => {
  it("has a video track, its audio track, and music tracks", () => {
    expect(otio.OTIO_SCHEMA).toBe("Timeline.1");
    expect(tracks.map((t) => [t.name, t.kind])).toEqual([
      ["Video 1", "Video"],
      ["Audio 1", "Audio"],
      ["Music 1", "Audio"],
      ["Music 2", "Audio"],
    ]);
  });

  it("cuts each clip at whole frames, with speed as a time warp", () => {
    const video = tracks[0].children as Json[];
    expect(video.map((c) => [c.name, c.source_range.start_time.value, frames(c)])).toEqual([
      ["Intro", 0, 310], // 12.4 s
      ["c2", 395, 526], // 15.8 s in; 26.3 s at 1.25x = 21.04 s on the timeline
      ["c3", 50, 100],
      ["c4", 1250, 338], // 13.5 s, rounded from the running timeline position
    ]);
    expect(video[1].effects).toEqual([{ OTIO_SCHEMA: "LinearTimeWarp.1", name: "speed", effect_name: "LinearTimeWarp", metadata: {}, time_scalar: 1.25 }]);
    // The track adds up to the timeline's length in frames.
    const total = layoutMain(tl).at(-1)!.end;
    expect(video.reduce((n, c) => n + frames(c), 0)).toBe(Math.round(total * 25));
  });

  it("leaves gaps on the audio track for muted clips and clips without sound", () => {
    const audio = tracks[1].children as Json[];
    expect(audio.map((c) => c.OTIO_SCHEMA)).toEqual(["Clip.2", "Clip.2", "Gap.1", "Gap.1"]);
    expect(audio.map(frames)).toEqual((tracks[0].children as Json[]).map(frames));
  });

  it("places music at its start time, overlapping clips on separate tracks, ending with the main track", () => {
    const [music1, music2] = [tracks[2].children as Json[], tracks[3].children as Json[]];
    expect(music1.map((c) => [c.OTIO_SCHEMA, c.name, frames(c)])).toEqual([
      ["Clip.2", "Bed", 750],
      ["Gap.1", "", 375],
      ["Clip.2", "m3", 149], // stops where the main track ends (50.94 s = frame 1274)
    ]);
    expect(music2.map((c) => [c.OTIO_SCHEMA, frames(c)])).toEqual([["Gap.1", 500], ["Clip.2", 125]]);
    expect(music1[0].metadata["text-video-editor"]).toEqual({ id: "m1", volume: 0.3, fadeIn: 1, fadeOut: 2 });
  });

  it("links clips to the original media by full path", () => {
    const ref = (tracks[0].children as Json[])[0].media_references.DEFAULT_MEDIA;
    expect(ref.target_url).toBe(pathToFileURL(path.join(projectDir, "media", "interview take 2.mp4")).href);
    expect(ref.target_url).toContain("interview%20take%202.mp4");
    expect(ref.available_range.duration.value).toBe(15000);
  });

  it("keeps volume, mute and notes in clip metadata", () => {
    expect((tracks[0].children as Json[])[3].metadata["text-video-editor"]).toEqual({
      id: "c4",
      speed: 1,
      volume: 1,
      muted: true,
      note: "Keep this answer",
    });
  });

  it("writes a uniquely named .otio file into exports/", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tve-otio-"));
    const when = new Date(2026, 9, 14, 9, 5, 7);
    const a = await writeOtio(dir, tl, when);
    const b = await writeOtio(dir, tl, when);
    expect([a, b]).toEqual(["demo_resolve_2026-10-14_09-05-07.otio", "demo_resolve_2026-10-14_09-05-07-2.otio"]);
    expect(JSON.parse(await readFile(path.join(dir, "exports", a), "utf8")).OTIO_SCHEMA).toBe("Timeline.1");
  });
});

const otioPython = process.env.OTIO_PYTHON;
const hasOtio = !!otioPython && spawnSync(otioPython, ["-c", "import opentimelineio"]).status === 0;

describe.skipIf(!hasOtio)("OTIO hand-off read by OpenTimelineIO itself", () => {
  it("loads, and every clip sits where the timeline puts it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tve-otio-"));
    const file = path.join(dir, "exports", await writeOtio(dir, tl));
    const script = [
      "import json, sys, opentimelineio as otio",
      "t = otio.adapters.read_from_file(sys.argv[1])",
      "out = []",
      "for track in t.tracks:",
      "    items = [[c.name, round(c.range_in_parent().start_time.to_seconds(), 3), round(c.duration().to_seconds(), 3)] for c in track if isinstance(c, otio.schema.Clip)]",
      "    out.append([track.name, track.kind, round(track.duration().to_seconds(), 3), items])",
      "print(json.dumps(out))",
    ].join("\n");
    const run = spawnSync(otioPython!, ["-c", script, file], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    const loaded = JSON.parse(run.stdout) as Array<[string, string, number, Array<[string, number, number]>]>;

    const placed = layoutMain(tl);
    const fr = (s: number) => Math.round(s * 25) / 25;
    expect(loaded[0][2]).toBeCloseTo(fr(placed.at(-1)!.end), 3);
    expect(loaded[0][3]).toEqual(placed.map((p) => [p.clip.label ?? p.clip.id, fr(p.start), +(fr(p.end) - fr(p.start)).toFixed(3)]));
    expect(loaded[2][3]).toEqual([["Bed", 0, 30], ["m3", 45, 5.96]]);
    expect(loaded.map((t) => t[2])).toEqual([50.96, 50.96, 50.96, 25]);
    expect(loaded[3][3]).toEqual([["m2", 20, 5]]);
  });
});
