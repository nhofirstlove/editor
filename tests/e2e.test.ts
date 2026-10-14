// End to end: generate test media with ffmpeg, export a known timeline, and check the
// result with ffprobe and ffmpeg's own detectors.
//
// The main test source is white with a tone, except from 2 s to 3 s where the picture
// is black AND the sound is silent. In the export, the black stretches (blackdetect)
// and the silent stretches (silencedetect) must appear exactly where the timeline puts
// them. That checks cut points, speed changes and audio/video sync in one go.
//
// Run on its own with: npm run e2e

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { duckGainAt, layoutMain, totalDuration, voiceSpans, zoomWindow } from "../schema/sequence.ts";
import type { Timeline } from "../schema/timeline.ts";
import { newExportName, runExport, type ExportResult } from "../server/export.ts";
import { run } from "../server/ffmpeg.ts";
import { detectSilences } from "../server/media.ts";
import { hasFfmpeg, makeTestVideo } from "./helpers/test-media.ts";

const FPS = 25;
const TOLERANCE = 0.08; // seconds: about two frames, plus AAC's start-up delay

function ffmpeg(args: string[]): string {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stderr;
}

/** Black stretches in a video, from ffmpeg's blackdetect filter. */
function blackRanges(file: string): Array<[number, number]> {
  const log = ffmpeg(["-i", file, "-an", "-vf", "blackdetect=d=0.2:pix_th=0.1", "-f", "null", "-"]);
  return [...log.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

const timeline: Timeline = {
  version: 1,
  project: "e2e",
  fps: FPS,
  resolution: { width: 320, height: 240 },
  sources: [
    { id: "A", path: "media/a.mp4", duration: 6, fps: FPS, width: 320, height: 240, audioChannels: 1 },
    { id: "B", path: "media/b.mp4", duration: 4, fps: FPS, width: 640, height: 360, audioChannels: 0 },
  ],
  tracks: {
    main: [
      { id: "c1", sourceId: "A", in: 1, out: 4 }, //                 0–3     black/silent at 1–2
      { id: "c2", sourceId: "B", in: 0, out: 2 }, //                 3–5     no audio: silent
      { id: "c3", sourceId: "A", in: 0, out: 4, speed: 2 }, //       5–7     black/silent at 6–6.5
      { id: "c4", sourceId: "A", in: 0, out: 2, muted: true }, //    7–9     muted: silent
      { id: "c5", sourceId: "A", in: 3, out: 4.5, speed: 0.5, volume: 2 }, // 9–12
      { id: "c6", sourceId: "A", in: 4, out: 6, speed: 4 }, //       12–12.5 (atempo 2 x 2)
    ],
  },
};

describe.skipIf(!hasFfmpeg)("end-to-end export", () => {
  let dir: string;
  let result: ExportResult;
  let output: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tve-e2e-"));
    await mkdir(path.join(dir, "media"));
    // A: 6 s, white with a 440 Hz tone; black and silent from 2 s to 3 s.
    const gap = "gte(t,2)*lt(t,3)";
    ffmpeg([
      "-f", "lavfi", "-i", `color=c=white:s=320x240:r=${FPS}:d=6`,
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
      "-vf", `drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='${gap}'`,
      "-af", `volume=volume=0:enable='${gap}',volume=4`,
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-pix_fmt", "yuv420p", "-c:a", "aac",
      path.join(dir, "media", "a.mp4"),
    ]);
    // B: 4 s test pattern in a different size, with no audio track.
    ffmpeg(["-f", "lavfi", "-i", `testsrc=size=640x360:rate=${FPS}:duration=4`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(dir, "media", "b.mp4")]);

    const name = await newExportName(dir, timeline, "final");
    result = await runExport(dir, timeline, "final", name, () => {});
    output = path.join(dir, "exports", result.file);
  });

  it("finds the gap in the source with the silences helper", async () => {
    const found = await detectSilences(path.join(dir, "media", "a.mp4"), 0.6, -35, 6);
    expect(found).toHaveLength(1);
    expect(found[0].start).toBeCloseTo(2, 1);
    expect(found[0].end).toBeCloseTo(3, 1);
  });

  it("matches the timeline duration within one frame per clip", () => {
    const expected = totalDuration(layoutMain(timeline));
    expect(expected).toBe(12.5);
    expect(result.expectedDuration).toBe(12.5);
    expect(Math.abs(result.duration - expected)).toBeLessThanOrEqual(timeline.tracks.main.length / FPS);
  });

  it("has a video and an audio stream of the same length", async () => {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration", "-of", "json", output]);
    const streams = JSON.parse(stdout).streams as Array<{ codec_type: string; width?: number; height?: number; duration: string }>;
    const video = streams.find((s) => s.codec_type === "video")!;
    const audio = streams.find((s) => s.codec_type === "audio")!;
    expect([video.width, video.height]).toEqual([320, 240]);
    expect(Math.abs(Number(video.duration) - Number(audio.duration))).toBeLessThan(TOLERANCE);
  });

  it("puts black picture exactly where the timeline says (cuts and speed changes)", () => {
    const black = blackRanges(output);
    expect(black).toHaveLength(2);
    // c1 shows source 2–3 at timeline 1–2; c3 shows it at double speed at 6–6.5.
    for (const [[start, end], [wantStart, wantEnd]] of black.map((b, i) => [b, [[1, 2], [6, 6.5]][i]] as const)) {
      expect(Math.abs(start - wantStart)).toBeLessThan(TOLERANCE);
      expect(Math.abs(end - wantEnd)).toBeLessThan(TOLERANCE);
    }
  });

  it("puts silence in the same places, so sound and picture are in sync", async () => {
    const silent = await detectSilences(output, 0.3, -35, result.duration);
    const expected = [
      [1, 2], // the gap in c1 (same as the black picture)
      [3, 5], // c2's source has no audio
      [6, 6.5], // the gap in c3 at 2x (same as the black picture)
      [7, 9], // c4 is muted
    ];
    expect(silent.map((s) => [s.start, s.end])).toHaveLength(expected.length);
    silent.forEach((s, i) => {
      expect(Math.abs(s.start - expected[i][0])).toBeLessThan(TOLERANCE);
      expect(Math.abs(s.end - expected[i][1])).toBeLessThan(TOLERANCE);
    });
  });

  it("plays the slowed-down and sped-up clips at the right length (atempo chains)", async () => {
    // c5 (0.5x) fills 9–12 and c6 (4x) fills 12–12.5 with tone: no silence there.
    const silent = await detectSilences(output, 0.1, -35, result.duration);
    expect(silent.some((s) => s.end > 9.1 && s.start < result.duration - 0.1)).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)("end-to-end export with music", () => {
  // Main track: 6 s of picture with no sound. Music: a tone at 1–3 s (with short fades)
  // and another from 4.5 s that runs past the end and must be cut off at 6 s.
  const withMusic: Timeline = {
    version: 1,
    project: "e2e-music",
    fps: FPS,
    resolution: { width: 320, height: 240 },
    sources: [
      { id: "B", path: "media/b.mp4", duration: 6, fps: FPS, width: 320, height: 240, audioChannels: 0 },
      { id: "T", path: "media/tone.wav", duration: 10, audioChannels: 1 },
    ],
    tracks: {
      main: [{ id: "c1", sourceId: "B", in: 0, out: 6 }],
      music: [
        { id: "m1", sourceId: "T", start: 1, in: 2, out: 4, volume: 2, fadeIn: 0.2, fadeOut: 0.2 },
        { id: "m2", sourceId: "T", start: 4.5, in: 0, out: 5 },
      ],
    },
  };
  let dir: string;
  let result: ExportResult;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tve-e2e-music-"));
    await mkdir(path.join(dir, "media"));
    ffmpeg(["-f", "lavfi", "-i", `testsrc=size=320x240:rate=${FPS}:duration=6`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(dir, "media", "b.mp4")]);
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=10", path.join(dir, "media", "tone.wav")]);
    result = await runExport(dir, withMusic, "preview", await newExportName(dir, withMusic, "preview"), () => {});
  });

  it("ends with the main track, cutting off music that runs longer", () => {
    expect(Math.abs(result.duration - 6)).toBeLessThan(TOLERANCE);
  });

  it("puts the music exactly where the music track says", async () => {
    const silent = await detectSilences(path.join(dir, "exports", result.file), 0.3, -40, result.duration);
    const expected = [
      [0, 1], // before m1
      [3, 4.5], // between m1 and m2
    ];
    expect(silent).toHaveLength(expected.length);
    silent.forEach((s, i) => {
      expect(Math.abs(s.start - expected[i][0])).toBeLessThan(TOLERANCE);
      expect(Math.abs(s.end - expected[i][1])).toBeLessThan(TOLERANCE);
    });
  });
});

describe.skipIf(!hasFfmpeg)("end-to-end export with voiceover and ducking", () => {
  // Main track: 8 s of picture with no sound. Music: a 330 Hz tone the whole way through.
  // Voiceover: a 2000 Hz tone in three clips; the first two are 0.1 s apart, so their
  // ramps meet. Music is lowered 12 dB under voice. Low-pass and high-pass filters
  // separate the two tones again, so each can be measured on its own.
  const DB = -12;
  const withVoice: Timeline = {
    version: 2,
    project: "e2e-voice",
    fps: FPS,
    resolution: { width: 320, height: 240 },
    sources: [
      { id: "B", path: "media/b.mp4", duration: 8, fps: FPS, width: 320, height: 240, audioChannels: 0 },
      { id: "T", path: "media/tone.wav", duration: 10, audioChannels: 1 },
      { id: "V", path: "media/voice.wav", duration: 3, audioChannels: 1 },
    ],
    tracks: {
      main: [{ id: "c1", sourceId: "B", in: 0, out: 8 }],
      voice: [
        { id: "v1", sourceId: "V", start: 2, in: 0, out: 1.5 }, //   2–3.5
        { id: "v2", sourceId: "V", start: 3.6, in: 1, out: 2.4 }, // 3.6–5
        { id: "v3", sourceId: "V", start: 6.2, in: 0, out: 1 }, //   6.2–7.2
      ],
      music: [{ id: "m1", sourceId: "T", start: 0, in: 0, out: 8, volume: 0.5 }],
      mix: { duckMusicUnderVoice: DB },
    },
  };
  const RATE = 48000;
  let dir: string;
  let result: ExportResult;

  /** The export's sound, filtered, as mono samples. */
  function samples(filter: string): Float32Array {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-i", path.join(dir, "exports", result.file), "-af", filter, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(r.stderr.toString());
    const buf = r.stdout as Buffer;
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  }

  /** Level in dB (RMS) between two times. */
  function level(data: Float32Array, from: number, to: number): number {
    let sum = 0;
    const a = Math.round(from * RATE);
    const b = Math.round(to * RATE);
    for (let i = a; i < b; i++) sum += data[i] * data[i];
    return 10 * Math.log10(sum / (b - a));
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tve-e2e-voice-"));
    await mkdir(path.join(dir, "media"));
    ffmpeg(["-f", "lavfi", "-i", `testsrc=size=320x240:rate=${FPS}:duration=8`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(dir, "media", "b.mp4")]);
    ffmpeg(["-f", "lavfi", "-i", `sine=frequency=330:sample_rate=${RATE}:duration=10`, path.join(dir, "media", "tone.wav")]);
    ffmpeg(["-f", "lavfi", "-i", `sine=frequency=2000:sample_rate=${RATE}:duration=3`, path.join(dir, "media", "voice.wav")]);
    result = await runExport(dir, withVoice, "preview", await newExportName(dir, withVoice, "preview"), () => {});
  });

  it("is as long as the main track", () => {
    expect(Math.abs(result.duration - 8)).toBeLessThan(TOLERANCE);
  });

  it("plays the voiceover exactly where the voice track says", () => {
    const voice = samples("highpass=f=1200,highpass=f=1200,highpass=f=1200");
    const loud = level(voice, 2.2, 3.3);
    const spans = voiceSpans(withVoice.tracks.voice);
    for (let t = 0.1; t < 7.9; t += 0.1) {
      const playing = spans.some((s) => t > s.from + 0.06 && t < s.to - 0.06);
      const quiet = spans.every((s) => t < s.from - 0.06 || t > s.to + 0.06);
      const here = level(voice, t - 0.025, t + 0.025);
      if (playing) expect(Math.abs(here - loud), `voice at ${t.toFixed(1)} s`).toBeLessThan(1);
      if (quiet) expect(here - loud, `no voice at ${t.toFixed(1)} s`).toBeLessThan(-40);
    }
  });

  it("lowers the music by exactly the ducking amount, in the same places as the player's gain function", () => {
    const music = samples("lowpass=f=600,lowpass=f=600,lowpass=f=600");
    const full = level(music, 0.2, 1.5); // before any voice: not ducked
    const spans = voiceSpans(withVoice.tracks.voice);
    const expectedDb = (from: number, to: number) => {
      // Average power of the player's gain over the window, in dB.
      let sum = 0;
      const n = 200;
      for (let i = 0; i < n; i++) sum += duckGainAt(spans, DB, from + ((i + 0.5) * (to - from)) / n) ** 2;
      return 10 * Math.log10(sum / n);
    };
    // Fully lowered while voice plays, and back to full level between v2 and v3.
    expect(level(music, 2.3, 3.3) - full).toBeCloseTo(DB, 0);
    expect(Math.abs(level(music, 2.3, 3.3) - full - DB)).toBeLessThan(0.3);
    expect(Math.abs(level(music, 5.4, 5.8) - full)).toBeLessThan(0.3);
    // Every 50 ms window across the export follows the player's curve: within 0.3 dB on
    // steady stretches, and within 0.5 dB on the 0.25 s ramps (the export changes the
    // volume in 5 ms steps).
    for (let t = 0.2; t < 7.75; t += 0.05) {
      const want = expectedDb(t, t + 0.05);
      const steady = Math.abs(expectedDb(t - 0.05, t) - want) < 0.01 && Math.abs(expectedDb(t + 0.05, t + 0.1) - want) < 0.01;
      const got = level(music, t, t + 0.05) - full;
      expect(Math.abs(got - want), `music at ${t.toFixed(2)} s: ${got.toFixed(2)} dB, expected ${want.toFixed(2)} dB`).toBeLessThan(steady ? 0.3 : 0.5);
    }
    // Between v1 and v2 (0.1 s apart) the two ramps meet, so the music only comes up a little.
    expect(duckGainAt(spans, DB, 3.55)).toBeCloseTo(10 ** ((DB * 0.8) / 20), 6);
    expect(level(music, 3.53, 3.57) - full).toBeLessThan(DB * 0.7);
  });
});

