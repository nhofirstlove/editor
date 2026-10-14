// Thin wrappers around the ffmpeg and ffprobe command-line tools.

import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

// Running ffmpeg processes, so they can be stopped when the server shuts down.
const running = new Set<ChildProcess>();

/** Stops every ffmpeg process this server started. */
export function stopAllFfmpeg(): void {
  for (const child of running) child.kill();
}

/** The full argument list runFfmpeg uses: quiet, overwrite, and progress on stdout. */
export function withProgressArgs(args: string[]): string[] {
  return ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", ...args];
}

/** Starts ffmpeg and keeps track of it until it exits. */
export function spawnFfmpeg(args: string[], cwd?: string): ChildProcessByStdio<null, Readable, Readable> {
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"], cwd });
  running.add(child);
  child.on("close", () => running.delete(child));
  child.on("error", () => running.delete(child));
  return child;
}

export type ToolStatus = { ok: true } | { ok: false; message: string };

/** Checks that ffmpeg and ffprobe can be run. Called once at startup. */
export function checkTools(): ToolStatus {
  const missing = ["ffmpeg", "ffprobe"].filter((tool) => {
    const run = spawnSync(tool, ["-version"], { stdio: "ignore" });
    return run.error !== undefined || run.status !== 0;
  });
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    message:
      `${missing.join(" and ")} could not be found. Install ffmpeg (it includes ffprobe) and make sure it is on your PATH, ` +
      "then stop the editor and run `npm run dev` again. The README has step-by-step instructions for macOS and Windows.",
  };
}

export type MediaInfo = {
  /** Seconds; 0 for a still image. */
  duration: number;
  hasVideo: boolean;
  /** A still picture (png, jpg, webp, bmp, tiff), not a video. */
  image?: boolean;
  fps?: number;
  width?: number;
  height?: number;
  audioChannels: number;
};

/** Reads duration, frame rate, resolution and audio channels with ffprobe. */
export async function probe(file: string): Promise<MediaInfo> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error("ffprobe could not read this file. It may not be a video file, or it may be damaged.");
  }
  return parseProbe(data);
}

type ProbeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  channels?: number;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
};

/** ffprobe format names of the still-image formats the editor accepts. */
const IMAGE_FORMATS = /^(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe)$/;

/** Turns ffprobe's JSON output into the metadata the editor stores. */
export function parseProbe(data: unknown): MediaInfo {
  const probe = (data ?? {}) as { format?: { duration?: string; format_name?: string }; streams?: ProbeStream[] };
  const streams = probe.streams ?? [];
  // Cover art inside audio files shows up as a one-frame "video" stream; ignore it.
  const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === "audio");

  if (video && !audio && IMAGE_FORMATS.test(probe.format?.format_name ?? "")) {
    if (!video.width || !video.height) throw new Error("Could not read the size of this image. It may be damaged.");
    return { duration: 0, hasVideo: true, image: true, width: video.width, height: video.height, audioChannels: 0 };
  }

  const duration = Number(probe.format?.duration ?? video?.duration ?? audio?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Could not read the length of this file. It may not be a video file, or it may be damaged.");
  }

  const info: MediaInfo = {
    // Round down so clip "out" times never point past the real end of the file.
    duration: Math.floor(duration * 1000) / 1000,
    hasVideo: video !== undefined,
    audioChannels: audio?.channels ?? 0,
  };
  if (video) {
    const fps = parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate);
    if (fps) info.fps = Math.round(fps * 1000) / 1000;
    if (video.width && video.height) {
      // Phone footage is often stored sideways with a rotation flag; report what viewers see.
      const rotation = Number(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
      const sideways = Math.abs(rotation) % 180 === 90;
      info.width = sideways ? video.height : video.width;
      info.height = sideways ? video.width : video.height;
    }
  }
  return info;
}

function parseRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [num, den] = rate.split("/").map(Number);
  const value = den ? num / den : num;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Runs ffmpeg and reports progress (0..1) from its `-progress` output.
 * `duration` is the length of the output in seconds, used to turn time into progress.
 */
export function runFfmpeg(args: string[], duration: number, onProgress: (p: number) => void, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnFfmpeg(withProgressArgs(args), cwd);
    let stderr = "";
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m && duration > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (err) => reject(new Error(`Could not start ffmpeg: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (exit code ${code}): ${lastLines(stderr)}`));
    });
  });
}

/** Runs a command to completion and returns its output. */
export function run(cmd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr = (stderr + c).slice(-4000)));
    child.on("error", (err) => reject(new Error(`Could not start ${cmd}: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(`${cmd} failed (exit code ${code}): ${lastLines(stderr)}`));
    });
  });
}

function lastLines(text: string): string {
  return text.trim().split(/\r?\n/).slice(-3).join(" / ") || "no details";
}
