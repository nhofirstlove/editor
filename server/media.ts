// Proxy and waveform-peaks generation. Both read the original in media/ and write only
// to proxies/ and peaks/, which are safe to delete and regenerate.

import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PeaksFile } from "./api-types.ts";
import { probe, runFfmpeg, spawnFfmpeg } from "./ffmpeg.ts";

/** Keyframe every 8 frames, so browsers can seek to almost any frame quickly. */
export const PROXY_KEYFRAME_INTERVAL = 8;
export const PEAKS_PER_SECOND = 100;
const PEAKS_SAMPLE_RATE = 16000;

/** File name used for a source's generated files: "media/day1/a.mp4" -> "day1__a.mp4". */
export function generatedName(sourcePath: string): string {
  return sourcePath.replace(/^media\//, "").replaceAll("/", "__");
}

/** The browser's copy of a source: a 720p MP4, or for a still image a JPEG. */
export function proxyFile(projectDir: string, sourcePath: string, image = false): string {
  return path.join(projectDir, "proxies", `${generatedName(sourcePath)}.proxy.${image ? "jpg" : "mp4"}`);
}

/** A JPEG no bigger than 2560 pixels on its longer side, for showing (and zooming) in the browser. */
export function imageProxyArgs(input: string, output: string): string[] {
  return [
    "-i", input,
    "-frames:v", "1",
    "-vf", "scale='min(2560,iw)':'min(2560,ih)':force_original_aspect_ratio=decrease",
    "-q:v", "3",
    "-f", "image2", "-c:v", "mjpeg", output,
  ];
}

export function peaksFile(projectDir: string, sourcePath: string): string {
  return path.join(projectDir, "peaks", `${generatedName(sourcePath)}.peaks.json`);
}

/**
 * ffmpeg arguments for a 720p H.264 proxy (never upscaled) with a short keyframe
 * interval, stereo AAC audio, and the index at the front for instant playback.
 */
export function proxyArgs(input: string, output: string, hasVideo = true): string[] {
  if (!hasVideo) {
    // Music and other audio-only files: an AAC copy every browser can play.
    return ["-i", input, "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-movflags", "+faststart", "-f", "mp4", output];
  }
  return [
    "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", "scale=-2:'trunc(min(720,ih)/2)*2'",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-g", String(PROXY_KEYFRAME_INTERVAL), "-keyint_min", String(PROXY_KEYFRAME_INTERVAL), "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-movflags", "+faststart",
    "-f", "mp4", output,
  ];
}

/** Temp name for a file being generated. Unique per process, so two servers never share one. */
function partialName(output: string): string {
  return `${output}.${process.pid}.part`;
}

export async function makeProxy(input: string, output: string, duration: number, onProgress: (p: number) => void): Promise<void> {
  const partial = partialName(output);
  try {
    const { hasVideo, image } = await probe(input);
    await runFfmpeg(image ? imageProxyArgs(input, partial) : proxyArgs(input, partial, hasVideo), image ? 0 : duration, onProgress);
    await rename(partial, output);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
}

/** Collects the loudest sample of every `samplesPerPeak` 16-bit mono samples. */
export function createPeakCounter(samplesPerPeak: number) {
  const peaks: number[] = [];
  let max = 0;
  let count = 0;
  let leftover: Buffer | null = null;

  return {
    /** Add raw signed 16-bit little-endian PCM. Chunks may split a sample in half. */
    push(chunk: Buffer): void {
      const buf: Buffer = leftover ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > max) max = v;
        if (++count === samplesPerPeak) {
          peaks.push(toByte(max));
          max = 0;
          count = 0;
        }
      }
      leftover = usable < buf.length ? buf.subarray(usable) : null;
    },
    finish(): number[] {
      if (count > 0) peaks.push(toByte(max));
      count = 0;
      return peaks;
    },
  };
}

function toByte(sample: number): number {
  return Math.min(255, Math.round((sample / 32767) * 255));
}

/** Decodes the first audio stream to mono PCM and writes peaks JSON. */
export async function makePeaks(input: string, output: string, duration: number, onProgress: (p: number) => void): Promise<void> {
  const counter = createPeakCounter(PEAKS_SAMPLE_RATE / PEAKS_PER_SECOND);
  const expectedBytes = duration * PEAKS_SAMPLE_RATE * 2;
  let readBytes = 0;

  await new Promise<void>((resolve, reject) => {
    const args = ["-hide_banner", "-nostdin", "-v", "error", "-i", input, "-map", "0:a:0", "-ac", "1", "-ar", String(PEAKS_SAMPLE_RATE), "-f", "s16le", "pipe:1"];
    const child = spawnFfmpeg(args);
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      counter.push(chunk);
      readBytes += chunk.length;
      if (expectedBytes > 0) onProgress(Math.min(1, readBytes / expectedBytes));
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr = (stderr + c).slice(-2000)));
    child.on("error", (err) => reject(new Error(`Could not start ffmpeg: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else if (/matches no streams/i.test(stderr)) reject(new Error("This file has no audio track, so there is no waveform to draw."));
      else reject(new Error(`ffmpeg could not read the audio (exit code ${code}): ${stderr.trim() || "no details"}`));
    });
  });

  const data: PeaksFile = { version: 1, peaksPerSecond: PEAKS_PER_SECOND, peaks: counter.finish() };
  const partial = partialName(output);
  await writeFile(partial, JSON.stringify(data));
  await rename(partial, output);
}

export type Silence = { start: number; end: number; duration: number };

/**
 * Finds pauses in a file's audio with ffmpeg's silencedetect filter.
 * Times are source seconds, rounded to 3 decimals.
 */
export async function detectSilences(input: string, minSeconds: number, noiseDb: number, fileDuration: number): Promise<Silence[]> {
  const args = ["-hide_banner", "-nostdin", "-i", input, "-map", "0:a:0", "-vn", "-af", `silencedetect=noise=${noiseDb}dB:d=${minSeconds}`, "-f", "null", "-"];
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawnFfmpeg(args);
    let out = "";
    child.stderr.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.on("error", (err) => reject(new Error(`Could not start ffmpeg: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else if (/matches no streams/i.test(out)) reject(new Error("This file has no audio track, so there are no pauses to find."));
      else reject(new Error(`ffmpeg could not read the audio (exit code ${code}): ${out.trim().split(/\r?\n/).slice(-2).join(" / ")}`));
    });
  });
  return parseSilences(stderr, fileDuration);
}

/** Reads silencedetect's log lines. A silence still open at the end runs to the end of the file. */
export function parseSilences(log: string, fileDuration: number): Silence[] {
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const silences: Silence[] = [];
  let start: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end: (-?[\d.]+)/.exec(line);
    if (e && start !== null) {
      const end = Math.min(fileDuration, Number(e[1]));
      silences.push({ start: round(start), end: round(end), duration: round(end - start) });
      start = null;
    }
  }
  if (start !== null && fileDuration > start) {
    silences.push({ start: round(start), end: round(fileDuration), duration: round(fileDuration - start) });
  }
  return silences;
}
