import { spawnSync } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { PeaksFile } from "../server/api-types.ts";
import { probe, run } from "../server/ffmpeg.ts";
import { makePeaks, makeProxy, PEAKS_PER_SECOND, PROXY_KEYFRAME_INTERVAL } from "../server/media.ts";
import { hasFfmpeg, makeTestVideo } from "./helpers/test-media.ts";

describe.skipIf(!hasFfmpeg)("media processing (needs ffmpeg)", () => {
  let dir: string;
  let source: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tve-media-"));
    source = path.join(dir, "source.mp4");
    makeTestVideo(source, { seconds: 4, silence: [1.5, 2.5] });
  });

  it("reads metadata with ffprobe", async () => {
    const info = await probe(source);
    expect(info.hasVideo).toBe(true);
    expect(info.fps).toBe(25);
    expect([info.width, info.height]).toEqual([1920, 1080]);
    expect(info.audioChannels).toBe(1);
    expect(info.duration).toBeGreaterThanOrEqual(3.99);
    expect(info.duration).toBeLessThanOrEqual(4.05);
  });

  it("makes a 720p proxy with a short keyframe interval, reporting progress", async () => {
    const proxy = path.join(dir, "source.proxy.mp4");
    const progress: number[] = [];
    await makeProxy(source, proxy, 4, (p) => progress.push(p));

    const info = await probe(proxy);
    expect([info.width, info.height]).toEqual([1280, 720]);
    expect(info.audioChannels).toBe(2);
    expect(Math.abs(info.duration - 4)).toBeLessThan(0.1);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p >= 0 && p <= 1)).toBe(true);

    // Keyframe positions: every PROXY_KEYFRAME_INTERVAL frames.
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=key_frame", "-of", "csv=p=0", proxy,
    ]);
    const flags = stdout.trim().split(/\r?\n/).map((l) => l.trim());
    const keyIndexes = flags.flatMap((f, i) => (f.startsWith("1") ? [i] : []));
    expect(keyIndexes.slice(0, 4)).toEqual([0, 1, 2, 3].map((n) => n * PROXY_KEYFRAME_INTERVAL));
  });

  it("never upscales a small source", async () => {
    const small = path.join(dir, "small.mp4");
    makeTestVideo(small, { seconds: 1, width: 640, height: 360 });
    const proxy = path.join(dir, "small.proxy.mp4");
    await makeProxy(small, proxy, 1, () => {});
    const info = await probe(proxy);
    expect([info.width, info.height]).toEqual([640, 360]);
  });

  it("makes an audio-only proxy for a music file", async () => {
    const song = path.join(dir, "song.wav");
    const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", song]);
    expect(r.status).toBe(0);
    const proxy = path.join(dir, "song.proxy.mp4");
    await makeProxy(song, proxy, 2, () => {});
    const info = await probe(proxy);
    expect(info.hasVideo).toBe(false);
    expect(info.audioChannels).toBe(2);
    expect(Math.abs(info.duration - 2)).toBeLessThan(0.1);
  });

  it("writes waveform peaks that show the silent gap", async () => {
    const file = path.join(dir, "source.peaks.json");
    await makePeaks(source, file, 4, () => {});
    const data = JSON.parse(await readFile(file, "utf8")) as PeaksFile;
    expect(data.peaksPerSecond).toBe(PEAKS_PER_SECOND);
    expect(Math.abs(data.peaks.length - 4 * PEAKS_PER_SECOND)).toBeLessThanOrEqual(5);
    const at = (t: number) => data.peaks[Math.round(t * PEAKS_PER_SECOND)];
    // ffmpeg's sine source plays at 1/8 of full scale, about 32 of 255.
    expect(at(0.5)).toBeGreaterThan(20); // tone
    expect(at(2.0)).toBe(0); // silence between 1.5 s and 2.5 s
    expect(at(3.5)).toBeGreaterThan(20);
  });

  it("explains when a file has no audio for a waveform", async () => {
    const silent = path.join(dir, "noaudio.mp4");
    makeTestVideo(silent, { seconds: 1, width: 320, height: 240, audio: false });
    await expect(makePeaks(silent, path.join(dir, "noaudio.peaks.json"), 1, () => {})).rejects.toThrow(/no audio track/);
  });
});