describe.skipIf(!hasFfmpeg)("end-to-end export with a zooming still image", () => {
  // A 1 s video clip, then a 400x300 image (black, with a white 100x100 square at
  // x 150–250, y 100–200) shown for 2 s in a 320x240 frame, zooming from 1x to 2x around
  // a focus left of centre. In each measured frame the square's edges must be within a
  // pixel of where the shared zoom function puts them.
  const still: Timeline = {
    version: 2,
    project: "e2e-still",
    fps: FPS,
    resolution: { width: 320, height: 240 },
    sources: [
      { id: "A", path: "media/a.mp4", duration: 2, fps: FPS, width: 320, height: 240, audioChannels: 1 },
      { id: "I", kind: "image", path: "media/square.png", width: 400, height: 300 },
    ],
    tracks: {
      main: [
        { id: "c1", sourceId: "A", in: 0, out: 1 },
        { id: "c2", sourceId: "I", in: 0, out: 2, zoom: { from: 1, to: 2, focus: { x: 0.25, y: 0.5 } } },
      ],
    },
  };
  let dir: string;
  let result: ExportResult;
  let preview: ExportResult;

  /**
   * Where a bright band in a line of pixels (0..1) starts and ends, to a fraction of a
   * pixel: the points where brightness crosses one half, in pixel-edge coordinates.
   */
  function halfCrossings(line: number[]): [number, number] {
    let start = NaN;
    let end = NaN;
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [line[i - 1], line[i]];
      if (Number.isNaN(start) && a < 0.5 && b >= 0.5) start = i - 0.5 + (0.5 - a) / (b - a);
      if (a >= 0.5 && b < 0.5) end = i - 0.5 + (a - 0.5) / (a - b);
    }
    return [start, end];
  }

  /** One output frame as 8-bit gray pixels. */
  function frame(file: string, n: number): Uint8Array {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-i", path.join(dir, "exports", file), "-vf", `select='eq(n,${n})',format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], {
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(r.stderr.toString());
    return new Uint8Array(r.stdout as Buffer);
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tve-e2e-still-"));
    await mkdir(path.join(dir, "media"));
    makeTestVideo(path.join(dir, "media", "a.mp4"), { seconds: 2, width: 320, height: 240, silence: [5, 6] });
    ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=400x300,drawbox=x=150:y=100:w=100:h=100:color=white:t=fill", "-frames:v", "1", path.join(dir, "media", "square.png")]);
    result = await runExport(dir, still, "final", await newExportName(dir, still, "final"), () => {});
    preview = await runExport(dir, still, "preview", await newExportName(dir, still, "preview"), () => {});
  });

  it("is as long as the timeline, with the image silent", async () => {
    expect(Math.abs(result.duration - 3)).toBeLessThan(TOLERANCE);
    const silent = await detectSilences(path.join(dir, "exports", result.file), 0.3, -40, result.duration);
    expect(silent).toHaveLength(1);
    expect(Math.abs(silent[0].start - 1)).toBeLessThan(TOLERANCE);
  });

  // Final exports zoom at twice the size and scale down; previews zoom at output size.
  it.each([
    ["final", () => result],
    ["preview", () => preview],
  ])("zooms exactly as the shared zoom function says, at the start, middle and end (%s)", (_, exported) => {
    const clip = still.tracks.main[1];
    const W = 320;
    const H = 240;
    // Contain: the 400x300 image fills the 320x240 frame at 0.8x, so the square is at x 120–200, y 80–160.
    const square = { left: 120, right: 200, top: 80, bottom: 160 };
    for (const n of [0, 25, 49]) {
      const local = n / FPS;
      const z = zoomWindow(clip, local);
      const toX = (x: number) => (x / W - z.left) * z.scale * W;
      const toY = (y: number) => (y / H - z.top) * z.scale * H;
      const want = { left: toX(square.left), right: toX(square.right), top: toY(square.top), bottom: toY(square.bottom) };
      const pixels = frame(exported().file, FPS + n); // the image starts after the 1 s video clip
      const row = Math.round((want.top + want.bottom) / 2);
      const col = Math.round((want.left + want.right) / 2);
      const across = [...Array(W).keys()].map((x) => pixels[row * W + x] / 255);
      const down = [...Array(H).keys()].map((y) => pixels[y * W + col] / 255);
      const [left, right] = halfCrossings(across);
      const [top, bottom] = halfCrossings(down);
      const got = { left, right, top, bottom };
      const label = `frame ${n} (zoom ${z.scale.toFixed(3)}): got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
      for (const edge of ["left", "right", "top", "bottom"] as const) expect(Math.abs(got[edge] - want[edge]), label).toBeLessThanOrEqual(1);
      // Scale: the square's size, within one pixel.
      expect(Math.abs(got.right - got.left - (want.right - want.left)), label).toBeLessThanOrEqual(1);
    }
  });
});
