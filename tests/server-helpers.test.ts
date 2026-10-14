import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyTimeline, nextId, validateTimeline } from "../schema/timeline.ts";
import { parseProbe } from "../server/ffmpeg.ts";
import { saveSnapshot } from "../server/history.ts";
import { createPeakCounter, generatedName, parseSilences } from "../server/media.ts";
import { addImportedSource, checkProjectName, mediaFileName } from "../server/projects.ts";

describe("parseProbe", () => {
  const probe = (streams: object[], duration = "742.3612") => ({ format: { duration }, streams });

  it("reads duration, fps, resolution and audio channels", () => {
    const info = parseProbe(
      probe([
        { codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "25/1" },
        { codec_type: "audio", channels: 2 },
      ]),
    );
    expect(info).toEqual({ duration: 742.361, hasVideo: true, fps: 25, width: 1920, height: 1080, audioChannels: 2 });
  });

  it("handles fractional frame rates and falls back to r_frame_rate", () => {
    expect(parseProbe(probe([{ codec_type: "video", avg_frame_rate: "30000/1001" }])).fps).toBe(29.97);
    expect(parseProbe(probe([{ codec_type: "video", avg_frame_rate: "0/0", r_frame_rate: "24/1" }])).fps).toBe(24);
  });

  it("swaps width and height for rotated phone footage", () => {
    const info = parseProbe(probe([{ codec_type: "video", width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }]));
    expect([info.width, info.height]).toEqual([1080, 1920]);
  });

  it("ignores cover art in audio files", () => {
    const info = parseProbe(probe([{ codec_type: "audio", channels: 1 }, { codec_type: "video", disposition: { attached_pic: 1 } }]));
    expect(info.hasVideo).toBe(false);
    expect(info.audioChannels).toBe(1);
  });

  it("rejects files without a readable duration", () => {
    expect(() => parseProbe({ format: {}, streams: [] })).toThrow(/Could not read the length/);
  });
});

describe("createPeakCounter", () => {
  function pcm(values: number[]): Buffer {
    const buf = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => buf.writeInt16LE(v, i * 2));
    return buf;
  }

  it("keeps the loudest sample of each slice, scaled to 0-255", () => {
    const counter = createPeakCounter(4);
    counter.push(pcm([0, 100, -32767, 5, 0, 0, 0, 0, 16384]));
    expect(counter.finish()).toEqual([255, 0, 128]);
  });

  it("handles chunks that split a sample in half", () => {
    const whole = pcm([1000, -2000, 3000, -32767]);
    const counter = createPeakCounter(2);
    counter.push(whole.subarray(0, 3));
    counter.push(whole.subarray(3));
    expect(counter.finish()).toEqual([16, 255]);
  });
});

describe("project helpers", () => {
  it("accepts sensible project names and rejects risky ones", () => {
    expect(() => checkProjectName("client-interview_oct2")).not.toThrow();
    for (const bad of ["", "..", "a/b", "a b", "-x", "x".repeat(65)]) expect(() => checkProjectName(bad)).toThrow(/can't be used/);
  });

  it("finds the next free id", () => {
    expect(nextId([], "src")).toBe("src1");
    expect(nextId(["src1", "src7", "other"], "src")).toBe("src8");
  });

  it("names generated files after the media path", () => {
    expect(generatedName("media/day1/a.mp4")).toBe("day1__a.mp4");
  });

  it("makes uploaded file names safe and unique", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tve-"));
    await mkdir(path.join(dir, "media"));
    expect(await mediaFileName(dir, "My Interview (take 2).MP4")).toBe("My_Interview_take_2_.MP4");
    expect(await mediaFileName(dir, "C:\\Users\\me\\..\\clip.mov")).toBe("clip.mov");
    await writeFile(path.join(dir, "media", "clip.mov"), "");
    expect(await mediaFileName(dir, "clip.mov")).toBe("clip-2.mov");
  });

  it("adds an imported file as a source plus one full-length clip", () => {
    const info = { duration: 10.5, hasVideo: true, fps: 25, width: 1280, height: 720, audioChannels: 2 };
    const first = addImportedSource(emptyTimeline("demo"), "media/a.mp4", info);
    const second = addImportedSource(first.timeline, "media/b.mp4", { ...info, fps: 30 });
    const tl = second.timeline;
    expect(tl.fps).toBe(25);
    expect(tl.resolution).toEqual({ width: 1280, height: 720 });
    expect(tl.sources.map((s) => s.id)).toEqual(["src1", "src2"]);
    expect(tl.tracks.main).toEqual([
      { id: "c1", sourceId: "src1", in: 0, out: 10.5, speed: 1, volume: 1, muted: false },
      { id: "c2", sourceId: "src2", in: 0, out: 10.5, speed: 1, volume: 1, muted: false },
    ]);
    expect(validateTimeline(tl).ok).toBe(true);
  });

  it("puts an imported audio file on the music track at the start, quietly", () => {
    const video = { duration: 10.5, hasVideo: true, fps: 25, width: 1280, height: 720, audioChannels: 2 };
    const withVideo = addImportedSource(emptyTimeline("demo"), "media/a.mp4", video).timeline;
    const { timeline: tl, source } = addImportedSource(withVideo, "media/song.mp3", { duration: 95.25, hasVideo: false, audioChannels: 2 });
    expect(source).toEqual({ id: "src2", path: "media/song.mp3", duration: 95.25, audioChannels: 2 });
    expect(tl.tracks.main).toHaveLength(1);
    expect(tl.tracks.music).toEqual([{ id: "m1", sourceId: "src2", start: 0, in: 0, out: 95.25, volume: 0.3 }]);
    expect(tl.fps).toBe(25);
    expect(validateTimeline(tl).ok).toBe(true);
  });
});

describe("snapshots", () => {
  it("names snapshots by local time and reason, and never overwrites one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tve-history-"));
    const when = new Date(2026, 9, 14, 9, 5, 7);
    const first = await saveSnapshot(dir, "one", "external", when);
    const second = await saveSnapshot(dir, "two", "external", when);
    expect(path.basename(first)).toBe("2026-10-14_09-05-07_external.json");
    expect(path.basename(second)).toBe("2026-10-14_09-05-07_external-2.json");
    expect(await readFile(first, "utf8")).toBe("one");
  });
});

describe("parseSilences", () => {
  it("reads ffmpeg silencedetect output, closing an open silence at the end of the file", () => {
    const log = [
      "[silencedetect @ 0x1] silence_start: 1.50002",
      "[silencedetect @ 0x1] silence_end: 2.4999 | silence_duration: 0.999",
      "[silencedetect @ 0x1] silence_start: -0.01",
      "[silencedetect @ 0x1] silence_end: 0.7 | silence_duration: 0.71",
      "[silencedetect @ 0x1] silence_start: 9.2",
    ].join("\n");
    expect(parseSilences(log, 10)).toEqual([
      { start: 1.5, end: 2.5, duration: 1 },
      { start: 0, end: 0.7, duration: 0.7 },
      { start: 9.2, end: 10, duration: 0.8 },
    ]);
  });
});
